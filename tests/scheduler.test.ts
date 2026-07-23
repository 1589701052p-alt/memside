import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { enqueueDistillJob, tick, dedupCandidates, DISTILL_DEBOUNCE_MS } from '@/scheduler'
import { createCandidate as realCreateCandidate } from '@/memory/store'
import { memoryDistillJobs, memories } from '@/db/schema'
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
    loadTranscript: async () => [{ role: 'user', content: 'we only refund within 14 days' }],
    callAnthropic: async () => JSON.stringify({
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
    loadTranscript: async () => [{ role: 'user', content: 'something' }],
    callAnthropic: async () => JSON.stringify({
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
    callAnthropic: async () => '[]',
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
    loadTranscript: async () => [{ role: 'user', content: 'refund 14 days' }],
    callAnthropic: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:process] 14天退款', bodyMd: '14d', scope: 'project', runtime: null, distillAction: 'new' }] })
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
    loadTranscript: async () => [{ role: 'user', content: 'x' }],
    callAnthropic: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:x] new', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
      throw new Error('dedup api down')
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
    loadTranscript: async () => [{ role: 'user', content: 'x' }],
    callAnthropic: async () => { callCount++; return JSON.stringify({ candidates: [{ title: '[category:x] new', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] }) },
    createCandidate: async () => { createCalls++; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(callCount).toBe(1)
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
    loadTranscript: async () => [{ role: 'user', content: 'x' }],
    callAnthropic: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:x] new', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
      return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] })
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
// listForDedupByScope - only callAnthropic is mocked.
// ---------------------------------------------------------------------------

test('dedupCandidates keeps non-duplicate and drops duplicate in a multi-candidate group', async () => {
  const ex = await realCreateCandidate(db, { scopeType: 'project', scopeId: '/r', title: 'existing', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null, sourceCwd: '/r' })
  await db.update(memories).set({ status: 'approved' }).where(eq(memories.id, ex.id)).run()
  const cand0: DistillCandidate = { title: '[category:x] dup-of-existing', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new' }
  const cand1: DistillCandidate = { title: '[category:y] genuinely-new', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new' }
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
  const projectCand: DistillCandidate = { title: '[category:x] proj-cand', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new' }
  const globalCand: DistillCandidate = { title: '[category:y] glob-cand', bodyMd: 'b', scopeType: 'global', runtime: null, distillAction: 'new' }
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
  const cand: DistillCandidate = { title: '[category:x] x', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new' }
  await expect(dedupCandidates(db2, async () => 'x', [cand], '/r')).rejects.toThrow()
})
