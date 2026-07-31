import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb, type DbClient } from '@/db/client'
import {
  createCandidate, listApprovedByScope, listSubjectSlugs, patchMemory,
  MemoryConflictError, promoteCandidate,
} from '@/memory/store'

// subject-keyed 聚合 store 层（spec §4.4）：slug 写入/投影/清单查询/patch 校验。

const root = join(import.meta.dir, '.tmp-store-slug')
let dir = ''
let db: DbClient | null = null

beforeAll(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
})
beforeEach(() => {
  dir = join(root, Math.random().toString(36).slice(2))
  mkdirSync(dir, { recursive: true })
  db = openDb(join(dir, 't.db'))
})
afterEach(() => {
  if (db) { db.$client.close(); db = null }
})

const base = {
  scopeType: 'project' as const, scopeId: '/repo', title: 't', bodyMd: 'b',
  tags: [] as string[], sourceKind: 'manual' as const, runtime: null,
}

test('createCandidate writes subjectSlug; listApprovedByScope projects it', async () => {
  const m = await createCandidate(db!, { ...base, subjectSlug: 'refund-policy' })
  expect(m.subjectSlug).toBe('refund-policy')
  await promoteCandidate(db!, m.id, { action: 'approve' })
  const set = await listApprovedByScope(db!, { projectId: '/repo' })
  expect(set.byScope.project[0]!.subjectSlug).toBe('refund-policy')
})

test('createCandidate defaults subjectSlug to null', async () => {
  const m = await createCandidate(db!, base)
  expect(m.subjectSlug).toBeNull()
})

test('listSubjectSlugs: distinct, candidate+approved only, alphabetical', async () => {
  await createCandidate(db!, { ...base, subjectSlug: 'zeta' })
  await createCandidate(db!, { ...base, subjectSlug: 'alpha' })
  const dup = await createCandidate(db!, { ...base, subjectSlug: 'alpha' })
  const rejected = await createCandidate(db!, { ...base, subjectSlug: 'nope' })
  await promoteCandidate(db!, rejected.id, { action: 'reject' })
  await promoteCandidate(db!, dup.id, { action: 'approve' })
  const slugs = await listSubjectSlugs(db!, { scopeType: 'project', scopeId: '/repo' })
  expect(slugs).toEqual(['alpha', 'zeta'])
})

test('listSubjectSlugs: scope isolation (project vs global vs other project)', async () => {
  await createCandidate(db!, { ...base, subjectSlug: 'proj-a' })
  await createCandidate(db!, { ...base, scopeId: '/other', subjectSlug: 'proj-b' })
  await createCandidate(db!, { ...base, scopeType: 'global', scopeId: null, subjectSlug: 'glob' })
  expect(await listSubjectSlugs(db!, { scopeType: 'project', scopeId: '/repo' })).toEqual(['proj-a'])
  expect(await listSubjectSlugs(db!, { scopeType: 'global', scopeId: null })).toEqual(['glob'])
})

test('patchMemory sets / clears subjectSlug, counts as change', async () => {
  const m = await createCandidate(db!, base)
  const r1 = await patchMemory(db!, m.id, { subjectSlug: 'Hook-Install' })
  expect(r1.memory.subjectSlug).toBe('hook-install') // normalize 小写
  expect(r1.changedFields).toContain('subjectSlug')
  const r2 = await patchMemory(db!, m.id, { subjectSlug: null })
  expect(r2.memory.subjectSlug).toBeNull()
  expect(r2.changedFields).toContain('subjectSlug')
  // 无变化 -> 空 changedFields（幂等 no-op）
  const r3 = await patchMemory(db!, m.id, { subjectSlug: null })
  expect(r3.changedFields).toEqual([])
})

test('patchMemory rejects invalid subjectSlug with MemoryConflictError', async () => {
  const m = await createCandidate(db!, base)
  await expect(patchMemory(db!, m.id, { subjectSlug: 'refund policy' })).rejects.toThrow(MemoryConflictError)
  // 非法 patch 不落库
  const again = await listSubjectSlugs(db!, { scopeType: 'project', scopeId: '/repo' })
  expect(again).toEqual([])
})
