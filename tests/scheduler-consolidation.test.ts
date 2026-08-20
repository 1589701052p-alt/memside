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
import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { enqueueDistillJob, tick } from '@/scheduler'
import { createCandidate as realCreateCandidate } from '@/memory/store'
import { memories, memoryDiscards, memoryDistillJobs } from '@/db/schema'

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
