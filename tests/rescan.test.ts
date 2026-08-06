// tests/rescan.test.ts
// 回归防护:回扫是「重判」不是「清库」——判丢进 discards+status=rejected(双写,可恢复),
// 判留只补 NULL 字段,目录缺失跳过,重跑不重复判(已 rejected 离开候选池)。
// spec: docs/superpowers/specs/2026-08-06-agentic-value-judge-design.md §4.7
import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join, parse as parsePath } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { memories, memoryDiscards } from '@/db/schema'
import { createCandidate, getMemoryById } from '@/memory/store'
import { rescanCandidates } from '@/memory/rescan'
import { DEFAULT_JUDGE_CONFIG, type JudgeConfig } from '@/memory/judgeConfig'

const economyCfg = (): JudgeConfig => ({ ...DEFAULT_JUDGE_CONFIG, mode: 'economy' })

const root = join(import.meta.dir, '.tmp-rescan')
let dir = ''
let db: ReturnType<typeof openDb>
beforeAll(() => { rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true }) })
beforeEach(() => { dir = join(root, Math.random().toString(36).slice(2)); mkdirSync(dir, { recursive: true }); db = openDb(join(dir, 't.db')) })
afterEach(() => { db.$client.close() })

// 经济模式单发 judge 的 mock:第一条判丢(derivable),其余判留(decision)
const economyLLM = async () => '{"verdicts": [{"index": 0, "category": "derivable"}, {"index": 1, "category": "decision"}]}'

test('回扫:判丢进 discards + status=rejected;判留补 valueClass;目录缺失跳过', async () => {
  await createCandidate(db, {
    scopeType: 'project', scopeId: dir, title: '[category:a] 实现复述一条', bodyMd: 'b',
    tags: [], sourceKind: 'conversation', sourceCwd: dir, runtime: 'claude-code', origin: 'agent-observed',
  })
  await createCandidate(db, {
    scopeType: 'project', scopeId: dir, title: '[category:trap] 真坑一条', bodyMd: 'b',
    tags: [], sourceKind: 'conversation', sourceCwd: dir, runtime: 'claude-code', origin: 'agent-observed',
  })
  await createCandidate(db, {
    scopeType: 'project', scopeId: '/不存在/已删除目录', title: '[category:a] 目录没了', bodyMd: 'b',
    tags: [], sourceKind: 'conversation', sourceCwd: '/不存在/已删除目录', runtime: 'claude-code',
  })
  const report = await rescanCandidates(db, {
    callLLM: economyLLM, loadJudgeConfig: economyCfg,
  })
  expect(report).toEqual({ processed: 3, discarded: 1, skipped: 1, keptUpdated: 1 })
  const discards = await db.select().from(memoryDiscards)
  expect(discards).toHaveLength(1)
  expect(discards[0]!.reason).toBe('derivable')
  const rows = await db.select().from(memories)
  const byTitle = new Map(rows.map((r) => [r.title, r]))
  expect(byTitle.get('[category:a] 实现复述一条')!.status).toBe('rejected')
  expect(byTitle.get('[category:trap] 真坑一条')!.status).toBe('candidate')
  expect(byTitle.get('[category:trap] 真坑一条')!.valueClass).toBe('decision')
  expect(byTitle.get('[category:a] 目录没了')!.status).toBe('candidate')  // 跳过不动
})

test('重跑幂等:已 rejected 的不再处理', async () => {
  await createCandidate(db, {
    scopeType: 'project', scopeId: dir, title: '[category:a] 实现复述一条', bodyMd: 'b',
    tags: [], sourceKind: 'conversation', sourceCwd: dir, runtime: 'claude-code', origin: 'agent-observed',
  })
  const deps = { callLLM: economyLLM, loadJudgeConfig: economyCfg }
  await rescanCandidates(db, deps)
  const second = await rescanCandidates(db, deps)
  expect(second.processed).toBe(0)
  expect(await db.select().from(memoryDiscards)).toHaveLength(1)  // 没有第二条审计
})

// 回归防护(2026-08-06 final fix wave):rescan 曾把每个批次硬编码
// sourceKind: 'conversation' 喂 judgeValueAgentic,subagent 候选的
// 「重点核对是否一次性任务约束」提示(agentJudge 协议段)在回扫里永远落空——
// ③ backlog 正是为此设。修复后同 rootDir 内按 sourceKind 分组分批,
// judge 收到的 user prompt 必须带真实来源标记。
test('回扫质量模式:subagent 候选的 judge prompt 带 source: subagent(不与 conversation 混批)', async () => {
  await createCandidate(db, {
    scopeType: 'project', scopeId: dir, title: '[category:trap] 主会话坑', bodyMd: 'b',
    tags: [], sourceKind: 'conversation', sourceCwd: dir, runtime: 'claude-code', origin: 'agent-observed',
  })
  await createCandidate(db, {
    scopeType: 'project', scopeId: dir, title: '[category:trap] subagent 任务工单约束', bodyMd: 'b',
    tags: [], sourceKind: 'subagent', sourceCwd: dir, runtime: 'claude-code', origin: 'agent-observed',
  })
  const judgeUsers: string[] = []
  await rescanCandidates(db, {
    callLLM: async (_system, user) => { judgeUsers.push(user); return '{"final": {"verdicts": [{"index": 0, "category": "decision"}]}}' },
    loadJudgeConfig: () => ({ mode: 'quality', maxRounds: 30, timeBudgetS: 300 }),
  })
  // 两种来源各一批:两批 prompt 分别标 conversation / subagent,绝不混批
  expect(judgeUsers).toHaveLength(2)
  const conv = judgeUsers.find((u) => u.includes('主会话坑'))
  const sub = judgeUsers.find((u) => u.includes('任务工单约束'))
  expect(conv).toContain('source: conversation')
  expect(conv).not.toContain('source: subagent')
  expect(sub).toContain('source: subagent')
  expect(sub).not.toContain('source: conversation')
})

// 回归防护(2026-08-06 final fix wave 复审):rescan 的 rootDir 守卫曾与
// scheduler 同款漏洞——只查 existsSync,候选 sourceCwd 是文件系统根('C:\' / '/')
// 时通过守卫,质量模式就会 judgeValueAgentic(rootDir=盘根) -> makeRepoTools(盘根),
// agent 工具可读整盘。修复后与「目录已删」同款跳过(不判不动,可恢复)。
// 断言:整组 skipped、judge LLM 零调用、候选状态不变(绝不让 agent 拿到盘根沙箱)。
test('回扫质量模式:sourceCwd 是文件系统根 -> 整组跳过,agent 拿不到盘根沙箱', async () => {
  const fsRoot = parsePath(process.cwd()).root  // Windows: 'C:\';POSIX: '/'
  await createCandidate(db, {
    scopeType: 'project', scopeId: fsRoot, title: '[category:trap] 根目录会话坑', bodyMd: 'b',
    tags: [], sourceKind: 'conversation', sourceCwd: fsRoot, runtime: 'claude-code', origin: 'agent-observed',
  })
  let judgeCalls = 0
  const report = await rescanCandidates(db, {
    callLLM: async () => { judgeCalls++; return '{"final": {"verdicts": [{"index": 0, "category": "decision"}]}}' },
    loadJudgeConfig: () => ({ mode: 'quality', maxRounds: 30, timeBudgetS: 300 }),
  })
  expect(report).toEqual({ processed: 1, discarded: 0, skipped: 1, keptUpdated: 0 })
  expect(judgeCalls).toBe(0)  // 跳过在 judge 之前:agent 循环从未启动
  const row = (await db.select().from(memories))[0]!
  expect(row.status).toBe('candidate')  // 跳过不动:仍是候选,不判丢不判留
})
