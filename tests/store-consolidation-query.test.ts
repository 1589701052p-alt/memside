import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import type { DbClient } from '@/db/client'
import { createCandidate, listForDedupByScope } from '@/memory/store'

// DB 构造沿用 store-crud.test.ts 模式：每条测试独立子目录 + 测后 close 原始
// bun:sqlite 句柄，避免 Windows EBUSY（删含打开句柄的目录失败）。spec §3.3
// 合并步按 subjectSlug 预筛 existing：解除 candidate 50 条盲区。
const root = join(import.meta.dir, '.tmp-slug')
let dir = ''
let db: DbClient

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
  db.$client.close()
})

test('listForDedupByScope with slugs → only candidates with matching slug, no 50 limit', async () => {
  // 建 60 条同 slug candidate + 10 条别的 slug
  for (let i = 0; i < 60; i++) {
    await createCandidate(db, { scopeType: 'project', scopeId: 'p', title: `[category:convention] t${i}`, bodyMd: 'b', tags: [], sourceKind: 'conversation', sourceCwd: 'p', runtime: 'claude-code', distillJobId: 'j', subjectSlug: 'refund', origin: 'agent-observed', evidence: null })
  }
  for (let i = 0; i < 10; i++) {
    await createCandidate(db, { scopeType: 'project', scopeId: 'p', title: `[category:architecture] o${i}`, bodyMd: 'b', tags: [], sourceKind: 'conversation', sourceCwd: 'p', runtime: 'claude-code', distillJobId: 'j', subjectSlug: 'other', origin: 'agent-observed', evidence: null })
  }
  const res = await listForDedupByScope(db, { scopeType: 'project', scopeId: 'p', slugs: ['refund'] })
  expect(res.length).toBe(60)  // 不被 LIMIT 50 截断
  expect(res.every((r) => r.subjectSlug === 'refund')).toBe(true)
})

test('listForDedupByScope no slugs (empty batch) → fallback recent 50 cap', async () => {
  for (let i = 0; i < 70; i++) {
    await createCandidate(db, { scopeType: 'project', scopeId: 'p', title: `[category:convention] t${i}`, bodyMd: 'b', tags: [], sourceKind: 'conversation', sourceCwd: 'p', runtime: 'claude-code', distillJobId: 'j', subjectSlug: null, origin: 'agent-observed', evidence: null })
  }
  const res = await listForDedupByScope(db, { scopeType: 'project', scopeId: 'p', slugs: [] })
  expect(res.length).toBeLessThanOrEqual(50)  // fallback 上限 50 防爆 prompt
})

test('listForDedupByScope result rows carry subjectSlug', async () => {
  await createCandidate(db, { scopeType: 'project', scopeId: 'p', title: '[category:convention] t', bodyMd: 'b', tags: [], sourceKind: 'conversation', sourceCwd: 'p', runtime: 'claude-code', distillJobId: 'j', subjectSlug: 'refund', origin: 'agent-observed', evidence: null })
  const res = await listForDedupByScope(db, { scopeType: 'project', scopeId: 'p', slugs: ['refund'] })
  expect(res[0]!.subjectSlug).toBe('refund')
})
