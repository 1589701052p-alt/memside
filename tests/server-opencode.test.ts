import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { ClaudeCodeAdapter } from '@/adapter/claudeCode'
import { createApp } from '@/server'
import type { RuntimeAdapter } from '@/adapter/types'

// Task 4 回归锁：daemon 接收双 adapter（claude + opencode）。
// 锁定契约：createApp(deps) 接收 deps.opencodeAdapter，且 /hooks/opencode/inject
// 路由调用 deps.opencodeAdapter.inject({cwd}) 并把返回块包成 {block}。
//
// 为什么用 fake opencodeAdapter 而非真实 OpencodeAdapter+seed：本任务的范围是
// 「server 接收双 adapter + 路由接线」，adapter.inject 的内部逻辑（listApprovedByScope
// 跨 runtime + formatMemoryBlock）已由 Task 3 的 adapter-opencode.test.ts 锁定。
// fake 隔离路由接线层，避免与 Task 3 逻辑耦合。capture 路由（POST /hooks/opencode/capture）
// 是 Task 5 的范围，本任务不注册。
//
// 注：brief Step 3 写了「暂不注册 opencode 路由（Task 5 注册）」，但 Step 1 的测试
// 调用 /hooks/opencode/inject 且 Step 4 要求 PASS、Task 5 Step 1 注释「Task 4 已覆盖」。
// 三者只有在 Task 4 注册最小 inject 路由时才自洽（capture 仍归 Task 5）。CLAUDE.md
// 硬约束「测试全绿才能 push」+ TDD 红->绿亦不允许提交一个必然 404 的失败测试。

const root = join(import.meta.dir, '.tmp-server-opencode')
let dir = ''
let db: ReturnType<typeof openDb>

beforeAll(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
})

beforeEach(() => {
  // EBUSY-safe 模式（同 server.test.ts / adapter-claude.test.ts）：每测试独立子目录，
  // afterEach 关 bun:sqlite 原始句柄，避免 Windows 上删还在被锁的 -wal/-shm。
  dir = join(root, Math.random().toString(36).slice(2))
  mkdirSync(dir, { recursive: true })
  db = openDb(join(dir, 't.db'))
})

afterEach(() => {
  db.$client.close()
})

test('GET /hooks/opencode/inject 返回 opencode adapter 块', async () => {
  // fake opencodeAdapter.inject 返回已知块 -> 证明路由调用了 deps.opencodeAdapter.inject
  // 并把返回值原样包成 {block}（与 /inject 路由用 deps.adapter.inject 的模式对齐）。
  const BLOCK = '--- BEGIN INJECTED MEMORY ---\nproject: /p\nopencode wired\n--- END INJECTED MEMORY ---'
  const opencodeFake: RuntimeAdapter = {
    kind: 'opencode',
    capture: async () => [],
    inject: async () => BLOCK,
  }
  const app = createApp({
    db,
    adapter: new ClaudeCodeAdapter(db),
    opencodeAdapter: opencodeFake,
    enqueueDistillJob: async () => ({ jobId: 'j', nextRunAt: 0 }),
    broadcast: () => {},
  })
  const res = await app.request('/hooks/opencode/inject?cwd=/p', { method: 'GET' })
  const body = await res.json().catch(() => ({}))
  expect(body.block).toContain('--- BEGIN INJECTED MEMORY ---')
})
