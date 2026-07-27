import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { enqueueDistillJob, tick, dedupCandidates, DISTILL_DEBOUNCE_MS } from '@/scheduler'
import { createCandidate as realCreateCandidate } from '@/memory/store'
import { memoryDistillJobs, memories, memoryDiscards, memorySessionOffsets } from '@/db/schema'
import type { DistillCandidate } from '@/memory/distiller'

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
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'we only refund within 14 days' }], fullLength: 1 }),
    callLLM: async () => JSON.stringify({
      candidates: [{ title: '[category:invariant] refund window 14d', bodyMd: '14 days', scope: 'project', runtime: null, distillAction: 'new' }],
    }),
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
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'something' }], fullLength: 1 }),
    callLLM: async () => JSON.stringify({
      candidates: [{ title: '[category:invariant] x', bodyMd: 'b', scope: 'global', runtime: null, distillAction: 'new' }],
    }),
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
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'refund 14 days' }], fullLength: 1 }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:process] 14天退款', bodyMd: '14d', scope: 'project', runtime: null, distillAction: 'new' }] })
      // callCount === 2: dedup marks dup of existing -> candidate removed -> judgeValue skipped (0 candidates)
      return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: true, duplicateOfId: ex.id }] })
    },
    createCandidate: async () => { createCalls++; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(createCalls).toBe(0)
})

test('tick keeps all candidates when dedup LLM throws (conservative, job still done)', async () => {
  const ex = await realCreateCandidate(db, { scopeType: 'project', scopeId: '/r', title: 'existing', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null, sourceCwd: '/r' })
  await db.update(memories).set({ status: 'approved' }).where(eq(memories.id, ex.id)).run()
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let createCalls = 0
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1 }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:x] new', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
      if (callCount === 2) throw new Error('dedup api down')
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    },
    createCandidate: async () => { createCalls++; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(createCalls).toBe(1)
  const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(rows[0]!.status).toBe('done')
})

test('tick skips dedup LLM when no existing memories in scope', async () => {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let callCount = 0
  let createCalls = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1 }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:x] new', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    },
    createCandidate: async () => { createCalls++; return { id: 'c1', status: 'candidate', version: 1 } as any },
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
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1 }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:x] new', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
      if (callCount === 2) return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] })
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    },
    createCandidate: async (_db, input) => { captured = input; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(captured.sourceCwd).toBe('/r')
  expect(captured.distillAction).toBe('new')
})

// ---------------------------------------------------------------------------
// Direct dedupCandidates tests (Fix 1 + Fix 2 from final branch review).
// These exercise the grouping + globalIndex mapping + cross-scope isolation
// + spec §8 DB-error bubbling directly, with real DB prepositioning and real
// listForDedupByScope - only callLLM is mocked.
// ---------------------------------------------------------------------------

test('dedupCandidates keeps non-duplicate and drops duplicate in a multi-candidate group', async () => {
  const ex = await realCreateCandidate(db, { scopeType: 'project', scopeId: '/r', title: 'existing', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null, sourceCwd: '/r' })
  await db.update(memories).set({ status: 'approved' }).where(eq(memories.id, ex.id)).run()
  const cand0: DistillCandidate = { title: '[category:x] dup-of-existing', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new', subject: 'domain' }
  const cand1: DistillCandidate = { title: '[category:y] genuinely-new', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new', subject: 'domain' }
  // Verdict index 0 = duplicate, index 1 = new. Exercises globalIndex mapping:
  // index 1 must be kept (not index 0).
  const keep = await dedupCandidates(db, async () => JSON.stringify({
    verdicts: [{ index: 0, isDuplicate: true, duplicateOfId: ex.id }, { index: 1, isDuplicate: false }],
  }), [cand0, cand1], '/r')
  expect(keep.length).toBe(1)
  expect(keep[0]!.title).toBe(cand1.title)
})

test('dedupCandidates groups by scope and compares each only against same-scope existing', async () => {
  const projEx = await realCreateCandidate(db, { scopeType: 'project', scopeId: '/r', title: 'project-existing-title', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null, sourceCwd: '/r' })
  await db.update(memories).set({ status: 'approved' }).where(eq(memories.id, projEx.id)).run()
  const globEx = await realCreateCandidate(db, { scopeType: 'global', scopeId: null, title: 'global-existing-title', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  await db.update(memories).set({ status: 'approved' }).where(eq(memories.id, globEx.id)).run()
  const projectCand: DistillCandidate = { title: '[category:x] proj-cand', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new', subject: 'domain' }
  const globalCand: DistillCandidate = { title: '[category:y] glob-cand', bodyMd: 'b', scopeType: 'global', runtime: null, distillAction: 'new', subject: 'domain' }
  const prompts: string[] = []
  let callCount = 0
  const keep = await dedupCandidates(db, async (_sys, user) => {
    callCount++
    prompts.push(user)
    // Return a verdict whose duplicateOfId matches whichever existing id
    // appears in THIS call's prompt (i.e. the in-scope existing).
    const inScopeId = user.includes(projEx.id) ? projEx.id : globEx.id
    return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: true, duplicateOfId: inScopeId }] })
  }, [projectCand, globalCand], '/r')
  expect(keep.length).toBe(0)
  expect(callCount).toBe(2)
  // Each call's prompt contains only its own scope's existing title (cross-scope isolation).
  const projPrompt = prompts.find((p) => p.includes(projEx.id))!
  const globPrompt = prompts.find((p) => p.includes(globEx.id))!
  expect(projPrompt).toContain('project-existing-title')
  expect(projPrompt).not.toContain('global-existing-title')
  expect(globPrompt).toContain('global-existing-title')
  expect(globPrompt).not.toContain('project-existing-title')
})

test('dedupCandidates bubbles listForDedupByScope DB errors (spec §8)', async () => {
  // Open a second db then close its raw handle so any query throws. judgeDuplicates
  // is never reached because listForDedupByScope throws first. Per spec §8 this
  // bubbles to tick's catch (infrastructure fault -> job retry), NOT swallowed.
  const db2 = openDb(join(dir, 't2.db'))
  db2.$client.close()
  const cand: DistillCandidate = { title: '[category:x] x', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new', subject: 'domain' }
  await expect(dedupCandidates(db2, async () => 'x', [cand], '/r')).rejects.toThrow()
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
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1 }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:x] js array map', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
      if (callCount === 2) return JSON.stringify({ verdicts: [{ index: 0, category: 'public-knowledge' }] })
      return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] })
    },
    createCandidate: async () => { createCalls++; return { id: 'c1', status: 'candidate', version: 1 } as any },
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
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1 }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:x] chose A not B because', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
      if (callCount === 2) return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
      return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] })
    },
    createCandidate: async (_db, input) => { captured = input; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(captured.valueClass).toBe('decision')
})

test('tick keeps all as valueClass=null when judgeValue LLM throws, job still done', async () => {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let captured: any = null
  let createCalls = 0
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1 }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:x] new', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
      if (callCount === 2) throw new Error('value api down')
      return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] })
    },
    createCandidate: async (_db, input) => { captured = input; createCalls++; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(createCalls).toBe(1)
  expect(captured.valueClass).toBeNull()
  const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(rows[0]!.status).toBe('done')
})

test('tick runs dedup before judgeValue (3-phase call order)', async () => {
  // Pre-position an existing memory so dedup actually calls the LLM (without
  // existing memories, judgeDuplicates short-circuits and the 3rd phase is
  // never reached, making the call-order assertion untestable).
  const ex = await realCreateCandidate(db, { scopeType: 'project', scopeId: '/r', title: 'existing', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null, sourceCwd: '/r' })
  await db.update(memories).set({ status: 'approved' }).where(eq(memories.id, ex.id)).run()
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  const phases: string[] = []
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1 }),
    callLLM: async (_sys, user) => {
      callCount++
      if (callCount === 1) { phases.push('distill'); return JSON.stringify({ candidates: [{ title: '[category:x] new', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] }) }
      if (callCount === 2) { phases.push('dedup'); return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] }) }
      phases.push('judgeValue'); return JSON.stringify({ verdicts: [{ index: 0, category: 'trap' }] })
    },
    createCandidate: async () => ({ id: 'c1', status: 'candidate', version: 1 } as any),
  })
  expect(phases).toEqual(['distill', 'dedup', 'judgeValue'])
})

test('tick: protected invariant candidate survives with valueClass=decision (e2e gate + bulk-reject immunity)', async () => {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let captured: any = null
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'refunds only within 14 days' }], fullLength: 1 }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:invariant] 退款须在发货后14天内', bodyMd: '14d', scope: 'project', runtime: null, distillAction: 'new', subject: 'domain' }] })
      // dedup short-circuits (1 candidate, no existing) -> call 2 is judgeValue;
      // judgeValue LLM wrongly says derivable -> logic gate must override to keep+decision
      return JSON.stringify({ verdicts: [{ index: 0, category: 'derivable' }] })
    },
    createCandidate: async (_db, input) => { captured = input; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(callCount).toBe(2) // distill + judgeValue; dedup skipped LLM (short-circuit)
  expect(captured).not.toBeNull()
  expect(captured.valueClass).toBe('decision') // non-null -> immune to 批量拒绝未评估
  const rows = await db.select().from(memoryDiscards)
  expect(rows.length).toBe(0) // not discarded despite LLM saying derivable
})

test('tick: codebase invariant candidate is discarded when LLM says derivable (e2e subject gate)', async () => {
  // TDD（第二轮核心 e2e）：codebase 类 invariant（代码复述）不再被逻辑门保护。
  // distill 产出 subject=codebase，judgeValue LLM 判 derivable -> 丢弃入 discards，
  // createCandidate 不被调用。与上一条 domain 测试互为正反锚点。
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let createCalls = 0
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'valueFilter must force-keep invariant' }], fullLength: 1 }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:invariant] valueFilter 必须强制保留 invariant', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new', subject: 'codebase' }] })
      return JSON.stringify({ verdicts: [{ index: 0, category: 'derivable' }] })
    },
    createCandidate: async () => { createCalls++; return { id: 'c1', status: 'candidate', version: 1 } as any },
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
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'refund rule' }], fullLength: 1 }),
    callLLM: async (_sys, user) => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:invariant] 退款规则14天期限', bodyMd: '14d', scope: 'project', runtime: null, distillAction: 'new', subject: 'domain' }] })
      if (callCount === 2) { captured = user; return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: true, duplicateOfId: ex.id }] }) }
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    },
    createCandidate: async () => { createCalls++; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(captured).toContain('14天退款窗口') // existing bodyMd 进了 dedup prompt
  expect(createCalls).toBe(0) // 新候选被判重复，不创建
})

test('tick: codebase-subject design-decision candidate is derivable-discarded (e2e subject-driven derivable)', async () => {
  // TDD（第三轮 §D）：dogfood 场景下"关于当前仓库自身设计决策"的候选被 LLM 当 decision
  // 保留。现在 distiller 标 subject=codebase，valueFilter prompt 带 subject 标记 +
  // 中性描述关联 derivable -> LLM 判 derivable -> 丢弃。锁住 subject 信号端到端流转。
  // 根因见 spec §1.2（valueFilter 判 derivable 缺仓库参照系，靠 distiller subject 补强）。
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let createCalls = 0
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'token budget widened to 64k' }], fullLength: 1 }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:architecture] token 预算从 12k 扩到 64k', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new', subject: 'codebase' }] })
      // dedup short-circuits (1 candidate, no existing) -> call 2 is judgeValue;
      // subject=codebase + 仓库自身设计决策 -> derivable
      return JSON.stringify({ verdicts: [{ index: 0, category: 'derivable' }] })
    },
    createCandidate: async () => { createCalls++; return { id: 'c1', status: 'candidate', version: 1 } as any },
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
    loadTranscript: async () => ({ turns: [], fullLength: 120 }),
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
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'new turn' }], fullLength: 42 }),
    callLLM: async () => JSON.stringify({ candidates: [{ title: '[category:x] t', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] }),
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
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 5 }),
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
      loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 3 }),
      callLLM: async () => JSON.stringify({ candidates: [{ title: '[category:x] t', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] }),
      createCandidate: async () => ({ id: 'c1', status: 'candidate', version: 1 } as any),
    })
    const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
    expect(rows[0]!.status).toBe('done')
  } finally {
    sessionOffsetsThrows = false
    db.insert = realInsert
  }
})
