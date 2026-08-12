// tracker 单例双侧注入（spec 2026-08-12 §5.7）：startDaemon 源码层断言兜底。
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(import.meta.dir, '..', 'src', 'daemon.ts'), 'utf8')

test('startDaemon 创建唯一 tracker 并注入 createApp 与 tickDeps', () => {
  expect(src).toContain("import { createActivityTracker } from './activity'")
  expect(src).toContain('const tracker = createActivityTracker()')
  expect(src).toContain('tracker')  // 双侧注入见下两条精确断言
  expect(src).toMatch(/createApp\(\{[^}]*tracker/s)
  expect(src).toMatch(/const tickDeps: TickDeps = \{[^}]*tracker/s)
})

test('tracker 只创建一次（单例）', () => {
  expect(src.match(/createActivityTracker\(\)/g)?.length).toBe(1)
})
