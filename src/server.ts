import { Hono } from 'hono'
import { desc } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { memories, memoryDistillEvents } from '@/db/schema'
import type { ClaudeCodeAdapter } from '@/adapter/claudeCode'
import { promoteCandidate, patchMemory, createCandidate, getMemoryById } from '@/memory/store'
import type { TranscriptTurn } from '@/memory/pure'
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
 * 1. Collector (`POST /hooks/claude/:event`) - claude code hook callback. The
 *    <50ms ack contract: only `adapter.pushCapture` (in-memory push) + a
 *    fire-and-forget `void enqueueDistillJob(...)` (never awaited in the hot
 *    path). No file reads, no LLM, no DB writes on the critical path. Returns
 *    202 Accepted. `sourceKind` is `'error'` for `PostToolUse` (error-signal
 *    transcript path) and `'conversation'` for everything else.
 *
 * 2. Injector (`POST /inject`) - SessionStart hook calls this to get the memory
 *    block prepended to the session. Delegates to `adapter.inject({cwd})`;
 *    returns `{ block }` where block may be null (no approved memories). The
 *    adapter swallows store errors so injection never throws to the caller.
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
    const body = await c.req.json().catch(() => ({}) as { transcript?: unknown; cwd?: string; sourceEventId?: string })
    const turns: TranscriptTurn[] = Array.isArray(body.transcript) ? body.transcript : []
    const cwd: string = body.cwd ?? ''
    const sourceEventId: string = body.sourceEventId ?? `${event}-${Date.now()}`
    const debounceKey = `${cwd}:${event}`
    const sourceKind = event === 'PostToolUse' ? 'error' : 'conversation'
    deps.adapter.pushCapture({
      sourceEventId,
      runtime: 'claude-code',
      cwd,
      debounceKey,
      turns,
      sourceKind,
    })
    // Persist the transcript turns into memory_distill_events keyed by the
    // distill job, then enqueue. Fire-and-forget so the route still returns
    // 202 synchronously (<50ms ack contract); bun:sqlite writes are sync/sub-ms
    // and the 5s debounce gives the tick plenty of time to read the events.
    // Without this the daemon's makeLoadTranscript always sees an empty table
    // and no candidate memories are ever produced from real hook callbacks.
    void (async () => {
      try {
        const { jobId } = await deps.enqueueDistillJob(deps.db, { sourceEventId, runtime: 'claude-code', cwd, debounceKey })
        await deps.db.insert(memoryDistillEvents).values({
          distillJobId: jobId,
          attemptIndex: 0,
          ts: Date.now(),
          kind: sourceKind === 'error' ? 'error' : 'conversation',
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
