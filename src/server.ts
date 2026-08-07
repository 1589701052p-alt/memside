import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { and, count, desc, eq, gt, inArray, isNull, notInArray, or } from 'drizzle-orm'
import { join } from 'node:path'
import { z } from 'zod'
import type { DbClient } from '@/db/client'
import { memories, memoryDistillJobs, memoryDistillEvents, memoryDiscards, memoryDistillRuns } from '@/db/schema'
import type { ClaudeCodeAdapter } from '@/adapter/claudeCode'
import type { RuntimeAdapter } from '@/adapter/types'
import type { MemoryStatus } from '@/memory/pure'
import { promoteCandidate, patchMemory, createCandidate, getMemoryById, getSourceInput, archiveMemory, unarchiveMemory, restoreMemory, promoteDiscard, listDiscards, getDistillRun, listRecentDistillRuns, listMemoriesPage, listDiscardsPage, listDistillRunsPage, bulkRejectUnevaluated, PROTECTED_VALUE_CLASSES, MemoryNotFoundError, type PageCursor } from '@/memory/store'
import { parseTranscriptFile, loadSubagentTranscript } from '@/claude/transcript'
import { parseOpencodeMessages } from '@/opencode/transcript'
import type { OpencodeMessage } from '@/opencode/transcript'
import type { EnqueueInput } from '@/scheduler'
import { loadUiLlmConfig, saveUiLlmConfig, maskToken, loadJudgeConfig, saveJudgeConfig, type UiLlmConfig } from '@/settings'
import type { JudgeConfig } from '@/memory/judgeConfig'
import { loadClaudeCreds, type ClaudeCreds } from './creds'
import { testConnection as defaultTestConnection } from './anthropic'
import { testConnection as openAiTestConnection, loadOpenAiUiCreds, type OpenAiCreds } from './openai'
import { resolveCallLLMProtocol, type LLMProtocol, type LLMCall } from '@/llm'
import { rescanCandidates, type RescanReport } from '@/memory/rescan'

export interface AppDeps {
  db: DbClient
  adapter: ClaudeCodeAdapter
  /** opencode runtime adapter（Task 4 接线）。与 `adapter`（claude code）并列；
   * 现有 `/hooks/claude/SessionStart` 与 `/inject` 仍走 `adapter`（claude），
   * `/hooks/opencode/inject` 走 `opencodeAdapter`。用 `RuntimeAdapter` 接口类型
   * 而非具体类，便于测试注入 fake（真实实例化在 daemon.ts: `new OpencodeAdapter(db)`）。 */
  opencodeAdapter: RuntimeAdapter
  enqueueDistillJob: (db: DbClient, input: EnqueueInput) => Promise<{ jobId: string; nextRunAt: number }>
  broadcast: (msg: unknown) => void
  /** 一键启动（生产模式）：vite build 产物目录（src/web/dist）。提供时
   * `GET /` 返回 index.html、`/assets/*` 走 serveStatic；不提供时行为与
   * 之前完全一致（vite dev 模式走 5173，不需要 daemon 托管）。 */
  staticDir?: string
  /** LLM 设置端点的注入点（均可选，缺省走真实实现；测试注入假实现，
   * 不碰真实 ~/.claude 与网络）。 */
  loadUiConfig?: () => UiLlmConfig | null
  saveUiConfig?: (patch: { baseURL?: string; token?: string; model?: string; protocol?: 'anthropic' | 'openai'; clear?: boolean }) => void
  loadEffectiveCreds?: () => ClaudeCreds
  loadEffectiveOpenAiCreds?: () => OpenAiCreds | null
  testConnection?: (cfg: { protocol: LLMProtocol; baseURL?: string; token: string; model?: string }) => Promise<{ ok: boolean; error?: string }>
  /** 存量回扫(Task 7)的 LLM 调用 seam。与 daemon 注入 scheduler 的 callLLM 同一份
   * (组合根 resolveCallLLM)。缺省时 POST /api/rescan 回 503(不静默起假回扫);
   * 测试注入 mock。 */
  callLLM?: LLMCall
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
 *    - `Stop`: the <50ms ack contract holds - the handler returns 202
 *      synchronously while a fire-and-forget IIFE (never awaited in the hot
 *      path) reads the JSONL file via `parseTranscriptFile`, persists the turns
 *      into `memory_distill_events`, and enqueues a distill job. `sourceKind`
 *      is `'conversation'`. The hook payload's `session_id` is read and passed
 *      to `enqueueDistillJob` so the scheduler can distill incrementally by turn
 *      offset (round 5).
 *      `PostToolUse` is skipped entirely (early-return 202 without
 *      parsing/enqueuing/broadcasting) - see the route handler. PostToolUse's
 *      transcript is a cumulative prefix of Stop's, so it would duplicate Stop.
 *      `SubagentStop` (round 7) is NOT skipped: it uses `loadSubagentTranscript`
 *      to read that subagent's own conversation file (double-fallback on
 *      `agent_id`), enqueues a one-off distill job tagged with `sourceAgentId`
 *      (no `sessionId` - subagents don't update the main session offset), and
 *      persists/broadcasts like Stop. Error signals still surface via
 *      detectErrorSignals on the Stop transcript.
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

  // LLM 设置端点的依赖解析（缺省走真实实现）：
  // - loadUi/saveUi：app_settings 表读写（Task 1 的 loadUiLlmConfig/saveUiLlmConfig）。
  // - loadEff：四级凭证链（Task 2 的 loadClaudeCreds，UI 级整级短路）。
  // - testConn：最小请求探测（Task 3 的 testConnection）。
  const loadUi = deps.loadUiConfig ?? (() => loadUiLlmConfig(deps.db))
  const saveUi = deps.saveUiConfig ?? ((patch: { baseURL?: string; token?: string; model?: string; protocol?: 'anthropic' | 'openai'; clear?: boolean }) => saveUiLlmConfig(deps.db, patch))
  const loadEff = deps.loadEffectiveCreds ?? (() => loadClaudeCreds(loadUi()))
  const loadEffOpenAi = deps.loadEffectiveOpenAiCreds ?? (() => loadOpenAiUiCreds(loadUi(), process.env))
  const testConn = deps.testConnection ?? ((cfg: { protocol: LLMProtocol; baseURL?: string; token: string; model?: string }) =>
    cfg.protocol === 'openai'
      ? openAiTestConnection({ baseURL: cfg.baseURL, token: cfg.token, model: cfg.model })
      : defaultTestConnection({ baseURL: cfg.baseURL, token: cfg.token, model: cfg.model })
  ) as (cfg: { protocol: LLMProtocol; baseURL?: string; token: string; model?: string }) => Promise<{ ok: boolean; error?: string }>

  /** 按协议解析当前生效 creds，统一为 {source, apiKey, baseURL?, model?}；无 creds 返回 null。 */
  function resolveEffective(
    proto: LLMProtocol,
    loadAnthropic: () => ClaudeCreds,
    loadOpenAi: () => OpenAiCreds | null,
  ): { source: string; apiKey: string; baseURL?: string; model?: string } | null {
    if (proto === 'openai') {
      const c = loadOpenAi()
      if (!c) return null
      return { source: c.source, apiKey: c.apiKey, baseURL: c.baseURL, model: c.model }
    }
    const c = loadAnthropic()
    if (!c.apiKey) return null
    return { source: c.source, apiKey: c.apiKey, ...(c.baseURL ? { baseURL: c.baseURL } : {}), ...(c.model ? { model: c.model } : {}) }
  }

  /** GET/PUT 共用的响应形状（Task 6/7 依赖）。token 只回 maskToken 打码，
   * 永不回明文（spec 硬约束）。loadUi 读异常降级 saved:null——GET 不得因
   * 存储读异常 500（spec）；loadEff 异常同理降级 effective:null。 */
  const buildState = () => {
    let saved: UiLlmConfig | null = null
    try { saved = loadUi() } catch { /* 存储异常降级 saved:null，不 500（spec） */ }
    let effective: { source: string; apiKey: string; baseURL?: string; model?: string } | null = null
    try {
      const proto = resolveCallLLMProtocol(saved, process.env)
      effective = resolveEffective(proto, loadEff, loadEffOpenAi)
    } catch { effective = null }
    const proto = resolveCallLLMProtocol(saved, process.env)
    return {
      saved: saved?.token
        ? { protocol: saved.protocol ?? 'anthropic', baseURL: saved.baseURL ?? null, model: saved.model ?? null, tokenMasked: maskToken(saved.token) }
        : null,
      effective: effective?.apiKey
        ? {
            source: effective.source,
            protocol: proto,
            baseURL: effective.baseURL ?? null,
            model: effective.model ?? null,
            tokenMasked: maskToken(effective.apiKey),
          }
        : null,
    }
  }

  // --- Collector ----------------------------------------------------------
  app.post('/hooks/claude/:event', async (c) => {
    const event = c.req.param('event')
    const body = await c.req.json().catch(() => ({}) as {
      transcript_path?: string; cwd?: string; sourceEventId?: string; session_id?: string; agent_id?: string
    })
    const cwd: string = body.cwd ?? ''
    const sessionId: string = body.session_id ?? ''

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

    // PostToolUse 不蒸馏（第四轮）：transcript 是累积式全量，与 Stop transcript
    // 前缀重叠，每次 tool call 一个 job 会导致同一段会话被重复蒸馏（同义候选爆炸）。
    // Stop/SubagentStop transcript 已含全部 tool_result（含 error），错误信号由
    // distiller 内的 detectErrorSignals 从 Stop transcript 提取，PostToolUse 无独有价值。
    if (event === 'PostToolUse') {
      return c.json({ ok: true }, 202)
    }

    // SubagentStop（第七轮）：不再早返回。payload 带 agent_id -> loadSubagentTranscript
    // 定位该 subagent 自己的对话文件（双路兜底）-> 单独蒸馏成独立任务（与主会话互不可见）。
    // subagent 一次性任务，不传 sessionId（不更新主会话偏移）；sourceAgentId 标来源。
    if (event === 'SubagentStop') {
      const agentId: string = body.agent_id ?? ''
      const transcriptPath: string = body.transcript_path ?? ''
      const sourceEventId: string = body.sourceEventId ?? `${event}-${Date.now()}`
      const debounceKey = `${cwd}:${event}`
      const sourceKind = 'conversation'  // events.kind：对话型数据（subagent 区分在 job.source_agent_id）
      // 失败模式可观测：payload 缺 agent_id 时 loadSubagentTranscript 只能退回 transcript_path
      // 兜底。同步路径打 warn（不入 IIFE，即使后续 enqueue 失败也留信号），便于发现 claude
      // code payload 变更悄悄禁用 subagent 蒸馏的情况。
      if (!agentId) {
        console.warn('memside: SubagentStop payload missing agent_id; falling back to transcript_path')
      }
      void (async () => {
        try {
          const turns = loadSubagentTranscript(transcriptPath, agentId)
          const { jobId } = await deps.enqueueDistillJob(deps.db, {
            sourceEventId, runtime: 'claude-code', cwd, debounceKey, sourceAgentId: agentId || null,
          })
          await deps.db.insert(memoryDistillEvents).values({
            distillJobId: jobId, attemptIndex: 0, ts: Date.now(),
            kind: sourceKind, payload: JSON.stringify(turns),
          })
        } catch (e) {
          deps.broadcast({ type: 'memory.enqueue.failed', sourceEventId, error: String(e) })
        }
      })()
      deps.broadcast({ type: 'memory.capture', sourceEventId })
      return c.json({ ok: true }, 202)
    }

    // Stop (C3 fix): claude code pipes
    // `transcript_path` (a JSONL file path, NOT an inline array). The old code
    // read `body.transcript` (inline) which is always undefined in production
    // -> turns=[] -> empty payload stored -> distiller got nothing. Tests
    // passed only because e2e mocked the transcript inline. Now we parse the
    // real JSONL file into TranscriptTurn[].
    const transcriptPath: string = body.transcript_path ?? ''
    const sourceEventId: string = body.sourceEventId ?? `${event}-${Date.now()}`
    const debounceKey = `${cwd}:${event}`
    const sourceKind = 'conversation'
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
        const { jobId } = await deps.enqueueDistillJob(deps.db, { sourceEventId, runtime: 'claude-code', cwd, debounceKey, sessionId })
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

  // opencode injector（Task 4 接线）：opencode plugin 的 messages.transform 钩子
  // 在新会话首条 user 消息前 GET 这个端点，把审批记忆块注入会话上下文（对齐 claude
  // code 的 /inject + SessionStart 闭环，但 opencode 走 query 传 cwd + opencodeAdapter）。
  // 与上面 /inject 的差异仅在用 opencodeAdapter（跨 runtime 共享记忆，spec §5）。
  // capture 路由（POST /hooks/opencode/capture，Task 5）注册在下方。
  app.get('/hooks/opencode/inject', async (c) => {
    const cwd = c.req.query('cwd') ?? ''
    const block = await deps.opencodeAdapter.inject({ cwd })
    return c.json({ block })
  })

  // opencode capture（Task 5 接线）：opencode idle hook 在会话空闲时 POST 全量 messages。
  // 与 claude code Stop 路由（server.ts:222-238）同构：fire-and-forget IIFE 转 turns ->
  // enqueueDistillJob + memory_distill_events 行 -> 202 同步 ack（<50ms 契约）。
  // 差异：opencode transcript 是 inline messages（非 JSONL 文件），由 parseOpencodeMessages
  // 转换；debounceKey 优先用 sessionId（多 opencode 会话隔离），缺省回退 `${cwd}:opencode`。
  // 错误信号不走单独路由：全量 transcript 内的 isError turn 由 distiller 的 detectErrorSignals
  // 提取（对齐 claude code PostToolUse 跳过决策，server.ts:154-157）。
  app.post('/hooks/opencode/capture', async (c) => {
    const body = await c.req.json().catch(() => ({}) as {
      sessionId?: string; cwd?: string; messages?: OpencodeMessage[]; sourceEventId?: string
    })
    const cwd = body.cwd ?? ''
    const sessionId = body.sessionId ?? ''
    const sourceEventId = body.sourceEventId ?? `opencode-idle-${Date.now()}`
    const debounceKey = sessionId || `${cwd}:opencode`
    // parseOpencodeMessages 在 IIFE try/catch 内（对齐 claude code Stop 路由 server.ts:224-238）：
    // 同步抛出会逃逸 async 路由 -> 500，违反「<50ms 202 ack」契约。body.messages 非数组真值
    // （`??` 只挡 null/undefined）或缺 parts 的畸形 payload 由 transcript.ts 守卫跳过不抛，
    // 双保险：即便守卫漏网，IIFE catch 也记 memory.enqueue.failed 而非 500。
    void (async () => {
      try {
        const turns = parseOpencodeMessages(Array.isArray(body.messages) ? body.messages : [])
        const { jobId } = await deps.enqueueDistillJob(deps.db, {
          sourceEventId, runtime: 'opencode', cwd, debounceKey, sessionId,
        })
        await deps.db.insert(memoryDistillEvents).values({
          distillJobId: jobId, attemptIndex: 0, ts: Date.now(),
          kind: 'conversation', payload: JSON.stringify(turns),
        })
      } catch (e) {
        deps.broadcast({ type: 'memory.enqueue.failed', sourceEventId, error: String(e) })
      }
    })()
    deps.broadcast({ type: 'memory.capture', sourceEventId })
    return c.json({ ok: true }, 202)
  })

  // --- Memory API ---------------------------------------------------------
  // 回扫状态(单实例,随 createApp 闭包;fire-and-forget 与 distill loop 同款)。
  // running 期间重按 -> 409;进度(done/total/discarded)、停止标记(stopping/
  // cancelRequested)、完成报告与运行级崩溃 error 经 GET /api/status 暴露。
  let rescanState: {
    running: boolean; done: number; total: number; discarded: number
    stopping: boolean; cancelRequested: boolean
    report: RescanReport | null; error: string | null
  } = { running: false, done: 0, total: 0, discarded: 0, stopping: false, cancelRequested: false, report: null, error: null }

  // Status (background visibility): lets the web UI show capture / distill
  // activity so the user isn't staring at an empty queue with no clue whether
  // the daemon is working. Returns event count, recent distill-job stats, and
  // the most recent error (if any).
  // 计数全部走 SQL 聚合（COUNT/GROUP BY），不做全表物化——此前 5 个 SELECT *
  // 仅用于数行数，其中 memory_distill_events 含完整 hook payload，实测全表
  // 物化 ~870ms（2741 行），拖慢每次 tab 切换与 3s 轮询（Promise.all 同等待）。
  app.get('/api/status', async (c) => {
    // jobs 统计语义 = 最近 20 个 job（按 createdAt desc）——只取所需两列。
    const jobs = await deps.db.select({ status: memoryDistillJobs.status, lastError: memoryDistillJobs.lastError })
      .from(memoryDistillJobs).orderBy(desc(memoryDistillJobs.createdAt)).limit(20).all()
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    const eventCount = await deps.db.select({ n: count() }).from(memoryDistillEvents).all()
    const memGroups = await deps.db.select({ status: memories.status, n: count() }).from(memories).groupBy(memories.status).all()
    const discardCount = await deps.db.select({ n: count() }).from(memoryDiscards).all()
    const runGroups = await deps.db.select({ outcome: memoryDistillRuns.outcome, n: count() })
      .from(memoryDistillRuns).where(gt(memoryDistillRuns.ts, cutoff)).groupBy(memoryDistillRuns.outcome).all()
    // 全量 run 数：runs tab 列表计数用（total 是 24h 活动窗口，当总数会误导）。
    const runAllTime = await deps.db.select({ n: count() }).from(memoryDistillRuns).all()
    // 未评估候选计数（与 bulkRejectUnevaluated 同条件，spec 决策 4）：保护类
    // valueClass 之外/无 valueClass 的 candidate。
    const unevalCount = await deps.db.select({ n: count() }).from(memories).where(and(
      eq(memories.status, 'candidate'),
      or(isNull(memories.valueClass), notInArray(memories.valueClass, [...PROTECTED_VALUE_CLASSES])),
    )).all()
    const jobStats: Record<string, number> = {}
    for (const j of jobs) jobStats[j.status] = (jobStats[j.status] ?? 0) + 1
    const memStats: Record<string, number> = {}
    for (const g of memGroups) memStats[g.status] = g.n
    const runStats: Record<string, number> = {}
    for (const g of runGroups) runStats[g.outcome] = g.n
    const errored = jobs.find((j) => j.lastError)
    return c.json({
      events: eventCount[0]?.n ?? 0,
      jobs: jobStats,
      memories: memStats,
      discards: discardCount[0]?.n ?? 0,
      distillRuns: { total: runGroups.reduce((s, g) => s + g.n, 0), byOutcome: runStats, allTime: runAllTime[0]?.n ?? 0 },
      lastError: errored ? { error: errored.lastError } : null,
      unevaluatedCandidates: unevalCount[0]?.n ?? 0,
      rescan: rescanState,
    })
  })

  // 存量回扫(Task 7,spec §4.7):fire-and-forget——202 立即返回,后台按当前判定
  // 模式重判全部候选;进度(done/total/discarded)、停止标记与完成报告在 GET
  // /api/status 的 rescan 字段。
  // 并发重按防护:running 期间 409。中断后直接重按,无脏状态(判丢离开候选池天然
  // 不重判,判留重判幂等)。
  app.post('/api/rescan', (c) => {
    if (rescanState.running) return c.json({ error: 'rescan already running' }, 409)
    if (!deps.callLLM) return c.json({ error: 'rescan unavailable: no LLM configured' }, 503)
    const callLLM = deps.callLLM
    rescanState = {
      running: true, done: 0, total: 0, discarded: 0,
      stopping: false, cancelRequested: false, report: null, error: null,
    }
    void (async () => {
      try {
        const report = await rescanCandidates(deps.db, {
          callLLM,
          loadJudgeConfig: () => loadJudgeConfig(deps.db),
        },
        (done, total, discarded) => {
          rescanState.done = done; rescanState.total = total; rescanState.discarded = discarded
        },
        () => rescanState.cancelRequested)  // 批边界停止(spec §3.2)
        rescanState.report = report
      } catch (e) {
        console.warn('memside: rescan failed', e)
        rescanState.error = String(e)  // 崩溃透传:UI 红字可见,不静默解锁
      } finally {
        rescanState.running = false
        rescanState.stopping = false
        rescanState.cancelRequested = false
        deps.broadcast({ type: 'rescan' })
      }
    })()
    return c.json({ started: true }, 202)
  })

  // 回扫取消(spec §3.2):只置标记,粒度=批边界——正在判的批照常判完落库,
  // 后续批次不再开始;未在跑 409(UI 忽略,轮询自愈)。
  app.post('/api/rescan/cancel', (c) => {
    if (!rescanState.running) return c.json({ error: 'no rescan running' }, 409)
    rescanState.cancelRequested = true
    rescanState.stopping = true
    return c.json({ stopping: true }, 202)
  })

  /** 非法/缺省游标宽松忽略（undefined = 第一页），不 400（spec 契约）。 */
  function parseBefore(c: { req: { query: (k: string) => string | undefined } }): PageCursor | undefined {
    const b = c.req.query('before')
    const bid = c.req.query('beforeId')
    if (!b || !bid) return undefined
    const ts = Number(b)
    if (!Number.isFinite(ts)) return undefined
    return { ts, id: bid }
  }

  app.get('/api/memories', async (c) => {
    const statusParam = c.req.query('status') ?? ''
    const VALID: Set<string> = new Set(['candidate', 'approved', 'archived', 'superseded', 'rejected'])
    const wanted = statusParam.split(',').map((s) => s.trim()).filter((s): s is MemoryStatus => s.length > 0 && VALID.has(s))
    // 带 limit -> 游标分页（spec 2026-08-07）；不带 -> 旧全量形状（兼容锚点）
    if (c.req.query('limit') !== undefined) {
      const page = await listMemoriesPage(deps.db, {
        statuses: wanted,
        limit: Number(c.req.query('limit')),
        before: parseBefore(c),
      })
      return c.json(page)
    }
    const rows = wanted.length > 0
      ? await deps.db.select().from(memories).where(inArray(memories.status, wanted)).orderBy(desc(memories.createdAt)).all()
      : await deps.db.select().from(memories).orderBy(desc(memories.createdAt)).all()
    return c.json({ items: rows })
  })

  app.get('/api/memories/:id', async (c) => {
    const got = await getMemoryById(deps.db, c.req.param('id'))
    if (!got) return c.json({ error: 'not found' }, 404)
    return c.json(got)
  })

  // 原始输入溯源：懒加载产生这条记忆的「蒸馏时喂模型的过滤版 transcript」。
  // 不塞进列表接口（避免 3s 轮询响应膨胀）。无 distillJobId（手动/历史）或无快照行
  // -> available:false（不回填、不撒谎）；有快照 -> 返回 turns + memory 摘要。
  app.get('/api/memories/:id/source-input', async (c) => {
    const got = await getMemoryById(deps.db, c.req.param('id'))
    if (!got) return c.json({ error: 'not found' }, 404)
    const m = got.memory
    if (!m.distillJobId) return c.json({ available: false })
    const snap = await getSourceInput(deps.db, m.distillJobId)
    if (!snap) return c.json({ available: false })
    return c.json({
      available: true,
      title: m.title,
      bodyMd: m.bodyMd,
      valueClass: m.valueClass,
      sourceCwd: m.sourceCwd,
      createdAt: m.createdAt,
      turnCount: snap.turnCount,
      charCount: snap.charCount,
      turns: snap.turns,
    })
  })

  app.post('/api/memories/:id/promote', async (c) => {
    // 空/非法 body 优雅 400：曾裸 c.req.json() 在 try 外，空 body 抛
    // "Unexpected end of JSON input" 逃逸成 500。action 校验同时挡住空对象 {}
    // 被当 approve 的意外（body.action undefined !== 'reject' -> 走 else approve 分支）。
    const body = await c.req.json().catch(() => null)
    const validActions = ['approve', 'reject', 'approve_and_supersede']
    if (!body || typeof body !== 'object' || !validActions.includes(body.action)) {
      return c.json({ error: `body.action must be one of: ${validActions.join(', ')}` }, 400)
    }
    try {
      const m = await promoteCandidate(deps.db, c.req.param('id'), body)
      deps.broadcast({ type: 'memory.promoted', memoryId: m.id, newStatus: m.status })
      return c.json({ memory: m })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 409)
    }
  })

  app.patch('/api/memories/:id', async (c) => {
    // 空/非对象 body 优雅 400：曾裸 c.req.json() 在 try 外，空 body 抛错逃逸 500。
    // 空对象 {} 是合法 no-op（patchMemory 所有 !== undefined 守卫均跳过，changed=[]）。
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'request body required' }, 400)
    }
    try {
      const r = await patchMemory(deps.db, c.req.param('id'), body)
      deps.broadcast({ type: 'memory.updated', memoryId: r.memory.id, changedFields: r.changedFields })
      return c.json(r)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 409)
    }
  })

  app.post('/api/memories/bulk-promote', async (c) => {
    const body = await c.req.json().catch(() => ({ ids: [] as string[], action: 'reject' }))
    const ids: string[] = Array.isArray(body.ids) ? body.ids.filter((x: unknown) => typeof x === 'string') : []
    let count = 0
    for (const id of ids) {
      try {
        const m = await promoteCandidate(deps.db, id, { action: 'reject' })
        deps.broadcast({ type: 'memory.promoted', memoryId: m.id, newStatus: m.status })
        count += 1
      } catch {
        // skip not-found / non-candidate (already terminal); continue with the rest
      }
    }
    return c.json({ rejected: count })
  })

  // 服务端按条件批量拒绝「未评估」候选（spec 决策 4）：覆盖整个尾队，
  // 不依赖前端分页加载了多少。
  app.post('/api/memories/bulk-reject-unevaluated', async (c) => {
    const r = await bulkRejectUnevaluated(deps.db)
    deps.broadcast({ type: 'memories.bulk-rejected', rejected: r.rejected })
    return c.json(r)
  })

  // --- Discards (AI 自动拒绝审计) -----------------------------------------
  app.get('/api/discards', async (c) => {
    if (c.req.query('limit') !== undefined) {
      return c.json(await listDiscardsPage(deps.db, { limit: Number(c.req.query('limit')), before: parseBefore(c) }))
    }
    const items = await listDiscards(deps.db)
    return c.json({ items })
  })

  app.post('/api/discards/:id/promote', async (c) => {
    try {
      const m = await promoteDiscard(deps.db, c.req.param('id'))
      deps.broadcast({ type: 'discard.promoted', memoryId: m.id, discardId: c.req.param('id') })
      return c.json({ memory: m })
    } catch (e) {
      if (e instanceof MemoryNotFoundError) return c.json({ error: (e as Error).message }, 404)
      return c.json({ error: (e as Error).message }, 409)
    }
  })

  // --- Distill runs (工作记录透明化) --------------------------------------
  // 列表不含 rawOutput（走详情端点懒加载）；详情返回完整 DistillRunRow 或 404；
  // source-input 复用按 distillJobId 查快照的 store 函数。
  app.get('/api/distill-runs', async (c) => {
    // 带 limit -> 游标分页；不带 -> 旧 LIMIT 200 形状（兼容锚点）。
    // 旧 limit 参数解析（cap 500）随分流删除——带 limit 现在走分页形状；
    // 现有 web UI 不传 limit（App.tsx 的 listDistillRuns(fetch)），无行为回退。
    if (c.req.query('limit') !== undefined) {
      return c.json(await listDistillRunsPage(deps.db, { limit: Number(c.req.query('limit')), before: parseBefore(c) }))
    }
    const items = await listRecentDistillRuns(deps.db, { limit: 200 })
    return c.json({ items })
  })

  app.get('/api/distill-runs/:jobId', async (c) => {
    const run = await getDistillRun(deps.db, c.req.param('jobId'))
    if (!run) return c.json({ error: 'not found' }, 404)
    return c.json(run)
  })

  app.get('/api/distill-runs/:jobId/source-input', async (c) => {
    const snap = await getSourceInput(deps.db, c.req.param('jobId'))
    if (!snap) return c.json({ error: 'not found' }, 404)
    return c.json({ turnCount: snap.turnCount, charCount: snap.charCount, turns: snap.turns })
  })

  // --- LLM settings (Web UI 凭证配置) --------------------------------------
  // saved = UI 级（app_settings 表），effective = 四级凭证链实际生效级；
  // 两者都只回打码 token。PUT 走字段级合并（token 缺省保持已存值；clear 清整级）；
  // baseURL 限 http(s)（'' 允许 = 回默认端点）。saveUi 抛错（DB 写失败）自然 500，
  // 但 buildState 内的读异常已降级（见上）。
  app.get('/api/settings/llm', (c) => c.json(buildState()))

  const putSchema = z.object({
    baseURL: z.string().regex(/^https?:\/\//, 'baseURL must be http(s) URL').optional().or(z.literal('')),
    token: z.string().optional(),
    model: z.string().optional(),
    protocol: z.enum(['anthropic', 'openai']).optional(),
    clear: z.boolean().optional(),
  })
  app.put('/api/settings/llm', async (c) => {
    const parsed = putSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid body' }, 400)
    saveUi(parsed.data)
    return c.json(buildState())
  })

  // 「测试连接」：body 字段缺省时回落到已保存的 UI 级配置；解析不出 token ->
  // {ok:false,error:'no credentials'}（HTTP 200——这是业务结果不是请求错误）。
  // body 里的 token 只用于本次探测，不落存储。
  const testSchema = z.object({
    baseURL: z.string().optional(),
    token: z.string().optional(),
    model: z.string().optional(),
    protocol: z.enum(['anthropic', 'openai']).optional(),
  })
  app.post('/api/settings/llm/test', async (c) => {
    const body = testSchema.parse(await c.req.json().catch(() => ({})))
    const saved = loadUi()
    const cfg = {
      protocol: (body.protocol ?? saved?.protocol ?? 'anthropic') as LLMProtocol,
      baseURL: body.baseURL ?? saved?.baseURL,
      token: body.token ?? saved?.token,
      model: body.model ?? saved?.model,
    }
    if (!cfg.token) return c.json({ ok: false, error: 'no credentials' })
    return c.json(await testConn({ protocol: cfg.protocol, baseURL: cfg.baseURL, token: cfg.token, model: cfg.model }))
  })

  // 「测试生效」：无 body，后端自解析当前生效的 creds + 协议（与 buildState 同源，
  // 确保测的是 distill 实际会用的那套）。无 creds / 存储异常 -> {ok:false,error:'no credentials'}
  // （HTTP 200——业务结果不是请求错误）。复用 testConn 派发器，测试注入零网络。
  app.post('/api/settings/llm/test-effective', async (c) => {
    let saved: UiLlmConfig | null = null
    try { saved = loadUi() } catch { saved = null }
    let effective: { source: string; apiKey: string; baseURL?: string; model?: string } | null = null
    try {
      const proto = resolveCallLLMProtocol(saved, process.env)
      effective = resolveEffective(proto, loadEff, loadEffOpenAi)
    } catch { effective = null }
    if (!effective?.apiKey) return c.json({ ok: false, error: 'no credentials' })
    const proto = resolveCallLLMProtocol(saved, process.env)
    return c.json(await testConn({ protocol: proto, baseURL: effective.baseURL, token: effective.apiKey, model: effective.model }))
  })

  // --- Judge settings (判定模式 + agent 预算) ---------------------------------
  // GET 回当前生效配置（脏数据逐字段回默认/夹取，见 settings.loadJudgeConfig）。
  // PUT 字段级保存：非法 mode / 非数字预算 400 拒绝，不落存储；读取回显最新生效值。
  // scheduler 每次 tick 现读（TickDeps.loadJudgeConfig），UI 改动即时生效不重启。
  app.get('/api/settings/judge', (c) => c.json(loadJudgeConfig(deps.db)))

  app.put('/api/settings/judge', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object') return c.json({ error: 'invalid body' }, 400)
    const b = body as Record<string, unknown>
    if (b.mode !== undefined && b.mode !== 'quality' && b.mode !== 'economy') return c.json({ error: 'invalid mode' }, 400)
    for (const k of ['maxRounds', 'timeBudgetS'] as const) {
      if (b[k] !== undefined && (typeof b[k] !== 'number' || !Number.isFinite(b[k]))) return c.json({ error: `invalid ${k}` }, 400)
    }
    saveJudgeConfig(deps.db, b as Partial<JudgeConfig>)
    return c.json(loadJudgeConfig(deps.db))
  })

  // --- Archive / unarchive / restore --------------------------------------
  app.post('/api/memories/:id/archive', async (c) => {
    try {
      const m = await archiveMemory(deps.db, c.req.param('id'))
      deps.broadcast({ type: 'memory.archived', memoryId: m.id, newStatus: m.status })
      return c.json({ memory: m })
    } catch (e) {
      if (e instanceof MemoryNotFoundError) return c.json({ error: (e as Error).message }, 404)
      return c.json({ error: (e as Error).message }, 409)
    }
  })

  app.post('/api/memories/:id/unarchive', async (c) => {
    try {
      const m = await unarchiveMemory(deps.db, c.req.param('id'))
      deps.broadcast({ type: 'memory.unarchived', memoryId: m.id, newStatus: m.status })
      return c.json({ memory: m })
    } catch (e) {
      if (e instanceof MemoryNotFoundError) return c.json({ error: (e as Error).message }, 404)
      return c.json({ error: (e as Error).message }, 409)
    }
  })

  app.post('/api/memories/:id/restore', async (c) => {
    try {
      const m = await restoreMemory(deps.db, c.req.param('id'))
      deps.broadcast({ type: 'memory.restored', memoryId: m.id, newStatus: m.status })
      return c.json({ memory: m })
    } catch (e) {
      if (e instanceof MemoryNotFoundError) return c.json({ error: (e as Error).message }, 404)
      return c.json({ error: (e as Error).message }, 409)
    }
  })

  app.post('/api/memories', async (c) => {
    const body = await c.req.json()
    const m = await createCandidate(deps.db, { ...body, sourceKind: 'manual', runtime: body.runtime ?? null })
    deps.broadcast({ type: 'memory.candidate.created', memoryId: m.id })
    return c.json({ memory: m }, 201)
  })

  // --- Static hosting (one-click launch, production mode) ------------------
  // 注册在末尾：具名路由（/api/*、/inject、/hooks/*）先匹配，静态处理只在
  // 未命中时介入，不会抢占 API（与 CLAUDE.md 的 vite proxy 陷阱同类问题）。
  if (deps.staticDir) {
    app.get('/', serveStatic({ path: join(deps.staticDir, 'index.html') }))
    app.use('/assets/*', serveStatic({ root: deps.staticDir }))
  }

  return app
}
