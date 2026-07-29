import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { DbClient } from '@/db/client'
import { openDb } from '@/db/client'
import { memoryDistillEvents, memoryDistillJobs } from '@/db/schema'
import { tick, startMemoryDistillLoop, enqueueDistillJob, type TickDeps } from '@/scheduler'
import { createCandidate, getSessionOffset } from '@/memory/store'
import type { TranscriptTurn } from '@/memory/pure'
import { makeLLMCall as makeAnthropicCall } from '@/anthropic'
import { makeLLMCall as makeOpenAiCall, type OpenAiCreds } from '@/openai'
import { resolveLLMBackend, type LLMCall } from '@/llm'
import { type ClaudeCreds } from './creds'
import { createApp } from './server'
import { ClaudeCodeAdapter } from './adapter/claudeCode'
import { installHooks } from './install'

export interface DaemonOpts {
  dbPath?: string
  port?: number
  installClaudeHooks?: boolean
  /** 一键启动（生产模式）：vite build 产物目录，透传为 createApp 的
   * staticDir。不传则 daemon 不托管静态文件（裸 daemon 语义不变）。 */
  serveStaticDir?: string
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
    const fullLength = turns.length
    // subagent 蒸馏任务：一次性全量，不按 session 偏移切片（spec 第一层）。
    if (job.sourceAgentId) return { turns, fullLength }
    // 无 sessionId（历史 job）-> 全量返回，向后兼容（不切片、不更新偏移）。
    if (!job.sessionId) return { turns, fullLength }
    // 有 sessionId -> 查偏移切片。getSessionOffset 失败降级全量（不阻塞蒸馏）。
    let offset = 0
    try { offset = await getSessionOffset(db, job.sessionId) }
    catch (e) { console.warn('memside: getSessionOffset failed, degrading to full', e); return { turns, fullLength } }
    return { turns: turns.slice(offset), fullLength }
  }
}

interface ResolveCallLLMDeps {
  loadClaudeCreds?: () => ClaudeCreds
  loadOpenAiCreds?: () => OpenAiCreds | null
}

/**
 * 组合根：按 `resolveLLMBackend(process.env)` 选后端，装配对应 `makeLLMCall` 为
 * `callLLM`。可选注入两套 creds 供测试避开网络；不传则各 `makeLLMCall` 用各自默认
 * loader（anthropic 读 `~/.claude` + env；openai 读 env）。后端选择逻辑由
 * `resolveLLMBackend` 单测覆盖（tests/llm.test.ts）；本函数是薄胶水。
 */
function resolveCallLLM(deps: ResolveCallLLMDeps = {}): LLMCall {
  return resolveLLMBackend(process.env) === 'openai'
    ? makeOpenAiCall(deps.loadOpenAiCreds ? { loadOpenAiCreds: deps.loadOpenAiCreds } : {})
    : makeAnthropicCall(deps.loadClaudeCreds ? { loadClaudeCreds: deps.loadClaudeCreds } : {})
}

/**
 * Single distill pass for tests: build `TickDeps` (loadTranscript from the
 * events table, callLLM from `resolveCallLLM` unless injected,
 * createCandidate from the store) and run one `tick`. Returns the count of
 * jobs processed.
 *
 * Both `loadClaudeCreds` / `loadOpenAiCreds` and `callLLM` are injectable so tests never
 * touch the network.
 */
export async function runDistillOnce(
  db: DbClient,
  deps: {
    loadClaudeCreds?: () => ClaudeCreds
    loadOpenAiCreds?: () => OpenAiCreds | null
    callLLM?: LLMCall
  } = {},
): Promise<number> {
  const callLLM = deps.callLLM ?? resolveCallLLM({ loadClaudeCreds: deps.loadClaudeCreds, loadOpenAiCreds: deps.loadOpenAiCreds })
  const tickDeps: TickDeps = {
    loadTranscript: makeLoadTranscript(db),
    callLLM,
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
 * start the 1Hz distill loop with the real `callLLM` (via
 * `resolveCallLLM()`). Optional `installClaudeHooks` writes the collector
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
  const app = createApp({ db, adapter, enqueueDistillJob, broadcast, staticDir: opts.serveStaticDir })
  const server = Bun.serve({ port, hostname: '127.0.0.1', fetch: app.fetch })

  const tickDeps: TickDeps = {
    loadTranscript: makeLoadTranscript(db),
    callLLM: resolveCallLLM(),
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
