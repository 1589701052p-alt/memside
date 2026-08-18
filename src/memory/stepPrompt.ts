// src/memory/stepPrompt.ts
import { extractJsonObject } from './pure'
import type { DistillStep, StepFailReason } from './stepState'

const ABORT_PATTERNS = ['aborted', 'connection error', 'timeout', 'timed out', 'econnreset', 'socket hang up']

/** 从异常/响应分类失败原因（spec §5.3）。 */
export function classifyFailure(error: unknown, rawResponse: string | null): StepFailReason {
  const hasResponse = rawResponse != null && rawResponse.trim().length > 0
  if (hasResponse) {
    // 试解析，能完整 parse 但不合规由调用方的 shouldRetry 判定（走 format）；
    // 不能 parse（JSON.parse 失败）→ format；像 JSON 但截断 → incomplete。
    try {
      JSON.parse(extractJsonObject(rawResponse!))
      return 'format' // 解析成功但内容不合规，重试要纠格式（调用方分类细化）
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // 截断特征：parse 报错但原始里有未闭合的 JSON 结构
      if (rawResponse!.includes('{') && !isClosedJson(rawResponse!)) return 'incomplete'
      return 'format'
    }
  }
  // 无响应：看异常类型
  if (error) {
    const msg = (error instanceof Error ? error.message : String(error)).toLowerCase()
    if (ABORT_PATTERNS.some((p) => msg.includes(p))) return 'aborted'
  }
  return 'aborted'
}

/**
 * 判断 s 是否为"干净截断"的 JSON 前缀：所有字符串闭合，只剩未闭合的 {/}。
 * 结束在未闭合字符串内（如 '{"bad'）→ 返回 true（视为已闭合），由调用方
 * 走 format 分支——那不是合法 JSON 结构，只是残渣；'{"a":1'（字符串全闭、
 * 对象未闭）→ false → incomplete（max_tokens 掐断的典型形态）。
 */
function isClosedJson(s: string): boolean {
  let depth = 0
  let inString = false
  let escape = false
  for (const ch of s) {
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
    } else {
      if (ch === '"') inString = true
      else if (ch === '{') depth++
      else if (ch === '}') depth--
    }
  }
  return inString || depth <= 0
}

/** 根据失败原因拼追问文本（spec §5.3）。 */
export function buildFollowupPrompt(reason: StepFailReason, lastResponse: string, _step: DistillStep): string {
  const suffix = '请只输出纯 JSON 对象，不要 markdown 围栏，不要解释文字，键与字符串值用双引号。'
  if (reason === 'incomplete') {
    return `\n\n[系统] 你上次的回复没回完，请接着上面的内容输出完整的 JSON。上次的回复：\n${lastResponse}\n${suffix}`
  }
  if (reason === 'format') {
    return `\n\n[系统] 你上次的回复格式不对，请输出合规的 JSON 对象。上次的回复：\n${lastResponse}\n${suffix}`
  }
  // aborted
  return `\n\n[系统] 上次请求被中断，请重新输出完整的 JSON 结果。${suffix}`
}
