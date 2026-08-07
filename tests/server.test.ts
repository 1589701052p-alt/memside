import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { eq } from 'drizzle-orm'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { createCandidate, promoteCandidate, saveSourceInput, saveDistillRun, logDiscards } from '@/memory/store'
import { ClaudeCodeAdapter } from '@/adapter/claudeCode'
import { OpencodeAdapter } from '@/adapter/opencode'
import { createApp } from '@/server'
import { memoryDistillJobs, memoryDistillEvents, memories, memoryDiscards, memoryDistillRuns } from '@/db/schema'
import type { MemoryStatus } from '@/memory/pure'
import type { ValueClass } from '@/memory/valueFilter'

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
let opencodeAdapter: OpencodeAdapter
let enqueueCalls: { sourceEventId: string; runtime: string; cwd: string; debounceKey: string; sessionId?: string; sourceAgentId?: string | null }[]
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
  opencodeAdapter = new OpencodeAdapter(db)
  enqueueCalls = []
  broadcastCalls = []
  app = createApp({
    db,
    adapter,
    opencodeAdapter,
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
    opencodeAdapter,
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
  // 第四轮：PostToolUse transcript 是累积式全量，与 Stop transcript 前缀重叠，
  // 每次 tool call 一个 job 导致同一段会话被重复蒸馏（同义候选爆炸）。
  // PostToolUse 不再蒸馏--Stop transcript 已含全部 tool_result（含 error），
  // 错误信号由 distiller 内 detectErrorSignals 从 Stop transcript 提取。
  // 即使带 transcript_path + is_error turn，也直接 202 跳过，不产生任何副作用。
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
  // 等待 fire-and-forget 路径（若误走）写出 event
  await new Promise((res) => setTimeout(res, 50))
  const events = await db.select().from(memoryDistillEvents)
  expect(events.length).toBe(beforeEvents.length)  // 不存 event
  expect(enqueueCalls.length).toBe(0)               // 不 enqueue job
  expect(broadcastCalls.length).toBe(0)             // 不 broadcast（连 memory.capture 都不发）
})

test('collector SubagentStop now enqueues + stores event + broadcasts (subagent distill)', async () => {
  // 第七轮（本 spec）：SubagentStop 不再早返回。payload 带 agent_id -> 定位 subagent
  // 自己的文件 -> 单独蒸馏。这里 transcript_path 指向一个 fixture（双路兜底退回它），
  // 断言 enqueue（带 sourceAgentId）+ 落 event + broadcast。
  const fixturePath = writeJsonlFixture('sub.jsonl', {
    type: 'user', message: { role: 'user', content: 'subagent internal turn' },
  })
  const beforeEvents = await db.select().from(memoryDistillEvents)
  const r = await req('/hooks/claude/SubagentStop', {
    method: 'POST',
    body: JSON.stringify({ sourceEventId: 'e3', cwd: '/r', transcript_path: fixturePath, session_id: 'sess-1', agent_id: 'ag-1' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(202)
  await new Promise((res) => setTimeout(res, 50))
  // enqueue 被调用，且带 sourceAgentId
  expect(enqueueCalls.length).toBe(1)
  expect(enqueueCalls[0]).toMatchObject({ sourceEventId: 'e3', runtime: 'claude-code', cwd: '/r', debounceKey: '/r:SubagentStop' })
  expect(enqueueCalls[0]!.sourceAgentId).toBe('ag-1')
  // 落了 event（含 subagent 内部 turn）
  const events = await db.select().from(memoryDistillEvents)
  expect(events.length).toBe(beforeEvents.length + 1)
  expect(events[events.length - 1]!.payload).toContain('subagent internal turn')
  // broadcast 了 capture
  expect(broadcastCalls.length).toBeGreaterThanOrEqual(1)
})

test('collector SubagentStop with agent_id hitting subagent file (double-fallback path 1)', async () => {
  // agent_id 推路径命中真实 subagent 文件 -> 落的 event 含 subagent 内容、不含主会话内容
  const subDir = join(dir, 'sess-ff', 'subagents')
  mkdirSync(subDir, { recursive: true })
  const mainPath = join(dir, 'sess-ff.jsonl')
  writeFileSync(mainPath, JSON.stringify({ type: 'user', message: { role: 'user', content: 'MAIN' } }) + '\n')
  const subPath = join(subDir, 'agent-ff.jsonl')
  writeFileSync(subPath, JSON.stringify({ type: 'user', message: { role: 'user', content: 'SUBAGENT-FF' } }) + '\n')
  await req('/hooks/claude/SubagentStop', {
    method: 'POST',
    body: JSON.stringify({ sourceEventId: 'e-ff', cwd: '/r', transcript_path: mainPath, agent_id: 'ff' }),
    headers: { 'content-type': 'application/json' },
  })
  await new Promise((res) => setTimeout(res, 50))
  const events = await db.select().from(memoryDistillEvents)
  const last = events[events.length - 1]!
  expect(last.payload).toContain('SUBAGENT-FF')
  expect(last.payload).not.toContain('MAIN')
})

test('collector SubagentStop still acks 202 when enqueue rejects, broadcasts failure', async () => {
  const bc: unknown[] = []
  app = createApp({
    db, adapter, opencodeAdapter,
    enqueueDistillJob: async () => { throw new Error('SQLITE_BUSY') },
    broadcast: (m: unknown) => { bc.push(m) },
  })
  const r = await req('/hooks/claude/SubagentStop', {
    method: 'POST',
    body: JSON.stringify({ sourceEventId: 'e-rej', cwd: '/r', transcript_path: '', agent_id: 'ag' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(202)
  await new Promise((res) => setTimeout(res, 50))
  expect(bc.some((m: any) => m.type === 'memory.enqueue.failed' && m.sourceEventId === 'e-rej')).toBe(true)
})

test('collector Stop reads session_id and passes it to enqueueDistillJob', async () => {
  // 第五轮：hook payload 的 session_id 是增量蒸馏的会话键。server.ts 必须读取并
  // 传入 enqueueDistillJob，否则 tick 无法按 session 切片偏移。
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
  // 第五轮：历史/无 session_id 的 Stop 仍正常 enqueue（sessionId 为空），
  // tick 走全量蒸馏路径。向后兼容。
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
  expect(enqueueCalls[0]!.sessionId).toBe('')  // 空 session_id -> 空串
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

test('POST /api/memories/:id/promote empty body -> 400 (not 500)', async () => {
  // 回归防护：曾裸 c.req.json() 在 try 外，空 body 抛 "Unexpected end of JSON
  // input" 逃逸成 500。web-api 客户端把 5xx 当异常抛、4xx 当业务错误，promote
  // 空 body 是客户端 bug 不应是 500。同时锁定候选未被误 approve。
  const c = await createCandidate(db, { scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  const r = await req(`/api/memories/${c.id}/promote`, { method: 'POST' })
  expect(r.status).toBe(400)
  const got = await req(`/api/memories/${c.id}`)
  expect(got.body.memory.status).toBe('candidate')
})

test('POST /api/memories/:id/promote invalid action -> 400 (not silently approved)', async () => {
  // 空/非法 action 曾走 else 分支被当 approve（body.action undefined !== 'reject'）。
  // action 校验挡住：非法 action 不应静默 approve 候选记忆。
  const c = await createCandidate(db, { scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  const r = await req(`/api/memories/${c.id}/promote`, {
    method: 'POST',
    body: JSON.stringify({ action: 'bogus' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(400)
  const got = await req(`/api/memories/${c.id}`)
  expect(got.body.memory.status).toBe('candidate')
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

test('PATCH /api/memories/:id empty body -> 400 (not 500)', async () => {
  // 回归防护：曾裸 c.req.json() 在 try 外，空 body 抛错逃逸 500。空对象 {} 是合法
  // no-op（200 changedFields=[]），但完全无 body 应 400。
  const c = await createCandidate(db, { scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  const miss = await req(`/api/memories/${c.id}`, { method: 'PATCH' })
  expect(miss.status).toBe(400)
  const noop = await req(`/api/memories/${c.id}`, {
    method: 'PATCH',
    body: JSON.stringify({}),
    headers: { 'content-type': 'application/json' },
  })
  expect(noop.status).toBe(200)
  expect(noop.body.changedFields).toEqual([])
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
  await saveSourceInput(db, 'job-snap', [{ role: 'user', content: 'the original input' }])
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
  // 不写快照行
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
  await saveSourceInput(db, 'job-list', [{ role: 'user', content: 'SHOULD_NOT_APPEAR_IN_LIST' }])
  const r = await req('/api/memories')
  const body = JSON.stringify(r.body)
  expect(body).not.toContain('SHOULD_NOT_APPEAR_IN_LIST')
  expect(body).not.toContain('turns_json')
  expect(body).not.toContain('"turns"')
})

// --- Task 5: origin/evidence 透传锁定（origin-driven value judgment）---
// 锁回归：store.createCandidate 已写 origin/evidence 列（Task 3 schema/store），
// server 的 GET /api/memories 直接序列化 drizzle 行（c.json({ items: rows })），
// 不做字段白名单，origin/evidence 自动透传。本测试锁定该透传契约，防止未来
// server 改成显式 pick 字段时静默丢掉出处信息（spec §R1 核心数据）。
// 预期 server 零改动即绿；若红，说明 server 引入了字段筛选，需补齐。
test('GET /api/memories 透传 origin/evidence（server 零改动，测试锁定透传）', async () => {
  const c = await createCandidate(db, {
    scopeType: 'project', scopeId: '/r', title: '退款窗口', bodyMd: '14 天内可退',
    tags: [], sourceKind: 'conversation', runtime: null, sourceCwd: '/r',
    origin: 'user-stated', evidence: '用户原话：这个商品支持 14 天退款',
  })
  const r = await req('/api/memories?status=candidate')
  expect(r.status).toBe(200)
  expect(r.body.items.length).toBe(1)
  expect(r.body.items[0].id).toBe(c.id)
  expect(r.body.items[0].origin).toBe('user-stated')
  expect(r.body.items[0].evidence).toBe('用户原话：这个商品支持 14 天退款')
})

// 负向锁定：未传 origin/evidence 的候选（手动记忆/老行）序列化为 null，不报错、
// 不漏字段。防止 rowToMemory / drizzle 行缺列时 undefined 被当作已标注。
test('GET /api/memories 未标注出处的候选 origin/evidence 为 null', async () => {
  await createCandidate(db, {
    scopeType: 'global', scopeId: null, title: '手动记忆', bodyMd: 'b',
    tags: [], sourceKind: 'manual', runtime: null,
  })
  const r = await req('/api/memories?status=candidate')
  expect(r.status).toBe(200)
  expect(r.body.items[0].origin).toBeNull()
  expect(r.body.items[0].evidence).toBeNull()
})

// --- Task 6: status 过滤 + discards 端点 + 4 个写路由 ---------------------
// 锁定回归：GET /api/memories?status=… 服务端过滤、GET /api/discards 审计列表、
// /api/status 含 discards 计数、archive/unarchive/restore/promote 4 写路由。
async function seedDiscardRow(id: string, opts: Partial<{ scopeType: string; scopeId: string | null; promotedMemoryId: string | null }> = {}) {
  const now = Date.now()
  await db.insert(memoryDistillJobs).values({
    id: `job-${id}`, debounceKey: 'k', sourceEventId: 'e', runtime: 'claude-code',
    cwd: '/p', sessionId: null, sourceAgentId: null, scopeResolvedJson: null,
    status: 'done', attempts: 0, nextRunAt: now, lastError: null, createdAt: now, finishedAt: now,
  })
  await db.insert(memoryDiscards).values({
    id, distillJobId: `job-${id}`, title: 'dt', bodyMd: 'db', reason: 'public-knowledge', ts: now,
    scopeType: opts.scopeType ?? 'project', scopeId: opts.scopeId ?? '/p',
    sourceCwd: '/p', runtime: 'claude-code', sourceKind: 'conversation',
    promotedMemoryId: opts.promotedMemoryId ?? null,
  })
}

test('GET /api/memories?status filters by status', async () => {
  const c = await createCandidate(db, { scopeType: 'global', scopeId: null, title: 'cand', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  await promoteCandidate(db, c.id, { action: 'approve' })
  const r = await req('/api/memories?status=approved')
  expect(r.status).toBe(200)
  expect((r.body.items as any[]).every((m) => m.status === 'approved')).toBe(true)
})

test('GET /api/memories?status with multiple values', async () => {
  const r = await req('/api/memories?status=approved,archived,superseded')
  expect(r.status).toBe(200)
  expect(Array.isArray(r.body.items)).toBe(true)
})

test('GET /api/memories?status ignores illegal values (no 400)', async () => {
  const r = await req('/api/memories?status=bogus,candidate')
  expect(r.status).toBe(200)
  // bogus 被忽略，只取 candidate
  expect((r.body.items as any[]).every((m) => m.status === 'candidate')).toBe(true)
})

test('GET /api/memories without status returns all', async () => {
  const r = await req('/api/memories')
  expect(r.status).toBe(200)
  expect(Array.isArray(r.body.items)).toBe(true)
})

test('GET /api/discards returns items newest-first', async () => {
  await seedDiscardRow('d1')
  const r = await req('/api/discards')
  expect(r.status).toBe(200)
  expect((r.body.items as any[]).length).toBe(1)
})

test('GET /api/discards empty table returns items:[]', async () => {
  const r = await req('/api/discards')
  expect(r.status).toBe(200)
  expect(r.body.items).toEqual([])
})

test('GET /api/status includes discards count', async () => {
  await seedDiscardRow('d1')
  const r = await req('/api/status')
  expect(r.status).toBe(200)
  expect(r.body.discards).toBe(1)
})

test('POST /api/memories/:id/restore moves rejected to candidate', async () => {
  const c = await createCandidate(db, { scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  await promoteCandidate(db, c.id, { action: 'reject' })
  const r = await req(`/api/memories/${c.id}/restore`, { method: 'POST' })
  expect(r.status).toBe(200)
  expect(r.body.memory.status).toBe('candidate')
  expect(broadcastCalls.some((m: any) => m.type === 'memory.restored')).toBe(true)
})

test('POST /api/memories/:id/restore on non-rejected returns 409', async () => {
  const c = await createCandidate(db, { scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  const r = await req(`/api/memories/${c.id}/restore`, { method: 'POST' })
  expect(r.status).toBe(409)
})

test('POST /api/memories/:id/archive + unarchive', async () => {
  const c = await createCandidate(db, { scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  await promoteCandidate(db, c.id, { action: 'approve' })
  const ar = await req(`/api/memories/${c.id}/archive`, { method: 'POST' })
  expect(ar.status).toBe(200)
  expect(ar.body.memory.status).toBe('archived')
  const ur = await req(`/api/memories/${c.id}/unarchive`, { method: 'POST' })
  expect(ur.status).toBe(200)
  expect(ur.body.memory.status).toBe('approved')
})

test('POST /api/discards/:id/promote creates candidate', async () => {
  await seedDiscardRow('d1')
  const r = await req('/api/discards/d1/promote', { method: 'POST' })
  expect(r.status).toBe(200)
  expect(r.body.memory.status).toBe('candidate')
  expect(broadcastCalls.some((m: any) => m.type === 'discard.promoted')).toBe(true)
})

test('POST /api/discards/:id/promote on already-promoted returns 409', async () => {
  await seedDiscardRow('d1', { promotedMemoryId: 'x' })
  const r = await req('/api/discards/d1/promote', { method: 'POST' })
  expect(r.status).toBe(409)
})

test('POST /api/discards/:id/promote on missing id returns 404', async () => {
  const r = await req('/api/discards/nope/promote', { method: 'POST' })
  expect(r.status).toBe(404)
})

// --- Task 5: distill-runs 端点 + /api/status 计数 --------------------------
// 锁定回归：distill 工作记录透明化。GET /api/distill-runs 列表（不含 rawOutput）、
// GET /api/distill-runs/:jobId 详情（含 rawOutput）、GET .../source-input 原始输入、
// /api/status 增 distillRuns 计数（按 outcome 分桶、近 24h）。
async function seedRunRow(jobId: string, outcome: string, cwd = '/repo', agentId: string | null = null) {
  await db.insert(memoryDistillJobs).values({ id: jobId, debounceKey: 'k', sourceEventId: 'e', runtime: 'claude-code', cwd, sourceAgentId: agentId, status: 'done', attempts: 0, nextRunAt: 0, createdAt: 100, finishedAt: 200 })
  await saveDistillRun(db, jobId, { outcome: outcome as any, rawOutput: { candidates: [{ title: '[category:convention] x' }] }, rawCount: 1, acceptedCount: 1, dedupedCount: 1, filteredCount: 1, storedCount: 1, discardedCount: 0, durationMs: 5, errorMessage: null })
}

test('GET /api/distill-runs lists runs without rawOutput', async () => {
  await seedRunRow('job-x1', 'produced')
  const r = await req('/api/distill-runs')
  expect(r.status).toBe(200)
  expect(r.body.items.length).toBe(1)
  expect(r.body.items[0].outcome).toBe('produced')
  expect(r.body.items[0].cwd).toBe('/repo')
  expect(JSON.stringify(r.body)).not.toContain('rawOutput')  // 列表不含 rawOutput
})

test('GET /api/distill-runs/:jobId returns detail with rawOutput', async () => {
  await seedRunRow('job-x2', 'produced')
  const r = await req('/api/distill-runs/job-x2')
  expect(r.status).toBe(200)
  expect((r.body.rawOutput as any)?.candidates?.length).toBe(1)
})

test('GET /api/distill-runs/:jobId 404 when missing', async () => {
  const r = await req('/api/distill-runs/nope')
  expect(r.status).toBe(404)
})

test('GET /api/distill-runs/:jobId/source-input returns turns', async () => {
  await saveSourceInput(db, 'job-x3', [{ role: 'user', content: 'hello' }] as any)
  const r = await req('/api/distill-runs/job-x3/source-input')
  expect(r.status).toBe(200)
  expect(r.body.turnCount).toBe(1)
  expect(r.body.turns[0].content).toBe('hello')
})

test('GET /api/distill-runs/:jobId/source-input 404 when no snapshot', async () => {
  const r = await req('/api/distill-runs/no-snap/source-input')
  expect(r.status).toBe(404)
})

test('GET /api/status includes distillRuns counts', async () => {
  await seedRunRow('job-x4', 'produced')
  await seedRunRow('job-x5', 'empty_output')
  const r = await req('/api/status')
  expect(r.status).toBe(200)
  expect(r.body.distillRuns).toBeDefined()
  expect(r.body.distillRuns.total).toBeGreaterThanOrEqual(2)
})

// 回归（2026-08-07 性能修复）：/api/status 计数从全表物化改 SQL 聚合
// （COUNT/GROUP BY）后语义必须不变——distillRuns 只计近 24h（严格 ts > 截止），
// byOutcome 分桶一致。此前旧实现对 memory_distill_events（大 payload 表）
// 做全表 SELECT * 仅为数行数，实测单请求 ~870ms。
test('GET /api/status 聚合语义不变：24h 外的 run 不计入 distillRuns', async () => {
  await seedRunRow('job-recent', 'produced')
  await seedRunRow('job-stale', 'produced')
  const staleTs = Date.now() - 25 * 60 * 60 * 1000
  await db.update(memoryDistillRuns).set({ ts: staleTs })
    .where(eq(memoryDistillRuns.distillJobId, 'job-stale')).run()
  const r = await req('/api/status')
  expect(r.status).toBe(200)
  expect(r.body.distillRuns.total).toBe(1)
  expect(r.body.distillRuns.byOutcome).toEqual({ produced: 1 })
})

// --- Task 5: distill-error-capture -- errorMessage 端点验证 ---
// 锁回归：GET /api/distill-runs/:jobId 和 GET /api/distill-runs 列表自动带出
// errorMessage（store 层 Task 3 已加字段，server 路由不改代码）。
test('GET /api/distill-runs/:jobId returns errorMessage', async () => {
  await saveDistillRun(db, 'job-em1', { outcome: 'llm_error', rawOutput: null, rawCount: 0,
    acceptedCount: 0, dedupedCount: 0, filteredCount: 0, storedCount: 0, discardedCount: 0,
    durationMs: 42, errorMessage: '500 Internal Server Error' })
  const res = await app.request('/api/distill-runs/job-em1')
  const data = await res.json()
  expect(data.errorMessage).toBe('500 Internal Server Error')
  expect(data.outcome).toBe('llm_error')
})

test('GET /api/distill-runs list items include errorMessage', async () => {
  await saveDistillRun(db, 'job-em2', { outcome: 'llm_error', rawOutput: null, rawCount: 0,
    acceptedCount: 0, dedupedCount: 0, filteredCount: 0, storedCount: 0, discardedCount: 0,
    durationMs: 1, errorMessage: 'timeout' })
  const res = await app.request('/api/distill-runs')
  const data = await res.json()
  const row = (data.items as any[]).find((r: any) => r.distillJobId === 'job-em2')
  expect(row?.errorMessage).toBe('timeout')
})

// --- Task 7: 存量回扫端点 --------------------------------------------------
// 回归防护:POST /api/rescan 是 fire-and-forget(202 立即返回),并发重按 409
// (不得起两个回扫);进度/报告经 GET /api/status 的 rescan 字段暴露。
// spec: docs/superpowers/specs/2026-08-06-agentic-value-judge-design.md §4.7
test('POST /api/rescan 202 fire-and-forget + status 暴露 rescan 字段', async () => {
  app = createApp({
    db, adapter, opencodeAdapter,
    enqueueDistillJob: async () => ({ jobId: 'j', nextRunAt: 0 }),
    broadcast: () => {},
    callLLM: async () => '{"verdicts": []}',
  })
  const r = await req('/api/rescan', { method: 'POST' })
  expect(r.status).toBe(202)
  expect(r.body.started).toBe(true)
  // 空候选池:回扫很快完成;轮询 status 直到 running=false,报告存在。
  let st = (await req('/api/status')).body
  for (let i = 0; i < 50 && st.rescan.running; i++) {
    await new Promise((r2) => setTimeout(r2, 10))
    st = (await req('/api/status')).body
  }
  expect(st.rescan.running).toBe(false)
  expect(st.rescan.report).toEqual({ processed: 0, discarded: 0, skipped: 0, keptUpdated: 0, stopped: false })
  // 新字段随 status 下发(老 UI 忽略,新 UI 依赖)
  expect(st.rescan.discarded).toBe(0)
  expect(st.rescan.stopping).toBe(false)
  expect(st.rescan.error).toBeNull()
})

test('POST /api/rescan 运行中重按 -> 409(并发防护)', async () => {
  // 挂起的 callLLM 让回扫停在判定中,第二次 POST 必见 running=true。
  await createCandidate(db, {
    scopeType: 'project', scopeId: dir, title: '[category:a] 一条', bodyMd: 'b',
    tags: [], sourceKind: 'conversation', sourceCwd: dir, runtime: 'claude-code', origin: 'agent-observed',
  })
  let release: (s: string) => void = () => {}
  const gate = new Promise<string>((res) => { release = res })
  app = createApp({
    db, adapter, opencodeAdapter,
    enqueueDistillJob: async () => ({ jobId: 'j', nextRunAt: 0 }),
    broadcast: () => {},
    callLLM: () => gate,
  })
  const r1 = await req('/api/rescan', { method: 'POST' })
  expect(r1.status).toBe(202)
  const r2 = await req('/api/rescan', { method: 'POST' })
  expect(r2.status).toBe(409)
  expect(r2.body.error).toBe('rescan already running')
  release('not json')  // 放行:agent 判定失败倒向保留,回扫收尾
  let st = (await req('/api/status')).body
  for (let i = 0; i < 100 && st.rescan.running; i++) {
    await new Promise((r3) => setTimeout(r3, 10))
    st = (await req('/api/status')).body
  }
  expect(st.rescan.running).toBe(false)
  expect(st.rescan.report.processed).toBe(1)
})

// --- 回扫取消与崩溃透传(spec 2026-08-07 §3.2/§3.3) --------------------------
// 回归防护:停止粒度=批边界——cancel 只置标记,正在判的批照常判完;运行级崩溃
// 必须落 rescan.error(UI 红字可见),不得静默解锁按钮。
test('POST /api/rescan/cancel 未在跑 -> 409', async () => {
  app = createApp({
    db, adapter, opencodeAdapter,
    enqueueDistillJob: async () => ({ jobId: 'j', nextRunAt: 0 }),
    broadcast: () => {},
    callLLM: async () => '{"verdicts": []}',
  })
  const r = await req('/api/rescan/cancel', { method: 'POST' })
  expect(r.status).toBe(409)
  expect(r.body.error).toBe('no rescan running')
})

test('POST /api/rescan/cancel 批边界停止:第 2 批前停,stopped=true,stopping 可见', async () => {
  for (let i = 0; i < 20; i++) {
    await createCandidate(db, {
      scopeType: 'project', scopeId: dir, title: `[category:a] 候选${i}`, bodyMd: 'b',
      tags: [], sourceKind: 'conversation', sourceCwd: dir, runtime: 'claude-code', origin: 'agent-observed',
    })
  }
  let onFirstCall: () => void = () => {}
  const firstCall = new Promise<void>((res) => { onFirstCall = res })
  let release: (s: string) => void = () => {}
  const gate = new Promise<string>((res) => { release = res })
  let called = false
  app = createApp({
    db, adapter, opencodeAdapter,
    enqueueDistillJob: async () => ({ jobId: 'j', nextRunAt: 0 }),
    broadcast: () => {},
    callLLM: () => { if (!called) { called = true; onFirstCall() } return gate },
  })
  const r1 = await req('/api/rescan', { method: 'POST' })
  expect(r1.status).toBe(202)
  await firstCall  // 第 1 批判定已开始(默认质量模式,agent 循环首轮 LLM)
  const rc = await req('/api/rescan/cancel', { method: 'POST' })
  expect(rc.status).toBe(202)
  expect(rc.body.stopping).toBe(true)
  expect((await req('/api/status')).body.rescan.stopping).toBe(true)
  release('{"final": {"verdicts": []}}')  // 放行:第 1 批判完(全留),随后批边界停止
  let st = (await req('/api/status')).body
  for (let i = 0; i < 200 && st.rescan.running; i++) {
    await new Promise((r2) => setTimeout(r2, 10))
    st = (await req('/api/status')).body
  }
  expect(st.rescan.running).toBe(false)
  expect(st.rescan.report.stopped).toBe(true)
  expect(st.rescan.report.processed).toBe(15)
})

test('POST /api/rescan 运行级崩溃 -> status.rescan.error 可见(不静默解锁)', async () => {
  await createCandidate(db, {
    scopeType: 'project', scopeId: dir, title: '[category:a] 一条', bodyMd: 'b',
    tags: [], sourceKind: 'conversation', sourceCwd: dir, runtime: 'claude-code', origin: 'agent-observed',
  })
  // 只让 insert 抛错(合成 job 落库即崩,/api/status 只 select 不受影响)
  const brokenDb = new Proxy(db, {
    get: (t, p, r) => (p === 'insert'
      ? () => { throw new Error('boom-insert') }
      : Reflect.get(t, p, r)),
  })
  app = createApp({
    db: brokenDb as typeof db, adapter, opencodeAdapter,
    enqueueDistillJob: async () => ({ jobId: 'j', nextRunAt: 0 }),
    broadcast: () => {},
    callLLM: async () => '{"verdicts": []}',
  })
  const r = await req('/api/rescan', { method: 'POST' })
  expect(r.status).toBe(202)
  let st = (await req('/api/status')).body
  for (let i = 0; i < 100 && st.rescan.running; i++) {
    await new Promise((r2) => setTimeout(r2, 10))
    st = (await req('/api/status')).body
  }
  expect(st.rescan.running).toBe(false)
  expect(st.rescan.error).toContain('boom-insert')
})

// --- Task 4 (2026-08-07 tab-list-pagination): 三列表端点游标分页分流 + ----------
// bulk-reject-unevaluated + /api/status unevaluatedCandidates。
// 锁定 HTTP 契约：带 limit -> {items,hasMore,nextCursor} 分页形状；不带 -> 旧全量
// 形状（兼容锚点）；非法游标宽松忽略不 400；bulk-reject 走服务端按条件批量 + broadcast。

async function seedMem(createdAt: number, status: MemoryStatus, valueClass: ValueClass | null = null) {
  const m = await createCandidate(db, {
    scopeType: 'global', scopeId: null, title: `t-${createdAt}`, bodyMd: 'b',
    tags: [], sourceKind: 'manual', runtime: null, valueClass,
  })
  await db.update(memories).set({ createdAt, status }).where(eq(memories.id, m.id)).run()
  return m.id
}

test('GET /api/memories?limit 分页形状 + 游标翻页', async () => {
  for (const ts of [1000, 2000, 3000]) await seedMem(ts, 'candidate')
  const p1 = await req('/api/memories?status=candidate&limit=2')
  expect(p1.status).toBe(200)
  expect(p1.body.items.length).toBe(2)
  expect(p1.body.hasMore).toBe(true)
  expect(p1.body.nextCursor).toEqual({ ts: 2000, id: p1.body.items[1].id })
  const p2 = await req(`/api/memories?status=candidate&limit=2&before=${p1.body.nextCursor.ts}&beforeId=${p1.body.nextCursor.id}`)
  expect(p2.body.items.length).toBe(1)
  expect(p2.body.hasMore).toBe(false)
  expect(p2.body.nextCursor).toBeNull()
})

test('GET /api/memories 不带 limit -> 旧全量形状（兼容锚点）', async () => {
  for (const ts of [1000, 2000, 3000]) await seedMem(ts, 'candidate')
  const r = await req('/api/memories?status=candidate')
  expect(r.status).toBe(200)
  expect(r.body.items.length).toBe(3)
  expect('hasMore' in r.body).toBe(false)
})

test('GET /api/memories 非法游标宽松忽略不 400', async () => {
  await seedMem(1000, 'candidate')
  const r = await req('/api/memories?status=candidate&limit=50&before=abc&beforeId=x')
  expect(r.status).toBe(200)
  expect(r.body.items.length).toBe(1)
})

test('GET /api/memories limit clamp：0 -> 1 条，9999 -> 不报错', async () => {
  for (const ts of [1000, 2000, 3000]) await seedMem(ts, 'candidate')
  const r0 = await req('/api/memories?status=candidate&limit=0')
  expect(r0.body.items.length).toBe(1)
  const rBig = await req('/api/memories?status=candidate&limit=9999')
  expect(rBig.status).toBe(200)
  expect(rBig.body.hasMore).toBe(false)
})

test('GET /api/discards 分页/旧形状分流', async () => {
  await logDiscards(db, 'job-d', [1, 2, 3].map((i) => ({
    title: `d-${i}`, bodyMd: 'b', reason: 'fleeting' as const,
    scopeType: 'global' as const, scopeId: null, sourceCwd: null,
    runtime: null, sourceKind: 'conversation' as const,
  })))
  const legacy = await req('/api/discards')
  expect(legacy.body.items.length).toBe(3)
  expect('hasMore' in legacy.body).toBe(false)
  const p1 = await req('/api/discards?limit=2')
  expect(p1.body.items.length).toBe(2)
  expect(p1.body.hasMore).toBe(true)
})

test('GET /api/distill-runs 分页/旧形状分流', async () => {
  const legacy = await req('/api/distill-runs')
  expect(legacy.status).toBe(200)
  expect('hasMore' in legacy.body).toBe(false)
  const paged = await req('/api/distill-runs?limit=50')
  expect(paged.status).toBe(200)
  expect(paged.body).toEqual({ items: [], hasMore: false, nextCursor: null })
})

test('POST /api/memories/bulk-reject-unevaluated 按条件批量 + broadcast', async () => {
  await seedMem(1000, 'candidate', null)
  await seedMem(2000, 'candidate', 'decision')
  const r = await req('/api/memories/bulk-reject-unevaluated', { method: 'POST' })
  expect(r.status).toBe(200)
  expect(r.body.rejected).toBe(1)
  expect(broadcastCalls.some((m: any) => m?.type === 'memories.bulk-rejected')).toBe(true)
})

test('GET /api/status 含 unevaluatedCandidates 且数值正确', async () => {
  await seedMem(1000, 'candidate', null)
  await seedMem(2000, 'candidate', 'decision')
  await seedMem(3000, 'approved', null)
  const r = await req('/api/status')
  expect(r.body.unevaluatedCandidates).toBe(1)
})
