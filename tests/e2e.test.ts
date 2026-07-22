import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { createApp } from '@/server'
import { ClaudeCodeAdapter } from '@/adapter/claudeCode'
import { enqueueDistillJob, tick } from '@/scheduler'
import { createCandidate } from '@/memory/store'
import { makeLoadTranscript } from '@/daemon'
import { memoryDistillJobs, memories } from '@/db/schema'

/**
 * End-to-end smoke test for the memside MVP loop.
 *
 * Locks in the full pipeline contract from Task 17 - now exercising the REAL
 * capture -> distill data flow (C1 + C3 fix):
 *   claude code Stop hook -> collector parses a REAL JSONL transcript file
 *   (transcript_path, not an inline mock array) via parseTranscriptFile ->
 *   persists turns to memory_distill_events -> distill tick reads them via the
 *   REAL makeLoadTranscript -> candidate memory -> approve via API -> inject.
 *
 * Every layer is real (Hono app, bun:sqlite DB, real `enqueueDistillJob`,
 * real collector HTTP route that calls parseTranscriptFile and writes
 * memory_distill_events, real `tick`, real `makeLoadTranscript` reading the
 * events table, real `createCandidate`, real `promoteCandidate`, real
 * `listApprovedByScope`, real `formatMemoryBlock`); only the Anthropic LLM
 * call is mocked, since a live API key is not available in CI. This is the
 * proof that C3's transcript_path fix works: a real JSONL file is parsed into
 * turns that flow collector -> events -> makeLoadTranscript -> distiller.
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

  // 1. claude code Stop hook fires with a transcript_path pointing at a REAL
  //    JSONL file containing a business rule. The collector acks 202 and
  //    fire-and-forget calls parseTranscriptFile(path) to turn the JSONL into
  //    TranscriptTurn[], persists them into memory_distill_events (C1+C3 fix),
  //    and enqueues a distill job. No inline mock transcript - this exercises
  //    the real parseTranscriptFile -> DB -> makeLoadTranscript -> distiller
  //    path. Only callAnthropic is mocked (no live API key in CI).
  const fixturePath = join(dir, 'transcript.jsonl')
  writeFileSync(
    fixturePath,
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'we only issue refunds within 14 days of shipment' },
    }) + '\n',
  )
  const hookRes = await app.fetch(new Request('http://x/hooks/claude/Stop', {
    method: 'POST',
    body: JSON.stringify({
      sourceEventId: 'e1',
      cwd: '/repo',
      transcript_path: fixturePath,
    }),
    headers: { 'content-type': 'application/json' },
  }))
  expect(hookRes.status).toBe(202)

  // 2. Wait briefly for the fire-and-forget collector IIFE to write the
  //    memory_distill_events row. The IIFE runs async after the 202 response;
  //    bun:sqlite writes are sync/sub-ms so 50ms is ample headroom.
  await new Promise((r) => setTimeout(r, 50))

  // 3. The real enqueueDistillJob inserted a pending job (nextRunAt = now +
  //    5s debounce). Force it due so tick picks it up immediately.
  const jobs = await db.select().from(memoryDistillJobs)
  expect(jobs.length).toBe(1)
  const jobId = jobs[0]!.id
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))

  // 4. Distill tick with the REAL makeLoadTranscript (reads
  //    memory_distill_events by jobId, parses JSON payload into turns) and a
  //    mocked Anthropic. The mock returns one candidate with a
  //    [category:invariant] title (required by the distiller's parse guard)
  //    and scope='project' so scopeId resolves to the job's cwd. The ONLY mock
  //    is callAnthropic - everything else is the real production path.
  //
  //    C1+C3 lock: we capture the `userPrompt` arg passed to callAnthropic and
  //    assert it contains a substring of the hook's transcript turn. If the
  //    data path broke (parseTranscriptFile returned [], or turns never reached
  //    the distiller), the mock would still return a candidate and the rest of
  //    the test would pass - but capturedUserPrompt would be empty. This
  //    assertion is the proof that turns flowed JSONL file -> parseTranscriptFile
  //    -> collector -> events -> makeLoadTranscript -> distiller.
  let capturedUserPrompt = ''
  await tick(db, {
    loadTranscript: makeLoadTranscript(db),
    callAnthropic: async (_system: string, user: string) => {
      capturedUserPrompt = user
      return JSON.stringify({
        candidates: [{
          title: '[category:invariant] refund window 14 days',
          bodyMd: 'Refunds allowed within 14 days of shipment.',
          scope: 'project',
          runtime: null,
          distillAction: 'new',
        }],
      })
    },
    createCandidate,
  })
  // C1 lock: the transcript turn content ('we only issue refunds within 14 days
  // of shipment') must appear in the userPrompt that reached the distiller.
  expect(capturedUserPrompt).toContain('refunds within 14 days')

  // 5. Candidate exists in the DB - proving the REAL loadTranscript read the
  //    turns that the REAL collector wrote.
  const cands = await db.select().from(memories).where(eq(memories.status, 'candidate'))
  expect(cands.length).toBe(1)
  const candId = cands[0]!.id

  // 6. Approve via the web API promote endpoint.
  const promoRes = await app.fetch(new Request(`http://x/api/memories/${candId}/promote`, {
    method: 'POST',
    body: JSON.stringify({ action: 'approve' }),
    headers: { 'content-type': 'application/json' },
  }))
  expect(promoRes.status).toBe(200)

  // 7. Inject returns the memory block for the same cwd. The candidate was
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
