// 回归防护:模式开关必须选对执行者;缺配置默认质量;agent 故障不得让 job 失败(全保留);
// 项目目录已删除时质量模式必须降级经济模式,绝不让 agent 工具拿到盘根沙箱
// (fix round 1:makeRepoTools('/') 会把 grep/read/list 放宽到整个文件系统)。
// spec: docs/superpowers/specs/2026-08-06-agentic-value-judge-design.md §4.6/§6/失败矩阵
// mock LLM 按 system prompt 内容分派(distill/dedup/单发 judge/agent judge),
// 不按调用顺序——judgeDuplicates 是否消耗调用取决于库里有没有 existing,按序脚本太脆。
import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join, parse as parsePath } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { enqueueDistillJob, tick } from '@/scheduler'
import { memoryDistillJobs, memoryDistillRuns } from '@/db/schema'

// 与 tests/scheduler.test.ts 同款 harness:每用例独立子目录,避免 Windows EBUSY。
const root = join(import.meta.dir, '.tmp-sched-dispatch')
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

const DISTILL_ONE = JSON.stringify({
  candidates: [{ title: '[category:trap] token 掩码只留前6后4', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }],
})
const AGENT_PROTOCOL_LINE = '每轮必须且只能输出一个 JSON 对象'
const SINGLE_SHOT_OUTPUT_LINE = 'Emit one verdict per candidate, keyed by index.'

async function seedDueJob(cwd = '/r'): Promise<string> {
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd, debounceKey: 'k1', debounceMs: 0,
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  return jobId
}

test('缺 loadJudgeConfig -> 默认质量模式(agent 路径,候选以 trap 入库)', async () => {
  // cwd 必须真实存在:fix round 1 起 rootDir 缺失会降级经济模式(spec 失败矩阵),
  // 要走到 agent 路径就得给一个 existsSync 为真的目录。
  const jobId = await seedDueJob(dir)
  let captured: any = null
  const judgeSystems: string[] = []
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'token mask keeps first6 last4' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async (system) => {
      if (system.includes('memside-distiller')) return DISTILL_ONE
      if (system.includes('memside-dedup')) return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] })
      judgeSystems.push(system)
      // agent 首轮即 final:判 trap
      return '{"final": {"verdicts": [{"index": 0, "category": "trap"}]}}'
    },
    createCandidate: async (_db, input) => { captured = input; return { id: 'c1', status: 'candidate', version: 1 } as any },
    // 不传 loadJudgeConfig -> DEFAULT_JUDGE_CONFIG(quality)
  })
  expect(captured).not.toBeNull()
  expect(captured.valueClass).toBe('trap')
  // 走的是 agent 判定器:judge 调用 system 含 agent 协议行,不含单发输出行
  expect(judgeSystems.length).toBeGreaterThan(0)
  expect(judgeSystems[0]).toContain(AGENT_PROTOCOL_LINE)
  expect(judgeSystems[0]).not.toContain(SINGLE_SHOT_OUTPUT_LINE)
  // trace 落盘:rawOutput 保留 .candidates 键,加 agentTrace 键(形状向后兼容)
  const runs = await db.select().from(memoryDistillRuns).where(eq(memoryDistillRuns.distillJobId, jobId))
  const raw = JSON.parse(runs[0]!.rawOutputJson!) as Record<string, unknown>
  expect(Array.isArray(raw.candidates)).toBe(true)
  expect(Array.isArray(raw.agentTrace)).toBe(true)
  const jobs = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(jobs[0]!.status).toBe('done')
})

test('mode=economy -> 走单发 judge(无 agent 协议段)', async () => {
  await seedDueJob()
  let captured: any = null
  const judgeSystems: string[] = []
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async (system) => {
      if (system.includes('memside-distiller')) return DISTILL_ONE
      if (system.includes('memside-dedup')) return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] })
      judgeSystems.push(system)
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    },
    createCandidate: async (_db, input) => { captured = input; return { id: 'c1', status: 'candidate', version: 1 } as any },
    loadJudgeConfig: () => ({ mode: 'economy', maxRounds: 30, timeBudgetS: 300 }),
  })
  expect(captured).not.toBeNull()
  expect(captured.valueClass).toBe('decision')
  // 单发 judge:system 含单发输出段,绝不含 agent 协议行
  expect(judgeSystems.length).toBeGreaterThan(0)
  expect(judgeSystems[0]).toContain(SINGLE_SHOT_OUTPUT_LINE)
  expect(judgeSystems[0]).not.toContain(AGENT_PROTOCOL_LINE)
})

test('质量模式 agent LLM 报错 -> 候选仍入库(全保留兜底),job done 非 failed', async () => {
  const jobId = await seedDueJob(dir)  // 真实存在的 cwd -> 走 agent 路径
  let createCalls = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async (system) => {
      if (system.includes('memside-distiller')) return DISTILL_ONE
      if (system.includes('memside-dedup')) return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] })
      throw new Error('agent judge api down')  // agent 判定器全程报错
    },
    createCandidate: async () => { createCalls++; return { id: 'c1', status: 'candidate', version: 1 } as any },
    loadJudgeConfig: () => ({ mode: 'quality', maxRounds: 30, timeBudgetS: 300 }),
  })
  expect(createCalls).toBe(1)  // 全保留兜底:候选照样入库(valueClass=null,人工审批兜底)
  const jobs = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(jobs[0]!.status).toBe('done')
})

test('质量模式 + job.cwd 目录不存在 -> 降级经济模式单发判定(不跑 agent,蒸馏记录注明降级)', async () => {
  // fix round 1 回归锁:job.cwd 被删(或从不存在)时,若让 agent 带 makeRepoTools('/')
  // 跑,工具沙箱就放宽到盘根,LLM 可读任意文件。spec 失败矩阵:该批降级经济模式。
  // 断言:judge 调用走单发(含单发输出段、不含 agent 协议行),候选照常入库,
  // run 记录 rawOutput 带 judgeFallback='economy:no-root-dir'。
  const jobId = await seedDueJob(join(dir, 'deleted-project-dir'))  // 不存在
  let captured: any = null
  const judgeSystems: string[] = []
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async (system) => {
      if (system.includes('memside-distiller')) return DISTILL_ONE
      if (system.includes('memside-dedup')) return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] })
      judgeSystems.push(system)
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    },
    createCandidate: async (_db, input) => { captured = input; return { id: 'c1', status: 'candidate', version: 1 } as any },
    loadJudgeConfig: () => ({ mode: 'quality', maxRounds: 30, timeBudgetS: 300 }),
  })
  expect(captured).not.toBeNull()
  expect(captured.valueClass).toBe('decision')
  // 降级经济模式:单发 judge,绝非 agent(无协议行 = 无工具循环)
  expect(judgeSystems.length).toBeGreaterThan(0)
  expect(judgeSystems[0]).toContain(SINGLE_SHOT_OUTPUT_LINE)
  expect(judgeSystems[0]).not.toContain(AGENT_PROTOCOL_LINE)
  // 蒸馏记录注明降级
  const runs = await db.select().from(memoryDistillRuns).where(eq(memoryDistillRuns.distillJobId, jobId))
  const raw = JSON.parse(runs[0]!.rawOutputJson!) as Record<string, unknown>
  expect(raw.judgeFallback).toBe('economy:no-root-dir')
  expect(Array.isArray(raw.candidates)).toBe(true)  // 既有键不动
  const jobs = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(jobs[0]!.status).toBe('done')
})

test('质量模式 + job.cwd 是文件系统根 -> 同样降级经济模式(盘根沙箱拒绝)', async () => {
  // 2026-08-06 final fix wave 回归锁:会话真在 '/' / 'C:\' 启动时,旧检查
  // existsSync('C:\\') 为真,agent 会拿 makeRepoTools(盘根) 跑,沙箱放宽到整个盘。
  // 断言:与「目录不存在」同款降级——单发 judge、judgeFallback 注明、候选照常入库。
  const fsRoot = parsePath(process.cwd()).root  // Windows: 'C:\';POSIX: '/'
  const jobId = await seedDueJob(fsRoot)
  let captured: any = null
  const judgeSystems: string[] = []
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async (system) => {
      if (system.includes('memside-distiller')) return DISTILL_ONE
      if (system.includes('memside-dedup')) return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] })
      judgeSystems.push(system)
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    },
    createCandidate: async (_db, input) => { captured = input; return { id: 'c1', status: 'candidate', version: 1 } as any },
    loadJudgeConfig: () => ({ mode: 'quality', maxRounds: 30, timeBudgetS: 300 }),
  })
  expect(captured).not.toBeNull()
  expect(captured.valueClass).toBe('decision')
  expect(judgeSystems.length).toBeGreaterThan(0)
  expect(judgeSystems[0]).toContain(SINGLE_SHOT_OUTPUT_LINE)
  expect(judgeSystems[0]).not.toContain(AGENT_PROTOCOL_LINE)
  const runs = await db.select().from(memoryDistillRuns).where(eq(memoryDistillRuns.distillJobId, jobId))
  const raw = JSON.parse(runs[0]!.rawOutputJson!) as Record<string, unknown>
  expect(raw.judgeFallback).toBe('economy:no-root-dir')
  const jobs = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(jobs[0]!.status).toBe('done')
})

test('judgeValueAgentic 纵深防御:rootDir=null 时工具为 stub,永不构造盘根沙箱', async () => {
  // fix round 1 配套锁:即使 agentJudge 被单独调用(绕过 scheduler 降级),
  // rootDir=null 下 LLM 请求工具也只拿到错误文本,读不到任何文件。
  const { judgeValueAgentic } = await import('@/memory/agentJudge')
  let calls = 0
  const callLLM = async () => {
    calls++
    if (calls === 1) return '{"tool": "read", "args": {"path": "src/scheduler.ts"}}'
    return '{"final": {"verdicts": [{"index": 0, "category": "trap"}]}}'
  }
  const { verdicts, trace } = await judgeValueAgentic(
    [{ title: 'T', bodyMd: 'b', scopeType: 'project', runtime: 'claude-code', distillAction: 'new', origin: 'agent-observed', evidence: null, subjectSlug: null }],
    { callLLM, rootDir: null, approvedTitles: [], sourceKind: 'conversation', maxRounds: 5, timeBudgetMs: 60_000 },
  )
  expect(verdicts[0]).toEqual({ index: 0, keep: true, valueClass: 'trap' })
  const toolSteps = trace.filter((s) => s.kind === 'tool')
  expect(toolSteps.length).toBe(1)
  expect(toolSteps[0]!.toolResult).toContain('工具不可用')
  expect(toolSteps[0]!.toolResult).not.toContain('judgeValue')  // 没读到真文件内容
})
