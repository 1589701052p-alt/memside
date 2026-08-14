import type { DistillCandidate } from '@/memory/distiller'
import type { LLMCall } from '@/llm'
import { callWithRetry } from './retry'

export type ValueClass = 'user-rule' | 'decision' | 'preference' | 'convention' | 'trap' | 'topology'
export type DiscardReason = 'public-knowledge' | 'derivable' | 'taming' | 'fleeting' | 'exact-duplicate' | 'duplicate'

export type ValueVerdict =
  | { index: number; keep: false; reason: DiscardReason }
  | { index: number; keep: true; valueClass: ValueClass }
  | { index: number; keep: true; valueClass: null }

// Task 5: prompt 拆为 头+规则+输出段 三段再拼回。字节锁 tests/value-filter-prompt.test.ts
// 保证重组后与原字面量逐字节一致(判定规则文本语义零变更);agent 判定器复用头+规则段
// 并追加 agent 协议段,避免两份规则文本漂移。
export const VALUE_JUDGE_HEADER = `You are memside-value-judge. Assign exactly one category to each candidate memory.

`
export const VALUE_JUDGE_RULES = `Each candidate carries an origin tag: user-stated (the user said it in this session),
user-confirmed (the agent proposed it and the user explicitly adopted it), or
agent-observed (the agent derived it on its own).

Retain categories (assign the best fit):
1. user-rule - an explicit rule or hard constraint the user laid down: workflow rules,
   quality bars, safety constraints.
2. decision - the WHY behind a choice the user made or adopted: abandoned alternatives,
   driving constraints.
3. preference - the user's personal preferences and collaboration habits.
4. convention - an unwritten team/repo norm that holds steady without being stated by
   the user in this session.
5. trap - counterintuitive behavior, known gotchas, postmortem lessons from incidents.
6. topology - a cross-boundary connection (cross-module/service/repo) invisible from
   any single vantage point.

Drop categories (assign only when the stated test passes):
7. public-knowledge - TEST: could an engineer who never read this repo and never saw
   this session write this entry from general knowledge or official docs alone?
   ("Python dicts preserve insertion order" -> yes; "refunds only within 14 days of
   shipment in this product" -> no.)
8. derivable - TEST: reading only this repository's code/docs/config, never this
   conversation, could one re-derive this entry's content? ("the token mask retains the
   first 6 and last 4 chars" -> yes; "the credential chain puts UI first because stale
   env vars once caused a 401 outage" -> no - the code shows the order, not the why.)
   "Docs" includes this project's own rulebooks and specs (CLAUDE.md, README,
   STATE.md, docs/, and test files that grep-guard a rule): a standing rule already
   written there is derivable even when it also reads as a convention or process
   norm - assign derivable, not convention. ("tests must run with bun test, per
   CLAUDE.md" -> derivable; "reviewers here prefer merge commits over squash,
   nowhere written down" -> convention.)
   HARD RULE: never assign derivable to a candidate whose origin is user-stated or
   user-confirmed.
9. fleeting - TEST: in a brand-new session three months from now, would this entry
   still bind or inform? ("let's stop here for today" -> no; "every change lands via
   branch + PR" -> yes.)
   HARD RULE: fleeting is ONLY for session logistics (scheduling, "for today",
   "after lunch") and for guidance the entry itself marks as superseded. A standing
   rule, workflow, or quality gate of this project - however small - still binds
   three months from now by definition; never assign fleeting to one. ("never commit
   directly to master" -> not fleeting; "we'll merge PR #58 after lunch" ->
   fleeting.)`
const VALUE_JUDGE_OUTPUT_SECTION = `

输出格式如下（仅示范结构，勿照抄内容；只输出这一个 JSON 对象，无 markdown 围栏，无解释文字）：
{
  "verdicts": [
    {"index": 0, "category": "decision"},
    {"index": 1, "category": "public-knowledge"}
  ]
}
Emit one verdict per candidate, keyed by index.`
export const VALUE_JUDGE_SYSTEM_PROMPT = VALUE_JUDGE_HEADER + VALUE_JUDGE_RULES + VALUE_JUDGE_OUTPUT_SECTION

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

const VALID_CATEGORIES = new Set([
  'user-rule', 'decision', 'preference', 'convention', 'trap', 'topology',
  'public-knowledge', 'derivable', 'fleeting',
])
const DISCARD_CATEGORIES = new Set(['public-knowledge', 'derivable', 'fleeting'])
const VALUE_CLASS_MAP: Record<string, ValueClass> = {
  'user-rule': 'user-rule', decision: 'decision', preference: 'preference',
  convention: 'convention', trap: 'trap', topology: 'topology',
}

/** Task 5:agent 判定器合法类别 = 单发 9 类 + 第 10 类 duplicate(对已审批记忆语义重复)。 */
export const AGENT_VALID_CATEGORIES: ReadonlySet<string> = new Set([
  'user-rule', 'decision', 'preference', 'convention', 'trap', 'topology',
  'public-knowledge', 'derivable', 'fleeting', 'duplicate',
])

/**
 * 逐条 verdict 映射(经济/质量共用):discard 类 -> keep:false;retain 类 -> keep+valueClass;
 * 非法类别/缺漏下标 -> 保守 keep(stated->decision,observed->null);
 * stated 免疫硬兜底:origin 非 agent-observed 被判 derivable -> 改判 keep+decision
 * (spec §R2 回归锁;duplicate 不免疫——用户复述一条已审批记忆同样是重复)。
 */
export function verdictsFromCategories(
  entries: { index: number; category: string }[],
  candidates: DistillCandidate[],
  validCategories: ReadonlySet<string>,
  discardCategories: ReadonlySet<string>,
): ValueVerdict[] {
  const n = candidates.length
  const byIndex = new Map<number, ValueVerdict>()
  for (const v of entries) {
    if (typeof v.index !== 'number' || v.index < 0 || v.index >= n) continue
    if (!validCategories.has(v.category)) {
      // 与失败兜底一致(spec §R3):stated/confirmed -> decision(免疫批量拒绝未评估),
      // observed -> null。幻觉类别兜底不能比 LLM-整体失败兜底更弱。
      byIndex.set(v.index, { index: v.index, keep: true,
        valueClass: candidates[v.index]!.origin === 'agent-observed' ? null : 'decision' })
      continue
    }
    if (discardCategories.has(v.category)) {
      // 代码硬兜底(spec §R2,7-30 误杀回归锁):用户陈述类免疫 derivable。
      // prompt 已禁考 Q2;LLM 违规时这里改判 keep+decision。fleeting 不免疫
      //(Q3 是 AI 对用户话语的判断权,"今天先到这吧" 该丢)。duplicate 同样不免疫。
      if (v.category === 'derivable' && candidates[v.index]!.origin !== 'agent-observed') {
        byIndex.set(v.index, { index: v.index, keep: true, valueClass: 'decision' })
      } else {
        byIndex.set(v.index, { index: v.index, keep: false, reason: v.category as DiscardReason })
      }
    } else {
      byIndex.set(v.index, { index: v.index, keep: true, valueClass: VALUE_CLASS_MAP[v.category] })
    }
  }
  return candidates.map((c, i) => byIndex.get(i) ?? {
    index: i, keep: true,
    valueClass: c.origin === 'agent-observed' ? null : 'decision',
  })
}

function renderUserPrompt(candidates: DistillCandidate[]): string {
  return candidates.map((c, i) =>
    `[${i}] (origin: ${c.origin}) ${c.title}\n${c.bodyMd}${c.evidence ? `\n出处: ${c.evidence}` : ''}`,
  ).join('\n---\n')
}

/**
 * Validate parsed value-judge output for retry-worthiness. Returns an error
 * message to retry, or null to accept. Checks: parsed has a `verdicts` array,
 * each verdict has a numeric `index` in [0, n), and a `category` string that is
 * one of the 9 VALID_CATEGORIES. Exhausted retries fall through to the existing
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
 * Origin-driven value classification (9 类：6 留 + 3 丢) + stated 免疫 derivable 兜底。
 * keepNull 失败兜底：用户陈述类（user-stated/user-confirmed）给 decision（免疫 Web UI
 * "批量拒绝未评估" 按钮，该按钮 target value_class IS NULL），agent-observed 给 null。
 * 主路径映射 LLM 9 类 verdict：retain 6 类 -> keep+valueClass；drop 3 类（public-knowledge
 * /derivable/fleeting）-> discard。代码硬兜底（spec §R2，7-30 误杀回归锁）：origin 非
 * agent-observed 的候选被判 derivable 时改判 keep+decision（prompt 已禁考 Q2，LLM 违规
 * 时代码再兜一道）。judgeValueBase 吞自身 LLM 错误（全 keep+null/decision），不冒泡。
 */
async function judgeValueBase(
  candidates: DistillCandidate[],
  callLLM: LLMCall,
): Promise<ValueVerdict[]> {
  const n = candidates.length
  if (n === 0) return []
  const keepNull = (): ValueVerdict[] =>
    candidates.map((c, i) => ({
      index: i,
      keep: true,
      // R3 失败兜底（spec）：用户陈述类给 decision（免疫批量拒绝），observed 给 null。
      valueClass: c.origin === 'agent-observed' ? null : ('decision' as ValueClass),
    }))
  try {
    const parsed = await callWithRetry({
      call: callLLM,
      system: VALUE_JUDGE_SYSTEM_PROMPT,
      user: renderUserPrompt(candidates),
      shouldRetry: valueShouldRetry(n),
    }) as { verdicts?: unknown } | undefined
    if (!parsed || !Array.isArray(parsed.verdicts)) return keepNull()
    const entries = (parsed.verdicts as unknown[]).filter(
      (v): v is { index: number; category: string } =>
        !!v && typeof v === 'object' &&
        typeof (v as { index?: unknown }).index === 'number' &&
        typeof (v as { category?: unknown }).category === 'string',
    )
    // Task 5:逐条映射逻辑抽为 verdictsFromCategories(与 agent 判定器共用),语义不变。
    return verdictsFromCategories(entries, candidates, VALID_CATEGORIES, DISCARD_CATEGORIES)
  } catch {
    return keepNull()
  }
}

/**
 * Classify each candidate into one of 9 categories (6 retain + 3 drop) + apply taming
 * override (fix6). Code maps public-knowledge/derivable/fleeting => discard,
 * user-rule/decision/preference/convention/trap/topology => keep with valueClass;
 * stated-immune backstop (spec §R2) re-classifies non-observed candidates that the LLM
 * wrongly tagged derivable to keep+decision. judgeValueBase swallows its own LLM errors
 * (all keep+null/decision), never bubbles. The taming override (fix6) runs last and
 * overrides the stated-immune backstop (safety > stated-immune): a taming instruction is
 * discarded even if it would otherwise be retained.
 */
export async function judgeValue(
  candidates: DistillCandidate[],
  callLLM: LLMCall,
): Promise<ValueVerdict[]> {
  const n = candidates.length
  if (n === 0) return []
  const base = await judgeValueBase(candidates, callLLM)
  // 第六轮第 4 项：taming override，最后跑，覆盖 stated 免疫（安全 > stated 免疫）。
  // 驯化指令即使 origin=user-stated，仍丢弃--合法用户规则不会含反馈压制词，无现实冲突。
  return base.map((v, i) =>
    detectTaming(candidates[i]!.title, candidates[i]!.bodyMd)
      ? { index: i, keep: false, reason: 'taming' }
      : v
  )
}
