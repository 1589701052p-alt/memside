import { test, expect } from 'bun:test'
import { memoryTabFilter, hasCachedData, shouldShowLoading } from '../src/web/tab-cache'

// Task 1（perf/tab-switch-cache）：tab 切换 stale-while-revalidate 缓存的纯函数。
// 数据按 tab 缓存，回访直接渲染缓存 + 后台刷新。纯函数层可单测（CLAUDE.md「首选可断言面」）。

test('memoryTabFilter 三映射（candidate/approved/rejected）', () => {
  expect(memoryTabFilter('candidate')).toBe('candidate')
  expect(memoryTabFilter('approved')).toBe('approved,archived,superseded')
  expect(memoryTabFilter('rejected')).toBe('rejected')
})

test('hasCachedData：loaded[tab] 真值判断', () => {
  expect(hasCachedData({ candidate: true }, 'candidate')).toBe(true)
  expect(hasCachedData({ candidate: true }, 'approved')).toBe(false)
  expect(hasCachedData({}, 'candidate')).toBe(false)
  expect(hasCachedData({ candidate: false }, 'candidate')).toBe(false)
})

test('shouldShowLoading：无缓存 + 在拉 = true', () => {
  expect(shouldShowLoading({}, { candidate: true }, 'candidate')).toBe(true)
})

test('shouldShowLoading：有缓存（无论是否在拉）= false', () => {
  expect(shouldShowLoading({ candidate: true }, { candidate: true }, 'candidate')).toBe(false)
  expect(shouldShowLoading({ candidate: true }, { candidate: false }, 'candidate')).toBe(false)
})

test('shouldShowLoading：无缓存不在拉 = false', () => {
  expect(shouldShowLoading({}, { candidate: false }, 'candidate')).toBe(false)
  expect(shouldShowLoading({}, {}, 'candidate')).toBe(false)
})