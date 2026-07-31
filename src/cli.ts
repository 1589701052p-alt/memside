#!/usr/bin/env bun
/**
 * memside CLI entrypoint.
 *
 * Three commands:
 * - `start`            - launch the daemon (HTTP server + 1Hz distill loop) on
 *                        MEMSIDE_PORT (default 7777). Does NOT install claude
 *                        code hooks or the opencode plugin; use `install` for
 *                        that.
 * - `install`          - write the four collector hook commands into
 *                        `~/.claude/settings.json` (idempotent) AND copy the
 *                        opencode plugin into `~/.config/opencode/memside-opencode/`
 *                        + idempotently merge `opencode.json`'s `plugin` array.
 *                        Does NOT start the daemon.
 * - `start-and-install` - both: start the daemon AND install the claude hooks
 *                        + opencode plugin.
 *
 * Unknown command prints a usage line and exits 1.
 */
import { startDaemon } from './daemon'
import { installHooks, installOpencodePlugin } from './install'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const cmd = process.argv[2]
const PORT = Number(process.env.MEMSIDE_PORT ?? 7777)
// Repo `opencode-plugin/` source dir (Task 6 artifact), resolved relative to
// this cli.ts so it works whether run via `bun run src/cli.ts` or a bundled bin.
const pluginSrcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'opencode-plugin')

if (cmd === 'start') {
  await startDaemon({ port: PORT, installClaudeHooks: false })
  console.log(`memside daemon on http://127.0.0.1:${PORT}`)
} else if (cmd === 'install') {
  installHooks({ port: PORT })
  installOpencodePlugin({ port: PORT, pluginSrcDir })
  console.log('hooks installed into ~/.claude/settings.json; opencode plugin installed into ~/.config/opencode/')
} else if (cmd === 'start-and-install') {
  await startDaemon({ port: PORT, installClaudeHooks: true })
  installOpencodePlugin({ port: PORT, pluginSrcDir })
  console.log(`memside daemon on http://127.0.0.1:${PORT} (hooks installed; opencode plugin installed)`)
} else {
  console.log('usage: memside <start|install|start-and-install>')
  process.exit(1)
}
