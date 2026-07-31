import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { ClaudeCodeAdapter } from '@/adapter/claudeCode'
import { createApp } from '@/server'
import { memoryDistillEvents } from '@/db/schema'
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

test('POST /hooks/opencode/capture -> enqueueDistillJob(runtime:opencode) + events 行 + 202', async () => {
  // Task 5 回归锁：opencode 侧会话捕获路由。opencode idle hook POST 全量 messages ->
  // parseOpencodeMessages 转 TranscriptTurn[] -> enqueueDistillJob(runtime:'opencode') +
  // memory_distill_events 行（kind:'conversation'）-> 202 同步 ack。
  // 镜像 claude code Stop 路由的 fire-and-forget IIFE + broadcast + 202 模式（server.ts:222-238）。
  // 错误信号不走单独路由：由 capture 全量 transcript 经 distiller 的 detectErrorSignals 提取
  // （对齐 claude code PostToolUse 跳过决策，server.ts:154-157）。
  const BLOCK = '--- BEGIN INJECTED MEMORY ---\nopencode wired\n--- END INJECTED MEMORY ---'
  const opencodeFake: RuntimeAdapter = {
    kind: 'opencode',
    capture: async () => [],
    inject: async () => BLOCK,
  }
  const enqueueCalls: { runtime: string; cwd: string; debounceKey: string; sessionId?: string }[] = []
  const bc: unknown[] = []
  const app = createApp({
    db,
    adapter: new ClaudeCodeAdapter(db),
    opencodeAdapter: opencodeFake,
    enqueueDistillJob: async (_d, input) => { enqueueCalls.push(input); return { jobId: 'j1', nextRunAt: 0 } },
    broadcast: (m: unknown) => { bc.push(m) },
  })
  const res = await app.request('/hooks/opencode/capture', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: 's1',
      cwd: '/p',
      messages: [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hi' }] }],
    }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(202)
  // enqueueDistillJob 在 IIFE 内异步调用，但 fake 在调用时同步记录入参（参考 server.test.ts
  // 的 enqueueCalls 模式），fire-and-forget 不 await 也能确定性断言。
  expect(enqueueCalls.length).toBe(1)
  expect(enqueueCalls[0]).toMatchObject({ runtime: 'opencode', cwd: '/p', debounceKey: 's1', sessionId: 's1' })
  // memory_distill_events 行写入（IIFE 内异步落库，等 50ms 让 DB write 完成）
  await new Promise((r) => setTimeout(r, 50))
  const events = await db.select().from(memoryDistillEvents)
  expect(events.length).toBe(1)
  expect(events[0]!.kind).toBe('conversation')
  // payload 是 JSON.stringify(parseOpencodeMessages(messages))，含 user 文本
  expect(events[0]!.payload).toContain('hi')
  // capture 路由同步 broadcast memory.capture（与 claude Stop 一致）
  expect(bc.some((m: any) => m.type === 'memory.capture')).toBe(true)
})

test('POST /hooks/opencode/capture 缺 sessionId 时 debounceKey 回退 cwd:opencode', async () => {
  // debounceKey 兜底：无 sessionId 时用 `${cwd}:opencode`，避免多 opencode 会话
  // 共用同一 cwd 串成一条 debounce 链导致互相覆盖（对齐 brief 的 debounceKey 公式）。
  const opencodeFake: RuntimeAdapter = {
    kind: 'opencode',
    capture: async () => [],
    inject: async () => '',
  }
  const enqueueCalls: { runtime: string; cwd: string; debounceKey: string; sessionId?: string }[] = []
  const app = createApp({
    db,
    adapter: new ClaudeCodeAdapter(db),
    opencodeAdapter: opencodeFake,
    enqueueDistillJob: async (_d, input) => { enqueueCalls.push(input); return { jobId: 'j2', nextRunAt: 0 } },
    broadcast: () => {},
  })
  const res = await app.request('/hooks/opencode/capture', {
    method: 'POST',
    body: JSON.stringify({ cwd: '/p', messages: [] }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(202)
  expect(enqueueCalls[0]).toMatchObject({ runtime: 'opencode', cwd: '/p', debounceKey: '/p:opencode', sessionId: '' })
})

// final-review Important #1 回归锁：malformed messages 不得逃逸路由 -> 500，必须 202 ack。
// 背景：capture 路由镜像 claude code Stop（parseTranscriptFile 在 IIFE try/catch 内），
// 但 opencode 版一度把 parseOpencodeMessages 放在 IIFE 之外同步执行——body.messages 为
// 非数组真值（`??` 只挡 null/undefined，`{}`/`42`/字符串会漏过）或单条 message 缺 parts 时，
// parseOpencodeMessages 抛 TypeError，逃逸 async 路由 -> 500，违反「<50ms 202 ack」契约。
// 真实 opencode 版本的 message 形态是文档化验证空缺，单个畸形 idle payload 即可触发 500，
// plugin 的 catch 吞掉错误但捕获信号被静默丢失而非记为 memory.capture 广播。
// 修复：parseOpencodeMessages 移入 IIFE try/catch + 入参/消息级 parts 守卫（跳过不抛）。
// 本测试锁定：畸形 messages -> 202（非 500）+ memory.capture 广播仍发（信号未丢）。
test('POST /hooks/opencode/capture 畸形 messages 仍 202（非 500）+ capture 广播', async () => {
  const opencodeFake: RuntimeAdapter = {
    kind: 'opencode',
    capture: async () => [],
    inject: async () => '',
  }
  const enqueueCalls: { runtime: string; cwd: string; debounceKey: string; sessionId?: string }[] = []
  const bc: unknown[] = []
  const app = createApp({
    db,
    adapter: new ClaudeCodeAdapter(db),
    opencodeAdapter: opencodeFake,
    enqueueDistillJob: async (_d, input) => { enqueueCalls.push(input); return { jobId: 'j3', nextRunAt: 0 } },
    broadcast: (m: unknown) => { bc.push(m) },
  })

  // 畸形用例 1：messages 是非数组真值（字符串）——`??` 不挡，须 Array.isArray 守卫
  const res1 = await app.request('/hooks/opencode/capture', {
    method: 'POST',
    body: JSON.stringify({ sessionId: 's1', cwd: '/p', messages: 'not-an-array' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res1.status).toBe(202) // 关键断言：202 非 500
  expect(bc.some((m: any) => m.type === 'memory.capture')).toBe(true) // 捕获信号未丢

  // 畸形用例 2：单条 message 缺 parts（真实 opencode 版本可能的形态偏差）
  const bc2: unknown[] = []
  const app2 = createApp({
    db,
    adapter: new ClaudeCodeAdapter(db),
    opencodeAdapter: opencodeFake,
    enqueueDistillJob: async (_d, input) => { enqueueCalls.push(input); return { jobId: 'j4', nextRunAt: 0 } },
    broadcast: (m: unknown) => { bc2.push(m) },
  })
  const res2 = await app2.request('/hooks/opencode/capture', {
    method: 'POST',
    body: JSON.stringify({ sessionId: 's2', cwd: '/p', messages: [{ info: { role: 'user' } }] }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res2.status).toBe(202) // 关键断言：202 非 500
  expect(bc2.some((m: any) => m.type === 'memory.capture')).toBe(true) // 捕获信号未丢
})
