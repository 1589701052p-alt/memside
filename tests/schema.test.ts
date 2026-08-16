import { test, expect, describe, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  // 旧形态的 memory_distill_jobs（与 MVP DDL 同形态，供 global-via-job 回填溯源）
  old.exec(`CREATE TABLE memory_distill_jobs (id TEXT PRIMARY KEY, debounce_key TEXT NOT NULL, source_event_id TEXT NOT NULL, runtime TEXT NOT NULL, cwd TEXT, scope_resolved_json TEXT, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_run_at INTEGER NOT NULL, last_error TEXT, created_at INTEGER NOT NULL, finished_at INTEGER)`)
  old.exec(`INSERT INTO memory_distill_jobs (id, debounce_key, source_event_id, runtime, cwd, status, attempts, next_run_at, created_at) VALUES ('j1','dk','se1','claude-code','/oldglobal','done',1,1,1)`)
  old.exec(`INSERT INTO memories (id, scope_type, scope_id, title, body_md, tags, status, source_kind, created_at, version) VALUES ('p1','project','/oldproj','t','b','[]','candidate','manual',1,1)`)
  old.exec(`INSERT INTO memories (id, scope_type, scope_id, title, body_md, tags, status, source_kind, created_at, version) VALUES ('g1','global',NULL,'t','b','[]','candidate','manual',1,1)`)
  // g2：global 记忆但带 distill_job_id='j1'，其来源 cwd 应从 job 行恢复
  old.exec(`INSERT INTO memories (id, scope_type, scope_id, distill_job_id, title, body_md, tags, status, source_kind, created_at, version) VALUES ('g2','global',NULL,'j1','t','b','[]','candidate','conversation',1,1)`)
  old.close()

  // openDb 跑 CREATE IF NOT EXISTS(no-op) + 迁移(ALTER + 回填)
  const migrated = openDb(dbPath)
  const cols = migrated.$client.prepare('PRAGMA table_info(memories)').all() as { name: string }[]
  expect(cols.some((c) => c.name === 'source_cwd')).toBe(true)
  const rows = migrated.$client.prepare('SELECT id, source_cwd FROM memories').all() as { id: string; source_cwd: string | null }[]
  // p1：project 行从 scope_id 回填
  expect(rows.find((r) => r.id === 'p1')!.source_cwd).toBe('/oldproj')
  // g2：global 行从 distill_job_id -> job.cwd 恢复（NEW）
  expect(rows.find((r) => r.id === 'g2')!.source_cwd).toBe('/oldglobal')
  // g1：无 distill_job_id（手动），保持 NULL -> UI 显示"手动"/"未知"
  expect(rows.find((r) => r.id === 'g1')!.source_cwd).toBeNull()
  migrated.$client.close()

  // 幂等：reopen 不抛（guard 跳过 ALTER，否则 duplicate column 报错）
  const reopened = openDb(dbPath)
  expect((reopened.$client.prepare('PRAGMA table_info(memories)').all() as { name: string }[]).some((c) => c.name === 'source_cwd')).toBe(true)
  reopened.$client.close()
})

test('fresh db has value_class column', () => {
  db = openDb(join(dir, 'vc.db'))
  const cols = db.$client.prepare('PRAGMA table_info(memories)').all() as { name: string }[]
  expect(cols.some((c) => c.name === 'value_class')).toBe(true)
})

test('fresh db has memory_discards table', () => {
  db = openDb(join(dir, 'md.db'))
  const tables = db.$client.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_discards'").all() as { name: string }[]
  expect(tables.length).toBe(1)
})

test('migration adds value_class to pre-existing db, idempotent, no backfill', () => {
  const dbPath = join(dir, 'oldvc.db')
  const old = new Database(dbPath)
  old.exec(`CREATE TABLE memories (id TEXT PRIMARY KEY, scope_type TEXT NOT NULL CHECK (scope_type IN ('project','global')), scope_id TEXT, runtime TEXT, title TEXT NOT NULL, body_md TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, source_kind TEXT NOT NULL, source_cwd TEXT, source_event_id TEXT, distill_job_id TEXT, distill_action TEXT, supersedes_id TEXT, superseded_by_id TEXT, approved_at INTEGER, created_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1, CHECK ((scope_type='global' AND scope_id IS NULL) OR (scope_type='project' AND scope_id IS NOT NULL)))`)
  old.exec(`INSERT INTO memories (id, scope_type, scope_id, title, body_md, tags, status, source_kind, created_at, version) VALUES ('p1','project','/r','t','b','[]','candidate','manual',1,1)`)
  old.close()
  const migrated = openDb(dbPath)
  const cols = migrated.$client.prepare('PRAGMA table_info(memories)').all() as { name: string }[]
  expect(cols.some((c) => c.name === 'value_class')).toBe(true)
  // no backfill: existing row stays NULL
  const rows = migrated.$client.prepare('SELECT id, value_class FROM memories').all() as { id: string; value_class: string | null }[]
  expect(rows.find((r) => r.id === 'p1')!.value_class).toBeNull()
  migrated.$client.close()
  // idempotent: reopen doesn't throw (guard skips ALTER)
  const reopened = openDb(dbPath)
  expect((reopened.$client.prepare('PRAGMA table_info(memories)').all() as { name: string }[]).some((c) => c.name === 'value_class')).toBe(true)
  reopened.$client.close()
})

test('fresh db has memory_session_offsets table', () => {
  db = openDb(join(dir, 'mso.db'))
  const tables = db.$client.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_session_offsets'").all() as { name: string }[]
  expect(tables.length).toBe(1)
  const cols = db.$client.prepare('PRAGMA table_info(memory_session_offsets)').all() as { name: string }[]
  expect(cols.some((c) => c.name === 'session_id')).toBe(true)
  expect(cols.some((c) => c.name === 'last_turn_offset')).toBe(true)
  expect(cols.some((c) => c.name === 'updated_at')).toBe(true)
})

test('fresh db has session_id column on memory_distill_jobs', () => {
  db = openDb(join(dir, 'sid.db'))
  const cols = db.$client.prepare('PRAGMA table_info(memory_distill_jobs)').all() as { name: string }[]
  expect(cols.some((c) => c.name === 'session_id')).toBe(true)
})

test('migration adds session_id to pre-existing memory_distill_jobs, idempotent', () => {
  const dbPath = join(dir, 'oldsid.db')
  // 旧形态库：memory_distill_jobs 无 session_id 列（第四轮及之前形态）
  const old = new Database(dbPath)
  old.exec(`CREATE TABLE memory_distill_jobs (id TEXT PRIMARY KEY, debounce_key TEXT NOT NULL, source_event_id TEXT NOT NULL, runtime TEXT NOT NULL, cwd TEXT, scope_resolved_json TEXT, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_run_at INTEGER NOT NULL, last_error TEXT, created_at INTEGER NOT NULL, finished_at INTEGER)`)
  old.close()
  const migrated = openDb(dbPath)
  const cols = migrated.$client.prepare('PRAGMA table_info(memory_distill_jobs)').all() as { name: string }[]
  expect(cols.some((c) => c.name === 'session_id')).toBe(true)
  migrated.$client.close()
  // 幂等：reopen 不抛（guard 跳过 ALTER，否则 duplicate column 报错）
  const reopened = openDb(dbPath)
  expect((reopened.$client.prepare('PRAGMA table_info(memory_distill_jobs)').all() as { name: string }[]).some((c) => c.name === 'session_id')).toBe(true)
  reopened.$client.close()
})

test('fresh db has memory_distill_inputs table with required columns', () => {
  db = openDb(join(dir, 'mdi.db'))
  const tables = db.$client.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_distill_inputs'").all() as { name: string }[]
  expect(tables.length).toBe(1)
  const cols = db.$client.prepare('PRAGMA table_info(memory_distill_inputs)').all() as { name: string }[]
  expect(cols.some((c) => c.name === 'distill_job_id')).toBe(true)
  expect(cols.some((c) => c.name === 'turns_json')).toBe(true)
  expect(cols.some((c) => c.name === 'turn_count')).toBe(true)
  expect(cols.some((c) => c.name === 'char_count')).toBe(true)
  expect(cols.some((c) => c.name === 'ts')).toBe(true)
})

test('memory_distill_inputs has no FK to memory_distill_jobs (decoupled cleanup)', () => {
  db = openDb(join(dir, 'mdifk.db'))
  const fks = db.$client.prepare('PRAGMA foreign_key_list(memory_distill_inputs)').all()
  expect(fks.length).toBe(0)
})

test('fresh db has subject_slug column + idx_memories_subject index', () => {
  db = openDb(join(dir, 'ss.db'))
  const cols = db.$client.prepare('PRAGMA table_info(memories)').all() as { name: string }[]
  expect(cols.some((c) => c.name === 'subject_slug')).toBe(true)
  const idx = db.$client.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memories_subject'").all() as { name: string }[]
  expect(idx.length).toBe(1)
})

test('migration adds subject_slug to pre-existing db, idempotent, no backfill', () => {
  const dbPath = join(dir, 'oldss.db')
  // 旧形态库：有 value_class、无 subject_slug（subject-keyed 聚合之前的形态）
  const old = new Database(dbPath)
  old.exec(`CREATE TABLE memories (id TEXT PRIMARY KEY, scope_type TEXT NOT NULL CHECK (scope_type IN ('project','global')), scope_id TEXT, runtime TEXT, title TEXT NOT NULL, body_md TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, source_kind TEXT NOT NULL, source_cwd TEXT, source_event_id TEXT, distill_job_id TEXT, distill_action TEXT, supersedes_id TEXT, superseded_by_id TEXT, approved_at INTEGER, created_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1, value_class TEXT, CHECK ((scope_type='global' AND scope_id IS NULL) OR (scope_type='project' AND scope_id IS NOT NULL)))`)
  old.exec(`INSERT INTO memories (id, scope_type, scope_id, title, body_md, tags, status, source_kind, created_at, version) VALUES ('p1','project','/r','t','b','[]','candidate','manual',1,1)`)
  old.close()
  const migrated = openDb(dbPath)
  const cols = migrated.$client.prepare('PRAGMA table_info(memories)').all() as { name: string }[]
  expect(cols.some((c) => c.name === 'subject_slug')).toBe(true)
  // no backfill: existing row stays NULL（NULL = 未分组，spec §4.2）
  const rows = migrated.$client.prepare('SELECT id, subject_slug FROM memories').all() as { id: string; subject_slug: string | null }[]
  expect(rows.find((r) => r.id === 'p1')!.subject_slug).toBeNull()
  migrated.$client.close()
  // 幂等：reopen 不抛（guard 跳过 ALTER，否则 duplicate column 报错）
  const reopened = openDb(dbPath)
  expect((reopened.$client.prepare('PRAGMA table_info(memories)').all() as { name: string }[]).some((c) => c.name === 'subject_slug')).toBe(true)
  reopened.$client.close()
})

test('fresh db has origin/evidence columns', () => {
  db = openDb(join(dir, 'oe.db'))
  const cols = db.$client.prepare('PRAGMA table_info(memories)').all() as { name: string }[]
  expect(cols.some((c) => c.name === 'origin')).toBe(true)
  expect(cols.some((c) => c.name === 'evidence')).toBe(true)
})

test('migration adds origin/evidence to pre-existing db, idempotent, no backfill', () => {
  const dbPath = join(dir, 'oldoe.db')
  // 旧形态库：有 subject_slug、无 origin/evidence（出处驱动价值判定之前的形态）。
  // source_kind CHECK 含 'subagent' -> 不触发表重建，隔离测试 origin/evidence ALTER 路径。
  const old = new Database(dbPath)
  old.exec(`CREATE TABLE memories (id TEXT PRIMARY KEY, scope_type TEXT NOT NULL CHECK (scope_type IN ('project','global')), scope_id TEXT, runtime TEXT, title TEXT NOT NULL, body_md TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, source_kind TEXT NOT NULL CHECK (source_kind IN ('conversation','error','manual','subagent')), source_cwd TEXT, source_event_id TEXT, distill_job_id TEXT, distill_action TEXT, supersedes_id TEXT, superseded_by_id TEXT, approved_at INTEGER, created_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1, value_class TEXT, subject_slug TEXT, CHECK ((scope_type='global' AND scope_id IS NULL) OR (scope_type='project' AND scope_id IS NOT NULL)))`)
  old.exec(`INSERT INTO memories (id, scope_type, scope_id, title, body_md, tags, status, source_kind, created_at, version) VALUES ('p1','project','/r','t','b','[]','candidate','manual',1,1)`)
  old.close()
  const migrated = openDb(dbPath)
  const cols = migrated.$client.prepare('PRAGMA table_info(memories)').all() as { name: string }[]
  expect(cols.some((c) => c.name === 'origin')).toBe(true)
  expect(cols.some((c) => c.name === 'evidence')).toBe(true)
  // no backfill: existing row stays NULL（NULL = 未标注，spec §数据模型）
  const rows = migrated.$client.prepare('SELECT id, origin, evidence FROM memories').all() as { id: string; origin: string | null; evidence: string | null }[]
  expect(rows.find((r) => r.id === 'p1')!.origin).toBeNull()
  expect(rows.find((r) => r.id === 'p1')!.evidence).toBeNull()
  migrated.$client.close()
  // 幂等：reopen 不抛（guard 跳过 ALTER，否则 duplicate column 报错）
  const reopened = openDb(dbPath)
  const reopenedCols = reopened.$client.prepare('PRAGMA table_info(memories)').all() as { name: string }[]
  expect(reopenedCols.some((c) => c.name === 'origin')).toBe(true)
  expect(reopenedCols.some((c) => c.name === 'evidence')).toBe(true)
  reopened.$client.close()
})

test('memories.source_kind accepts subagent (CHECK widened)', () => {
  // 旧 CHECK ('conversation','error','manual') 会拒绝 'subagent'；扩展后必须接受。
  // 沿用 schema.test.ts 既有风格：raw db.insert(memories)（本文件已 import memories + eq）。
  db = openDb(join(dir, 't.db'))
  db.insert(memories).values({
    id: '01SUB', scopeType: 'global', scopeId: null, runtime: null,
    title: '[category:x] sub', bodyMd: 'b', tags: '[]', status: 'candidate',
    sourceKind: 'subagent', createdAt: 1, version: 1,
  }).run()
  const rows = db.select().from(memories).where(eq(memories.id, '01SUB')).all()
  expect(rows[0]!.sourceKind).toBe('subagent')
})

test('memory_distill_jobs has source_agent_id column', () => {
  db = openDb(join(dir, 't.db'))
  const pragma = db!.$client.prepare('PRAGMA table_info(memory_distill_jobs)').all() as { name: string }[]
  expect(pragma.some((c) => c.name === 'source_agent_id')).toBe(true)
})

test('old DB with narrow source_kind CHECK is rebuilt to accept subagent (idempotent)', () => {
  // 模拟旧库：手建一个 source_kind CHECK 不含 subagent 的 memories 表 + 一行数据，
  // 重新 openDb 触发 migration，断言：数据保留 + 'subagent' 插入不再被 CHECK 拒绝 + 幂等。
  const oldDbPath = join(dir, 'old.db')
  const raw = new Database(oldDbPath)
  raw.exec(`CREATE TABLE memories (
    id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_id TEXT, runtime TEXT,
    title TEXT NOT NULL, body_md TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL, source_kind TEXT NOT NULL CHECK (source_kind IN ('conversation','error','manual')),
    source_event_id TEXT, distill_job_id TEXT, distill_action TEXT,
    supersedes_id TEXT, superseded_by_id TEXT, approved_at INTEGER, created_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1, source_cwd TEXT, value_class TEXT, subject_slug TEXT,
    CHECK ((scope_type='global' AND scope_id IS NULL) OR (scope_type='project' AND scope_id IS NOT NULL))
  )`)
  raw.exec(`INSERT INTO memories (id, scope_type, scope_id, runtime, title, body_md, tags, status, source_kind, source_event_id, distill_job_id, distill_action, supersedes_id, superseded_by_id, approved_at, created_at, version, source_cwd, value_class, subject_slug)
    VALUES ('m-old','global',NULL,NULL,'old title','old body','[]','approved','conversation',NULL,NULL,NULL,NULL,NULL,1,100,1,NULL,NULL,NULL)`)
  raw.close()
  // 重新打开 -> 触发 migration（表重建扩展 CHECK）
  const db2 = openDb(oldDbPath)
  // 旧数据保留
  const rows = db2.select().from(memories).all()
  expect(rows.some((r: any) => r.id === 'm-old' && r.title === 'old title')).toBe(true)
  // 'subagent' 现在可插入（CHECK 已扩展）
  db2.insert(memories).values({
    id: 'm-new', scopeType: 'global', scopeId: null, runtime: null,
    title: 'sub', bodyMd: 'b', tags: '[]', status: 'candidate',
    sourceKind: 'subagent', createdAt: 1, version: 1,
  }).run()
  const got = db2.select().from(memories).where(eq(memories.id, 'm-new')).all()
  expect(got[0]!.sourceKind).toBe('subagent')
  db2.$client.close()
  // 再开一次 -> 幂等（不重复重建；'subagent' 仍可插）
  const db3 = openDb(oldDbPath)
  db3.insert(memories).values({
    id: 'm-new2', scopeType: 'global', scopeId: null, runtime: null,
    title: 'sub2', bodyMd: 'b', tags: '[]', status: 'candidate',
    sourceKind: 'subagent', createdAt: 2, version: 1,
  }).run()
  expect(db3.select().from(memories).where(eq(memories.id, 'm-new2')).all().length).toBe(1)
  db3.$client.close()
})

test('memory_discards has scope/source columns after migration', () => {
  db = openDb(join(dir, 't.db'))
  const cols = db.$client.prepare('PRAGMA table_info(memory_discards)').all() as { name: string }[]
  const names = cols.map((c) => c.name)
  expect(names).toContain('scope_type')
  expect(names).toContain('scope_id')
  expect(names).toContain('source_cwd')
  expect(names).toContain('runtime')
  expect(names).toContain('source_kind')
  expect(names).toContain('promoted_memory_id')
})

test('memory_discards migration is idempotent (reopen)', () => {
  const path = join(dir, 't.db')
  const db1 = openDb(path)
  db1.$client.close()
  db = openDb(path)  // 二次打开，迁移再跑一次，不应报错
  const cols = db.$client.prepare('PRAGMA table_info(memory_discards)').all() as { name: string }[]
  expect(cols.filter((c) => c.name === 'scope_type').length).toBe(1)  // 不重复加列
})

test('fresh db has error_message column on memory_distill_runs', () => {
  db = openDb(join(dir, 'em.db'))
  const cols = db.$client.prepare('PRAGMA table_info(memory_distill_runs)').all() as { name: string }[]
  expect(cols.some((c) => c.name === 'error_message')).toBe(true)
})

test('migration adds error_message to pre-existing memory_distill_runs, idempotent, no backfill', () => {
  const dbPath = join(dir, 'oldem.db')
  // 旧形态库：memory_distill_runs 无 error_message 列
  const old = new Database(dbPath)
  old.exec(`CREATE TABLE memory_distill_runs (distill_job_id TEXT PRIMARY KEY, outcome TEXT NOT NULL, raw_output_json TEXT, distilled_count INTEGER NOT NULL, accepted_count INTEGER NOT NULL, deduped_count INTEGER NOT NULL, filtered_count INTEGER NOT NULL, stored_count INTEGER NOT NULL, discarded_count INTEGER NOT NULL, duration_ms INTEGER NOT NULL, ts INTEGER NOT NULL)`)
  old.exec(`INSERT INTO memory_distill_runs (distill_job_id, outcome, raw_output_json, distilled_count, accepted_count, deduped_count, filtered_count, stored_count, discarded_count, duration_ms, ts) VALUES ('j1','llm_error',NULL,0,0,0,0,0,0,1234,1)`)
  old.close()
  const migrated = openDb(dbPath)
  const cols = migrated.$client.prepare('PRAGMA table_info(memory_distill_runs)').all() as { name: string }[]
  expect(cols.some((c) => c.name === 'error_message')).toBe(true)
  // no backfill: existing row stays NULL
  const rows = migrated.$client.prepare('SELECT distill_job_id, error_message FROM memory_distill_runs').all() as { distill_job_id: string; error_message: string | null }[]
  expect(rows.find((r) => r.distill_job_id === 'j1')!.error_message).toBeNull()
  migrated.$client.close()
  // 幂等：reopen 不抛（guard 跳过 ALTER，否则 duplicate column 报错）
  const reopened = openDb(dbPath)
  expect((reopened.$client.prepare('PRAGMA table_info(memory_distill_runs)').all() as { name: string }[]).some((c) => c.name === 'error_message')).toBe(true)
  reopened.$client.close()
})

test('app_settings table exists with expected columns (idempotent on reopen)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memside-schema-'))
  const p = join(dir, 't.db')
  openDb(p).$client.close()
  const db = openDb(p) // 二次打开：迁移幂等不抛错
  const raw = (db as any).$client as import('bun:sqlite').Database
  const cols = raw.prepare("PRAGMA table_info(app_settings)").all() as { name: string }[]
  expect(cols.map((c) => c.name).sort()).toEqual(['key', 'updated_at', 'value'])
})

describe('distill-batching schema（spec §4.5）', () => {
  test('新库：三个新表 + last_capture_at 列 + waiting 状态可插入', async () => {
    // 注：brief 原文用 openDb(':memory:')，但 client.ts 的 mkdirSync(dirname(path))
    // 对 ':memory:' 会在 bun 下抛 EEXIST(mkdir '.')，改用本文件既有的 fresh-dir 文件库模式。
    db = openDb(join(dir, 'batch.db'))
    const cols = db.$client.prepare('PRAGMA table_info(memory_distill_jobs)').all() as { name: string }[]
    expect(cols.some((c) => c.name === 'last_capture_at')).toBe(true)
    // waiting 状态可插入（无 CHECK 约束回归锁：spec §4.5 已核实 live DB 无 CHECK）
    db.$client.exec(`INSERT INTO memory_distill_jobs (id, debounce_key, source_event_id, runtime, status, attempts, next_run_at, created_at)
      VALUES ('j1', 'k', 'e', 'claude-code', 'waiting', 0, 0, 0)`)
    db.$client.exec(`INSERT INTO memory_session_flushes (session_id, ts) VALUES ('s1', 1)`)
    db.$client.exec(`INSERT INTO memory_session_digests (session_id, digest, mode, updated_at) VALUES ('s1', 'd', 'llm', 1)`)
    db.$client.exec(`INSERT INTO memory_degradations (id, ts, kind) VALUES ('g1', 1, 'sweep_error')`)
  })
  test('幂等：模拟老库（无 last_capture_at、无新表）openDb 两次不炸且补齐', async () => {
    const path = join(tmpdir(), `memside-schema-batch-${Date.now()}.db`)
    // 手工建"老库"：只建旧版 jobs 表
    const raw = new Database(path)
    raw.exec(`CREATE TABLE memory_distill_jobs (
      id TEXT PRIMARY KEY, debounce_key TEXT NOT NULL, source_event_id TEXT NOT NULL,
      runtime TEXT NOT NULL, cwd TEXT, session_id TEXT, source_agent_id TEXT,
      scope_resolved_json TEXT, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      next_run_at INTEGER NOT NULL, last_error TEXT, created_at INTEGER NOT NULL, finished_at INTEGER)`)
    raw.close()
    const db1 = openDb(path)  // 第一次：迁移执行
    db1.$client.close()
    const db2 = openDb(path)  // 第二次：幂等不炸
    const cols = db2.$client.prepare('PRAGMA table_info(memory_distill_jobs)').all() as { name: string }[]
    expect(cols.some((c) => c.name === 'last_capture_at')).toBe(true)
    db2.$client.close()
    // 注：brief 原文此处 rmSync(path)，但 Windows 上 bun:sqlite close 后 WAL 锁不立即释放
    // （见本文件头部注释），rmSync 会 EBUSY。tmp 文件留在 tmpdir 无害，与 app_settings 测试同模式。
  })
})

test('notifications 表列齐全（spec 2026-08-12 §5.1）', () => {
  db = openDb(join(dir, 'notif.db'))
  const cols = db.$client.prepare('PRAGMA table_info(notifications)').all() as { name: string }[]
  const names = cols.map((c) => c.name)
  for (const n of ['id', 'ts', 'kind', 'title', 'body', 'ref_type', 'ref_id', 'read_at']) {
    expect(names).toContain(n)
  }
})

test('memory_distill_runs 含 digest_ms/dedup_ms/judge_ms（spec §5.4）', () => {
  db = openDb(join(dir, 'timing.db'))
  const cols = db.$client.prepare('PRAGMA table_info(memory_distill_runs)').all() as { name: string }[]
  const names = cols.map((c) => c.name)
  for (const n of ['digest_ms', 'dedup_ms', 'judge_ms']) expect(names).toContain(n)
})

test('memory_distill_runs has raw_text column (spec 2026-08-15 §5.4)', () => {
  db = openDb(join(dir, 'rawtext.db'))
  const cols = db.$client.prepare('PRAGMA table_info(memory_distill_runs)').all() as { name: string }[]
  expect(cols.some((c) => c.name === 'raw_text')).toBe(true)
})

test('notifications 索引存在', () => {
  db = openDb(join(dir, 'notifidx.db'))
  const idx = db.$client.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='notifications'").all() as { name: string }[]
  const names = idx.map((i) => i.name)
  expect(names).toContain('idx_notifications_ts')
  expect(names).toContain('idx_notifications_read')
})

test('memory_trash table exists with required columns', () => {
  db = openDb(join(dir, 'trash.db'))
  const cols = db.$client.prepare('PRAGMA table_info(memory_trash)').all() as { name: string }[]
  const names = cols.map((c) => c.name)
  expect(names).toContain('id')
  expect(names).toContain('memory_snapshot')
  expect(names).toContain('original_memory_id')
  expect(names).toContain('deleted_at')
  expect(names).toContain('title')
  // 索引存在
  const idx = db.$client.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memory_trash'").all() as { name: string }[]
  expect(idx.some((i) => i.name === 'idx_trash_deleted_at')).toBe(true)
})
