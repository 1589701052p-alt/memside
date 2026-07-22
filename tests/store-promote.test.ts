import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { createCandidate, promoteCandidate, patchMemory } from '@/memory/store'

// Each test gets its own fresh subdirectory under `root`. We only ever wipe
// `root` in `beforeAll` (before any DB is opened), and we close the raw handle
// after each test. This avoids a Windows EBUSY: deleting a directory that still
// contains an open bun:sqlite Database (plus its -wal/-shm sidecars) fails, and
// the OS doesn't release those locks the instant `.close()` returns. Fresh
// subdirs mean we never delete a dir holding an open handle. (Same pattern as
// store-crud.test.ts / schema.test.ts.) The plan's bare `rmSync(tmp)` in
// beforeEach throws EBUSY on Windows and is intentionally NOT used here.
const root = join(import.meta.dir, '.tmp-promo')
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

test('approve moves candidate to approved with approvedAt', async () => {
  const c = await createCandidate(db, { scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  const a = await promoteCandidate(db, c.id, { action: 'approve' })
  expect(a.status).toBe('approved')
  expect(a.approvedAt).not.toBeNull()
})

test('approve_and_supersede marks old row superseded, bumps version', async () => {
  const old = await createCandidate(db, { scopeType: 'global', scopeId: null, title: 'old', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  await promoteCandidate(db, old.id, { action: 'approve' })
  const cand = await createCandidate(db, { scopeType: 'global', scopeId: null, title: 'new', bodyMd: 'b2', tags: [], sourceKind: 'manual', runtime: null })
  const a = await promoteCandidate(db, cand.id, { action: 'approve_and_supersede', supersedeIds: [old.id] })
  expect(a.status).toBe('approved')
  expect(a.version).toBe(2)
  expect(a.supersedesId).toBe(old.id)
})

test('reject moves candidate to rejected', async () => {
  const c = await createCandidate(db, { scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  const r = await promoteCandidate(db, c.id, { action: 'reject' })
  expect(r.status).toBe('rejected')
})

test('patchMemory bumps version only on real change', async () => {
  const c = await createCandidate(db, { scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  const noop = await patchMemory(db, c.id, { title: 't' }) // same title
  expect(noop.memory.version).toBe(1)
  const changed = await patchMemory(db, c.id, { title: 't2' })
  expect(changed.memory.version).toBe(2)
  expect(changed.changedFields).toContain('title')
})

test('promote non-candidate throws', async () => {
  const c = await createCandidate(db, { scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  await promoteCandidate(db, c.id, { action: 'approve' })
  await expect(promoteCandidate(db, c.id, { action: 'approve' })).rejects.toThrow()
})
