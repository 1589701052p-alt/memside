// 状态栏 LLM 实况接线 + 旧噪音移除（spec 2026-08-12 §5.10）。源码层文本断言兜底。
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')

test('状态栏接 LLM 实况与消息入口', () => {
  expect(src).toContain('llmActivity')
  expect(src).toContain('llmStats24h')
  expect(src).toContain('unreadNotifications')
  expect(src).toContain('phaseLabel')
  expect(src).toContain('formatElapsed')
  expect(src).toContain('formatPhaseStat')
  expect(src).toContain("setTab('messages')")
  expect(src).toContain('近24h')
})

test('旧状态栏噪音不得复活（反向锁）', () => {
  expect(src).not.toContain('已捕获事件')
  expect(src).not.toContain('最近错误')
  expect(src).not.toContain('ackDegradations')
  expect(src).not.toContain('recentDegradations')
  expect(src).not.toContain('知道了')
})
