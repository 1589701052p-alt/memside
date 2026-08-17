import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Grep-able marker stamped onto every memside-managed hook command.
 *
 * - Lets `installHooks` find and replace its own prior entries on re-run
 *   (idempotent merge) without touching user-authored hooks.
 * - Surfaced in `~/.claude/settings.json` as a curl request header
 *   (`-H "x-memside-tag: memside-managed"`) so a human inspecting the file can
 *   see which hooks memside owns. The collector ignores request headers (it
 *   reads only the JSON body), so the header is safe noise.
 *
 * Why a header and not a shell comment: on Windows the hook command runs under
 * cmd.exe, where `#` is not a comment token - `# memside-managed` would be
 * passed to curl as extra arguments, breaking the POST. An HTTP header is
 * ignored by curl's argument parser (it's a `-H` value) and by the collector
 * (it reads only the JSON body), so it is the portable idempotency marker.
 */
export const MEMSIDE_TAG = 'memside-managed'

export interface InstallOpts {
  port: number
  /**
   * Override the claude config dir (default `~/.claude`). Tests pass a tmp dir
   * so they never touch the real user settings.
   */
  baseDir?: string
}

/**
 * The five claude code hook events memside subscribes to. Each event is a
 * POST to the collector (`POST /hooks/claude/<event>`, see `src/server.ts`).
 *
 * - SessionStart / Stop / SubagentStop -> `sourceKind: 'conversation'`
 * - PostToolUse -> `sourceKind: 'error'` (error-signal transcript path)
 * - SessionEnd -> flush 标记（攒量批处理收尾，spec §4.8）：会话有序结束时
 *   在 memory_session_flushes 落一行，tick sweep 据此结算该 session 的
 *   waiting job；崩溃/强杀时本事件不可靠，TTL 扫描兜底。
 *
 * The collector's <50ms ack contract means the curl call returns near-instantly;
 * a `--max-time 2` guards against a dead collector blocking the user's
 * claude code session.
 */
const EVENTS = ['SessionStart', 'Stop', 'PostToolUse', 'SubagentStop', 'SessionEnd'] as const
type HookEvent = (typeof EVENTS)[number]

/**
 * Resolve the user's home directory in a portable way.
 *
 * Mirrors `resolveHome()` in `src/creds.ts`: `os.homedir()` reads USERPROFILE
 * on Windows and ignores HOME, so we honor an explicit `HOME` override first
 * (tests rely on this; on Windows a user-set HOME is also what claude code
 * itself honors when present). Falls back to USERPROFILE, then the OS-reported
 * home.
 */
function resolveHome(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir()
}

/**
 * Build the shell command memside installs for one hook event.
 *
 * Shape (per task-14 plan): claude code pipes the hook JSON payload to stdin;
 * `curl -d @-` reads that stdin and forwards it verbatim as the JSON request
 * body to the collector. The trailing `-H "x-memside-tag: ${MEMSIDE_TAG}"`
 * is the grep-able idempotency marker: it is an HTTP header (invisible to
 * curl's argument parser and ignored by the collector, which reads only the
 * JSON body) so it is safe on both POSIX shells and Windows cmd.exe.
 *
 * A `#` shell comment was originally used but is invalid in cmd.exe (Task 17
 * fix): `# memside-managed` becomes stray curl arguments on Windows.
 *
 * Verification debt (see task-14-report.md): the `SessionStart` hook in
 * claude code can return `hookSpecificOutput.additionalContext` to inject
 * memory into the session. A plain `curl` POST returns empty stdout and so
 * contributes no additionalContext today. Making SessionStart actually
 * inject requires either pointing it at `/inject` and emitting the
 * additionalContext envelope, or a dedicated injector command. That live
 * contract is verified in the Task 17 manual smoke and is not locked by
 * these tests (which lock idempotent-merge + endpoint-URL behavior).
 */
function hookCommand(port: number, event: HookEvent): string {
  const url = `http://127.0.0.1:${port}/hooks/claude/${event}`
  // `--noproxy 127.0.0.1,localhost` is mandatory in proxy environments: curl
  // otherwise honors HTTP_PROXY/HTTPS_PROXY for the loopback call too, sending
  // 127.0.0.1:PORT through the system proxy (e.g. a clash/v2ray on :7897)
  // which returns 502 and silently breaks EVERY hook - capture AND the
  // SessionStart additionalContext injection. claude code's hook subprocess
  // inherits the system env including HTTP_PROXY, so it cannot rely on a
  // session-set NO_PROXY. --noproxy bypasses the proxy for loopback only; the
  // distiller's outbound Ark call still uses HTTPS_PROXY as needed.
  return `curl -s --noproxy 127.0.0.1,localhost --max-time 2 -X POST ${url} -H "content-type: application/json" -H "x-memside-tag: ${MEMSIDE_TAG}" -d @-`
}

/**
 * Merge memside's hook entries into `~/.claude/settings.json` for the four
 * claude code hook events.
 *
 * Idempotent: any prior memside-managed group (a matcher-group whose command
 * list contains the `MEMSIDE_TAG` marker) is removed before the fresh entry
 * is pushed, so re-running with a new port replaces rather than appends.
 * User-authored hooks (groups without the marker) are always preserved.
 *
 * Never throws: a malformed settings.json is treated as an empty document so
 * the install always succeeds and the user's claude code keeps booting.
 */
export function installHooks(opts: InstallOpts): void {
  const claudeDir = opts.baseDir ?? join(resolveHome(), '.claude')
  mkdirSync(claudeDir, { recursive: true })
  const settingsPath = join(claudeDir, 'settings.json')

  let settings: Record<string, unknown> = {}
  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        settings = parsed as Record<string, unknown>
      }
    } catch {
      // malformed settings.json: start fresh so install always succeeds
      settings = {}
    }
  }

  let hooks = settings.hooks as Record<string, unknown[]> | undefined
  if (!hooks || typeof hooks !== 'object') {
    hooks = {}
    settings.hooks = hooks
  }

  for (const ev of EVENTS) {
    let groups = hooks[ev]
    if (!Array.isArray(groups)) groups = []
    // drop any prior memside-managed group (idempotent replace)
    groups = groups.filter((group: unknown) => {
      if (!group || typeof group !== 'object') return true
      const g = group as { hooks?: Array<{ command?: string }> }
      const cmds = (g.hooks ?? []).map((h) => h.command ?? '').join('|')
      return !cmds.includes(MEMSIDE_TAG)
    })
    groups.push({
      matcher: '*',
      hooks: [{ type: 'command', command: hookCommand(opts.port, ev) }],
    })
    hooks[ev] = groups
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
}

export interface InstallOpencodePluginOpts {
  port: number
  /**
   * Override the opencode config dir (default `~/.config/opencode`). Tests pass
   * a tmp dir so they never touch the real user config.
   */
  baseDir?: string
  /** 磁盘源目录模式（dev/npm：从仓库 opencode-plugin/ 读盘复制）。 */
  pluginSrcDir?: string
  /** 内容模式（exe：从内嵌资产字符串写盘）。与 pluginSrcDir 互斥。 */
  files?: { 'memside.js': string; 'package.json': string }
}

/**
 * Install the opencode plugin (Task 6 artifact) into the user's opencode config
 * dir and idempotently merge its path into `opencode.json`'s `plugin` array.
 *
 * Mirrors `installHooks`'s idempotent-merge pattern, but uses a path substring
 * (`memside-opencode`) as the self-identification marker: opencode's `plugin`
 * entries are plain strings with no header slot (unlike claude code's curl
 * `-H "x-memside-tag: ..."`), so the installed directory name is the natural
 * grep-able handle. A prior memside entry is filtered out before the fresh
 * absolute path is pushed, so re-running with a new port replaces rather than
 * appends. User-authored plugin entries (e.g. `superpowers@git+...`) are
 * always preserved.
 *
 * The absolute path is written with forward slashes to avoid `~` / backslash
 * expansion differences across opencode versions (design §6, failure mode 6).
 *
 * Never throws on malformed `opencode.json` (treated as an empty document so
 * install always succeeds); `cpSync` / IO errors still surface.
 */
export function installOpencodePlugin(opts: InstallOpencodePluginOpts): void {
  const ocdDir = opts.baseDir ?? join(resolveHome(), '.config', 'opencode')
  mkdirSync(ocdDir, { recursive: true })
  const destDir = join(ocdDir, 'memside-opencode')
  if (opts.files) {
    // 内容模式（exe）：从内嵌字符串写盘，不 cpSync
    // writeFileSync 不建父目录，需先 mkdir destDir（cpSync recursive 会自建，这里手动建）
    mkdirSync(destDir, { recursive: true })
    writeFileSync(join(destDir, 'memside.js'), opts.files['memside.js'])
    writeFileSync(join(destDir, 'package.json'), opts.files['package.json'])
  } else if (opts.pluginSrcDir) {
    // 磁盘模式（dev/npm）：复制仓库 opencode-plugin/
    cpSync(opts.pluginSrcDir, destDir, { recursive: true })
  } else {
    throw new Error('installOpencodePlugin: must provide pluginSrcDir or files')
  }
  // 端口烘焙：读 memside.js 把 __MEMSIDE_PORT__ 占位替换为实际端口
  const jsPath = join(destDir, 'memside.js')
  let js = readFileSync(jsPath, 'utf-8')
  js = js.replace(/__MEMSIDE_PORT__/g, String(opts.port))
  writeFileSync(jsPath, js)
  // 幂等合并 opencode.json 的 plugin 数组
  const settingsPath = join(ocdDir, 'opencode.json')
  let cfg: Record<string, unknown> = {}
  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        cfg = parsed as Record<string, unknown>
      }
    } catch {
      // malformed opencode.json: start fresh so install always succeeds
      cfg = {}
    }
  }
  let plugin = Array.isArray(cfg.plugin) ? (cfg.plugin as string[]) : []
  // drop any prior memside-opencode entry (idempotent replace)
  plugin = plugin.filter((p) => typeof p === 'string' && !p.includes('memside-opencode'))
  // absolute path with forward slashes (avoid `~` expansion differences)
  plugin.push(destDir.replace(/\\/g, '/'))
  cfg.plugin = plugin
  writeFileSync(settingsPath, JSON.stringify(cfg, null, 2) + '\n')
}
