import { drizzle } from 'drizzle-orm/bun-sqlite'
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { memories, memoryDistillJobs, memoryDistillEvents } from './schema'

export type DbClient = ReturnType<typeof openDb>

export function openDb(path: string) {
  mkdirSync(dirname(path), { recursive: true })
  const raw = new Database(path)
  raw.exec('PRAGMA journal_mode=WAL')
  raw.exec('PRAGMA synchronous=NORMAL')
  const db = drizzle(raw, { schema: { memories, memoryDistillJobs, memoryDistillEvents } })
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
      source_kind TEXT NOT NULL CHECK (source_kind IN ('conversation','error','manual')),
      source_event_id TEXT,
      distill_job_id TEXT,
      distill_action TEXT CHECK (distill_action IN ('new','update_of','duplicate_of','conflict_with') OR distill_action IS NULL),
      supersedes_id TEXT,
      superseded_by_id TEXT,
      approved_at INTEGER,
      created_at INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
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
  `)
  return db
}
