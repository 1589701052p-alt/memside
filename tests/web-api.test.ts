import { test, expect } from 'bun:test'
import { listMemories, promoteMemory } from '@/web/api'

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
