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
