// tests/web-ui-utils.test.ts
// Task 9 纯函数层测试（spec §4.9）：skipped_trivial 徽标 + 降级 kind 人话映射。
// 8 个 kind 中文标签逐字锁死——UI 直接渲染，措辞回归必须红。
import { describe, test, expect } from 'bun:test'
import { formatOutcome, degradationKindLabel } from '@/web/ui-utils'

describe('formatOutcome skipped_trivial（spec §4.9）', () => {
  test('新 outcome 有专属徽标', () => {
    expect(formatOutcome('skipped_trivial')).toEqual({ label: '琐碎跳过', color: '#999' })
  })
  test('未知 outcome 兜底不空白', () => {
    const r = formatOutcome('some_future_outcome' as never)
    expect(r.label.length).toBeGreaterThan(0)
  })
})

describe('degradationKindLabel', () => {
  test('已知 kind 人话映射；未知 kind 原样返回', () => {
    expect(degradationKindLabel('digest_llm_failed')).toBe('滚动摘要失败')
    expect(degradationKindLabel('threshold_compute_error')).toBe('阈值计算失败')
    expect(degradationKindLabel('capture_persist_failed')).toBe('捕获存储失败')
    expect(degradationKindLabel('flush_mark_failed')).toBe('flush标记失败')
    expect(degradationKindLabel('digest_read_failed')).toBe('摘要读取失败')
    expect(degradationKindLabel('titles_query_failed')).toBe('已审批查询失败')
    expect(degradationKindLabel('sweep_error')).toBe('sweep异常')
    expect(degradationKindLabel('digest_truncated')).toBe('摘要超长截断')
    expect(degradationKindLabel('whatever')).toBe('whatever')
  })
})
