import { test, expect } from 'bun:test'
import { memoryTabFilter, hasCachedData, shouldShowLoading, mergePage, mergeAppend, mergeRefreshPage, nextCursorAfter, tabTotalCount, isListTab, hasActiveFilter, EMPTY_MEMORY_FILTER } from '../src/web/tab-cache'

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

// --- 回归（2026-08-07 实测 bug）：3s 轮询 refresh 不得用页 1 响应覆盖已翻深的游标 ---
//  bug 现象：翻到 100 条后轮询把 nextCursor 重置回页 1 末尾，loadMore 反复拉到
//  已加载的重复页、mergeAppend 全去重，无限滚动永远卡在第一页之后一页。
//  游标语义 = 已加载列表的尾部位置；页 1 轮询只刷顶部，不动尾部。

test('mergeRefreshPage: 已翻深的列表保留旧游标与 hasMore（不被页 1 覆盖）', () => {
  const old = {
    items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
    nextCursor: { ts: 100, id: 'd' }, // 已翻到 d 之后
    hasMore: true,
  }
  const firstPage = {
    items: [{ id: 'n' }, { id: 'a' }], // 页 1 轮询：新条目 n + a 新版
    nextCursor: { ts: 300, id: 'a' }, // 页 1 自己的游标——不得采用
    hasMore: true,
  }
  const merged = mergeRefreshPage(old, firstPage, (t) => t.id)
  expect(merged.items.map((t) => t.id)).toEqual(['n', 'a', 'b', 'c', 'd']) // mergePage 语义不变
  expect(merged.nextCursor).toEqual({ ts: 100, id: 'd' }) // 游标保留旧值
  expect(merged.hasMore).toBe(true)
})

test('mergeRefreshPage: 已全部加载（hasMore=false）不被页 1 的 true 复活', () => {
  const old = { items: [{ id: 'a' }], nextCursor: { ts: 1, id: 'a' }, hasMore: false }
  const firstPage = { items: [{ id: 'n' }, { id: 'a' }], nextCursor: { ts: 9, id: 'a' }, hasMore: true }
  const merged = mergeRefreshPage(old, firstPage, (t) => t.id)
  expect(merged.items.map((t) => t.id)).toEqual(['n', 'a'])
  expect(merged.hasMore).toBe(false) // 新条目在顶部，不影响「没有更老的」
  expect(merged.nextCursor).toEqual({ ts: 1, id: 'a' })
})

test('mergeRefreshPage: 空旧列表（首载 / emptyPage 重置后）采用页 1 的游标', () => {
  const old = { items: [] as { id: string }[], nextCursor: null, hasMore: true }
  const firstPage = { items: [{ id: 'a' }], nextCursor: { ts: 5, id: 'a' }, hasMore: true }
  const merged = mergeRefreshPage(old, firstPage, (t) => t.id)
  expect(merged.items.map((t) => t.id)).toEqual(['a'])
  expect(merged.nextCursor).toEqual({ ts: 5, id: 'a' })
  expect(merged.hasMore).toBe(true)
})

test('mergeRefreshPage: 空旧列表 + 页 1 也不足一页 → hasMore=false 落准', () => {
  const old = { items: [] as { id: string }[], nextCursor: null, hasMore: true }
  const firstPage = { items: [{ id: 'a' }], nextCursor: null, hasMore: false }
  const merged = mergeRefreshPage(old, firstPage, (t) => t.id)
  expect(merged.hasMore).toBe(false)
  expect(merged.nextCursor).toBeNull()
})

// --- 回归（2026-08-07 用户反馈）：tab 列表头计数必须是服务端全表总数， ---
//  不是前端已加载条数（分页后 items.length 只是一页，当总数会误导用户）。

test('tabTotalCount: 五 tab 各自取服务端全表计数', () => {
  const s = {
    memories: { candidate: 538, approved: 100, archived: 5, superseded: 2, rejected: 2554 },
    discards: 673,
    distillRuns: { total: 7, allTime: 413 },
  }
  expect(tabTotalCount(s, 'candidate')).toBe(538)
  expect(tabTotalCount(s, 'approved')).toBe(107) // approved+archived+superseded（与徽标同公式）
  expect(tabTotalCount(s, 'rejected')).toBe(2554)
  expect(tabTotalCount(s, 'discards')).toBe(673)
  expect(tabTotalCount(s, 'runs')).toBe(413) // allTime 全量，不是 24h 窗口的 total=7
})

test('tabTotalCount: status 缺字段/老 daemon 降级', () => {
  expect(tabTotalCount(null, 'candidate')).toBeNull() // status 未就绪
  expect(tabTotalCount({ memories: {}, discards: 0 }, 'approved')).toBe(0) // 缺 status key -> 0
  // 老 daemon 无 allTime -> 降级 total；distillRuns 整个缺 -> 0
  expect(tabTotalCount({ memories: {}, discards: 0, distillRuns: { total: 7 } }, 'runs')).toBe(7)
  expect(tabTotalCount({ memories: {}, discards: 0 }, 'runs')).toBe(0)
})

// --- 设置 tab（docs/superpowers/specs/2026-08-07-settings-tab-design.md §3.2）---

test('isListTab: 五个列表 tab 全 true，settings false', () => {
  expect(isListTab('candidate')).toBe(true)
  expect(isListTab('approved')).toBe(true)
  expect(isListTab('rejected')).toBe(true)
  expect(isListTab('discards')).toBe(true)
  expect(isListTab('runs')).toBe(true)
  expect(isListTab('settings')).toBe(false)
})

// --- 2026-08-11 记忆列表筛选（spec web-memory-filters §4.3）---

test('hasActiveFilter: 全空 false，任一维非空 true', () => {
  expect(hasActiveFilter({ project: '', slug: '', category: '', valueClass: '' })).toBe(false)
  expect(hasActiveFilter({ project: 'C:/x', slug: '', category: '', valueClass: '' })).toBe(true)
  expect(hasActiveFilter({ project: '', slug: 's', category: '', valueClass: '' })).toBe(true)
  expect(hasActiveFilter({ project: '', slug: '', category: 'trap', valueClass: '' })).toBe(true)
  expect(hasActiveFilter({ project: '', slug: '', category: '', valueClass: 'unevaluated' })).toBe(true)
})

test('EMPTY_MEMORY_FILTER 四维全空且未激活', () => {
  expect(EMPTY_MEMORY_FILTER).toEqual({ project: '', slug: '', category: '', valueClass: '' })
  expect(hasActiveFilter(EMPTY_MEMORY_FILTER)).toBe(false)
})