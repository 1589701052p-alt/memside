// 锁 spec 2026-08-18 §6：暂停任务/待审查候选 UI 可见 + 重试/放弃按钮 + 重试轮次。
// 源码层文本断言（CLAUDE.md：运行时巨型组件难直接覆盖时，最低限度保留一条源代码
// 层文本断言兜底）。App.tsx 必须含这些 token，否则 UI 静默 stall 暂停任务/待审查候选。
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const app = readFileSync('src/web/App.tsx', 'utf-8')

describe('resume UI tokens', () => {
  test('有"已暂停"标记', () => expect(app).toContain('已暂停'))
  test('有重试按钮', () => expect(app).toMatch(/重试|retry/i))
  test('有放弃按钮', () => expect(app).toMatch(/放弃|abandon/i))
  test('有重试轮次显示', () => expect(app).toMatch(/轮|attempt|round/i))
  test('有待审查候选区块', () => expect(app).toContain('待审查'))
})
