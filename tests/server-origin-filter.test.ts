import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { eq } from 'drizzle-orm'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { createCandidate, ORIGIN_UNLABELED } from '@/memory/store'
import { ClaudeCodeAdapter } from '@/adapter/claudeCode'
import { OpencodeAdapter } from '@/adapter/opencode'
import { createApp } from '@/server'
import { memories } from '@/db/schema'
import type { MemoryStatus } from '@/memory/pure'

// 第五维 origin（出处）筛选的 server 层参数透传回归锁定。
// Spec: docs/superpowers/specs/2026-08-20-origin-filter-design.md
// Task 2：GET /api/memories?origin=... query 透传 + POST /api/memories/export
// body.filter.origin 透传，二者都走同一 MemoryListFilter（store 层 Task 1 已实现）。
// 完全照抄 valueClass 既有 server 测试模式（见 server.test.ts 四维筛选用例）。

const root = join(import.meta.dir, '.tmp-server-origin-filter')
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
  const probe = res.clone()
  return { status: res.status, body: await probe.json().catch(() => null), res }
}

async function seedMem(opts: {
  ts: number; status?: MemoryStatus
  origin?: 'user-stated' | 'user-confirmed' | 'agent-observed' | null
}) {
  const m = await createCandidate(db, {
    scopeType: 'global', scopeId: null,
    title: `[category:convention] t-${opts.ts}`, bodyMd: 'b',
    tags: [], sourceKind: 'manual', runtime: null,
    origin: opts.origin ?? null,
  })
  await db.update(memories).set({ createdAt: opts.ts, status: opts.status ?? 'candidate' })
    .where(eq(memories.id, m.id)).run()
  return m.id
}

test('GET /api/memories?limit&origin=user-stated 命中行集正确（只含 user-stated）', async () => {
  const us = await seedMem({ ts: 1000, origin: 'user-stated' })
  await seedMem({ ts: 2000, origin: 'user-confirmed' })
  await seedMem({ ts: 3000, origin: 'agent-observed' })
  const r = await req('/api/memories?limit=50&origin=user-stated')
  expect(r.status).toBe(200)
  expect(r.body.items.length).toBe(1)
  expect(r.body.items[0].id).toBe(us)
  expect(r.body.items[0].origin).toBe('user-stated')
  expect(r.body.total).toBe(1)
})

test('GET /api/memories?limit&origin=unlabeled 筛出 NULL origin 行', async () => {
  await seedMem({ ts: 1000, origin: 'user-stated' })
  const n1 = await seedMem({ ts: 2000, origin: null })
  const n2 = await seedMem({ ts: 3000, origin: null })
  const r = await req(`/api/memories?limit=50&origin=${ORIGIN_UNLABELED}`)
  expect(r.status).toBe(200)
  expect(r.body.items.length).toBe(2)
  const ids = (r.body.items as { id: string }[]).map((m) => m.id)
  expect(ids).toContain(n1)
  expect(ids).toContain(n2)
  expect(r.body.items.every((m: { origin: string | null }) => m.origin === null)).toBe(true)
  expect(r.body.total).toBe(2)
})

test('GET /api/memories?limit&origin 每个合法值各只命中本类', async () => {
  await seedMem({ ts: 1000, origin: 'user-stated' })
  await seedMem({ ts: 2000, origin: 'user-confirmed' })
  await seedMem({ ts: 3000, origin: 'agent-observed' })
  for (const v of ['user-stated', 'user-confirmed', 'agent-observed'] as const) {
    const r = await req(`/api/memories?limit=50&origin=${v}`)
    expect(r.body.items.length).toBe(1)
    expect(r.body.items[0].origin).toBe(v)
  }
})

test('GET /api/memories?limit&origin 与 status AND 共存', async () => {
  await seedMem({ ts: 1000, status: 'candidate', origin: 'user-stated' })
  await seedMem({ ts: 2000, status: 'rejected', origin: 'user-stated' })
  await seedMem({ ts: 3000, status: 'candidate', origin: 'agent-observed' })
  const r = await req('/api/memories?status=candidate&limit=50&origin=user-stated')
  expect(r.body.items.length).toBe(1)
  expect(r.body.items[0].status).toBe('candidate')
  expect(r.body.items[0].origin).toBe('user-stated')
  expect(r.body.total).toBe(1)
})

test('GET /api/memories?limit&origin=非法值 宽松忽略不 400（等价不筛）', async () => {
  await seedMem({ ts: 1000, origin: 'user-stated' })
  await seedMem({ ts: 2000, origin: null })
  const r = await req('/api/memories?limit=50&origin=bogus')
  expect(r.status).toBe(200)
  expect(r.body.items.length).toBe(2) // 非法值被 store 白名单忽略，等价不筛
})

test('GET /api/memories 不带 limit -> origin 不生效（旧全量形状不筛选，与四维一致）', async () => {
  await seedMem({ ts: 1000, origin: 'user-stated' })
  await seedMem({ ts: 2000, origin: 'user-confirmed' })
  const r = await req('/api/memories?origin=user-stated')
  expect(r.status).toBe(200)
  expect(r.body.items.length).toBe(2) // 无 limit 分支不读 filter，等价旧全量
})

test('POST /api/memories/export scope=filter body.filter.origin 圈定导出行集', async () => {
  const us = await seedMem({ ts: 1000, origin: 'user-stated' })
  await seedMem({ ts: 2000, origin: 'user-confirmed' })
  await seedMem({ ts: 3000, origin: 'agent-observed' })
  const { status, body } = await req('/api/memories/export', {
    method: 'POST',
    body: JSON.stringify({ scope: 'filter', filter: { origin: 'user-stated' }, format: 'json' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(status).toBe(200)
  const ids = (body.memories as { id: string }[]).map((m) => m.id)
  expect(ids).toEqual([us])
  // 不混入其它 origin
  expect((body.memories as { origin: string | null }[]).every((m) => m.origin === 'user-stated')).toBe(true)
})

test('POST /api/memories/export scope=filter body.filter.origin=unlabeled 只导 NULL 行', async () => {
  await seedMem({ ts: 1000, origin: 'user-stated' })
  const n1 = await seedMem({ ts: 2000, origin: null })
  const n2 = await seedMem({ ts: 3000, origin: null })
  const { status, body } = await req('/api/memories/export', {
    method: 'POST',
    body: JSON.stringify({ scope: 'filter', filter: { origin: ORIGIN_UNLABELED }, format: 'json' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(status).toBe(200)
  const ids = (body.memories as { id: string }[]).map((m) => m.id).sort()
  expect(ids).toEqual([n1, n2].sort())
  expect((body.memories as { origin: string | null }[]).every((m) => m.origin === null)).toBe(true)
})

test('POST /api/memories/export scope=filter body.filter.origin 与其它维度 AND 共存', async () => {
  // origin=user-stated × status=candidate 仅命中一条
  await seedMem({ ts: 1000, status: 'candidate', origin: 'user-stated' })
  await seedMem({ ts: 2000, status: 'rejected', origin: 'user-stated' })
  await seedMem({ ts: 3000, status: 'candidate', origin: 'agent-observed' })
  const { status, body } = await req('/api/memories/export', {
    method: 'POST',
    body: JSON.stringify({
      scope: 'filter', statuses: ['candidate'], filter: { origin: 'user-stated' }, format: 'json',
    }),
    headers: { 'content-type': 'application/json' },
  })
  expect(status).toBe(200)
  expect(body.memories.length).toBe(1)
  expect(body.memories[0].origin).toBe('user-stated')
  expect(body.memories[0].status).toBe('candidate')
})
