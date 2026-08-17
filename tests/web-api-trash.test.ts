import { test, expect } from 'bun:test'
import { bulkDelete, emptyTrash, restoreFromTrash, listTrashPage, exportMemories, importMemories as importApi, type TrashItem } from '../src/web/api'

function fakeFetch(responder: (url: string, init?: RequestInit) => Response) {
  return ((url: string, init?: RequestInit) => Promise.resolve(responder(url, init))) as any
}

test('bulkDelete posts ids', async () => {
  let captured: { url: string; body: string } | null = null
  const f = fakeFetch((url, init) => { captured = { url, body: init?.body as string }; return new Response(JSON.stringify({ deleted: 2, skipped: 0 }), { status: 200 }) })
  const r = await bulkDelete(['a', 'b'], f)
  expect(r.deleted).toBe(2)
  expect(captured!.url).toBe('/api/memories/bulk-delete')
  expect(JSON.parse(captured!.body).ids).toEqual(['a', 'b'])
})

test('exportMemories returns Blob', async () => {
  const f = fakeFetch(() => new Response('md content', { status: 200, headers: { 'content-type': 'text/markdown' } }))
  const blob = await exportMemories({ scope: 'all', format: 'markdown' }, f)
  expect(blob).toBeInstanceOf(Blob)
  expect(await blob.text()).toBe('md content')
})

test('importMemories uploads FormData with file', async () => {
  let capturedInit: RequestInit | null | undefined = null
  const f = fakeFetch((_url, init) => { capturedInit = init; return new Response(JSON.stringify({ imported: 1, skipped: 0, overwritten: 0, errors: [] }), { status: 200 }) })
  const file = new File(['content'], 'm.json', { type: 'application/json' })
  const r = await importApi(file, 'skip', f)
  expect(r.imported).toBe(1)
  expect(capturedInit!.body).toBeInstanceOf(FormData)
})
