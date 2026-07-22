import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
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
 * The four claude code hook events memside subscribes to. Each event is a
 * POST to the collector (`POST /hooks/claude/<event>`, see `src/server.ts`).
 *
 * - SessionStart / Stop / SubagentStop -> `sourceKind: 'conversation'`
 * - PostToolUse -> `sourceKind: 'error'` (error-signal transcript path)
 *
 * The collector's <50ms ack contract means the curl call returns near-instantly;
 * a `--max-time 2` guards against a dead collector blocking the user's
 * claude code session.
 */
const EVENTS = ['SessionStart', 'Stop', 'PostToolUse', 'SubagentStop'] as const
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
