import { test, expect, mock, beforeEach } from 'bun:test'
import { makeLLMCall, DISTILL_MODEL, testConnection } from '@/anthropic'
import { DEFAULT_LLM_MAX_TOKENS } from '@/llm'

// These tests assert that the proxy auth fields resolved by `loadClaudeCreds`
// (baseURL + model) actually flow into the @anthropic-ai/sdk call:
//   - baseURL    -> `new Anthropic({ baseURL })`
//   - model      -> `client.messages.stream({ model })`
//   - max_tokens -> `DEFAULT_LLM_MAX_TOKENS` (8192) by default, `opts.maxTokens` override
//
// 锁定 2026-08-14 根因修复：makeLLMCall 必须走流式 `messages.stream`
// （非流式 `messages.create` 在生成 >~60s 时被端点准时断连，即「60s 非流式墙」，
// 见 docs/superpowers/specs/2026-08-14-llm-streaming-and-failure-visibility-design.md §1）。
// 未来 refactor 一旦改回 create，「走 stream 不走 create」这条断言必须变红。
//
// We never make a live network call: `@anthropic-ai/sdk` is replaced with a
// recording fake. `mock.module` is hoisted above the `@/anthropic` import by
// bun:test, so `makeLLMCall` closes over the fake class at runtime.

const ctorCalls: Array<Record<string, unknown>> = []
// makeLLMCall 流式路径的调用记录 + 失败注入
const streamCalls: Array<Record<string, unknown>> = []
const streamOpts: Array<unknown> = []
let streamError: Error | null = null
// finalMessage() 返回的 Message（content 块可在测试里定制）
let streamContent: Array<Record<string, unknown>> = [{ type: 'text', text: '{"candidates":[]}' }]
// testConnection 仍走非流式 create（max_tokens=1 可达性探针，spec 非目标）
const createCalls: Array<Record<string, unknown>> = []
const createOpts: Array<unknown> = []
let createError: Error | null = null

function FakeAnthropic(this: any, opts: Record<string, unknown> = {}) {
  ctorCalls.push(opts)
  this.messages = {
    stream: (args: Record<string, unknown>, opts2?: Record<string, unknown>) => {
      if (streamError) throw streamError
      streamCalls.push(args)
      streamOpts.push(opts2)
      return {
        finalMessage: async () => {
          if (streamError) throw streamError
          return { content: streamContent }
        },
      }
    },
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
  streamCalls.length = 0
  streamOpts.length = 0
  streamError = null
  streamContent = [{ type: 'text', text: '{"candidates":[]}' }]
  createCalls.length = 0
  createOpts.length = 0
  createError = null
})

// --- T1 根因回归锁：流式化 ---

test('makeLLMCall 走 messages.stream 而非 messages.create（2026-08-14 根因回归锁）', async () => {
  const callLLM = makeLLMCall({
    loadClaudeCreds: () => ({ apiKey: 'k', model: 'm', source: 'test' }),
  })
  await callLLM('sys', 'user')
  expect(streamCalls.length).toBe(1)
  expect(createCalls.length).toBe(0)
})

test('makeLLMCall 传入 timeout 600_000（10 分钟硬上限兜底）', async () => {
  const callLLM = makeLLMCall({
    loadClaudeCreds: () => ({ apiKey: 'k', model: 'm', source: 'test' }),
  })
  await callLLM('sys', 'user')
  expect(streamOpts[0]).toEqual({ timeout: 600_000 })
})

test('文本块拼接：多 text 块拼接、非 text 块丢弃', async () => {
  streamContent = [
    { type: 'text', text: '{"a":' },
    { type: 'tool_use', id: 'tu_1', name: 'noop', input: {} },
    { type: 'thinking', thinking: 'hmm' },
    { type: 'text', text: '1}' },
  ]
  const callLLM = makeLLMCall({
    loadClaudeCreds: () => ({ apiKey: 'k', model: 'm', source: 'test' }),
  })
  const out = await callLLM('sys', 'user')
  expect(out).toBe('{"a":1}')
})

test('SDK 抛错时 Error.message 透传', async () => {
  streamError = new Error('Connection error.')
  const callLLM = makeLLMCall({
    loadClaudeCreds: () => ({ apiKey: 'k', model: 'm', source: 'test' }),
  })
  await expect(callLLM('sys', 'user')).rejects.toThrow('Connection error.')
})

// --- 凭据 / 模型 / max_tokens 流入 SDK ---

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

  // creds model flows into messages.stream (NOT DISTILL_MODEL)
  expect(streamCalls[0].model).toBe('deepseek-v4-flash[1m]')
  expect(streamCalls[0].model).not.toBe(DISTILL_MODEL)
})

test('falls back to DISTILL_MODEL when creds have no model (official key path)', async () => {
  const callLLM = makeLLMCall({
    loadClaudeCreds: () => ({ apiKey: 'sk-official', source: 'env:apiKey' }),
  })
  await callLLM('sys', 'user')
  expect(streamCalls[0].model).toBe(DISTILL_MODEL)
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
  expect(streamCalls[0].model).toBe('claude-sonnet-x')
  expect(streamCalls[0].model).not.toBe(DISTILL_MODEL)
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
  expect(streamCalls[0].max_tokens).toBe(DEFAULT_LLM_MAX_TOKENS)
  expect(streamCalls[0].max_tokens).toBe(8192)
})

test('makeLLMCall honors opts.maxTokens override', async () => {
  const callLLM = makeLLMCall({
    loadClaudeCreds: () => ({ apiKey: 'k', model: 'm', source: 'test' }),
  })
  await callLLM('sys', 'user', { maxTokens: 512 })
  expect(streamCalls[0].max_tokens).toBe(512)
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
