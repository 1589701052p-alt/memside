// tests/consolidate.test.ts
//
// 合并步纯逻辑模块 consolidate.ts 的单元测试（spec 2026-08-19-candidate-consolidation Task 1）。
// 锁定的回归类：
// - parseConsolidate：合法 merge/keep/drop 解析、单条幻觉组兜底 keep、漏覆盖兜底 keep、
//   update_of targetId 校验（仅 approved 合法；candidate 非法 → fallback keep）、
//   origin 一律降级 agent-observed、mergedTitle 缺 [category:] 前缀组无效、形状突变 → null。
// - consolidateShouldRetry：形状/action/members/targetId/mergedTitle 校验。
// - CONSOLIDATE_SYSTEM_PROMPT：硬约束 token 在场。
//
// 控制器裁决（pre-flight scan）：
// #1 update_of target 合法集合 = existing.filter(status==='approved') 的 id（approvedIds），
//    非 candidate id。parseConsolidate 与 consolidateShouldRetry 均按此过滤。
// #2 新增用例：update_of targetId 指向 candidate（非 approved）→ 该组无效，members 兜底 keep。
import { describe, it, expect } from 'bun:test'
import { parseConsolidate, consolidateShouldRetry, CONSOLIDATE_SYSTEM_PROMPT, renderUserPrompt } from '@/memory/consolidate'
import type { ExistingMemoryForDedup } from '@/memory/dedup'

const existing: ExistingMemoryForDedup[] = [
  { id: 'A', title: '[category:convention] old', bodyMd: 'b', scopeType: 'project', scopeId: 'p', status: 'approved' },
  // 裁决 #2：夹具含 status:'candidate' 的 id 'C'，证明 candidate 不可作 update_of target。
  { id: 'C', title: '[category:convention] pending', bodyMd: 'c', scopeType: 'project', scopeId: 'p', status: 'candidate' },
]

// newCandidates：两条同主题碎片 + 一条独立 + 一条纯重复（new-3，待 drop）
const news = [
  { title: '[category:convention] 退款14天', bodyMd: 'b1', scopeType: 'project' as const, runtime: 'claude-code' as const, distillAction: 'new' as const, origin: 'user-stated' as const, evidence: 'e1', subjectSlug: 'refund' },
  { title: '[category:invariant] 退款期限', bodyMd: 'b2', scopeType: 'project' as const, runtime: 'claude-code' as const, distillAction: 'new' as const, origin: 'agent-observed' as const, evidence: 'e2', subjectSlug: 'refund' },
  { title: '[category:architecture] 无关', bodyMd: 'b3', scopeType: 'project' as const, runtime: 'claude-code' as const, distillAction: 'new' as const, origin: 'agent-observed' as const, evidence: null, subjectSlug: 'other' },
  // new-3：new-0 的纯语义重复（同一规则换个说法），待 drop
  { title: '[category:convention] 退款须14天内', bodyMd: 'b1dup', scopeType: 'project' as const, runtime: 'claude-code' as const, distillAction: 'new' as const, origin: 'user-stated' as const, evidence: 'e1dup', subjectSlug: 'refund' },
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
    // merge 产出 1 条；keep 产出 1 条（new-2 原样）；drop 不产出候选但记 dropIndices
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
    expect(res!.candidates[0]!.supersedesId).toBeNull()  // 无 supersedesId
  })
  // 裁决 #2：targetId 指向 candidate（非 approved）→ 该组无效，members 兜底 keep
  it('update_of targetId points to candidate (non-approved) → fallback keep', () => {
    const out = { groups: [{ action: 'update_of', targetId: 'C', members: ['new-0'], mergedTitle: '[category:convention] x', mergedBody: 'b', mergedEvidence: 'e', mergedSlug: 's', mergedOrigin: 'agent-observed' }] }
    const res = parseConsolidate(out, [news[0]!], existing)
    expect(res!.candidates[0]!.distillAction).toBe('new')  // candidate 不可作 target → fallback keep
    expect(res!.candidates[0]!.supersedesId).toBeNull()
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

describe('consolidateShouldRetry', () => {
  // 裁决 #1：合法 target 集合 = existing.filter(status==='approved') 的 id（A approved, C candidate）
  const approvedIds = new Set(existing.filter((e) => e.status === 'approved').map((e) => e.id))
  const fn = consolidateShouldRetry(approvedIds)
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
  it('update_of targetId not in approved → retry', () => {
    expect(fn({ groups: [{ action: 'update_of', targetId: 'ZZZ', members: ['new-0'] }] })).toMatch(/targetId/)
  })
  // 裁决 #2：targetId 指向 candidate（非 approved）→ retry（C 不在 approvedIds 内）
  it('update_of targetId points to candidate (non-approved) → retry', () => {
    expect(fn({ groups: [{ action: 'update_of', targetId: 'C', members: ['new-0'] }] })).toMatch(/targetId/)
  })
  // 回归锁（spec 2026-08-20）：报错必须携带可执行引导，否则 followup 轮模型无据可改、3 轮同错
  it('targetId not in approved → retry message lists APPROVED 分区合法 id', () => {
    expect(fn({ groups: [{ action: 'update_of', targetId: 'C', members: ['new-0'] }] })).toMatch(/仅限 APPROVED 分区: A/)
  })
  // 回归锁（spec 2026-08-20-consolidate-update-of-target-prompt final-fix M1）：
  // approvedIds 过大时引导串不得把全部 id 列出（token 溢出 / prompt 失焦），
  // 最多列前 20 个 + 「等 N 条」尾注。空集合不计算 ids（M2 死计算）。
  it('approvedIds > 20 → retry message 只列前 20 个 id + 「等 N 条」', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 25; i++) ids.add(`id-${i}`)
    const fn25 = consolidateShouldRetry(ids)
    const msg = fn25({ groups: [{ action: 'update_of', targetId: 'BAD', members: ['new-0'] }] })
    expect(msg).toContain('id-0')           // 第 1 个列出
    expect(msg).not.toContain('id-20')     // 第 21 个不列出
    expect(msg).toContain('等 25 条')
  })
  it('approvedIds 为空 → retry message 明示不可使用 update_of', () => {
    const fnEmpty = consolidateShouldRetry(new Set<string>())
    expect(fnEmpty({ groups: [{ action: 'update_of', targetId: 'C', members: ['new-0'] }] })).toMatch(/不可使用 update_of/)
  })
  it('merge missing mergedTitle → retry', () => {
    expect(fn({ groups: [{ action: 'merge', members: ['new-0'], mergedBody: 'b', mergedEvidence: 'e', mergedSlug: 's', mergedOrigin: 'agent-observed' }] })).toMatch(/mergedTitle/)
  })
  it('merge missing mergedSlug → retry', () => {
    expect(fn({ groups: [{ action: 'merge', members: ['new-0'], mergedTitle: '[category:convention] x', mergedBody: 'b', mergedEvidence: 'e', mergedOrigin: 'agent-observed' }] })).toMatch(/mergedSlug/)
  })
  it('update_of missing mergedSlug → retry', () => {
    expect(fn({ groups: [{ action: 'update_of', targetId: 'A', members: ['new-0'], mergedTitle: '[category:convention] x', mergedBody: 'b', mergedEvidence: 'e', mergedOrigin: 'agent-observed' }] })).toMatch(/mergedSlug/)
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
  // 回归锁（spec 2026-08-20）：分区规则必须写进系统提示，且旧的假 id 示例必须清除
  it('contains partition rules + empty-approved ban + no fake id example', () => {
    expect(CONSOLIDATE_SYSTEM_PROMPT).toContain('APPROVED 分区')
    expect(CONSOLIDATE_SYSTEM_PROMPT).toContain('CANDIDATE 分区')
    expect(CONSOLIDATE_SYSTEM_PROMPT).toContain('(none)')
    expect(CONSOLIDATE_SYSTEM_PROMPT).toContain('禁止使用 update_of')
    expect(CONSOLIDATE_SYSTEM_PROMPT).not.toContain('"targetId": "A"')
  })
})

// 回归锁（spec 2026-08-20-consolidate-update-of-target-prompt）：
// 旧 renderUserPrompt 把 approved+candidate 混排且不带 status，模型无从区分，
// update_of 指向 candidate 时 3 轮重试同错必挂。分区渲染让规则可执行。
describe('renderUserPrompt 分区渲染', () => {
  it('approved 与 candidate 各归其区，id 不串区', () => {
    const p = renderUserPrompt(news, existing, ['refund'])
    const approvedIdx = p.indexOf('Existing APPROVED memories')
    const candidateIdx = p.indexOf('Existing CANDIDATE memories')
    const newIdx = p.indexOf('New candidates:')
    expect(approvedIdx).toBeGreaterThanOrEqual(0)
    expect(candidateIdx).toBeGreaterThan(approvedIdx)
    expect(newIdx).toBeGreaterThan(candidateIdx)
    const approvedSection = p.slice(approvedIdx, candidateIdx)
    const candidateSection = p.slice(candidateIdx, newIdx)
    expect(approvedSection).toContain('id=A')       // A 是 approved 夹具
    expect(approvedSection).not.toContain('id=C')
    expect(candidateSection).toContain('id=C')      // C 是 candidate 夹具
    expect(candidateSection).not.toContain('id=A')
  })
  it('approved 为空 → 明示 update_of 不可用 + candidate 仍列出', () => {
    const p = renderUserPrompt(news, [existing[1]!], ['refund'])  // 仅 candidate C
    expect(p).toContain('update_of is NOT available')
    expect(p).toContain('id=C')
    expect(p.slice(p.indexOf('Existing APPROVED'), p.indexOf('Existing CANDIDATE'))).toContain('(none)')
  })
  it('existing 为空 → 两区均 (none)', () => {
    const p = renderUserPrompt(news, [], [])
    expect(p).toContain('New candidates:')
    const approvedSection = p.slice(p.indexOf('Existing APPROVED'), p.indexOf('Existing CANDIDATE'))
    const candidateSection = p.slice(p.indexOf('Existing CANDIDATE'), p.indexOf('New candidates:'))
    expect(approvedSection).toContain('(none)')
    expect(candidateSection).toContain('(none)')
  })
})
