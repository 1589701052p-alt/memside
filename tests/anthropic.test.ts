import { test, expect, mock, beforeEach } from 'bun:test'
import { makeLLMCall, DISTILL_MODEL } from '@/anthropic'
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

function FakeAnthropic(this: any, opts: Record<string, unknown> = {}) {
  ctorCalls.push(opts)
  this.messages = {
    create: async (args: Record<string, unknown>) => {
      createCalls.push(args)
      return { content: [{ type: 'text', text: '{"candidates":[]}' }] }
    },
  }
}

mock.module('@anthropic-ai/sdk', () => ({ default: FakeAnthropic }))

beforeEach(() => {
  ctorCalls.length = 0
  createCalls.length = 0
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
