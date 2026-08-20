import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { memories, memoryDistillJobs } from '@/db/schema'
import { createCandidate, logDiscards, listFacets, VALUE_CLASS_UNEVALUATED, FACET_LIST_CAP, type FacetScope } from '@/memory/store'

// 回归锁定：listFacets 按 tab scope 统计（spec 2026-08-11-per-tab-memory-filters §4.1）。
// 推翻 2026-08-11-web-memory-filters 的全局口径（两表 UNION）：memories scope 只数
// 给定 statuses 的行；discards scope 只查 memory_discards（slugs/valueClasses 恒空）。
const root = join(import.meta.dir, '.tmp-store-facets')
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

const CANDIDATE: FacetScope = { kind: 'memories', statuses: ['candidate'] }
const APPROVED: FacetScope = { kind: 'memories', statuses: ['approved', 'archived', 'superseded'] }
const REJECTED: FacetScope = { kind: 'memories', statuses: ['rejected'] }
const DISCARDS: FacetScope = { kind: 'discards' }

async function seedMem(title: string, opts: { sourceCwd?: string | null; slug?: string | null; valueClass?: 'decision' | 'trap' | null; status?: 'candidate' | 'approved' | 'rejected' } = {}) {
  const m = await createCandidate(db, {
    scopeType: 'global', scopeId: null, title, bodyMd: 'b',
    tags: [], sourceKind: 'manual', runtime: null,
    sourceCwd: opts.sourceCwd ?? null, subjectSlug: opts.slug ?? null,
    valueClass: opts.valueClass ?? null,
  })
  if (opts.status && opts.status !== 'candidate') {
    await db.update(memories).set({ status: opts.status }).where(eq(memories.id, m.id))
  }
  return m
}

function seedDiscardJob() {
  db.insert(memoryDistillJobs).values({
    id: 'job-f', debounceKey: 'k', sourceEventId: 's', runtime: 'claude-code',
    cwd: '/r', status: 'done', attempts: 0, nextRunAt: 0, createdAt: 0,
  }).run()
}

test('memories scope: projects 只数 scope statuses 内的行（混播状态互相隔离）', async () => {
  await seedMem('[category:trap] A', { sourceCwd: 'C:/p/a' })
  await seedMem('[category:trap] B', { sourceCwd: 'C:/p/a', status: 'rejected' })
  await seedMem('[category:trap] C', { sourceCwd: 'C:/p/b', status: 'rejected' })
  await seedMem('[category:trap] D', { sourceCwd: null }) // NULL 不进选项
  expect((await listFacets(db, CANDIDATE)).projects).toEqual([{ value: 'C:/p/a', count: 1 }])
  expect((await listFacets(db, REJECTED)).projects).toEqual([
    { value: 'C:/p/a', count: 1 }, // 同 count 按 value 字母序
    { value: 'C:/p/b', count: 1 },
  ])
})

test('memories scope: approved scope 覆盖 approved/archived/superseded 三态', async () => {
  await seedMem('[category:trap] A', { sourceCwd: 'C:/p/a', status: 'approved' })
  const b = await seedMem('[category:trap] B', { sourceCwd: 'C:/p/a' })
  await db.update(memories).set({ status: 'archived' }).where(eq(memories.id, b.id))
  const s = await seedMem('[category:trap] S', { sourceCwd: 'C:/p/a' })
  await db.update(memories).set({ status: 'superseded' }).where(eq(memories.id, s.id))
  await seedMem('[category:trap] C', { sourceCwd: 'C:/p/a' }) // candidate，不应出现
  expect((await listFacets(db, APPROVED)).projects).toEqual([{ value: 'C:/p/a', count: 3 }])
})

test('memories scope: categories/slugs/valueClasses 同样按 scope（未评估桶只数 scope 内 NULL）', async () => {
  await seedMem('[category:invariant] X', { slug: 'refund-policy', valueClass: 'decision' })
  await seedMem('[category:invariant] Y', { slug: 'refund-policy', valueClass: null, status: 'rejected' })
  await seedMem('[category:test-pattern] Z', { slug: 'a-b', valueClass: null, status: 'rejected' })
  const f = await listFacets(db, CANDIDATE)
  expect(f.categories).toEqual([{ value: 'invariant', count: 1 }])
  expect(f.slugs).toEqual([{ value: 'refund-policy', count: 1 }])
  expect(f.valueClasses).toEqual([{ value: 'decision', count: 1 }])
  const r = await listFacets(db, REJECTED)
  expect(r.categories).toEqual([
    { value: 'invariant', count: 1 },    // 同 count 按 value 字母序
    { value: 'test-pattern', count: 1 },
  ])
  expect(r.slugs).toEqual([
    { value: 'a-b', count: 1 },            // 同 count 按 value 字母序：a-b < refund-policy
    { value: 'refund-policy', count: 1 },
  ])
  expect(r.valueClasses).toEqual([{ value: VALUE_CLASS_UNEVALUATED, count: 2 }])
})

test('discards scope: 只查 memory_discards，slugs/valueClasses 恒空；memories scope 不含 discard 行', async () => {
  await seedMem('[category:trap] A', { sourceCwd: 'C:/p/mem-only', slug: 's1', valueClass: 'decision' })
  seedDiscardJob()
  await logDiscards(db, 'job-f', [
    { title: '[category:trap] C', bodyMd: 'b', reason: 'fleeting' as const, scopeType: 'project' as const, scopeId: 'C:/p/d', sourceCwd: 'C:/p/d', runtime: null, sourceKind: 'conversation' as const },
    { title: '[category:trap] D', bodyMd: 'b', reason: 'fleeting' as const, scopeType: 'project' as const, scopeId: 'C:/p/d', sourceCwd: 'C:/p/d', runtime: null, sourceKind: 'conversation' as const },
  ])
  const f = await listFacets(db, DISCARDS)
  expect(f.projects).toEqual([{ value: 'C:/p/d', count: 2 }])
  expect(f.categories).toEqual([{ value: 'trap', count: 2 }])
  expect(f.slugs).toEqual([])
  expect(f.valueClasses).toEqual([])
  expect((await listFacets(db, CANDIDATE)).projects).toEqual([{ value: 'C:/p/mem-only', count: 1 }])
})

test('空表 -> 四个空数组（任何 scope）', async () => {
  expect(await listFacets(db, CANDIDATE)).toEqual({ projects: [], categories: [], slugs: [], valueClasses: [], origins: [] })
  expect(await listFacets(db, DISCARDS)).toEqual({ projects: [], categories: [], slugs: [], valueClasses: [], origins: [] })
})

// 回归锁定（spec web-memory-filters §4.1 + per-tab spec §2 G3）：
// FACET_LIST_CAP（200）截断在 scope 化后仍必须成立。
test('slugs 截断到 FACET_LIST_CAP（201 个不同 slug -> 200）', async () => {
  for (let i = 0; i < 201; i++) {
    await seedMem('[category:trap] s' + i, { slug: 'slug-' + i })
  }
  const f = await listFacets(db, CANDIDATE)
  expect(f.slugs.length).toBe(FACET_LIST_CAP)
})