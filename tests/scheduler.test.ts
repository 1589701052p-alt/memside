import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { enqueueDistillJob, tick, DISTILL_DEBOUNCE_MS } from '@/scheduler'
import { createCandidate, createCandidate as realCreateCandidate, promoteCandidate } from '@/memory/store'
import { memoryDistillJobs, memoryDistillEvents, memories, memoryDiscards, memorySessionOffsets, memoryDistillInputs, memoryDistillRuns, notifications } from '@/db/schema'
import type { DistillCandidate } from '@/memory/distiller'
import { makeLoadTranscript } from '@/daemon'

// Task 5 起 tick 默认质量模式(agent 判定器)。凡锁「单发 judgeValue 行为」的既有用例
// 统一钉 economy 模式,保持原测试意图(单发判定语义由 economy 路径承载);
// 模式分发本身由 tests/scheduler-judge-dispatch.test.ts 锁定。
const ECONOMY = { mode: 'economy', maxRounds: 30, timeBudgetS: 300 } as const

// Each test gets its own fresh subdirectory under `root`. We only ever wipe
// `root` in `beforeAll` (before any DB is opened), and we close the raw handle
// after each test. This avoids a Windows EBUSY: deleting a directory that still
// contains an open bun:sqlite Database (plus its -wal/-shm sidecars) fails, and
// the OS doesn't release those locks the instant `.close()` returns. Fresh
// subdirs mean we never delete a dir holding an open handle. (Same pattern as
// store-crud.test.ts / schema.test.ts.)
const root = join(import.meta.dir, '.tmp-sched')
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

test('enqueue inserts a pending job with nextRunAt = now + debounce', async () => {
  const before = Date.now()
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1',
  })
  const after = Date.now()
  const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(rows[0]!.status).toBe('pending')
  expect(rows[0]!.nextRunAt).toBeGreaterThanOrEqual(before + DISTILL_DEBOUNCE_MS - 5)
  expect(rows[0]!.nextRunAt).toBeLessThanOrEqual(after + DISTILL_DEBOUNCE_MS + 5)
})

test('tick runs a due job and marks done, produces candidates', async () => {
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0,
  })
  // force due
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  const processed = await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'we only refund within 14 days' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async (sys) => {
      // Task 7：judge 失败即 step 失败（回 pending），成功路径需按 system 分派
      // （distill -> candidates；judge -> verdicts）。
      if (sys.includes('memside-distiller')) return JSON.stringify({
        candidates: [{ title: '[category:invariant] refund window 14d', bodyMd: '14 days', scope: 'project', runtime: null, distillAction: 'new' }],
      })
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    },
    createCandidate: async (_db, input) => ({ id: 'c1', status: 'candidate', version: 1 } as any),
  })
  expect(processed).toBe(1)
  const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(rows[0]!.status).toBe('done')
})

test('tick passes sourceCwd from job.cwd into createCandidate', async () => {
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/proj/x', debounceKey: 'k1', debounceMs: 0,
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let captured: any = null
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'something' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async () => {
      callCount++
      // call 1 = distill；call 2 = judge（dedup 在 1 候选无 existing 时短路）。
      if (callCount === 1) return JSON.stringify({
        candidates: [{ title: '[category:invariant] x', bodyMd: 'b', scope: 'global', runtime: null, distillAction: 'new' }],
      })
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    },
    createCandidate: async (_db, input) => { captured = input; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(captured.sourceCwd).toBe('/proj/x')
})

test('tick applies backoff on distill error', async () => {
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0,
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  await tick(db, {
    loadTranscript: async () => { throw new Error('no transcript') },
    callLLM: async () => '[]',
    createCandidate: async () => ({ id: 'c', status: 'candidate', version: 1 } as any),
  })
  const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(rows[0]!.status).toBe('pending')
  expect(rows[0]!.attempts).toBe(1)
  expect(rows[0]!.lastError).toBeTruthy()
})

test('tick filters duplicate candidates (dedup marks duplicate, not persisted)', async () => {
  const ex = await realCreateCandidate(db, { scopeType: 'project', scopeId: '/r', title: '[category:invariant] refund within 14 days', bodyMd: '14d', tags: [], sourceKind: 'manual', runtime: null, sourceCwd: '/r' })
  await db.update(memories).set({ status: 'approved' }).where(eq(memories.id, ex.id)).run()
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let createCalls = 0
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'refund 14 days' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:process] 14天退款', bodyMd: '14d', scope: 'project', runtime: null, distillAction: 'new' }] })
      // callCount === 2: 合并步标 new-0 为 drop（与 existing 纯语义重复）-> 候选移除 -> judgeValue skipped (0 candidates)
      return JSON.stringify({ groups: [{ action: 'drop', members: ['new-0'], dropReason: 'duplicate' }] })
    },
    createCandidate: async () => { createCalls++; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(createCalls).toBe(0)
})

test('tick: dedup LLM 报错 → step 失败回 pending 退避（Task 7：不再保守全保留吞错）', async () => {
  // Task 7（spec P1/§5）：dedup 会话失败是 step 失败——job 回 pending + 退避，
  // 不再把整批候选「全保留」冒充成功吞掉 LLM 故障。断点停在 dedup，下次带历史接续。
  const ex = await realCreateCandidate(db, { scopeType: 'project', scopeId: '/r', title: 'existing', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null, sourceCwd: '/r' })
  await db.update(memories).set({ status: 'approved' }).where(eq(memories.id, ex.id)).run()
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let createCalls = 0
  let callCount = 0
  const before = Date.now()
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:x] new', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
      throw new Error('dedup api down')
    },
    createCandidate: async () => { createCalls++; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(createCalls).toBe(0)  // dedup 未完成，judge/入库未跑
  const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(rows[0]!.status).toBe('pending')     // 非 done
  expect(rows[0]!.currentStep).toBe('dedup')  // 断点停 dedup
  expect(rows[0]!.stepAttempts).toBe(1)
  expect(rows[0]!.nextRunAt).toBeGreaterThan(before)  // 退避
  expect(rows[0]!.lastError).toBeTruthy()
})

test('tick skips dedup LLM when no existing memories in scope', async () => {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let callCount = 0
  let createCalls = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:x] new', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    },
    createCandidate: async () => { createCalls++; return { id: 'c1', status: 'candidate', version: 1 } as any },
    loadJudgeConfig: () => ECONOMY,
  })
  expect(callCount).toBe(2)
  expect(createCalls).toBe(1)
})

test('tick keeps sourceCwd/distillAction in createCandidate input after dedup', async () => {
  const ex = await realCreateCandidate(db, { scopeType: 'project', scopeId: '/r', title: 'existing', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null, sourceCwd: '/r' })
  await db.update(memories).set({ status: 'approved' }).where(eq(memories.id, ex.id)).run()
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let captured: any = null
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:x] new', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
      if (callCount === 2) return JSON.stringify({ groups: [{ action: 'keep', members: ['new-0'] }] })  // 合并步 keep
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    },
    createCandidate: async (_db, input) => { captured = input; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(captured.sourceCwd).toBe('/r')
  expect(captured.distillAction).toBe('new')
})

// ---------------------------------------------------------------------------
// Value-filter integration: tick runs dedup BEFORE judgeValue, so judgeValue +
// logDiscards only see dedup survivors. judgeValue classifies each survivor
// (rules 1-6); public-knowledge/derivable => discard (audit-logged to
// memory_discards), decision/convention/trap/topology => keep with valueClass,
// no valid classification => keep valueClass=null.
// ---------------------------------------------------------------------------

test('tick discards value-filter public-knowledge, logs to memory_discards, no createCandidate', async () => {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let createCalls = 0
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:x] js array map', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
      if (callCount === 2) return JSON.stringify({ verdicts: [{ index: 0, category: 'public-knowledge' }] })
      return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] })
    },
    createCandidate: async () => { createCalls++; return { id: 'c1', status: 'candidate', version: 1 } as any },
    loadJudgeConfig: () => ECONOMY,
  })
  expect(createCalls).toBe(0)
  const discards = await db.select().from(memoryDiscards)
  expect(discards.length).toBe(1)
  expect(discards[0]!.reason).toBe('public-knowledge')
  const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(rows[0]!.status).toBe('done')
})

test('tick passes valueClass into createCandidate for kept candidates', async () => {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let captured: any = null
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:x] chose A not B because', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
      if (callCount === 2) return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
      return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] })
    },
    createCandidate: async (_db, input) => { captured = input; return { id: 'c1', status: 'candidate', version: 1 } as any },
    loadJudgeConfig: () => ECONOMY,
  })
  expect(captured.valueClass).toBe('decision')
})

test('tick 入库候选携带 origin/evidence（用户陈述类端到端入库）', async () => {
  // Task 4（origin-driven value judgment）：distill 产出的 origin/evidence 必须随
  // createCandidate 入库（spec §模块改动点 3）。用既有 tick harness：enqueue job +
  // fake loadTranscript + callCount 分派 mock。distill 返回一条 origin='user-stated'、
  // evidence='任何改动必须走分支+PR' 的候选；无 existing -> dedup 短路；judgeValue
  // 返回 keep（category=decision）。断言 createCandidate 收到的 input.origin /
  // input.evidence 与候选一致（断言聚焦 origin/evidence 流转，不强约束 valueClass）。
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let captured: any = null
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: '任何改动必须走分支+PR' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:convention] 任何改动必须走分支+PR', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new', origin: 'user-stated', evidence: '任何改动必须走分支+PR' }] })
      // callCount === 2: judgeValue（dedup 无 existing 短路，不调 LLM）-> keep
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    },
    createCandidate: async (_db, input) => { captured = input; return { id: 'c1', status: 'candidate', version: 1 } as any },
    loadJudgeConfig: () => ECONOMY,
  })
  expect(callCount).toBe(2) // distill + judgeValue；dedup 短路
  expect(captured).not.toBeNull()
  expect(captured.origin).toBe('user-stated')
  expect(captured.evidence).toBe('任何改动必须走分支+PR')
})

test('tick: judgeValue LLM 报错 → step 失败回 pending，候选不丢不入队（Task 7 正式语义）', async () => {
  // Task 7（2026-08-18 §缺陷2/§5.2）：judge 失败不再 WIP「空 verdicts + done」——
  // 走 step 失败分支：job 回 pending + 退避，断点停 judge，下次带历史接续；
  // 满 3 次 → paused + 候选 pending_review（断点续跑测试套件锁定，此处锁首跳）。
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let createCalls = 0
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:x] new', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
      throw new Error('value api down')
    },
    createCandidate: async () => { createCalls++; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(createCalls).toBe(0)  // judge 未完成，无候选入库
  const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(rows[0]!.status).toBe('pending')      // 非 done：失败不消费 job
  expect(rows[0]!.currentStep).toBe('judge')   // 断点停 judge（distill/dedup 不重算）
  expect(rows[0]!.stepAttempts).toBe(1)
})

test('tick runs dedup before judgeValue (3-phase call order)', async () => {
  // Pre-position an existing memory so dedup actually calls the LLM (without
  // existing memories, consolidateCandidates short-circuits and the 3rd phase is
  // never reached, making the call-order assertion untestable).
  const ex = await realCreateCandidate(db, { scopeType: 'project', scopeId: '/r', title: 'existing', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null, sourceCwd: '/r' })
  await db.update(memories).set({ status: 'approved' }).where(eq(memories.id, ex.id)).run()
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  const phases: string[] = []
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async (_sys, user) => {
      callCount++
      if (callCount === 1) { phases.push('distill'); return JSON.stringify({ candidates: [{ title: '[category:x] new', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] }) }
      if (callCount === 2) { phases.push('dedup'); return JSON.stringify({ groups: [{ action: 'keep', members: ['new-0'] }] }) }
      phases.push('judgeValue'); return JSON.stringify({ verdicts: [{ index: 0, category: 'trap' }] })
    },
    createCandidate: async () => ({ id: 'c1', status: 'candidate', version: 1 } as any),
    loadJudgeConfig: () => ECONOMY,
  })
  expect(phases).toEqual(['distill', 'dedup', 'judgeValue'])
})

test('tick: protected invariant candidate survives with valueClass=decision (e2e gate + bulk-reject immunity)', async () => {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let captured: any = null
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'refunds only within 14 days' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:invariant] 退款须在发货后14天内', bodyMd: '14d', scope: 'project', runtime: null, distillAction: 'new', origin: 'user-stated', evidence: '退款须在发货后14天内' }] })
      // dedup short-circuits (1 candidate, no existing) -> call 2 is judgeValue;
      // judgeValue LLM wrongly says derivable -> logic gate must override to keep+decision
      return JSON.stringify({ verdicts: [{ index: 0, category: 'derivable' }] })
    },
    createCandidate: async (_db, input) => { captured = input; return { id: 'c1', status: 'candidate', version: 1 } as any },
    loadJudgeConfig: () => ECONOMY,
  })
  expect(callCount).toBe(2) // distill + judgeValue; dedup skipped LLM (short-circuit)
  expect(captured).not.toBeNull()
  expect(captured.valueClass).toBe('decision') // non-null -> immune to 批量拒绝未评估
  const rows = await db.select().from(memoryDiscards)
  expect(rows.length).toBe(0) // not discarded despite LLM saying derivable
})

test('tick: codebase invariant candidate is discarded when LLM says derivable (e2e ruleObject gate)', async () => {
  // TDD（第二轮核心 e2e）：codebase 类 invariant（代码复述）不再被逻辑门保护。
  // distill 产出 ruleObject=codebase，judgeValue LLM 判 derivable -> 丢弃入 discards，
  // createCandidate 不被调用。与上一条 domain 测试互为正反锚点。
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let createCalls = 0
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'valueFilter must force-keep invariant' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:invariant] valueFilter 必须强制保留 invariant', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new', ruleObject: 'codebase' }] })
      return JSON.stringify({ verdicts: [{ index: 0, category: 'derivable' }] })
    },
    createCandidate: async () => { createCalls++; return { id: 'c1', status: 'candidate', version: 1 } as any },
    loadJudgeConfig: () => ECONOMY,
  })
  expect(callCount).toBe(2) // distill + judgeValue; dedup short-circuits
  expect(createCalls).toBe(0) // discarded, not created
  const rows = await db.select().from(memoryDiscards)
  expect(rows.length).toBe(1)
  expect(rows[0]!.reason).toBe('derivable')
})

test('tick: dedup existing bodyMd flows into cross-batch comparison (e2e)', async () => {
  // TDD（第二轮）：已入库 existing 候选带 bodyMd 进 dedup prompt。先建一条 existing
  // candidate，再 enqueue 新 job 产出同义候选，断言 dedup 把新候选判为重复、不创建。
  const ex = await realCreateCandidate(db, { scopeType: 'project', scopeId: '/r', title: '[category:invariant] 退款须在发货后14天内', bodyMd: '14天退款窗口', tags: [], sourceKind: 'manual', runtime: null, sourceCwd: '/r' })
  await db.update(memories).set({ status: 'candidate' }).where(eq(memories.id, ex.id)).run()
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let createCalls = 0
  let captured = ''
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'refund rule' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async (_sys, user) => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:invariant] 退款规则14天期限', bodyMd: '14d', scope: 'project', runtime: null, distillAction: 'new', ruleObject: 'domain' }] })
      if (callCount === 2) { captured = user; return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: true, duplicateOfId: ex.id }] }) }
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    },
    createCandidate: async () => { createCalls++; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(captured).toContain('14天退款窗口') // existing bodyMd 进了 dedup prompt
  expect(createCalls).toBe(0) // 新候选被判重复，不创建
})

test('tick: codebase-ruleObject design-decision candidate is derivable-discarded (e2e ruleObject-driven derivable)', async () => {
  // TDD（第三轮 §D）：dogfood 场景下"关于当前仓库自身设计决策"的候选被 LLM 当 decision
  // 保留。现在 distiller 标 ruleObject=codebase，valueFilter prompt 带 ruleObject 标记 +
  // 中性描述关联 derivable -> LLM 判 derivable -> 丢弃。锁住 ruleObject 信号端到端流转。
  // 根因见 spec §1.2（valueFilter 判 derivable 缺仓库参照系，靠 distiller ruleObject 补强）。
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let createCalls = 0
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'token budget widened to 64k' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:architecture] token 预算从 12k 扩到 64k', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new', ruleObject: 'codebase' }] })
      // dedup short-circuits (1 candidate, no existing) -> call 2 is judgeValue;
      // ruleObject=codebase + 仓库自身设计决策 -> derivable
      return JSON.stringify({ verdicts: [{ index: 0, category: 'derivable' }] })
    },
    createCandidate: async () => { createCalls++; return { id: 'c1', status: 'candidate', version: 1 } as any },
    loadJudgeConfig: () => ECONOMY,
  })
  expect(callCount).toBe(2) // distill + judgeValue; dedup short-circuits
  expect(createCalls).toBe(0) // discarded, not created
  const rows = await db.select().from(memoryDiscards)
  expect(rows.length).toBe(1)
  expect(rows[0]!.reason).toBe('derivable')
})

// ---------------------------------------------------------------------------
// 第五轮增量蒸馏：turn 偏移切片 + 空切片跳过 + 偏移更新。
// 根因见 spec §1.1 问题1：Stop-vs-Stop 累积重复蒸馏（同 session 被 Stop 33 次，
// 早 Stop 是晚 Stop 完整前缀）。tick 对空 newTurns 跳过；成功后更新偏移。
// ---------------------------------------------------------------------------

test('tick skips distill when newTurns empty (marks done, no createCandidate, no setSessionOffset)', async () => {
  // 第五轮：同一 session 第三次 Stop 无新增 turn -> loadTranscript 返回 {turns:[], fullLength:120}
  // -> tick 标 done、不 distill、不 createCandidate。
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0,
    sessionId: 'sess-S',
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let createCalls = 0
  let llmCalls = 0
  const processed = await tick(db, {
    loadTranscript: async () => ({ turns: [], fullLength: 120, prefixTurns: [] }),
    callLLM: async () => { llmCalls++; return '[]' },
    createCandidate: async () => { createCalls++; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(processed).toBe(1)
  expect(llmCalls).toBe(0)            // 不调 LLM 蒸馏
  expect(createCalls).toBe(0)         // 不创建候选
  const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(rows[0]!.status).toBe('done') // 仍标 done（消费 job）
})

test('tick updates session offset after successful distill (job has sessionId)', async () => {
  // 第五轮：job 带 sessionId -> 蒸馏成功后 setSessionOffset(sessionId, fullLength)。
  // 下次同 session 的 loadTranscript 应从该偏移切片。用真实 store 函数验证端到端。
  const { getSessionOffset, setSessionOffset: _s } = await import('@/memory/store')
  void _s
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0,
    sessionId: 'sess-T',
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'new turn' }], fullLength: 42, prefixTurns: [] }),
    callLLM: async (sys) => {
      if (sys.includes('memside-distiller')) return JSON.stringify({ candidates: [{ title: '[category:x] t', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    },
    createCandidate: async () => ({ id: 'c1', status: 'candidate', version: 1 } as any),
  })
  // 偏移已更新到 fullLength
  expect(await getSessionOffset(db, 'sess-T')).toBe(42)
})

test('tick does NOT setSessionOffset when job has no sessionId (backward compat)', async () => {
  // 第五轮：历史 job（sessionId=null）-> 全量蒸馏、不更新偏移。向后兼容。
  const { getSessionOffset } = await import('@/memory/store')
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0,
    // 不传 sessionId
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 5, prefixTurns: [] }),
    callLLM: async () => JSON.stringify({ candidates: [{ title: '[category:x] t', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] }),
    createCandidate: async () => ({ id: 'c1', status: 'candidate', version: 1 } as any),
  })
  // 无 sessionId -> 不写偏移表（getSessionOffset 仍返回默认 0，但这里关键是该 session 无记录）
  expect(await getSessionOffset(db, 'any-session')).toBe(0)
})

test('tick still marks done when setSessionOffset throws (warn, non-blocking)', async () => {
  // 第五轮：setSessionOffset 失败只 warn，job 仍 done（偏移是优化非正确性依赖）。
  // 强锁构造：monkey-patch db.insert 让 memory_session_offsets 的 insert 抛，但 tick
  // 前半段（update running / select events / update done）不受影响。tick 内 try/catch
  // 吞掉 setSessionOffset 的抛，job 仍标 done。
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0,
    sessionId: 'sess-F',
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  // 包一层 db.insert：仅对 memory_session_offsets 表的 insert 抛错，其余透传。
  const realInsert = db.insert.bind(db)
  let sessionOffsetsThrows = false
  db.insert = ((table: unknown) => {
    const builder = realInsert(table as any)
    // memory_session_offsets 由 setSessionOffset 写入；命中即抛。
    if (sessionOffsetsThrows && table === memorySessionOffsets) {
      throw new Error('mocked session_offsets insert failure')
    }
    return builder
  }) as any
  try {
    sessionOffsetsThrows = true
    await tick(db, {
      loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 3, prefixTurns: [] }),
      callLLM: async (sys) => {
        if (sys.includes('memside-distiller')) return JSON.stringify({ candidates: [{ title: '[category:x] t', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
        return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
      },
      createCandidate: async () => ({ id: 'c1', status: 'candidate', version: 1 } as any),
    })
    const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
    expect(rows[0]!.status).toBe('done')
  } finally {
    sessionOffsetsThrows = false
    db.insert = realInsert
  }
})

test('makeLoadTranscript degrades to full when getSessionOffset throws (read-failure non-blocking)', async () => {
  // 第五轮 final review 补的读侧降级锁。daemon.ts makeLoadTranscript 内 getSessionOffset
  // 失败时 try/catch 降级全量返回（不阻塞蒸馏）。写侧对账（setSessionOffset throws ->
  // job still done）已由上一测试覆盖；本测试锁住读侧：偏移表有 offset=2（正常会 slice(2)
  // 只给 1 turn），但 db.select 对 memory_session_offsets 抛错 -> getSessionOffset throw
  // -> makeLoadTranscript 降级返回全量 3 turns，不切片。计划 Global Constraints 第 19 行
  // "getSessionOffset 失败降级全量" 的强锁（与上一测试互为读/写降级锚点）。
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0,
    sessionId: 'sess-D',
  })
  await db.insert(memoryDistillEvents).values({
    distillJobId: jobId, attemptIndex: 0, ts: 1, kind: 'conversation',
    payload: JSON.stringify([
      { role: 'user', content: 'turn A' },
      { role: 'user', content: 'turn B' },
      { role: 'user', content: 'turn C' },
    ]),
  })
  // 预置偏移 = 2：若 getSessionOffset 正常返回，makeLoadTranscript 会 slice(2) 只给 1 turn。
  // 降级路径必须绕过此偏移、返回全量 3 turns。
  await db.insert(memorySessionOffsets).values({
    sessionId: 'sess-D', lastTurnOffset: 2, updatedAt: Date.now(),
  })
  // 包一层 db.select：仅对 .from(memorySessionOffsets) 抛错，其余表（如 memoryDistillEvents）
  // 透传。与上一测试（setSessionOffset throws -> 包 db.insert）同模式：monkey-patch + flag
  // + finally 还原；区别是 db.select 的表名在 .from(table) 而非 db.select(table)，故返回
  // 一个仅拦截 .from 的适配对象（不 mutate 真 builder，避免 drizzle 内部单例被重复包装）。
  const realSelect = db.select.bind(db)
  let sessionOffsetsThrows = false
  db.select = (() => ({
    from: (table: unknown) => {
      if (sessionOffsetsThrows && table === memorySessionOffsets) {
        throw new Error('mocked session_offsets select failure')
      }
      return realSelect().from(table as any)
    },
  })) as any
  try {
    sessionOffsetsThrows = true
    const loadTranscript = makeLoadTranscript(db)
    const result = await loadTranscript({ id: jobId, cwd: '/r', sourceEventId: 'e1', sessionId: 'sess-D', sourceAgentId: null })
    // 降级全量：3 turns（不是 slice(2) 的 1 turn），fullLength = 3。
    expect(result.turns.length).toBe(3)
    expect(result.fullLength).toBe(3)
    expect(result.turns.map((t) => t.content)).toEqual(['turn A', 'turn B', 'turn C'])
  } finally {
    sessionOffsetsThrows = false
    db.select = realSelect
  }
})

// ---------------------------------------------------------------------------
// 第五轮 e2e：真实 makeLoadTranscript（不 mock）+ 真实 store 偏移。
// 同 session 两次 Stop：第一次全量蒸馏 + 更新偏移；第二次只蒸馏新增 turn。
// 锁住 spec §4.1 增量数据流。根因见 spec §1.1 问题1（Stop 累积重复蒸馏）。
// ---------------------------------------------------------------------------

test('e2e incremental: same-session second Stop distills only new turns', async () => {
  const { jobId: job1 } = await enqueueDistillJob(db, {
    sourceEventId: 'stop-1', runtime: 'claude-code', cwd: '/r', debounceKey: '/r:Stop', debounceMs: 0,
    sessionId: 'sess-e2e',
  })
  // 第一次 Stop 的 transcript：3 turns（全量）
  await db.insert(memoryDistillEvents).values({
    distillJobId: job1, attemptIndex: 0, ts: 1, kind: 'conversation',
    payload: JSON.stringify([
      { role: 'user', content: 'turn A' },
      { role: 'user', content: 'turn B' },
      { role: 'user', content: 'turn C' },
    ]),
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, job1))

  const loadTranscript = makeLoadTranscript(db)
  await tick(db, {
    loadTranscript,
    callLLM: async (sys) => {
      // 第一次 Stop：3 turns 全量蒸馏。偏移推进由下方 getSessionOffset 断言锁住
      // （distill 的 callLLM 次数受 valueFilter 重试影响，不稳，不在此断言）。
      if (sys.includes('memside-distiller')) return JSON.stringify({ candidates: [{ title: '[category:x] t', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    },
    createCandidate: async () => ({ id: 'c1', status: 'candidate', version: 1 } as any),
  })
  const { getSessionOffset } = await import('@/memory/store')
  expect(await getSessionOffset(db, 'sess-e2e')).toBe(3)  // 偏移推进到 3

  // 第二次 Stop：5 turns（前 3 是旧前缀，后 2 新增）
  const { jobId: job2 } = await enqueueDistillJob(db, {
    sourceEventId: 'stop-2', runtime: 'claude-code', cwd: '/r', debounceKey: '/r:Stop', debounceMs: 0,
    sessionId: 'sess-e2e',
  })
  await db.insert(memoryDistillEvents).values({
    distillJobId: job2, attemptIndex: 0, ts: 2, kind: 'conversation',
    payload: JSON.stringify([
      { role: 'user', content: 'turn A' },
      { role: 'user', content: 'turn B' },
      { role: 'user', content: 'turn C' },
      { role: 'user', content: 'turn D (new)' },
      { role: 'user', content: 'turn E (new)' },
    ]),
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, job2))

  let distillInputTurns: string[] = []
  await tick(db, {
    loadTranscript,
    callLLM: async (_sys, user) => {
      // distiller 的 user prompt 含 turns；捕获看是否只含 D/E
      distillInputTurns.push(user)
      if (_sys.includes('memside-distiller')) return JSON.stringify({ candidates: [{ title: '[category:x] t2', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    },
    createCandidate: async () => ({ id: 'c2', status: 'candidate', version: 1 } as any),
  })
  // 第二次：偏移已从 3 推进到 5（核心不可让步断言之一）
  expect(await getSessionOffset(db, 'sess-e2e')).toBe(5)
  // 第二次蒸馏的 Transcript 只含新增 turn D/E，不含旧 turn A/B/C。
  // 注意取 [0]：tick 内 LLM 调用顺序固定为 distill(1次) -> dedup(短路不调)
  // -> judgeValue(最多 3 次重试)。distill 是第一次调用，其 user prompt 由
  // distiller.renderUserPrompt 拼成 `[user] ${content}`，含完整 transcript。
  // 取末次会是 valueFilter 的 retry prompt（含候选 title 而非 transcript），不含 turns。
  // 账本重构（spec 2026-08-11-digest-ledger-redesign §4.1）：首停小切片直追把 turn
  // A/B/C 原样入账本，二停 priorContext 来自该账本，背景节（## 背景）合法含旧 turn。
  // 断言只锁 Transcript 节，避免把「正确上下文」误判为重复蒸馏；核心意图（只蒸馏
  // 新增 D/E、偏移推进到 5）不变。
  const distillPrompt = distillInputTurns[0]!
  expect(distillPrompt).toContain('Transcript:')
  const transcriptSection = distillPrompt.split('Transcript:')[1] ?? distillPrompt
  expect(transcriptSection).toContain('turn D (new)')
  expect(transcriptSection).toContain('turn E (new)')
  expect(transcriptSection).not.toContain('turn A')
  expect(transcriptSection).not.toContain('turn B')
  expect(transcriptSection).not.toContain('turn C')
})

test('e2e incremental: same-session second Stop with no new turns skips distill', async () => {
  // 第五轮：第二次 Stop transcript 与第一次相同（无新增）-> loadTranscript 返回空切片
  // -> tick 跳过蒸馏、不 createCandidate、偏移不变。
  const { jobId: job1 } = await enqueueDistillJob(db, {
    sourceEventId: 'stop-1', runtime: 'claude-code', cwd: '/r', debounceKey: '/r:Stop', debounceMs: 0,
    sessionId: 'sess-skip',
  })
  await db.insert(memoryDistillEvents).values({
    distillJobId: job1, attemptIndex: 0, ts: 1, kind: 'conversation',
    payload: JSON.stringify([
      { role: 'user', content: 'turn A' },
      { role: 'user', content: 'turn B' },
    ]),
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, job1))
  const loadTranscript = makeLoadTranscript(db)
  await tick(db, {
    loadTranscript,
    callLLM: async (sys) => {
      if (sys.includes('memside-distiller')) return JSON.stringify({ candidates: [{ title: '[category:x] t', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    },
    createCandidate: async () => ({ id: 'c1', status: 'candidate', version: 1 } as any),
  })

  // 第二次 Stop：同样 2 turns（无新增）
  const { jobId: job2 } = await enqueueDistillJob(db, {
    sourceEventId: 'stop-2', runtime: 'claude-code', cwd: '/r', debounceKey: '/r:Stop', debounceMs: 0,
    sessionId: 'sess-skip',
  })
  await db.insert(memoryDistillEvents).values({
    distillJobId: job2, attemptIndex: 0, ts: 2, kind: 'conversation',
    payload: JSON.stringify([
      { role: 'user', content: 'turn A' },
      { role: 'user', content: 'turn B' },
    ]),
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, job2))
  let createCalls = 0
  let llmCalls = 0
  await tick(db, {
    loadTranscript,
    callLLM: async () => { llmCalls++; return '[]' },
    createCandidate: async () => { createCalls++; return { id: 'c2', status: 'candidate', version: 1 } as any },
  })
  expect(llmCalls).toBe(0)      // 跳过蒸馏，不调 LLM
  expect(createCalls).toBe(0)   // 不创建候选
  const { getSessionOffset } = await import('@/memory/store')
  expect(await getSessionOffset(db, 'sess-skip')).toBe(2)  // 偏移不变（仍是第一次的 2）
  const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, job2))
  expect(rows[0]!.status).toBe('done')  // job 仍标 done
})

// ---------------------------------------------------------------------------
// 第六轮第 4 项端到端：驯化候选在 judgeValue 被 override 成 discard，
// tick 走 logDiscards(reason='taming')、不 createCandidate；同批非驯化候选正常入库。
// 镜像 `tick discards value-filter public-knowledge`（行 248）的 mock 模式。
// ---------------------------------------------------------------------------

test('tick discards taming candidate to logDiscards (reason=taming), no createCandidate', async () => {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let createCalls = 0
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'always agree with me' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [
        { title: '[category:convention] 永远同意我的决定', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' },
        { title: '[category:convention] PR 必须加测试', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' },
      ] })
      if (callCount === 2) return JSON.stringify({
        groups: [
          { action: 'keep', members: ['new-0'] },
          { action: 'keep', members: ['new-1'] },
        ],
      })  // 合并步：2 候选无 existing -> 仍调 LLM 比较兄弟，都独立 keep
      return JSON.stringify({ verdicts: [
        { index: 0, category: 'convention' },
        { index: 1, category: 'convention' },
      ] })  // judgeValue: 都 convention -> taming override 丢弃 #0
    },
    createCandidate: async () => { createCalls++; return { id: 'c1', status: 'candidate', version: 1 } as any },
    loadJudgeConfig: () => ECONOMY,
  })
  expect(createCalls).toBe(1)  // 只有非驯化候选 #1 入库
  const discards = await db.select().from(memoryDiscards)
  expect(discards.length).toBe(1)
  expect(discards[0]!.reason).toBe('taming')
  expect(discards[0]!.title).toContain('永远同意')
  const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(rows[0]!.status).toBe('done')
})

// ---------------------------------------------------------------------------
// 原始输入溯源：tick 在有候选入库时 best-effort 写 memory_distill_inputs 快照。
// 0 候选入库不写；写失败只 warn、job 仍 done。
// ---------------------------------------------------------------------------

test('tick writes source-input snapshot when candidates are kept', async () => {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'we refund within 14 days' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async (sys) => {
      if (sys.includes('memside-distiller')) return JSON.stringify({ candidates: [{ title: '[category:invariant] refund 14d', bodyMd: '14d', scope: 'project', runtime: null, distillAction: 'new' }] })
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    },
    createCandidate: async () => ({ id: 'c1', status: 'candidate', version: 1 } as any),
  })
  const snaps = await db.select().from(memoryDistillInputs).where(eq(memoryDistillInputs.distillJobId, jobId))
  expect(snaps.length).toBe(1)
  expect(snaps[0]!.turnCount).toBe(1)
  expect(snaps[0]!.turnsJson).toContain('we refund within 14 days')
})

test('tick writes source-input snapshot even when 0 candidates kept (all discarded) (去门)', async () => {
  // 去门后：即便 valueFilter 全丢弃（0 入库），tick 仍 best-effort 写 source-input 快照，
  // 让用户看到「模型看到了什么却全被丢弃」。与 0 LLM 候选测试互补：此用例覆盖
  // 「1 候选 -> dedup 短路 -> judgeValue 判 public-knowledge -> 丢弃」路径。
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:x] js array map', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
      if (callCount === 2) return JSON.stringify({ verdicts: [{ index: 0, category: 'public-knowledge' }] })
      return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] })
    },
    createCandidate: async () => ({ id: 'c1', status: 'candidate', version: 1 } as any),
  })
  const snaps = await db.select().from(memoryDistillInputs).where(eq(memoryDistillInputs.distillJobId, jobId))
  expect(snaps.length).toBe(1)  // 去门后 0 候选入库也写快照
  const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(rows[0]!.status).toBe('done')
})

test('tick still marks done when saveSourceInput throws (warn, non-blocking)', async () => {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  // 包一层 db.insert：仅对 memory_distill_inputs 表的 insert 抛错，其余透传。
  // 与既有 setSessionOffset-throws 测试（行 506-530）同模式：monkey-patch + flag + finally 还原。
  const realInsert = db.insert.bind(db)
  let inputsThrows = false
  db.insert = ((table: unknown) => {
    const builder = realInsert(table as any)
    if (inputsThrows && table === memoryDistillInputs) {
      throw new Error('mocked distill_inputs insert failure')
    }
    return builder
  }) as any
  try {
    inputsThrows = true
    await tick(db, {
      loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1, prefixTurns: [] }),
      callLLM: async (sys) => {
        if (sys.includes('memside-distiller')) return JSON.stringify({ candidates: [{ title: '[category:x] t', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
        return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
      },
      createCandidate: async () => ({ id: 'c1', status: 'candidate', version: 1 } as any),
    })
    const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
    expect(rows[0]!.status).toBe('done')  // 写失败可吞，job 仍 done
  } finally {
    inputsThrows = false
    db.insert = realInsert
  }
})

// ---------------------------------------------------------------------------
// Task 7：subject-keyed 聚合接线 —— tick 查 project∪global slug 清单喂 distiller，
// distiller 产出的 subjectSlug 随 createCandidate 入库。
// ---------------------------------------------------------------------------

test('tick: existing slugs (project + global union) reach the distiller prompt; subjectSlug persisted', async () => {
  // spec §4.6：tick 查 listSubjectSlugs 并集喂 distiller；候选的 subjectSlug 随 createCandidate 入库。
  const db = openDb(join(dir, 'slug.db'))
  // 预置：project 域一个 slug、global 域一个 slug
  const proj = await createCandidate(db, {
    scopeType: 'project', scopeId: '/repo', title: 't', bodyMd: 'b', tags: [],
    sourceKind: 'manual', runtime: null, subjectSlug: 'refund-policy',
  })
  await createCandidate(db, {
    scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b', tags: [],
    sourceKind: 'manual', runtime: null, subjectSlug: 'global-topic',
  })
  await promoteCandidate(db, proj.id, { action: 'approve' })
  const { enqueueDistillJob, tick } = await import('@/scheduler')
  await enqueueDistillJob(db, { sourceEventId: 'se1', runtime: 'claude-code', cwd: '/repo', debounceKey: 'dk', debounceMs: 0 })
  let distillUserPrompt = ''
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user' as const, content: 'refund rule' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async (_sys, user) => {
      callCount++
      if (callCount === 1) {
        distillUserPrompt = user
        return JSON.stringify({ candidates: [{ title: '[category:invariant] 退款14天', bodyMd: '14d', scope: 'project', runtime: null, distillAction: 'new', ruleObject: 'domain', subjectSlug: 'refund-policy' }] })
      }
      if (callCount === 2) return JSON.stringify({ groups: [{ action: 'keep', members: ['new-0'] }] })  // 合并步 keep（保守全留）
      // judgeValue：空 verdicts -> verdictsFromCategories 全 keep（缺漏下标保守 keep）
      return JSON.stringify({ verdicts: [] })
    },
    createCandidate,
  })
  expect(distillUserPrompt).toContain('refund-policy')
  expect(distillUserPrompt).toContain('global-topic')
  const rows = await db.select().from(memories).where(eq(memories.title, '[category:invariant] 退款14天'))
  expect(rows[0]!.subjectSlug).toBe('refund-policy')
  db.$client.close()
})

// ---------------------------------------------------------------------------
// Task 6：subagent 蒸馏隔离 -- job 带 sourceAgentId -> sourceKind='subagent'、
// 跳过偏移切片/更新；主会话 job 维持 sourceKind='conversation'、正常偏移。
// ---------------------------------------------------------------------------

test('tick: subagent job (sourceAgentId set) -> sourceKind=subagent in createCandidate', async () => {
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'sub-1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0,
    sourceAgentId: 'agent-XYZ',
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let captured: any = null
  let callCount = 0
  await tick(db, {
    // Task 8 起 subagent job 有琐碎下限（<1000 字 -> skipped_trivial 不调 LLM）；
    // 本用例锁 sourceKind 传播，需越过琐碎下限。
    loadTranscript: async () => ({ turns: [{ role: 'user', content: `subagent did X ${'y'.repeat(1200)}` }], fullLength: 1, prefixTurns: [] }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:architecture] subagent rationale', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    },
    createCandidate: async (_db, input) => { captured = input; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(captured.sourceKind).toBe('subagent')
})

test('tick: subagent job does NOT update session offset (even if sessionId present)', async () => {
  const { getSessionOffset } = await import('@/memory/store')
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'sub-2', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0,
    sessionId: 'sess-sub', sourceAgentId: 'agent-OFF',
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async () => JSON.stringify({ candidates: [{ title: '[category:x] t', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] }),
    createCandidate: async () => ({ id: 'c1', status: 'candidate', version: 1 } as any),
  })
  // subagent job 不更新偏移：sess-sub 无记录（getSessionOffset 返回 0 且无行）
  expect(await getSessionOffset(db, 'sess-sub')).toBe(0)
  const offs = await db.select().from(memorySessionOffsets)
  expect(offs.length).toBe(0)
})

test('tick: main-session job (no sourceAgentId) still uses sourceKind=conversation + updates offset', async () => {
  const { getSessionOffset } = await import('@/memory/store')
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'main-1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0,
    sessionId: 'sess-main',
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let captured: any = null
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 7, prefixTurns: [] }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:x] t', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    },
    createCandidate: async (_db, input) => { captured = input; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(captured.sourceKind).toBe('conversation')
  expect(await getSessionOffset(db, 'sess-main')).toBe(7)
})

// ---------------------------------------------------------------------------
// Task 4：distill run 记录透明化 -- tick 在每个 done job 写一行 memory_distill_runs
// （outcome 四态 + 计数链 + LLM 原始产出 + 耗时），并去掉 saveSourceInput 的
// keepWithClass>0 门（0 产出 job 也存过滤版输入）。run 记录 / source-input 均为
// best-effort：写失败只 warn，不阻塞 done。
// ---------------------------------------------------------------------------

async function forceDue(jobId: string) {
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
}

test('tick writes run record outcome=skipped_no_new_turns when newTurns empty', async () => {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e', runtime: 'claude-code', cwd: '/r', debounceKey: 'k', debounceMs: 0, sessionId: 's1' })
  await db.insert(memoryDistillEvents).values({ distillJobId: jobId, attemptIndex: 0, ts: Date.now(), kind: 'conversation', payload: '[]' })
  await forceDue(jobId)
  const n = await tick(db, { loadTranscript: async () => ({ turns: [], fullLength: 0, prefixTurns: [] }), callLLM: async () => JSON.stringify({ candidates: [] }), createCandidate: async (_d: any, input: any) => ({ id: 'c', status: 'candidate', version: 1 } as any) })
  expect(n).toBe(1)
  const runs = db.select().from(memoryDistillRuns).all()
  expect(runs.length).toBe(1)
  expect(runs[0]!.outcome).toBe('skipped_no_new_turns')
  expect(runs[0]!.distilledCount).toBe(0)
})

test('tick writes run record outcome=empty_output when LLM returns 0 candidates', async () => {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e', runtime: 'claude-code', cwd: '/r', debounceKey: 'k', debounceMs: 0, sessionId: 's2' })
  await db.insert(memoryDistillEvents).values({ distillJobId: jobId, attemptIndex: 0, ts: Date.now(), kind: 'conversation', payload: JSON.stringify([{ role: 'user', content: 'hi' }]) })
  await forceDue(jobId)
  await tick(db, { loadTranscript: async () => ({ turns: [{ role: 'user', content: 'hi' }] as any, fullLength: 1, prefixTurns: [] }), callLLM: async () => JSON.stringify({ candidates: [] }), createCandidate: async (_d: any, input: any) => ({ id: 'c', status: 'candidate', version: 1 } as any) })
  const runs = db.select().from(memoryDistillRuns).all()
  expect(runs[0]!.outcome).toBe('empty_output')
  expect(runs[0]!.distilledCount).toBe(0)
})

test('tick writes run record outcome=llm_error when callLLM throws（Task 7：3 tick 后暂停落终态）', async () => {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e', runtime: 'claude-code', cwd: '/r', debounceKey: 'k', debounceMs: 0, sessionId: 's3' })
  await db.insert(memoryDistillEvents).values({ distillJobId: jobId, attemptIndex: 0, ts: Date.now(), kind: 'conversation', payload: JSON.stringify([{ role: 'user', content: 'hi' }]) })
  await forceDue(jobId)
  // Task 7：每 tick 一轮，3 轮失败才暂停——run 记录在暂停时落终态 llm_error。
  for (let i = 0; i < 3; i++) {
    await tick(db, {
      loadTranscript: async () => ({ turns: [{ role: 'user', content: 'hi' }] as any, fullLength: 1, prefixTurns: [] }),
      callLLM: async () => { throw new Error('api down') },
      createCandidate: async (_d: any, input: any) => ({ id: 'c', status: 'candidate', version: 1 } as any),
    })
    if (i < 2) await forceDue(jobId)
  }
  const runs = db.select().from(memoryDistillRuns).all()
  expect(runs[0]!.outcome).toBe('llm_error')
  const job = db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId)).all()[0]!
  expect(job.status).toBe('paused')
})

test('tick: distill 首轮失败后续跑成功 -> outcome=produced（callThrew not sticky，Task 7 断点接续版）', async () => {
  // 回归（review fix-wave Finding 1 的 Task 7 语义版）：distill 第 1 轮抛错 ->
  // step 失败回 pending；第 2 个 tick 带历史接续成功产候选 -> dedup 短路（无
  // existing）-> judgeValue 判 decision 保留 -> 全程完成 outcome='produced'
  // （spec §4 produced = accepted_count > 0 regardless——重试成功不被误标 llm_error）。
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e', runtime: 'claude-code', cwd: '/r', debounceKey: 'k', debounceMs: 0, sessionId: 's3b' })
  await db.insert(memoryDistillEvents).values({ distillJobId: jobId, attemptIndex: 0, ts: Date.now(), kind: 'conversation', payload: JSON.stringify([{ role: 'user', content: 'hi' }]) })
  await forceDue(jobId)
  let callCount = 0
  const deps = {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'hi' }] as any, fullLength: 1, prefixTurns: [] }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) throw new Error('transient api down')   // tick1: distill round 1 抛错
      if (callCount === 2) return JSON.stringify({ candidates: [{ title: '[category:convention] x', bodyMd: 'b', scope: 'project', runtime: 'claude-code', distillAction: 'new' }] })  // tick2: distill round 2 成功
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })  // judgeValue
    },
    createCandidate: async (_d: any, input: any) => ({ id: 'c' + input.title, status: 'candidate', version: 1 } as any),
  }
  await tick(db, deps)
  const mid = db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId)).all()[0]!
  expect(mid.status).toBe('pending')      // tick1 失败回 pending（非 done）
  expect(mid.stepAttempts).toBe(1)
  await forceDue(jobId)
  await tick(db, deps)
  const runs = db.select().from(memoryDistillRuns).all()
  expect(runs[0]!.outcome).toBe('produced')            // NOT 'llm_error'
  expect(runs[0]!.acceptedCount).toBe(1)
  const job = db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId)).all()[0]!
  expect(job.status).toBe('done')
})

test('tick writes run record outcome=produced with correct count chain', async () => {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e', runtime: 'claude-code', cwd: '/r', debounceKey: 'k', debounceMs: 0, sessionId: 's4' })
  await db.insert(memoryDistillEvents).values({ distillJobId: jobId, attemptIndex: 0, ts: Date.now(), kind: 'conversation', payload: JSON.stringify([{ role: 'user', content: 'hi' }]) })
  await forceDue(jobId)
  // distill 返回 2 候选 -> dedup 全留 2 -> valueFilter 全留 2（decision）-> 入库 2
  let phase = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'hi' }] as any, fullLength: 1, prefixTurns: [] }),
    callLLM: async () => {
      phase++
      if (phase === 1) return JSON.stringify({ candidates: [
        { title: '[category:convention] a', bodyMd: 'b', scope: 'project', runtime: 'claude-code', distillAction: 'new' },
        { title: '[category:convention] c', bodyMd: 'd', scope: 'project', runtime: 'claude-code', distillAction: 'new' },
      ] })
      if (phase === 2) return JSON.stringify({ groups: [{ action: 'keep', members: ['new-0'] }, { action: 'keep', members: ['new-1'] }] })  // 合并步全留
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }, { index: 1, category: 'decision' }] })  // valueFilter
    },
    createCandidate: async (_d: any, input: any) => ({ id: 'c' + input.title, status: 'candidate', version: 1 } as any),
  })
  const runs = db.select().from(memoryDistillRuns).all()
  const r = runs[0]!
  expect(r.outcome).toBe('produced')
  expect(r.distilledCount).toBe(2)
  expect(r.acceptedCount).toBe(2)
  expect(r.dedupedCount).toBe(2)
  expect(r.filteredCount).toBe(2)
  expect(r.storedCount).toBe(2)
  expect(r.discardedCount).toBe(0)
})

test('tick writes source-input snapshot even when 0 candidates kept (去门)', async () => {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e', runtime: 'claude-code', cwd: '/r', debounceKey: 'k', debounceMs: 0, sessionId: 's5' })
  await db.insert(memoryDistillEvents).values({ distillJobId: jobId, attemptIndex: 0, ts: Date.now(), kind: 'conversation', payload: JSON.stringify([{ role: 'user', content: 'hi' }]) })
  await forceDue(jobId)
  await tick(db, { loadTranscript: async () => ({ turns: [{ role: 'user', content: 'hi' }] as any, fullLength: 1, prefixTurns: [] }), callLLM: async () => JSON.stringify({ candidates: [] }), createCandidate: async (_d: any, input: any) => ({ id: 'c', status: 'candidate', version: 1 } as any) })
  const snaps = db.select().from(memoryDistillInputs).all()
  expect(snaps.length).toBe(1)  // 去门后 0 候选也写
})

test('tick still marks done when saveDistillRun throws', async () => {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e', runtime: 'claude-code', cwd: '/r', debounceKey: 'k', debounceMs: 0, sessionId: 's6' })
  await db.insert(memoryDistillEvents).values({ distillJobId: jobId, attemptIndex: 0, ts: Date.now(), kind: 'conversation', payload: JSON.stringify([{ role: 'user', content: 'hi' }]) })
  await forceDue(jobId)
  const origInsert = db.insert.bind(db)
  ;(db as any).insert = (table: unknown) => { if (table === memoryDistillRuns) throw new Error('write fail'); return origInsert(table as any) }
  try {
    await tick(db, { loadTranscript: async () => ({ turns: [{ role: 'user', content: 'hi' }] as any, fullLength: 1, prefixTurns: [] }), callLLM: async () => JSON.stringify({ candidates: [] }), createCandidate: async (_d: any, input: any) => ({ id: 'c', status: 'candidate', version: 1 } as any) })
  } finally { (db as any).insert = origInsert }
  const job = db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId)).all()[0]!
  expect(job.status).toBe('done')
})

// ---------------------------------------------------------------------------
// Task 4（distill-error-capture）：scheduler 接线 errorMessage。
// llm_error 时 distill run 记 errorMessage + job.last_error 回写（/api/status
// 的 lastError 查 j.lastError 非空 -> 顶部状态栏能看到 LLM 错误）；produced
// 不写 job.last_error（回归锁：避免成功 job 被误标错误）。
// ---------------------------------------------------------------------------

test('llm_error: 3 次失败暂停后 run 记 errorMessage + job.last_error + paused（Task 7）', async () => {
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0,
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId)).run()
  for (let i = 0; i < 3; i++) {
    await tick(db, {
      loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1, prefixTurns: [] }),
      callLLM: async () => { throw new Error('500 Internal Server Error') },
      createCandidate: async () => ({ id: 'c', status: 'candidate', version: 1 } as any),
    })
    if (i < 2) await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId)).run()
  }
  // distill run 记录 errorMessage（3 轮汇总）
  const run = await db.select().from(memoryDistillRuns).where(eq(memoryDistillRuns.distillJobId, jobId)).all()
  expect(run[0]!.outcome).toBe('llm_error')
  expect(run[0]!.errorMessage).toContain('500 Internal Server Error')
  // job.last_error 回写（/api/status lastError 生效）+ 暂停非 done
  const job = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId)).all()
  expect(job[0]!.lastError).toContain('500 Internal Server Error')
  expect(job[0]!.status).toBe('paused')
})

test('produced: scheduler does NOT write job.last_error', async () => {
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0,
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId)).run()
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'refund 14 days' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async (sys) => {
      if (sys.includes('memside-distiller')) return JSON.stringify({ candidates: [{ title: '[category:invariant] 14d', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    },
    createCandidate: async () => ({ id: 'c', status: 'candidate', version: 1 } as any),
  })
  const job = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId)).all()
  expect(job[0]!.lastError).toBeNull()
  expect(job[0]!.status).toBe('done')
})

test('tick 对 subagent job 的候选强制降级 origin 为 agent-observed', async () => {
  // spec §3.3：job.sourceAgentId 非空 -> distillTranscript 收到 sourceKind='subagent'
  // -> 候选 origin 被降级。用既有 tick harness：enqueue subagent job + fake loadTranscript
  // + callCount 分派 mock。distill 返回 origin='user-stated'；dedup 无 existing 短路；
  // judgeValue 返回 keep。断言 createCandidate 收到的 input.origin === 'agent-observed'。
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1',
    debounceMs: 0, sourceAgentId: 'agent-1',
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let captured: any = null
  let callCount = 0
  await tick(db, {
    // Task 8 起 subagent job 有琐碎下限（<1000 字 -> skipped_trivial 不调 LLM）；
    // 本用例锁 origin 降级，需越过琐碎下限。
    loadTranscript: async () => ({ turns: [{ role: 'user', content: `You are implementing Task 1 ${'y'.repeat(1200)}` }], fullLength: 1, prefixTurns: [] }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:convention] t', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new', origin: 'user-stated', evidence: 'Do not change anything outside this task scope' }] })
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    },
    createCandidate: async (_db, input) => { captured = input; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(captured).not.toBeNull()
  expect(captured.origin).toBe('agent-observed')
  expect(captured.sourceKind).toBe('subagent')
})

// ---------------------------------------------------------------------------
// Task 5（2026-08-15 parse-error-visibility §5.5）：tick outcome 真值表接线。
// 调用未抛错但解析重试耗尽 -> parse_error（rawText 截断落盘 + errorMessage +
// job.last_error 回写 + parse_error 通知），不再假扮 empty_output。
// seed/驱动 tick 模式镜像上方 llm_error 用例（无 sessionId -> 跳过滚动账本路径，
// LLM 只被 distill 三次重试调用）。
// ---------------------------------------------------------------------------

test('tick: 三 tick 解析全败 -> 暂停 + outcome=parse_error + rawText 落盘 + last_error（Task 7 语义）', async () => {
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0,
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId)).run()
  for (let i = 0; i < 3; i++) {
    await tick(db, {
      loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1, prefixTurns: [] }),
      callLLM: async () => 'total garbage not json',
      createCandidate: async () => ({ id: 'c', status: 'candidate', version: 1 } as any),
    })
    if (i < 2) await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId)).run()
  }
  // 1. run 记录 outcome=parse_error（非 abort 失败归解析侧）
  const runs = await db.select().from(memoryDistillRuns).where(eq(memoryDistillRuns.distillJobId, jobId)).all()
  expect(runs[0]!.outcome).toBe('parse_error')
  // 2. errorMessage 含失败原因；rawText 从 llm_round 末轮读回落盘（未超 cap 不截断）
  expect(runs[0]!.errorMessage).toBeTruthy()
  expect(runs[0]!.rawText).toBe('total garbage not json')
  // 3. job.last_error 回写 + 暂停（非 done）
  const job = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId)).all()
  expect(job[0]!.lastError).toBeTruthy()
  expect(job[0]!.status).toBe('paused')
  // 4. 暂停汇总通知（kind=llm_error，title=step_failed）
  const notifs = await db.select().from(notifications).where(eq(notifications.refId, jobId)).all()
  expect(notifs.some((n) => n.kind === 'llm_error' && n.title === 'distill_failed')).toBe(true)
})

test('tick: 合法 {"candidates":[]} -> outcome=empty_output 且 rawText 为 null（真空回归锁）', async () => {
  // 合法空产出不得被新 parse_error 分支误吞：empty_output 保持 rawText/errorMessage 全 null、
  // 无 parse_error 通知、不回写 last_error。
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0,
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId)).run()
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async () => '{"candidates":[]}',
    createCandidate: async () => ({ id: 'c', status: 'candidate', version: 1 } as any),
  })
  const runs = await db.select().from(memoryDistillRuns).where(eq(memoryDistillRuns.distillJobId, jobId)).all()
  expect(runs[0]!.outcome).toBe('empty_output')
  expect(runs[0]!.rawText).toBeNull()
  expect(runs[0]!.errorMessage).toBeNull()
  const notifs = await db.select().from(notifications).where(eq(notifications.refId, jobId)).all()
  expect(notifs.filter((n) => n.kind === 'parse_error').length).toBe(0)
  const job = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId)).all()
  expect(job[0]!.lastError).toBeNull()
})

test('tick: capRawText 接线——暂停时超长垃圾输出落盘已截断（头8000+尾16000）（Task 7 语义）', async () => {
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0,
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId)).run()
  for (let i = 0; i < 3; i++) {
    await tick(db, {
      loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1, prefixTurns: [] }),
      callLLM: async () => 'x'.repeat(30000),
      createCandidate: async () => ({ id: 'c', status: 'candidate', version: 1 } as any),
    })
    if (i < 2) await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId)).run()
  }
  const runs = await db.select().from(memoryDistillRuns).where(eq(memoryDistillRuns.distillJobId, jobId)).all()
  expect(runs[0]!.outcome).toBe('parse_error')
  const raw = runs[0]!.rawText!
  expect(raw.length).toBeLessThan(25000)
  expect(raw).toContain('…[截断 6000 字]…')
})
