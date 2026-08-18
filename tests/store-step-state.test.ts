// tests/store-step-state.test.ts
// 锁 spec 2026-08-18 §4.1/§5.2/§8.3：断点读写、对话历史四样 round-trip、
// 3 次失败汇总一条任务级通知（同任务折叠）、paused→重试重置、pending_review。
// 覆盖 Task 4 store 层断点/历史/通知/暂停/重试/放弃/pending_review 全部函数。
import { describe, expect, test, beforeEach } from 'bun:test'
import { openDb, type DbClient } from '@/db/client'
import { memoryDistillJobs, memoryDistillRuns, memories } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getJobCheckpoint, setJobCheckpoint, saveLlmRound, listLlmRounds,
  markJobPaused, resetJobForRetry, abandonJob, logStepFailureNotification,
  listPendingReviewCandidates, promotePendingReviewToCandidate,
  createCandidate, listNotificationsPage,
} from '@/memory/store'

let db: DbClient

// 注：brief 原文用 openDb(':memory:')，但 client.ts 的 mkdirSync(dirname(path))
// 对 ':memory:' 会在 bun 下抛 EEXIST(mkdir '.')，改用每次 fresh 的临时文件库（与
// tests/store-distill-batching.test.ts 同模式）。
const seedJob = async (id: string) => {
  await db.insert(memoryDistillJobs).values({
    id, debounceKey: 'k', sourceEventId: 'e', runtime: 'claude-code',
    status: 'pending', attempts: 0, nextRunAt: 0, createdAt: 1, finishedAt: null,
  })
}

const seedRun = async (jobId: string) => {
  await db.insert(memoryDistillRuns).values({
    distillJobId: jobId, outcome: 'produced', distilledCount: 0, acceptedCount: 0,
    dedupedCount: 0, filteredCount: 0, storedCount: 0, discardedCount: 0,
    durationMs: 10, ts: 1,
  })
}

const countNotifications = async (kind?: string): Promise<number> => {
  const pg = await listNotificationsPage(db, kind ? { kind: kind as any } : {})
  return pg.total
}

beforeEach(() => {
  db = openDb(join(mkdtempSync(join(tmpdir(), 'memside-step-store-')), 'test.db'))
})

describe('断点读写', () => {
  test('新 job 断点默认 distill/0/null（currentStep NULL → distill）', async () => {
    await seedJob('j1')
    const cp = getJobCheckpoint(db, 'j1')
    expect(cp.currentStep).toBe('distill')
    expect(cp.stepAttempts).toBe(0)
    expect(cp.stepError).toBeNull()
  })

  test('getJobCheckpoint 不存在的 job 也返回默认值（不抛）', () => {
    const cp = getJobCheckpoint(db, 'nope')
    expect(cp.currentStep).toBe('distill')
    expect(cp.stepAttempts).toBe(0)
    expect(cp.stepError).toBeNull()
  })

  test('setJobCheckpoint 写入后读回一致', async () => {
    await seedJob('j1')
    await setJobCheckpoint(db, 'j1', { currentStep: 'judge', stepAttempts: 2, stepError: 'aborted' })
    const cp = getJobCheckpoint(db, 'j1')
    expect(cp).toEqual({ currentStep: 'judge', stepAttempts: 2, stepError: 'aborted' })
  })

  test('setJobCheckpoint 可清空 stepError（传 null）', async () => {
    await seedJob('j1')
    await setJobCheckpoint(db, 'j1', { currentStep: 'distill', stepAttempts: 1, stepError: 'fmt' })
    await setJobCheckpoint(db, 'j1', { currentStep: 'distill', stepAttempts: 1, stepError: null })
    expect(getJobCheckpoint(db, 'j1').stepError).toBeNull()
  })
})

describe('对话历史 round-trip', () => {
  test('saveLlmRound 四样落盘且 listLlmRounds 按 round 升序读回', async () => {
    await seedJob('j1')
    await saveLlmRound(db, { jobId: 'j1', step: 'judge', round: 2, request: 'q2', response: 'r2', result: { ok: true } })
    await saveLlmRound(db, { jobId: 'j1', step: 'judge', round: 1, request: 'q1', response: 'r1', result: { ok: false, reason: 'format' } })
    const rounds = await listLlmRounds(db, 'j1', 'judge')
    expect(rounds).toHaveLength(2)
    expect(rounds[0]!.round).toBe(1)
    expect(rounds[0]!.request).toBe('q1')
    expect(rounds[0]!.response).toBe('r1')
    expect(rounds[0]!.result).toEqual({ ok: false, reason: 'format' })
    expect(rounds[1]!.round).toBe(2)
    expect(rounds[1]!.result).toEqual({ ok: true })
  })

  test('listLlmRounds 只读本步骤（不跨步，payload.step 过滤）', async () => {
    await seedJob('j1')
    await saveLlmRound(db, { jobId: 'j1', step: 'distill', round: 1, request: 'd', response: 'd', result: { ok: true } })
    await saveLlmRound(db, { jobId: 'j1', step: 'judge', round: 1, request: 'j', response: 'j', result: { ok: true } })
    const rounds = await listLlmRounds(db, 'j1', 'judge')
    expect(rounds).toHaveLength(1)
    expect(rounds[0]!.request).toBe('j')
  })

  test('listLlmRounds 无历史返回空数组', async () => {
    await seedJob('j1')
    const rounds = await listLlmRounds(db, 'j1', 'distill')
    expect(rounds).toEqual([])
  })
})

describe('3 次失败汇总通知', () => {
  test('logStepFailureNotification 写一条任务级通知含汇总原因', async () => {
    await seedJob('j1')
    await logStepFailureNotification(db, { jobId: 'j1', step: 'judge', reasons: ['aborted(360036ms)', 'format(缺verdicts)', 'aborted(360045ms)'] })
    const pg = await listNotificationsPage(db, { kind: 'llm_error' })
    expect(pg.total).toBe(1)
    const n = pg.items[0]!
    expect(n.kind).toBe('llm_error')
    expect(n.title).toBe('judge_failed')
    expect(n.refType).toBe('distill_job')
    expect(n.refId).toBe('j1')
    expect(n.body).toContain('aborted(360036ms)')
    expect(n.body).toContain('format(缺verdicts)')
    expect(n.body).toContain('aborted(360045ms)')
  })

  test('同任务重复暂停折叠不刷屏（同内容折叠）', async () => {
    await seedJob('j1')
    await logStepFailureNotification(db, { jobId: 'j1', step: 'judge', reasons: ['a', 'b', 'c'] })
    const before = await countNotifications('llm_error')
    await logStepFailureNotification(db, { jobId: 'j1', step: 'judge', reasons: ['a', 'b', 'c'] })
    const after = await countNotifications('llm_error')
    expect(after).toBe(before) // 折叠，不新增
  })

  test('不同原因不折叠（新通知）', async () => {
    await seedJob('j1')
    await logStepFailureNotification(db, { jobId: 'j1', step: 'judge', reasons: ['a'] })
    await logStepFailureNotification(db, { jobId: 'j1', step: 'judge', reasons: ['b'] })
    expect(await countNotifications('llm_error')).toBe(2)
  })
})

describe('paused→重试重置', () => {
  test('markJobPaused 置 status=paused + run.pausedStep', async () => {
    await seedJob('j1')
    await seedRun('j1')
    await markJobPaused(db, 'j1', 'judge')
    const [j] = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, 'j1'))
    expect(j!.status).toBe('paused')
    expect(j!.stepError).not.toBeNull()
    const [r] = await db.select().from(memoryDistillRuns).where(eq(memoryDistillRuns.distillJobId, 'j1'))
    expect(r!.pausedStep).toBe('judge')
  })

  test('markJobPaused 无 run 行不抛（best-effort pausedStep）', async () => {
    await seedJob('j1')
    await expect(markJobPaused(db, 'j1', 'distill')).resolves.toBeUndefined()
    const [j] = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, 'j1'))
    expect(j!.status).toBe('paused')
  })

  test('resetJobForRetry 清零 attempts/stepError 回 pending', async () => {
    await seedJob('j1')
    await seedRun('j1')
    await setJobCheckpoint(db, 'j1', { currentStep: 'judge', stepAttempts: 3, stepError: 'aborted' })
    await markJobPaused(db, 'j1', 'judge')
    await resetJobForRetry(db, 'j1')
    const cp = getJobCheckpoint(db, 'j1')
    expect(cp.stepAttempts).toBe(0)
    expect(cp.stepError).toBeNull()
    const [j] = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, 'j1'))
    expect(j!.status).toBe('pending')
    expect(j!.nextRunAt).toBeLessThanOrEqual(Date.now())
  })

  test('abandonJob 置 status=done', async () => {
    await seedJob('j1')
    await setJobCheckpoint(db, 'j1', { currentStep: 'judge', stepAttempts: 2, stepError: 'x' })
    await abandonJob(db, 'j1')
    const [j] = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, 'j1'))
    expect(j!.status).toBe('done')
    expect(j!.finishedAt).not.toBeNull()
  })
})

describe('pending_review 候选', () => {
  test('listPendingReviewCandidates 按 projectId 过滤 pending_review 行', async () => {
    await seedJob('j1')
    // 两条 pending_review 候选属同一项目（sourceCwd=/p1），一条 candidate 不应返回
    await createCandidate(db, {
      scopeType: 'project', scopeId: '/p1', title: 't1', bodyMd: 'b', tags: [],
      sourceKind: 'conversation', runtime: 'claude-code', sourceCwd: '/p1',
      distillJobId: 'j1',
    })
    const c2 = await createCandidate(db, {
      scopeType: 'project', scopeId: '/p1', title: 't2', bodyMd: 'b', tags: [],
      sourceKind: 'conversation', runtime: 'claude-code', sourceCwd: '/p1',
      distillJobId: 'j1',
    })
    await createCandidate(db, {
      scopeType: 'project', scopeId: '/p2', title: 't3', bodyMd: 'b', tags: [],
      sourceKind: 'conversation', runtime: 'claude-code', sourceCwd: '/p2',
      distillJobId: 'j1',
    })
    // 直接把 c2 标 pending_review（模拟 judge 暂停期间标记）
    await db.update(memories).set({ status: 'pending_review' })
      .where(eq(memories.id, c2.id)).run()
    const list = await listPendingReviewCandidates(db, { projectId: '/p1' })
    expect(list.map((m) => m.title)).toEqual(['t2'])
    // status 运行时为 'pending_review'（MemoryStatus 类型不含该值，属 Task 9 UI/API 白名单范畴）
    expect(list[0]!.status as string).toBe('pending_review')
  })

  test('promotePendingReviewToCandidate 把 pending_review→candidate', async () => {
    await seedJob('j1')
    const c = await createCandidate(db, {
      scopeType: 'project', scopeId: '/p1', title: 't', bodyMd: 'b', tags: [],
      sourceKind: 'conversation', runtime: 'claude-code', sourceCwd: '/p1',
      distillJobId: 'j1',
    })
    await db.update(memories).set({ status: 'pending_review' })
      .where(eq(memories.id, c.id)).run()
    await promotePendingReviewToCandidate(db, c.id)
    const list = await listPendingReviewCandidates(db, { projectId: '/p1' })
    expect(list).toHaveLength(0)
  })
})
