import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { createCandidate, promoteCandidate } from '@/memory/store'
import { ClaudeCodeAdapter } from '@/adapter/claudeCode'

// EBUSY-safe pattern (same as store-promote.test.ts / store-crud.test.ts):
// wipe `root` once in beforeAll, give each test its own fresh subdir, and
// close the raw bun:sqlite handle in afterEach. The plan's bare `rmSync(tmp)`
// in beforeEach throws EBUSY on Windows because the previous test's Database
// (plus -wal/-shm sidecars) is still locked. Only test 1 has no db, but tests
// 2 and 3 open one, so we need the close-on-teardown discipline uniformly.
const root = join(import.meta.dir, '.tmp-cc')
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

test('pushCapture buffers events; capture drains them', async () => {
  const a = new ClaudeCodeAdapter()
  a.pushCapture({ sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k', turns: [{ role: 'user', content: 'hi' }], sourceKind: 'conversation' })
  const events = await a.capture()
  expect(events.length).toBe(1)
  // drained
  const again = await a.capture()
  expect(again.length).toBe(0)
})

test('inject returns null when no approved memories', async () => {
  const a = new ClaudeCodeAdapter(db)
  const block = await a.inject({ cwd: '/r' })
  expect(block).toBeNull()
})

test('inject returns anchored block with approved memory', async () => {
  const c = await createCandidate(db, { scopeType: 'project', scopeId: '/r', title: 'Use ULID', bodyMd: 'ids ULID', tags: [], sourceKind: 'manual', runtime: null })
  await promoteCandidate(db, c.id, { action: 'approve' })
  const a = new ClaudeCodeAdapter(db)
  const block = await a.inject({ cwd: '/r' })
  expect(block).toContain('--- BEGIN INJECTED MEMORY ---')
  expect(block).toContain('Use ULID')
})
