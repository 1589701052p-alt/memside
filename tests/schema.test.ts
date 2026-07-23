import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
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

test('fresh db has source_cwd column', () => {
  db = openDb(join(dir, 't3.db'))
  const cols = db.$client.prepare('PRAGMA table_info(memories)').all() as { name: string }[]
  expect(cols.some((c) => c.name === 'source_cwd')).toBe(true)
})

test('migration adds source_cwd to pre-existing db, backfills project rows, idempotent', () => {
  const dbPath = join(dir, 'old.db')
  // 旧形态库：无 source_cwd 列
  const old = new Database(dbPath)
  old.exec(`CREATE TABLE memories (id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_id TEXT, runtime TEXT, title TEXT NOT NULL, body_md TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, source_kind TEXT NOT NULL, source_event_id TEXT, distill_job_id TEXT, distill_action TEXT, supersedes_id TEXT, superseded_by_id TEXT, approved_at INTEGER, created_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1)`)
  old.exec(`INSERT INTO memories (id, scope_type, scope_id, title, body_md, tags, status, source_kind, created_at, version) VALUES ('p1','project','/oldproj','t','b','[]','candidate','manual',1,1)`)
  old.exec(`INSERT INTO memories (id, scope_type, scope_id, title, body_md, tags, status, source_kind, created_at, version) VALUES ('g1','global',NULL,'t','b','[]','candidate','manual',1,1)`)
  old.close()

  // openDb 跑 CREATE IF NOT EXISTS(no-op) + 迁移(ALTER + 回填)
  const migrated = openDb(dbPath)
  const cols = migrated.$client.prepare('PRAGMA table_info(memories)').all() as { name: string }[]
  expect(cols.some((c) => c.name === 'source_cwd')).toBe(true)
  const rows = migrated.$client.prepare('SELECT id, source_cwd FROM memories').all() as { id: string; source_cwd: string | null }[]
  expect(rows.find((r) => r.id === 'p1')!.source_cwd).toBe('/oldproj')
  expect(rows.find((r) => r.id === 'g1')!.source_cwd).toBeNull()
  migrated.$client.close()

  // 幂等：reopen 不抛（guard 跳过 ALTER，否则 duplicate column 报错）
  const reopened = openDb(dbPath)
  expect((reopened.$client.prepare('PRAGMA table_info(memories)').all() as { name: string }[]).some((c) => c.name === 'source_cwd')).toBe(true)
  reopened.$client.close()
})
