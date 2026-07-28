import type { DistillCandidate } from '@/memory/distiller'
import type { LLMCall } from '@/llm'
import { callWithRetry } from './retry'

export type ValueClass = 'decision' | 'convention' | 'trap' | 'topology'
export type DiscardReason = 'public-knowledge' | 'derivable' | 'taming'

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

Each candidate is marked with a ruleObject hint: codebase (describes the current repository's own code/config/modules) or domain (describes something outside the repository). Apply the 6 categories above as written - a codebase-ruleObject candidate that describes this repository's own design decisions, implementation rules, or internal behavior is derivable.

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

const TAMING_PATTERNS: readonly string[] = [
  // A 压制异议/批评/质疑
  '不要质疑', '别质疑', '不准质疑', '不要反驳', '别反驳', '不要反对', '别反对',
  '不要批评', '别批评', '不要指责', '不要唱反调', '不要提反对', '不要质疑我', '不要质疑用户',
  'never question', "don't question", 'never criticize', "don't criticize",
  'never criticise', "don't criticise", 'never disagree', "don't disagree",
  'never challenge', "don't challenge", 'never push back', "don't push back",
  'never argue', "don't argue", 'never correct me', "don't correct me", "don't contradict",
  // B 要求赞同/肯定
  '永远同意', '总是同意', '无条件同意', '永远赞同', '总是赞同', '永远支持我', '总是支持我',
  '不要否定', '别否定', '永远肯定', '永远站在我这边',
  'always agree', 'always validate', 'always affirm', 'always support me',
  'never say no', 'always say yes', 'always be agreeable',
  // C 压制诚实评价
  '不要指出问题', '别指出问题', '不要挑毛病', '别挑毛病', '不要给负面', '不要泼冷水',
  '不要给批评性',
  "don't point out problems", 'never point out problems',
  "don't give negative feedback", 'never give negative feedback',
  "don't be critical", 'never be critical',
  // D 依赖/角色扮演（dev 罕见，仅高精度标记）
  '角色扮演', 'roleplay', 'role-play', '永远陪伴', '一直陪着我', 'always be here for me',
]

/**
 * 确定性驯化检测（第 4 项）：匹配「要求 agent 压制诚实反馈 / 永远赞同 / foster 依赖」类
 * 指令。命中即丢弃（valueFilter taming override）。精度优先（liberal-capture 立场）：
 * 宁可漏隐晦驯化（留给人工审批），不可误杀合法 convention。短语限定在「反馈/评价动词」，
 * 不碰任务规则动词（use/commit/run），避免误杀 `always use bun` / `don't commit to master`。
 *
 * 纯函数、永不抛：兜底返回 false（不误杀）。关键词在代码里、不进 LLM system prompt，
 * 故不影响 valueFilter 的 neutrality 硬约束。
 */
export function detectTaming(title: string, bodyMd: string): boolean {
  try {
    const text = `${title}\n${bodyMd}`.toLowerCase()
    return TAMING_PATTERNS.some((p) => text.includes(p.toLowerCase()))
  } catch {
    return false  // 兜底：不误杀，走正常 LLM 分类
  }
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
  return candidates.map((c, i) => `[${i}] (ruleObject: ${c.ruleObject ?? 'codebase'}) ${c.title}\n${c.bodyMd}`).join('\n---\n')
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
 * Existing value-classification logic (rounds 1-3): keepNull fallback + LLM 6-class
 * classify + protected-category force-keep. Behavior identical to pre-fix6 judgeValue.
 * Extracted (fix6) so judgeValue can layer the taming override on top without touching
 * this logic - see I3-style specific-source guard sensitivity in STATE.md.
 */
async function judgeValueBase(
  candidates: DistillCandidate[],
  callLLM: LLMCall,
): Promise<ValueVerdict[]> {
  const n = candidates.length
  if (n === 0) return []
  const keepNull = (): ValueVerdict[] =>
    candidates.map((c, i) => {
      const cat = parseCategory(c.title)
      const subj = c.ruleObject === 'domain' ? 'domain' : 'codebase'
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
      const subj = c.ruleObject === 'domain' ? 'domain' : 'codebase'
      if (cat && VALUE_PROTECTED_CATEGORIES.has(cat) && subj === 'domain') {
        return { index: i, keep: true, valueClass: 'decision' as ValueClass }
      }
      return byIndex.get(i) ?? { index: i, keep: true, valueClass: null }
    })
  } catch {
    return keepNull()
  }
}

/**
 * Classify each candidate into one of 6 categories (rules 1-6) + apply taming override
 * (fix6). Code maps public-knowledge/derivable => discard, decision/convention/trap/
 * topology => keep with valueClass; protected categories (invariant/integration/
 * compliance × ruleObject=domain) are force-kept with valueClass='decision' inside
 * judgeValueBase. judgeValueBase swallows its own LLM errors (all keep+null/decision),
 * never bubbles. The taming override (fix6) runs last and overrides protected force-keep
 * (safety > protection): a taming instruction is discarded even if mislabeled invariant.
 */
export async function judgeValue(
  candidates: DistillCandidate[],
  callLLM: LLMCall,
): Promise<ValueVerdict[]> {
  const n = candidates.length
  if (n === 0) return []
  const base = await judgeValueBase(candidates, callLLM)
  // 第六轮第 4 项：taming override，最后跑，覆盖 protected force-keep（安全 > 保护）。
  // 驯化指令即使被误标 [category:invariant] ruleObject=domain，仍丢弃--合法 business
  // invariant 不会含反馈压制词，无现实冲突。
  return base.map((v, i) =>
    detectTaming(candidates[i]!.title, candidates[i]!.bodyMd)
      ? { index: i, keep: false, reason: 'taming' }
      : v
  )
}
