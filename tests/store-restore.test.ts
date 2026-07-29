import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { createCandidate, promoteCandidate, restoreMemory, MemoryConflictError, MemoryNotFoundError } from '@/memory/store'

const root = join(import.meta.dir, '.tmp-restore')
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

test('restore moves rejected back to candidate and clears approvedAt', async () => {
  const c = await createCandidate(db, { scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  await promoteCandidate(db, c.id, { action: 'reject' })  // candidate -> rejected
  const r = await restoreMemory(db, c.id)
  expect(r.status).toBe('candidate')
  expect(r.approvedAt).toBeNull()
})

test('restore rejects non-rejected memory (409)', async () => {
  const c = await createCandidate(db, { scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  // c 仍是 candidate
  await expect(restoreMemory(db, c.id)).rejects.toBeInstanceOf(MemoryConflictError)
})

test('restore on missing id throws NotFound', async () => {
  await expect(restoreMemory(db, 'nope')).rejects.toBeInstanceOf(MemoryNotFoundError)
})
