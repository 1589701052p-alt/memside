import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { memoryDiscards, memoryDistillJobs } from '@/db/schema'
import { logDiscards, createCandidate, promoteDiscard, getMemoryById, listDiscards, MemoryConflictError, MemoryNotFoundError } from '@/memory/store'

const root = join(import.meta.dir, '.tmp-discard')
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

async function seedJob(): Promise<string> {
  const now = Date.now()
  const jobId = 'job-test-1'
  await db.insert(memoryDistillJobs).values({
    id: jobId, debounceKey: 'k', sourceEventId: 'e', runtime: 'claude-code',
    cwd: '/proj', sessionId: null, sourceAgentId: null, scopeResolvedJson: null,
    status: 'done', attempts: 0, nextRunAt: now, lastError: null,
    createdAt: now, finishedAt: now,
  })
  return jobId
}

test('logDiscards persists scope/source columns', async () => {
  const jobId = await seedJob()
  await logDiscards(db, jobId, [{
    title: 't', bodyMd: 'b', reason: 'public-knowledge',
    scopeType: 'project', scopeId: '/proj', sourceCwd: '/proj',
    runtime: 'claude-code', sourceKind: 'conversation',
  }])
  const rows = await db.select().from(memoryDiscards).where(eq(memoryDiscards.distillJobId, jobId)).all()
  expect(rows.length).toBe(1)
  const r = rows[0]!
  expect(r.scopeType).toBe('project')
  expect(r.scopeId).toBe('/proj')
  expect(r.sourceCwd).toBe('/proj')
  expect(r.runtime).toBe('claude-code')
  expect(r.sourceKind).toBe('conversation')
  expect(r.promotedMemoryId).toBeNull()
})

test('logDiscards is a no-op on empty list', async () => {
  await logDiscards(db, 'any', [])
  const rows = await db.select().from(memoryDiscards).all()
  expect(rows.length).toBe(0)
})

async function seedDiscard(overrides: Partial<{ scopeType: string; scopeId: string | null; sourceCwd: string | null; runtime: string; sourceKind: string; promotedMemoryId: string | null }> = {}): Promise<string> {
  const jobId = await seedJob()
  const id = 'discard-1'
  const now = Date.now()
  // 用 `=== undefined` 判定而非 `??`：`??` 会把显式 null 当 nullish 吞掉回退默认值，
  // 无法构造迁移前老行（scope 字段全 NULL）场景。
  await db.insert(memoryDiscards).values({
    id, distillJobId: jobId, title: 'dt', bodyMd: 'db', reason: 'public-knowledge', ts: now,
    scopeType: overrides.scopeType !== undefined ? overrides.scopeType : 'project',
    scopeId: overrides.scopeId !== undefined ? overrides.scopeId : '/proj',
    sourceCwd: overrides.sourceCwd !== undefined ? overrides.sourceCwd : '/proj',
    runtime: overrides.runtime !== undefined ? overrides.runtime : 'claude-code',
    sourceKind: overrides.sourceKind !== undefined ? overrides.sourceKind : 'conversation',
    promotedMemoryId: overrides.promotedMemoryId !== undefined ? overrides.promotedMemoryId : null,
  })
  return id
}

test('promoteDiscard creates candidate from discard and backfills promoted_memory_id', async () => {
  const did = await seedDiscard()
  const m = await promoteDiscard(db, did)
  expect(m.status).toBe('candidate')
  expect(m.title).toBe('dt')
  expect(m.scopeType).toBe('project')
  expect(m.sourceCwd).toBe('/proj')
  // 回填
  const drows = await db.select().from(memoryDiscards).where(eq(memoryDiscards.id, did)).all()
  expect(drows[0]!.promotedMemoryId).toBe(m.id)
  // candidate 真实存在
  const got = await getMemoryById(db, m.id)
  expect(got).not.toBeNull()
})

test('promoteDiscard on already-promoted throws Conflict', async () => {
  const did = await seedDiscard({ promotedMemoryId: 'existing-cand-id' })
  await expect(promoteDiscard(db, did)).rejects.toBeInstanceOf(MemoryConflictError)
})

test('promoteDiscard on legacy row missing scope throws Conflict', async () => {
  const did = await seedDiscard({ scopeType: null as any, scopeId: null, sourceCwd: null, runtime: null as any, sourceKind: null as any })
  await expect(promoteDiscard(db, did)).rejects.toBeInstanceOf(MemoryConflictError)
})

test('promoteDiscard on missing id throws NotFound', async () => {
  await expect(promoteDiscard(db, 'nope')).rejects.toBeInstanceOf(MemoryNotFoundError)
})

test('listDiscards returns rows newest-first, default limit 200', async () => {
  const jobId = await seedJob()
  const now = Date.now()
  for (let i = 0; i < 3; i++) {
    await db.insert(memoryDiscards).values({
      id: `d-${i}`, distillJobId: jobId, title: `t${i}`, bodyMd: 'b', reason: 'derivable',
      ts: now + i, scopeType: 'global', scopeId: null, sourceCwd: null,
      runtime: 'claude-code', sourceKind: 'conversation', promotedMemoryId: null,
    })
  }
  const rows = await listDiscards(db)
  expect(rows.length).toBe(3)
  expect(rows[0]!.ts).toBeGreaterThan(rows[2]!.ts)  // DESC
})

test('listDiscards empty table returns []', async () => {
  const rows = await listDiscards(db)
  expect(rows).toEqual([])
})
