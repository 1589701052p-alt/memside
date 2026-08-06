// 回归防护:模式开关必须选对执行者;缺配置默认质量;agent 故障不得让 job 失败(全保留)。
// spec: docs/superpowers/specs/2026-08-06-agentic-value-judge-design.md §4.6/§6
// mock LLM 按 system prompt 内容分派(distill/dedup/单发 judge/agent judge),
// 不按调用顺序——judgeDuplicates 是否消耗调用取决于库里有没有 existing,按序脚本太脆。
import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
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

async function seedDueJob(): Promise<string> {
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0,
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  return jobId
}

test('缺 loadJudgeConfig -> 默认质量模式(agent 路径,候选以 trap 入库)', async () => {
  const jobId = await seedDueJob()
  let captured: any = null
  const judgeSystems: string[] = []
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'token mask keeps first6 last4' }], fullLength: 1 }),
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
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1 }),
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
  const jobId = await seedDueJob()
  let createCalls = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1 }),
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
