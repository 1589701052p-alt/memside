import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { memories, memoryDistillJobs } from '@/db/schema'
import type { MemoryStatus } from '@/memory/pure'
import type { ValueClass } from '@/memory/valueFilter'
import {
  createCandidate, listMemoriesPage, listDiscardsPage, logDiscards,
  VALUE_CLASS_UNEVALUATED,
} from '@/memory/store'

// 回归锁定：四维服务端筛选 + total 计数（spec 2026-08-11-web-memory-filters §4.1）。
// EBUSY-safe 模式同 store-page.test.ts（每 test 独立子目录）。
const root = join(import.meta.dir, '.tmp-store-filter')
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

test('filter.sourceCwd 精确匹配 + total', async () => {
  await seedMem({ ts: 1000, sourceCwd: 'C:/p/a' })
  await seedMem({ ts: 2000, sourceCwd: 'C:/p/b' })
  await seedMem({ ts: 3000, sourceCwd: null })
  const page = await listMemoriesPage(db, { statuses: [], limit: 50, filter: { sourceCwd: 'C:/p/a' } })
  expect(page.items.length).toBe(1)
  expect(page.items[0]!.sourceCwd).toBe('C:/p/a')
  expect(page.total).toBe(1)
})

test('filter.subjectSlug 精确匹配', async () => {
  await seedMem({ ts: 1000, slug: 'refund-policy' })
  await seedMem({ ts: 2000, slug: 'other' })
  await seedMem({ ts: 3000, slug: null })
  const page = await listMemoriesPage(db, { statuses: [], limit: 50, filter: { subjectSlug: 'refund-policy' } })
  expect(page.items.length).toBe(1)
  expect(page.items[0]!.subjectSlug).toBe('refund-policy')
})

test('filter.category: 带闭括号精确子串，不误中前缀相似值', async () => {
  await seedMem({ ts: 1000, title: '[category:arch] 短分类' })
  await seedMem({ ts: 2000, title: '[category:architecture] 长分类' })
  const page = await listMemoriesPage(db, { statuses: [], limit: 50, filter: { category: 'arch' } })
  expect(page.items.length).toBe(1)
  expect(page.items[0]!.title).toBe('[category:arch] 短分类')
})

test('filter.valueClass: 合法值精确 + unevaluated 哨兵命中 NULL 行', async () => {
  await seedMem({ ts: 1000, valueClass: 'decision' })
  await seedMem({ ts: 2000, valueClass: null })
  await seedMem({ ts: 3000, valueClass: 'trap' })
  const decided = await listMemoriesPage(db, { statuses: [], limit: 50, filter: { valueClass: 'decision' } })
  expect(decided.items.length).toBe(1)
  const uneval = await listMemoriesPage(db, { statuses: [], limit: 50, filter: { valueClass: VALUE_CLASS_UNEVALUATED } })
  expect(uneval.items.length).toBe(1)
  expect(uneval.items[0]!.valueClass).toBeNull()
  expect(uneval.total).toBe(1)
})

test('filter.valueClass 非法值 -> 条件忽略（返回全量）', async () => {
  await seedMem({ ts: 1000, valueClass: 'decision' })
  await seedMem({ ts: 2000, valueClass: null })
  const page = await listMemoriesPage(db, { statuses: [], limit: 50, filter: { valueClass: 'not-a-class' } })
  expect(page.items.length).toBe(2)
})

test('多维 AND + 与 status 条件共存', async () => {
  await seedMem({ ts: 1000, status: 'candidate', sourceCwd: 'C:/p/a', valueClass: 'decision' })
  await seedMem({ ts: 2000, status: 'rejected', sourceCwd: 'C:/p/a', valueClass: 'decision' })
  await seedMem({ ts: 3000, status: 'candidate', sourceCwd: 'C:/p/b', valueClass: 'decision' })
  const page = await listMemoriesPage(db, {
    statuses: ['candidate'], limit: 50, filter: { sourceCwd: 'C:/p/a', valueClass: 'decision' },
  })
  expect(page.items.length).toBe(1)
  expect(page.total).toBe(1)
})

test('无匹配 -> 空页 hasMore=false total=0', async () => {
  await seedMem({ ts: 1000, sourceCwd: 'C:/p/a' })
  const page = await listMemoriesPage(db, { statuses: [], limit: 50, filter: { sourceCwd: 'C:/nowhere' } })
  expect(page.items).toEqual([])
  expect(page.hasMore).toBe(false)
  expect(page.nextCursor).toBeNull()
  expect(page.total).toBe(0)
})

test('筛选与游标共存：翻页仍只含匹配行', async () => {
  for (let i = 0; i < 5; i++) {
    await seedMem({ ts: 1000 + i, sourceCwd: i % 2 === 0 ? 'C:/even' : 'C:/odd' })
  }
  const p1 = await listMemoriesPage(db, { statuses: [], limit: 2, filter: { sourceCwd: 'C:/even' } })
  expect(p1.items.length).toBe(2)
  expect(p1.items.every((m) => m.sourceCwd === 'C:/even')).toBe(true)
  expect(p1.hasMore).toBe(true)
  const p2 = await listMemoriesPage(db, { statuses: [], limit: 2, before: p1.nextCursor!, filter: { sourceCwd: 'C:/even' } })
  expect(p2.items.length).toBe(1)
  expect(p2.items[0]!.sourceCwd).toBe('C:/even')
  expect(p2.hasMore).toBe(false)
})

test('total = 同条件 COUNT，不随翻页变化', async () => {
  for (let i = 0; i < 3; i++) await seedMem({ ts: 1000 + i, sourceCwd: 'C:/x' })
  await seedMem({ ts: 9000, sourceCwd: 'C:/y' })
  const p1 = await listMemoriesPage(db, { statuses: [], limit: 2, filter: { sourceCwd: 'C:/x' } })
  expect(p1.total).toBe(3)
  const p2 = await listMemoriesPage(db, { statuses: [], limit: 2, before: p1.nextCursor!, filter: { sourceCwd: 'C:/x' } })
  expect(p2.total).toBe(3)
})

test('无 filter 回归锚：不传 filter 行为不变（total = 全表计数）', async () => {
  await seedMem({ ts: 1000 })
  const page = await listMemoriesPage(db, { statuses: [], limit: 50 })
  expect(page.items.length).toBe(1)
  expect(page.hasMore).toBe(false)
  expect(page.total).toBe(1)
})

test('listDiscardsPage filter: sourceCwd + category + AND', async () => {
  db.insert(memoryDistillJobs).values({
    id: 'job-f', debounceKey: 'k', sourceEventId: 's', runtime: 'claude-code',
    cwd: '/r', status: 'done', attempts: 0, nextRunAt: 0, createdAt: 0,
  }).run()
  await logDiscards(db, 'job-f', [
    { title: '[category:trap] 坑A', bodyMd: 'b', reason: 'fleeting' as const, scopeType: 'project' as const, scopeId: 'C:/p/a', sourceCwd: 'C:/p/a', runtime: null, sourceKind: 'conversation' as const },
    { title: '[category:convention] 约定B', bodyMd: 'b', reason: 'derivable' as const, scopeType: 'project' as const, scopeId: 'C:/p/a', sourceCwd: 'C:/p/a', runtime: null, sourceKind: 'conversation' as const },
    { title: '[category:trap] 坑C', bodyMd: 'b', reason: 'fleeting' as const, scopeType: 'global' as const, scopeId: null, sourceCwd: 'C:/p/b', runtime: null, sourceKind: 'conversation' as const },
  ])
  const byProject = await listDiscardsPage(db, { limit: 50, filter: { sourceCwd: 'C:/p/a' } })
  expect(byProject.items.length).toBe(2)
  expect(byProject.total).toBe(2)
  const byCat = await listDiscardsPage(db, { limit: 50, filter: { category: 'trap' } })
  expect(byCat.items.length).toBe(2)
  const both = await listDiscardsPage(db, { limit: 50, filter: { sourceCwd: 'C:/p/a', category: 'trap' } })
  expect(both.items.length).toBe(1)
  expect(both.items[0]!.title).toBe('[category:trap] 坑A')
})