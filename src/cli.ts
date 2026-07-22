#!/usr/bin/env bun
/**
 * memside CLI entrypoint.
 *
 * Three commands:
 * - `start`            - launch the daemon (HTTP server + 1Hz distill loop) on
 *                        MEMSIDE_PORT (default 7777). Does NOT install claude
 *                        code hooks; use `install` for that.
 * - `install`          - write the four collector hook commands into
 *                        `~/.claude/settings.json` (idempotent). Does NOT start
 *                        the daemon.
 * - `start-and-install` - both: start the daemon AND install the hooks.
 *
 * Unknown command prints a usage line and exits 1.
 */
import { startDaemon } from './daemon'
import { installHooks } from './install'

const cmd = process.argv[2]
const PORT = Number(process.env.MEMSIDE_PORT ?? 7777)

if (cmd === 'start') {
  await startDaemon({ port: PORT, installClaudeHooks: false })
  console.log(`memside daemon on http://127.0.0.1:${PORT}`)
} else if (cmd === 'install') {
  installHooks({ port: PORT })
  console.log('hooks installed into ~/.claude/settings.json')
} else if (cmd === 'start-and-install') {
  await startDaemon({ port: PORT, installClaudeHooks: true })
  console.log(`memside daemon on http://127.0.0.1:${PORT} (hooks installed)`)
} else {
  console.log('usage: memside <start|install|start-and-install>')
  process.exit(1)
}
