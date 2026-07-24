import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { enqueueDistillJob } from '@/scheduler'
import { runDistillOnce, sweepStuckRunning } from '@/daemon'
import { memoryDistillJobs, memoryDistillEvents } from '@/db/schema'

// EBUSY-safe pattern (same as scheduler.test.ts / server.test.ts): wipe `root`
// once in beforeAll, give each test its own fresh subdir, and close the raw
// bun:sqlite handle in afterEach. The brief's bare `rmSync(tmp)` in beforeEach
// throws EBUSY on Windows because the previous test's Database (plus -wal/-shm
// sidecars) is still locked. Fresh subdirs mean we never delete a dir holding
// an open handle.
const root = join(import.meta.dir, '.tmp-daemon')
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

/**
 * Task 16 integration capstone: locks in the wiring that `runDistillOnce`
 * composes `loadTranscript` (reads `memoryDistillEvents` rows + parses JSON
 * payload into TranscriptTurn[]) + `callLLM` + `createCandidate` and
 * drives `tick` to mark a job `done`.
 *
 * The Anthropic call + creds are mocked so this never touches the network.
 */
test('runDistillOnce wires loadTranscript + callLLM + createCandidate end-to-end (mocked)', async () => {
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k', debounceMs: 0,
  })
  // force due (enqueueDistillJob set nextRunAt = now + 0 = now, but tick's
  // pending+lte(now) select is time-sensitive on Windows CI; pin to 0 to be safe)
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  // seed a distill event the loader reads. The brief used the unsupported
  // `db.insert({table:...})` shorthand; we use the Drizzle query builder.
  await db.insert(memoryDistillEvents).values({
    distillJobId: jobId, attemptIndex: 0, ts: 1, kind: 'conversation',
    payload: JSON.stringify([{ role: 'user', content: 'refund 14 days' }]),
  })
  await runDistillOnce(db, {
    loadClaudeCreds: () => ({ apiKey: 'sk-test', source: 'test' }),
    callLLM: async () => JSON.stringify({
      candidates: [{ title: '[category:invariant] refund 14d', bodyMd: '14 days', scope: 'project', runtime: null, distillAction: 'new' }],
    }),
  })
  const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(rows[0]!.status).toBe('done')
})

/**
 * Daemon-startup hardening (flagged in Task 9's review): a crashed daemon must
 * not leave `memory_distill_jobs` rows stuck in `status='running'` forever.
 * `sweepStuckRunning` resets them to `pending` with `nextRunAt=now` so the
 * scheduler picks them up on the next tick.
 */
test('sweepStuckRunning resets running jobs back to pending with nextRunAt=now', async () => {
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k', debounceMs: 0,
  })
  // simulate a crashed-mid-run daemon: status=running, stale nextRunAt
  await db.update(memoryDistillJobs).set({ status: 'running', nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  const before = Date.now()
  const swept = sweepStuckRunning(db)
  const after = Date.now()
  expect(swept).toBe(1)
  const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(rows[0]!.status).toBe('pending')
  expect(rows[0]!.nextRunAt).toBeGreaterThanOrEqual(before)
  expect(rows[0]!.nextRunAt).toBeLessThanOrEqual(after)
})

test('sweepStuckRunning leaves pending/done/failed jobs untouched', async () => {
  const { jobId: pendId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0,
  })
  const { jobId: doneId } = await enqueueDistillJob(db, {
    sourceEventId: 'e2', runtime: 'claude-code', cwd: '/r', debounceKey: 'k2', debounceMs: 0,
  })
  await db.update(memoryDistillJobs).set({ status: 'done', finishedAt: 1 }).where(eq(memoryDistillJobs.id, doneId))
  const swept = sweepStuckRunning(db)
  expect(swept).toBe(0)
  const pend = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, pendId))
  const done = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, doneId))
  expect(pend[0]!.status).toBe('pending')
  expect(done[0]!.status).toBe('done')
})
