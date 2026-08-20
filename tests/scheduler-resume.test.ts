// 锁 spec 2026-08-18 §5/§8.5：断点续跑（失败不重算前步）、offset 仅四步全成
// 推进（失败/暂停不动）。修用户最初"内容永久跳过"的 bug（失败也推 offset + 无条件标 done）。
// Task 7（scheduler 断点续跑接线）：一次 tick 只推进当前步骤的一轮 LLM 对话（§5.4
// 锁定决断——成功同 tick 续下一步，失败回 pending + 退避，3 次失败暂停 + 通知）。
import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { enqueueDistillJob, tick } from '@/scheduler'
import { createCandidate, getSessionOffset, getJobCheckpoint, getSourceInput, listLlmRounds } from '@/memory/store'
import { memoryDistillJobs, memories, notifications } from '@/db/schema'

// 钉经济模式：单发 judgeValue 可控（quality 默认走 agent 判定器）；digest 阶段
// 经济模式自动成功（无滚动摘要调用），四步链路聚焦在 distill/dedup/judge。
const ECONOMY = { mode: 'economy', maxRounds: 30, timeBudgetS: 300 } as const

// 与 tests/scheduler.test.ts 同款 harness：每用例独立子目录，避免 Windows EBUSY。
const root = join(import.meta.dir, '.tmp-sched-resume')
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

async function seedDueJob(sessionId?: string): Promise<string> {
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0,
    sessionId,
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  return jobId
}

/** 步骤失败回 pending 后 nextRunAt 带退避（30s 起），测试手动重置到期。 */
async function forceDue(jobId: string) {
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
}

const loadTranscript = async (content = 'x') =>
  ({ turns: [{ role: 'user' as const, content }], fullLength: 3, prefixTurns: [] as never[] })

const fakeCreate = async () => ({ id: 'c1', status: 'candidate', version: 1 } as never)

test('distill 失败 → job 回 pending 不标 done，offset 不推进，stepAttempts=1', async () => {
  const jobId = await seedDueJob('s-res1')
  await tick(db, {
    loadTranscript: () => loadTranscript(),
    callLLM: async () => { throw new Error('the operation was aborted') },
    createCandidate: fakeCreate as never,
    loadJudgeConfig: () => ECONOMY,
  })
  const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(rows[0]!.status).toBe('pending')       // 非 done：失败不消费 job
  expect(rows[0]!.currentStep).toBe('distill')  // 断点停在 distill
  expect(rows[0]!.stepAttempts).toBe(1)         // 第 1 次失败
  expect(rows[0]!.lastError).toBeTruthy()
  expect(rows[0]!.finishedAt).toBeNull()
  // offset 未动（P5：仅四步全成推进）
  expect(await getSessionOffset(db, 's-res1')).toBe(0)
  // 对话历史留底：1 轮失败（aborted），重试将带历史接续
  const rounds = await listLlmRounds(db, jobId, 'distill')
  expect(rounds).toHaveLength(1)
  expect(rounds[0]!.result.ok).toBe(false)
  if (!rounds[0]!.result.ok) expect(rounds[0]!.result.reason).toBe('aborted')
})

test('distill 成功 → 推进到 dedup；第二次 tick 不重算 distill 的 LLM', async () => {
  const jobId = await seedDueJob('s-res2')
  let distillCalls = 0
  let dedupCalls = 0
  const callLLM = async (sys: string) => {
    if (sys.includes('memside-distiller')) {
      distillCalls++
      // 2 候选 → dedup 必调 LLM（兄弟比较），tick1 让 dedup 失败、tick2 让它成功
      return JSON.stringify({
        candidates: [
          { title: '[category:x] cand-a', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' },
          { title: '[category:x] cand-b', bodyMd: 'b2', scope: 'project', runtime: null, distillAction: 'new' },
        ],
      })
    }
    if (sys.includes('memside-consolidate')) {
      dedupCalls++
      if (dedupCalls <= 1) throw new Error('dedup api down')  // tick1：dedup 失败（单 tick 单轮）
      return JSON.stringify({ groups: [{ action: 'keep', members: ['new-0'] }, { action: 'keep', members: ['new-1'] }] })
    }
    return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }, { index: 1, category: 'decision' }] })
  }
  let createCalls = 0
  const create = async (_db: unknown, _input: unknown) => {
    createCalls++
    return { id: `c${createCalls}`, status: 'candidate', version: 1 } as never
  }
  await tick(db, { loadTranscript: () => loadTranscript(), callLLM, createCandidate: create, loadJudgeConfig: () => ECONOMY })
  // tick1：distill 成功、dedup 失败 → 断点=dedup，回 pending
  expect(distillCalls).toBe(1)
  const mid = getJobCheckpoint(db, jobId)
  expect(mid.currentStep).toBe('dedup')
  expect(mid.stepAttempts).toBe(1)
  const midRows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(midRows[0]!.status).toBe('pending')
  // 干净结果落库：dedup 恢复不需要重跑 distill 的 LLM
  await forceDue(jobId)
  await tick(db, { loadTranscript: () => loadTranscript(), callLLM, createCandidate: create, loadJudgeConfig: () => ECONOMY })
  expect(distillCalls).toBe(1)  // 核心：不重算 distill
  expect(createCalls).toBe(2)   // 两候选经 dedup/judge 后入库
  const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(rows[0]!.status).toBe('done')
  expect(rows[0]!.finishedAt).not.toBeNull()
})

test('judge 3 次失败 → job paused + 一条通知 + 候选 pending_review 不进审批队列', async () => {
  const jobId = await seedDueJob('s-res3')
  const callLLM = async (sys: string) => {
    if (sys.includes('memside-distiller')) {
      return JSON.stringify({
        candidates: [{ title: '[category:x] one', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }],
      })
    }
    throw new Error('judge api down')  // 1 候选 → dedup 短路；judge 每轮都失败
  }
  for (let i = 0; i < 3; i++) {
    await tick(db, { loadTranscript: () => loadTranscript(), callLLM, createCandidate: createCandidate as never, loadJudgeConfig: () => ECONOMY })
    if (i < 2) await forceDue(jobId)
  }
  const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(rows[0]!.status).toBe('paused')       // 3 次失败暂停等人处置（非 failed 丢弃）
  expect(rows[0]!.stepError).toBe('judge')     // 暂停位置标记
  expect(rows[0]!.finishedAt).toBeNull()
  // 汇总通知：一条任务级 llm_error，refId=jobId
  const notifs = await db.select().from(notifications).where(eq(notifications.refId, jobId))
  expect(notifs.filter((n) => n.kind === 'llm_error')).toHaveLength(1)
  // 候选标 pending_review：不丢（未进 discards）、不进审批队列（非 candidate）
  const cands = await db.select().from(memories).where(eq(memories.distillJobId, jobId))
  expect(cands).toHaveLength(1)
  expect(cands[0]!.status).toBe('pending_review')
  // offset 不推进
  expect(await getSessionOffset(db, 's-res3')).toBe(0)
})

test('四步全成功 → offset 推进 + job done + 候选入库', async () => {
  const jobId = await seedDueJob('s-ok')
  await tick(db, {
    loadTranscript: () => loadTranscript('refund within 14 days'),
    callLLM: async (sys: string) => {
      if (sys.includes('memside-distiller')) {
        return JSON.stringify({
          candidates: [{ title: '[category:invariant] refund 14d', bodyMd: '14 days', scope: 'project', runtime: null, distillAction: 'new' }],
        })
      }
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    },
    createCandidate: createCandidate as never,
    loadJudgeConfig: () => ECONOMY,
  })
  const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(rows[0]!.status).toBe('done')
  expect(rows[0]!.finishedAt).not.toBeNull()
  // offset 仅在四步全成时推进（P5）
  expect(await getSessionOffset(db, 's-ok')).toBe(3)
  const cands = await db.select().from(memories).where(eq(memories.distillJobId, jobId))
  expect(cands).toHaveLength(1)
  expect(cands[0]!.status).toBe('candidate')
  expect(cands[0]!.valueClass).toBe('decision')
})

test('judge 暂停后用户重试 → judge 成功 → pending_review 占位行退役，候选正式入队', async () => {
  const jobId = await seedDueJob('s-res4')
  let judgeBroken = true
  const callLLM = async (sys: string) => {
    if (sys.includes('memside-distiller')) {
      return JSON.stringify({
        candidates: [{ title: '[category:x] retry-me', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }],
      })
    }
    if (judgeBroken) throw new Error('judge api down')
    return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
  }
  // 3 tick → judge 暂停 + 候选 pending_review
  for (let i = 0; i < 3; i++) {
    await tick(db, { loadTranscript: () => loadTranscript(), callLLM, createCandidate: createCandidate as never, loadJudgeConfig: () => ECONOMY })
    if (i < 2) await forceDue(jobId)
  }
  let cands = await db.select().from(memories).where(eq(memories.distillJobId, jobId))
  expect(cands).toHaveLength(1)
  expect(cands[0]!.status).toBe('pending_review')
  // 用户经 UI 点「重试」（Task 9 路由 → resetJobForRetry）：stepAttempts 清零回 pending
  const { resetJobForRetry } = await import('@/memory/store')
  await resetJobForRetry(db, jobId)
  judgeBroken = false
  await tick(db, { loadTranscript: () => loadTranscript(), callLLM, createCandidate: createCandidate as never, loadJudgeConfig: () => ECONOMY })
  // judge 成功：占位 pending_review 退役，重判后的候选正式入队（spec §6.4）
  cands = await db.select().from(memories).where(eq(memories.distillJobId, jobId))
  expect(cands).toHaveLength(1)
  expect(cands[0]!.status).toBe('candidate')
  expect(cands[0]!.valueClass).toBe('decision')
  const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(rows[0]!.status).toBe('done')
  expect(await getSessionOffset(db, 's-res4')).toBe(3)
})

test('带记忆接续：distill 第 1 轮中断，第 2 轮追问带历史接续并全程完成', async () => {
  const jobId = await seedDueJob('s-retry')
  let llmCallCount = 0
  let capturedDistillUser = ''
  const callLLM = async (sys: string, user: string) => {
    llmCallCount++
    if (sys.includes('memside-distiller')) {
      if (llmCallCount === 1) throw new Error('the operation was aborted')
      capturedDistillUser = user  // tick2 的续跑请求
      return JSON.stringify({
        candidates: [{ title: '[category:x] resumed', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }],
      })
    }
    return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
  }
  await tick(db, { loadTranscript: () => loadTranscript(), callLLM, createCandidate: fakeCreate as never, loadJudgeConfig: () => ECONOMY })
  // tick1：一轮即失败（单 tick 单轮），回 pending
  const after1 = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(after1[0]!.status).toBe('pending')
  expect(after1[0]!.stepAttempts).toBe(1)
  await forceDue(jobId)
  await tick(db, { loadTranscript: () => loadTranscript(), callLLM, createCandidate: fakeCreate as never, loadJudgeConfig: () => ECONOMY })
  // tick2：distill 第 2 轮请求带追问（P2：接着做，不是重做）
  expect(capturedDistillUser).toMatch(/中断|重新输出/)
  const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(rows[0]!.status).toBe('done')
  expect(await getSessionOffset(db, 's-retry')).toBe(3)
})

// final-fix-1（judge 双重入库窗口）：judge 成功后若在 createCandidate 循环与
// setJobCheckpoint('digest') 之间崩溃 → job 回 pending → 下 tick judge 的 loadHistory
// 末轮-ok 路径零 LLM 调用复放同一裁决（llmSession.ts:46-51）→ 再次 createCandidate →
// 重复候选行。修复：插入新裁决前先 deleteCandidatesForJob 清掉旧 candidate 行。
test('final-fix-1: judge 成功后崩溃于 checkpoint 前 → 重跑不产生重复候选行', async () => {
  const jobId = await seedDueJob('s-fix1')
  // 2 候选（不同标题，dedup 不合并），judge 全 keep
  const callLLM = async (sys: string) => {
    if (sys.includes('memside-distiller')) {
      return JSON.stringify({
        candidates: [
          { title: '[category:x] keep-a', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' },
          { title: '[category:x] keep-b', bodyMd: 'b2', scope: 'project', runtime: null, distillAction: 'new' },
        ],
      })
    }
    if (sys.includes('memside-consolidate')) {
      return JSON.stringify({ groups: [{ action: 'keep', members: ['new-0'] }, { action: 'keep', members: ['new-1'] }] })
    }
    return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }, { index: 1, category: 'decision' }] })
  }
  // tick1：第 1 个 createCandidate 真实入库后，第 2 个抛错——模拟 createCandidate
  // 循环中 DB 故障（窗口：第一个 createCandidate 与 setJobCheckpoint('digest') 之间）。
  let createCalls = 0
  let tick1Crashed = false
  const createCrashOn2nd = async (_db: unknown, input: unknown) => {
    createCalls++
    if (createCalls === 2 && !tick1Crashed) {
      tick1Crashed = true
      throw new Error('simulate DB crash mid-create')
    }
    return createCandidate(db, input as never)
  }
  await tick(db, { loadTranscript: () => loadTranscript(), callLLM, createCandidate: createCrashOn2nd as never, loadJudgeConfig: () => ECONOMY })
  // tick1 崩溃 → 外层 catch → job 回 pending（非 done）
  const after1 = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(after1[0]!.status).toBe('pending')
  // 1 个候选已入库（第 1 个成功后第 2 个抛错）
  const candsAfter1 = await db.select().from(memories).where(eq(memories.distillJobId, jobId))
  expect(candsAfter1).toHaveLength(1)
  // tick2：重跑。judge loadHistory 末轮-ok 复放（零 LLM 调用）→ deleteCandidatesForJob
  // 清掉旧 candidate → 重新插入 2 个。无重复（未修会是 1 旧 + 2 新 = 3）。
  await forceDue(jobId)
  await tick(db, { loadTranscript: () => loadTranscript(), callLLM, createCandidate: createCandidate as never, loadJudgeConfig: () => ECONOMY })
  const cands = await db.select().from(memories).where(eq(memories.distillJobId, jobId))
  expect(cands).toHaveLength(2)  // 核心：无重复候选行
  expect(cands.every((c) => c.status === 'candidate')).toBe(true)
  const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(rows[0]!.status).toBe('done')
  expect(await getSessionOffset(db, 's-fix1')).toBe(3)
})

test('distill 3 次失败暂停: 存 source-input 快照（之前 distill 暂停无快照是黑盒）', async () => {
  const jobId = await seedDueJob('s-res-distill-pause')
  // distill 每轮都抛 abort -> 3 次暂停
  const callLLM = async () => { throw new Error('the operation was aborted') }
  for (let i = 0; i < 3; i++) {
    await tick(db, { loadTranscript: () => loadTranscript('some real input content'), callLLM, createCandidate: fakeCreate as never, loadJudgeConfig: () => ECONOMY })
    if (i < 2) await forceDue(jobId)
  }
  const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(rows[0]!.status).toBe('paused')
  expect(rows[0]!.stepError).toBe('distill')
  // 核心：distill 暂停也存了输入快照（spec §3.3(a)）
  const snap = await getSourceInput(db, jobId)
  expect(snap).not.toBeNull()
  expect(snap!.turnCount).toBeGreaterThan(0)
})
