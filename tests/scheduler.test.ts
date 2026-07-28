import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { enqueueDistillJob, tick, dedupCandidates, DISTILL_DEBOUNCE_MS } from '@/scheduler'
import { createCandidate as realCreateCandidate } from '@/memory/store'
import { memoryDistillJobs, memoryDistillEvents, memories, memoryDiscards, memorySessionOffsets, memoryDistillInputs } from '@/db/schema'
import type { DistillCandidate } from '@/memory/distiller'
import { makeLoadTranscript } from '@/daemon'

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
  const cand0: DistillCandidate = { title: '[category:x] dup-of-existing', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new', ruleObject: 'domain', subjectSlug: null }
  const cand1: DistillCandidate = { title: '[category:y] genuinely-new', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new', ruleObject: 'domain', subjectSlug: null }
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
  const projectCand: DistillCandidate = { title: '[category:x] proj-cand', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new', ruleObject: 'domain', subjectSlug: null }
  const globalCand: DistillCandidate = { title: '[category:y] glob-cand', bodyMd: 'b', scopeType: 'global', runtime: null, distillAction: 'new', ruleObject: 'domain', subjectSlug: null }
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
  const cand: DistillCandidate = { title: '[category:x] x', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new', ruleObject: 'domain', subjectSlug: null }
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
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:invariant] 退款须在发货后14天内', bodyMd: '14d', scope: 'project', runtime: null, distillAction: 'new', ruleObject: 'domain' }] })
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

test('tick: codebase invariant candidate is discarded when LLM says derivable (e2e ruleObject gate)', async () => {
  // TDD（第二轮核心 e2e）：codebase 类 invariant（代码复述）不再被逻辑门保护。
  // distill 产出 ruleObject=codebase，judgeValue LLM 判 derivable -> 丢弃入 discards，
  // createCandidate 不被调用。与上一条 domain 测试互为正反锚点。
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let createCalls = 0
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'valueFilter must force-keep invariant' }], fullLength: 1 }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:invariant] valueFilter 必须强制保留 invariant', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new', ruleObject: 'codebase' }] })
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
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'token budget widened to 64k' }], fullLength: 1 }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:architecture] token 预算从 12k 扩到 64k', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new', ruleObject: 'codebase' }] })
      // dedup short-circuits (1 candidate, no existing) -> call 2 is judgeValue;
      // ruleObject=codebase + 仓库自身设计决策 -> derivable
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
    const result = await loadTranscript({ id: jobId, cwd: '/r', sourceEventId: 'e1', sessionId: 'sess-D' })
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
    callLLM: async () => {
      // 第一次 Stop：3 turns 全量蒸馏。偏移推进由下方 getSessionOffset 断言锁住
      // （distill 的 callLLM 次数受 valueFilter 重试影响，不稳，不在此断言）。
      return JSON.stringify({ candidates: [{ title: '[category:x] t', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
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
      return JSON.stringify({ candidates: [{ title: '[category:x] t2', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
    },
    createCandidate: async () => ({ id: 'c2', status: 'candidate', version: 1 } as any),
  })
  // 第二次：偏移已从 3 推进到 5（核心不可让步断言之一）
  expect(await getSessionOffset(db, 'sess-e2e')).toBe(5)
  // 第二次蒸馏的 prompt 只含新增 turn D/E，不含旧 turn A/B/C。
  // 注意取 [0]：tick 内 LLM 调用顺序固定为 distill(1次) -> dedup(短路不调)
  // -> judgeValue(最多 3 次重试)。distill 是第一次调用，其 user prompt 由
  // distiller.renderUserPrompt 拼成 `[user] ${content}`，含完整 transcript。
  // 取末次会是 valueFilter 的 retry prompt（含候选 title 而非 transcript），不含 turns。
  const distillPrompt = distillInputTurns[0]!
  expect(distillPrompt).toContain('turn D (new)')
  expect(distillPrompt).toContain('turn E (new)')
  expect(distillPrompt).not.toContain('turn A')
  expect(distillPrompt).not.toContain('turn B')
  expect(distillPrompt).not.toContain('turn C')
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
    callLLM: async () => JSON.stringify({ candidates: [{ title: '[category:x] t', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] }),
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
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'always agree with me' }], fullLength: 1 }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [
        { title: '[category:convention] 永远同意我的决定', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' },
        { title: '[category:convention] PR 必须加测试', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' },
      ] })
      if (callCount === 2) return JSON.stringify({ verdicts: [
        { index: 0, isDuplicate: false },
        { index: 1, isDuplicate: false },
      ] })  // dedup: 2 候选 + 无 existing -> 比较兄弟，都不重复
      return JSON.stringify({ verdicts: [
        { index: 0, category: 'convention' },
        { index: 1, category: 'convention' },
      ] })  // judgeValue: 都 convention -> taming override 丢弃 #0
    },
    createCandidate: async () => { createCalls++; return { id: 'c1', status: 'candidate', version: 1 } as any },
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
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'we refund within 14 days' }], fullLength: 1 }),
    callLLM: async () => JSON.stringify({ candidates: [{ title: '[category:invariant] refund 14d', bodyMd: '14d', scope: 'project', runtime: null, distillAction: 'new' }] }),
    createCandidate: async () => ({ id: 'c1', status: 'candidate', version: 1 } as any),
  })
  const snaps = await db.select().from(memoryDistillInputs).where(eq(memoryDistillInputs.distillJobId, jobId))
  expect(snaps.length).toBe(1)
  expect(snaps[0]!.turnCount).toBe(1)
  expect(snaps[0]!.turnsJson).toContain('we refund within 14 days')
})

test('tick does NOT write source-input snapshot when 0 candidates kept (all discarded)', async () => {
  // 与既有 public-knowledge 丢弃测试（行 248）同 mock 模式：1 候选 + 无 existing ->
  // dedup 短路（不调 LLM），judgeValue 判 public-knowledge -> 丢弃，0 候选入库。
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1 }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:x] js array map', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
      if (callCount === 2) return JSON.stringify({ verdicts: [{ index: 0, category: 'public-knowledge' }] })
      return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] })
    },
    createCandidate: async () => ({ id: 'c1', status: 'candidate', version: 1 } as any),
  })
  const snaps = await db.select().from(memoryDistillInputs).where(eq(memoryDistillInputs.distillJobId, jobId))
  expect(snaps.length).toBe(0)  // 0 候选入库，不写快照
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
      loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1 }),
      callLLM: async () => JSON.stringify({ candidates: [{ title: '[category:x] t', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] }),
      createCandidate: async () => ({ id: 'c1', status: 'candidate', version: 1 } as any),
    })
    const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
    expect(rows[0]!.status).toBe('done')  // 写失败可吞，job 仍 done
  } finally {
    inputsThrows = false
    db.insert = realInsert
  }
})
