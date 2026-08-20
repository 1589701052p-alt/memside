// Task 3：scheduler dedup 步替换为合并步（consolidateCandidates）端到端回归锁。
//
// 锁三件事（断言语义逐字按 task-3-brief）：
// 1. 合并步 drop 的候选进 memory_discards（reason='duplicate'）——旧 dedup 二元
//    丢弃不落审计表，新合并步把 drop 显式记审计（spec §3）。
// 2. merge 产出候选 origin 一律降级 agent-observed（无例外，即便 LLM 标 mergedOrigin=
//    user-stated，parseConsolidate 强制降级）。
// 3. update_of 产出候选携带 distillAction='update_of' + supersedesId=targetId 入库。
//
// 复用 tests/scheduler.test.ts 的 tick harness：openDb(tmp) -> enqueueDistillJob ->
// nextRunAt=0 -> tick(db, deps)。callLLM 按 system prompt 内容分派（distiller/
// consolidate/value-judge 三选一）。deps.createCandidate 用真实 store.createCandidate
// 才能断言入库行。
import { test, describe, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { enqueueDistillJob, tick, consolidateBatch } from '@/scheduler'
import { createCandidate as realCreateCandidate, promoteCandidate } from '@/memory/store'
import { memories, memoryDiscards, memoryDistillJobs } from '@/db/schema'
import type { DistillCandidate } from '@/memory/distiller'

const ECONOMY = { mode: 'economy', maxRounds: 30, timeBudgetS: 300 } as const

const root = join(import.meta.dir, '.tmp-sched-consol')
let dir = ''
let db: ReturnType<typeof openDb>

beforeAll(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
})

beforeEach(() => {
  dir = join(root, Math.random().toString(36).slice(2))
  mkdirSync(dir, { recursive: true })
  db = openDb(join(dir, 't.db'))
})

afterEach(() => {
  db.$client.close()
})

async function seedDueJob(cwd = '/r'): Promise<string> {
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd, debounceKey: 'k1', debounceMs: 0,
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  return jobId
}

test('合并步 drop 候选进 memory_discards（reason=duplicate）', async () => {
  // 2 候选无 existing -> 合并步仍调 LLM（n>1）。LLM 标 new-0 为 drop（纯语义重复）、
  // new-1 为 keep。drop 的 new-0 走 logDiscards reason='duplicate'；keep 的 new-1 经
  // judge keep 入库。
  await seedDueJob()
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'refund 14 days' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async (sys) => {
      callCount++
      if (sys.includes('memside-distiller')) return JSON.stringify({
        candidates: [
          { title: '[category:invariant] 14天退款', bodyMd: '14d', scope: 'project', runtime: null, distillAction: 'new' },
          { title: '[category:process] 退款流程', bodyMd: '流程', scope: 'project', runtime: null, distillAction: 'new' },
        ],
      })
      if (sys.includes('memside-consolidate')) return JSON.stringify({
        groups: [
          { action: 'drop', members: ['new-0'], dropReason: 'duplicate' },
          { action: 'keep', members: ['new-1'] },
        ],
      })
      // judge (memside-value-judge) -> keep
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    },
    createCandidate: realCreateCandidate as never,
    loadJudgeConfig: () => ECONOMY,
  })
  expect(callCount).toBe(3) // distill + consolidate + judge
  const discards = await db.select().from(memoryDiscards)
  expect(discards.length).toBe(1)
  expect(discards[0]!.reason).toBe('duplicate')
  expect(discards[0]!.title).toBe('[category:invariant] 14天退款')
  // keep 的 new-1 入库 1 行
  const rows = await db.select().from(memories).where(eq(memories.status, 'candidate'))
  expect(rows.length).toBe(1)
})

test('merge 产出候选 origin 降级 agent-observed（LLM 标 user-stated 亦强制降级）', async () => {
  // 2 候选合并为 1：LLM 返回 merge group mergedOrigin='user-stated'，但 parseConsolidate
  // 一律强制 origin='agent-observed'（综合产物按观察处理）。断言入库候选 origin=
  // agent-observed。
  await seedDueJob()
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'refund policy' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async (sys) => {
      if (sys.includes('memside-distiller')) return JSON.stringify({
        candidates: [
          { title: '[category:invariant] 退款窗口', bodyMd: '14d', scope: 'project', runtime: null, distillAction: 'new', origin: 'user-stated', evidence: 'e1' },
          { title: '[category:invariant] refund window', bodyMd: '14 days', scope: 'project', runtime: null, distillAction: 'new', origin: 'user-stated', evidence: 'e2' },
        ],
      })
      if (sys.includes('memside-consolidate')) return JSON.stringify({
        groups: [
          { action: 'merge', members: ['new-0', 'new-1'], mergedTitle: '[category:invariant] 退款窗口 14 天', mergedBody: '14 days', mergedEvidence: 'e1; e2', mergedSlug: 'refund-window', mergedOrigin: 'user-stated' },
        ],
      })
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    },
    createCandidate: realCreateCandidate as never,
    loadJudgeConfig: () => ECONOMY,
  })
  const rows = await db.select().from(memories).where(eq(memories.status, 'candidate'))
  expect(rows.length).toBe(1)
  expect(rows[0]!.origin).toBe('agent-observed')
  expect(rows[0]!.distillAction).toBe('new')  // merge -> new
})

test('update_of 产出候选携带 distillAction=update_of + supersedesId=targetId', async () => {
  // 既有 approved 记忆 EX；新候选 1 条 -> 合并步调 LLM（existing 非空）。LLM 标
  // update_of targetId=EX.id。断言入库候选 distillAction='update_of' 且 supersedesId=EX.id。
  const ex = await realCreateCandidate(db, { scopeType: 'project', scopeId: '/r', title: '[category:invariant] 既有退款规则', bodyMd: '7d', tags: [], sourceKind: 'manual', runtime: null, sourceCwd: '/r' })
  await db.update(memories).set({ status: 'approved' }).where(eq(memories.id, ex.id)).run()
  await seedDueJob()
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'refund extended to 14 days' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async (sys) => {
      if (sys.includes('memside-distiller')) return JSON.stringify({
        candidates: [{ title: '[category:invariant] 退款延长至 14 天', bodyMd: '14d', scope: 'project', runtime: null, distillAction: 'new' }],
      })
      if (sys.includes('memside-consolidate')) return JSON.stringify({
        groups: [
          { action: 'update_of', targetId: ex.id, members: ['new-0'], mergedTitle: '[category:invariant] 退款窗口 14 天', mergedBody: '14 days', mergedEvidence: 'refund extended', mergedSlug: 'refund-window', mergedOrigin: 'agent-observed' },
        ],
      })
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    },
    createCandidate: realCreateCandidate as never,
    loadJudgeConfig: () => ECONOMY,
  })
  const rows = await db.select().from(memories).where(eq(memories.status, 'candidate'))
  expect(rows.length).toBe(1)
  expect(rows[0]!.distillAction).toBe('update_of')
  expect(rows[0]!.supersedesId).toBe(ex.id)
})

test('consolidateBatch bubbles listForDedupByScope DB errors (spec §8)', async () => {
  // 回归补偿（Task 4 清理旧 dedupCandidates 直接测试后）：合并步 consolidateBatch 与
  // 旧 dedupCandidates 同走 listForDedupByScope 查询，基础设施 DB 错误必须冒泡到
  // tick 的 catch（job 退避重试），不得被吞——LLM 调用前查询已抛错。
  const db2 = openDb(join(dir, 't2.db'))
  db2.$client.close()
  const cand: DistillCandidate = { title: '[category:x] x', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new', origin: 'agent-observed', evidence: null, subjectSlug: null }
  await expect(consolidateBatch(db2, async () => 'x', [cand], '/r')).rejects.toThrow()
})

// Task 6：端到端闭环 e2e——锁 spec §3「合并步替换 dedup」全链路形状：
// distill → consolidate → judge → 入库 →（update_of 用例）promote 闭环。
// 既有 Task 3 三用例锁单步断言（drop→discards / merge origin 降级 /
// update_of 入库字段），此处锁端到端串联后的**表级结果**。
describe('full pipeline consolidation e2e', () => {
  test('distill 4 碎片 → consolidate merge 成 1 + judge → 1 candidate 入库（非 4 条）', async () => {
    // 碎片熔合回归：4 条同主题（退款窗口）碎片经合并步熔成 1 条 merge 组，judge
    // keep，最终 memories 表仅 1 条 candidate（非 4 条独立条目）。锁合并步替换
    // 旧 dedup 的核心承诺——减量不丢事实。
    await seedDueJob()
    let callCount = 0
    await tick(db, {
      loadTranscript: async () => ({ turns: [{ role: 'user', content: 'refund 14 days policy' }], fullLength: 1, prefixTurns: [] }),
      callLLM: async (sys) => {
        callCount++
        if (sys.includes('memside-distiller')) return JSON.stringify({
          candidates: [
            { title: '[category:invariant] 退款窗口 14 天', bodyMd: '14d', scope: 'project', runtime: null, distillAction: 'new' },
            { title: '[category:invariant] refund window 14 days', bodyMd: 'fourteen days', scope: 'project', runtime: null, distillAction: 'new' },
            { title: '[category:invariant] 14天内可退', bodyMd: '两周退款', scope: 'project', runtime: null, distillAction: 'new' },
            { title: '[category:invariant] 退款期限14日', bodyMd: '14 days refund', scope: 'project', runtime: null, distillAction: 'new' },
          ],
        })
        if (sys.includes('memside-consolidate')) return JSON.stringify({
          groups: [
            { action: 'merge', members: ['new-0', 'new-1', 'new-2', 'new-3'], mergedTitle: '[category:invariant] 退款窗口 14 天', mergedBody: '购买后 14 天内可退款', mergedEvidence: '14d; fourteen days; 两周退款; 14 days refund', mergedSlug: 'refund-window', mergedOrigin: 'agent-observed' },
          ],
        })
        // judge (memside-value-judge) -> keep
        return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
      },
      createCandidate: realCreateCandidate as never,
      loadJudgeConfig: () => ECONOMY,
    })
    expect(callCount).toBe(3) // distill + consolidate + judge
    const rows = await db.select().from(memories).where(eq(memories.status, 'candidate'))
    expect(rows.length).toBe(1)
    expect(rows[0]!.title).toBe('[category:invariant] 退款窗口 14 天')
    expect(rows[0]!.origin).toBe('agent-observed')  // merge 综合产物降级
    expect(rows[0]!.subjectSlug).toBe('refund-window')
  })

  test('update_of 全闭环：consolidate 标 update_of → 入库 supersedesId → approve 后 target 标 superseded', async () => {
    // 既有 approved（id=A）+ consolidate 返回 update_of targetId=A。
    // 入库 candidate.distillAction='update_of' supersedesId='A'。
    // approve_and_supersede(supersedeIds=['A']) → A.status='superseded'，
    // candidate.status='approved'。断言不新增独立 approved 条目（A 从 approved→superseded，
    // 新 candidate 接管为 approved，approved 计数前后不变）。
    const A = await realCreateCandidate(db, { scopeType: 'project', scopeId: '/r', title: '[category:invariant] 退款规则 7 天', bodyMd: '7d', tags: [], sourceKind: 'manual', runtime: null, sourceCwd: '/r' })
    await db.update(memories).set({ status: 'approved' }).where(eq(memories.id, A.id)).run()
    const approvedBefore = (await db.select().from(memories).where(eq(memories.status, 'approved'))).length
    expect(approvedBefore).toBe(1)
    await seedDueJob()
    await tick(db, {
      loadTranscript: async () => ({ turns: [{ role: 'user', content: 'refund extended to 14 days' }], fullLength: 1, prefixTurns: [] }),
      callLLM: async (sys) => {
        if (sys.includes('memside-distiller')) return JSON.stringify({
          candidates: [{ title: '[category:invariant] 退款窗口延长至 14 天', bodyMd: '14d', scope: 'project', runtime: null, distillAction: 'new' }],
        })
        if (sys.includes('memside-consolidate')) return JSON.stringify({
          groups: [
            { action: 'update_of', targetId: A.id, members: ['new-0'], mergedTitle: '[category:invariant] 退款窗口 14 天', mergedBody: '14 days', mergedEvidence: 'refund extended to 14 days', mergedSlug: 'refund-window', mergedOrigin: 'agent-observed' },
          ],
        })
        return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
      },
      createCandidate: realCreateCandidate as never,
      loadJudgeConfig: () => ECONOMY,
    })
    // 入库断言：candidate 带 update_of + supersedesId
    const candRows = await db.select().from(memories).where(eq(memories.status, 'candidate'))
    expect(candRows.length).toBe(1)
    const cand = candRows[0]!
    expect(cand.distillAction).toBe('update_of')
    expect(cand.supersedesId).toBe(A.id)
    // 闭环：approve_and_supersede → A 标 superseded，candidate 标 approved
    const promoted = await promoteCandidate(db, cand.id, { action: 'approve_and_supersede', supersedeIds: [A.id] })
    expect(promoted.status).toBe('approved')
    expect(promoted.supersedesId).toBe(A.id)
    expect(promoted.version).toBe(2)  // A.version=1 → 接管行 version+1
    const Aafter = (await db.select().from(memories).where(eq(memories.id, A.id)))[0]!
    expect(Aafter.status).toBe('superseded')
    expect(Aafter.supersededById).toBe(cand.id)
    // 不新增独立 approved 条目：approved 计数前后不变（A 退出 approved，candidate 进 approved）
    const approvedAfter = (await db.select().from(memories).where(eq(memories.status, 'approved'))).length
    expect(approvedAfter).toBe(approvedBefore)
  })
})
