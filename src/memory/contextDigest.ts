// src/memory/contextDigest.ts

import type { TranscriptTurn } from './pure'

export const DIGEST_MAX_CHARS = 6000
export const DIGEST_LINE_MAX_CHARS = 300
export const DIGEST_TOOL_CALL_MAX_CHARS = 100

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()

/**
 * 规范行渲染（行格式唯一权威，spec §5.1）：user/assistant/thinking 每条截
 * DIGEST_LINE_MAX_CHARS 字单行（thinking 前缀 `THINKING:`），tool 只留 `[tool: 名字]`
 * （带 toolCall 时附截 100 字调用摘要），system 跳过。
 * 从旧 buildDeterministicDigest 内部原样提出；纯函数、永不抛。
 */
export function renderDigestLines(turns: readonly TranscriptTurn[]): string[] {
  if (!Array.isArray(turns) || turns.length === 0) return []
  const lines: string[] = []
  for (const t of turns) {
    if (t.role === 'user') lines.push(`USER: ${squash(t.content).slice(0, DIGEST_LINE_MAX_CHARS)}`)
    else if (t.role === 'assistant') lines.push(`ASSISTANT: ${squash(t.content).slice(0, DIGEST_LINE_MAX_CHARS)}`)
    else if (t.role === 'thinking') lines.push(`THINKING: ${squash(t.content).slice(0, DIGEST_LINE_MAX_CHARS)}`)
    else if (t.role === 'tool') {
      const name = t.toolName ?? 'unknown'
      if (t.toolCall) {
        const c = t.toolCall.length > DIGEST_TOOL_CALL_MAX_CHARS
          ? t.toolCall.slice(0, DIGEST_TOOL_CALL_MAX_CHARS) + '…[truncated]'
          : t.toolCall
        lines.push(`[tool: ${name}] ${c}`)
      } else {
        lines.push(`[tool: ${name}]`)
      }
    }
    // system 跳过
  }
  return lines
}

/**
 * 最旧整行丢弃直到 join('\n') 后 ≤ maxChars；仅剩单行仍超时原样返回（尾部切片
 * 归调用方）。经济模式确定性 digest 与 LLM 事实账本共用的唯一留存实现
 * （spec §2 G4：丢最旧、保最近）。纯函数。
 */
export function trimOldestLines(lines: readonly string[], maxChars: number): string[] {
  const out = [...lines]
  let joined = out.join('\n')
  while (joined.length > maxChars && out.length > 1) {
    out.shift()
    joined = out.join('\n')
  }
  return out
}

/**
 * 确定性 digest（经济模式；质量模式的降级兜底）：renderDigestLines + trimOldestLines，
 * 单行即超限时保留末尾 maxChars 字（沿用旧边界行为）。
 * 硬约束：对外行为与旧实现逐字节一致（spec §3；既有测试为回归锁）。
 * 纯函数、同输入逐字节同输出（prompt 稳定性，spec §4.2）、永不抛。
 */
export function buildDeterministicDigest(
  turns: readonly TranscriptTurn[],
  maxChars: number = DIGEST_MAX_CHARS,
): string {
  const kept = trimOldestLines(renderDigestLines(turns), maxChars)
  const out = kept.join('\n')
  return out.length > maxChars ? out.slice(out.length - maxChars) : out
}