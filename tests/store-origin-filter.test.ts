import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { memories, memoryDistillJobs } from '@/db/schema'
import type { MemoryStatus } from '@/memory/pure'
import {
  createCandidate, listMemoriesPage, listDiscardsPage, logDiscards,
  listFacets, ORIGIN_UNLABELED, PROTECTED_ORIGINS, type FacetScope,
} from '@/memory/store'

// 第五维 origin（出处）筛选 + facets 的 store 层回归锁定。
// Spec: docs/superpowers/specs/2026-08-20-origin-filter-design.md
// 完全照抄 valueClass 既有模式（VALUE_CLASS_UNEVALUATED 哨兵 + PROTECTED_VALUE_CLASSES 白名单
// 宽松策略）：合法三值 eq / 哨兵 isNull / 其余忽略；memories scope groupBy origin（NULL →
// 哨兵桶）；discards scope origins: []。
const root = join(import.meta.dir, '.tmp-store-origin-filter')
let dir = ''
let db: ReturnType<typeof openDb>

beforeAll(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
})
beforeEach(() => {
  dir = join(root, Math.random().toString(36).slice(2))
  mkdirSync(dir, { recursive: true })
  db = openDb(join(dir, 't.db'))
})
afterEach(() => { db.$client.close() })

async function seedMem(opts: {
  ts: number; status?: MemoryStatus; origin?: 'user-stated' | 'user-confirmed' | 'agent-observed' | null
  sourceCwd?: string | null
}) {
  const m = await createCandidate(db, {
    scopeType: 'global', scopeId: null,
    title: `[category:convention] t-${opts.ts}`, bodyMd: 'b',
    tags: [], sourceKind: 'manual', runtime: null,
    origin: opts.origin ?? null, sourceCwd: opts.sourceCwd ?? null,
  })
  await db.update(memories).set({ createdAt: opts.ts, status: opts.status ?? 'candidate' })
    .where(eq(memories.id, m.id)).run()
  return m.id
}

const CANDIDATE: FacetScope = { kind: 'memories', statuses: ['candidate'] }
const DISCARDS: FacetScope = { kind: 'discards' }

test('PROTECTED_ORIGINS 导出三个合法值（与 schema enum 对齐）', () => {
  expect(PROTECTED_ORIGINS).toEqual(['user-stated', 'user-confirmed', 'agent-observed'])
  expect(ORIGIN_UNLABELED).toBe('unlabeled')
  expect(PROTECTED_ORIGINS).not.toContain(ORIGIN_UNLABELED)
})

test('filter.origin: 合法值精确命中（user-stated 只筛出 user-stated 行）', async () => {
  await seedMem({ ts: 1000, origin: 'user-stated' })
  await seedMem({ ts: 2000, origin: 'user-confirmed' })
  await seedMem({ ts: 3000, origin: 'agent-observed' })
  await seedMem({ ts: 4000, origin: null })
  const page = await listMemoriesPage(db, { statuses: [], limit: 50, filter: { origin: 'user-stated' } })
  expect(page.items.length).toBe(1)
  expect(page.items[0]!.origin).toBe('user-stated')
  expect(page.total).toBe(1)
})

test('filter.origin: 每个合法值各只命中本类', async () => {
  await seedMem({ ts: 1000, origin: 'user-stated' })
  await seedMem({ ts: 2000, origin: 'user-confirmed' })
  await seedMem({ ts: 3000, origin: 'agent-observed' })
  for (const v of ['user-stated', 'user-confirmed', 'agent-observed'] as const) {
    const page = await listMemoriesPage(db, { statuses: [], limit: 50, filter: { origin: v } })
    expect(page.items.length).toBe(1)
    expect(page.items[0]!.origin).toBe(v)
  }
})

test('filter.origin: 哨兵 unlabeled 筛出 NULL 行，不含任何已标注行', async () => {
  await seedMem({ ts: 1000, origin: 'user-stated' })
  await seedMem({ ts: 2000, origin: 'user-confirmed' })
  await seedMem({ ts: 3000, origin: null })
  await seedMem({ ts: 4000, origin: null })
  const page = await listMemoriesPage(db, { statuses: [], limit: 50, filter: { origin: ORIGIN_UNLABELED } })
  expect(page.items.length).toBe(2)
  expect(page.items.every((m) => m.origin === null)).toBe(true)
  expect(page.total).toBe(2)
})

test('filter.origin: 非法值忽略条件（等价不筛，返回全量）', async () => {
  await seedMem({ ts: 1000, origin: 'user-stated' })
  await seedMem({ ts: 2000, origin: null })
  const page = await listMemoriesPage(db, { statuses: [], limit: 50, filter: { origin: 'foo' } })
  expect(page.items.length).toBe(2)
})

test('filter.origin 与 status 条件 AND 共存', async () => {
  await seedMem({ ts: 1000, status: 'candidate', origin: 'user-stated' })
  await seedMem({ ts: 2000, status: 'rejected', origin: 'user-stated' })
  await seedMem({ ts: 3000, status: 'candidate', origin: 'agent-observed' })
  const page = await listMemoriesPage(db, {
    statuses: ['candidate'], limit: 50, filter: { origin: 'user-stated' },
  })
  expect(page.items.length).toBe(1)
  expect(page.total).toBe(1)
})

test('listFacets memories scope: origins 计数含 NULL→哨兵桶、count 降序', async () => {
  await seedMem({ ts: 1000, origin: 'user-stated' })
  await seedMem({ ts: 2000, origin: 'user-stated' })
  await seedMem({ ts: 3000, origin: 'user-confirmed' })
  await seedMem({ ts: 4000, origin: null })
  await seedMem({ ts: 5000, origin: null })
  await seedMem({ ts: 6000, origin: null })
  const f = await listFacets(db, CANDIDATE)
  expect(f.origins).toEqual([
    { value: ORIGIN_UNLABELED, count: 3 },            // 3 > 2 > 1
    { value: 'user-stated', count: 2 },
    { value: 'user-confirmed', count: 1 },
  ])
})

test('listFacets memories scope: 同 count 按 value 字母序', async () => {
  await seedMem({ ts: 1000, origin: 'user-stated' })
  await seedMem({ ts: 2000, origin: 'user-confirmed' })
  await seedMem({ ts: 3000, origin: 'agent-observed' })
  const f = await listFacets(db, CANDIDATE)
  expect(f.origins).toEqual([
    { value: 'agent-observed', count: 1 },   // 同 count=1 字母序
    { value: 'user-confirmed', count: 1 },
    { value: 'user-stated', count: 1 },
  ])
})

test('listFacets memories scope: 全 NULL 只出哨兵桶', async () => {
  await seedMem({ ts: 1000, origin: null })
  await seedMem({ ts: 2000, origin: null })
  const f = await listFacets(db, CANDIDATE)
  expect(f.origins).toEqual([{ value: ORIGIN_UNLABELED, count: 2 }])
})

test('listFacets memories scope: 只数 scope statuses 内的行', async () => {
  await seedMem({ ts: 1000, origin: 'user-stated', status: 'candidate' })
  await seedMem({ ts: 2000, origin: 'user-stated', status: 'rejected' })
  const REJECTED: FacetScope = { kind: 'memories', statuses: ['rejected'] }
  const f = await listFacets(db, REJECTED)
  expect(f.origins).toEqual([{ value: 'user-stated', count: 1 }])
})

test('listFacets discards scope: origins 恒空（无 origin 列）', async () => {
  db.insert(memoryDistillJobs).values({
    id: 'job-f', debounceKey: 'k', sourceEventId: 's', runtime: 'claude-code',
    cwd: '/r', status: 'done', attempts: 0, nextRunAt: 0, createdAt: 0,
  }).run()
  await logDiscards(db, 'job-f', [
    { title: '[category:trap] 坑A', bodyMd: 'b', reason: 'fleeting' as const, scopeType: 'project' as const, scopeId: 'C:/p/a', sourceCwd: 'C:/p/a', runtime: null, sourceKind: 'conversation' as const },
  ])
  const f = await listFacets(db, DISCARDS)
  expect(f.origins).toEqual([])
})

test('空表 -> origins 空数组（任何 scope）', async () => {
  expect((await listFacets(db, CANDIDATE)).origins).toEqual([])
  expect((await listFacets(db, DISCARDS)).origins).toEqual([])
})

test('listDiscardsPage filter.origin 被静默忽略（无 origin 列，不崩不错筛）', async () => {
  db.insert(memoryDistillJobs).values({
    id: 'job-f', debounceKey: 'k', sourceEventId: 's', runtime: 'claude-code',
    cwd: '/r', status: 'done', attempts: 0, nextRunAt: 0, createdAt: 0,
  }).run()
  await logDiscards(db, 'job-f', [
    { title: '[category:trap] 坑A', bodyMd: 'b', reason: 'fleeting' as const, scopeType: 'project' as const, scopeId: 'C:/p/a', sourceCwd: 'C:/p/a', runtime: null, sourceKind: 'conversation' as const },
  ])
  const page = await listDiscardsPage(db, { limit: 50, filter: { origin: 'user-stated' } })
  expect(page.items.length).toBe(1) // origin 条件不生效，等价全量
})
