import { test, expect, mock, beforeEach } from 'bun:test'
import { makeLLMCall, DISTILL_MODEL, testConnection } from '@/anthropic'
import { DEFAULT_LLM_MAX_TOKENS } from '@/llm'

// These tests assert that the proxy auth fields resolved by `loadClaudeCreds`
// (baseURL + model) actually flow into the @anthropic-ai/sdk call:
//   - baseURL    -> `new Anthropic({ baseURL })`
//   - model      -> `client.messages.create({ model })`
//   - max_tokens -> `DEFAULT_LLM_MAX_TOKENS` (8192) by default, `opts.maxTokens` override
//
// We never make a live network call: `@anthropic-ai/sdk` is replaced with a
// recording fake. `mock.module` is hoisted above the `@/anthropic` import by
// bun:test, so `makeLLMCall` closes over the fake class at runtime.

const ctorCalls: Array<Record<string, unknown>> = []
const createCalls: Array<Record<string, unknown>> = []
// second-arg (RequestOptions) capture + failure injection for testConnection tests
const createOpts: Array<unknown> = []
let createError: Error | null = null

function FakeAnthropic(this: any, opts: Record<string, unknown> = {}) {
  ctorCalls.push(opts)
  this.messages = {
    create: async (args: Record<string, unknown>, opts2?: Record<string, unknown>) => {
      if (createError) throw createError
      createCalls.push(args)
      createOpts.push(opts2)
      return { content: [{ type: 'text', text: '{"candidates":[]}' }] }
    },
  }
}

mock.module('@anthropic-ai/sdk', () => ({ default: FakeAnthropic }))

beforeEach(() => {
  ctorCalls.length = 0
  createCalls.length = 0
  createOpts.length = 0
  createError = null
})

test('constructs Anthropic client with creds baseURL and uses creds model (proxy path)', async () => {
  const callLLM = makeLLMCall({
    loadClaudeCreds: () => ({
      apiKey: 'ark-token',
      baseURL: 'https://ark.cn-beijing.volces.com/api/plan',
      model: 'deepseek-v4-flash[1m]',
      source: 'env:authToken',
    }),
  })
  await callLLM('sys', 'user')

  // baseURL flows into the SDK constructor
  expect(ctorCalls[0].apiKey).toBe('ark-token')
  expect(ctorCalls[0].baseURL).toBe('https://ark.cn-beijing.volces.com/api/plan')

  // creds model flows into messages.create (NOT DISTILL_MODEL)
  expect(createCalls[0].model).toBe('deepseek-v4-flash[1m]')
  expect(createCalls[0].model).not.toBe(DISTILL_MODEL)
})

test('falls back to DISTILL_MODEL when creds have no model (official key path)', async () => {
  const callLLM = makeLLMCall({
    loadClaudeCreds: () => ({ apiKey: 'sk-official', source: 'env:apiKey' }),
  })
  await callLLM('sys', 'user')
  expect(createCalls[0].model).toBe(DISTILL_MODEL)
})

test('omits baseURL from constructor when creds have none', async () => {
  const callLLM = makeLLMCall({
    loadClaudeCreds: () => ({ apiKey: 'sk-official', source: 'env:apiKey' }),
  })
  await callLLM('sys', 'user')
  expect(ctorCalls[0].baseURL).toBeUndefined()
  expect('baseURL' in ctorCalls[0]).toBe(false)
})

test('uses creds model even when baseURL is absent (official key + model override)', async () => {
  const callLLM = makeLLMCall({
    loadClaudeCreds: () => ({ apiKey: 'sk-official', model: 'claude-sonnet-x', source: 'env:apiKey' }),
  })
  await callLLM('sys', 'user')
  expect(createCalls[0].model).toBe('claude-sonnet-x')
  expect(createCalls[0].model).not.toBe(DISTILL_MODEL)
  expect(ctorCalls[0].baseURL).toBeUndefined()
})

test('extracts joined text from content blocks', async () => {
  const callLLM = makeLLMCall({
    loadClaudeCreds: () => ({ apiKey: 'k', model: 'm', source: 'test' }),
  })
  const out = await callLLM('sys', 'user')
  expect(out).toBe('{"candidates":[]}')
})

test('throws when no creds are resolvable and never constructs a client', async () => {
  const callLLM = makeLLMCall({
    loadClaudeCreds: () => ({ apiKey: null, source: 'none' }),
  })
  expect(callLLM('sys', 'user')).rejects.toThrow(/no claude credentials/)
  expect(ctorCalls.length).toBe(0)
})

test('DEFAULT_LLM_MAX_TOKENS is 8192 (locks the 2048->8192 bump)', () => {
  expect(DEFAULT_LLM_MAX_TOKENS).toBe(8192)
})

test('makeLLMCall uses DEFAULT_LLM_MAX_TOKENS when opts omitted', async () => {
  const callLLM = makeLLMCall({
    loadClaudeCreds: () => ({ apiKey: 'k', model: 'm', source: 'test' }),
  })
  await callLLM('sys', 'user')
  expect(createCalls[0].max_tokens).toBe(DEFAULT_LLM_MAX_TOKENS)
  expect(createCalls[0].max_tokens).toBe(8192)
})

test('makeLLMCall honors opts.maxTokens override', async () => {
  const callLLM = makeLLMCall({
    loadClaudeCreds: () => ({ apiKey: 'k', model: 'm', source: 'test' }),
  })
  await callLLM('sys', 'user', { maxTokens: 512 })
  expect(createCalls[0].max_tokens).toBe(512)
})

// --- Task 3: UI 配置注入点 + testConnection ---

test('callLLM 把 loadUiConfig 的结果传给 loadClaudeCreds（UI 级注入点）', async () => {
  const seen: unknown[] = []
  const call = makeLLMCall({
    loadClaudeCreds: (ui?: any) => {
      seen.push(ui)
      return { apiKey: 'k', model: 'm', source: 'ui' }
    },
    loadUiConfig: () => ({ token: 'sk-ui-token-123456', baseURL: 'https://ui.example.com' }),
  })
  await call('sys', 'user')
  expect(seen).toEqual([{ token: 'sk-ui-token-123456', baseURL: 'https://ui.example.com' }])
})

test('callLLM 无 loadUiConfig 时以 undefined 调 loadClaudeCreds（向后兼容无参写法）', async () => {
  const seen: unknown[] = []
  const call = makeLLMCall({
    loadClaudeCreds: (ui?: any) => {
      seen.push(ui)
      return { apiKey: 'k', model: 'm', source: 'test' }
    },
  })
  await call('sys', 'user')
  expect(seen).toEqual([undefined])
})

test('testConnection: SDK 成功 -> {ok:true}', async () => {
  const r = await testConnection({ token: 'sk-abcdefghijklmn' })
  expect(r).toEqual({ ok: true })
})

test('testConnection: SDK 抛 401 -> {ok:false,error 含 401}', async () => {
  createError = new Error('401 {"error":{"type":"authentication_error","message":"invalid x-api-key"}}')
  const r = await testConnection({ token: 'sk-abcdefghijklmn' })
  expect(r.ok).toBe(false)
  expect(r.error).toContain('401')
})

test('testConnection: 走 cfg.baseURL 与 cfg.model 进 SDK', async () => {
  const r = await testConnection({
    token: 'sk-abcdefghijklmn',
    baseURL: 'https://ui.example.com',
    model: 'ui-model-x',
  })
  expect(r).toEqual({ ok: true })
  // ctor 收到 token + baseURL
  expect(ctorCalls[0].apiKey).toBe('sk-abcdefghijklmn')
  expect(ctorCalls[0].baseURL).toBe('https://ui.example.com')
  // create 收到 cfg.model 与 max_tokens=1（最小请求）
  expect(createCalls[0].model).toBe('ui-model-x')
  expect(createCalls[0].max_tokens).toBe(1)
  // 默认 15s 超时经第二参传入
  expect(createOpts[0]).toEqual({ timeout: 15_000 })
})

test('testConnection: cfg.model 缺省回退 DISTILL_MODEL，opts.timeoutMs 覆盖默认超时', async () => {
  const r = await testConnection({ token: 'sk-abcdefghijklmn' }, { timeoutMs: 1234 })
  expect(r).toEqual({ ok: true })
  expect(createCalls[0].model).toBe(DISTILL_MODEL)
  expect(createOpts[0]).toEqual({ timeout: 1234 })
  expect('baseURL' in ctorCalls[0]).toBe(false)
})
