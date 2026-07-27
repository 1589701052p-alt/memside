import type { DistillCandidate } from '@/memory/distiller'
import type { LLMCall } from '@/llm'
import { callWithRetry } from './retry'

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
   Project-specific business rules, contracts, and SLAs do not belong here.
2. derivable - re-derivable by reading THIS repository's current code/files/docs
   without the conversation. If the candidate describes the codebase being worked
   on (file paths, function/symbol names, config defaults, internal module
   behavior, file contents), it is derivable even when rationale is given.
3. decision - the WHY behind a choice: abandoned alternatives, constraints that
   drove the decision.
4. convention - an unwritten team rule / reviewer preference not documented anywhere.
5. trap - counterintuitive behavior, known gotcha, recurring pitfall.
6. topology - a cross-boundary connection (cross-module/service/team/repo) invisible
   from any single vantage point.

Each candidate is marked with a subject hint: codebase (describes the current repository's own code/config/modules) or domain (describes something outside the repository). Apply the 6 categories above as written - a codebase-subject candidate that describes this repository's own design decisions, implementation rules, or internal behavior is derivable.

Pick the best-fitting category for each candidate. 输出格式如下（仅示范结构，勿照抄内容；只输出这一个 JSON 对象，无 markdown 围栏，无解释文字）：
{
  "verdicts": [
    {"index": 0, "category": "decision"},
    {"index": 1, "category": "public-knowledge"}
  ]
}
Emit one verdict per candidate, keyed by index.`

export function parseCategory(title: string): string | null {
  const m = /^\s*\[category:([^\]]+)\]/i.exec(title)
  if (!m) return null
  return m[1]!.trim().toLowerCase()
}

/** Distill categories whose candidates valueFilter must NEVER discard:
 *  business hard rules / external contracts / regulatory constraints.
 *  Force-kept with valueClass='decision' (non-null -> immune to the Web UI
 *  "批量拒绝未评估" button, which targets value_class IS NULL). */
export const VALUE_PROTECTED_CATEGORIES = new Set(['invariant', 'integration', 'compliance'])

const VALID_CATEGORIES = new Set([
  'public-knowledge', 'derivable', 'decision', 'convention', 'trap', 'topology',
])
const DISCARD_CATEGORIES = new Set(['public-knowledge', 'derivable'])
const VALUE_CLASS_MAP: Record<string, ValueClass> = {
  decision: 'decision', convention: 'convention', trap: 'trap', topology: 'topology',
}

function renderUserPrompt(candidates: DistillCandidate[]): string {
  return candidates.map((c, i) => `[${i}] (subject: ${c.subject ?? 'codebase'}) ${c.title}\n${c.bodyMd}`).join('\n---\n')
}

/**
 * Validate parsed value-judge output for retry-worthiness. Returns an error
 * message to retry, or null to accept. Checks: parsed has a `verdicts` array,
 * each verdict has a numeric `index` in [0, n), and a `category` string that is
 * one of the 6 VALID_CATEGORIES. Exhausted retries fall through to the existing
 * per-verdict hallucinated-category -> keep+null mapping.
 */
function valueShouldRetry(n: number): (parsed: unknown) => string | null {
  return (parsed) => {
    if (!parsed || typeof parsed !== 'object') return '返回的不是 JSON 对象'
    const p = parsed as { verdicts?: unknown }
    if (!Array.isArray(p.verdicts)) return '缺少 verdicts 数组'
    for (let i = 0; i < p.verdicts.length; i++) {
      const v = p.verdicts[i] as Record<string, unknown> | null
      if (!v || typeof v.index !== 'number') return `verdict ${i} 缺少 index`
      if (v.index < 0 || v.index >= n) return `verdict ${v.index} 的 index 越界`
      if (typeof v.category !== 'string' || !VALID_CATEGORIES.has(v.category)) {
        return `verdict ${v.index} 的 category 非法`
      }
    }
    return null
  }
}

/**
 * Classify each candidate into one of 6 categories (rules 1-6). Code maps
 * public-knowledge/derivable => discard, decision/convention/trap/topology =>
 * keep with valueClass. No valid classification (LLM error / non-JSON / missing
 * verdicts / missing index / hallucinated category / retries exhausted) => keep
 * with valueClass=null (unevaluated): discard requires a positive rule-1/2
 * classification; absent that, keep. Never throws, never blocks distill (mirrors
 * dedup's judgeDuplicates).
 */
export async function judgeValue(
  candidates: DistillCandidate[],
  callLLM: LLMCall,
): Promise<ValueVerdict[]> {
  const n = candidates.length
  if (n === 0) return []
  const keepNull = (): ValueVerdict[] =>
    candidates.map((c, i) => {
      const cat = parseCategory(c.title)
      const subj = c.subject === 'domain' ? 'domain' : 'codebase'
      return (cat && VALUE_PROTECTED_CATEGORIES.has(cat) && subj === 'domain')
        ? { index: i, keep: true, valueClass: 'decision' as ValueClass }
        : { index: i, keep: true, valueClass: null }
    })
  try {
    const parsed = await callWithRetry({
      call: callLLM,
      system: VALUE_JUDGE_SYSTEM_PROMPT,
      user: renderUserPrompt(candidates),
      shouldRetry: valueShouldRetry(n),
    }) as { verdicts?: unknown } | undefined
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
    return candidates.map((c, i) => {
      const cat = parseCategory(c.title)
      const subj = c.subject === 'domain' ? 'domain' : 'codebase'
      if (cat && VALUE_PROTECTED_CATEGORIES.has(cat) && subj === 'domain') {
        return { index: i, keep: true, valueClass: 'decision' as ValueClass }
      }
      return byIndex.get(i) ?? { index: i, keep: true, valueClass: null }
    })
  } catch {
    return keepNull()
  }
}
