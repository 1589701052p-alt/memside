// 锁 spec 2026-08-18 §4.1：断点字段 + paused/pending_review 状态。迁移幂等。
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { openDb } from '@/db/client'
import type { DbClient } from '@/db/client'
import { memories, memoryDistillJobs, memoryDistillRuns } from '@/db/schema'
import { eq } from 'drizzle-orm'

// 注：brief 原文用 openDb(':memory:')，但 client.ts 的 mkdirSync(dirname(path))
// 对 ':memory:' 会在 bun 下抛 EEXIST(mkdir '.')，改用 fresh-dir 文件库模式（schema.test.ts 既例）。
function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'memside-step-state-'))
}

function cols(table: string, db: DbClient): string[] {
  return (db.$client.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
}

describe('schema step-state migration', () => {
  test('memory_distill_jobs 有 current_step/step_attempts/step_error', () => {
    const d = freshDir()
    const db = openDb(join(d, 't.db'))
    const c = cols('memory_distill_jobs', db)
    expect(c).toContain('current_step')
    expect(c).toContain('step_attempts')
    expect(c).toContain('step_error')
    db.$client.close()
  })

  test('memory_distill_runs 有 paused_step', () => {
    const d = freshDir()
    const db = openDb(join(d, 't.db'))
    expect(cols('memory_distill_runs', db)).toContain('paused_step')
    db.$client.close()
  })

  test('迁移幂等（openDb 两次不报错）', () => {
    const d = freshDir()
    const p = join(d, 't.db')
    const db = openDb(p)
    db.$client.close()
    // 再调一次迁移逻辑（openDb 内部幂等）
    const db2 = openDb(p)
    expect(cols('memory_distill_jobs', db2)).toContain('current_step')
    expect(cols('memory_distill_runs', db2)).toContain('paused_step')
    db2.$client.close()
  })

  test('memories.status 接受 pending_review（CHECK 已扩展）', () => {
    // 锁 spec 2026-08-18 §4.1：judge 3 次失败暂停期间候选标 pending_review，必须可插入。
    // memories.status 有 DB-level CHECK，需表重建迁移扩展；否则插入被 CHECK 拒绝。
    const d = freshDir()
    const db = openDb(join(d, 't.db'))
    db.insert(memories).values({
      id: 'pr-test', scopeType: 'global', scopeId: null, runtime: null,
      title: 't', bodyMd: 'b', tags: '[]', status: 'pending_review',
      sourceKind: 'manual', createdAt: 1, version: 1,
    }).run()
    const got = db.select().from(memories).where(eq(memories.id, 'pr-test')).all()
    expect(got.length).toBe(1)
    expect(got[0]!.status).toBe('pending_review')
    db.$client.close()
  })

  test('memory_distill_jobs.status 接受 paused（无 DB CHECK，schema enum 放行）', () => {
    const d = freshDir()
    const db = openDb(join(d, 't.db'))
    // memory_distill_jobs.status 无 DB-level CHECK，只要 schema enum 允许即可插入。
    db.$client.prepare(
      `INSERT INTO memory_distill_jobs (id, debounce_key, source_event_id, runtime, status, attempts, next_run_at, created_at)
       VALUES ('job-paused','dk','se','claude-code','paused',0,1,1)`,
    ).run()
    const got = db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, 'job-paused')).all()
    expect(got.length).toBe(1)
    expect(got[0]!.status).toBe('paused')
    db.$client.close()
  })

  test('memory_distill_runs 有 paused_step 列可写', () => {
    const d = freshDir()
    const db = openDb(join(d, 't.db'))
    db.$client.prepare(
      `INSERT INTO memory_distill_runs (distill_job_id, outcome, distilled_count, accepted_count, deduped_count, filtered_count, stored_count, discarded_count, duration_ms, ts, paused_step)
       VALUES ('r1','ok',1,1,0,0,1,0,10,1,'judge')`,
    ).run()
    const got = db.select().from(memoryDistillRuns).where(eq(memoryDistillRuns.distillJobId, 'r1')).all()
    expect(got.length).toBe(1)
    expect(got[0]!.pausedStep).toBe('judge')
    db.$client.close()
  })

  test('老库 status CHECK 不含 pending_review -> 迁移重建后可插入（幂等）', () => {
    // 模拟已跑过 subagent 重建的老库：status CHECK 仍为窄 5 值（无 pending_review）。
    // 重新 openDb 触发 pending_review 表重建迁移；数据保留 + pending_review 可插 + 幂等。
    const d = freshDir()
    const p = join(d, 'old.db')
    const raw = new Database(p)
    raw.exec(`CREATE TABLE memories (
      id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_id TEXT, runtime TEXT,
      title TEXT NOT NULL, body_md TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL CHECK (status IN ('candidate','approved','archived','superseded','rejected')),
      source_kind TEXT NOT NULL CHECK (source_kind IN ('conversation','error','manual','subagent')),
      source_event_id TEXT, distill_job_id TEXT, distill_action TEXT,
      supersedes_id TEXT, superseded_by_id TEXT, approved_at INTEGER, created_at INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, source_cwd TEXT, value_class TEXT, subject_slug TEXT,
      origin TEXT, evidence TEXT,
      CHECK ((scope_type='global' AND scope_id IS NULL) OR (scope_type='project' AND scope_id IS NOT NULL))
    )`)
    raw.exec(`INSERT INTO memories (id, scope_type, scope_id, runtime, title, body_md, tags, status, source_kind, source_event_id, distill_job_id, distill_action, supersedes_id, superseded_by_id, approved_at, created_at, version, source_cwd, value_class, subject_slug, origin, evidence)
      VALUES ('m-old','global',NULL,NULL,'old','b','[]','approved','conversation',NULL,NULL,NULL,NULL,NULL,1,100,1,NULL,NULL,NULL,NULL,NULL)`)
    raw.close()
    // 第一次开 -> 触发 pending_review 表重建
    const db2 = openDb(p)
    // 旧数据保留
    const rows = db2.select().from(memories).all()
    expect(rows.some((r) => r.id === 'm-old' && r.title === 'old')).toBe(true)
    // pending_review 现在可插入（CHECK 已扩展）
    db2.insert(memories).values({
      id: 'm-pr', scopeType: 'global', scopeId: null, runtime: null,
      title: 'pr', bodyMd: 'b', tags: '[]', status: 'pending_review',
      sourceKind: 'manual', createdAt: 2, version: 1,
    }).run()
    expect(db2.select().from(memories).where(eq(memories.id, 'm-pr')).all()[0]!.status).toBe('pending_review')
    db2.$client.close()
    // 再开一次 -> 幂等（不重复重建；pending_review 仍可插）
    const db3 = openDb(p)
    db3.insert(memories).values({
      id: 'm-pr2', scopeType: 'global', scopeId: null, runtime: null,
      title: 'pr2', bodyMd: 'b', tags: '[]', status: 'pending_review',
      sourceKind: 'manual', createdAt: 3, version: 1,
    }).run()
    expect(db3.select().from(memories).where(eq(memories.id, 'm-pr2')).all().length).toBe(1)
    db3.$client.close()
  })
})
