import { drizzle } from 'drizzle-orm/bun-sqlite'
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { memories, memoryDistillJobs, memoryDistillEvents, memoryDiscards, memorySessionOffsets, memoryDistillInputs, memoryDistillRuns } from './schema'

export type DbClient = ReturnType<typeof openDb>

export function openDb(path: string) {
  mkdirSync(dirname(path), { recursive: true })
  const raw = new Database(path)
  raw.exec('PRAGMA journal_mode=WAL')
  raw.exec('PRAGMA synchronous=NORMAL')
  const db = drizzle(raw, { schema: { memories, memoryDistillJobs, memoryDistillEvents, memoryDiscards, memorySessionOffsets, memoryDistillInputs, memoryDistillRuns } })
  // Schema bootstrap (idempotent). DDL lives here so tests need no migration runner.
  raw.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      scope_type TEXT NOT NULL CHECK (scope_type IN ('project','global')),
      scope_id TEXT,
      runtime TEXT CHECK (runtime IN ('claude-code','opencode') OR runtime IS NULL),
      title TEXT NOT NULL,
      body_md TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL CHECK (status IN ('candidate','approved','archived','superseded','rejected')),
      source_kind TEXT NOT NULL CHECK (source_kind IN ('conversation','error','manual','subagent')),
      source_cwd TEXT,
      source_event_id TEXT,
      distill_job_id TEXT,
      distill_action TEXT CHECK (distill_action IN ('new','update_of','duplicate_of','conflict_with') OR distill_action IS NULL),
      supersedes_id TEXT,
      superseded_by_id TEXT,
      approved_at INTEGER,
      created_at INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      subject_slug TEXT,
      CHECK ((scope_type='global' AND scope_id IS NULL) OR (scope_type='project' AND scope_id IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_memories_scope_status ON memories(scope_type, scope_id, status);
    CREATE INDEX IF NOT EXISTS idx_memories_status_created ON memories(status, created_at);
    CREATE TABLE IF NOT EXISTS memory_distill_jobs (
      id TEXT PRIMARY KEY,
      debounce_key TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      runtime TEXT NOT NULL,
      cwd TEXT,
      session_id TEXT,
      source_agent_id TEXT,
      scope_resolved_json TEXT,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_run_at INTEGER NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_distill_jobs_status_next ON memory_distill_jobs(status, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_distill_jobs_debounce ON memory_distill_jobs(debounce_key, status);
    CREATE TABLE IF NOT EXISTS memory_distill_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      distill_job_id TEXT NOT NULL REFERENCES memory_distill_jobs(id) ON DELETE CASCADE,
      attempt_index INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_distill_events_job_attempt ON memory_distill_events(distill_job_id, attempt_index, ts);
    CREATE TABLE IF NOT EXISTS memory_discards (
      id TEXT PRIMARY KEY,
      distill_job_id TEXT NOT NULL REFERENCES memory_distill_jobs(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body_md TEXT NOT NULL,
      reason TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_discards_ts ON memory_discards(ts);
    CREATE TABLE IF NOT EXISTS memory_session_offsets (
      session_id TEXT PRIMARY KEY,
      last_turn_offset INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_distill_inputs (
      distill_job_id TEXT PRIMARY KEY,
      turns_json     TEXT NOT NULL,
      turn_count     INTEGER NOT NULL,
      char_count     INTEGER NOT NULL,
      ts             INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_distill_runs (
      distill_job_id   TEXT PRIMARY KEY,
      outcome          TEXT NOT NULL,
      raw_output_json  TEXT,
      distilled_count  INTEGER NOT NULL,
      accepted_count   INTEGER NOT NULL,
      deduped_count    INTEGER NOT NULL,
      filtered_count   INTEGER NOT NULL,
      stored_count     INTEGER NOT NULL,
      discarded_count  INTEGER NOT NULL,
      duration_ms      INTEGER NOT NULL,
      ts               INTEGER NOT NULL
    );
  `)
  // Idempotent migration: add source_cwd to pre-existing memories tables.
  // CREATE TABLE IF NOT EXISTS is a no-op on existing tables, so a column
  // added in a later release needs an explicit ALTER + backfill.
  {
    const cols = raw.prepare('PRAGMA table_info(memories)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'source_cwd')) {
      raw.exec('ALTER TABLE memories ADD COLUMN source_cwd TEXT')
      raw.exec("UPDATE memories SET source_cwd = scope_id WHERE scope_type = 'project' AND source_cwd IS NULL")
      raw.exec("UPDATE memories SET source_cwd = (SELECT cwd FROM memory_distill_jobs WHERE id = memories.distill_job_id) WHERE source_cwd IS NULL AND distill_job_id IS NOT NULL")
    }
  }
  // Idempotent migration: add value_class to pre-existing memories tables.
  // No backfill (future-only feature; existing rows stay NULL = unevaluated).
  {
    const cols = raw.prepare('PRAGMA table_info(memories)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'value_class')) {
      raw.exec('ALTER TABLE memories ADD COLUMN value_class TEXT')
    }
  }
  // Idempotent migration: add subject_slug to pre-existing memories tables.
  // No backfill（NULL = 未分组，注入平铺，与旧行为一致，spec §4.2）。
  {
    const cols = raw.prepare('PRAGMA table_info(memories)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'subject_slug')) {
      raw.exec('ALTER TABLE memories ADD COLUMN subject_slug TEXT')
    }
    // Index here (after ALTER) not in DDL: CREATE TABLE IF NOT EXISTS is a no-op
    // on pre-existing tables, so a DDL index on subject_slug would fail with
    // "no such column" on older DBs before the ALTER runs (idx_distill_jobs_session 先例)。
    raw.exec('CREATE INDEX IF NOT EXISTS idx_memories_subject ON memories(scope_type, scope_id, subject_slug)')
  }
  // Idempotent migration: add session_id to pre-existing memory_distill_jobs.
  // 第五轮增量蒸馏的会话键；历史 job 无此列 -> 升级后为 NULL -> 全量蒸馏（向后兼容）。
  // 无 backfill（NULL 表示"未知会话"，全量蒸馏是安全默认）。
  {
    const cols = raw.prepare('PRAGMA table_info(memory_distill_jobs)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'session_id')) {
      raw.exec('ALTER TABLE memory_distill_jobs ADD COLUMN session_id TEXT')
    }
    // Index on session_id is created here (after the ALTER) rather than in the
    // initial DDL block: CREATE TABLE IF NOT EXISTS is a no-op on pre-existing
    // tables, so an index on session_id in the DDL would fail with "no such
    // column" on round-4-and-earlier DBs before the ALTER runs. IF NOT EXISTS
    // makes this idempotent across reopens.
    raw.exec('CREATE INDEX IF NOT EXISTS idx_distill_jobs_session ON memory_distill_jobs(session_id)')
  }
  // Idempotent migration: add source_agent_id to memory_distill_jobs.
  // subagent 蒸馏任务的来源标识；主会话 job 为 NULL。无 backfill。
  {
    const cols = raw.prepare('PRAGMA table_info(memory_distill_jobs)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'source_agent_id')) {
      raw.exec('ALTER TABLE memory_distill_jobs ADD COLUMN source_agent_id TEXT')
    }
  }
  // Idempotent migration: add scope/source columns to memory_discards.
  // 让 promoteDiscard 提升路径自包含（不必反查 job）。nullable；老行 NULL。
  // 幂等：列已存在则跳过（与 source_cwd/value_class 迁移同模式）。
  {
    const cols = raw.prepare('PRAGMA table_info(memory_discards)').all() as { name: string }[]
    const have = (n: string) => cols.some((c) => c.name === n)
    if (!have('scope_type')) raw.exec('ALTER TABLE memory_discards ADD COLUMN scope_type TEXT')
    if (!have('scope_id')) raw.exec('ALTER TABLE memory_discards ADD COLUMN scope_id TEXT')
    if (!have('source_cwd')) raw.exec('ALTER TABLE memory_discards ADD COLUMN source_cwd TEXT')
    if (!have('runtime')) raw.exec('ALTER TABLE memory_discards ADD COLUMN runtime TEXT')
    if (!have('source_kind')) raw.exec('ALTER TABLE memory_discards ADD COLUMN source_kind TEXT')
    if (!have('promoted_memory_id')) raw.exec('ALTER TABLE memory_discards ADD COLUMN promoted_memory_id TEXT')
  }
  // Idempotent migration: widen memories.source_kind CHECK to include 'subagent'.
  // sqlite 无法 ALTER CHECK，旧库的窄 CHECK 会拒绝 source_kind='subagent' 插入。
  // 检测 sqlite_master 里的建表 SQL 是否已含 'subagent'；不含则表重建（保数据、重建索引）。
  {
    const tbl = raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'").get() as { sql?: string } | undefined
    if (tbl?.sql && !tbl.sql.includes("'subagent'")) {
      // 事务包裹整段表重建 DDL：SQLite DDL 是事务性的，BEGIN...COMMIT 之间任一语句
      // 失败 -> ROLLBACK 回滚到旧表，避免「DROP memories 后 RENAME 前」被 kill 导致
      // 下次重开 CREATE TABLE IF NOT EXISTS 建空表、guard 见 'subagent' 跳过重建、
      // 用户数据滞留 memories_new 的丢失窗口。guard 在事务外决定是否进入。
      raw.exec('BEGIN')
      try {
        raw.exec(`CREATE TABLE memories_new (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('project','global')),
        scope_id TEXT,
        runtime TEXT CHECK (runtime IN ('claude-code','opencode') OR runtime IS NULL),
        title TEXT NOT NULL,
        body_md TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK (status IN ('candidate','approved','archived','superseded','rejected')),
        source_kind TEXT NOT NULL CHECK (source_kind IN ('conversation','error','manual','subagent')),
        source_cwd TEXT,
        source_event_id TEXT,
        distill_job_id TEXT,
        distill_action TEXT CHECK (distill_action IN ('new','update_of','duplicate_of','conflict_with') OR distill_action IS NULL),
        supersedes_id TEXT,
        superseded_by_id TEXT,
        approved_at INTEGER,
        created_at INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        subject_slug TEXT,
        value_class TEXT,
        CHECK ((scope_type='global' AND scope_id IS NULL) OR (scope_type='project' AND scope_id IS NOT NULL))
      )`)
      raw.exec(`INSERT INTO memories_new (id, scope_type, scope_id, runtime, title, body_md, tags, status, source_kind, source_cwd, source_event_id, distill_job_id, distill_action, supersedes_id, superseded_by_id, approved_at, created_at, version, subject_slug, value_class)
        SELECT id, scope_type, scope_id, runtime, title, body_md, tags, status, source_kind, source_cwd, source_event_id, distill_job_id, distill_action, supersedes_id, superseded_by_id, approved_at, created_at, version, subject_slug, value_class FROM memories`)
      raw.exec('DROP TABLE memories')
      raw.exec('ALTER TABLE memories_new RENAME TO memories')
      raw.exec('CREATE INDEX IF NOT EXISTS idx_memories_scope_status ON memories(scope_type, scope_id, status)')
      raw.exec('CREATE INDEX IF NOT EXISTS idx_memories_status_created ON memories(status, created_at)')
      raw.exec('CREATE INDEX IF NOT EXISTS idx_memories_subject ON memories(scope_type, scope_id, subject_slug)')
      raw.exec('COMMIT')
      } catch (e) {
        raw.exec('ROLLBACK')
        throw e
      }
    }
  }
  return db
}
