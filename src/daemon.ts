import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { DbClient } from '@/db/client'
import { openDb } from '@/db/client'
import { memoryDistillEvents, memoryDistillJobs } from '@/db/schema'
import { tick, startMemoryDistillLoop, enqueueDistillJob, type TickDeps } from '@/scheduler'
import { createCandidate } from '@/memory/store'
import type { TranscriptTurn } from '@/memory/pure'
import { makeLLMCall } from '@/anthropic'
import { loadClaudeCreds, type ClaudeCreds } from './creds'
import { createApp } from './server'
import { ClaudeCodeAdapter } from './adapter/claudeCode'
import { installHooks } from './install'

export interface DaemonOpts {
  dbPath?: string
  port?: number
  installClaudeHooks?: boolean
}

/**
 * Shared loader the daemon uses for both the test seam (`runDistillOnce`) and
 * the live scheduler loop (`startDaemon`). Reads `memoryDistillEvents` rows
 * for a job in ts order and parses each `payload` as a JSON array of
 * `TranscriptTurn`. Non-JSON / non-array payloads are silently skipped.
 */
export function makeLoadTranscript(db: DbClient): TickDeps['loadTranscript'] {
  return async (job) => {
    const rows = await db.select().from(memoryDistillEvents)
      .where(eq(memoryDistillEvents.distillJobId, job.id))
      .orderBy(memoryDistillEvents.ts)
    const turns: TranscriptTurn[] = []
    for (const r of rows) {
      try {
        const parsed = JSON.parse(r.payload)
        if (Array.isArray(parsed)) for (const t of parsed) turns.push(t as TranscriptTurn)
      } catch { /* skip malformed payload */ }
    }
    return turns
  }
}

/**
 * Single distill pass for tests: build `TickDeps` (loadTranscript from the
 * events table, callAnthropic from `makeCallAnthropic` unless injected,
 * createCandidate from the store) and run one `tick`. Returns the count of
 * jobs processed.
 *
 * Both `loadClaudeCreds` and `callAnthropic` are injectable so tests never
 * touch the network.
 */
export async function runDistillOnce(
  db: DbClient,
  deps: {
    loadClaudeCreds?: () => ClaudeCreds
    callAnthropic?: (systemPrompt: string, userPrompt: string) => Promise<string>
  } = {},
): Promise<number> {
  const callAnthropic = deps.callAnthropic ?? makeLLMCall({ loadClaudeCreds: deps.loadClaudeCreds ?? loadClaudeCreds })
  const tickDeps: TickDeps = {
    loadTranscript: makeLoadTranscript(db),
    callAnthropic,
    createCandidate,
  }
  return tick(db, tickDeps)
}

/**
 * Daemon-startup hardening (flagged in Task 9's review): reset any
 * `memory_distill_jobs` rows stuck in `status='running'` back to `pending`
 * with `nextRunAt=now`. A crashed daemon (or a tick that died mid-run after
 * marking `running`) would otherwise leave jobs running forever, since the
 * scheduler's `tick` only selects `status='pending'`.
 *
 * Returns the count of swept rows so callers can log it.
 */
export function sweepStuckRunning(db: DbClient): number {
  const stuck = db.select().from(memoryDistillJobs)
    .where(eq(memoryDistillJobs.status, 'running'))
    .all()
  if (stuck.length === 0) return 0
  const now = Date.now()
  for (const row of stuck) {
    db.update(memoryDistillJobs).set({ status: 'pending', nextRunAt: now })
      .where(eq(memoryDistillJobs.id, row.id)).run()
  }
  return stuck.length
}

/**
 * Start the memside daemon: open the DB, sweep stuck-running jobs, build the
 * claude-code adapter + Hono app, `Bun.serve` on `port` (default 7777), and
 * start the 1Hz distill loop with the real `callAnthropic` (via
 * `loadClaudeCreds`). Optional `installClaudeHooks` writes the collector
 * hook commands into `~/.claude/settings.json`.
 *
 * Returns `{ server, stop }`; `stop` clears the loop interval and stops the
 * HTTP server.
 */
export async function startDaemon(opts: DaemonOpts = {}) {
  const dbPath = opts.dbPath ?? join(homedir(), '.memside', 'memside.db')
  const db = openDb(dbPath)
  const port = opts.port ?? 7777

  // Recover from a prior crash: any job marked `running` by a daemon that died
  // mid-tick would otherwise be invisible to the pending-only select in `tick`.
  sweepStuckRunning(db)

  const adapter = new ClaudeCodeAdapter(db)
  const broadcast = (msg: unknown) => { /* WS fan-out placeholder; MVP polls /api/memories */ void msg }
  const app = createApp({ db, adapter, enqueueDistillJob, broadcast })
  const server = Bun.serve({ port, hostname: '127.0.0.1', fetch: app.fetch })

  const tickDeps: TickDeps = {
    loadTranscript: makeLoadTranscript(db),
    callAnthropic: makeLLMCall(),
    createCandidate,
  }
  const stopLoop = startMemoryDistillLoop(db, tickDeps)

  if (opts.installClaudeHooks) installHooks({ port })

  return {
    server,
    stop: () => {
      stopLoop()
      server.stop()
    },
  }
}
