// src/memory/consolidate.ts
//
// 合并步纯逻辑（spec 2026-08-19-candidate-consolidation Task 1）。
// 把 scheduler「去重」步从二元丢弃升级为「合并步」：merge / keep / drop / update_of。
// 本模块为纯逻辑（不接 scheduler/store）：consolidateCandidates 走 runLlmSession
// step='dedup'（步骤名不改，断点续跑历史兼容），parseConsolidate/consolidateShouldRetry
// 为可断言纯函数。origin 一律降级 agent-observed（无例外）；成功响应内单条幻觉兜底 keep。
import type { DistillCandidate } from './distiller'
import type { ExistingMemoryForDedup } from './dedup'
import type { LLMCall } from '@/llm'
import { runLlmSession, type RoundRecord } from './llmSession'
import { normalizeSubjectSlug } from './pure'

export const CONSOLIDATE_SYSTEM_PROMPT = `You are memside-consolidate. You receive a batch of newly-distilled candidate memories plus the existing memories in the same scope, and you consolidate them into the FEWEST durable entries by:

1. MERGE — when several new candidates are different facets of the SAME rule / decision / constraint, fuse them into ONE entry preserving every distinct facet (rationale, conditions, scope) in mergedBody. Pick the most complete title; keep the [category:xxx] prefix, choosing the category that best fits the fused rule.
2. UPDATE_OF — when a new candidate is a refinement / supplement / correction of an EXISTING approved memory (same subject), mark it update_of with targetId = that existing memory's id. The existing memory will be superseded on approval, NOT stacked as a duplicate.
3. KEEP — a new candidate that is genuinely independent stays as-is.
4. DROP — a new candidate that is a pure semantic restatement of another new candidate OR an existing memory (same rule reworded) is dropped.

HARD RULES:
- 仅当确属同一规则/决策/约束的不同侧面才合并（MERGE）。不同事实、不同规则、不同主题的记忆必须保持独立——宁可多留不可误并。MERGE 必须保留所有独特侧面，绝不允许「为减量丢事实」。
- DROP 仅限纯语义重复（同一规则换个说法），不可用于「内容相似但角度不同」的候选。
- update_of 仅当新候选是对既有 approved 记忆同一主题的精炼/补充/纠正；targetId 必须是本 prompt 列出的 existing 记忆中 status=approved 的 id 之一（candidate 不可作 target）。
- 合并后 origin 一律 agent-observed（综合产物按观察处理）。
- 合并后 subjectSlug 必须给出：优先复用 existing subject slugs 清单；成员无 slug 但确属同主题时据内容造 kebab-case（2~4 个英文小写单词）。

对每条新候选 id 形如 new-<i>。每个 group 的 members 必须是合法 new-id 字符串数组；所有 new-<i> 必须被恰好一个 group 覆盖。

输出格式如下（仅示范结构，勿照抄内容；只输出这一个 JSON 对象，无 markdown 围栏，无解释文字）：
{
  "groups": [
    { "action": "merge", "members": ["new-0", "new-2"], "mergedTitle": "[category:invariant] ...", "mergedBody": "...", "mergedEvidence": "出处1; 出处2", "mergedSlug": "refund-policy", "mergedOrigin": "agent-observed" },
    { "action": "update_of", "targetId": "A", "members": ["new-1"], "mergedTitle": "...", "mergedBody": "...", "mergedEvidence": "...", "mergedSlug": "refund-policy", "mergedOrigin": "agent-observed" },
    { "action": "keep", "members": ["new-3"] },
    { "action": "drop", "members": ["new-4"], "dropReason": "duplicate" }
  ]
}`

export interface ConsolidateGroup {
  action: 'merge' | 'keep' | 'drop' | 'update_of'
  members: string[]
  targetId?: string
  dropReason?: string
  mergedTitle?: string
  mergedBody?: string
  mergedEvidence?: string
  mergedSlug?: string
  mergedOrigin?: string
}

export interface ConsolidateInput {
  newCandidates: DistillCandidate[]
  existing: ExistingMemoryForDedup[]
  callLLM: LLMCall
  jobId?: string
  persistRound?: (r: RoundRecord) => Promise<void>
  loadHistory?: () => Promise<RoundRecord[]>
}

/** 合并后候选——在 DistillCandidate 基础上承载 update_of 的 supersedesId。 */
export interface ConsolidatedCandidate extends DistillCandidate {
  supersedesId: string | null
}

export interface ConsolidateResult {
  candidates: ConsolidatedCandidate[]
  /** drop 的 new 下标（走 logDiscards reason='duplicate'）。 */
  dropIndices: number[]
}

/**
 * 解析合并步 LLM 输出为 ConsolidatedCandidate[] + dropIndices。
 * 成功响应内的单条幻觉（非法 member id / 非法 targetId / 缺 mergedTitle）→ 该组无效，
 * 其 members 兜底 keep 原样候选（保守不丢内容，与人闸一致）。形状突变 → null。
 * 所有 new-<i> 必须被覆盖：漏掉的 → 兜底 keep。
 * origin 一律 agent-observed（强制降级，无例外）。
 *
 * 控制器裁决 #1：update_of target 合法集合 = existing.filter(status==='approved')
 * 的 id（approvedIds），candidate 不可作 target。
 */
export function parseConsolidate(
  parsed: unknown,
  newCandidates: DistillCandidate[],
  existing: ExistingMemoryForDedup[],
): ConsolidateResult | null {
  if (!parsed || typeof parsed !== 'object') return null
  const p = parsed as { groups?: unknown }
  if (!Array.isArray(p.groups)) return null
  // 裁决 #1：仅 approved 既有记忆可作 update_of target。
  const approvedIds = new Set(existing.filter((e) => e.status === 'approved').map((e) => e.id))
  const out: ConsolidatedCandidate[] = []
  const dropIndices = new Set<number>()
  const covered = new Set<number>()
  for (const rawG of p.groups) {
    if (!rawG || typeof rawG !== 'object') continue
    const g = rawG as ConsolidateGroup
    if (!VALID_ACTIONS.has(g.action)) continue
    if (!Array.isArray(g.members)) continue
    const memberIdx: number[] = []
    let membersValid = true
    for (const m of g.members) {
      const mt = /^new-(\d+)$/.exec(m)
      if (!mt) { membersValid = false; break }
      const j = Number(mt[1])
      if (j < 0 || j >= newCandidates.length) { membersValid = false; break }
      memberIdx.push(j)
    }
    if (!membersValid) continue  // 该组无效，members 留给兜底 keep
    if (g.action === 'drop') {
      for (const j of memberIdx) { dropIndices.add(j); covered.add(j) }
      continue
    }
    if (g.action === 'keep') {
      for (const j of memberIdx) {
        if (covered.has(j)) continue
        covered.add(j)
        out.push(toConsolidated(newCandidates[j]!, 'new', null))
      }
      continue
    }
    // merge / update_of：必须有合法 mergedTitle
    if (typeof g.mergedTitle !== 'string' || !g.mergedTitle.includes('[category:')) continue
    if (typeof g.mergedBody !== 'string') continue
    let action: 'new' | 'update_of' = 'new'
    let supersedesId: string | null = null
    if (g.action === 'update_of') {
      // 裁决 #1：targetId 必须在 approvedIds 内（candidate 非法 → fallback keep）
      if (typeof g.targetId !== 'string' || !approvedIds.has(g.targetId)) continue  // fallback: members 走兜底 keep
      action = 'update_of'
      supersedesId = g.targetId
    }
    // 合并后取第一个未覆盖 member 作占位（实际用 merged 字段），其余标记覆盖
    const first = memberIdx.find((j) => !covered.has(j))
    if (first === undefined) continue  // 全已覆盖（重复引用），跳过
    memberIdx.forEach((j) => covered.add(j))
    out.push({
      title: g.mergedTitle!,
      bodyMd: g.mergedBody!,
      scopeType: newCandidates[first]!.scopeType,
      runtime: newCandidates[first]!.runtime,
      distillAction: action,
      origin: 'agent-observed',  // 强制降级，无例外
      evidence: typeof g.mergedEvidence === 'string' && g.mergedEvidence.trim() ? g.mergedEvidence.trim() : null,
      subjectSlug: normalizeSubjectSlug(g.mergedSlug),
      supersedesId,
    })
  }
  // 兜底：未被任何 group 覆盖的 new-<i> → keep 原样
  for (let i = 0; i < newCandidates.length; i++) {
    if (covered.has(i)) continue
    if (dropIndices.has(i)) continue
    out.push(toConsolidated(newCandidates[i]!, 'new', null))
  }
  return { candidates: out, dropIndices: [...dropIndices].sort((a, b) => a - b) }
}

const VALID_ACTIONS = new Set(['merge', 'keep', 'drop', 'update_of'])

/**
 * keep / short-circuit / 兜底未覆盖 三条「原样保留」路径的候选构造（spec §4 line 185
 * 「keep → 原样 candidate」）：保留原始 origin（不降级——只有 merge/update_of 的
 * 综合产物在 parseConsolidate 内强制 agent-observed）。distillAction 透传调用方
 * 给定的值（keep 路径='new'；update_of fallback='new'）。
 */
function toConsolidated(c: DistillCandidate, action: 'new' | 'update_of', supersedesId: string | null): ConsolidatedCandidate {
  return {
    title: c.title, bodyMd: c.bodyMd, scopeType: c.scopeType, runtime: c.runtime,
    distillAction: action, origin: c.origin, evidence: c.evidence,
    subjectSlug: c.subjectSlug, supersedesId,
  }
}

/**
 * 校验合并步 LLM 输出是否值得重试。返回错误信息则重试，null 则接受。
 * 控制器裁决 #1：update_of 的 targetId 合法集合 = existing.filter(status==='approved')
 * 的 id（approvedIds）。调用方需传入该过滤后的集合。
 */
export function consolidateShouldRetry(approvedIds: Set<string>): (parsed: unknown) => string | null {
  return (parsed) => {
    if (!parsed || typeof parsed !== 'object') return '返回的不是 JSON 对象'
    const p = parsed as { groups?: unknown }
    if (!Array.isArray(p.groups)) return '缺少 groups 数组'
    for (let i = 0; i < p.groups.length; i++) {
      const g = p.groups[i] as Record<string, unknown> | null
      if (!g || typeof g !== 'object') return `group ${i} 非对象`
      const action = g.action
      if (action !== 'merge' && action !== 'keep' && action !== 'drop' && action !== 'update_of')
        return `group ${i} 非法 action（${String(action)}）`
      if (!Array.isArray(g.members) || !g.members.every((m) => typeof m === 'string'))
        return `group ${i} members 必须是字符串数组`
      if (action === 'update_of') {
        if (typeof g.targetId !== 'string') return `group ${i} update_of 缺少 targetId`
        if (!approvedIds.has(g.targetId)) return `group ${i} targetId 不在 approved 集合内`
      }
      if (action === 'merge' || action === 'update_of') {
        if (typeof g.mergedTitle !== 'string' || !g.mergedTitle.includes('[category:'))
          return `group ${i} 缺少 mergedTitle 或 [category:] 前缀`
        if (typeof g.mergedBody !== 'string') return `group ${i} 缺少 mergedBody`
        // spec §4.5：mergedSlug 与 mergedTitle/mergedBody 并列为合法 merge/update_of group 必备字段。
        // 第一道防线：漏标 → 重试，避免 normalizeSubjectSlug(null) 静默产出无 slug 合并候选。
        if (typeof g.mergedSlug !== 'string' || g.mergedSlug.trim() === '') return `group ${i} 缺少 mergedSlug`
      }
    }
    return null
  }
}

function renderUserPrompt(newCandidates: DistillCandidate[], existing: ExistingMemoryForDedup[], existingSlugs: string[]): string {
  const exLines = existing.length > 0
    ? existing.map((e) => `id=${e.id} | slug=${e.subjectSlug ?? '(none)'} | ${e.title}\n${e.bodyMd}`).join('\n')
    : '(none)'
  const newLines = newCandidates.map((c, i) => `id=new-${i} | slug=${c.subjectSlug ?? '(none)'} | ${c.title}\n${c.bodyMd}${c.evidence ? `\n出处: ${c.evidence}` : ''}`).join('\n---\n')
  const slugs = existingSlugs.length > 0 ? existingSlugs.join(', ') : '(none)'
  return `Existing subject slugs (reuse these): ${slugs}\n\nExisting memories (same scope):\n${exLines}\n\nNew candidates:\n${newLines}\n\nReturn JSON per the system instructions. Every new-<i> must be covered by exactly one group.`
}

/**
 * 合并步：替换原 dedupCandidates 的语义去重调用。走 runLlmSession step='dedup'
 * （步骤名不改，断点续跑历史兼容）。LLM 失败/重试耗尽 → {failed:true,reasons}
 * 由 scheduler 走 step 失败分支（P1 不吞错）。成功响应内单条幻觉由 parseConsolidate
 * 兜底 keep（保守不丢内容）。existing 为空且 newCandidates <= 1 时不调 LLM。
 */
export async function consolidateCandidates(input: ConsolidateInput): Promise<ConsolidateResult | { failed: true; reasons: string[] }> {
  const n = input.newCandidates.length
  if (n === 0) return { candidates: [], dropIndices: [] }
  if (input.existing.length === 0 && n <= 1) {
    return { candidates: input.newCandidates.map((c) => toConsolidated(c, 'new', null)), dropIndices: [] }
  }
  // 裁决 #1：approvedIds = existing.filter(approved).id；candidate 不可作 update_of target。
  const approvedIds = new Set(input.existing.filter((e) => e.status === 'approved').map((e) => e.id))
  const existingSlugs = [...new Set(input.existing.map((e) => e.subjectSlug).filter((s): s is string => !!s))]
  const userPrompt = renderUserPrompt(input.newCandidates, input.existing, existingSlugs)
  // 多 scope 组共用 step='dedup' 的历史池：按「request 以本组 prompt 开头」过滤出
  // 本组自己的对话（followup 轮 request = initialUser + 追问，天然以本组 prompt 开头）。
  const rawHistory = input.loadHistory ? await input.loadHistory() : []
  const history = input.loadHistory ? rawHistory.filter((r) => r.request.startsWith(userPrompt)) : rawHistory
  const session = await runLlmSession({
    callLLM: input.callLLM,
    system: CONSOLIDATE_SYSTEM_PROMPT,
    initialUser: userPrompt,
    step: 'dedup',
    jobId: input.jobId ?? '',
    persistRound: input.persistRound,
    ...(input.loadHistory
      ? { loadHistory: async () => history, maxAttempts: history.length + 1 }
      : { maxAttempts: 3 }),
    shouldRetry: consolidateShouldRetry(approvedIds),
  })
  if (!session.ok) return { failed: true, reasons: session.reasons }
  const parsed = session.parsed
  const res = parseConsolidate(parsed, input.newCandidates, input.existing)
  if (!res) return { failed: true, reasons: ['consolidate: 响应缺少 groups 数组'] }
  return res
}
