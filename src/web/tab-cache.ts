/**
 * Tab 切换 stale-while-revalidate 缓存的纯函数（可单测，不依赖 React / DOM）。
 * 数据按 tab 缓存，回访直接渲染缓存 + 后台刷新。Task 2 的 App.tsx 重构使用。
 *
 * 设计依据：docs/superpowers/specs/2026-08-06-tab-switch-cache-design.md。
 */

export type MemoryTabKey = 'candidate' | 'approved' | 'rejected'

/** tab 键 -> 后端 state 过滤串。approved 含 archived/superseded 历史态。 */
export function memoryTabFilter(tab: MemoryTabKey): string {
  if (tab === 'approved') return 'approved,archived,superseded'
  return tab
}

/** 该 tab 是否已加载过缓存（loaded[tab] 真值）。 */
export function hasCachedData(loaded: Record<string, boolean>, tab: string): boolean {
  return loaded[tab] === true
}

/** 该 tab 是否应显示加载态：无缓存且正在拉取。 */
export function shouldShowLoading(
  loaded: Record<string, boolean>,
  pending: Record<string, boolean>,
  tab: string,
): boolean {
  return !hasCachedData(loaded, tab) && pending[tab] === true
}

// --- 无限滚动分页（spec 2026-08-07）----------------------------------------

/**
 * 轮询刷第 1 页后的合并：第一页（最新数据）原样置前；已加载列表中 id 不在
 * 第一页的条目按原顺序追加。第一页里的老 id 用第一页版本（状态可能已变）。
 */
export function mergePage<T>(loaded: T[], firstPage: T[], key: (t: T) => string): T[] {
  const inFirst = new Set(firstPage.map(key))
  return [...firstPage, ...loaded.filter((t) => !inFirst.has(key(t)))]
}

/** loadMore 追加合并：幂等去重（守卫失效导致重复拉同一页时不产生重复卡片）。 */
export function mergeAppend<T>(loaded: T[], nextPage: T[], key: (t: T) => string): T[] {
  const seen = new Set(loaded.map(key))
  return [...loaded, ...nextPage.filter((t) => !seen.has(key(t)))]
}

/** 翻页游标推进：hasMore=false 或无游标 -> null（不再发 loadMore）。 */
export function nextCursorAfter<T>(page: { hasMore: boolean; nextCursor: { ts: number; id: string } | null }): { ts: number; id: string } | null {
  return page.hasMore ? page.nextCursor : null
}