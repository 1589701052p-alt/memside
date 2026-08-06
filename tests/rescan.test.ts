// tests/rescan.test.ts
// 回归防护:回扫是「重判」不是「清库」——判丢进 discards+status=rejected(双写,可恢复),
// 判留只补 NULL 字段,目录缺失跳过,重跑不重复判(已 rejected 离开候选池)。
// spec: docs/superpowers/specs/2026-08-06-agentic-value-judge-design.md §4.7
import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
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
