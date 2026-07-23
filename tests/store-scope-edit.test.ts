import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { eq } from 'drizzle-orm'
import { memories } from '@/db/schema'
import { createCandidate, patchMemory, listApprovedByScope, MemoryConflictError } from '@/memory/store'

const root = join(import.meta.dir, '.tmp-scope-edit')
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

test('patch project->global clears scopeId and bumps version', async () => {
  const m = await createCandidate(db, {
    scopeType: 'project', scopeId: '/r', title: 't', bodyMd: 'b',
    tags: [], sourceKind: 'conversation', runtime: null, sourceCwd: '/r',
  })
  const r = await patchMemory(db, m.id, { scopeType: 'global' })
  expect(r.memory.scopeType).toBe('global')
  expect(r.memory.scopeId).toBeNull()
  expect(r.memory.version).toBe(2)
  expect(r.changedFields).toContain('scopeType')
  expect(r.changedFields).toContain('scopeId')
})

test('patch global->project sets scopeId to sourceCwd', async () => {
  const m = await createCandidate(db, {
    scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b',
    tags: [], sourceKind: 'conversation', runtime: null, sourceCwd: '/r',
  })
  const r = await patchMemory(db, m.id, { scopeType: 'project' })
  expect(r.memory.scopeType).toBe('project')
  expect(r.memory.scopeId).toBe('/r')
  expect(r.changedFields).toContain('scopeType')
})

test('patch global->project without sourceCwd throws MemoryConflictError', async () => {
  const m = await createCandidate(db, {
    scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b',
    tags: [], sourceKind: 'manual', runtime: null,
  })
  await expect(patchMemory(db, m.id, { scopeType: 'project' })).rejects.toThrow(MemoryConflictError)
})

test('patch scopeId-only violating invariant throws', async () => {
  const m = await createCandidate(db, {
    scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b',
    tags: [], sourceKind: 'manual', runtime: null,
  })
  await expect(patchMemory(db, m.id, { scopeId: '/x' })).rejects.toThrow(MemoryConflictError)
})

test('patch scope unchanged is idempotent no-op', async () => {
  const m = await createCandidate(db, {
    scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b',
    tags: [], sourceKind: 'manual', runtime: null,
  })
  const r = await patchMemory(db, m.id, { scopeType: 'global' })
  expect(r.changedFields).toEqual([])
  expect(r.memory.version).toBe(1)
})

test('project->global then approved injects in any cwd', async () => {
  const m = await createCandidate(db, {
    scopeType: 'project', scopeId: '/r', title: 't', bodyMd: 'b',
    tags: [], sourceKind: 'conversation', runtime: null, sourceCwd: '/r',
  })
  await patchMemory(db, m.id, { scopeType: 'global' })
  await db.update(memories).set({ status: 'approved' }).where(eq(memories.id, m.id)).run()
  const set = await listApprovedByScope(db, { projectId: '/other', runtime: 'claude-code' })
  expect(set.byScope.global.length).toBe(1)
  expect(set.byScope.project.length).toBe(0)
})

test('global->project then approved injects only in source cwd', async () => {
  const m = await createCandidate(db, {
    scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b',
    tags: [], sourceKind: 'conversation', runtime: null, sourceCwd: '/r',
  })
  await patchMemory(db, m.id, { scopeType: 'project' })
  await db.update(memories).set({ status: 'approved' }).where(eq(memories.id, m.id)).run()
  const inSource = await listApprovedByScope(db, { projectId: '/r', runtime: 'claude-code' })
  expect(inSource.byScope.project.length).toBe(1)
  const inOther = await listApprovedByScope(db, { projectId: '/other', runtime: 'claude-code' })
  expect(inOther.byScope.project.length).toBe(0)
  expect(inOther.byScope.global.length).toBe(0)
})
