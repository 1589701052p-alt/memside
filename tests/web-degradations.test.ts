// tests/web-degradations.test.ts
// 蒸馏 modal degradations 区接线 + 横幅退役反向锁。
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('降级横幅与 modal 呈现（源码断言）', () => {
  test('降级横幅与全局 ack 已由消息中心取代（反向锁）', () => {
    const src = readFileSync('src/web/App.tsx', 'utf8')
    expect(src).not.toContain('recentDegradations')
    expect(src).not.toContain('/api/degradations/ack')
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
