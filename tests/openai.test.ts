import { test, expect, beforeEach, afterEach } from 'bun:test'
import { makeLLMCall, loadOpenAiCreds, loadOpenAiUiCreds, testConnection } from '@/openai'
import { DEFAULT_LLM_MAX_TOKENS } from '@/llm'

// 这些测试锁 OpenAI 格式 LLMCall 实现（src/openai.ts，spec §5.2 / §9）：
//   - 请求形状：POST {baseURL}/chat/completions，Bearer 鉴权，system+user 两条 message，
//     max_tokens 默认 DEFAULT_LLM_MAX_TOKENS(8192)、opts.maxTokens 可覆盖。
//   - 响应抽取 choices[0].message.content（多 choice 取 [0]）。
//   - 失败语义对齐 Anthropic：无凭据 / creds loader 抛错 / HTTP 非 2xx / 响应缺字段 /
//     超时(AbortController) 均 throw，交由 callWithRetry 重试降级。
// 全程 mock globalThis.fetch，不发真实网络请求；loadOpenAiCreds 走注入，不读 env
// （loadOpenAiCreds 自身的 env 行为单独覆盖）。

const CREDS = { apiKey: 'sk-test', baseURL: 'https://internal.example.com/v1', model: 'internal-model' }
const ENV_KEYS = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'] as const

let origFetch: typeof fetch
let fetchCalls: Array<{ url: string; init: RequestInit }>
let fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
const savedEnv: Record<string, string | undefined> = {}

function okResp(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  origFetch = globalThis.fetch
  fetchCalls = []
  // 默认 fetch 实现返回空 200；每个测试可覆盖 fetchImpl 定制响应/行为
  fetchImpl = async () => new Response('{}', { status: 200 })
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), init: init ?? {} })
    return fetchImpl(input as RequestInfo | URL, init)
  }) as typeof fetch
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k] }
})

afterEach(() => {
  globalThis.fetch = origFetch
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

// ---- loadOpenAiCreds：env 行为（spec §5.2 / §4 决策 3/4）----

test('loadOpenAiCreds returns null when OPENAI_API_KEY missing', () => {
  process.env.OPENAI_MODEL = 'm'
  expect(loadOpenAiCreds()).toBeNull()
})

test('loadOpenAiCreds throws when OPENAI_API_KEY set but OPENAI_MODEL missing', () => {
  process.env.OPENAI_API_KEY = 'k'
  expect(() => loadOpenAiCreds()).toThrow(/OPENAI_MODEL missing/)
})

test('loadOpenAiCreds defaults baseURL to https://api.openai.com/v1 and strips trailing slash', () => {
  process.env.OPENAI_API_KEY = 'k'
  process.env.OPENAI_MODEL = 'm'
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1/'
  const c = loadOpenAiCreds()!
  expect(c.apiKey).toBe('k')
  expect(c.model).toBe('m')
  expect(c.baseURL).toBe('https://api.openai.com/v1')
})

// ---- makeLLMCall：请求形状 + 响应抽取（spec §9 断言 1-4）----

test('makeLLMCall posts to {baseURL}/chat/completions with Bearer auth + system/user messages + default max_tokens', async () => {
  fetchImpl = async () => okResp({ choices: [{ message: { content: 'hello' } }] })
  const call = makeLLMCall({ loadOpenAiCreds: () => CREDS })
  const out = await call('SYS', 'USR')
  expect(out).toBe('hello')
  expect(fetchCalls).toHaveLength(1)
  expect(fetchCalls[0]!.url).toBe('https://internal.example.com/v1/chat/completions')
  const headers = new Headers(fetchCalls[0]!.init.headers as HeadersInit)
  expect(headers.get('authorization')).toBe('Bearer sk-test')
  expect(headers.get('content-type')).toBe('application/json')
  const body = JSON.parse(fetchCalls[0]!.init.body as string)
  expect(body.model).toBe('internal-model')
  expect(body.messages).toEqual([
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'USR' },
  ])
  expect(body.max_tokens).toBe(DEFAULT_LLM_MAX_TOKENS)
  expect(body.max_tokens).toBe(8192)
})

test('makeLLMCall honors opts.maxTokens override', async () => {
  fetchImpl = async () => okResp({ choices: [{ message: { content: 'x' } }] })
  const call = makeLLMCall({ loadOpenAiCreds: () => CREDS })
  await call('s', 'u', { maxTokens: 512 })
  const body = JSON.parse(fetchCalls[0]!.init.body as string)
  expect(body.max_tokens).toBe(512)
})

test('makeLLMCall extracts choices[0].message.content (first of many choices)', async () => {
  fetchImpl = async () => okResp({
    choices: [
      { message: { content: 'first' } },
      { message: { content: 'second' } },
    ],
  })
  const call = makeLLMCall({ loadOpenAiCreds: () => CREDS })
  const out = await call('s', 'u')
  expect(out).toBe('first')
})

// ---- makeLLMCall：失败语义（spec §9 断言 5-9 / §8）----

test('makeLLMCall throws "no OpenAI credentials" and never calls fetch when loadOpenAiCreds returns null', async () => {
  const call = makeLLMCall({ loadOpenAiCreds: () => null })
  await expect(call('s', 'u')).rejects.toThrow(/no OpenAI credentials/)
  expect(fetchCalls).toHaveLength(0)
})

test('makeLLMCall propagates loadOpenAiCreds errors (e.g. missing model) without calling fetch', async () => {
  const call = makeLLMCall({ loadOpenAiCreds: () => { throw new Error('OPENAI_MODEL missing') } })
  await expect(call('s', 'u')).rejects.toThrow(/OPENAI_MODEL missing/)
  expect(fetchCalls).toHaveLength(0)
})

test('makeLLMCall throws "OpenAI HTTP <status>" on non-2xx', async () => {
  fetchImpl = async () => new Response('{"error":"bad key"}', { status: 401 })
  const call = makeLLMCall({ loadOpenAiCreds: () => CREDS })
  await expect(call('s', 'u')).rejects.toThrow(/OpenAI HTTP 401/)
})

test('makeLLMCall throws when response missing choices[0].message.content', async () => {
  fetchImpl = async () => okResp({ choices: [{ message: {} }] })
  const call = makeLLMCall({ loadOpenAiCreds: () => CREDS })
  await expect(call('s', 'u')).rejects.toThrow(/missing choices\[0\]\.message\.content/)
})

test('makeLLMCall aborts after timeoutMs when fetch never resolves', async () => {
  // 永不 resolve 的 fetch；timeoutMs 极小 -> AbortController 触发 -> fetch reject
  // Mock 必须监听 abort signal 才能 reject，否则 test 永远挂起（与真实 fetch 行为一致）
  fetchImpl = (_input, init) => new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
  })
  const call = makeLLMCall({ loadOpenAiCreds: () => CREDS, timeoutMs: 50 })
  await expect(call('s', 'u')).rejects.toThrow()
  expect(fetchCalls).toHaveLength(1)
  // signal 必须随请求下发
  expect(fetchCalls[0]!.init.signal).toBeInstanceOf(AbortSignal)
})

// ---- loadOpenAiUiCreds：UI 级凭证合并（spec §接口契约）----

test('loadOpenAiUiCreds: UI token 存在用 UI creds（去尾斜杠）', () => {
  const c = loadOpenAiUiCreds({ token: 'sk-ui', baseURL: 'https://ui.example.com/v1/', model: 'ui-model' }, {})
  expect(c).toEqual({ apiKey: 'sk-ui', baseURL: 'https://ui.example.com/v1', model: 'ui-model' })
})

test('loadOpenAiUiCreds: UI model/baseURL 缺省回退 env', () => {
  const c = loadOpenAiUiCreds({ token: 'sk-ui' }, { OPENAI_MODEL: 'env-model', OPENAI_BASE_URL: 'https://env.example.com/v1/' })
  expect(c).toEqual({ apiKey: 'sk-ui', baseURL: 'https://env.example.com/v1', model: 'env-model' })
})

test('loadOpenAiUiCreds: UI model 与 env 都缺 -> 抛错', () => {
  expect(() => loadOpenAiUiCreds({ token: 'sk-ui' }, {})).toThrow(/OpenAI model missing/)
})

test('loadOpenAiUiCreds: UI 为 null -> 回退 env', () => {
  process.env.OPENAI_API_KEY = 'k'
  process.env.OPENAI_MODEL = 'm'
  expect(loadOpenAiUiCreds(null, {})).toEqual({ apiKey: 'k', baseURL: 'https://api.openai.com/v1', model: 'm' })
})

test('makeLLMCall 注入 loadUiConfig 时用 UI creds', async () => {
  fetchImpl = async () => okResp({ choices: [{ message: { content: 'hi' } }] })
  const call = makeLLMCall({
    loadUiConfig: () => ({ token: 'sk-ui', baseURL: 'https://ui.example.com/v1', model: 'ui-model' }),
  })
  await call('s', 'u')
  expect(fetchCalls[0]!.url).toBe('https://ui.example.com/v1/chat/completions')
  const headers = new Headers(fetchCalls[0]!.init.headers as HeadersInit)
  expect(headers.get('authorization')).toBe('Bearer sk-ui')
})

// ---- testConnection：OpenAI 最小请求（spec §测试连接）----

test('testConnection posts {baseURL}/chat/completions 最小请求', async () => {
  fetchImpl = async () => okResp({ choices: [{ message: { content: 'hi' } }] })
  const r = await testConnection({ baseURL: 'https://ui.example.com/v1/', token: 'sk', model: 'm' })
  expect(r.ok).toBe(true)
  expect(fetchCalls[0]!.url).toBe('https://ui.example.com/v1/chat/completions')
  const body = JSON.parse(fetchCalls[0]!.init.body as string)
  expect(body.max_tokens).toBe(1)
  expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
  expect(body.model).toBe('m')
})

test('testConnection 非 2xx -> {ok:false, error 含状态码}', async () => {
  fetchImpl = async () => new Response('{"error":"bad key"}', { status: 401 })
  const r = await testConnection({ token: 'sk', model: 'm' })
  expect(r.ok).toBe(false)
  expect(r.error).toMatch(/OpenAI HTTP 401/)
})
