import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { memoryDiscards, memoryDistillJobs } from '@/db/schema'
import { logDiscards } from '@/memory/store'

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
