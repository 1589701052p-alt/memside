import { test, expect } from 'bun:test'
import { DEFAULT_LLM_MAX_TOKENS, resolveLLMBackend } from '@/llm'

// 锁定契约层默认 max_tokens。该值由 makeLLMCall（src/anthropic.ts 与 src/openai.ts）
// 在 opts.maxTokens 缺省时透传；distill/dedup/valueFilter 经 callWithRetry 以 2 参调用
// seam，故 8192 默认值贯通三处。改动此常量须同步审视 distill 输出是否会被截断。
// 见 spec §5.1 / §9。
test('DEFAULT_LLM_MAX_TOKENS is 8192 (locks the 2048->8192 bump)', () => {
  expect(DEFAULT_LLM_MAX_TOKENS).toBe(8192)
})

// resolveLLMBackend 锁混合后端选择规则（spec §5.1 / §4 决策 5/7 / §9）：
//   - 显式 MEMSIDE_LLM_BACKEND=anthropic|openai 覆盖一切；
//   - 未设（或空串）时按 OPENAI_API_KEY 存在性探测——有则 openai，无则 anthropic；
//   - 未识别的非空值抛错（防拼错静默回退到 anthropic）。
// 该纯函数是 daemon.resolveCallLLM 的选择核心，daemon.test.ts 注入 mock callLLM
// 不经此路径，故选择逻辑必须在此单测覆盖。
test('resolveLLMBackend: explicit openai wins regardless of OPENAI_API_KEY', () => {
  expect(resolveLLMBackend({ MEMSIDE_LLM_BACKEND: 'openai' })).toBe('openai')
  expect(resolveLLMBackend({ MEMSIDE_LLM_BACKEND: 'openai', OPENAI_API_KEY: 'x' })).toBe('openai')
})

test('resolveLLMBackend: explicit anthropic wins even when OPENAI_API_KEY present', () => {
  expect(resolveLLMBackend({ MEMSIDE_LLM_BACKEND: 'anthropic', OPENAI_API_KEY: 'x' })).toBe('anthropic')
})

test('resolveLLMBackend: empty env defaults to anthropic', () => {
  expect(resolveLLMBackend({})).toBe('anthropic')
})

test('resolveLLMBackend: no explicit backend + OPENAI_API_KEY present -> openai', () => {
  expect(resolveLLMBackend({ OPENAI_API_KEY: 'x' })).toBe('openai')
})

test('resolveLLMBackend: empty-string MEMSIDE_LLM_BACKEND treated as unset', () => {
  // 空串 = 未设：仍按 OPENAI_API_KEY 探测
  expect(resolveLLMBackend({ MEMSIDE_LLM_BACKEND: '', OPENAI_API_KEY: 'x' })).toBe('openai')
  expect(resolveLLMBackend({ MEMSIDE_LLM_BACKEND: '' })).toBe('anthropic')
})

test('resolveLLMBackend: unknown MEMSIDE_LLM_BACKEND throws (no silent fallback)', () => {
  expect(() => resolveLLMBackend({ MEMSIDE_LLM_BACKEND: 'foo' })).toThrow(/unknown MEMSIDE_LLM_BACKEND/)
})
