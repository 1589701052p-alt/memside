// 多选 + 批量操作条 + 导出/导入入口接线（spec 2026-08-16 task-10）。源码层文本
// 断言兜底：锁定 selectedIds state、批量操作条 token、导出/导入入口与 API 接入
// 点、冲突策略选项。一旦未来 refactor 误删任一接线点就变红，让意图一眼可辨。
// 运行时巨型组件难直接覆盖，源码层断言是 CLAUDE.md 认可的最低限度兜底。
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(import.meta.dir, '../src/web/App.tsx'), 'utf8')

test('App.tsx 含多选 + 批量操作条 token', () => {
  expect(src).toContain('selectedIds')
  expect(src).toContain('已选')
  expect(src).toContain('批量删除')
})

test('App.tsx 含导出/导入入口 token', () => {
  expect(src).toContain('导出')
  expect(src).toContain('导入')
  expect(src).toContain('exportMemories')
  expect(src).toContain('importMemories')
})

test('App.tsx 含冲突策略选项 token', () => {
  expect(src).toContain('跳过已存在')
  expect(src).toContain('覆盖已存在')
  expect(src).toContain('全部新建')
})
