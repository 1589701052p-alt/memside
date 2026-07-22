import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { createCandidate, promoteCandidate } from '@/memory/store'
import { ClaudeCodeAdapter } from '@/adapter/claudeCode'
import { createApp } from '@/server'

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
let enqueueCalls: { sourceEventId: string; runtime: string; cwd: string; debounceKey: string }[]
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

test('collector hook accepts event and acks 202', async () => {
  const r = await req('/hooks/claude/Stop', {
    method: 'POST',
    body: JSON.stringify({ sourceEventId: 'e1', cwd: '/r', transcript: [{ role: 'user', content: 'hi' }] }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(202)
  // Brief's baseline assertion (fixed: field is `queue`, not `_queue`).
  // This is weak by itself - the enqueue assertion below is the real check.
  expect((adapter as any).queue.length).toBe(1)
  // Stronger than the brief's baseline: verify the fire-and-forget enqueue was
  // actually called with the hook's payload. The mock records calls synchronously
  // at call-time (before the async return), so this is deterministic even though
  // the handler does `void` (not `await`) on enqueue - the <50ms ack contract.
  expect(enqueueCalls.length).toBe(1)
  expect(enqueueCalls[0]).toMatchObject({
    sourceEventId: 'e1',
    runtime: 'claude-code',
    cwd: '/r',
    debounceKey: '/r:Stop',
  })
  // collector broadcasts a capture event for WS subscribers
  expect(broadcastCalls.length).toBeGreaterThanOrEqual(1)
})

test('collector PostToolUse marks sourceKind error', async () => {
  // PostToolUse events carry error signals; the collector must tag them
  // sourceKind='error' so the distiller routes to the error-signal prompt path.
  const r = await req('/hooks/claude/PostToolUse', {
    method: 'POST',
    body: JSON.stringify({ sourceEventId: 'e2', cwd: '/r', transcript: [{ role: 'tool', content: 'err', isError: true }] }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(202)
  const queued = (adapter as any).queue as Array<{ sourceKind: string }>
  expect(queued[0].sourceKind).toBe('error')
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
