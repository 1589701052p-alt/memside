import { test, expect } from 'bun:test'
import { listMemories, promoteMemory, patchMemory, getSourceInput, listDiscards, restoreMemory, archiveMemory, unarchiveMemory, promoteDiscard } from '@/web/api'

// Locks the web API client contract (Task 15). The React component itself is
// not unit-tested; this client is the testable seam — a `fetchFn` param lets
// tests inject a mock fetch instead of hitting the network. If the URL shape,
// HTTP method, or request body drifts from what server.ts (Task 13) expects,
// one of these two tests goes red.

test('listMemories calls GET /api/memories and returns items', async () => {
  let called = ''
  const fetchFn = (async (url: string) => {
    called = url
    return new Response(JSON.stringify({ items: [{ id: '1', title: 't', status: 'candidate' }] }), { status: 200 })
  }) as any
  const items = await listMemories(fetchFn)
  expect(called).toBe('/api/memories')
  expect(items.length).toBe(1)
})

test('promoteMemory POSTs to /api/memories/:id/promote', async () => {
  let captured: { url: string; method: string; body: string } | null = null
  const fetchFn = (async (url: string, init: any) => {
    captured = { url, method: init.method, body: init.body }
    return new Response(JSON.stringify({ memory: { id: '1', status: 'approved' } }), { status: 200 })
  }) as any
  await promoteMemory('1', { action: 'approve' }, fetchFn)
  expect(captured!.url).toBe('/api/memories/1/promote')
  expect(captured!.method).toBe('POST')
  expect(captured!.body).toContain('approve')
})

test('patchMemory PATCHes /api/memories/:id with scopeType in body', async () => {
  let captured: { url: string; method: string; body: string } | null = null
  const fetchFn = (async (url: string, init: any) => {
    captured = { url, method: init.method, body: init.body }
    return new Response(JSON.stringify({ memory: { id: '1', status: 'candidate' }, changedFields: ['scopeType'] }), { status: 200 })
  }) as any
  await patchMemory('1', { scopeType: 'global' }, fetchFn)
  expect(captured!.url).toBe('/api/memories/1')
  expect(captured!.method).toBe('PATCH')
  expect(captured!.body).toContain('scopeType')
})

test('patchMemory throws on non-OK response with server error message', async () => {
  const fetchFn = (async () =>
    new Response(JSON.stringify({ error: 'project scope requires a sourceCwd' }), { status: 409 })) as any
  await expect(patchMemory('1', { scopeType: 'project' }, fetchFn)).rejects.toThrow('sourceCwd')
})

test('getSourceInput calls GET /api/memories/:id/source-input', async () => {
  let captured: { url: string; method: string } | null = null
  const fetchFn = (async (url: string, init: any) => {
    captured = { url, method: init?.method ?? 'GET' }
    return new Response(JSON.stringify({ available: true, title: 't', turns: [{ role: 'user', content: 'x' }], turnCount: 1, charCount: 1 }), { status: 200 })
  }) as any
  const data = await getSourceInput('42', fetchFn)
  expect(captured!.url).toBe('/api/memories/42/source-input')
  expect(captured!.method).toBe('GET')
  expect(data.available).toBe(true)
  expect(data.turns!.length).toBe(1)
})

// --- Task 7: memory audit views client (status filter + discards/restore/archive/promote) ---
// Locks the web API client contract for the audit-views endpoints (Task 6
// server). listMemories now takes an optional status query; the five new
// wrappers hit the discard/restore/archive/promote routes. If the URL shape or
// HTTP method drifts from server.ts, one of these goes red.

test('listMemories passes status query when provided', async () => {
  let called = ''
  const fetchFn = (async (url: string) => { called = url; return new Response(JSON.stringify({ items: [] }), { status: 200 }) }) as any
  await listMemories(fetchFn, 'approved,archived')
  // encodeURIComponent encodes the comma -> %2C; Hono decodes it server-side
  // before splitting on ',', so both forms work, but the client emits encoded.
  expect(called).toBe('/api/memories?status=approved%2Carchived')
})

test('listMemories omits status when undefined', async () => {
  let called = ''
  const fetchFn = (async (url: string) => { called = url; return new Response(JSON.stringify({ items: [] }), { status: 200 }) }) as any
  await listMemories(fetchFn)
  expect(called).toBe('/api/memories')
})

test('listDiscards calls GET /api/discards', async () => {
  let called = ''
  const fetchFn = (async (url: string) => { called = url; return new Response(JSON.stringify({ items: [{ id: 'd1', title: 't', reason: 'taming' }] }), { status: 200 }) }) as any
  const items = await listDiscards(fetchFn)
  expect(called).toBe('/api/discards')
  expect(items.length).toBe(1)
})

test('restoreMemory POSTs /api/memories/:id/restore', async () => {
  let captured: { url: string; method: string } | null = null
  const fetchFn = (async (url: string, init: any) => { captured = { url, method: init.method }; return new Response(JSON.stringify({ memory: { id: '1', status: 'candidate' } }), { status: 200 }) }) as any
  await restoreMemory('1', fetchFn)
  expect(captured!.url).toBe('/api/memories/1/restore')
  expect(captured!.method).toBe('POST')
})

test('archiveMemory + unarchiveMemory POST correct paths', async () => {
  const seen: string[] = []
  const fetchFn = (async (url: string, init: any) => { seen.push(`${init.method} ${url}`); return new Response(JSON.stringify({ memory: { id: '1' } }), { status: 200 }) }) as any
  await archiveMemory('1', fetchFn)
  await unarchiveMemory('1', fetchFn)
  expect(seen).toContain('POST /api/memories/1/archive')
  expect(seen).toContain('POST /api/memories/1/unarchive')
})

test('promoteDiscard POSTs /api/discards/:id/promote', async () => {
  let captured: { url: string; method: string } | null = null
  const fetchFn = (async (url: string, init: any) => { captured = { url, method: init.method }; return new Response(JSON.stringify({ memory: { id: 'm1', status: 'candidate' } }), { status: 200 }) }) as any
  await promoteDiscard('d1', fetchFn)
  expect(captured!.url).toBe('/api/discards/d1/promote')
  expect(captured!.method).toBe('POST')
})
