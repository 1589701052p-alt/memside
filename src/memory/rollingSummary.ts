// src/memory/rollingSummary.ts
import type { TranscriptTurn } from './pure'
import type { LLMCall } from '@/llm'
import { DIGEST_MAX_CHARS, DIGEST_LINE_MAX_CHARS } from './contextDigest'

/**
 * 滚动摘要 system prompt（spec §4.3）。中立压缩：只压缩不评判，
 * 禁止 keep/discard/倾向性措辞（项目记忆：LLM 判定 prompt 必须中立）。
 */
export const ROLLING_SUMMARY_SYSTEM_PROMPT = `You are a conversation-digest compressor for a memory sidecar.

You maintain a running digest of the EARLIER part of a developer-agent session, so that a later distillation step can understand the context of newer turns.

Rules:
- Output ONLY the merged digest text, no JSON, no markdown fences, no commentary.
- Write in 简体中文 (technical terms may stay in English).
- Chronological, topic-grouped plain sentences; one fact per line.
- Compress mechanically: merge what is given, do not editorialize, rank, or advise.
- Hard length budget: at most ${DIGEST_MAX_CHARS} characters.`

const renderTurns = (turns: readonly TranscriptTurn[]): string =>
  turns.map((t) => `[${t.role}] ${t.content.replace(/\s+/g, ' ').trim().slice(0, DIGEST_LINE_MAX_CHARS)}`).join('\n')

/**
 * 把本次切片增量并入既有滚动摘要。priorDigest=null 为首建。
 * LLM 错误向外抛（调用方保留旧摘要 + logDegradation）；空白产出同视为失败。
 * 产出超长由代码强制截断（不信任 LLM，spec §4.3）并以 truncated 标记告知调用方
 * （调用方 logDegradation('digest_truncated')，spec §5 #8）。
 */
export async function mergeRollingSummary(
  priorDigest: string | null,
  newTurns: readonly TranscriptTurn[],
  callLLM: LLMCall,
): Promise<{ digest: string; truncated: boolean }> {
  const newSlice = renderTurns(newTurns)
  const user = priorDigest
    ? `旧摘要：\n${priorDigest}\n\n新增会话内容：\n${newSlice}\n\n请输出合并后的新摘要。`
    : `会话内容：\n${newSlice}\n\n请输出摘要。`
  const out = await callLLM(ROLLING_SUMMARY_SYSTEM_PROMPT, user)
  const trimmed = (out ?? '').trim()
  if (!trimmed) throw new Error('rolling summary: empty LLM output')
  const truncated = trimmed.length > DIGEST_MAX_CHARS
  return { digest: truncated ? trimmed.slice(0, DIGEST_MAX_CHARS) : trimmed, truncated }
}
