import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { memories } from '@/db/schema'
import { createCandidate, listApprovedByScope, getMemoryById } from '@/memory/store'

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
