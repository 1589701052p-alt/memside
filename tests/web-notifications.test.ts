// 消息 tab 接线（spec 2026-08-12 §5.10）。源码层文本断言兜底。
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const appSrc = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')

test('消息 tab 数据流接线', () => {
  expect(appSrc).toContain('listNotificationsPage')
  expect(appSrc).toContain('markNotificationRead')
  expect(appSrc).toContain('markAllNotificationsRead')
  expect(appSrc).toContain('notificationTitle')
  expect(appSrc).toContain('全部已读')
  expect(appSrc).toContain('暂无消息')
})

test('消息筛选三件：kind 下拉 / 仅未读 / 关键词', () => {
  expect(appSrc).toContain("kind === 'degradation'")
  expect(appSrc).toContain("kind === 'llm_error'")
  expect(appSrc).toContain('unreadOnly')
})
