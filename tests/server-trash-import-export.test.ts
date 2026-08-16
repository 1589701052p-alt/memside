import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { createCandidate, promoteCandidate } from '@/memory/store'
import { ClaudeCodeAdapter } from '@/adapter/claudeCode'
import { OpencodeAdapter } from '@/adapter/opencode'
import { createApp } from '@/server'
import { serializeMemoriesJson } from '@/memory/exchange'
import type { Memory } from '@/memory/store'

const root = join(import.meta.dir, '.tmp-server-trash')
let dir = ''
let db: ReturnType<typeof openDb>
let app: ReturnType<typeof createApp>
let broadcastCalls: unknown[]

beforeAll(() => { rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true }) })
beforeEach(() => {
  dir = join(root, Math.random().toString(36).slice(2)); mkdirSync(dir, { recursive: true })
  db = openDb(join(dir, 't.db'))
  broadcastCalls = []
  app = createApp({ db, adapter: new ClaudeCodeAdapter(db), opencodeAdapter: new OpencodeAdapter(db),
    enqueueDistillJob: async () => ({ jobId: 'j', nextRunAt: 0 }), broadcast: (m) => broadcastCalls.push(m) })
})
afterEach(() => { db.$client.close() })

async function req(path: string, init?: RequestInit) {
  const res = await app.fetch(new Request(`http://x${path}`, init))
  // clone before reading json so callers needing res.text()/res.headers stay usable
  const probe = res.clone()
  return { status: res.status, body: await probe.json().catch(() => null), res }
}

async function mkCandidate() {
  return createCandidate(db, { scopeType: 'global', scopeId: null, title: '[category:convention] t', bodyMd: 'b', tags: ['x'], sourceKind: 'manual', runtime: null })
}
function mkMemory(id: string): Memory {
  return { id, scopeType: 'global', scopeId: null, runtime: null, title: '[category:c] T', bodyMd: 'b', tags: [], status: 'approved', sourceKind: 'manual', sourceCwd: null, sourceEventId: null, distillJobId: null, distillAction: null, supersedesId: null, supersededById: null, approvedAt: 1, createdAt: 2, version: 1, valueClass: 'convention', subjectSlug: null, origin: 'user-stated', evidence: 'e' }
}

test('POST /api/memories/bulk-delete 删 memory + broadcast', async () => {
  const a = await mkCandidate()
  const { status, body } = await req('/api/memories/bulk-delete', { method: 'POST', body: JSON.stringify({ ids: [a.id] }), headers: { 'content-type': 'application/json' } })
  expect(status).toBe(200)
  expect(body.deleted).toBe(1)
  expect(broadcastCalls.some((m) => (m as any).type === 'memories.bulk-deleted')).toBe(true)
})

test('POST /api/memories/bulk-delete 空 ids 400', async () => {
  const { status } = await req('/api/memories/bulk-delete', { method: 'POST', body: JSON.stringify({ ids: [] }), headers: { 'content-type': 'application/json' } })
  expect(status).toBe(400)
})

test('GET /api/trash 分页返回', async () => {
  const a = await mkCandidate()
  await req('/api/memories/bulk-delete', { method: 'POST', body: JSON.stringify({ ids: [a.id] }), headers: { 'content-type': 'application/json' } })
  const { status, body } = await req('/api/trash?limit=20')
  expect(status).toBe(200)
  expect(body.items.length).toBe(1)
  expect(body.total).toBe(1)
})

test('POST /api/trash/:id/restore 恢复 + memory 状态保留', async () => {
  const a = await mkCandidate(); await promoteCandidate(db, a.id, { action: 'approve' })
  await req('/api/memories/bulk-delete', { method: 'POST', body: JSON.stringify({ ids: [a.id] }), headers: { 'content-type': 'application/json' } })
  const trash = (await req('/api/trash?limit=20')).body.items[0]
  const { status, body } = await req(`/api/trash/${trash.id}/restore`, { method: 'POST' })
  expect(status).toBe(200)
  expect(body.memory.status).toBe('approved')
  expect(broadcastCalls.some((m) => (m as any).type === 'memory.restored')).toBe(true)
})

test('POST /api/trash/empty 清空', async () => {
  const a = await mkCandidate()
  await req('/api/memories/bulk-delete', { method: 'POST', body: JSON.stringify({ ids: [a.id] }), headers: { 'content-type': 'application/json' } })
  const { status, body } = await req('/api/trash/empty', { method: 'POST' })
  expect(status).toBe(200)
  expect(body.emptied).toBe(1)
})

test('POST /api/memories/export JSON envelope', async () => {
  const a = await mkCandidate()
  const { status, body } = await req('/api/memories/export', { method: 'POST', body: JSON.stringify({ scope: 'all', format: 'json' }), headers: { 'content-type': 'application/json' } })
  expect(status).toBe(200)
  expect(body.format).toBe('memside-memories')
  expect(body.memories.length).toBe(1)
})

test('POST /api/memories/export markdown Content-Disposition', async () => {
  await mkCandidate()
  const { status, res } = await req('/api/memories/export', { method: 'POST', body: JSON.stringify({ scope: 'all', format: 'markdown' }), headers: { 'content-type': 'application/json' } })
  expect(status).toBe(200)
  expect(res.headers.get('content-disposition')).toContain('attachment')
  const text = await res.text()
  expect(text).toContain('# memside 记忆导出')
})

test('POST /api/memories/export scope=filter + statuses 只导出匹配行（非全表）', async () => {
  // 一条 approved + 一条 candidate；scope=filter+statuses=['approved'] 应只返
  // approved 行，锁定 scope:'filter' 不再静默导出全表（spec §导出三档作用域）。
  const cand = await mkCandidate()
  const appr = await mkCandidate(); await promoteCandidate(db, appr.id, { action: 'approve' })
  const { status, body } = await req('/api/memories/export', { method: 'POST', body: JSON.stringify({ scope: 'filter', statuses: ['approved'], format: 'json' }), headers: { 'content-type': 'application/json' } })
  expect(status).toBe(200)
  const ids = (body.memories as { id: string }[]).map((m) => m.id)
  expect(ids).toContain(appr.id)
  expect(ids).not.toContain(cand.id)
})

test('POST /api/memories/import JSON 高保真', async () => {
  const env = serializeMemoriesJson([mkMemory('IMP1')], Date.now())
  const form = new FormData(); form.append('file', new Blob([env]), 'm.json')
  const { status, body } = await req('/api/memories/import?conflict=newid', { method: 'POST', body: form })
  expect(status).toBe(200)
  expect(body.imported).toBe(1)
  expect(broadcastCalls.some((m) => (m as any).type === 'memories.imported')).toBe(true)
})

test('POST /api/memories/import markdown 低保真成 candidate', async () => {
  const md = `# memside 记忆导出\n\n---\n\n## [category:c] X\n\n- **范围**: global\n\n正文\n`
  const form = new FormData(); form.append('file', new Blob([md]), 'm.md')
  const { status, body } = await req('/api/memories/import?conflict=newid', { method: 'POST', body: form })
  expect(status).toBe(200)
  expect(body.imported).toBe(1)
})

test('POST /api/memories/import 超 10000 条 400', async () => {
  const many = Array.from({ length: 10001 }, (_, i) => mkMemory(`I${i}`))
  const env = serializeMemoriesJson(many, Date.now())
  const form = new FormData(); form.append('file', new Blob([env]), 'big.json')
  const { status } = await req('/api/memories/import?conflict=newid', { method: 'POST', body: form })
  expect(status).toBe(400)
})
