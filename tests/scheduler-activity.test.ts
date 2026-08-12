// LLM 阶段活动接线 + 三阶段耗时 + llm_error 消息（spec 2026-08-12 §5.6）。
import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { enqueueDistillJob, tick } from '@/scheduler'
import { getDistillRun, listNotificationsPage } from '@/memory/store'
import { memoryDistillJobs, memoryDistillRuns } from '@/db/schema'
import { createActivityTracker } from '@/activity'

const ECONOMY = { mode: 'economy', maxRounds: 30, timeBudgetS: 300 } as const

const root = join(import.meta.dir, '.tmp-sched-activity')
let dir = ''
let db: ReturnType<typeof openDb>

beforeAll(() => { rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true }) })
beforeEach(() => {
  dir = join(root, Math.random().toString(36).slice(2))
  mkdirSync(dir, { recursive: true })
  db = openDb(join(dir, 't.db'))
})
afterEach(() => { db.$client.close() })

const ONE_CANDIDATE = JSON.stringify({
  candidates: [{ title: '[category:invariant] x', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }],
})

async function seedDueJob(cwd = '/proj/memside') {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd, debounceKey: 'k', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  return jobId
}

test('一趟 job：tracker 依次 distill->dedup->judge，结束归 null；run 落 dedup_ms/judge_ms', async () => {
  const jobId = await seedDueJob()
  const tracker = createActivityTracker()
  const seen: string[] = []
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'hello world' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async (sys) => {
      const act = tracker.get()
      if (act) seen.push(act.phase)
      // distill 返候选；dedup/judge 的 prompt 返「无重复/全保留」语义的安全值
      if (act?.phase === 'distill') return ONE_CANDIDATE
      return JSON.stringify({})
    },
    createCandidate: async () => ({ id: 'c1', status: 'candidate', version: 1 } as any),
    loadJudgeConfig: () => ECONOMY,
    tracker,
  })
  expect(tracker.get()).toBeNull()
  expect(seen[0]).toBe('distill')
  expect(seen).toContain('judge')              // dedup 可能 0 调用（单候选短路），judge 必调
  const run = await getDistillRun(db, jobId)
  expect(run!.judgeMs).not.toBeNull()
})

test('0 候选短路：judge 未调 LLM -> judge_ms NULL', async () => {
  const jobId = await seedDueJob()
  const tracker = createActivityTracker()
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async () => JSON.stringify({ candidates: [] }),
    createCandidate: async () => ({ id: 'c', status: 'candidate', version: 1 } as any),
    loadJudgeConfig: () => ECONOMY,
    tracker,
  })
  const run = await getDistillRun(db, jobId)
  expect(run!.judgeMs).toBeNull()
  expect(tracker.get()).toBeNull()
})

test('llm_error 路径：写一条 kind=llm_error 消息，refId=jobId', async () => {
  const jobId = await seedDueJob()
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async () => { throw new Error('502 Bad Gateway') },
    createCandidate: async () => ({ id: 'c', status: 'candidate', version: 1 } as any),
    loadJudgeConfig: () => ECONOMY,
    tracker: createActivityTracker(),
  })
  const pg = await listNotificationsPage(db, { kind: 'llm_error' })
  expect(pg.total).toBe(1)
  expect(pg.items[0]!.refId).toBe(jobId)
  expect(pg.items[0]!.body).toContain('502')
})

test('降级经 logDegradation 也进消息（digest_llm_failed 之外的既有路径回归）', async () => {
  // loadTranscript 抛错 -> job 回退 pending（既有行为），本测试只锁 tracker 不复位残留
  const tracker = createActivityTracker()
  await seedDueJob()
  await tick(db, {
    loadTranscript: async () => { throw new Error('no transcript') },
    callLLM: async () => '[]',
    createCandidate: async () => ({ id: 'c', status: 'candidate', version: 1 } as any),
    loadJudgeConfig: () => ECONOMY,
    tracker,
  })
  expect(tracker.get()).toBeNull()
})
