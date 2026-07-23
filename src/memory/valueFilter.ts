import type { DistillCandidate } from '@/memory/distiller'

export type ValueClass = 'decision' | 'convention' | 'trap' | 'topology'
export type DiscardReason = 'public-knowledge' | 'derivable'

export type ValueVerdict =
  | { index: number; keep: false; reason: DiscardReason }
  | { index: number; keep: true; valueClass: ValueClass }
  | { index: number; keep: true; valueClass: null }

export const VALUE_JUDGE_SYSTEM_PROMPT = `You are memside-value-judge. Classify each candidate memory into exactly one
category by these criteria:

1. public-knowledge - obtainable via Google / official docs / source within ~10s
   (language syntax, stdlib, third-party API, generic algorithms, public standards).
2. derivable - re-derivable by reading existing code/files/docs; only a file path
   or entry point would need remembering.
3. decision - the WHY behind a choice: abandoned alternatives, constraints that
   drove the decision.
4. convention - an unwritten team rule / reviewer preference not documented anywhere.
5. trap - counterintuitive behavior, known gotcha, recurring pitfall.
6. topology - a cross-boundary connection (cross-module/service/team/repo) invisible
   from any single vantage point.

Pick the best-fitting category for each candidate. Respond ONLY with JSON:
{"verdicts":[{"index":<n>,"category":"public-knowledge|derivable|decision|convention|trap|topology"}]}.
Emit one verdict per candidate, keyed by index.`

const VALID_CATEGORIES = new Set([
  'public-knowledge', 'derivable', 'decision', 'convention', 'trap', 'topology',
])
const DISCARD_CATEGORIES = new Set(['public-knowledge', 'derivable'])
const VALUE_CLASS_MAP: Record<string, ValueClass> = {
  decision: 'decision', convention: 'convention', trap: 'trap', topology: 'topology',
}

function renderUserPrompt(candidates: DistillCandidate[]): string {
  return candidates.map((c, i) => `[${i}] ${c.title}\n${c.bodyMd}`).join('\n---\n')
}

/**
 * Classify each candidate into one of 6 categories (rules 1-6). Code maps
 * public-knowledge/derivable => discard, decision/convention/trap/topology =>
 * keep with valueClass. No valid classification (LLM error / non-JSON / missing
 * index / hallucinated category) => keep with valueClass=null (unevaluated):
 * discard requires a positive rule-1/2 classification; absent that, keep. Never
 * throws, never blocks distill (mirrors dedup's judgeDuplicates).
 */
export async function judgeValue(
  candidates: DistillCandidate[],
  callAnthropic: (system: string, user: string) => Promise<string>,
): Promise<ValueVerdict[]> {
  const n = candidates.length
  if (n === 0) return []
  const keepNull = (): ValueVerdict[] =>
    candidates.map((_, i) => ({ index: i, keep: true, valueClass: null }))
  try {
    const raw = await callAnthropic(VALUE_JUDGE_SYSTEM_PROMPT, renderUserPrompt(candidates))
    const parsed = JSON.parse(raw) as { verdicts?: unknown }
    if (!parsed || !Array.isArray(parsed.verdicts)) return keepNull()
    const byIndex = new Map<number, ValueVerdict>()
    for (const v of parsed.verdicts) {
      if (!v || typeof v !== 'object') continue
      const o = v as { index?: unknown; category?: unknown }
      if (typeof o.index !== 'number' || o.index < 0 || o.index >= n) continue
      if (typeof o.category !== 'string' || !VALID_CATEGORIES.has(o.category)) {
        byIndex.set(o.index, { index: o.index, keep: true, valueClass: null })
        continue
      }
      if (DISCARD_CATEGORIES.has(o.category)) {
        byIndex.set(o.index, { index: o.index, keep: false, reason: o.category as DiscardReason })
      } else {
        byIndex.set(o.index, { index: o.index, keep: true, valueClass: VALUE_CLASS_MAP[o.category] })
      }
    }
    return candidates.map((_, i) => byIndex.get(i) ?? { index: i, keep: true, valueClass: null })
  } catch {
    return keepNull()
  }
}
