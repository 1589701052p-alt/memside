import { test, expect, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { installHooks, MEMSIDE_TAG } from '@/install'

// Test isolation: point HOME at a scratch dir so we never touch the real
// ~/.claude/settings.json. install.ts honors HOME first (see resolveHome in
// creds.ts for the same Windows-portable pattern), so this override works
// cross-OS.
const fakeHome = join(import.meta.dir, '.tmp-install')
const realHome = homedir()
const realUserprofile = process.env.USERPROFILE

beforeEach(() => {
  rmSync(fakeHome, { recursive: true, force: true })
  mkdirSync(join(fakeHome, '.claude'), { recursive: true })
  ;(process.env as any).HOME = fakeHome
  // On Windows os.homedir() reads USERPROFILE; clear it so HOME is the
  // single source of truth for the test (matches how resolveHome falls back).
  delete process.env.USERPROFILE
})

afterEach(() => {
  ;(process.env as any).HOME = realHome
  if (realUserprofile !== undefined) {
    ;(process.env as any).USERPROFILE = realUserprofile
  } else {
    delete process.env.USERPROFILE
  }
})

test('installHooks writes memside hooks into settings.json', () => {
  installHooks({ port: 7777 })
  const raw = JSON.parse(readFileSync(join(fakeHome, '.claude', 'settings.json'), 'utf-8'))
  expect(raw.hooks.SessionStart).toBeTruthy()
  expect(raw.hooks.Stop).toBeTruthy()
  expect(raw.hooks.PostToolUse).toBeTruthy()
  expect(raw.hooks.SubagentStop).toBeTruthy()
  expect(JSON.stringify(raw.hooks)).toContain('7777')
  expect(JSON.stringify(raw.hooks)).toContain('/hooks/claude/Stop')
  expect(JSON.stringify(raw.hooks)).toContain('/hooks/claude/SessionStart')
  expect(JSON.stringify(raw.hooks)).toContain('/hooks/claude/PostToolUse')
  expect(JSON.stringify(raw.hooks)).toContain('/hooks/claude/SubagentStop')
  // every memside command carries the grep-able marker
  expect(JSON.stringify(raw.hooks)).toContain(MEMSIDE_TAG)
})

test('installHooks is idempotent and preserves existing user hooks', () => {
  mkdirSync(join(fakeHome, '.claude'), { recursive: true })
  // pretend a user hook already exists
  writeFileSync(
    join(fakeHome, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo user-hook' }] }] } }),
  )
  installHooks({ port: 7777 })
  const raw = JSON.parse(readFileSync(join(fakeHome, '.claude', 'settings.json'), 'utf-8'))
  const stopCmds = JSON.stringify(raw.hooks.Stop)
  expect(stopCmds).toContain('echo user-hook')
  expect(stopCmds).toContain('/hooks/claude/Stop')
  // user hook is untouched (no memside marker on it)
  expect(raw.hooks.Stop.length).toBeGreaterThanOrEqual(2)
})

test('re-running installHooks does not duplicate memside entries', () => {
  installHooks({ port: 7777 })
  installHooks({ port: 8888 }) // re-run with a different port -> replaces, not appends
  const raw = JSON.parse(readFileSync(join(fakeHome, '.claude', 'settings.json'), 'utf-8'))
  for (const ev of ['SessionStart', 'Stop', 'PostToolUse', 'SubagentStop'] as const) {
    const groups = raw.hooks[ev]
    // exactly one memside-managed group per event
    const memsideGroups = groups.filter((g: any) =>
      (g?.hooks ?? []).some((h: any) => typeof h.command === 'string' && h.command.includes(MEMSIDE_TAG)),
    )
    expect(memsideGroups.length).toBe(1)
  }
  // port was updated to the new value
  expect(JSON.stringify(raw.hooks)).toContain('8888')
  expect(JSON.stringify(raw.hooks)).not.toContain('7777')
})

test('installHooks creates ~/.claude dir when missing', () => {
  // wipe the .claude dir created in beforeEach so install has to make it
  rmSync(join(fakeHome, '.claude'), { recursive: true, force: true })
  expect(existsSync(join(fakeHome, '.claude'))).toBe(false)
  installHooks({ port: 9999 })
  expect(existsSync(join(fakeHome, '.claude', 'settings.json'))).toBe(true)
})

// Regression test for the Task 17 cmd.exe-safe marker fix: the idempotency
// marker must NOT be a `#` shell comment (invalid in cmd.exe on Windows - `#`
// and `memside-managed` become stray curl args). Instead it must be an HTTP
// header (`-H "x-memside-tag: memside-managed"`) which curl parses safely
// on all shells and the collector ignores (it reads only the JSON body).
test('hook command uses a curl header marker, not a shell comment (cmd.exe-safe)', () => {
  installHooks({ port: 7777 })
  const raw = JSON.parse(readFileSync(join(fakeHome, '.claude', 'settings.json'), 'utf-8'))
  const cmds = (['SessionStart', 'Stop', 'PostToolUse', 'SubagentStop'] as const).flatMap((ev) =>
    raw.hooks[ev].flatMap((g: any) => (g.hooks ?? []).map((h: any) => h.command as string)),
  )
  for (const cmd of cmds) {
    // the header form is present
    expect(cmd).toContain(`x-memside-tag: ${MEMSIDE_TAG}`)
    // the `#` shell-comment form is absent (would break cmd.exe)
    expect(cmd).not.toContain(`# ${MEMSIDE_TAG}`)
    // --max-time 2 guard is preserved (collector must not block the hook)
    expect(cmd).toContain('--max-time 2')
  }
})
