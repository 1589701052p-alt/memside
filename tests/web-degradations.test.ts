// tests/web-degradations.test.ts
// Task 9 源码层文本断言（CLAUDE.md 运行时兜底面）：React 组件不单测，
// 锁 App.tsx 的降级横幅 / ack 调用 / 蒸馏 modal degradations 区接线。
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('降级横幅与 modal 呈现（源码断言）', () => {
  test('App.tsx 含降级横幅与 ack 调用', () => {
    const src = readFileSync('src/web/App.tsx', 'utf8')
    expect(src).toContain('recentDegradations')
    expect(src).toContain('/api/degradations/ack')
    expect(src).toContain('次降级')
  })
  test('App.tsx 蒸馏 modal 含 degradations 区', () => {
    const src = readFileSync('src/web/App.tsx', 'utf8')
    expect(src).toContain('/degradations')
  })
})
