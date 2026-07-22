import { Hono } from 'hono'
import { desc } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { memories, memoryDistillEvents } from '@/db/schema'
import type { ClaudeCodeAdapter } from '@/adapter/claudeCode'
import { promoteCandidate, patchMemory, createCandidate, getMemoryById } from '@/memory/store'
import { parseTranscriptFile } from '@/claude/transcript'
import type { EnqueueInput } from '@/scheduler'

export interface AppDeps {
  db: DbClient
  adapter: ClaudeCodeAdapter
  enqueueDistillJob: (db: DbClient, input: EnqueueInput) => Promise<{ jobId: string; nextRunAt: number }>
  broadcast: (msg: unknown) => void
}

/**
 * Build the Hono app for the memside HTTP layer.
 *
 * Three concerns, three route groups:
 *
 * 1. Collector (`POST /hooks/claude/:event`) - claude code hook callback.
 *    claude code pipes a JSON stdin payload whose `transcript_path` is a path
 *    to a JSONL transcript file (NOT an inline array - verified against claude
 *    code 2.1.217's bundle). Two branches by event:
 *    - `SessionStart`: does NOT capture/enqueue. Calls `adapter.inject({cwd})`
 *      and, when there is an approved-memory block, returns the
 *      `{hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:<block>}}`
 *      envelope claude code reads from the hook's stdout to prepend context to
 *      the new session (C2 fix). When there is nothing to inject, returns
 *      `{ok:true}`. This is synchronous-ish (a DB read + formatMemoryBlock,
 *      ~ms) and returns directly - NOT fire-and-forget - because the hook's
 *      stdout IS the response body claude code reads. SessionStart is
 *      low-frequency so a few ms is fine.
 *    - `Stop` / `SubagentStop` / `PostToolUse`: the <50ms ack contract holds -
 *      the handler returns 202 synchronously while a fire-and-forget IIFE
 *      (never awaited in the hot path) reads the JSONL file via
 *      `parseTranscriptFile`, persists the turns into `memory_distill_events`,
 *      and enqueues a distill job. `sourceKind` is `'error'` for `PostToolUse`
 *      (error-signal transcript path) and `'conversation'` otherwise.
 *
 * 2. Injector (`POST /inject`) - programmatic seam (the SessionStart hook
 *    itself goes through the collector branch above). Delegates to
 *    `adapter.inject({cwd})`; returns `{ block }` where block may be null (no
 *    approved memories). The adapter swallows store errors so injection never
 *    throws to the caller.
 *
 * 3. Memory API (`/api/memories...`) - CRUD for the web UI. List (createdAt
 *    DESC), get (404 on miss), create manual candidate (201), promote
 *    (approve/reject/supersede; 409 on conflict), patch (field update + version
 *    bump; 409 on terminal). Every mutating route broadcasts a WS event via the
 *    injected `broadcast` seam (actual WS wiring is a later task).
 */
export function createApp(deps: AppDeps) {
  const app = new Hono()

  // --- Collector ----------------------------------------------------------
  app.post('/hooks/claude/:event', async (c) => {
    const event = c.req.param('event')
    const body = await c.req.json().catch(() => ({}) as { transcript_path?: string; cwd?: string; sourceEventId?: string })
    const cwd: string = body.cwd ?? ''

    // SessionStart (C2 fix): inject approved memories into the new session.
    // claude code honors ONLY the `hookSpecificOutput.additionalContext`
    // envelope on a SessionStart hook's stdout (bundle error string: "Did you
    // mean hookSpecificOutput.additionalContext (with a hookEventName)?").
    // A plain `{ok:true}` contributes no context. We do NOT capture/enqueue
    // here - SessionStart has no transcript to distill. The inject path is a
    // DB read + formatMemoryBlock (~ms); SessionStart is low-frequency so a
    // few ms synchronous is fine, and crucially this must NOT be
    // fire-and-forget because the hook's stdout IS the response body claude
    // code reads.
    if (event === 'SessionStart') {
      const block = await deps.adapter.inject({ cwd })
      if (block) {
        return c.json({
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: block,
          },
        })
      }
      return c.json({ ok: true })
    }

    // Stop / SubagentStop / PostToolUse (C3 fix): claude code pipes
    // `transcript_path` (a JSONL file path, NOT an inline array). The old code
    // read `body.transcript` (inline) which is always undefined in production
    // -> turns=[] -> empty payload stored -> distiller got nothing. Tests
    // passed only because e2e mocked the transcript inline. Now we parse the
    // real JSONL file into TranscriptTurn[].
    const transcriptPath: string = body.transcript_path ?? ''
    const sourceEventId: string = body.sourceEventId ?? `${event}-${Date.now()}`
    const debounceKey = `${cwd}:${event}`
    const sourceKind = event === 'PostToolUse' ? 'error' : 'conversation'
    // The in-memory adapter.pushCapture queue is intentionally NOT fed here:
    // the real data path is the memory_distill_events DB row written by the
    // fire-and-forget IIFE below (C1 fix). pushCapture/capture stay on the
    // adapter for unit tests / future adapters, but buffering every hook's full
    // transcript in an unbounded in-memory queue was a leak with no consumer.
    // Persist the transcript turns into memory_distill_events keyed by the
    // distill job, then enqueue. Fire-and-forget so the route still returns
    // 202 synchronously (<50ms ack contract); bun:sqlite writes are sync/sub-ms
    // and the 5s debounce gives the tick plenty of time to read the events.
    // Without this the daemon's makeLoadTranscript always sees an empty table
    // and no candidate memories are ever produced from real hook callbacks.
    //
    // When transcript_path is empty/missing or the file yields no turns, we
    // still enqueue (the distiller can decide) and store `[]` as the payload.
    // This preserves the capture signal for WS subscribers and lets a later
    // retry pick up a transcript file that was still being written when the
    // hook fired; dropping the job would lose the event entirely.
    void (async () => {
      try {
        const turns = transcriptPath ? parseTranscriptFile(transcriptPath) : []
        const { jobId } = await deps.enqueueDistillJob(deps.db, { sourceEventId, runtime: 'claude-code', cwd, debounceKey })
        await deps.db.insert(memoryDistillEvents).values({
          distillJobId: jobId,
          attemptIndex: 0,
          ts: Date.now(),
          kind: sourceKind,
          payload: JSON.stringify(turns),
        })
      } catch (e) {
        deps.broadcast({ type: 'memory.enqueue.failed', sourceEventId, error: String(e) })
      }
    })()
    deps.broadcast({ type: 'memory.capture', sourceEventId })
    return c.json({ ok: true }, 202)
  })

  // --- Injector -----------------------------------------------------------
  app.post('/inject', async (c) => {
    const { cwd } = await c.req.json().catch(() => ({ cwd: '' }))
    const block = await deps.adapter.inject({ cwd })
    return c.json({ block })
  })

  // --- Memory API ---------------------------------------------------------
  app.get('/api/memories', async (c) => {
    const rows = await deps.db.select().from(memories).orderBy(desc(memories.createdAt))
    return c.json({ items: rows })
  })

  app.get('/api/memories/:id', async (c) => {
    const got = await getMemoryById(deps.db, c.req.param('id'))
    if (!got) return c.json({ error: 'not found' }, 404)
    return c.json(got)
  })

  app.post('/api/memories/:id/promote', async (c) => {
    const body = await c.req.json()
    try {
      const m = await promoteCandidate(deps.db, c.req.param('id'), body)
      deps.broadcast({ type: 'memory.promoted', memoryId: m.id, newStatus: m.status })
      return c.json({ memory: m })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 409)
    }
  })

  app.patch('/api/memories/:id', async (c) => {
    const body = await c.req.json()
    try {
      const r = await patchMemory(deps.db, c.req.param('id'), body)
      deps.broadcast({ type: 'memory.updated', memoryId: r.memory.id, changedFields: r.changedFields })
      return c.json(r)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 409)
    }
  })

  app.post('/api/memories', async (c) => {
    const body = await c.req.json()
    const m = await createCandidate(deps.db, { ...body, sourceKind: 'manual', runtime: body.runtime ?? null })
    deps.broadcast({ type: 'memory.candidate.created', memoryId: m.id })
    return c.json({ memory: m }, 201)
  })

  return app
}
