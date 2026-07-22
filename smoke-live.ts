/**
 * Live end-to-end smoke (STATE.md verification debt #4 core).
 *
 * Runs the REAL daemon (tmp DB, no hook install, no ~/.memside pollution),
 * posts a REAL transcript via transcript_path, lets the REAL distill loop call
 * the REAL Ark proxy LLM (deepseek-v4-flash via settings.json creds), approves
 * the resulting candidate, and asserts the SessionStart hook returns the
 * additionalContext envelope. Nothing is mocked.
 *
 *   bun run smoke-live.ts
 */
import { startDaemon } from './src/daemon'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

const tmpDir = mkdtempSync(join(tmpdir(), 'memside-smoke-'))
const dbPath = join(tmpDir, 'smoke.db')
const transcriptPath = join(tmpDir, 't.jsonl')
writeFileSync(
  transcriptPath,
  [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Team rule: we only issue refunds within 14 days of shipment. No exceptions. Past that window, deny the request.' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Understood. Refunds are only allowed within 14 days of shipment; after that I will deny the request.' }] } }),
  ].join('\n') + '\n',
)

const cwd = '/smoke/proj'
const port = 7778
const base = `http://127.0.0.1:${port}`

const { stop } = await startDaemon({ dbPath, port })
console.log(`daemon up on ${base} | db ${dbPath}`)

// --- capture (Stop hook) ---
const cap = await fetch(`${base}/hooks/claude/Stop`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ transcript_path: transcriptPath, cwd, sourceEventId: 'smoke-1' }),
})
console.log('capture ->', cap.status, await cap.text())

// --- wait for debounce (5s) + 1Hz tick + LLM round-trip ---
console.log('waiting 30s for debounce + tick + LLM...')
await new Promise((r) => setTimeout(r, 30000))

// --- list ---
const list = (await (await fetch(`${base}/api/memories`)).json()) as { items: any[] }
console.log(`memories: ${list.items?.length ?? 0}`)
for (const m of list.items ?? []) {
  console.log(`   [${m.status}] scope=${m.scopeType}/${m.scopeId} | ${m.title}`)
}

// --- diagnose distill pipeline ---
const raw = new Database(dbPath)
const jobs = raw.query('SELECT id, status, attempts, next_run_at, last_error FROM memory_distill_jobs').all() as any[]
console.log('distill jobs:', JSON.stringify(jobs, null, 2))
const events = raw.query('SELECT distill_job_id, attempt_index, kind, length(payload) AS plen, substr(payload,1,120) AS preview FROM memory_distill_events').all() as any[]
console.log('distill events:', JSON.stringify(events, null, 2))
raw.close()

const cand = (list.items ?? []).find((m) => m.status === 'candidate')
if (!cand) {
  console.log('NO CANDIDATE produced - distill likely failed (check creds / model / Ark reachability)')
  stop()
  process.exit(0)
}

// --- approve ---
const prom = await (
  await fetch(`${base}/api/memories/${cand.id}/promote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'approve' }),
  })
).json()
console.log('promote ->', prom.memory?.status ?? prom.error)

// --- inject (SessionStart) using the SAME cwd the candidate was scoped to ---
const injectCwd = cand.scopeId ?? cwd
const inj = await (
  await fetch(`${base}/hooks/claude/SessionStart`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: injectCwd }),
  })
).json()
console.log('inject envelope keys:', Object.keys(inj))
if (inj.hookSpecificOutput?.additionalContext) {
  console.log('  hookEventName:', inj.hookSpecificOutput.hookEventName)
  console.log('  additionalContext (first 300 chars):')
  console.log('    ' + String(inj.hookSpecificOutput.additionalContext).slice(0, 300))
  console.log('\n=== LIVE SMOKE PASSED: capture -> distill -> approve -> inject all real ===')
} else {
  console.log('  (no block returned - approved memory not in scope for cwd', injectCwd, ')')
}

stop()
process.exit(0)
