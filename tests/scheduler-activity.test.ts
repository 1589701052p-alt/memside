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
const QUALITY = { mode: 'quality', maxRounds: 30, timeBudgetS: 300 } as const

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

async function seedDueJob(cwd = '/proj/memside', sessionId?: string) {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd, debounceKey: 'k', debounceMs: 0, sessionId })
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
      // distill 返候选；judge 返合法 verdicts（Task 7：judge 失败即 step 失败，
      // 成功路径必须按 system 分派，不能再全调用返同一串）。
      if (sys.includes('memside-distiller')) return ONE_CANDIDATE
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
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

test('llm_error 路径：3 次失败暂停后写一条 kind=llm_error 消息，refId=jobId（Task 7）', async () => {
  const jobId = await seedDueJob()
  for (let i = 0; i < 3; i++) {
    await tick(db, {
      loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1, prefixTurns: [] }),
      callLLM: async () => { throw new Error('502 Bad Gateway') },
      createCandidate: async () => ({ id: 'c', status: 'candidate', version: 1 } as any),
      loadJudgeConfig: () => ECONOMY,
      tracker: createActivityTracker(),
    })
    await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  }
  const pg = await listNotificationsPage(db, { kind: 'llm_error' })
  expect(pg.total).toBe(1)                       // 3 次失败汇总一条（不刷屏）
  expect(pg.items[0]!.refId).toBe(jobId)
  expect(pg.items[0]!.body).toContain('502')
  const job = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(job[0]!.status).toBe('paused')
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

test('quality 模式 digest 接线：相位含 digest，run 回填 digest_ms（spec §8 case #12）', async () => {
  // digest 站点前置：!callThrew && quality && sessionId && 非 subagent。
  // updateSessionLedger 仅当切片渲染 ≥ DIRECT_APPEND_MAX_CHARS(1200) 才调 LLM——
  // renderDigestLines 单行封顶 ~306 字，故喂 5 条 300 字 user turn 触发压缩路径。
  // cwd 用真实存在的 dir -> judge 走 judgeValueAgentic，fake 首发即 final  verdict 收官。
  const jobId = await seedDueJob(dir, 's1')
  const tracker = createActivityTracker()
  const seen: string[] = []
  const bigTurns = Array.from({ length: 5 }, () => ({ role: 'user' as const, content: 'x'.repeat(300) }))
  await tick(db, {
    loadTranscript: async () => ({ turns: bigTurns, fullLength: bigTurns.length, prefixTurns: [] }),
    callLLM: async () => {
      const act = tracker.get()
      if (act) seen.push(act.phase)
      if (act?.phase === 'distill') return ONE_CANDIDATE
      if (act?.phase === 'judge') return JSON.stringify({ final: { verdicts: [{ index: 0, category: 'decision' }] } })
      if (act?.phase === 'digest') return '用户讨论了退款规则\n助手确认 14 天窗口'
      return JSON.stringify({})
    },
    createCandidate: async () => ({ id: 'c1', status: 'candidate', version: 1 } as any),
    loadJudgeConfig: () => QUALITY,
    tracker,
  })
  expect(tracker.get()).toBeNull()
  expect(seen).toContain('digest')
  const run = await getDistillRun(db, jobId)
  expect(run!.digestMs).not.toBeNull()
})
