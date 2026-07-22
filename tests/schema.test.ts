import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb, type DbClient } from '@/db/client'
import { memories } from '@/db/schema'
import { eq } from 'drizzle-orm'

const root = join(import.meta.dir, '.tmp-schema')

// Each test gets its own fresh subdirectory under `root`. We only ever wipe
// `root` in `beforeAll` (before any DB is opened), and we close the raw handle
// after each test. This avoids a Windows EBUSY: deleting a directory that still
// contains an open bun:sqlite Database (plus its -wal/-shm sidecars) fails, and
// the OS doesn't release those locks the instant `.close()` returns. Fresh
// subdirs mean we never delete a dir holding an open handle.
let dir = ''
let db: DbClient | null = null

beforeAll(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
})

beforeEach(() => {
  dir = join(root, Math.random().toString(36).slice(2))
  mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  if (db) {
    db.$client.close()
    db = null
  }
})

test('can insert + query a memory row', async () => {
  db = openDb(join(dir, 't.db'))
  await db.insert(memories).values({
    id: '01TEST',
    scopeType: 'global',
    scopeId: null,
    title: 't',
    bodyMd: 'b',
    tags: '[]',
    status: 'candidate',
    sourceKind: 'manual',
    createdAt: 1,
    version: 1,
  })
  const rows = await db.select().from(memories).where(eq(memories.id, '01TEST'))
  expect(rows.length).toBe(1)
  expect(rows[0]!.title).toBe('t')
})

test('global scope rejects non-null scope_id (CHECK constraint)', async () => {
  db = openDb(join(dir, 't2.db'))
  // `.execute()` converts drizzle's QueryPromise (a custom thenable, not a
  // native Promise) into a native Promise. bun:test's `.rejects` matcher only
  // assimilates native Promises, so the bare `db.insert(...).values(...)`
  // thenable is treated as a resolved value and the assertion fails spuriously.
  await expect(
    db.insert(memories).values({
      id: '02TEST', scopeType: 'global', scopeId: 'x', title: 't', bodyMd: 'b',
      tags: '[]', status: 'candidate', sourceKind: 'manual', createdAt: 1, version: 1,
    }).execute(),
  ).rejects.toThrow()
})
