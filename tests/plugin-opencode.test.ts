import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

const js = readFileSync(new URL('../opencode-plugin/memside.js', import.meta.url), 'utf-8')

test('plugin 注册两钩子', () => {
  expect(js).toContain("'experimental.chat.messages.transform'")
  expect(js).toContain('session.idle')
})

test('plugin 端口 env 优先烘焙回退', () => {
  expect(js).toContain('process.env.MEMSIDE_PORT')
  expect(js).toContain('__MEMSIDE_PORT__')
})

test('inject 幂等守卫标记', () => {
  expect(js).toContain('--- BEGIN INJECTED MEMORY ---')
})

test('best-effort catch 不抛回 opencode', () => {
  expect(js).toMatch(/catch/)
})

// --- live-smoke 回归守卫（2026-07-31 真实 opencode 1.15.5 验证产出的修复）---
// 这三条是 live smoke 在真实 opencode + Bun 1.3.14 + 系统代理 :7897 环境下暴露的
// 必修缺陷；plugin 是 opencode 进程内加载的独立 JS（无 TS import），运行时行为只能
// live 验证，故用源码层文本断言兜底（CLAUDE.md「最低限度保留一条源代码层文本断言」）。
// 任一修复被回退 -> 测试红 -> 立刻看出意图。

test('NO_PROXY 旁路 loopback（bun fetch 会代理 127.0.0.1 导致 502）', () => {
  // bun fetch 原生尊重 HTTP_PROXY 且不豁免 loopback；不追加 NO_PROXY 则 capture+inject
  // 双双被系统代理拦截静默 502。必须追加（非覆盖）127.0.0.1,localhost。
  expect(js).toContain('NO_PROXY')
  expect(js).toMatch(/127\.0\.0\.1.*localhost|localhost.*127\.0\.0\.1/)
  // 追加而非覆盖：保留用户既有 NO_PROXY
  expect(js).toMatch(/process\.env\.NO_PROXY.*\+/)
})

test('session.messages 用 path:{id} 签名（非旧 {sessionID}）', () => {
  // opencode SDK 期望 { path: { id: sessionID } }；旧 { sessionID } 会把字面量对象
  // 拼进 URL -> "%7Bid%7D" -> SDK 报 "Expected a string starting with ses"。
  expect(js).toContain('client.session.messages({ path: { id: sessionID } })')
  expect(js).not.toContain('client.session.messages({ sessionID })')
})

test('messages 响应归一化兜底 Array.isArray(res.data)', () => {
  // SDK 返回形态可能是数组或 {messages:[]}；用 Array.isArray 判别取真值，避免
  // 形态变更导致 capture 存空 transcript -> distill skipped_no_new_turns。
  expect(js).toContain('Array.isArray(res.data)')
})
