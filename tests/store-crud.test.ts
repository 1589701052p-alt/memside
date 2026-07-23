import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { memories, memoryDistillJobs, memoryDiscards } from '@/db/schema'
import { createCandidate, listApprovedByScope, getMemoryById, listForDedupByScope, DEDUP_EXISTING_LIMIT, logDiscards } from '@/memory/store'

// Each test gets its own fresh subdirectory under `root`. We only ever wipe
// `root` in `beforeAll` (before any DB is opened), and we close the raw handle
// after each test. This avoids a Windows EBUSY: deleting a directory that still
// contains an open bun:sqlite Database (plus its -wal/-shm sidecars) fails, and
// the OS doesn't release those locks the instant `.close()` returns. Fresh
// subdirs mean we never delete a dir holding an open handle. (Same pattern as
// schema.test.ts.)
const root = join(import.meta.dir, '.tmp-store')
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

test('createCandidate stores row as candidate', async () => {
  const m = await createCandidate(db, {
    scopeType: 'global', scopeId: null, title: 'Use ULID', bodyMd: 'ids are ULID',
    tags: ['convention'], sourceKind: 'manual', runtime: null,
  })
  expect(m.status).toBe('candidate')
  expect(m.version).toBe(1)
})

test('listApprovedByScope returns only approved, runtime-filtered', async () => {
  const m = await createCandidate(db, {
    scopeType: 'global', scopeId: null, title: 'g1', bodyMd: 'b',
    tags: [], sourceKind: 'manual', runtime: null,
  })
  // approve it via raw update (promote lands in Task 7)
  await db.update(memories).set({ status: 'approved' }).where(eq(memories.id, m.id)).run()
  const set = await listApprovedByScope(db, { projectId: 'p1', runtime: 'claude-code' })
  // global + no runtime tag -> injected for any runtime
  expect(set.byScope.global.length).toBe(1)
  expect(set.byScope.project.length).toBe(0)
})

test('getMemoryById returns row', async () => {
  const m = await createCandidate(db, {
    scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b',
    tags: [], sourceKind: 'manual', runtime: null,
  })
  const got = await getMemoryById(db, m.id)
  expect(got?.memory.id).toBe(m.id)
})

test('createCandidate stores sourceCwd and reads it back', async () => {
  const m = await createCandidate(db, {
    scopeType: 'project', scopeId: '/r', title: 't', bodyMd: 'b',
    tags: [], sourceKind: 'conversation', runtime: null, sourceCwd: '/r',
  })
  expect(m.sourceCwd).toBe('/r')
  const got = await getMemoryById(db, m.id)
  expect(got?.memory.sourceCwd).toBe('/r')
})

test('createCandidate defaults sourceCwd to null when omitted', async () => {
  const m = await createCandidate(db, {
    scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b',
    tags: [], sourceKind: 'manual', runtime: null,
  })
  expect(m.sourceCwd).toBeNull()
})

test('listForDedupByScope returns candidate+approved in same scope', async () => {
  const c = await createCandidate(db, { scopeType: 'project', scopeId: '/r', title: 'cand', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  const a = await createCandidate(db, { scopeType: 'project', scopeId: '/r', title: 'appr', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  await db.update(memories).set({ status: 'approved' }).where(eq(memories.id, a.id)).run()
  const rows = await listForDedupByScope(db, { scopeType: 'project', scopeId: '/r' })
  expect(rows.map((r) => r.id).sort()).toEqual([a.id, c.id].sort())
  expect(rows.every((r) => r.status === 'candidate' || r.status === 'approved')).toBe(true)
})

test('listForDedupByScope excludes other scopes and terminal statuses', async () => {
  await createCandidate(db, { scopeType: 'project', scopeId: '/other', title: 'other scope', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  await createCandidate(db, { scopeType: 'global', scopeId: null, title: 'global scope', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  const rej = await createCandidate(db, { scopeType: 'project', scopeId: '/r', title: 'rejected', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  await db.update(memories).set({ status: 'rejected' }).where(eq(memories.id, rej.id)).run()
  // Cover the remaining terminal statuses (rejected already above); the query
  // selects only candidate+approved, so all three must be excluded.
  const arc = await createCandidate(db, { scopeType: 'project', scopeId: '/r', title: 'archived', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  await db.update(memories).set({ status: 'archived' }).where(eq(memories.id, arc.id)).run()
  const sup = await createCandidate(db, { scopeType: 'project', scopeId: '/r', title: 'superseded', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  await db.update(memories).set({ status: 'superseded' }).where(eq(memories.id, sup.id)).run()
  const rows = await listForDedupByScope(db, { scopeType: 'project', scopeId: '/r' })
  expect(rows.length).toBe(0)
})

test('listForDedupByScope limits candidates to DEDUP_EXISTING_LIMIT', async () => {
  for (let i = 0; i < DEDUP_EXISTING_LIMIT + 5; i++) {
    await createCandidate(db, { scopeType: 'global', scopeId: null, title: `c${i}`, bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  }
  const rows = await listForDedupByScope(db, { scopeType: 'global', scopeId: null })
  expect(rows.length).toBe(DEDUP_EXISTING_LIMIT)
})

test('listForDedupByScope returns approved all + candidate limited', async () => {
  for (let i = 0; i < 3; i++) {
    const m = await createCandidate(db, { scopeType: 'global', scopeId: null, title: `a${i}`, bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
    await db.update(memories).set({ status: 'approved' }).where(eq(memories.id, m.id)).run()
  }
  for (let i = 0; i < DEDUP_EXISTING_LIMIT + 2; i++) {
    await createCandidate(db, { scopeType: 'global', scopeId: null, title: `c${i}`, bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  }
  const rows = await listForDedupByScope(db, { scopeType: 'global', scopeId: null })
  const approved = rows.filter((r) => r.status === 'approved')
  const candidates = rows.filter((r) => r.status === 'candidate')
  expect(approved.length).toBe(3)
  expect(candidates.length).toBe(DEDUP_EXISTING_LIMIT)
})

test('createCandidate stores valueClass and reads it back', async () => {
  const m = await createCandidate(db, {
    scopeType: 'project', scopeId: '/r', title: 't', bodyMd: 'b',
    tags: [], sourceKind: 'manual', runtime: null, valueClass: 'decision',
  })
  expect(m.valueClass).toBe('decision')
  const got = await getMemoryById(db, m.id)
  expect(got?.memory.valueClass).toBe('decision')
})

test('createCandidate defaults valueClass to null when omitted', async () => {
  const m = await createCandidate(db, {
    scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b',
    tags: [], sourceKind: 'manual', runtime: null,
  })
  expect(m.valueClass).toBeNull()
})

test('logDiscards writes rows with title/bodyMd/reason/distillJobId', async () => {
  // need a distill job row for the FK
  db.insert(memoryDistillJobs).values({ id: 'j1', debounceKey: 'k', sourceEventId: 's', runtime: 'claude-code', cwd: '/r', status: 'done', attempts: 0, nextRunAt: 0, createdAt: 0 }).run()
  await logDiscards(db, 'j1', [
    { title: 't1', bodyMd: 'b1', reason: 'public-knowledge' },
    { title: 't2', bodyMd: 'b2', reason: 'derivable' },
  ])
  const rows = await db.select().from(memoryDiscards).orderBy(memoryDiscards.ts)
  expect(rows.length).toBe(2)
  expect(rows[0]!.title).toBe('t1')
  expect(rows[0]!.reason).toBe('public-knowledge')
  expect(rows[0]!.distillJobId).toBe('j1')
})

test('logDiscards is a no-op on empty list', async () => {
  db.insert(memoryDistillJobs).values({ id: 'j2', debounceKey: 'k', sourceEventId: 's', runtime: 'claude-code', cwd: '/r', status: 'done', attempts: 0, nextRunAt: 0, createdAt: 0 }).run()
  await logDiscards(db, 'j2', [])
  const rows = await db.select().from(memoryDiscards)
  expect(rows.length).toBe(0)
})
