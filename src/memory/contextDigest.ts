// src/memory/contextDigest.ts
import type { TranscriptTurn } from './pure'

export const DIGEST_MAX_CHARS = 3000
export const DIGEST_LINE_MAX_CHARS = 300

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()

/**
 * 确定性 digest（经济模式；质量模式的降级兜底）：user/assistant 每条截
 * DIGEST_LINE_MAX_CHARS 字单行，tool 只留 `[tool: 名字]`，system 跳过。
 * 时间序拼接；超 maxChars 从最早处整行丢弃（保留最近上下文）。
 * 纯函数、同输入逐字节同输出（prompt 稳定性，spec §4.2）、永不抛。
 */
export function buildDeterministicDigest(
  turns: readonly TranscriptTurn[],
  maxChars: number = DIGEST_MAX_CHARS,
): string {
  if (!Array.isArray(turns) || turns.length === 0) return ''
  const lines: string[] = []
  for (const t of turns) {
    if (t.role === 'user') lines.push(`USER: ${squash(t.content).slice(0, DIGEST_LINE_MAX_CHARS)}`)
    else if (t.role === 'assistant') lines.push(`ASSISTANT: ${squash(t.content).slice(0, DIGEST_LINE_MAX_CHARS)}`)
    else if (t.role === 'tool') lines.push(`[tool: ${t.toolName ?? 'unknown'}]`)
    // system 跳过
  }
  // 从最早处整行丢弃直到总量达标（最后截一次行首防单行即超限的边界）。
  let out = lines.join('\n')
  while (out.length > maxChars && lines.length > 1) {
    lines.shift()
    out = lines.join('\n')
  }
  return out.length > maxChars ? out.slice(out.length - maxChars) : out
}
