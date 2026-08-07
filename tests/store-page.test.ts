import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { memories } from '@/db/schema'
import type { MemoryStatus } from '@/memory/pure'
import type { ValueClass } from '@/memory/valueFilter'
import {
  createCandidate, clampPageLimit, listMemoriesPage,
  MEMORY_PAGE_DEFAULT_LIMIT, MEMORY_PAGE_MAX_LIMIT,
} from '@/memory/store'

// 回归锁定：五 tab 无限滚动分页（spec 2026-08-07 §store）。
// 游标复合键 (createdAt, id) 保证同毫秒批量插入翻页不重不漏。
// EBUSY-safe 模式同 store-crud.test.ts（每 test 独立子目录）。
const root = join(import.meta.dir, '.tmp-store-page')
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

/** 造一条 candidate 并把 createdAt 改成指定值（ULID 按创建序递增）。 */
async function seedMemory(createdAt: number, status: MemoryStatus = 'candidate', valueClass: ValueClass | null = null) {
  const m = await createCandidate(db, {
    scopeType: 'global', scopeId: null, title: `t-${createdAt}`, bodyMd: 'b',
    tags: [], sourceKind: 'manual', runtime: null, valueClass,
  })
  await db.update(memories).set({ createdAt, status }).where(eq(memories.id, m.id)).run()
  return m.id
}

test('clampPageLimit: undefined/NaN -> 50, 0 -> 1, 9999 -> 200', () => {
  expect(clampPageLimit(undefined)).toBe(MEMORY_PAGE_DEFAULT_LIMIT)
  expect(clampPageLimit(NaN)).toBe(MEMORY_PAGE_DEFAULT_LIMIT)
  expect(clampPageLimit(0)).toBe(1)
  expect(clampPageLimit(9999)).toBe(MEMORY_PAGE_MAX_LIMIT)
  expect(MEMORY_PAGE_DEFAULT_LIMIT).toBe(50)
  expect(MEMORY_PAGE_MAX_LIMIT).toBe(200)
})

test('listMemoriesPage: 分页边界 hasMore/nextCursor 翻页不重不漏', async () => {
  for (const ts of [1000, 2000, 3000, 4000, 5000]) await seedMemory(ts)
  const p1 = await listMemoriesPage(db, { statuses: ['candidate'], limit: 2 })
  expect(p1.items.map((m) => m.createdAt)).toEqual([5000, 4000])
  expect(p1.hasMore).toBe(true)
  expect(p1.nextCursor).toEqual({ ts: 4000, id: p1.items[1]!.id })
  const p2 = await listMemoriesPage(db, { statuses: ['candidate'], limit: 2, before: p1.nextCursor! })
  expect(p2.items.map((m) => m.createdAt)).toEqual([3000, 2000])
  expect(p2.hasMore).toBe(true)
  const p3 = await listMemoriesPage(db, { statuses: ['candidate'], limit: 2, before: p2.nextCursor! })
  expect(p3.items.map((m) => m.createdAt)).toEqual([1000])
  expect(p3.hasMore).toBe(false)
  expect(p3.nextCursor).toBeNull()
})

test('listMemoriesPage: 同毫秒复合键 (createdAt, id) 不重不漏', async () => {
  // 同一 createdAt 三条（模拟回扫批量插入）；默认 ulid() 在同一毫秒内不保证
  // 创建序，故按实际字典序降序断言，保证测试确定性。
  const ids = [await seedMemory(1000), await seedMemory(1000), await seedMemory(1000)]
  const sortedDesc = [...ids].sort().reverse()
  const p1 = await listMemoriesPage(db, { statuses: ['candidate'], limit: 2 })
  expect(p1.items.map((m) => m.id)).toEqual([sortedDesc[0], sortedDesc[1]]) // id DESC
  const p2 = await listMemoriesPage(db, { statuses: ['candidate'], limit: 2, before: p1.nextCursor! })
  expect(p2.items.map((m) => m.id)).toEqual([sortedDesc[2]])
  expect(p2.hasMore).toBe(false)
})

test('listMemoriesPage: status inArray 过滤', async () => {
  await seedMemory(1000, 'candidate')
  await seedMemory(2000, 'rejected')
  const page = await listMemoriesPage(db, { statuses: ['rejected'], limit: 50 })
  expect(page.items.length).toBe(1)
  expect(page.items[0]!.status).toBe('rejected')
})

test('listMemoriesPage: 空表 -> 空页无游标', async () => {
  const page = await listMemoriesPage(db, { statuses: ['candidate'], limit: 50 })
  expect(page).toEqual({ items: [], hasMore: false, nextCursor: null })
})
