// 回收站 tab 接线（spec 2026-08-16 task-9）。源码层文本断言兜底：锁定 trash
// tab、TrashCard 组件、清空/恢复按钮、API 调用接入点。一旦未来 refactor 误删
// 任一接线点就变红，让意图一眼可辨。运行时巨型组件难直接覆盖，源码层断言是
// CLAUDE.md 认可的最低限度兜底。
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')

test('回收站 tab 注册进 TabKey', () => {
  // TabKey 联合包含 'trash'（isListTab('trash') 已在 tab-cache 返回 true）
  expect(src).toMatch(/type TabKey = .*'trash'/)
})

test('回收站 tab 项挂进 tabs 数组', () => {
  expect(src).toContain("{ key: 'trash', label: '回收站'")
})

test('TrashCard 组件存在', () => {
  expect(src).toContain('function TrashCard')
})

test('回收站 API client 已导入', () => {
  expect(src).toContain('listTrashPage')
  expect(src).toContain('emptyTrash')
  expect(src).toContain('restoreFromTrash')
})

test('清空回收站按钮接线', () => {
  expect(src).toContain('清空回收站')
  expect(src).toContain('emptyTrashClick')
})

test('恢复按钮接线', () => {
  expect(src).toContain('恢复')
  expect(src).toContain('restoreTrash')
})
