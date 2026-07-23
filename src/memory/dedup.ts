import type { DistillCandidate } from '@/memory/distiller'
import type { MemoryScope, MemoryStatus } from '@/memory/pure'

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
  callAnthropic: (system: string, user: string) => Promise<string>
}

export type DedupVerdict =
  | { index: number; duplicate: false }
  | { index: number; duplicate: true; duplicateOfId: string }

export const DEDUP_SYSTEM_PROMPT = `You are memside-dedup. Decide whether each new candidate memory is a SEMANTIC DUPLICATE of any existing memory in the same scope - the same rule or fact, even if worded differently or tagged with a different [category:] prefix.

Respond ONLY with JSON: {"verdicts":[{"index":<n>,"isDuplicate":true,"duplicateOfId":"<id>"} | {"index":<n>,"isDuplicate":false}]}. Emit one verdict per new candidate, keyed by its index. duplicateOfId MUST be one of the existing ids. When unsure, emit isDuplicate:false.`

function renderUserPrompt(newCandidates: DistillCandidate[], existing: ExistingMemoryForDedup[]): string {
  // judgeDuplicates short-circuits empty `existing` before reaching here, so the
  // map join never runs against []. No `(none)` fallback needed.
  const exLines = existing.map((e) => `id=${e.id} | ${e.title}`).join('\n')
  const newLines = newCandidates.map((c, i) => `[${i}] ${c.title}\n${c.bodyMd}`).join('\n---\n')
  return `Existing memories (same scope):\n${exLines}\n\nNew candidates:\n${newLines}\n\nReturn JSON per the system instructions.`
}

/**
 * Judge each new candidate against same-scope existing memories for semantic
 * duplication. Pure + injectable `callAnthropic` (same seam as the distiller).
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
    const raw = await input.callAnthropic(DEDUP_SYSTEM_PROMPT, renderUserPrompt(input.newCandidates, input.existing))
    const parsed = JSON.parse(raw) as { verdicts?: unknown }
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
