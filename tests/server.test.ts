import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { eq } from 'drizzle-orm'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { createCandidate, promoteCandidate, saveSourceInput, saveDistillRun, logDiscards } from '@/memory/store'
import { ClaudeCodeAdapter } from '@/adapter/claudeCode'
import { OpencodeAdapter } from '@/adapter/opencode'
import { createApp } from '@/server'
import { memoryDistillJobs, memoryDistillEvents, memories, memoryDiscards, memoryDistillRuns, memoryDegradations, notifications, memorySessionOffsets } from '@/db/schema'
import { markAllNotificationsRead } from '@/memory/store'
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

// --- collector SubagentStop（spec 2026-08-15 §5.3）：删主会话兜底 + 取证 degradation ---
// Task 7：SubagentStop 不再调 loadSubagentTranscript（会退回主会话）改调
// resolveSubagentTranscript（永不兜底）。turns 非空 -> 入队 + 存 event（旧行为守卫）；
// turns 空 -> 不入队、不存 event，写一条 subagent_transcript_missing degradation
// （detail = diag 全字段 + payloadKeys），logDegradation 双写通知。
test('collector SubagentStop: subagent 文件命中 -> 入队 + 存 event + broadcast（旧行为守卫）', async () => {
  // 夹具：tmp 目录 main.jsonl + main/subagents/agent-AG.jsonl
  const subDir = join(dir, 'main', 'subagents')
  mkdirSync(subDir, { recursive: true })
  const mainPath = join(dir, 'main.jsonl')
  writeFileSync(mainPath, JSON.stringify({ type: 'user', message: { role: 'user', content: 'MAIN SESSION' } }) + '\n')
  const subPath = join(subDir, 'agent-AG.jsonl')
  writeFileSync(subPath, JSON.stringify({ type: 'user', message: { role: 'user', content: 'SUBAGENT INTERNAL' } }) + '\n')
  const beforeEvents = await db.select().from(memoryDistillEvents)
  const beforeDeg = await db.select().from(memoryDegradations)
  const r = await req('/hooks/claude/SubagentStop', {
    method: 'POST',
    body: JSON.stringify({ sourceEventId: 'e3', cwd: '/r', transcript_path: mainPath, agent_id: 'AG' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(202)
  await new Promise((res) => setTimeout(res, 50))
  // enqueue 被调且 sourceAgentId='AG'
  expect(enqueueCalls.length).toBe(1)
  expect(enqueueCalls[0]).toMatchObject({ sourceEventId: 'e3', runtime: 'claude-code', cwd: '/r', debounceKey: '/r:SubagentStop' })
  expect(enqueueCalls[0]!.sourceAgentId).toBe('AG')
  // 落了 event（含 subagent 内部 turn，不含主会话）
  const events = await db.select().from(memoryDistillEvents)
  expect(events.length).toBe(beforeEvents.length + 1)
  expect(events[events.length - 1]!.payload).toContain('SUBAGENT INTERNAL')
  expect(events[events.length - 1]!.payload).not.toContain('MAIN SESSION')
  // 无 degradation 行
  const afterDeg = await db.select().from(memoryDegradations)
  expect(afterDeg.length).toBe(beforeDeg.length)
  // broadcast 了 capture
  expect(broadcastCalls.length).toBeGreaterThanOrEqual(1)
})

test('collector SubagentStop: 文件缺失 -> 不入队 + subagent_transcript_missing degradation（含取证）+ 通知双写', async () => {
  // 夹具只有 main.jsonl（无 subagents 目录或无该 agent 文件）
  const mainPath = join(dir, 'main.jsonl')
  writeFileSync(mainPath, JSON.stringify({ type: 'user', message: { role: 'user', content: 'MAIN SESSION' } }) + '\n')
  const beforeEvents = await db.select().from(memoryDistillEvents)
  const beforeJobs = await db.select().from(memoryDistillJobs)
  const r = await req('/hooks/claude/SubagentStop', {
    method: 'POST',
    body: JSON.stringify({ sourceEventId: 'e-miss', cwd: '/r', transcript_path: mainPath, session_id: 's1', agent_id: 'NOPE' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(202)
  await new Promise((res) => setTimeout(res, 50))
  // 不入队
  expect(enqueueCalls.length).toBe(0)
  const afterJobs = await db.select().from(memoryDistillJobs)
  expect(afterJobs.length).toBe(beforeJobs.length)
  // 不存 event
  const afterEvents = await db.select().from(memoryDistillEvents)
  expect(afterEvents.length).toBe(beforeEvents.length)
  // memory_degradations 有 kind='subagent_transcript_missing' 且 sessionId='s1'
  const degs = await db.select().from(memoryDegradations)
  const miss = degs.find((d) => d.kind === 'subagent_transcript_missing')
  expect(miss).toBeDefined()
  expect(miss!.sessionId).toBe('s1')
  // detail JSON 含 diag 全字段 + payloadKeys；agentId='NOPE'、derivedExists=false
  const detail = JSON.parse(miss!.detail!)
  expect(detail.agentId).toBe('NOPE')
  expect(detail.derivedExists).toBe(false)
  expect(detail.derivedTurns).toBe(0)
  expect(detail.transcriptPath).toBe(mainPath)
  expect(detail.mainTranscriptExists).toBe(true)
  expect(Array.isArray(detail.subagentsDirEntries)).toBe(true)
  expect(Array.isArray(detail.payloadKeys)).toBe(true)
  expect(detail.payloadKeys).toContain('agent_id')
  // notifications 表新增 kind='degradation'、title='subagent_transcript_missing' 的行
  const notifs = await db.select().from(notifications)
  const nd = notifs.find((n) => n.kind === 'degradation' && n.title === 'subagent_transcript_missing')
  expect(nd).toBeDefined()
})

test('collector SubagentStop: payload 缺 agent_id -> 同样走 degradation（不再只 console.warn）', async () => {
  // POST 不带 agent_id
  const mainPath = join(dir, 'main2.jsonl')
  writeFileSync(mainPath, JSON.stringify({ type: 'user', message: { role: 'user', content: 'MAIN2' } }) + '\n')
  const r = await req('/hooks/claude/SubagentStop', {
    method: 'POST',
    body: JSON.stringify({ sourceEventId: 'e-noid', cwd: '/r', transcript_path: mainPath, session_id: 's2' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(202)
  await new Promise((res) => setTimeout(res, 50))
  expect(enqueueCalls.length).toBe(0)
  const degs = await db.select().from(memoryDegradations)
  const miss = degs.find((d) => d.kind === 'subagent_transcript_missing' && d.sessionId === 's2')
  expect(miss).toBeDefined()
  const detail = JSON.parse(miss!.detail!)
  expect(detail.agentId).toBe('')
  expect(detail.derivedPath).toBeNull()
})

// spec 2026-08-17 §测试策略 #7（源码层文本守卫）+ #7 端到端透传：SubagentStop 分支必须
// 把 body.agent_transcript_path 透传给 resolveSubagentTranscript 第三参数；降级 detail 的
// diag spread 自动带出 agentTranscriptPath 值 + agentTranscriptPathExists 存在性两字段。
// 这条测试钉死透传链路，防未来 refactor 丢第三参数。
test('collector SubagentStop: body.agent_transcript_path 透传 -> 降级 detail 含 agentTranscriptPath 值 + agentTranscriptPathExists:true（端到端透传锁，spec §测试策略 #7）', async () => {
  // 夹具：主会话 main.jsonl 存在，但 subagents 目录下无 agent-AG.jsonl（derivedExists=false，
  // 走降级）。直连路径 agent_transcript_path 指向一个真实 tmp 文件——模拟 claude code 对
  // 异常子 agent 用了不同落盘位置。透传到位时 detail.agentTranscriptPathExists=true。
  const mainPath = join(dir, 'main-diag.jsonl')
  writeFileSync(mainPath, JSON.stringify({ type: 'user', message: { role: 'user', content: 'MAIN DIAG' } }) + '\n')
  const directPath = join(dir, 'direct-agent.jsonl')
  writeFileSync(directPath, JSON.stringify({ type: 'user', message: { role: 'user', content: 'DIRECT' } }) + '\n')
  const r = await req('/hooks/claude/SubagentStop', {
    method: 'POST',
    body: JSON.stringify({
      sourceEventId: 'e-diag', cwd: '/r', session_id: 's-diag',
      transcript_path: mainPath, agent_id: 'AG', agent_transcript_path: directPath,
    }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(202)
  await new Promise((res) => setTimeout(res, 50))
  // derivedPath 不存在 -> 不入队 + 降级
  expect(enqueueCalls.length).toBe(0)
  const degs = await db.select().from(memoryDegradations)
  const miss = degs.find((d) => d.kind === 'subagent_transcript_missing' && d.sessionId === 's-diag')
  expect(miss).toBeDefined()
  const detail = JSON.parse(miss!.detail!)
  // 透传到位：直连路径值 + 存在性如实进入 diag（spread 进 detail）
  expect(detail.agentTranscriptPath).toBe(directPath)
  expect(detail.agentTranscriptPathExists).toBe(true)
  // 推导路径仍不存在（直连路径不进决策）——锁定取证不污染控制流
  expect(detail.derivedExists).toBe(false)
  expect(detail.payloadKeys).toContain('agent_transcript_path')
})

test('collector SubagentStop: 源码层文本守卫——server.ts SubagentStop 分支透传第三参数 agentTranscriptPath（spec §测试策略 #7，防 refactor 丢参数）', async () => {
  const src = await Bun.file(join(import.meta.dir, '..', 'src', 'server.ts')).text()
  // 第三参数必须出现：resolveSubagentTranscript(transcriptPath, agentId, agentTranscriptPath)
  expect(src).toContain('resolveSubagentTranscript(transcriptPath, agentId, agentTranscriptPath)')
  // body.agent_transcript_path 读取 + ?? '' 兜底（缺失时传空串 -> diag 判空 -> null/false）
  expect(src).toContain("body.agent_transcript_path ?? ''")
  // body 的 inline 类型含 agent_transcript_path（透传契约对齐 Task 1 新签名）
  expect(src).toContain('agent_transcript_path?: string')
})

test('collector Stop reads session_id and keys the session waiting job by it', async () => {
  // 第五轮：hook payload 的 session_id 是增量蒸馏的会话键。server.ts 必须读取并
  // 落到 job.sessionId，否则 tick 无法按 session 切片偏移。
  // 攒量批处理（Task 7，spec §4.8）后：带 session_id 的主会话 Stop 不再走
  // deps.enqueueDistillJob（那是 legacy 无 sessionId / subagent 的 seam），而是
  // 累加进该 session 唯一的 waiting job（不变量 A）——本测试改为锁新契约：
  // job 以 session_id 为键建成 waiting，且未立即放行。
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
  await new Promise((res) => setTimeout(res, 50))
  const jobs = await db.select().from(memoryDistillJobs)
  expect(jobs.length).toBe(1)
  expect(jobs[0]!.sessionId).toBe('sess-abc')
  expect(jobs[0]!.status).toBe('waiting')
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
// --- status 按类未读计数（spec 2026-08-14 §3.2，T4）-------------------------
test('GET /api/status 按类未读计数 + 最新未读 llm_error', async () => {
  // 状态栏警示条的数据源：unreadLlmErrors / unreadDegradations 分别计数
  // （已读的不计入），latestUnreadLlmError 返回最新一条未读 llm_error 的
  // body/ts；unreadNotifications 总数保留不变。
  const rows: (typeof notifications.$inferInsert)[] = [
    { id: 'n-e1', ts: 1000, kind: 'llm_error', title: 'llm_error', body: 'Connection error. (old)', readAt: null },
    { id: 'n-e2', ts: 2000, kind: 'llm_error', title: 'llm_error', body: 'Connection error. (new)', readAt: null },
    { id: 'n-e3', ts: 3000, kind: 'llm_error', title: 'llm_error', body: 'already read', readAt: 9999 },
    { id: 'n-d1', ts: 1001, kind: 'degradation', title: 'context_trim', body: null, readAt: null },
    { id: 'n-d2', ts: 1002, kind: 'degradation', title: 'dedup_skip', body: null, readAt: null },
    { id: 'n-d3', ts: 1003, kind: 'degradation', title: 'judge_skip', body: null, readAt: null },
  ]
  for (const row of rows) await db.insert(notifications).values(row)

  const r = await req('/api/status')
  expect(r.status).toBe(200)
  expect(r.body.unreadLlmErrors).toBe(2)
  expect(r.body.unreadDegradations).toBe(3)
  expect(r.body.latestUnreadLlmError).toEqual({ body: 'Connection error. (new)', ts: 2000 })
  expect(r.body.unreadNotifications).toBe(5)
})

test('GET /api/status 全部已读后按类计数归零、latestUnreadLlmError 为 null', async () => {
  await db.insert(notifications).values({ id: 'n-r1', ts: 1000, kind: 'llm_error', title: 'llm_error', body: 'boom', readAt: null })
  await db.insert(notifications).values({ id: 'n-r2', ts: 1001, kind: 'degradation', title: 'context_trim', body: null, readAt: null })
  await markAllNotificationsRead(db)

  const r = await req('/api/status')
  expect(r.status).toBe(200)
  expect(r.body.unreadLlmErrors).toBe(0)
  expect(r.body.unreadDegradations).toBe(0)
  expect(r.body.latestUnreadLlmError).toBeNull()
  expect(r.body.unreadNotifications).toBe(0)
})

// Task 8（spec 2026-08-15 §5.7）：unreadLlmErrors / latestUnreadLlmError 字段名
// 不变，语义扩为「覆盖 llm_error + parse_error」两类 LLM 类报错——解析失败不再
// 假扮空产出而漏报。latestUnreadLlmError 取两类中 ts 最新的一条。
test('GET /api/status: unreadLlmErrors 覆盖 parse_error；latestUnreadLlmError 取两类中最新', async () => {
  const rows: (typeof notifications.$inferInsert)[] = [
    { id: 'n-pe1', ts: 1000, kind: 'llm_error', title: 'llm_error', body: 'Connection error.', readAt: null },
    { id: 'n-pe2', ts: 2000, kind: 'parse_error', title: 'parse_error', body: '不是合法 JSON：x', readAt: null },
  ]
  for (const row of rows) await db.insert(notifications).values(row)

  const r = await req('/api/status')
  expect(r.status).toBe(200)
  expect(r.body.unreadLlmErrors).toBe(2)
  expect(r.body.latestUnreadLlmError).toEqual({ body: '不是合法 JSON：x', ts: 2000 })
  expect(r.body.unreadNotifications).toBe(2)
})

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
  // allTime = 全量 run 数（含 24h 外），runs tab 列表计数用
  expect(r.body.distillRuns.allTime).toBe(2)
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
  release('not json')  // 放行:judge 失败 -> Task 7 暂停语义（pending_review + stopped），回扫收尾
  let st = (await req('/api/status')).body
  for (let i = 0; i < 100 && st.rescan.running; i++) {
    await new Promise((r3) => setTimeout(r3, 10))
    st = (await req('/api/status')).body
  }
  expect(st.rescan.running).toBe(false)
  expect(st.rescan.report.stopped).toBe(true)      // judge 失败停住（可重跑续判）
  expect(st.rescan.report.processed).toBe(0)       // 该批未判完（标 pending_review）
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

// --- 2026-08-11 web-memory-filters: 四维服务端筛选 + facets + total ---------

async function seedMemFull(opts: {
  ts: number; status?: MemoryStatus; valueClass?: ValueClass | null
  sourceCwd?: string | null; slug?: string | null; title?: string
}) {
  const m = await createCandidate(db, {
    scopeType: 'global', scopeId: null,
    title: opts.title ?? `[category:convention] t-${opts.ts}`, bodyMd: 'b',
    tags: [], sourceKind: 'manual', runtime: null,
    valueClass: opts.valueClass ?? null, sourceCwd: opts.sourceCwd ?? null,
    subjectSlug: opts.slug ?? null,
  })
  await db.update(memories).set({ createdAt: opts.ts, status: opts.status ?? 'candidate' })
    .where(eq(memories.id, m.id)).run()
  return m.id
}

test('GET /api/memories?limit 四维筛选参数各自生效 + total + 组合 AND', async () => {
  await seedMemFull({ ts: 1000, sourceCwd: 'C:/p/a', slug: 'refund-policy', valueClass: 'decision' })
  await seedMemFull({ ts: 2000, sourceCwd: 'C:/p/b', slug: 'other', valueClass: null })
  const byProject = await req(`/api/memories?limit=50&project=${encodeURIComponent('C:/p/a')}`)
  expect(byProject.status).toBe(200)
  expect(byProject.body.items.length).toBe(1)
  expect(byProject.body.total).toBe(1)
  const bySlug = await req('/api/memories?limit=50&slug=refund-policy')
  expect(bySlug.body.items.length).toBe(1)
  const byCat = await req('/api/memories?limit=50&category=convention')
  expect(byCat.body.items.length).toBe(2)
  const byVc = await req('/api/memories?limit=50&valueClass=unevaluated')
  expect(byVc.body.items.length).toBe(1)
  const combined = await req(`/api/memories?limit=50&project=${encodeURIComponent('C:/p/a')}&valueClass=decision`)
  expect(combined.body.items.length).toBe(1)
  expect(combined.body.total).toBe(1)
})

test('GET /api/memories 非法 valueClass 宽松忽略不 400', async () => {
  await seedMemFull({ ts: 1000, valueClass: 'decision' })
  const r = await req('/api/memories?limit=50&valueClass=bogus')
  expect(r.status).toBe(200)
  expect(r.body.items.length).toBe(1)
})

test('GET /api/memories 旧全量路径忽略 filter 参数（决策 D4 锁）', async () => {
  await seedMemFull({ ts: 1000, sourceCwd: 'C:/p/a' })
  await seedMemFull({ ts: 2000, sourceCwd: 'C:/p/b' })
  const r = await req(`/api/memories?project=${encodeURIComponent('C:/p/a')}`)
  expect(r.status).toBe(200)
  expect(r.body.items.length).toBe(2) // 无 limit -> 旧形状，不筛选
  expect('hasMore' in r.body).toBe(false)
})

test('GET /api/discards?limit project/category 筛选 + total', async () => {
  db.insert(memoryDistillJobs).values({
    id: 'job-f', debounceKey: 'k', sourceEventId: 's', runtime: 'claude-code',
    cwd: '/r', status: 'done', attempts: 0, nextRunAt: 0, createdAt: 0,
  }).run()
  await logDiscards(db, 'job-f', [
    { title: '[category:trap] 坑A', bodyMd: 'b', reason: 'fleeting' as const, scopeType: 'project' as const, scopeId: 'C:/p/a', sourceCwd: 'C:/p/a', runtime: null, sourceKind: 'conversation' as const },
    { title: '[category:convention] 约定B', bodyMd: 'b', reason: 'derivable' as const, scopeType: 'project' as const, scopeId: 'C:/p/a', sourceCwd: 'C:/p/a', runtime: null, sourceKind: 'conversation' as const },
  ])
  const byProject = await req(`/api/discards?limit=50&project=${encodeURIComponent('C:/p/a')}`)
  expect(byProject.body.items.length).toBe(2)
  expect(byProject.body.total).toBe(2)
  const byCat = await req('/api/discards?limit=50&category=trap')
  expect(byCat.body.items.length).toBe(1)
  const none = await req(`/api/discards?limit=50&project=${encodeURIComponent('C:/nope')}`)
  expect(none.body.items.length).toBe(0)
  expect(none.body.total).toBe(0)
})

async function seedDiscardRowForFacets(id: string, title: string, sourceCwd: string) {
  const now = Date.now()
  await db.insert(memoryDistillJobs).values({
    id: `job-${id}`, debounceKey: 'k', sourceEventId: 'e', runtime: 'claude-code',
    cwd: '/p', sessionId: null, sourceAgentId: null, scopeResolvedJson: null,
    status: 'done', attempts: 0, nextRunAt: now, lastError: null, createdAt: now, finishedAt: now,
  })
  await db.insert(memoryDiscards).values({
    id, distillJobId: `job-${id}`, title, bodyMd: 'db', reason: 'public-knowledge', ts: now,
    scopeType: 'project', scopeId: sourceCwd,
    sourceCwd, runtime: 'claude-code', sourceKind: 'conversation',
    promotedMemoryId: null,
  })
}

test('GET /api/facets?tab= 按 tab 圈定统计（混播状态互相隔离）', async () => {
  await seedMemFull({ ts: 1000, sourceCwd: 'C:/p/a', slug: 's1', valueClass: 'decision' })
  await seedMemFull({ ts: 2000, sourceCwd: 'C:/p/a', slug: 's2', valueClass: null, status: 'rejected' })
  const cand = await req('/api/facets?tab=candidate')
  expect(cand.status).toBe(200)
  expect(cand.body.projects).toEqual([{ value: 'C:/p/a', count: 1 }])
  expect(cand.body.slugs).toEqual([{ value: 's1', count: 1 }])
  expect(cand.body.categories).toEqual([{ value: 'convention', count: 1 }])
  expect(cand.body.valueClasses).toEqual([{ value: 'decision', count: 1 }])
  const rej = await req('/api/facets?tab=rejected')
  expect(rej.body.projects).toEqual([{ value: 'C:/p/a', count: 1 }])
  expect(rej.body.slugs).toEqual([{ value: 's2', count: 1 }])
  expect(rej.body.valueClasses).toEqual([{ value: 'unevaluated', count: 1 }])
})

test('GET /api/facets?tab=discards 只查 discards 表，memories scope 不含 discard 行', async () => {
  await seedMemFull({ ts: 1000, sourceCwd: 'C:/p/mem', slug: 's1', valueClass: 'decision' })
  await seedDiscardRowForFacets('df1', '[category:trap] D1', 'C:/p/dis')
  await seedDiscardRowForFacets('df2', '[category:trap] D2', 'C:/p/dis')
  const r = await req('/api/facets?tab=discards')
  expect(r.status).toBe(200)
  expect(r.body.projects).toEqual([{ value: 'C:/p/dis', count: 2 }])
  expect(r.body.categories).toEqual([{ value: 'trap', count: 2 }])
  expect(r.body.slugs).toEqual([])
  expect(r.body.valueClasses).toEqual([])
  const cand = await req('/api/facets?tab=candidate')
  expect(cand.body.projects).toEqual([{ value: 'C:/p/mem', count: 1 }])
})

test('GET /api/facets?tab=approved 覆盖 approved/archived/superseded 三态（candidate 不混入）', async () => {
  // 终审 Regression 锁：GET /api/facets?tab=approved 是唯一覆盖多状态映射
  // （approved/archived/superseded）的 HTTP 契约。若未来从映射里删掉一个状态，
  // 本测试红——防止「编译通过但静默丢状态」。
  await seedMemFull({ ts: 1000, sourceCwd: 'C:/p/a', status: 'approved' })
  await seedMemFull({ ts: 2000, sourceCwd: 'C:/p/a', status: 'archived' })
  await seedMemFull({ ts: 3000, sourceCwd: 'C:/p/a', status: 'superseded' })
  await seedMemFull({ ts: 4000, sourceCwd: 'C:/p/a' }) // candidate，不应计入
  const r = await req('/api/facets?tab=approved')
  expect(r.status).toBe(200)
  expect(r.body.projects).toEqual([{ value: 'C:/p/a', count: 3 }])
})

test('GET /api/facets 缺失/非法 tab -> 400', async () => {
  expect((await req('/api/facets')).status).toBe(400)
  expect((await req('/api/facets?tab=runs')).status).toBe(400)
})

// --- Task 9: 暂停 job 处置 + 待审查候选 + /api/status pausedJobs -----------------
// 锁 spec 2026-08-18 §6：retry/abandon 路由 + pending_review 列表/whitelist +
// status.pausedJobs 计数。复用 server.test.ts seedJob 模式（直插 memory_distill_jobs）。

function seedPausedJob(id: string, opts: { cwd?: string; sessionId?: string } = {}): void {
  const now = Date.now()
  db.insert(memoryDistillJobs).values({
    id, debounceKey: `k-${id}`, sourceEventId: `s-${id}`, runtime: 'claude-code',
    cwd: opts.cwd ?? '/p', sessionId: opts.sessionId ?? null,
    status: 'paused', attempts: 2, nextRunAt: now, createdAt: now, stepError: 'judge',
  }).run()
}

test('GET /api/status 报 pausedJobs 计数（spec §6）', async () => {
  seedPausedJob('pj1')
  seedPausedJob('pj2')
  const r = await req('/api/status')
  expect(r.status).toBe(200)
  expect(r.body.pausedJobs).toBe(2)
})

test('POST /api/distill-runs/:jobId/retry 重置 paused job 回 pending（spec §6）', async () => {
  seedPausedJob('pj1')
  const r = await req('/api/distill-runs/pj1/retry', { method: 'POST' })
  expect(r.status).toBe(200)
  expect(r.body.ok).toBe(true)
  const job = db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, 'pj1')).all()[0]!
  expect(job.status).toBe('pending')
  expect(job.stepAttempts).toBe(0)
  expect(job.stepError).toBeNull()
  expect(broadcastCalls.some((m: any) => m.type === 'job.retry')).toBe(true)
})

test('POST /api/distill-runs/:jobId/retry 非 paused job -> 409', async () => {
  const now = Date.now()
  db.insert(memoryDistillJobs).values({
    id: 'dj1', debounceKey: 'k', sourceEventId: 's', runtime: 'claude-code',
    status: 'done', attempts: 0, nextRunAt: now, createdAt: now,
  }).run()
  const r = await req('/api/distill-runs/dj1/retry', { method: 'POST' })
  expect(r.status).toBe(409)
})

test('POST /api/distill-runs/:jobId/retry 不存在的 job -> 404', async () => {
  const r = await req('/api/distill-runs/nope/retry', { method: 'POST' })
  expect(r.status).toBe(404)
})

test('POST /api/distill-runs/:jobId/abandon 标 done + 推进 session offset（spec §6）', async () => {
  // seed paused job 带 session + conversation event（3 turns）
  seedPausedJob('pj2', { sessionId: 'sess1' })
  db.insert(memoryDistillEvents).values({
    distillJobId: 'pj2', attemptIndex: 0, ts: Date.now(), kind: 'conversation',
    payload: JSON.stringify([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }]),
  }).run()
  const r = await req('/api/distill-runs/pj2/abandon', { method: 'POST' })
  expect(r.status).toBe(200)
  expect(r.body.ok).toBe(true)
  const job = db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, 'pj2')).all()[0]!
  expect(job.status).toBe('done')
  expect(job.finishedAt).not.toBeNull()
  expect(broadcastCalls.some((m: any) => m.type === 'job.abandoned')).toBe(true)
  // offset 推进到事件存档的 fullLength（3 turns）
  const off = db.select().from(memorySessionOffsets).where(eq(memorySessionOffsets.sessionId, 'sess1')).all()
  expect(off[0]?.lastTurnOffset).toBe(3)
})

test('POST /api/distill-runs/:jobId/abandon 无 session 的 job 只标 done（offset 不动）', async () => {
  seedPausedJob('pj3') // sessionId=null
  const r = await req('/api/distill-runs/pj3/abandon', { method: 'POST' })
  expect(r.status).toBe(200)
  const job = db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, 'pj3')).all()[0]!
  expect(job.status).toBe('done')
})

test('GET /api/memories/pending-review 列出 pending_review 候选（spec §6.4）', async () => {
  const c = await createCandidate(db, {
    scopeType: 'project', scopeId: '/p1', title: 'pr1', bodyMd: 'b', tags: [],
    sourceKind: 'conversation', runtime: 'claude-code', sourceCwd: '/p1', distillJobId: 'j1',
  })
  await db.update(memories).set({ status: 'pending_review' }).where(eq(memories.id, c.id)).run()
  // 另一条普通 candidate 不应返回
  await createCandidate(db, {
    scopeType: 'project', scopeId: '/p1', title: 'c2', bodyMd: 'b', tags: [],
    sourceKind: 'conversation', runtime: 'claude-code', sourceCwd: '/p1', distillJobId: 'j1',
  })
  const r = await req('/api/memories/pending-review?project=/p1')
  expect(r.status).toBe(200)
  expect(r.body.items).toHaveLength(1)
  expect(r.body.items[0].title).toBe('pr1')
})

test('GET /api/memories/pending-review 无 project 参数 -> 返回全部', async () => {
  const c1 = await createCandidate(db, {
    scopeType: 'project', scopeId: '/p1', title: 'pr1', bodyMd: 'b', tags: [],
    sourceKind: 'conversation', runtime: 'claude-code', sourceCwd: '/p1', distillJobId: 'j1',
  })
  const c2 = await createCandidate(db, {
    scopeType: 'project', scopeId: '/p2', title: 'pr2', bodyMd: 'b', tags: [],
    sourceKind: 'conversation', runtime: 'claude-code', sourceCwd: '/p2', distillJobId: 'j2',
  })
  await db.update(memories).set({ status: 'pending_review' }).where(eq(memories.id, c1.id)).run()
  await db.update(memories).set({ status: 'pending_review' }).where(eq(memories.id, c2.id)).run()
  const r = await req('/api/memories/pending-review')
  expect(r.status).toBe(200)
  expect(r.body.items).toHaveLength(2)
})

test('POST /api/memories/:id/promote 从 pending_review approve 成功（whitelist 扩展，spec §6.4）', async () => {
  const c = await createCandidate(db, {
    scopeType: 'project', scopeId: '/p1', title: 'pr1', bodyMd: 'b', tags: [],
    sourceKind: 'conversation', runtime: 'claude-code', sourceCwd: '/p1', distillJobId: 'j1',
  })
  await db.update(memories).set({ status: 'pending_review' }).where(eq(memories.id, c.id)).run()
  const r = await req(`/api/memories/${c.id}/promote`, {
    method: 'POST',
    body: JSON.stringify({ action: 'approve' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(200)
  expect(r.body.memory.status).toBe('approved')
})

test('GET /api/distill-runs 列表含 pausedStep + attempts（spec §6 UI 可见）', async () => {
  seedPausedJob('pj1')
  await saveDistillRun(db, 'pj1', {
    outcome: 'parse_error', rawOutput: null, rawCount: 0, acceptedCount: 0,
    dedupedCount: 0, filteredCount: 0, storedCount: 0, discardedCount: 0,
    durationMs: 100, errorMessage: 'bad json', rawText: '...',
  })
  // markJobPaused 写 pausedStep 到 run 行
  const { markJobPaused } = await import('@/memory/store')
  await markJobPaused(db, 'pj1', 'judge')
  const r = await req('/api/distill-runs?limit=10')
  expect(r.status).toBe(200)
  const item = r.body.items.find((x: any) => x.distillJobId === 'pj1')
  expect(item).toBeTruthy()
  expect(item.pausedStep).toBe('judge')
  expect(item.attempts).toBe(2)
})
