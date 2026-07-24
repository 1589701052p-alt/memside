import { extractJsonObject } from './pure'
import type { LLMCall } from '@/llm'

export interface RetryOpts {
  call: LLMCall
  system: string
  user: string
  /** Return an error message to retry, or null to accept the parsed output. */
  shouldRetry: (parsed: unknown) => string | null
  maxRetries?: number
}

const FEEDBACK_SUFFIX = '请只输出纯 JSON 对象，不要 markdown 围栏，不要解释文字，键与字符串值用双引号，最后一个属性后无逗号。'

/**
 * Call `call` -> extractJsonObject -> JSON.parse -> shouldRetry. On any failure
 * (call throws, parse fails, shouldRetry returns an error), feed the error back
 * to the model in natural language and retry, up to maxRetries times (default 2,
 * so 3 total attempts).
 *
 * Returns the last successfully-parsed object (or undefined if parse never
 * succeeded), so the caller's existing `!parsed` guards still catch the
 * exhausted case -> existing fallback behavior unchanged.
 */
export async function callWithRetry(opts: RetryOpts): Promise<unknown> {
  const maxRetries = opts.maxRetries ?? 2
  let lastParsed: unknown = undefined
  let currentUser = opts.user
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let raw: string
    try {
      raw = await opts.call(opts.system, currentUser)
    } catch (e) {
      if (attempt === maxRetries) return lastParsed
      const error = `调用失败：${e instanceof Error ? e.message : String(e)}`
      currentUser = `${opts.user}\n\n[修正] 你上次的回答有问题：${error}。${FEEDBACK_SUFFIX}`
      continue
    }
    const cleaned = extractJsonObject(raw)
    let parsed: unknown
    try {
      parsed = JSON.parse(cleaned)
    } catch (e) {
      if (attempt === maxRetries) return lastParsed
      const error = `不是合法 JSON：${e instanceof Error ? e.message : String(e)}`
      currentUser = `${opts.user}\n\n[修正] 你上次的回答有问题：${error}。${FEEDBACK_SUFFIX}`
      continue
    }
    lastParsed = parsed
    const retryError = opts.shouldRetry(parsed)
    if (retryError === null) return parsed
    if (attempt === maxRetries) return lastParsed
    currentUser = `${opts.user}\n\n[修正] 你上次的回答有问题：${retryError}。${FEEDBACK_SUFFIX}`
  }
  return lastParsed
}