import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { DbClient } from '@/db/client'
import { openDb } from '@/db/client'
import { memoryDistillEvents, memoryDistillJobs } from '@/db/schema'
import { tick, startMemoryDistillLoop, enqueueDistillJob, type TickDeps } from '@/scheduler'
import { createCandidate, getSessionOffset, insertNotification, markNotificationsReadByKind } from '@/memory/store'
import type { TranscriptTurn } from '@/memory/pure'
import { makeLLMCall as makeAnthropicCall } from '@/anthropic'
import { makeLLMCall as makeOpenAiCall, type OpenAiCreds } from '@/openai'
import { resolveCallLLMProtocol, type LLMCall, type LLMCallOpts } from '@/llm'
import { loadUiLlmConfig, loadJudgeConfig, loadRuntimePaths, defaultRuntimePaths, type UiLlmConfig, type RuntimePaths } from './settings'
import { type ClaudeCreds } from './creds'
import { createApp } from './server'
import { ClaudeCodeAdapter } from './adapter/claudeCode'
import { OpencodeAdapter } from './adapter/opencode'
import { installHooks, installOpencodePlugin, uninstallOpencodePlugin, isHooksInstalled, isOpencodePluginInstalled, checkAllHooksInstalled, type HookInstallSummary } from './install'
import { createActivityTracker } from './activity'

export interface DaemonOpts {
  dbPath?: string
  port?: number
  installClaudeHooks?: boolean
  /** 一键启动（生产模式）：vite build 产物目录，透传为 createApp 的
   * staticDir。不传则 daemon 不托管静态文件（裸 daemon 语义不变）。 */
  serveStaticDir?: string
  /** 内存静态资产（exe 模式）：透传 createApp.staticAssets，与 serveStaticDir 互斥。
   * dev/npm 用 serveStaticDir 走磁盘。 */
  serveStaticAssets?: { indexHtml: string; assets: Record<string, Uint8Array> }
  /** opencode 插件源（让 UI 的「保存并安装」能在请求时装/卸 opencode，spec runtime-settings-redesign §3.2）。
   *  - dev/npm：cli.ts 传 { srcDir: <repo>/opencode-plugin }
   *  - exe：launcher 传 { files: { memside.js, 'package.json' } }
   *  缺省 → daemon 不暴露 opencode install 能力（端点 ok:false + 说明）；uninstall 仍可用。 */
  opencodePluginSource?: { srcDir: string } | { files: { 'memside.js': string; 'package.json': string } }
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
    if (job.sourceAgentId) return { turns, fullLength, prefixTurns: [] }
    // 无 sessionId（历史 job）-> 全量返回，向后兼容（不切片、不更新偏移）。
    if (!job.sessionId) return { turns, fullLength, prefixTurns: [] }
    // 有 sessionId -> 查偏移切片。getSessionOffset 失败降级全量（不阻塞蒸馏）。
    let offset = 0
    try { offset = await getSessionOffset(db, job.sessionId) }
    catch (e) { console.warn('memside: getSessionOffset failed, degrading to full', e); return { turns, fullLength, prefixTurns: [] } }
    // prefixTurns = 已蒸馏过的前缀（spec §4.7）：tick 用其构建 priorContext。
    return { turns: turns.slice(offset), fullLength, prefixTurns: turns.slice(0, offset) }
  }
}

interface ResolveCallLLMDeps {
  loadClaudeCreds?: () => ClaudeCreds
  loadOpenAiCreds?: () => OpenAiCreds | null
}

/**
 * 组合根：每次调用现读 UI 配置（`loadUiLlmConfig(db)`），经 `resolveCallLLMProtocol`
 * 动态解析协议（UI token 存在时 UI 的 protocol 压过 env；否则回退
 * `resolveLLMBackend(env)`），再派发到 anthropic / openai 后端并注入
 * `loadUiConfig`。这样 UI 设置页的协议切换即时生效，无需重启 daemon。
 * 可选注入两套 creds 供测试避开网络；不传则各 `makeLLMCall` 用各自默认
 * loader（anthropic 读 `~/.claude` + env；openai 读 env）。协议解析逻辑由
 * `resolveCallLLMProtocol` 单测覆盖（tests/llm.test.ts）；本函数是薄胶水。
 *
 * 传入 `db` 时，被选中的链路注入 db-backed `loadUiConfig`（UI 设置页写入的
 * 凭证整级短路生效）。DB 读取异常降级为无 UI 级（返回 null），不沿 LLM 调用
 * 路径炸掉 distill——与全项目「存储异常降级」一致。
 */
export function resolveCallLLM(deps: ResolveCallLLMDeps = {}, db?: DbClient): LLMCall {
  return async function callLLM(system: string, user: string, opts?: LLMCallOpts): Promise<string> {
    // 每次调用现读 UI 配置；DB 读异常降级为无 UI 级（不炸 distill）
    let ui: UiLlmConfig | null = null
    if (db) { try { ui = loadUiLlmConfig(db) } catch { ui = null } }
    const proto = resolveCallLLMProtocol(ui, process.env)
    if (proto === 'openai') {
      const call = makeOpenAiCall({
        ...(deps.loadOpenAiCreds ? { loadOpenAiCreds: deps.loadOpenAiCreds } : {}),
        ...(db ? { loadUiConfig: () => ui } : {}),
      })
      return await call(system, user, opts)
    }
    const call = makeAnthropicCall({
      ...(deps.loadClaudeCreds ? { loadClaudeCreds: deps.loadClaudeCreds } : {}),
      ...(db ? { loadUiConfig: () => ui } : {}),
    })
    return await call(system, user, opts)
  }
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
  const callLLM = deps.callLLM ?? resolveCallLLM({ loadClaudeCreds: deps.loadClaudeCreds, loadOpenAiCreds: deps.loadOpenAiCreds }, db)
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
 * 四槽全空提醒周期（spec 2026-08-19 §3.1）：启动立即一次 + 每 30s 复探。
 * 探针毫秒级，30s 无负担；卸载后 ≤30s 内提醒（显眼化，原 5min 太久）。
 */
const HOOK_CHECK_INTERVAL_MS = 30 * 1000

/**
 * 探测四槽 hook 安装状态并据此写/清 hook_missing 提醒（spec 2026-08-19 §3.5）。
 * allMissing → 写一条（insertNotification 同内容折叠防刷屏）；任一已装 → 清未读
 * hook_missing（用户装好后旧提醒自动消失）。永不抛：探针/存储异常降级只 warn。
 * opts 可注入 checkAllHooksInstalledFn 便于测试避开真实磁盘。
 */
export async function checkHooksAndNotify(
  db: DbClient,
  opts?: { checkAllHooksInstalledFn?: (db: DbClient) => HookInstallSummary },
): Promise<void> {
  const check = opts?.checkAllHooksInstalledFn ?? ((d) => checkAllHooksInstalled(d))
  try {
    const summary = check(db)
    if (summary.allMissing) {
      await insertNotification(db, {
        kind: 'hook_missing',
        title: '运行环境未安装 hook',
        body: '检测到 claude code / codeagent / opencode / nga 四个槽均未安装，记忆捕获将不会生效。请打开「设置」页安装至少一个 agent 的 hook。',
      })
    } else {
      await markNotificationsReadByKind(db, 'hook_missing')
    }
  } catch (e) {
    console.warn('memside: hook install check failed', e)
  }
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

  // LLM 实时活动单例（spec 2026-08-12 §5.7）：scheduler 侧置位，server 侧读出。
  const tracker = createActivityTracker()
  const adapter = new ClaudeCodeAdapter(db)
  // opencode runtime adapter（Task 4 接线）：与 claude adapter 共享同一 db，
  // project 记忆跨 runtime 共享（spec §5，listApprovedByScope 已去 runtime 过滤）。
  // /hooks/opencode/inject 走它；capture 路由与 plugin 安装在 Task 5/6/7 落地。
  const opencodeAdapter = new OpencodeAdapter(db)
  const broadcast = (msg: unknown) => { /* WS fan-out placeholder; MVP polls /api/memories */ void msg }
  // opencode 插件 install/uninstall 接缝（spec runtime-settings-redesign §3.2）。
  // install 依赖 source（srcDir/files）；uninstall 不依赖 source，恒注入真实实现。
  const installOpencodePluginFn = opts.opencodePluginSource
    ? (o: { baseDir?: string }) => {
        const src = opts.opencodePluginSource as { srcDir?: string; files?: { 'memside.js': string; 'package.json': string } }
        if (src.srcDir) installOpencodePlugin({ port, baseDir: o.baseDir, pluginSrcDir: src.srcDir })
        else if (src.files) installOpencodePlugin({ port, baseDir: o.baseDir, files: src.files })
      }
    : undefined
  const uninstallOpencodePluginFn = (o: { baseDir?: string }) => uninstallOpencodePlugin(o)
  // 只读安装探针（spec 2026-08-19-runtime-settings-four-slots §status）：无条件下注入
  // （探针只读磁盘、不依赖插件源，与 uninstallOpencodePluginFn 同款），让生产 daemon
  // 的 GET /api/settings/runtime/status 探测真实安装状态而非降级 installed:false。
  const isHooksInstalledFn = (o: { baseDir?: string; settingsFilename?: string }) => isHooksInstalled(o)
  const isOpencodePluginInstalledFn = (o: { baseDir?: string }) => isOpencodePluginInstalled(o)
  const app = createApp({
    db,
    adapter,
    opencodeAdapter,
    enqueueDistillJob,
    broadcast,
    staticDir: opts.serveStaticDir,
    staticAssets: opts.serveStaticAssets,
    tracker,
    callLLM: resolveCallLLM({}, db),
    port,
    installOpencodePluginFn,
    uninstallOpencodePluginFn,
    isHooksInstalledFn,
    isOpencodePluginInstalledFn,
  })
  const server = Bun.serve({ port, hostname: '127.0.0.1', fetch: app.fetch })

  const tickDeps: TickDeps = {
    loadTranscript: makeLoadTranscript(db),
    tracker,
    callLLM: resolveCallLLM({}, db),
    createCandidate,
    // 每 tick 现读 app_settings 的判定配置：UI 设置页改动即时生效，不重启 daemon
    // （与 resolveCallLLM 的「每次调用现读 UI 配置」同一语义）。
    loadJudgeConfig: () => loadJudgeConfig(db),
  }
  const stopLoop = startMemoryDistillLoop(db, tickDeps)

  if (opts.installClaudeHooks) {
    // 读 UI 配置的运行环境路径（四槽）。存储异常降级到默认四槽。本 spec 不碰启动时
    // 自动装的语义（spec §5「零回归」）——只装 claude 槽（与改动前同款单槽行为，仅
    // 适配 Task 1 的 4-slot 形状）。codeagent 槽装 hooks 走 §3.6 ?target=codeagent 端点
    // / UI 按钮，不在 daemon 启动时自动装。
    let rp: RuntimePaths
    try { rp = loadRuntimePaths(db) } catch { rp = defaultRuntimePaths() }
    installHooks({ port, baseDir: rp.claude.dir, settingsFilename: rp.claude.settingsFilename })
  }

  // 四槽全空提醒（spec 2026-08-19 §3.5 + 显眼化 §3.1）：启动立即一次 + 每 30s 周期复探。
  // I1 修复（final review 2026-08-19）：探测必须排在 installClaudeHooks 块之后——
  // 否则 exe 首启 opts.installClaudeHooks:true 时探针先于装 hook 跑，四槽必然全空
  // → 写一条假阳性「未安装 hook」提醒（实际 memside 马上装好）。装完再探，语义不变。
  void checkHooksAndNotify(db)
  const hookCheckTimer = setInterval(() => { void checkHooksAndNotify(db) }, HOOK_CHECK_INTERVAL_MS)
  hookCheckTimer.unref?.()

  return {
    server,
    stop: () => {
      clearInterval(hookCheckTimer)
      stopLoop()
      server.stop()
    },
  }
}
