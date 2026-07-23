import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// 源代码层文本断言兜底（CLAUDE.md）：React 组件不便于单测，至少锁住"来源"
// 标注与 scope 编辑入口存在于 App.tsx。一旦被 refactor 删除会立刻变红。
const src = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')

test('App.tsx annotates source project', () => {
  expect(src).toContain('来源')
  expect(src).toContain('sourceCwd')
})

test('App.tsx exposes a scope edit control', () => {
  expect(src).toContain('scopeType')
})

test('App.tsx surfaces edit errors (spec §8)', () => {
  expect(src).toContain('editError')
})

// Task 8: 价值优先级排序 + valueClass 徽标 + 批量拒绝未评估。
// 派生优先级标签(高·决策 等) + 未评估 占位 + 批量拒绝按钮文案。
// 一旦 refactor 删掉这些 UI 锚点会立刻变红。
test('App.tsx renders valueClass badge labels and bulk-reject button (source text)', () => {
  // 派生优先级标签
  expect(src).toContain('高·决策')
  expect(src).toContain('未评估')
  // 批量拒绝未评估按钮
  expect(src).toContain('批量拒绝未评估')
})
