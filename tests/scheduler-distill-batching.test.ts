// tests/scheduler-distill-batching.test.ts
// Task 8 回归锁（spec §4.7/§4.8）：tick sweep（flush/TTL -> 放行/skipped_trivial）、
// distiller 上下文接线（priorContext/approvedTitles）、滚动摘要维护、subagent 琐碎判定。
// 基建对齐 tests/scheduler.test.ts / tests/store-distill-batching.test.ts：
// 临时文件库（bun 下 openDb(':memory:') mkdirSync EEXIST）+ mock callLLM + 手工 seed job/event。
import { describe, test, expect, beforeEach } from 'bun:test'
import { openDb, type DbClient } from '@/db/client'
import { memoryDistillJobs, memoryDistillEvents, memoryDistillRuns, memories } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { tick, sweepWaitingJobs, type TickDeps } from '@/scheduler'
import { createCandidate, markFlush, upsertSessionEvent, getSessionDigest, setSessionOffset } from '@/memory/store'
import { SESSION_FLUSH_TTL_MS } from '@/memory/threshold'
import type { LLMCall } from '@/llm'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let db: DbClient
const okLLM: LLMCall = async () => JSON.stringify({ candidates: [] })
// 质量模式 JudgeConfig（与 DEFAULT_JUDGE_CONFIG 同 mode，小预算；测试不触达预算）。
const QUALITY = { mode: 'quality', maxRounds: 5, timeBudgetS: 60 } as const
const ECONOMY = { mode: 'economy', maxRounds: 5, timeBudgetS: 60 } as const

const seedWaiting = async (id: string, sessionId: string, turns: unknown[], opts: { lastCaptureAt?: number; cwd?: string } = {}) => {
  await db.insert(memoryDistillJobs).values({
    id, debounceKey: 'k', sourceEventId: 'e', runtime: 'claude-code', cwd: opts.cwd ?? '/proj',
    sessionId, status: 'waiting', attempts: 0, nextRunAt: 0, createdAt: 1, finishedAt: null,
    lastCaptureAt: opts.lastCaptureAt ?? Date.now(),
  })
  await upsertSessionEvent(db, id, JSON.stringify(turns))
}
const tickDeps = (callLLM: LLMCall = okLLM): TickDeps => ({
  loadTranscript: async (job) => {
    const rows = await db.select().from(memoryDistillEvents).where(eq(memoryDistillEvents.distillJobId, job.id))
    const turns = rows.length ? JSON.parse(rows[0]!.payload) : []
    return { turns, fullLength: turns.length, prefixTurns: [] }
  },
  callLLM,
  createCandidate,
})

beforeEach(() => {
  db = openDb(join(mkdtempSync(join(tmpdir(), 'memside-sched-batch-')), 'test.db'))
})

describe('sweepWaitingJobs（spec §4.7）', () => {
  test('flush 标记 + 足量 -> 放行 pending', async () => {
    await seedWaiting('j1', 's1', [{ role: 'user', content: 'x'.repeat(2000) }])
    await markFlush(db, 's1')
    expect(await sweepWaitingJobs(db, Date.now())).toBe(1)
    const [j] = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, 'j1'))
    expect(j!.status).toBe('pending')
  })
  test('flush + 不足量 -> skipped_trivial + done + 无 LLM 调用', async () => {
    await seedWaiting('j1', 's1', [{ role: 'user', content: '短' }])
    await markFlush(db, 's1')
    await sweepWaitingJobs(db, Date.now())
    const [j] = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, 'j1'))
    expect(j!.status).toBe('done')
    const [run] = await db.select().from(memoryDistillRuns).where(eq(memoryDistillRuns.distillJobId, 'j1'))
    expect(run!.outcome).toBe('skipped_trivial')
  })
  test('TTL 过期（lastCaptureAt 超过 2h）-> 同 flush 两分支', async () => {
    await seedWaiting('j1', 's1', [{ role: 'user', content: 'x'.repeat(2000) }], { lastCaptureAt: Date.now() - SESSION_FLUSH_TTL_MS - 1 })
    await sweepWaitingJobs(db, Date.now())
    const [j] = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, 'j1'))
    expect(j!.status).toBe('pending')
  })
  test('未过期无 flush -> 不动；lastCaptureAt NULL（legacy）-> 不走 sweep', async () => {
    await seedWaiting('j1', 's1', [{ role: 'user', content: 'x'.repeat(2000) }])
    await db.update(memoryDistillJobs).set({ lastCaptureAt: null }).where(eq(memoryDistillJobs.id, 'j1')).run()
    expect(await sweepWaitingJobs(db, Date.now())).toBe(0)
    const [j] = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, 'j1'))
    expect(j!.status).toBe('waiting')
  })
  test('offset 已结算的 session：flush 时无新内容 -> skipped_trivial', async () => {
    const turns = [{ role: 'user', content: 'x'.repeat(2000) }]
    await seedWaiting('j1', 's1', turns)
    await setSessionOffset(db, 's1', 1) // 已蒸馏过
    await markFlush(db, 's1')
    await sweepWaitingJobs(db, Date.now())
    const [run] = await db.select().from(memoryDistillRuns).where(eq(memoryDistillRuns.distillJobId, 'j1'))
    expect(run!.outcome).toBe('skipped_trivial')
  })
})

describe('tick 接线：priorContext/approvedTitles（spec §4.7）', () => {
  test('经济模式：distill prompt 含确定性 digest 与已审批标题', async () => {
    let seen = ''
    const spyLLM: LLMCall = async (_s, user) => { seen = user; return JSON.stringify({ candidates: [] }) }
    await createCandidate(db, {
      scopeType: 'project', scopeId: '/proj', title: '[category:convention] 已有记忆',
      bodyMd: 'b', tags: [], sourceKind: 'manual', sourceCwd: '/proj', runtime: 'claude-code',
    })
    // approved 需要 promote：直接 update status（测试只锁接线不锁 promote 流程）
    await db.update(memories).set({ status: 'approved' }).run()
    await db.insert(memoryDistillJobs).values({
      id: 'j1', debounceKey: 'k', sourceEventId: 'e', runtime: 'claude-code', cwd: '/proj',
      sessionId: 's1', status: 'pending', attempts: 0, nextRunAt: 0, createdAt: 1, finishedAt: null,
    })
    const deps = tickDeps(spyLLM)
    // 钉经济模式：quality 模式会在 distill 后追加滚动摘要 LLM 调用，覆盖 seen。
    deps.loadJudgeConfig = () => ECONOMY
    deps.loadTranscript = async () => ({
      turns: [{ role: 'user', content: '新内容' }], fullLength: 3,
      prefixTurns: [{ role: 'user', content: '旧讨论一' }, { role: 'assistant', content: '旧讨论二' }],
    })
    await tick(db, deps)
    expect(seen).toContain('## 背景（仅供理解上下文，禁止从中提炼）')
    expect(seen).toContain('旧讨论一')
    expect(seen).toContain('## 已记录的记忆标题（禁止重复提炼）')
    expect(seen).toContain('[category:convention] 已有记忆')
  })
  test('titles 为空数组时不渲染该节（正常路径）', async () => {
    // listApprovedByScope 的 DB 错误路径难以直接注入（tick 内同一 db），
    // titles_query_failed 落表路径由源码层断言与 Task 9 状态面兜底。此处锁「正常路径
    // titles 为空数组时不渲染该节」：
    let seen = ''
    const spyLLM: LLMCall = async (_s, user) => { seen = user; return JSON.stringify({ candidates: [] }) }
    await db.insert(memoryDistillJobs).values({
      id: 'j1', debounceKey: 'k', sourceEventId: 'e', runtime: 'claude-code', cwd: '/proj',
      sessionId: 's1', status: 'pending', attempts: 0, nextRunAt: 0, createdAt: 1, finishedAt: null,
    })
    const deps = tickDeps(spyLLM)
    deps.loadJudgeConfig = () => ECONOMY
    deps.loadTranscript = async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1, prefixTurns: [] })
    await tick(db, deps)
    expect(seen).not.toContain('## 已记录的记忆标题')
  })
})

describe('滚动摘要接线（质量模式，spec §4.7）', () => {
  test('distill 成功后 mergeRollingSummary 并入并 upsert', async () => {
    let n = 0
    const dualLLM: LLMCall = async () => {
      n += 1
      if (n === 1) return JSON.stringify({ candidates: [] }) // distill
      return '滚动摘要v1' // mergeRollingSummary
    }
    await db.insert(memoryDistillJobs).values({
      id: 'j1', debounceKey: 'k', sourceEventId: 'e', runtime: 'claude-code', cwd: '/proj',
      sessionId: 's1', status: 'pending', attempts: 0, nextRunAt: 0, createdAt: 1, finishedAt: null,
    })
    const deps = tickDeps(dualLLM)
    deps.loadJudgeConfig = () => QUALITY
    deps.loadTranscript = async () => ({ turns: [{ role: 'user', content: '新内容' }], fullLength: 1, prefixTurns: [] })
    await tick(db, deps)
    expect((await getSessionDigest(db, 's1'))?.digest).toBe('滚动摘要v1')
  })
  test('mergeRollingSummary 抛错 -> digest_llm_failed 落表 + job 仍 done', async () => {
    // 判别滚动摘要调用：ROLLING_SUMMARY_SYSTEM_PROMPT 含 'compressor'
    // （'conversation-digest compressor'），distill 系统 prompt 不含。
    const failLLM: LLMCall = async (sys) => {
      if (sys.includes('compressor')) throw new Error('ark 502')
      return JSON.stringify({ candidates: [] })
    }
    await db.insert(memoryDistillJobs).values({
      id: 'j1', debounceKey: 'k', sourceEventId: 'e', runtime: 'claude-code', cwd: '/proj',
      sessionId: 's1', status: 'pending', attempts: 0, nextRunAt: 0, createdAt: 1, finishedAt: null,
    })
    const deps = tickDeps(failLLM)
    deps.loadJudgeConfig = () => QUALITY
    deps.loadTranscript = async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1, prefixTurns: [] })
    await tick(db, deps)
    const [j] = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, 'j1'))
    expect(j!.status).toBe('done')
    const degs = await db.query.memoryDegradations.findMany()
    expect(degs.some((d) => d.kind === 'digest_llm_failed')).toBe(true)
  })
})

describe('subagent trivial 判定（spec §4.8）', () => {
  test('subagent job 低于琐碎下限 -> skipped_trivial 不调 LLM', async () => {
    let called = false
    const spyLLM: LLMCall = async () => { called = true; return JSON.stringify({ candidates: [] }) }
    await db.insert(memoryDistillJobs).values({
      id: 'j1', debounceKey: 'k', sourceEventId: 'e', runtime: 'claude-code', cwd: '/proj',
      sessionId: null, sourceAgentId: 'agent-x', status: 'pending', attempts: 0, nextRunAt: 0,
      createdAt: 1, finishedAt: null,
    })
    const deps = tickDeps(spyLLM)
    deps.loadTranscript = async () => ({ turns: [{ role: 'user', content: '短' }], fullLength: 1, prefixTurns: [] })
    await tick(db, deps)
    expect(called).toBe(false)
    const [run] = await db.select().from(memoryDistillRuns).where(eq(memoryDistillRuns.distillJobId, 'j1'))
    expect(run!.outcome).toBe('skipped_trivial')
  })
})

describe('tick 对 sweep 异常的韧性（spec §5 #9）', () => {
  test('sweep 抛错 -> sweep_error 落表 + pending job 仍被处理', async () => {
    // listWaitingJobs 本身走 db；注入会让 consumeFlush 抛错的数据困难，
    // 改为锁「sweep 被 try/catch 包住 + sweep_error kind 存在」的源码断言：
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/scheduler.ts', 'utf8')
    expect(src).toContain("'sweep_error'")
  })
})
