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