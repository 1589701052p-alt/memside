import type { DistillCandidate } from '@/memory/distiller'
import type { MemoryScope, MemoryStatus } from '@/memory/pure'
import { callWithRetry } from './retry'
import type { LLMCall } from '@/llm'

export interface ExistingMemoryForDedup {
  id: string
  title: string
  scopeType: MemoryScope
  scopeId: string | null
  status: MemoryStatus
}

export interface DedupInput {
  newCandidates: DistillCandidate[]
  existing: ExistingMemoryForDedup[]
  callLLM: LLMCall
}

export type DedupVerdict =
  | { index: number; duplicate: false }
  | { index: number; duplicate: true; duplicateOfId: string }

export const DEDUP_SYSTEM_PROMPT = `You are memside-dedup. Decide whether each new candidate memory is a SEMANTIC DUPLICATE of any existing memory in the same scope - the same rule or fact, even if worded differently or tagged with a different [category:] prefix.

输出格式如下（仅示范结构，勿照抄内容；只输出这一个 JSON 对象，无 markdown 围栏，无解释文字）：
{
  "verdicts": [
    {"index": 0, "isDuplicate": false},
    {"index": 1, "isDuplicate": true, "duplicateOfId": "A"}
  ]
}
Emit one verdict per new candidate, keyed by its index. duplicateOfId MUST be one of the existing ids.`

function renderUserPrompt(newCandidates: DistillCandidate[], existing: ExistingMemoryForDedup[]): string {
  // judgeDuplicates short-circuits empty `existing` before reaching here, so the
  // map join never runs against []. No `(none)` fallback needed.
  const exLines = existing.map((e) => `id=${e.id} | ${e.title}`).join('\n')
  const newLines = newCandidates.map((c, i) => `[${i}] ${c.title}\n${c.bodyMd}`).join('\n---\n')
  return `Existing memories (same scope):\n${exLines}\n\nNew candidates:\n${newLines}\n\nReturn JSON per the system instructions.`
}

/**
 * Validate parsed dedup output for retry-worthiness. Returns an error message
 * to retry, or null to accept. Checks: parsed has a `verdicts` array, each
 * verdict has a numeric `index`, and any `isDuplicate:true` verdict references
 * a `duplicateOfId` in `existingIds`. Exhausted retries fall through to the
 * existing per-verdict hallucination->new logic.
 */
function dedupShouldRetry(existingIds: Set<string>): (parsed: unknown) => string | null {
  return (parsed) => {
    if (!parsed || typeof parsed !== 'object') return '返回的不是 JSON 对象'
    const p = parsed as { verdicts?: unknown }
    if (!Array.isArray(p.verdicts)) return '缺少 verdicts 数组'
    for (let i = 0; i < p.verdicts.length; i++) {
      const v = p.verdicts[i] as Record<string, unknown> | null
      if (!v || typeof v.index !== 'number') return `verdict ${i} 缺少 index`
      if (v.isDuplicate === true) {
        if (typeof v.duplicateOfId !== 'string') return `verdict ${v.index} 标记重复但缺少 duplicateOfId`
        if (!existingIds.has(v.duplicateOfId)) return `verdict ${v.index} 的 duplicateOfId 不在已有记忆中`
      }
    }
    return null
  }
}

/**
 * Judge each new candidate against same-scope existing memories for semantic
 * duplication. Pure + injectable `callLLM` (same seam as the distiller).
 *
 * Conservative fallback (never throws, never drops info): on LLM error, non-JSON,
 * missing `verdicts`, missing indices, or a hallucinated `duplicateOfId` not in
 * `existing`, the affected candidate is treated as `duplicate:false` (kept). When
 * `existing` is empty or `newCandidates` is empty, the LLM is not called at all.
 */
export async function judgeDuplicates(input: DedupInput): Promise<DedupVerdict[]> {
  const n = input.newCandidates.length
  if (n === 0) return []
  if (input.existing.length === 0) {
    return input.newCandidates.map((_, i) => ({ index: i, duplicate: false }))
  }
  const existingIds = new Set(input.existing.map((e) => e.id))
  try {
    const parsed = await callWithRetry({
      call: input.callLLM,
      system: DEDUP_SYSTEM_PROMPT,
      user: renderUserPrompt(input.newCandidates, input.existing),
      shouldRetry: dedupShouldRetry(existingIds),
    }) as { verdicts?: unknown } | undefined
    if (!parsed || !Array.isArray(parsed.verdicts)) {
      return input.newCandidates.map((_, i) => ({ index: i, duplicate: false }))
    }
    const byIndex = new Map<number, DedupVerdict>()
    for (const v of parsed.verdicts) {
      if (!v || typeof v !== 'object') continue
      const o = v as { index?: unknown; isDuplicate?: unknown; duplicateOfId?: unknown }
      if (typeof o.index !== 'number' || o.index < 0 || o.index >= n) continue
      if (o.isDuplicate === true && typeof o.duplicateOfId === 'string' && existingIds.has(o.duplicateOfId)) {
        byIndex.set(o.index, { index: o.index, duplicate: true, duplicateOfId: o.duplicateOfId })
      } else {
        // isDuplicate:false OR hallucinated duplicateOfId -> treat as new
        byIndex.set(o.index, { index: o.index, duplicate: false })
      }
    }
    // Any index the LLM omitted -> new (conservative)
    return input.newCandidates.map((_, i) => byIndex.get(i) ?? { index: i, duplicate: false })
  } catch {
    return input.newCandidates.map((_, i) => ({ index: i, duplicate: false }))
  }
}
