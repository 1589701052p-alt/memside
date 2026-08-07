import { test, expect } from 'bun:test'
import { memoryTabFilter, hasCachedData, shouldShowLoading, mergePage, mergeAppend, nextCursorAfter } from '../src/web/tab-cache'

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

// --- Task 6：分页合并纯函数（docs/superpowers/specs/2026-08-07-tab-list-pagination-design.md）---

test('mergePage: 第一页优先 + id 去重 + 老条目保序追加', () => {
  const loaded = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }, { id: 'c', v: 1 }]
  const first = [{ id: 'n', v: 9 }, { id: 'a', v: 2 }] // a 有新版本
  const merged = mergePage(loaded, first, (t) => t.id)
  expect(merged.map((t) => t.id)).toEqual(['n', 'a', 'b', 'c'])
  expect(merged[1]!.v).toBe(2) // 第一页数据赢
})

test('mergePage: 空 loaded / 空 firstPage', () => {
  expect(mergePage([], [{ id: 'x' }], (t) => t.id).map((t) => t.id)).toEqual(['x'])
  expect(mergePage([{ id: 'x' }], [], (t) => t.id).map((t) => t.id)).toEqual(['x'])
})

test('mergeAppend: 追加去重（重复拉同一页不产生重复卡片）', () => {
  const loaded = [{ id: 'a' }, { id: 'b' }]
  const next = [{ id: 'b', v: 2 }, { id: 'c' }]
  const merged = mergeAppend(loaded, next, (t) => t.id)
  expect(merged.map((t) => t.id)).toEqual(['a', 'b', 'c'])
  expect(merged[1]).toEqual({ id: 'b' }) // 已存在条目不被覆盖（保持 loaded 版）
})

test('nextCursorAfter: hasMore 真返回游标，假/缺游标返回 null', () => {
  expect(nextCursorAfter({ hasMore: true, nextCursor: { ts: 1, id: 'a' } })).toEqual({ ts: 1, id: 'a' })
  expect(nextCursorAfter({ hasMore: false, nextCursor: { ts: 1, id: 'a' } })).toBeNull()
  expect(nextCursorAfter({ hasMore: true, nextCursor: null })).toBeNull()
})