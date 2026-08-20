# 候选记忆合并步（consolidation）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 scheduler 的「去重」（dedup）步从二元丢弃升级为「合并步」（consolidate）——同主题碎片熔成一条、跨会话按 subjectSlug 全量比对、update_of 作为更新提案闭环，从源头削减候选队列碎片与堆积。

**Architecture:** 新建 `src/memory/consolidate.ts` 纯逻辑模块（SYSTEM_PROMPT + LLM 契约 + parse/shouldRetry/consolidateCandidates，走 runLlmSession step='dedup'），替换 `dedupCandidates` 的语义去重调用；store 层 `listForDedupByScope` 改按 subjectSlug 预筛（解除 50 条盲区）；scheduler 入库时让合并产物（merge/update_of）的 action 覆盖 distillAction/supersedesId/title/body/evidence/slug；UI 给 update_of 候选加紫色「更新」徽标。步骤边界/断点续跑/失败路径全复用既有四步机，不新增 LLM 调用。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite + @anthropic-ai/sdk；Vite + React 19。测试 `bun test`（严禁 npm test）。

**Spec:** `docs/superpowers/specs/2026-08-19-candidate-consolidation-design.md`

## Global Constraints

- 本仓库 Windows + PowerShell 5.1 环境：`&&` 连接符非法，提交前跑全量校验 `bun run typecheck && bun test` 必须在 Bash 工具中执行（或 `;` 串联）。
- 测试一律 `bun test` 运行（bun:sqlite/Bun API 专有，npm test 走 Node 必失败）。
- 无新运行时依赖（runLlmSession/exact dedup/normalizeSubjectSlug 既有复用）。
- distiller prompt 提取范式不动（源头重写属方案 B，后续）；judge 盲判不动；exact dedup 不动；stepState 四步 `distill→dedup→judge→digest` 名字与边界不动。
- 合并产物 origin 一律降级 `agent-observed`（不设例外口子，即使用户拍板保守）。
- 人闸不动——所有合并产物仍以 candidate 入队待人工审批。
- 合并步替换原 dedup 的 1 次 LLM 调用，不新增调用次数。

---

## File Structure

| 文件 | 责任 | 状态 |
|---|---|---|
| `src/memory/consolidate.ts` | 合并步纯逻辑：CONSOLIDATE_SYSTEM_PROMPT、renderUserPrompt、consolidateShouldRetry、parseConsolidate、consolidateCandidates（走 runLlmSession step='dedup'）。吸收 dedup.ts 的语义去重职责。 | 新建 |
| `src/memory/dedup.ts` | `judgeDuplicates` 被合并步取代后退役；`ExactDedup` 在独立模块 `exactDedup.ts` 不动。删除 `judgeDuplicates`/`DedupInput`/`DedupVerdict`/`DedupJudgeResult`/`DEDUP_SYSTEM_PROMPT` 及其测试。 | 删除语义去重部分 |
| `src/memory/store.ts` | `listForDedupByScope` 改按 subjectSlug 预筛（§3.3）；签名加 `slugs` 参数；`DEDUP_EXISTING_LIMIT` 语义从「candidate 取最近 50」改为「无 slug fallback 上限」。 | 修改 |
| `src/scheduler.ts` | dedup 步内 `dedupCandidates` → `consolidateCandidates`；入库（:604-622）让合并产物 action 覆盖字段；deduped 类型承载合并后的 DistillCandidate + action。 | 修改 |
| `src/web/App.tsx` | MemoryCard 加「更新 #<摘要>」紫色徽标（distillAction='update_of' && supersedesId）。 | 修改 |
| `src/web/ui-utils.ts` | 徽标渲染纯函数 `updateBadge`。 | 修改 |
| `tests/consolidate.test.ts` | 纯函数正向/边界/错误路径。 | 新建 |
| `tests/store-consolidation-query.test.ts` | slug 预筛查询。 | 新建 |
| `tests/scheduler-consolidation.test.ts` | 合并步替换 dedup 集成 + update_of 落库。 | 新建/扩展 |
| `tests/app-source-assertions.test.ts` | UI 徽标源码层文本断言。 | 扩展 |

---

### Task 1: 合并步纯逻辑模块 consolidate.ts

**Files:**
- Create: `src/memory/consolidate.ts`
- Test: `tests/consolidate.test.ts`

**Interfaces:**
- Consumes: `runLlmSession` / `RoundRecord` from `./llmSession`；`LLMCall` from `@/llm`；`DistillCandidate`/`DistillOrigin` from `./distiller`；`MemoryScope`/`RuntimeTag` from `./pure`；`ExistingMemoryForDedup` from `./dedup`（type 保留，见 Task 2 决策）；`normalizeSubjectSlug` from `./pure`。
- Produces: `CONSOLIDATE_SYSTEM_PROMPT`、`ConsolidateGroup`、`ConsolidateInput`、`ConsolidateResult`、`parseConsolidate`、`consolidateShouldRetry`、`consolidateCandidates`。

- [ ] **Step 1: 写失败测试——parseConsolidate 合法输入**

```typescript
// tests/consolidate.test.ts
import { parseConsolidate, consolidateShouldRetry, CONSOLIDATE_SYSTEM_PROMPT } from '@/memory/consolidate'
import type { ExistingMemoryForDedup } from '@/memory/dedup'

const existing: ExistingMemoryForDedup[] = [
  { id: 'A', title: '[category:convention] old', bodyMd: 'b', scopeType: 'project', scopeId: 'p', status: 'approved' },
]
// newCandidates 两条同主题碎片 + 一条独立 + 一条纯重复
const news = [
  { title: '[category:convention] 退款14天', bodyMd: 'b1', scopeType: 'project' as const, runtime: 'claude-code' as const, distillAction: 'new' as const, origin: 'user-stated' as const, evidence: 'e1', subjectSlug: 'refund' },
  { title: '[category:invariant] 退款期限', bodyMd: 'b2', scopeType: 'project' as const, runtime: 'claude-code' as const, distillAction: 'new' as const, origin: 'agent-observed' as const, evidence: 'e2', subjectSlug: 'refund' },
  { title: '[category:architecture] 无关', bodyMd: 'b3', scopeType: 'project' as const, runtime: 'claude-code' as const, distillAction: 'new' as const, origin: 'agent-observed' as const, evidence: null, subjectSlug: 'other' },
]

const llmOutput = {
  groups: [
    { action: 'merge', members: ['new-0', 'new-1'], mergedTitle: '[category:invariant] 退款须14天内', mergedBody: 'b1+b2', mergedEvidence: 'e1; e2', mergedSlug: 'refund', mergedOrigin: 'agent-observed' },
    { action: 'keep', members: ['new-2'] },
    { action: 'drop', members: ['new-3'], dropReason: 'duplicate' },
  ],
}

describe('parseConsolidate', () => {
  it('legal groups → merged candidates + keep + drop set', () => {
    const res = parseConsolidate(llmOutput, news, existing)
    expect(res).not.toBeNull()
    // merge 产出 1 条；keep 产出 1 条（new-2 原样）；drop 不产出
    expect(res!.candidates.length).toBe(2)
    const merged = res!.candidates[0]!
    expect(merged.title).toBe('[category:invariant] 退款须14天内')
    expect(merged.subjectSlug).toBe('refund')
    expect(merged.origin).toBe('agent-observed')  // 一律降级 observed
    expect(merged.evidence).toBe('e1; e2')
    // keep 候选原样
    expect(res!.candidates[1]!.title).toBe('[category:architecture] 无关')
    expect(res!.dropIndices).toEqual([3])
  })
})
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test tests/consolidate.test.ts`
Expected: FAIL（`@/memory/consolidate` 不存在）

- [ ] **Step 3: 写失败测试——边界/兜底**

```typescript
describe('parseConsolidate edge cases', () => {
  it('hallucinated member id → that group fallback keep; others unaffected', () => {
    const out = { groups: [{ action: 'keep', members: ['new-0'] }, { action: 'drop', members: ['new-99'], dropReason: 'duplicate' }] }
    const res = parseConsolidate(out, [news[0]!], existing)
    // new-99 不存在 → drop 组无效 → new-0 keep；无对应 new-99
    expect(res!.dropIndices).toEqual([])
    expect(res!.candidates.length).toBe(1)
  })
  it('missing new-i (not covered by any group) → fallback keep that candidate', () => {
    const out = { groups: [{ action: 'keep', members: ['new-0'] }] }  // 漏 new-1
    const res = parseConsolidate(out, [news[0]!, news[1]!], existing)
    expect(res!.candidates.length).toBe(2)  // new-0 + new-1 兜底 keep
  })
  it('update_of with invalid targetId (not in existing) → fallback keep', () => {
    const out = { groups: [{ action: 'update_of', targetId: 'ZZZ', members: ['new-0'], mergedTitle: '[category:convention] x', mergedBody: 'b', mergedEvidence: 'e', mergedSlug: 's', mergedOrigin: 'agent-observed' }] }
    const res = parseConsolidate(out, [news[0]!], existing)
    expect(res!.candidates[0]!.distillAction).toBe('new')  // fallback keep，不标 update_of
    expect(res!.candidates[0]!.supersedesId).toBeNull?.(true)  // 无 supersedesId
  })
  it('update_of with valid targetId → distillAction=update_of + supersedesId set', () => {
    const out = { groups: [{ action: 'update_of', targetId: 'A', members: ['new-0'], mergedTitle: '[category:convention] x', mergedBody: 'b', mergedEvidence: 'e', mergedSlug: 's', mergedOrigin: 'agent-observed' }] }
    const res = parseConsolidate(out, [news[0]!], existing)
    expect(res!.candidates[0]!.distillAction).toBe('update_of')
    expect(res!.candidates[0]!.supersedesId).toBe('A')
  })
  it('origin always agent-observed even if all members user-stated', () => {
    const out = { groups: [{ action: 'merge', members: ['new-0'], mergedTitle: '[category:convention] x', mergedBody: 'b', mergedEvidence: 'e', mergedSlug: 's', mergedOrigin: 'user-stated' }] }
    const res = parseConsolidate(out, [news[0]!], existing)
    expect(res!.candidates[0]!.origin).toBe('agent-observed')  // 强制降级，无例外
  })
  it('shape mutation (no groups array) → null', () => {
    expect(parseConsolidate({ foo: 1 }, news, existing)).toBeNull()
    expect(parseConsolidate(null, news, existing)).toBeNull()
  })
  it('merge missing mergedTitle prefix → group invalid', () => {
    const out = { groups: [{ action: 'merge', members: ['new-0'], mergedTitle: 'no prefix', mergedBody: 'b', mergedEvidence: 'e', mergedSlug: 's', mergedOrigin: 'agent-observed' }] }
    const res = parseConsolidate(out, [news[0]!], existing)
    // mergedTitle 缺 [category:] → 组无效 → new-0 兜底 keep 原样
    expect(res!.candidates[0]!.title).toBe('[category:convention] 退款14天')
  })
})
```

- [ ] **Step 4: 运行测试验证失败**

Run: `bun test tests/consolidate.test.ts`
Expected: FAIL（parseConsolidate 未实现）

- [ ] **Step 5: 写失败测试——consolidateShouldRetry**

```typescript
describe('consolidateShouldRetry', () => {
  const existingIds = new Set(['A'])
  const fn = consolidateShouldRetry(existingIds)
  it('not object → retry', () => { expect(fn(null)).toMatch(/不是 JSON 对象/) })
  it('no groups array → retry', () => { expect(fn({ foo: 1 })).toMatch(/缺少 groups/) })
  it('invalid action → retry', () => {
    expect(fn({ groups: [{ action: 'x', members: ['new-0'] }] })).toMatch(/非法 action/)
  })
  it('members not string array → retry', () => {
    expect(fn({ groups: [{ action: 'keep', members: 'new-0' }] })).toMatch(/members/)
  })
  it('update_of missing targetId → retry', () => {
    expect(fn({ groups: [{ action: 'update_of', members: ['new-0'] }] })).toMatch(/targetId/)
  })
  it('update_of targetId not in existing → retry', () => {
    expect(fn({ groups: [{ action: 'update_of', targetId: 'ZZZ', members: ['new-0'] }] })).toMatch(/targetId/)
  })
  it('merge missing mergedTitle → retry', () => {
    expect(fn({ groups: [{ action: 'merge', members: ['new-0'], mergedBody: 'b', mergedEvidence: 'e', mergedSlug: 's', mergedOrigin: 'agent-observed' }] })).toMatch(/mergedTitle/)
  })
  it('legal → null (accept)', () => {
    expect(fn(llmOutput)).toBeNull()
  })
})

describe('CONSOLIDATE_SYSTEM_PROMPT', () => {
  it('contains hard-constraint tokens', () => {
    expect(CONSOLIDATE_SYSTEM_PROMPT).toContain('宁可多留不可误并')
    expect(CONSOLIDATE_SYSTEM_PROMPT).toContain('update_of 仅当')
    expect(CONSOLIDATE_SYSTEM_PROMPT).toContain('approved')
  })
})
```

- [ ] **Step 6: 运行测试验证失败**

Run: `bun test tests/consolidate.test.ts`
Expected: FAIL（consolidateShouldRetry 未实现）

- [ ] **Step 7: 实现 consolidate.ts 纯函数**

```typescript
// src/memory/consolidate.ts
import type { DistillCandidate, DistillOrigin } from './distiller'
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
- update_of 仅当新候选是对既有 approved 记忆同一主题的精炼/补充/纠正；targetId 必须是本 prompt 列出的 existing 记忆 id 之一。
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

export function consolidateShouldRetry(existingIds: Set<string>): (parsed: unknown) => string | null {
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
        if (!existingIds.has(g.targetId)) return `group ${i} targetId 不在 existing 集合内`
      }
      if (action === 'merge' || action === 'update_of') {
        if (typeof g.mergedTitle !== 'string' || !g.mergedTitle.includes('[category:'))
          return `group ${i} 缺少 mergedTitle 或 [category:] 前缀`
        if (typeof g.mergedBody !== 'string') return `group ${i} 缺少 mergedBody`
      }
    }
    return null
  }
}

const VALID_ACTIONS = new Set(['merge', 'keep', 'drop', 'update_of'])

/**
 * 解析合并步 LLM 输出为 ConsolidatedCandidate[] + dropIndices。
 * 成功响应内的单条幻觉（非法 member id / 非法 targetId / 缺 mergedTitle）→ 该组无效，
 * 其 members 兜底 keep 原样候选（保守不丢内容，与人闸一致）。形状突变 → null。
 * 所有 new-<i> 必须被覆盖：漏掉的 → 兜底 keep。
 * origin 一律 agent-observed（强制降级，无例外）。
 */
export function parseConsolidate(
  parsed: unknown,
  newCandidates: DistillCandidate[],
  existing: ExistingMemoryForDedup[],
): ConsolidateResult | null {
  if (!parsed || typeof parsed !== 'object') return null
  const p = parsed as { groups?: unknown }
  if (!Array.isArray(p.groups)) return null
  const existingIds = new Set(existing.map((e) => e.id))
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
      if (typeof g.targetId !== 'string' || !existingIds.has(g.targetId)) continue  // fallback: members 走兜底 keep
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

function toConsolidated(c: DistillCandidate, action: 'new' | 'update_of', supersedesId: string | null): ConsolidatedCandidate {
  return {
    title: c.title, bodyMd: c.bodyMd, scopeType: c.scopeType, runtime: c.runtime,
    distillAction: action, origin: 'agent-observed', evidence: c.evidence,
    subjectSlug: c.subjectSlug, supersedesId,
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
  const existingIds = new Set(input.existing.map((e) => e.id))
  const existingSlugs = [...new Set(input.existing.map((e) => e.subjectSlug).filter((s): s is string => !!s))]
  const userPrompt = renderUserPrompt(input.newCandidates, input.existing, existingSlugs)
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
    shouldRetry: consolidateShouldRetry(existingIds),
  })
  if (!session.ok) return { failed: true, reasons: session.reasons }
  const parsed = session.parsed
  const res = parseConsolidate(parsed, input.newCandidates, input.existing)
  if (!res) return { failed: true, reasons: ['consolidate: 响应缺少 groups 数组'] }
  return res
}
```

注意：`ExistingMemoryForDedup` 当前缺 `subjectSlug` 字段——Task 2 会给该 type 加可选 `subjectSlug?: string | null` 并在 `listForDedupByScope` 查询带上。本 Task 测试用 `as ExistingMemoryForDedup[]` 时不强求该字段（可选）。

- [ ] **Step 8: 运行测试验证通过**

Run: `bun test tests/consolidate.test.ts`
Expected: PASS（全部用例绿）

- [ ] **Step 9: 提交**

```bash
git add src/memory/consolidate.ts tests/consolidate.test.ts
git commit -m "feat(consolidate): 合并步纯逻辑（merge/keep/drop/update_of + origin 降级 + 幻觉兜底）"
```

---

### Task 2: store listForDedupByScope 改按 subjectSlug 预筛 + ExistingMemoryForDedup 加 subjectSlug

**Files:**
- Modify: `src/memory/dedup.ts`（给 `ExistingMemoryForDedup` 加 `subjectSlug?: string | null`）
- Modify: `src/memory/store.ts:196-216`（`listForDedupByScope` 改 slug 预筛；`:162` `DEDUP_EXISTING_LIMIT` 注释更新）
- Test: `tests/store-consolidation-query.test.ts`

**Interfaces:**
- Consumes: `memories` schema 表（已有 `subjectSlug` 列）。
- Produces: `listForDedupByScope(db, { scopeType, scopeId, slugs?: string[] })` 返回 `ExistingMemoryForDedup[]`（含 `subjectSlug`）。

- [ ] **Step 1: 写失败测试——slug 预筛查询**

```typescript
// tests/store-consolidation-query.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { openDb, createCandidate } from '@/memory/store'
import { listForDedupByScope } from '@/memory/store'
import type { DbClient } from '@/memory/store'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

let db: DbClient
beforeEach(() => {
  const path = join(import.meta.dir, `tmp-slug-${Math.random().toString(36).slice(2)}.db`)
  db = openDb(path)
  ;(db as any)._path = path
})
afterEach?.(() => { try { rmSync((db as any)._path) } catch {} })

describe('listForDedupByScope slug prefilter', () => {
  it('with slugs → only candidates with matching slug, no 50 limit', async () => {
    // 建 60 条同 slug candidate + 10 条别的 slug
    for (let i = 0; i < 60; i++) {
      await createCandidate(db, { scopeType: 'project', scopeId: 'p', title: `[category:convention] t${i}`, bodyMd: 'b', tags: [], sourceKind: 'conversation', sourceCwd: 'p', runtime: 'claude-code', distillJobId: 'j', subjectSlug: 'refund', origin: 'agent-observed', evidence: null })
    }
    for (let i = 0; i < 10; i++) {
      await createCandidate(db, { scopeType: 'project', scopeId: 'p', title: `[category:architecture] o${i}`, bodyMd: 'b', tags: [], sourceKind: 'conversation', sourceCwd: 'p', runtime: 'claude-code', distillJobId: 'j', subjectSlug: 'other', origin: 'agent-observed', evidence: null })
    }
    const res = await listForDedupByScope(db, { scopeType: 'project', scopeId: 'p', slugs: ['refund'] })
    expect(res.length).toBe(60)  // 不被 LIMIT 50 截断
    expect(res.every((r) => r.subjectSlug === 'refund')).toBe(true)
  })
  it('no slugs (empty batch) → fallback recent 50 cap', async () => {
    for (let i = 0; i < 70; i++) {
      await createCandidate(db, { scopeType: 'project', scopeId: 'p', title: `[category:convention] t${i}`, bodyMd: 'b', tags: [], sourceKind: 'conversation', sourceCwd: 'p', runtime: 'claude-code', distillJobId: 'j', subjectSlug: null, origin: 'agent-observed', evidence: null })
    }
    const res = await listForDedupByScope(db, { scopeType: 'project', scopeId: 'p', slugs: [] })
    expect(res.length).toBeLessThanOrEqual(50)  // fallback 上限 50 防爆 prompt
  })
  it('result rows carry subjectSlug', async () => {
    await createCandidate(db, { scopeType: 'project', scopeId: 'p', title: '[category:convention] t', bodyMd: 'b', tags: [], sourceKind: 'conversation', sourceCwd: 'p', runtime: 'claude-code', distillJobId: 'j', subjectSlug: 'refund', origin: 'agent-observed', evidence: null })
    const res = await listForDedupByScope(db, { scopeType: 'project', scopeId: 'p', slugs: ['refund'] })
    expect(res[0]!.subjectSlug).toBe('refund')
  })
})
```

注：`createCandidate`/`openDb` 的确切 import 形态以 store.ts 实际导出为准；执行者先 grep `export.*openDb` 与 `export.*createCandidate` 确认。若 store 不导出 `openDb`，改用现有测试 helper（grep `tests/store-*.test.ts` 找 db 构造模式）。

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test tests/store-consolidation-query.test.ts`
Expected: FAIL（`listForDedupByScope` 不接 `slugs` 参数 / 返回行无 `subjectSlug`）

- [ ] **Step 3: 修改 dedup.ts 给 type 加字段**

```typescript
// src/memory/dedup.ts —— ExistingMemoryForDedup 加 subjectSlug
export interface ExistingMemoryForDedup {
  id: string
  title: string
  bodyMd: string
  scopeType: MemoryScope
  scopeId: string | null
  status: MemoryStatus
  /** spec §3.3：合并步按 subjectSlug 预筛 existing，需带回 slug。可选（老库无）。 */
  subjectSlug?: string | null
}
```

- [ ] **Step 4: 修改 store.ts listForDedupByScope**

```typescript
// src/memory/store.ts:196 —— 改按 subjectSlug 预筛
export async function listForDedupByScope(
  db: DbClient,
  opts: { scopeType: MemoryScope; scopeId: string | null; slugs?: string[] },
): Promise<ExistingMemoryForDedup[]> {
  const scopeClause = opts.scopeId === null ? isNull(memories.scopeId) : eq(memories.scopeId, opts.scopeId)
  const cols = { id: memories.id, title: memories.title, bodyMd: memories.bodyMd, scopeType: memories.scopeType, scopeId: memories.scopeId, status: memories.status, subjectSlug: memories.subjectSlug }
  // approved 全量（不变）
  const approvedRows = await db.select(cols).from(memories).where(
    and(eq(memories.scopeType, opts.scopeType), scopeClause, eq(memories.status, 'approved')),
  ).orderBy(desc(memories.createdAt)).all()
  // candidate：本批有 slug → 只取同 slug（不限条数）；无 slug → fallback 最近 50
  const slugs = opts.slugs ?? []
  let candidateRows
  if (slugs.length > 0) {
    candidateRows = await db.select(cols).from(memories).where(
      and(eq(memories.scopeType, opts.scopeType), scopeClause, eq(memories.status, 'candidate'), inArray(memories.subjectSlug, slugs)),
    ).orderBy(desc(memories.createdAt)).all()
  } else {
    candidateRows = await db.select(cols).from(memories).where(
      and(eq(memories.scopeType, opts.scopeType), scopeClause, eq(memories.status, 'candidate')),
    ).orderBy(desc(memories.createdAt)).limit(DEDUP_EXISTING_LIMIT).all()
  }
  const seen = new Set<string>()
  const out: ExistingMemoryForDedup[] = []
  for (const r of [...approvedRows, ...candidateRows]) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    out.push({ id: r.id, title: r.title, bodyMd: r.bodyMd, scopeType: r.scopeType as MemoryScope, scopeId: r.scopeId, status: r.status as MemoryStatus, subjectSlug: r.subjectSlug as string | null })
  }
  return out
}
```

更新 `DEDUP_EXISTING_LIMIT`（store.ts:162）的注释为「无 slug fallback 上限（slug 预筛路径不限条数）」。确认 `inArray` 已在 store.ts import（grep 既有用法）。

- [ ] **Step 5: 运行测试验证通过**

Run: `bun test tests/store-consolidation-query.test.ts`
Expected: PASS

- [ ] **Step 6: 全量 typecheck + 测试防回归**

Run: `bun run typecheck && bun test`（Bash 工具）
Expected: 全绿（既有 dedup 测试若引用旧 `listForDedupByScope` 无 slugs 调用形态，补 `slugs: []` 或 `slugs: undefined` 适配；grep 调用点）

- [ ] **Step 7: 提交**

```bash
git add src/memory/dedup.ts src/memory/store.ts tests/store-consolidation-query.test.ts
git commit -m "feat(store): listForDedupByScope 按 subjectSlug 预筛（解除 50 条盲区）"
```

---

### Task 3: scheduler dedup 步替换为 consolidateCandidates + 入库 action 覆盖

**Files:**
- Modify: `src/scheduler.ts:121-165`（`dedupCandidates` → 改用 `consolidateCandidates`，返回 ConsolidatedCandidate[] + dropIndices）、`:486-527`（dedup 步块接线 drop 走 logDiscards）、`:604-622`（入库用 ConsolidatedCandidate 的 distillAction/supersedesId/origin/evidence/slug）
- Test: `tests/scheduler-consolidation.test.ts`

**Interfaces:**
- Consumes: `consolidateCandidates`/`ConsolidatedCandidate` from Task 1；`listForDedupByScope`（新签名，Task 2）。
- Produces: scheduler dedup 步输出 `deduped: ConsolidatedCandidate[]` + `dedupDropIndices`；入库 candidate 带 `distillAction`/`supersedesId`。

- [ ] **Step 1: 写失败测试——scheduler 用合并步，drop 走 logDiscards，merge 候选带降级 origin**

```typescript
// tests/scheduler-consolidation.test.ts
// 用 fake callLLM 返回合并 JSON，断言：
// 1) drop 的候选进 memory_discards（reason='duplicate'）
// 2) merge 产出的候选 origin='agent-observed'
// 3) update_of 产出的候选 distillAction='update_of' + supersedesId=targetId
// 参考既有 tests/scheduler*.test.ts 的 tick 驱动模式（grep fake callLLM + job 构造）。
// 执行者先读 tests/scheduler.test.ts 头部 helper 复用 db/job/callLLM 构造。
```

执行者需先读 `tests/scheduler.test.ts` 头部，复用其 db 构造、job 入队、fake callLLM 模式。测试骨架（以实际 helper 为准调整）：

```typescript
import { describe, it, expect } from 'bun:test'
// 复用 scheduler.test.ts 的 makeDb / enqueueJob / fakeCallLLM helper（或 import）

describe('scheduler dedup step → consolidate', () => {
  it('drop candidates logged to memory_discards reason=duplicate', async () => {
    // fake callLLM: distill 返回 2 候选；consolidate 返回 1 drop + 1 keep
    // 驱动一次 tick，断言 memory_discards 有 1 行 reason='duplicate'
  })
  it('merge candidate origin downgraded to agent-observed', async () => {
    // fake callLLM consolidate 返回 merge 组（mergedOrigin=user-stated）
    // 断言入库候选 origin='agent-observed'
  })
  it('update_of candidate carries distillAction=update_of + supersedesId', async () => {
    // fake callLLM consolidate 返回 update_of targetId=existing approved
    // 断言入库候选 distillAction='update_of' && supersedesId=targetId
  })
})
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test tests/scheduler-consolidation.test.ts`
Expected: FAIL（scheduler 仍调旧 dedupCandidates）

- [ ] **Step 3: 改 scheduler.ts dedupCandidates 函数**

把 `src/scheduler.ts:133-165` 的 `dedupCandidates` 改为调 `consolidateCandidates`：

```typescript
// src/scheduler.ts
import { consolidateCandidates, type ConsolidatedCandidate } from '@/memory/consolidate'
// 删除：import { judgeDuplicates } from '@/memory/dedup'（若仅此处用）

/**
 * 合并步（spec §3）：替换旧二元丢弃 dedup。按 (scopeType, scopeId) 分组，每组调
 * consolidateCandidates（1 LLM）：同主题碎片熔合、纯重复 drop、对既有 approved 的
 * 精炼 update_of。返回合并后候选 + drop 的全局下标（走 logDiscards reason='duplicate'）。
 * LLM 失败 → {failed:true,reasons}（P1 不吞错）。existing 按 subjectSlug 预筛（§3.3）。
 */
export async function consolidateBatch(
  db: DbClient,
  callLLM: LLMCall,
  candidates: DistillCandidate[],
  jobCwd: string | null,
  session?: JudgeSessionOpts,
): Promise<{ kept: ConsolidatedCandidate[]; dropIndices: number[] } | { failed: true; reasons: string[] }> {
  if (candidates.length === 0) return { kept: [], dropIndices: [] }
  const groups = new Map<string, { scopeType: DistillCandidate['scopeType']; scopeId: string | null; items: { c: DistillCandidate; globalIndex: number }[] }>()
  candidates.forEach((c, i) => {
    const scopeId = resolveScopeId(c.scopeType, jobCwd)
    const key = `${c.scopeType}:${scopeId ?? ''}`
    if (!groups.has(key)) groups.set(key, { scopeType: c.scopeType, scopeId, items: [] })
    groups.get(key)!.items.push({ c, globalIndex: i })
  })
  const kept: ConsolidatedCandidate[] = []
  const dropGlobal: number[] = []
  for (const g of groups.values()) {
    const slugs = [...new Set(g.items.map((it) => it.c.subjectSlug).filter((s): s is string => !!s))]
    const existing = await listForDedupByScope(db, { scopeType: g.scopeType, scopeId: g.scopeId, slugs })
    const res = await consolidateCandidates({
      newCandidates: g.items.map((it) => it.c),
      existing, callLLM,
      jobId: session?.jobId, persistRound: session?.persistRound, loadHistory: session?.loadHistory,
    })
    if ('failed' in res) return res
    kept.push(...res.candidates)
    for (const localIdx of res.dropIndices) {
      dropGlobal.push(g.items[localIdx]!.globalIndex)
    }
  }
  return { kept, dropIndices: dropGlobal.sort((a, b) => a - b) }
}
```

- [ ] **Step 4: 改 scheduler.ts dedup 步块（:486-527）接线**

```typescript
// 步骤 2 块内：exact dedup 后调 consolidateBatch；drop 走 logDiscards reason='duplicate'
if (!failed && currentStep === 'dedup') {
  const exact = await exactDedupCandidates(db, candidates, job.cwd ?? null)
  dedupExactDrops = exact.drops.length
  if (exact.drops.length > 0) {
    try {
      await logDiscards(db, job.id, exact.drops.map((d) => ({ /* 既有字段不变 */ ... })))
    } catch (e) { console.warn('memside: logDiscards failed', e) }
  }
  const pDedup = phase('dedup')
  let dedupPhase = { calls: 0, ms: 0 }
  let dedupOut: { kept: ConsolidatedCandidate[]; dropIndices: number[] } | { failed: true; reasons: string[] }
  try {
    dedupOut = await consolidateBatch(db, tracked, exact.kept, job.cwd ?? null, {
      jobId: job.id,
      persistRound: (r) => saveLlmRound(db, { jobId: job.id, step: 'dedup', round: r.round, request: r.request, response: r.response, result: r.result }),
      loadHistory: () => listLlmRounds(db, job.id, 'dedup'),
    })
  } finally { dedupPhase = pDedup.end() }
  dedupMs = dedupPhase.calls > 0 ? dedupPhase.ms : null
  if ('failed' in dedupOut) {
    failed = { step: 'dedup', reasons: dedupOut.reasons }
  } else {
    // 合并步 drop 的候选走 logDiscards reason='duplicate'
    if (dedupOut.dropIndices.length > 0) {
      const dropRecords = dedupOut.dropIndices.map((i) => {
        const c = exact.kept[i]!
        return { title: c.title, bodyMd: c.bodyMd, reason: 'duplicate' as const,
          scopeType: c.scopeType, scopeId: resolveScopeId(c.scopeType, job.cwd ?? null),
          sourceCwd: job.cwd ?? null, runtime: c.runtime, sourceKind }
      })
      try { await logDiscards(db, job.id, dropRecords) } catch (e) { console.warn('memside: logDiscards failed', e) }
    }
    deduped = dedupOut.kept
    await saveStepOutput(db, job.id, 'dedup', { deduped, exactDrops: exact.drops.length, consolidatedDrops: dedupOut.dropIndices.length })
    await setJobCheckpoint(db, job.id, { currentStep: 'judge', stepAttempts: 0, stepError: null })
    currentStep = 'judge'
    stepAttempts = 0
  }
}
```

注：`deduped` 的类型从 `DistillCandidate[]` 升为 `ConsolidatedCandidate[]`——grep `deduped` 声明处声明（`let deduped: DistillCandidate[] | null`）改类型；judge 步消费 `deduped` 处（:538 `deduped[i]`）兼容（ConsolidatedCandidate extends DistillCandidate）。

- [ ] **Step 5: 改入库块（:604-622）让合并产物字段覆盖**

```typescript
for (const k of keepWithClass) {
  await deps.createCandidate(db, {
    scopeType: k.cand.scopeType,
    scopeId: resolveScopeId(k.cand.scopeType, job.cwd ?? null),
    title: k.cand.title,
    bodyMd: k.cand.bodyMd,
    tags: [],
    sourceKind,
    sourceCwd: job.cwd ?? null,
    runtime: k.cand.runtime,
    distillJobId: job.id,
    distillAction: k.cand.distillAction,        // 合并步产物覆盖（merge→new, update_of→update_of）
    supersedesId: k.cand.supersedesId ?? null,  // ★ 新增：update_of 透传 targetId
    sourceEventId: job.sourceEventId,
    valueClass: k.valueClass,
    subjectSlug: k.cand.subjectSlug,
    origin: k.cand.origin,
    evidence: k.cand.evidence,
  })
}
```

执行者确认 `createCandidate` 的 `MemoryInput`（store.ts:33 附近）有 `supersedesId` 字段——grep 确认；若无，Task 3 在 MemoryInput 加 `supersedesId?: string | null` 并在 createCandidate insert 透传（schema memories 表已有 supersedes_id 列，STATE.md 既有）。`keepWithClass` 的 cand 类型此时是 `ConsolidatedCandidate`（含 supersedesId）——grep `keepWithClass` 声明处确认类型随 `deduped` 升级。

- [ ] **Step 6: 运行测试验证通过**

Run: `bun test tests/scheduler-consolidation.test.ts`
Expected: PASS

- [ ] **Step 7: 全量校验防回归**

Run: `bun run typecheck && bun test`（Bash 工具）
Expected: 全绿。若既有 `tests/dedup.test.ts` / `tests/scheduler.test.ts` 引用已删的 `judgeDuplicates`/`dedupCandidates`，更新或删除对应用例（语义已被合并步取代）。

- [ ] **Step 8: 提交**

```bash
git add src/scheduler.ts tests/scheduler-consolidation.test.ts
git commit -m "feat(scheduler): dedup 步替换为合并步（consolidate）+ update_of 落库"
```

---

### Task 4: 删除旧 dedup 语义去重代码 + 测试清理

**Files:**
- Modify: `src/memory/dedup.ts`（删 `judgeDuplicates`/`DedupInput`/`DedupVerdict`/`DedupJudgeResult`/`DEDUP_SYSTEM_PROMPT`/`renderUserPrompt`/`dedupShouldRetry`/`isValidDuplicateOfId`；保留 `ExistingMemoryForDedup` type——合并步复用）
- Delete: `tests/dedup.test.ts`（若存在，语义去重测试已被 consolidate 测试取代）
- Modify: 任何 import `judgeDuplicates` 的残留（grep 全仓清理）

**Interfaces:**
- Consumes: Task 1（consolidate 接管）、Task 3（scheduler 不再 import 旧 dedup）。
- Produces: 仓库无 `judgeDuplicates` 残留。

- [ ] **Step 1: grep 确认旧符号无残留引用**

Run: `grep -rn "judgeDuplicates\|DEDUP_SYSTEM_PROMPT\|DedupInput\|DedupVerdict\|DedupJudgeResult" src/ tests/`
Expected: 仅 `src/memory/dedup.ts` 自身定义处命中（scheduler 已在 Task 3 改走 consolidate）。

- [ ] **Step 2: 删除 dedup.ts 语义去重部分**

保留 `ExistingMemoryForDedup` interface（Task 2 已加 subjectSlug）+ 其 import。删除其余语义去重函数与 SYSTEM_PROMPT。文件末态仅含 type 定义：

```typescript
// src/memory/dedup.ts —— 语义去重职责已由 src/memory/consolidate.ts 接管。
// 本文件仅保留 ExistingMemoryForDedup type（合并步 + listForDedupByScope 复用）。
import type { MemoryScope, MemoryStatus } from '@/memory/pure'

export interface ExistingMemoryForDedup {
  id: string
  title: string
  bodyMd: string
  scopeType: MemoryScope
  scopeId: string | null
  status: MemoryStatus
  subjectSlug?: string | null
}
```

- [ ] **Step 3: 删除/更新旧 dedup 测试**

若 `tests/dedup.test.ts` 存在且测 `judgeDuplicates`，删除整个文件（语义已由 `tests/consolidate.test.ts` 覆盖）。若该文件还测 `ExistingMemoryForDedup` type 或其他保留符号，只删 judgeDuplicates 相关用例。

- [ ] **Step 4: 全量校验**

Run: `bun run typecheck && bun test`（Bash 工具）
Expected: 全绿，无未用 import 报错。

- [ ] **Step 5: 提交**

```bash
git add src/memory/dedup.ts tests/dedup.test.ts
git commit -m "refactor(dedup): 删除被合并步取代的语义去重代码（保留 ExistingMemoryForDedup type）"
```

---

### Task 5: Web UI update_of 候选紫色「更新」徽标

**Files:**
- Modify: `src/web/ui-utils.ts`（加 `updateBadge` 纯函数）
- Modify: `src/web/App.tsx`（MemoryCard 渲染徽标）
- Test: `tests/app-source-assertions.test.ts`（源码层文本断言）

**Interfaces:**
- Consumes: candidate 的 `distillAction` + `supersedesId` 字段（Memory 类型已有，store 透传）。
- Produces: UI 给 update_of 候选显紫色「更新」徽标。

- [ ] **Step 1: 写失败测试——ui-utils updateBadge 纯函数**

```typescript
// tests/ui-clarity.test.ts 或 tests/app-source-assertions.test.ts 扩展
import { updateBadge } from '@/web/ui-utils'

describe('updateBadge', () => {
  it('update_of + supersedesId → badge with 更新 label', () => {
    const b = updateBadge({ distillAction: 'update_of', supersedesId: '01HXYZ' })
    expect(b).not.toBeNull()
    expect(b!.label).toContain('更新')
    expect(b!.color).toBe('purple')  // 紫色
  })
  it('new / null supersedesId → null (no badge)', () => {
    expect(updateBadge({ distillAction: 'new', supersedesId: null })).toBeNull()
    expect(updateBadge({ distillAction: 'update_of', supersedesId: null })).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test tests/ui-clarity.test.ts`（或 app-source-assertions）
Expected: FAIL（`updateBadge` 不存在）

- [ ] **Step 3: 实现 ui-utils.updateBadge**

```typescript
// src/web/ui-utils.ts —— 加到文件末尾
export interface UpdateBadge {
  label: string
  color: 'purple'
  tip: string
}

/** spec §6.3：update_of 候选显紫色「更新」徽标，提示这是对既有记忆的精炼而非全新条目。 */
export function updateBadge(c: { distillAction: string | null; supersedesId: string | null }): UpdateBadge | null {
  if (c.distillAction !== 'update_of' || !c.supersedesId) return null
  const short = c.supersedesId.slice(0, 6)
  return { label: `更新 #${short}`, color: 'purple', tip: '这是对既有已审批记忆的精炼/更新提案；批准时会取代原记忆，而非新增独立条目。' }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `bun test tests/ui-clarity.test.ts`
Expected: PASS

- [ ] **Step 5: MemoryCard 渲染徽标（App.tsx）**

执行者先 grep `MemoryCard` 在 App.tsx 的定义，找到徽章行渲染处（既有 origin/category 徽标附近），插入 updateBadge 渲染。参考既有徽标 inline style 模式（`src/web/App.tsx` 内 originBadge 用法）。骨架：

```tsx
// 在 MemoryCard 徽章行，origin 徽标之后：
{updateBadge({ distillAction: m.distillAction ?? null, supersedesId: m.supersedesId ?? null }) && (
  <span style={{ background: '#a855f7', color: '#fff', /* 既有徽标 padding/fontSize 模式 */ }} title={updateBadge({ distillAction: m.distillAction ?? null, supersedesId: m.supersedesId ?? null })!.tip}>
    {updateBadge({ distillAction: m.distillAction ?? null, supersedesId: m.supersedesId ?? null })!.label}
  </span>
)}
```

（执行者提取一次 `const ub = updateBadge(...)` 避免三重复调用，匹配既有代码风格。）

- [ ] **Step 6: 源码层文本断言（运行时组件兜底）**

```typescript
// tests/app-source-assertions.test.ts 扩展
it('MemoryCard renders update_of badge wiring', () => {
  const src = readFileSync(join(__dirname, '../src/web/App.tsx'), 'utf8')
  expect(src).toContain('updateBadge')
  expect(src).toContain('更新 #')
})
it('ui-utils exports updateBadge', () => {
  const src = readFileSync(join(__dirname, '../src/web/ui-utils.ts'), 'utf8')
  expect(src).toContain('export function updateBadge')
})
```

- [ ] **Step 7: 全量校验**

Run: `bun run typecheck && bun test`（Bash 工具）
Expected: 全绿。

- [ ] **Step 8: 提交**

```bash
git add src/web/ui-utils.ts src/web/App.tsx tests/app-source-assertions.test.ts
git commit -m "feat(web): update_of 候选紫色「更新」徽标（提示对既有记忆的精炼）"
```

---

### Task 6: 端到端闭环 + STATE.md 回填

**Files:**
- Modify: `STATE.md`（追加合并步段落 + 上线后观测清单）
- Test: `tests/scheduler-consolidation.test.ts`（扩展 e2e 形状断言）

**Interfaces:**
- Consumes: Task 1-5 全部。

- [ ] **Step 1: 写 e2e 形状断言——full pipeline distill→consolidate→judge→入库**

```typescript
// tests/scheduler-consolidation.test.ts 扩展
describe('full pipeline consolidation e2e', () => {
  it('distill 4 碎片 → consolidate merge 成 1 + judge → 1 candidate 入库', async () => {
    // fake callLLM: distill 返回 4 条同主题碎片；consolidate 返回 1 merge 组；
    // judge 返回 keep。断言 memories 表 1 条 candidate（非 4 条）。
  })
  it('update_of 全闭环：consolidate 标 update_of → 入库 supersedesId → approve 后 target 标 superseded', async () => {
    // 1 条既有 approved（targetId=A）+ consolidate 返回 update_of targetId=A
    // 入库 candidate.distillAction='update_of' supersedesId='A'
    // approve_and_supersede（supersedeIds=['A']）→ A.status='superseded'，candidate.status='approved'
    // 断言不新增独立 approved 条目（memories approved 计数不变，A 从 approved→superseded）
  })
})
```

- [ ] **Step 2: 运行测试验证**

Run: `bun test tests/scheduler-consolidation.test.ts`
Expected: PASS（若 e2e 用例因 fake LLM 形状问题红，调 fake 返回对齐 consolidate 契约）。

- [ ] **Step 3: STATE.md 追加段落**

在 STATE.md 顶部「## 蒸馏输入膨胀根治」之前插入新段落，记录：合并步替换 dedup、merge/keep/drop/update_of 四态、slug 预筛、origin 降级、update_of 闭环、改动文件、测试数、上线后观测清单（每会话产出候选数对比、同 slug 并存数、无 slug 占比、update_of 采纳率、误并抽样、合并步失败率）。

- [ ] **Step 4: 全量校验**

Run: `bun run typecheck && bun test`（Bash 工具）
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add STATE.md tests/scheduler-consolidation.test.ts
git commit -m "test+docs: 合并步 e2e 闭环 + STATE.md 记录"
```

---

## Self-Review

**1. Spec coverage:**
- §3 架构（dedup 步升级合并步）→ Task 1 + Task 3。✓
- §3.3 slug 预筛解除 50 盲区 → Task 2。✓
- §4 LLM 契约（merge/keep/drop/update_of + 字段取舍）→ Task 1。✓
- §4.3 origin 一律降级 observed → Task 1（`origin: 'agent-observed'` 硬编码 + 测试）。✓
- §4.4 id 引用约束 + targetId ∈ existing → Task 1（shouldRetry + parse 兜底）。✓
- §5 失败处理/断点续跑 → Task 1（consolidateCandidates 走 runLlmSession step='dedup'）+ Task 3（failed 冒泡）。✓
- §6 update_of 落库 + 审批闭环 → Task 3（入库 supersedesId）+ Task 5（UI 徽标）。✓
- §6.1 target 限定 approved → Task 1（existing 只含 approved + candidate，但 update_of 守卫 targetId ∈ existingIds；Task 3 测试用 approved target 验证）。注：existing 含 candidate，update_of 理论可指 candidate——但 §6.1 说 target 限定 approved。**缺口**：listForDedupByScope 返回的 existing 含 candidate，update_of 可指向 candidate。需在 Task 1 parseConsolidate 收紧：update_of targetId 必须 ∈ existing 中 status='approved' 的 id。
- §8 改动面表 → 各 Task 对应。✓
- §9 测试策略 → 各 Task 测试。✓

**修复缺口**：Task 1 的 update_of 校验需按 target 的 status='approved' 限定（不只 id ∈ existing）。在 parseConsolidate/consolidateShouldRetry 中，existingIds 应只含 approved 的 id（candidate id 不算合法 target）。

**2. Placeholder scan:** Step 1 测试骨架（Task 3/6）含「参考既有 helper」说明——执行者需先读邻近测试。这是可接受的（既有模式复用），非占位符。其余步骤含实际代码。无 TBD/TODO。

**3. Type consistency:** `ConsolidatedCandidate extends DistillCandidate + supersedesId` 在 Task 1 定义、Task 3 消费（`k.cand.supersedesId`）、Task 5 UI 消费（`m.supersedesId`）——一致。`updateBadge` 在 Task 5 定义/消费一致。`listForDedupByScope` 新签名（slugs）Task 2 定义、Task 3 消费——一致。

应用缺口修复：更新 Task 1 的 update_of 校验逻辑。

已在 Task 1 Step 7 实现里固化：`existingIds` 来自 `existing`（含 approved + candidate），但 update_of 守卫 `existingIds.has(g.targetId)` 会让 candidate 也可作 target。需收紧为只允许 approved target。执行者按下方修正实现。

---

**修正说明（执行者必读）：** Task 1 中 `parseConsolidate` 与 `consolidateShouldRetry` 的 `existingIds` 应改为 `approvedIds`（只含 `existing.filter(e => e.status === 'approved').map(e => e.id)`）。candidate 不可作 update_of target（spec §6.1）。测试 `update_of with valid targetId` 用例的 existing target 必须是 `status:'approved'`（已是）。Task 1 Step 3 边界用例 `update_of with invalid targetId` 用 `targetId:'ZZZ'`——ZZZ 不在 approvedIds，正确 fallback。补一条用例：`update_of targetId 指向 candidate（非 approved）→ fallback keep`。
