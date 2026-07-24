import { test, expect } from 'bun:test'
import { DEFAULT_LLM_MAX_TOKENS } from '@/llm'

// 锁定契约层默认 max_tokens。该值由 makeLLMCall（src/anthropic.ts）在
// opts.maxTokens 缺省时透传给 messages.create；distill/dedup/valueFilter 经
// callWithRetry 以 2 参调用 seam，故 8192 默认值贯通三处。改动此常量须同步
// 审视 distill 输出是否会被截断。见 spec §5.1 / §9。
test('DEFAULT_LLM_MAX_TOKENS is 8192 (locks the 2048->8192 bump)', () => {
  expect(DEFAULT_LLM_MAX_TOKENS).toBe(8192)
})
