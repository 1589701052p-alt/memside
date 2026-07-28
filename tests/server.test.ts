import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { createCandidate, promoteCandidate, getSourceInput } from '@/memory/store'
import { ClaudeCodeAdapter } from '@/adapter/claudeCode'
import { createApp } from '@/server'
import { memoryDistillJobs, memoryDistillEvents, memories } from '@/db/schema'

// EBUSY-safe pattern (same as store-promote.test.ts / adapter-claude.test.ts):
// wipe `root` once in beforeAll, give each test its own fresh subdir, and
// close the raw bun:sqlite handle in afterEach. The brief's bare `rmSync(tmp)`
// in beforeEach throws EBUSY on Windows because the previous test's Database
// (plus -wal/-shm sidecars) is still locked. Fresh subdirs mean we never
// delete a dir holding an open handle.
const root = join(import.meta.dir, '.tmp-server')
let dir = ''
let db: ReturnType<typeof openDb>
let app: ReturnType<typeof createApp>
let adapter: ClaudeCodeAdapter
let enqueueCalls: { sourceEventId: string; runtime: string; cwd: string; debounceKey: string; sessionId?: string }[]
let broadcastCalls: unknown[]

beforeAll(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
})

beforeEach(() => {
  dir = join(root, Math.random().toString(36).slice(2))
  mkdirSync(dir, { recursive: true })
  db = openDb(join(dir, 't.db'))
  adapter = new ClaudeCodeAdapter(db)
  enqueueCalls = []
  broadcastCalls = []
  app = createApp({
    db,
    adapter,
    enqueueDistillJob: async (_d, input) => {
      enqueueCalls.push(input)
      return { jobId: 'j', nextRunAt: 0 }
    },
    broadcast: (msg: unknown) => { broadcastCalls.push(msg) },
  })
})

afterEach(() => {
  db.$client.close()
})

async function req(path: string, init?: RequestInit) {
  const res = await app.fetch(new Request(`http://x${path}`, init))
  return { status: res.status, body: await res.json().catch(() => null) }
}

/** Write `lines` (one JSON object per arg) as a JSONL fixture in the per-test
 * tmp dir and return its absolute path. Real file writes (no fs mocking) so
 * the REAL parseTranscriptFile path is exercised end-to-end. */
function writeJsonlFixture(name: string, ...lines: unknown[]): string {
  const p = join(dir, name)
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return p
}

test('collector hook accepts event and acks 202', async () => {
  // C3 fix: the collector now reads `transcript_path` (a JSONL file path)
  // instead of an inline `body.transcript` array. Write a real fixture with a
  // known user turn and assert the stored memory_distill_events payload
  // contains that turn (proving parseTranscriptFile -> DB wired up).
  const fixturePath = writeJsonlFixture('stop.jsonl', {
    type: 'user',
    message: { role: 'user', content: 'hi from the transcript file' },
  })
  const r = await req('/hooks/claude/Stop', {
    method: 'POST',
    body: JSON.stringify({ sourceEventId: 'e1', cwd: '/r', transcript_path: fixturePath }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(202)
  // The fire-and-forget enqueue mock records calls synchronously at call-time
  // (before the async return), so this is deterministic even though the handler
  // does `void` (not `await`) on enqueue - the <50ms ack contract.
  expect(enqueueCalls.length).toBe(1)
  expect(enqueueCalls[0]).toMatchObject({
    sourceEventId: 'e1',
    runtime: 'claude-code',
    cwd: '/r',
    debounceKey: '/r:Stop',
  })
  // C1 fix: the collector's fire-and-forget IIFE persists turns to
  // memory_distill_events (not the vestigial adapter.pushCapture queue).
  // Wait briefly for the IIFE to complete the DB write.
  await new Promise((res) => setTimeout(res, 50))
  const events = await db.select().from(memoryDistillEvents)
  expect(events.length).toBe(1)
  expect(events[0]!.kind).toBe('conversation')
  // C3 lock: the stored payload is JSON.stringify(parseTranscriptFile(path)),
  // so the real user turn from the fixture must appear in the payload.
  expect(events[0]!.payload).toContain('hi from the transcript file')
  // collector broadcasts a capture event for WS subscribers
  expect(broadcastCalls.length).toBeGreaterThanOrEqual(1)
})

test('collector acks 202 even when enqueue rejects, and broadcasts memory.enqueue.failed', async () => {
  const bc: unknown[] = []
  app = createApp({
    db,
    adapter,
    enqueueDistillJob: async () => { throw new Error('SQLITE_BUSY') },
    broadcast: (m: unknown) => { bc.push(m) },
  })
  // No transcript_path: turns=[] (the distiller can decide on an empty
  // transcript); this test is about the enqueue-rejection ack + broadcast.
  const r = await req('/hooks/claude/Stop', {
    method: 'POST',
    body: JSON.stringify({ sourceEventId: 'e-reject', cwd: '/r' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(202)
  // the .catch handler runs async after the 202 response; wait briefly for it
  await new Promise((res) => setTimeout(res, 50))
  expect(bc.some((m: any) => m.type === 'memory.enqueue.failed' && m.sourceEventId === 'e-reject')).toBe(true)
})

test('collector PostToolUse is skipped (no distill, no event, no job, no broadcast)', async () => {
  // 绗洓杞細PostToolUse transcript 鏄疮绉紡鍏ㄩ噺锛屼笌 Stop transcript 鍓嶇紑閲嶅彔锛?
  // 姣忔 tool call 涓€涓?job 瀵艰嚧鍚屼竴娈典細璇濊閲嶅钂搁锛堝悓涔夊€欓€夌垎鐐革級銆?
  // PostToolUse 涓嶅啀钂搁--Stop transcript 宸插惈鍏ㄩ儴 tool_result锛堝惈 error锛夛紝
  // 閿欒淇″彿鐢?distiller 鍐?detectErrorSignals 浠?Stop transcript 鎻愬彇銆?
  // 鍗充娇甯?transcript_path + is_error turn锛屼篃鐩存帴 202 璺宠繃锛屼笉浜х敓浠讳綍鍓綔鐢ㄣ€?
  const fixturePath = writeJsonlFixture('posttool.jsonl', {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'err', is_error: true }],
    },
  })
  const beforeEvents = await db.select().from(memoryDistillEvents)
  const r = await req('/hooks/claude/PostToolUse', {
    method: 'POST',
    body: JSON.stringify({ sourceEventId: 'e2', cwd: '/r', transcript_path: fixturePath }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(202)
  // 绛夊緟 fire-and-forget 璺緞锛堣嫢璇蛋锛夊啓鍑?event
  await new Promise((res) => setTimeout(res, 50))
  const events = await db.select().from(memoryDistillEvents)
  expect(events.length).toBe(beforeEvents.length)  // 涓嶅瓨 event
  expect(enqueueCalls.length).toBe(0)               // 涓?enqueue job
  expect(broadcastCalls.length).toBe(0)             // 涓?broadcast锛堣繛 memory.capture 閮戒笉鍙戯級
})

test('collector SubagentStop is skipped (no distill, no event, no job, no broadcast)', async () => {
  // 绗簲杞細SubagentStop 鐨?transcript_path 鎸囧悜涓讳細璇?JSONL锛堜笉鏄嫭绔嬪瓙浼氳瘽锛夛紝
  // 涓庡悓 session 鐨?Stop 钂搁鍚屼竴娈典細璇濓紙firstUser 涓€鑷淬€乼urns 鏁板嚑涔庣浉鍚岋級锛岀函閲嶅銆?
  // SubagentStop 鏃犵嫭鏈変环鍊硷紝鏃╄繑鍥?202 涓嶈捀棣忋€備笌 PostToolUse 璺宠繃瀵圭О銆?
  const fixturePath = writeJsonlFixture('subagent.jsonl', {
    type: 'user',
    message: { role: 'user', content: 'subagent transcript is main session' },
  })
  const beforeEvents = await db.select().from(memoryDistillEvents)
  const r = await req('/hooks/claude/SubagentStop', {
    method: 'POST',
    body: JSON.stringify({ sourceEventId: 'e3', cwd: '/r', transcript_path: fixturePath, session_id: 'sess-1' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(202)
  await new Promise((res) => setTimeout(res, 50))
  const events = await db.select().from(memoryDistillEvents)
  expect(events.length).toBe(beforeEvents.length)  // 涓嶅瓨 event
  expect(enqueueCalls.length).toBe(0)               // 涓?enqueue job
  expect(broadcastCalls.length).toBe(0)             // 涓?broadcast
})

test('collector Stop reads session_id and passes it to enqueueDistillJob', async () => {
  // 绗簲杞細hook payload 鐨?session_id 鏄閲忚捀棣忕殑浼氳瘽閿€俿erver.ts 蹇呴』璇诲彇骞?
  // 浼犲叆 enqueueDistillJob锛屽惁鍒?tick 鏃犳硶鎸?session 鍒囩墖鍋忕Щ銆?
  const fixturePath = writeJsonlFixture('stop-sid.jsonl', {
    type: 'user',
    message: { role: 'user', content: 'stop with session id' },
  })
  const r = await req('/hooks/claude/Stop', {
    method: 'POST',
    body: JSON.stringify({ sourceEventId: 'e4', cwd: '/r', transcript_path: fixturePath, session_id: 'sess-abc' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(202)
  expect(enqueueCalls.length).toBe(1)
  expect(enqueueCalls[0]!.sessionId).toBe('sess-abc')
})

test('collector Stop without session_id still enqueues (backward compat)', async () => {
  // 绗簲杞細鍘嗗彶/鏃?session_id 鐨?Stop 浠嶆甯?enqueue锛坰essionId 涓虹┖锛夛紝
  // tick 璧板叏閲忚捀棣忚矾寰勩€傚悜鍚庡吋瀹广€?
  const fixturePath = writeJsonlFixture('stop-nosid.jsonl', {
    type: 'user',
    message: { role: 'user', content: 'stop no session id' },
  })
  const r = await req('/hooks/claude/Stop', {
    method: 'POST',
    body: JSON.stringify({ sourceEventId: 'e5', cwd: '/r', transcript_path: fixturePath }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(202)
  expect(enqueueCalls.length).toBe(1)
  expect(enqueueCalls[0]!.sessionId).toBe('')  // 绌?session_id -> 绌轰覆
})

test('collector SessionStart returns hookSpecificOutput envelope when memories exist (C2)', async () => {
  // C2 fix: SessionStart must return the additionalContext envelope claude code
  // reads from the hook's stdout (NOT a plain {ok:true}). Approve a memory for
  // cwd '/r' so adapter.inject returns a block, then POST the SessionStart hook.
  const c = await createCandidate(db, { scopeType: 'project', scopeId: '/r', title: 'Refund window', bodyMd: '14 days', tags: [], sourceKind: 'manual', runtime: null })
  await promoteCandidate(db, c.id, { action: 'approve' })
  const r = await req('/hooks/claude/SessionStart', {
    method: 'POST',
    body: JSON.stringify({ cwd: '/r' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(200)
  // The envelope shape claude code requires (bundle error otherwise).
  expect(r.body.hookSpecificOutput).toBeDefined()
  expect(r.body.hookSpecificOutput.hookEventName).toBe('SessionStart')
  expect(typeof r.body.hookSpecificOutput.additionalContext).toBe('string')
  // The approved memory is inside the injected block.
  expect(r.body.hookSpecificOutput.additionalContext).toContain('--- BEGIN INJECTED MEMORY ---')
  expect(r.body.hookSpecificOutput.additionalContext).toContain('Refund window')
  // SessionStart does NOT capture/enqueue: no distill job, no events row.
  expect(enqueueCalls.length).toBe(0)
  await new Promise((res) => setTimeout(res, 30))
  const events = await db.select().from(memoryDistillEvents)
  expect(events.length).toBe(0)
})

test('collector SessionStart returns {ok:true} when no memories to inject (C2)', async () => {
  // No approved memories for this cwd -> adapter.inject returns null -> the
  // hook must NOT emit an empty additionalContext block (that would inject
  // noise). Plain {ok:true} means claude code injects nothing.
  const r = await req('/hooks/claude/SessionStart', {
    method: 'POST',
    body: JSON.stringify({ cwd: '/no-memories-here' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(200)
  expect(r.body).toEqual({ ok: true })
  expect(r.body.hookSpecificOutput).toBeUndefined()
})

test('inject returns null block when no memories', async () => {
  const r = await req('/inject', {
    method: 'POST',
    body: JSON.stringify({ cwd: '/r' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(200)
  expect(r.body).toEqual({ block: null })
})

test('inject returns block after approve', async () => {
  const c = await createCandidate(db, { scopeType: 'project', scopeId: '/r', title: 'T', bodyMd: 'B', tags: [], sourceKind: 'manual', runtime: null })
  await promoteCandidate(db, c.id, { action: 'approve' })
  const r = await req('/inject', { method: 'POST', body: JSON.stringify({ cwd: '/r' }), headers: { 'content-type': 'application/json' } })
  expect(r.body.block).toContain('--- BEGIN INJECTED MEMORY ---')
})

test('GET /api/memories lists candidates', async () => {
  await createCandidate(db, { scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  const r = await req('/api/memories')
  expect(r.status).toBe(200)
  expect(r.body.items.length).toBe(1)
})

test('POST /api/memories/:id/promote approves', async () => {
  const c = await createCandidate(db, { scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  const r = await req(`/api/memories/${c.id}/promote`, { method: 'POST', body: JSON.stringify({ action: 'approve' }), headers: { 'content-type': 'application/json' } })
  expect(r.status).toBe(200)
  expect(r.body.memory.status).toBe('approved')
})

test('GET /api/memories/:id returns memory or 404', async () => {
  const c = await createCandidate(db, { scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  const ok = await req(`/api/memories/${c.id}`)
  expect(ok.status).toBe(200)
  expect(ok.body.memory.id).toBe(c.id)
  const miss = await req('/api/memories/nope')
  expect(miss.status).toBe(404)
})

test('POST /api/memories creates manual candidate (201)', async () => {
  const r = await req('/api/memories', {
    method: 'POST',
    body: JSON.stringify({ scopeType: 'global', scopeId: null, title: 'manual', bodyMd: 'body', tags: ['x'] }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(201)
  expect(r.body.memory.status).toBe('candidate')
  expect(r.body.memory.sourceKind).toBe('manual')
})

test('PATCH /api/memories/:id updates title and broadcasts', async () => {
  const c = await createCandidate(db, { scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  const r = await req(`/api/memories/${c.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title: 't2' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(200)
  expect(r.body.memory.title).toBe('t2')
  expect(r.body.changedFields).toContain('title')
  expect(broadcastCalls.some((m) => (m as any).type === 'memory.updated')).toBe(true)
})

test('GET /api/status reports events, job stats, memory counts, and lastError', async () => {
  // Background visibility for the web UI: the status bar needs the capture-event
  // count, distill-job state counts, memory counts by status, and the most
  // recent distill error so the user can see the daemon working instead of an
  // empty queue.
  const c1 = await createCandidate(db, { scopeType: 'project', scopeId: '/p', title: '[category:x] a', bodyMd: 'a', tags: [], sourceKind: 'manual', runtime: null })
  await promoteCandidate(db, c1.id, { action: 'approve' })
  await createCandidate(db, { scopeType: 'project', scopeId: '/p', title: '[category:x] b', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  const now = Date.now()
  db.insert(memoryDistillJobs).values({ id: 'j1', debounceKey: 'k1', sourceEventId: 's1', runtime: 'claude-code', cwd: '/p', status: 'done', attempts: 0, nextRunAt: now, createdAt: now }).run()
  db.insert(memoryDistillJobs).values({ id: 'j2', debounceKey: 'k2', sourceEventId: 's2', runtime: 'claude-code', cwd: '/p', status: 'failed', attempts: 3, nextRunAt: now, createdAt: now, lastError: 'boom' }).run()
  db.insert(memoryDistillEvents).values({ distillJobId: 'j1', attemptIndex: 0, ts: now, kind: 'conversation', payload: '[]' }).run()

  const r = await req('/api/status')
  expect(r.status).toBe(200)
  expect(r.body.events).toBe(1)
  expect(r.body.jobs.done).toBe(1)
  expect(r.body.jobs.failed).toBe(1)
  expect(r.body.memories.candidate).toBe(1)
  expect(r.body.memories.approved).toBe(1)
  expect(r.body.lastError).toEqual({ error: 'boom' })
})

test('PATCH /api/memories/:id edits scope project->global', async () => {
  const c = await createCandidate(db, {
    scopeType: 'project', scopeId: '/r', title: 't', bodyMd: 'b',
    tags: [], sourceKind: 'conversation', runtime: null, sourceCwd: '/r',
  })
  const r = await req(`/api/memories/${c.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ scopeType: 'global' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(200)
  expect(r.body.memory.scopeType).toBe('global')
  expect(r.body.memory.scopeId).toBeNull()
  expect(r.body.changedFields).toContain('scopeType')
  expect(broadcastCalls.some((m) => (m as any).type === 'memory.updated')).toBe(true)
})

test('PATCH /api/memories/:id global->project without sourceCwd returns 409', async () => {
  const c = await createCandidate(db, {
    scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b',
    tags: [], sourceKind: 'manual', runtime: null,
  })
  const r = await req(`/api/memories/${c.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ scopeType: 'project' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(409)
  expect(r.body.error).toBeTruthy()
})

test('POST /api/memories/bulk-promote rejects multiple and broadcasts per id', async () => {
  const c1 = await createCandidate(db, { scopeType: 'global', scopeId: null, title: 't1', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  const c2 = await createCandidate(db, { scopeType: 'global', scopeId: null, title: 't2', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  const r = await req('/api/memories/bulk-promote', {
    method: 'POST',
    body: JSON.stringify({ ids: [c1.id, c2.id], action: 'reject' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(200)
  expect(r.body.rejected).toBe(2)
  expect(broadcastCalls.filter((m) => (m as any).type === 'memory.promoted').length).toBe(2)
  const after = await db.select().from(memories)
  expect(after.every((m) => m.status === 'rejected')).toBe(true)
})

test('POST /api/memories/bulk-promote skips not-found id and continues the batch', async () => {
  // Skip-path lock: a nonexistent id (promoteCandidate throws MemoryNotFoundError)
  // must be swallowed by the per-id try/catch, increment neither the rejected
  // count nor emit a memory.promoted broadcast, and the rest of the batch must
  // still process. Without this the boundary behavior is untested even though
  // it's the route's core error-handling contract.
  const c1 = await createCandidate(db, { scopeType: 'global', scopeId: null, title: 't1', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  const c2 = await createCandidate(db, { scopeType: 'global', scopeId: null, title: 't2', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  const r = await req('/api/memories/bulk-promote', {
    method: 'POST',
    body: JSON.stringify({ ids: [c1.id, 'nonexistent-id', c2.id], action: 'reject' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(200)
  expect(r.body.rejected).toBe(2)
  expect(broadcastCalls.filter((m) => (m as any).type === 'memory.promoted').length).toBe(2)
  const after = await db.select().from(memories)
  expect(after.length).toBe(2)
  expect(after.every((m) => m.status === 'rejected')).toBe(true)
})

test('GET /api/memories/:id/source-input returns available:true with turns when snapshot exists', async () => {
  const c = await createCandidate(db, { scopeType: 'project', scopeId: '/r', title: '[category:x] t', bodyMd: 'b', tags: [], sourceKind: 'conversation', runtime: null, sourceCwd: '/r', distillJobId: 'job-snap' })
  await getSourceInput(db, 'job-snap', [{ role: 'user', content: 'the original input' }])
  const r = await req(`/api/memories/${c.id}/source-input`)
  expect(r.status).toBe(200)
  expect(r.body.available).toBe(true)
  expect(r.body.title).toContain('[category:x]')
  expect(r.body.turnCount).toBe(1)
  expect(r.body.turns[0]!.content).toBe('the original input')
})

test('GET /api/memories/:id/source-input returns available:false when memory has no distillJobId (manual)', async () => {
  const c = await createCandidate(db, { scopeType: 'global', scopeId: null, title: 'manual', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  const r = await req(`/api/memories/${c.id}/source-input`)
  expect(r.status).toBe(200)
  expect(r.body.available).toBe(false)
})

test('GET /api/memories/:id/source-input returns available:false when snapshot row missing', async () => {
  const c = await createCandidate(db, { scopeType: 'project', scopeId: '/r', title: 't', bodyMd: 'b', tags: [], sourceKind: 'conversation', runtime: null, sourceCwd: '/r', distillJobId: 'job-nosnap' })
  // 涓嶅啓蹇収琛?
  const r = await req(`/api/memories/${c.id}/source-input`)
  expect(r.status).toBe(200)
  expect(r.body.available).toBe(false)
})

test('GET /api/memories/:id/source-input returns 404 when memory missing', async () => {
  const r = await req('/api/memories/nope/source-input')
  expect(r.status).toBe(404)
})

test('GET /api/memories list response does NOT contain turns (lazy load only)', async () => {
  const c = await createCandidate(db, { scopeType: 'project', scopeId: '/r', title: 't', bodyMd: 'b', tags: [], sourceKind: 'conversation', runtime: null, sourceCwd: '/r', distillJobId: 'job-list' })
  await getSourceInput(db, 'job-list', [{ role: 'user', content: 'SHOULD_NOT_APPEAR_IN_LIST' }])
  const r = await req('/api/memories')
  const body = JSON.stringify(r.body)
  expect(body).not.toContain('SHOULD_NOT_APPEAR_IN_LIST')
  expect(body).not.toContain('turns_json')
  expect(body).not.toContain('"turns"')
})
