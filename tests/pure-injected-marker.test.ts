import { test, expect } from 'bun:test'
import { isInjectedMemoryBlock, INJECTED_MEMORY_MARKER, formatMemoryBlock } from '@/memory/pure'

/**
 * 注入记忆块 marker 识别（spec 2026-08-20 §3.3）。
 * 背景：SessionStart 注入的记忆块泄进 transcript 当 user 行（实测 200 文件 15 中），
 * 且这些行无任何官方来源字段——marker 是唯一可识别信号（claude+opencode 共用）。
 * marker 漂移（formatMemoryBlock 改格式）必须让本文件变红，强制同步。
 */

test('INJECTED_MEMORY_MARKER 字面量锁定（漂移即红）', () => {
  expect(INJECTED_MEMORY_MARKER).toBe('--- BEGIN INJECTED MEMORY ---')
})

test('formatMemoryBlock 产出含 marker（marker 漂移守卫）', () => {
  const row = {
    id: 'm1', scopeType: 'global' as const, scopeId: null, runtime: 'claude-code' as const,
    title: '[category:invariant] x', bodyMd: 'y', createdAt: 0, version: 1, tags: [],
  }
  const block = formatMemoryBlock({ byScope: { project: [], global: [row] } })
  expect(block).toContain(INJECTED_MEMORY_MARKER)
})

test('含 BEGIN marker → true', () => {
  expect(isInjectedMemoryBlock('## Learned context (auto-injected, advisory)\n\n--- BEGIN INJECTED MEMORY ---')).toBe(true)
})

test('完整注入块 → true', () => {
  expect(isInjectedMemoryBlock('--- BEGIN INJECTED MEMORY ---\n- [x] some memory\n--- END INJECTED MEMORY ---')).toBe(true)
})

test('普通用户文本 → false', () => {
  expect(isInjectedMemoryBlock('we only issue refunds within 14 days')).toBe(false)
})

test('loop 注解 / task 通知 → false', () => {
  expect(isInjectedMemoryBlock('[1 prior /loop wakeup found nothing actionable; loop is healthy.]')).toBe(false)
  expect(isInjectedMemoryBlock('<task-notification><task-id>a</task-id></task-notification>')).toBe(false)
})

test('非 string 入参 → false（永不抛）', () => {
  expect(isInjectedMemoryBlock(null)).toBe(false)
  expect(isInjectedMemoryBlock(undefined)).toBe(false)
  expect(isInjectedMemoryBlock(123)).toBe(false)
  expect(isInjectedMemoryBlock({})).toBe(false)
})
