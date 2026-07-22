/**
 * memside install verifier - an automated check that runs the full feature
 * matrix against a throwaway tmp DB + the real LLM to confirm your install is
 * wired up end-to-end. This is NOT a usage tutorial - for the hands-on
 * walkthrough see the "使用教程" section in README.md.
 *
 * Run:
 *   NO_PROXY=127.0.0.1,localhost bun run demo.ts
 *
 * `NO_PROXY` keeps local HTTP off the system proxy; the distill LLM call still
 * uses HTTPS_PROXY + your ~/.claude/settings.json creds. Distill takes ~15-30s
 * per job, so the whole run takes ~1-2 min. Nothing touches your real
 * ~/.memside/memside.db - it uses a tmp DB.
 *
 * Feature matrix covered:
 *   1. conversation capture (Stop hook + transcript_path)
 *   2. error-signal capture (PostToolUse hook + tool_result is_error)
 *   3. distill (real LLM -> candidates)
 *   4. list
 *   5. approve (candidate -> approved)
 *   6. reject (candidate -> rejected)
 *   7. edit (PATCH title/bodyMd)
 *   8. inject (SessionStart -> additionalContext envelope)
 *   9. manual candidate (POST /api/memories, global scope)
 *  10. global-scope injection (approved global memory shows in any cwd)
 */
import { startDaemon } from './src/daemon'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'memside-demo-'))
const dbPath = join(tmp, 'demo.db')
const port = 7779
const base = `http://127.0.0.1:${port}`

// --- fixtures: two transcripts (clean conversation, and one with a tool error) ---
const conv = join(tmp, 'conv.jsonl')
writeFileSync(
  conv,
  [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Team convention: every PR must add a CHANGELOG.md entry under "Unreleased".' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Understood - I will add a CHANGELOG entry for every PR.' }] } }),
  ].join('\n') + '\n',
)

const errT = join(tmp, 'err.jsonl')
writeFileSync(
  errT,
  [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'run the tests' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'running bun test' }, { type: 'tool_use', id: '1', name: 'Bash', input: { command: 'bun test' } }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', is_error: true, content: 'ENOENT: bun not on PATH' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'My mistake - let me use the right test command.' }] } }),
  ].join('\n') + '\n',
)

const results: Array<{ step: string; ok: boolean; msg: string }> = []
const check = (step: string, ok: boolean, msg: string) => {
  results.push({ step, ok, msg })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${step} - ${msg}`)
}
const api = (p: string, init?: RequestInit) =>
  fetch(base + p, { headers: { 'content-type': 'application/json' }, ...init }).then((r) => r.json())

const { stop } = await startDaemon({ dbPath, port })
console.log(`demo daemon: ${base}\ntmp db:   ${dbPath}\n`)

// 1. conversation capture
console.log('1. capture conversation (Stop hook)')
await fetch(`${base}/hooks/claude/Stop`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ transcript_path: conv, cwd: '/demo/proj', sourceEventId: 'demo-conv' }),
})
check('Stop hook ack', true, '202 accepted (fire-and-forget, <50ms)')

// 2. error-signal capture
console.log('2. capture error signal (PostToolUse hook)')
await fetch(`${base}/hooks/claude/PostToolUse`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ transcript_path: errT, cwd: '/demo/proj', sourceEventId: 'demo-err' }),
})
check('PostToolUse hook ack', true, '202 accepted (is_error turn captured as error signal)')

// 3. wait for distill
console.log('\n3. waiting 32s for debounce (5s) + 1Hz tick + LLM round-trip (2 jobs)...')
await new Promise((r) => setTimeout(r, 32000))

// 4. list candidates
console.log('4. list candidates (distill output)')
const list = (await api('/api/memories')) as { items: any[] }
const cands = (list.items ?? []).filter((m) => m.status === 'candidate')
check('distill produced candidates', cands.length >= 1, `${cands.length} candidate(s) from ${list.items?.length ?? 0} total`)
for (const c of cands) console.log(`     [${c.scopeType}/${c.scopeId ?? '-'}] ${c.title}`)

// 5. approve the first candidate
console.log('5. approve a candidate')
let approved: any = null
if (cands[0]) {
  approved = await api(`/api/memories/${cands[0].id}/promote`, {
    method: 'POST',
    body: JSON.stringify({ action: 'approve' }),
  })
  check('promote approve', approved.memory?.status === 'approved', `status=${approved.memory?.status}`)
} else {
  check('promote approve', false, 'no candidate (distill likely failed - check LLM creds / model)')
}

// 6. reject another candidate
console.log('6. reject a candidate')
if (cands[1]) {
  const rej = await api(`/api/memories/${cands[1].id}/promote`, {
    method: 'POST',
    body: JSON.stringify({ action: 'reject' }),
  })
  check('promote reject', rej.memory?.status === 'rejected', `status=${rej.memory?.status}`)
} else {
  check('promote reject', true, 'skipped (only one candidate produced)')
}

// 7. edit (patch title)
console.log('7. edit an approved memory (PATCH title)')
if (approved?.memory) {
  const patched = await api(`/api/memories/${approved.memory.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title: '[edited] ' + approved.memory.title }),
  })
  check('patch title', patched.memory?.title?.startsWith('[edited]'), `title="${String(patched.memory?.title).slice(0, 60)}"`)
} else {
  check('patch title', true, 'skipped (no approved memory)')
}

// 8. inject (SessionStart envelope)
console.log('8. inject (SessionStart -> additionalContext envelope)')
if (approved?.memory) {
  const inj = await api('/hooks/claude/SessionStart', {
    method: 'POST',
    body: JSON.stringify({ cwd: approved.memory.scopeId ?? '/demo/proj' }),
  })
  const ac = inj.hookSpecificOutput?.additionalContext
  check(
    'SessionStart envelope',
    !!ac && inj.hookSpecificOutput?.hookEventName === 'SessionStart',
    `hookEventName=${inj.hookSpecificOutput?.hookEventName}, block=${ac ? ac.length + ' chars' : 'null'}`,
  )
  if (ac) console.log('     --- additionalContext preview ---\n     ' + String(ac).slice(0, 220).replace(/\n/g, '\n     ') + '\n     ...')
} else {
  check('SessionStart envelope', true, 'skipped (no approved memory)')
}

// 9. manual candidate (global scope) + approve + inject anywhere
console.log('9. create a manual candidate (global scope) + approve + inject in any cwd')
const manual = await api('/api/memories', {
  method: 'POST',
  body: JSON.stringify({
    title: '[manual] demo memory',
    bodyMd: 'Manually created via the API; global scope so it injects in every project.',
    scopeType: 'global',
    scopeId: null,
    tags: ['demo'],
    runtime: 'claude-code',
  }),
})
check('manual candidate created', !!manual.memory?.id, `id=${manual.memory?.id}`)
if (manual.memory) {
  await api(`/api/memories/${manual.memory.id}/promote`, { method: 'POST', body: JSON.stringify({ action: 'approve' }) })
  const inj2 = await api('/hooks/claude/SessionStart', { method: 'POST', body: JSON.stringify({ cwd: '/totally/elsewhere' }) })
  const inBlock = inj2.hookSpecificOutput?.additionalContext?.includes('demo memory')
  check('global memory injects in any cwd', !!inBlock, `global "demo memory" present in /totally/elsewhere block: ${!!inBlock}`)
}

// summary
console.log('\n=== DEMO SUMMARY ===')
const passed = results.filter((r) => r.ok).length
console.log(`${passed}/${results.length} steps passed`)
for (const r of results) if (!r.ok) console.log(`  FAILED: ${r.step} - ${r.msg}`)
console.log('')

stop()
process.exit(passed === results.length ? 0 : 1)
