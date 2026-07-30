import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { memories, memoryDistillJobs, memoryDiscards, memoryDistillInputs, memoryDistillRuns } from '@/db/schema'
import type { TranscriptTurn } from '@/memory/pure'
import { createCandidate, listApprovedByScope, getMemoryById, listForDedupByScope, DEDUP_EXISTING_LIMIT, logDiscards, getSessionOffset, setSessionOffset, saveSourceInput, getSourceInput, saveDistillRun, getDistillRun, listRecentDistillRuns } from '@/memory/store'

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
    { title: 't1', bodyMd: 'b1', reason: 'public-knowledge', scopeType: 'project', scopeId: '/r', sourceCwd: '/r', runtime: 'claude-code', sourceKind: 'conversation' },
    { title: 't2', bodyMd: 'b2', reason: 'derivable', scopeType: 'project', scopeId: '/r', sourceCwd: '/r', runtime: 'claude-code', sourceKind: 'conversation' },
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

test('getSessionOffset returns 0 for unknown session (first distill = full)', async () => {
  // 第五轮：首次蒸馏无偏移记录 -> 返回 0 -> loadTranscript 全量切片。
  // 这是增量蒸馏的"首次全量"入口，必须默认 0 而非抛错。
  expect(await getSessionOffset(db, 'never-seen-session')).toBe(0)
})

test('setSessionOffset UPSERTs: second write overwrites; getSessionOffset reads it back', async () => {
  // 第五轮：同一 session 多次 Stop，每次蒸馏后偏移推进。UPSERT 保证不抛主键冲突。
  await setSessionOffset(db, 'sess-A', 36)
  expect(await getSessionOffset(db, 'sess-A')).toBe(36)
  // 第二次 Stop 蒸馏到 120 -> 覆盖
  await setSessionOffset(db, 'sess-A', 120)
  expect(await getSessionOffset(db, 'sess-A')).toBe(120)
})

test('saveSourceInput inserts a row, getSourceInput reads it back', async () => {
  const turns = [
    { role: 'user' as const, content: 'hello' },
    { role: 'assistant' as const, content: 'hi there' },
  ]
  await saveSourceInput(db, 'job-1', turns)
  const snap = await getSourceInput(db, 'job-1')
  expect(snap).not.toBeNull()
  expect(snap!.turnCount).toBe(2)
  expect(snap!.charCount).toBe('hello'.length + 'hi there'.length)
  expect(snap!.turns.length).toBe(2)
  expect(snap!.turns[0]!.content).toBe('hello')
})

test('saveSourceInput UPSERT overwrites on same distillJobId (no duplicate rows)', async () => {
  await saveSourceInput(db, 'job-2', [{ role: 'user' as const, content: 'first' }])
  await saveSourceInput(db, 'job-2', [{ role: 'user' as const, content: 'second' }, { role: 'user' as const, content: 'third' }])
  const rows = await db.select().from(memoryDistillInputs).where(eq(memoryDistillInputs.distillJobId, 'job-2'))
  expect(rows.length).toBe(1)  // UPSERT 覆盖，不产生两行
  const snap = await getSourceInput(db, 'job-2')
  expect(snap!.turnCount).toBe(2)  // 第二次的值
  expect(snap!.turns[0]!.content).toBe('second')
})

test('getSourceInput returns null for missing job', async () => {
  const snap = await getSourceInput(db, 'no-such-job')
  expect(snap).toBeNull()
})

test('getSourceInput returns null on malformed turns_json (deser failure, no crash)', async () => {
  // 直接写一行坏 JSON，模拟历史/损坏数据
  db.insert(memoryDistillInputs).values({
    distillJobId: 'job-bad', turnsJson: 'not-valid-json{', turnCount: 0, charCount: 0, ts: 1,
  }).run()
  const snap = await getSourceInput(db, 'job-bad')
  expect(snap).toBeNull()
})

test('saveDistillRun inserts a row, getDistillRun reads it back', async () => {
  await db.insert(memoryDistillJobs).values({ id: 'job-r1', debounceKey: 'k', sourceEventId: 'e', runtime: 'claude-code', cwd: '/repo', status: 'done', attempts: 0, nextRunAt: 0, createdAt: 100, finishedAt: 200 })
  await saveDistillRun(db, 'job-r1', { outcome: 'produced', rawOutput: { candidates: [{ title: 'x' }] }, rawCount: 1, acceptedCount: 1, dedupedCount: 1, filteredCount: 1, storedCount: 1, discardedCount: 0, durationMs: 42, errorMessage: null })
  const run = await getDistillRun(db, 'job-r1')
  expect(run?.outcome).toBe('produced')
  expect(run?.rawCount).toBe(1)
  expect(run?.durationMs).toBe(42)
  expect((run?.rawOutput as any)?.candidates?.length).toBe(1)
})

test('saveDistillRun UPSERT overwrites on same distillJobId', async () => {
  await saveDistillRun(db, 'job-r2', { outcome: 'empty_output', rawOutput: null, rawCount: 0, acceptedCount: 0, dedupedCount: 0, filteredCount: 0, storedCount: 0, discardedCount: 0, durationMs: 5, errorMessage: null })
  await saveDistillRun(db, 'job-r2', { outcome: 'produced', rawOutput: null, rawCount: 3, acceptedCount: 2, dedupedCount: 2, filteredCount: 1, storedCount: 1, discardedCount: 1, durationMs: 9, errorMessage: null })
  const run = await getDistillRun(db, 'job-r2')
  expect(run?.outcome).toBe('produced')
  expect(run?.rawCount).toBe(3)
})

test('getDistillRun returns null for missing job', async () => {
  expect(await getDistillRun(db, 'nope')).toBeNull()
})

test('getDistillRun returns null rawOutput on malformed raw_output_json', async () => {
  await db.insert(memoryDistillRuns).values({ distillJobId: 'job-bad', outcome: 'produced', rawOutputJson: 'not-json{', distilledCount: 1, acceptedCount: 1, dedupedCount: 1, filteredCount: 1, storedCount: 1, discardedCount: 0, durationMs: 1, ts: 1 })
  const run = await getDistillRun(db, 'job-bad')
  expect(run?.rawOutput).toBeNull()
  expect(run?.outcome).toBe('produced')
})

test('listRecentDistillRuns returns rows newest-first with job metadata, no rawOutput', async () => {
  await db.insert(memoryDistillJobs).values({ id: 'job-l1', debounceKey: 'k', sourceEventId: 'e', runtime: 'claude-code', cwd: '/a', status: 'done', attempts: 0, nextRunAt: 0, createdAt: 10, finishedAt: 20 })
  await db.insert(memoryDistillJobs).values({ id: 'job-l2', debounceKey: 'k', sourceEventId: 'e', runtime: 'claude-code', cwd: '/b', sourceAgentId: 'ag1', status: 'done', attempts: 0, nextRunAt: 0, createdAt: 30, finishedAt: 40 })
  await saveDistillRun(db, 'job-l1', { outcome: 'produced', rawOutput: { candidates: [] }, rawCount: 1, acceptedCount: 1, dedupedCount: 1, filteredCount: 1, storedCount: 1, discardedCount: 0, durationMs: 1, errorMessage: null })
  await saveDistillRun(db, 'job-l2', { outcome: 'empty_output', rawOutput: null, rawCount: 0, acceptedCount: 0, dedupedCount: 0, filteredCount: 0, storedCount: 0, discardedCount: 0, durationMs: 1, errorMessage: null })
  const rows = await listRecentDistillRuns(db)
  expect(rows.length).toBe(2)
  expect(rows[0]!.ts).toBeGreaterThanOrEqual(rows[1]!.ts)
  expect(rows.find((r) => r.distillJobId === 'job-l2')?.sourceAgentId).toBe('ag1')
  expect(rows.find((r) => r.distillJobId === 'job-l1')?.cwd).toBe('/a')
  expect((rows[0] as any).rawOutput).toBeUndefined()
})

test('openDb creates memory_distill_runs with all columns', () => {
  const cols = (db.$client.prepare('PRAGMA table_info(memory_distill_runs)').all() as { name: string }[])
    .map((r) => r.name)
  expect(cols).toEqual(expect.arrayContaining([
    'distill_job_id', 'outcome', 'raw_output_json', 'distilled_count', 'accepted_count',
    'deduped_count', 'filtered_count', 'stored_count', 'discarded_count', 'duration_ms', 'ts',
  ]))
})

test('saveDistillRun persists errorMessage; getDistillRun reads it back', async () => {
  await saveDistillRun(db, 'job-em1', { outcome: 'llm_error', rawOutput: null, rawCount: 0,
    acceptedCount: 0, dedupedCount: 0, filteredCount: 0, storedCount: 0, discardedCount: 0,
    durationMs: 42, errorMessage: '500 Internal Server Error' })
  const run = await getDistillRun(db, 'job-em1')
  expect(run?.errorMessage).toBe('500 Internal Server Error')
  expect(run?.outcome).toBe('llm_error')
})

test('saveDistillRun UPSERT overwrites errorMessage', async () => {
  await saveDistillRun(db, 'job-em2', { outcome: 'llm_error', rawOutput: null, rawCount: 0,
    acceptedCount: 0, dedupedCount: 0, filteredCount: 0, storedCount: 0, discardedCount: 0,
    durationMs: 5, errorMessage: 'timeout' })
  await saveDistillRun(db, 'job-em2', { outcome: 'produced', rawOutput: null, rawCount: 1,
    acceptedCount: 1, dedupedCount: 1, filteredCount: 1, storedCount: 1, discardedCount: 0,
    durationMs: 9, errorMessage: null })
  const run = await getDistillRun(db, 'job-em2')
  expect(run?.errorMessage).toBeNull()
  expect(run?.outcome).toBe('produced')
})

test('listRecentDistillRuns returns errorMessage in each row', async () => {
  await saveDistillRun(db, 'job-em3', { outcome: 'llm_error', rawOutput: null, rawCount: 0,
    acceptedCount: 0, dedupedCount: 0, filteredCount: 0, storedCount: 0, discardedCount: 0,
    durationMs: 1, errorMessage: 'fetch failed' })
  const rows = await listRecentDistillRuns(db)
  const row = rows.find((r) => r.distillJobId === 'job-em3')
  expect(row?.errorMessage).toBe('fetch failed')
})
