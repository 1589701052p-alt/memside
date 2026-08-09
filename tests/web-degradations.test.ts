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
  // runs 行降级徽标（spec §4.9 终审修复）：有 degradations 的 run 在 outcome 徽标旁
  // 渲染琥珀色「降级」mini-badge，提示明细可看（明细在 modal 区）。
  test('DistillRunRow 渲染 runs 行降级徽标（hasDegradations）', () => {
    const src = readFileSync('src/web/App.tsx', 'utf8')
    expect(src).toContain('r.hasDegradations')
    expect(src).toContain('>降级</span>')
  })
})
