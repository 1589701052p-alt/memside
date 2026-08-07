import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { memories, memoryDistillJobs } from '@/db/schema'
import type { MemoryStatus } from '@/memory/pure'
import type { ValueClass } from '@/memory/valueFilter'
import {
  createCandidate, clampPageLimit, listMemoriesPage, logDiscards, saveDistillRun,
  listDiscardsPage, listDistillRunsPage,
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

// --- Task 2: listDiscardsPage / listDistillRunsPage -------------------------
// 与 brief 的偏差（以 schema.ts / store-crud.test.ts 为准校准）：
//  - memoryDistillJobs 无 payloadHash 列、debounceKey notNull -> 照抄 store-crud 的 insert 形状
//  - memoryDiscards.distillJobId 有 FK -> seedDiscards 先插 job 行

async function seedDiscards(n: number) {
  // logDiscards 一次写 n 行（同一 ts = Date.now()，天然同毫秒批量）
  db.insert(memoryDistillJobs).values({ id: 'job-d', debounceKey: 'k', sourceEventId: 's', runtime: 'claude-code', cwd: '/r', status: 'done', attempts: 0, nextRunAt: 0, createdAt: 0 }).run()
  await logDiscards(db, 'job-d', Array.from({ length: n }, (_, i) => ({
    title: `d-${i}`, bodyMd: 'b', reason: 'fleeting' as const,
    scopeType: 'global' as const, scopeId: null, sourceCwd: null,
    runtime: null, sourceKind: 'conversation' as const,
  })))
}

test('listDiscardsPage: 同毫秒批量翻页不重不漏 + hasMore', async () => {
  await seedDiscards(3)
  const p1 = await listDiscardsPage(db, { limit: 2 })
  expect(p1.items.length).toBe(2)
  expect(p1.hasMore).toBe(true)
  const p2 = await listDiscardsPage(db, { limit: 2, before: p1.nextCursor! })
  expect(p2.items.length).toBe(1)
  expect(p2.hasMore).toBe(false)
  const allIds = [...p1.items, ...p2.items].map((d) => d.id)
  expect(new Set(allIds).size).toBe(3)
})

test('listDiscardsPage: 空表 -> 空页', async () => {
  expect(await listDiscardsPage(db, { limit: 50 })).toEqual({ items: [], hasMore: false, nextCursor: null })
})

async function seedRun(jobId: string) {
  db.insert(memoryDistillJobs).values({
    id: jobId, debounceKey: 'k', sourceEventId: 'e', status: 'done', cwd: `C:/proj/${jobId}`, runtime: 'claude-code',
    attempts: 0, nextRunAt: 0, createdAt: 1,
  }).run()
  await saveDistillRun(db, jobId, {
    outcome: 'produced', rawOutput: null, rawCount: 1, acceptedCount: 1,
    dedupedCount: 1, filteredCount: 1, storedCount: 1, discardedCount: 0,
    durationMs: 10, errorMessage: null,
  })
}

test('listDistillRunsPage: 翻页 + job 元数据带出 + 孤儿 run cwd=null', async () => {
  await seedRun('j1')
  await seedRun('j2')
  // 孤儿 run（无 job 行）
  await saveDistillRun(db, 'j-orphan', {
    outcome: 'empty_output', rawOutput: null, rawCount: 0, acceptedCount: 0,
    dedupedCount: 0, filteredCount: 0, storedCount: 0, discardedCount: 0,
    durationMs: 1, errorMessage: null,
  })
  const p1 = await listDistillRunsPage(db, { limit: 2 })
  expect(p1.items.length).toBe(2)
  expect(p1.hasMore).toBe(true)
  const p2 = await listDistillRunsPage(db, { limit: 2, before: p1.nextCursor! })
  expect(p2.items.length).toBe(1)
  expect(p2.hasMore).toBe(false)
  const all = [...p1.items, ...p2.items]
  expect(new Set(all.map((r) => r.distillJobId)).size).toBe(3)
  const orphan = all.find((r) => r.distillJobId === 'j-orphan')!
  expect(orphan.cwd).toBeNull()
  const j1 = all.find((r) => r.distillJobId === 'j1')
  expect(j1?.cwd).toBe('C:/proj/j1')
})
