import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { memoryDistillJobs } from '@/db/schema'
import { createCandidate, logDiscards, listFacets, VALUE_CLASS_UNEVALUATED } from '@/memory/store'

// 回归锁定：/api/facets 数据面（spec 2026-08-11-web-memory-filters §4.1 决策 D1/D2）。
// 项目/分类 UNION memories+discards 两表；value_class NULL 聚未评估桶；count 降序。
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

async function seedMem(title: string, opts: { sourceCwd?: string | null; slug?: string | null; valueClass?: 'decision' | 'trap' | null } = {}) {
  return createCandidate(db, {
    scopeType: 'global', scopeId: null, title, bodyMd: 'b',
    tags: [], sourceKind: 'manual', runtime: null,
    sourceCwd: opts.sourceCwd ?? null, subjectSlug: opts.slug ?? null,
    valueClass: opts.valueClass ?? null,
  })
}

function seedDiscardJob() {
  db.insert(memoryDistillJobs).values({
    id: 'job-f', debounceKey: 'k', sourceEventId: 's', runtime: 'claude-code',
    cwd: '/r', status: 'done', attempts: 0, nextRunAt: 0, createdAt: 0,
  }).run()
}

test('projects UNION 两表：discard 独有项目必须出现，同值合并计数', async () => {
  await seedMem('[category:trap] A', { sourceCwd: 'C:/p/a' })
  await seedMem('[category:trap] B', { sourceCwd: null }) // NULL 不进选项
  seedDiscardJob()
  await logDiscards(db, 'job-f', [
    { title: '[category:trap] C', bodyMd: 'b', reason: 'fleeting' as const, scopeType: 'project' as const, scopeId: 'C:/p/only-discard', sourceCwd: 'C:/p/only-discard', runtime: null, sourceKind: 'conversation' as const },
    { title: '[category:trap] D', bodyMd: 'b', reason: 'fleeting' as const, scopeType: 'project' as const, scopeId: 'C:/p/a', sourceCwd: 'C:/p/a', runtime: null, sourceKind: 'conversation' as const },
  ])
  const f = await listFacets(db)
  expect(f.projects).toEqual([
    { value: 'C:/p/a', count: 2 },            // 1 memory + 1 discard 合并
    { value: 'C:/p/only-discard', count: 1 }, // 只在 discards 里（决策 D1）
  ])
})

test('categories 两表 title 解析计数（幻觉分类也收录，数据驱动）', async () => {
  await seedMem('[category:invariant] X')
  await seedMem('[category:invariant] Y')
  await seedMem('[category:test-pattern] Z') // 幻觉值也必须出现
  seedDiscardJob()
  await logDiscards(db, 'job-f', [
    { title: '[category:invariant] W', bodyMd: 'b', reason: 'fleeting' as const, scopeType: 'global' as const, scopeId: null, sourceCwd: null, runtime: null, sourceKind: 'conversation' as const },
  ])
  const f = await listFacets(db)
  expect(f.categories).toEqual([
    { value: 'invariant', count: 3 },   // 2 memories + 1 discard
    { value: 'test-pattern', count: 1 },
  ])
})

test('slugs 排除 NULL；valueClasses 含未评估桶；count 降序 + 同 count 字母序', async () => {
  await seedMem('[category:trap] 1', { slug: 'refund-policy', valueClass: 'decision' })
  await seedMem('[category:trap] 2', { slug: 'refund-policy', valueClass: 'decision' })
  await seedMem('[category:trap] 3', { slug: 'a-b', valueClass: null })
  await seedMem('[category:trap] 4', { slug: null, valueClass: 'trap' })
  const f = await listFacets(db)
  expect(f.slugs).toEqual([
    { value: 'refund-policy', count: 2 },
    { value: 'a-b', count: 1 },
  ])
  expect(f.valueClasses).toEqual([
    { value: 'decision', count: 2 },
    { value: 'trap', count: 1 },                    // 同 count 字母序：t < u
    { value: VALUE_CLASS_UNEVALUATED, count: 1 },
  ])
})

test('空表 -> 四个空数组', async () => {
  expect(await listFacets(db)).toEqual({ projects: [], categories: [], slugs: [], valueClasses: [] })
})