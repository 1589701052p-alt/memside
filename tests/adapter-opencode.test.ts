import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { memories } from '@/db/schema'
import { createCandidate } from '@/memory/store'
import { OpencodeAdapter } from '@/adapter/opencode'

// --- tmp DB setup (parallel to store-crud.test.ts) ---
const root = join(import.meta.dir, '.tmp-opencode')
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

afterEach(() => {
  db.$client.close()
})

test('inject 返回 approved 记忆块（跨 runtime）', async () => {
  // seed a project approved memory with runtime='claude-code' to verify cross-runtime sharing
  const projectId = '/repo-cross-inject'
  const m = await createCandidate(db, {
    scopeType: 'project', scopeId: projectId, title: 'shared-memory', bodyMd: 'body text',
    tags: [], sourceKind: 'conversation', runtime: 'claude-code', sourceCwd: projectId,
  })
  await db.update(memories).set({ status: 'approved' }).where(eq(memories.id, m.id)).run()

  const adapter = new OpencodeAdapter(db)
  const block = await adapter.inject({ cwd: projectId })
  expect(block).toContain('--- BEGIN INJECTED MEMORY ---')
  expect(block).toContain('shared-memory')
  expect(block).toContain('body text')
})

test('inject 无 db -> null', async () => {
  const adapter = new OpencodeAdapter(undefined)
  expect(await adapter.inject({ cwd: '/x' })).toBeNull()
})

test('inject db 错误降级 null，不抛', async () => {
  // a fake db whose methods throw
  const badDb = {
    select: () => { throw new Error('db exploded') },
    update: () => { throw new Error('db exploded') },
    insert: () => { throw new Error('db exploded') },
    delete: () => { throw new Error('db exploded') },
    $client: { close: () => {} },
  }
  const adapter = new OpencodeAdapter(badDb as any)
  expect(await adapter.inject({ cwd: '/x' })).toBeNull()
})

test('pushCapture / capture 保持入队出队', async () => {
  const adapter = new OpencodeAdapter(undefined)
  const event = {
    sourceEventId: 'evt-1',
    runtime: 'opencode' as const,
    cwd: '/repo',
    debounceKey: 'key-1',
    turns: [],
    sourceKind: 'conversation' as const,
  }
  adapter.pushCapture(event)
  const drained = await adapter.capture()
  expect(drained).toHaveLength(1)
  expect(drained[0]!.sourceEventId).toBe('evt-1')
  // second drain should be empty
  expect(await adapter.capture()).toHaveLength(0)
})

test('kind 属性为 opencode', () => {
  const adapter = new OpencodeAdapter(undefined)
  expect(adapter.kind).toBe('opencode')
})
