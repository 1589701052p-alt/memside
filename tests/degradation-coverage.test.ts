// tests/degradation-coverage.test.ts
// 降级可见化守卫（spec §5 配套硬约束）：每个降级点必须有 logDegradation 调用。
// grep 级源码守卫——重构若把某个 kind 的落表调用删成静默吞错，本文件必须变红。
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('降级点 logDegradation 覆盖（grep 级守卫）', () => {
  const kinds = [
    'threshold_compute_error', 'capture_persist_failed', 'flush_mark_failed',
    'digest_llm_failed', 'digest_read_failed', 'titles_query_failed',
    'sweep_error', 'digest_truncated',
  ]
  test('spec §5 全部 kind 在 src/ 有落表调用点', () => {
    const files = ['src/server.ts', 'src/scheduler.ts', 'src/memory/store.ts', 'src/memory/rollingSummary.ts']
    const all = files.map((f) => readFileSync(f, 'utf8')).join('\n')
    for (const k of kinds) {
      // 每个 kind 字符串必须出现在 src/ 生产点（logDegradation 调用处）；
      // ui-utils 的人话映射不算生产点，不计入。
      expect(all.includes(`'${k}'`)).toBe(true)
    }
  })
  test('logDegradation 自身失败是唯一 console-only 路径（源码锁注释）', () => {
    const src = readFileSync('src/memory/store.ts', 'utf8')
    expect(src).toContain('logDegradation failed')
  })
})
