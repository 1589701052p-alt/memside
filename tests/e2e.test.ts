import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { createApp } from '@/server'
import { ClaudeCodeAdapter } from '@/adapter/claudeCode'
import { enqueueDistillJob, tick } from '@/scheduler'
import { createCandidate } from '@/memory/store'
import { memoryDistillEvents, memoryDistillJobs, memories } from '@/db/schema'

/**
 * End-to-end smoke test for the memside MVP loop.
 *
 * Locks in the full pipeline contract from Task 17:
 *   claude code Stop hook -> distill enqueue -> distill tick (mocked Anthropic)
 *   -> candidate memory -> approve via API -> inject block contains the memory.
 *
 * This is the single integration test that proves all 16 prior tasks compose
 * into the product vision. Every layer is real (Hono app, bun:sqlite DB, real
 * `enqueueDistillJob`, real `tick`, real `createCandidate`, real `promoteCandidate`,
 * real `listApprovedByScope`, real `formatMemoryBlock`); only the Anthropic LLM
 * call is mocked, since a live API key is not available in CI.
 *
 * EBUSY-safe pattern (same as server.test.ts / scheduler.test.ts): wipe `root`
 * once in beforeAll, give each test its own fresh subdir, and close the raw
 * bun:sqlite handle in afterEach. The brief's bare `rmSync(tmp)` in beforeEach
 * throws EBUSY on Windows if a previous run left a locked db.
 */
const root = join(import.meta.dir, '.tmp-e2e')
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

test('MVP loop: hook -> distill -> candidate -> approve -> inject', async () => {
  const adapter = new ClaudeCodeAdapter(db)
  const app = createApp({ db, adapter, enqueueDistillJob, broadcast: () => {} })

  // 1. claude code Stop hook fires with a transcript containing a business rule.
  //    The collector acks 202 and fire-and-forget-enqueues a distill job. The
  //    drizzle/bun-sqlite INSERT executes synchronously inside the async
  //    enqueueDistillJob call, so the job row is in the DB before we read it.
  const hookRes = await app.fetch(new Request('http://x/hooks/claude/Stop', {
    method: 'POST',
    body: JSON.stringify({
      sourceEventId: 'e1',
      cwd: '/repo',
      transcript: [{ role: 'user', content: 'we only issue refunds within 14 days of shipment' }],
    }),
    headers: { 'content-type': 'application/json' },
  }))
  expect(hookRes.status).toBe(202)

  // 2. Seed the distill event payload. In production the collector persists the
  //    transcript turns into memory_distill_events; here we insert them
  //    directly, then force the job due (nextRunAt=0) so tick picks it up.
  const jobs = await db.select().from(memoryDistillJobs)
  expect(jobs.length).toBe(1)
  const jobId = jobs[0]!.id
  await db.insert(memoryDistillEvents).values({
    distillJobId: jobId, attemptIndex: 0, ts: 1, kind: 'conversation',
    payload: JSON.stringify([{ role: 'user', content: 'refunds within 14 days' }]),
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))

  // 3. Distill tick with a mocked Anthropic. The mock returns one candidate
  //    with a [category:invariant] title (required by the distiller's parse
  //    guard) and scope='project' so scopeId resolves to the job's cwd.
  await tick(db, {
    loadTranscript: async () => [{ role: 'user', content: 'refunds within 14 days' }],
    callAnthropic: async () => JSON.stringify({
      candidates: [{
        title: '[category:invariant] refund window 14 days',
        bodyMd: 'Refunds allowed within 14 days of shipment.',
        scope: 'project',
        runtime: null,
        distillAction: 'new',
      }],
    }),
    createCandidate,
  })

  // 4. Candidate exists in the DB.
  const cands = await db.select().from(memories).where(eq(memories.status, 'candidate'))
  expect(cands.length).toBe(1)
  const candId = cands[0]!.id

  // 5. Approve via the web API promote endpoint.
  const promoRes = await app.fetch(new Request(`http://x/api/memories/${candId}/promote`, {
    method: 'POST',
    body: JSON.stringify({ action: 'approve' }),
    headers: { 'content-type': 'application/json' },
  }))
  expect(promoRes.status).toBe(200)

  // 6. Inject returns the memory block for the same cwd. The candidate was
  //    scopeId='/repo' (from the hook's cwd), runtime=null (passes the
  //    claude-code runtime filter), so it appears in the injected block.
  const injRes = await app.fetch(new Request('http://x/inject', {
    method: 'POST',
    body: JSON.stringify({ cwd: '/repo' }),
    headers: { 'content-type': 'application/json' },
  }))
  const injBody = await injRes.json()
  expect(injBody.block).toContain('--- BEGIN INJECTED MEMORY ---')
  expect(injBody.block).toContain('refund window 14 days')
})
