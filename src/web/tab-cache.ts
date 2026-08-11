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

/**
 * 轮询刷第 1 页后的整页合并：items 按 mergePage 语义合并，但游标/hasMore
 * 只在「旧列表为空」（首载或 emptyPage 重置后首次刷新）时采用页 1 响应值；
 * 已加载过条目时保留旧值——游标语义 = 已加载尾部位置，页 1 轮询只刷顶部，
 * 若用页 1 的游标覆盖会把翻页进度重置回第一页末尾，loadMore 因此反复拉到
 * 已加载的重复页（实测 bug：滚动永远卡在第二页）。
 */
export function mergeRefreshPage<T>(
  oldPage: { items: T[]; nextCursor: { ts: number; id: string } | null; hasMore: boolean },
  firstPage: { items: T[]; nextCursor: { ts: number; id: string } | null; hasMore: boolean },
  key: (t: T) => string,
): { items: T[]; nextCursor: { ts: number; id: string } | null; hasMore: boolean } {
  const items = mergePage(oldPage.items, firstPage.items, key)
  if (oldPage.items.length === 0) {
    return { items, nextCursor: firstPage.nextCursor, hasMore: firstPage.hasMore }
  }
  return { items, nextCursor: oldPage.nextCursor, hasMore: oldPage.hasMore }
}

/** 翻页游标推进：hasMore=false 或无游标 -> null（不再发 loadMore）。 */
export function nextCursorAfter<T>(page: { hasMore: boolean; nextCursor: { ts: number; id: string } | null }): { ts: number; id: string } | null {
  return page.hasMore ? page.nextCursor : null
}

// --- tab 实际总数（status 派生）---------------------------------------------

/** tabTotalCount 依赖的 status 计数子集（与 api.ts MemsideStatus 结构兼容）。 */
export interface TabStatusCounts {
  memories: Record<string, number>
  discards: number
  distillRuns?: { total: number; allTime?: number }
}

/**
 * 各 tab 列表头的「实际总数」：必须来自服务端全表计数（/api/status），
 * 不是前端已加载条数——分页后 items.length 只是前 N 页，当总数会误导用户
 * （2026-08-07 实测反馈）。approved 含 archived/superseded 历史态（与 tab
 * 徽标同公式）；runs 用 allTime 全量（distillRuns.total 只是 24h 活动窗口），
 * 老 daemon 无 allTime 时降级 total。status 未就绪返回 null（调用方回退
 * 已加载条数）。
 */
export function tabTotalCount(
  s: TabStatusCounts | null,
  tab: 'candidate' | 'approved' | 'rejected' | 'discards' | 'runs',
): number | null {
  if (!s) return null
  switch (tab) {
    case 'candidate': return s.memories.candidate ?? 0
    case 'approved': return (s.memories.approved ?? 0) + (s.memories.archived ?? 0) + (s.memories.superseded ?? 0)
    case 'rejected': return s.memories.rejected ?? 0
    case 'discards': return s.discards
    case 'runs': return s.distillRuns?.allTime ?? s.distillRuns?.total ?? 0
  }
}

// --- 设置 tab（spec 2026-08-07 settings-tab §3.2）---------------------------

/**
 * 该 tab 是否走列表数据流（refresh / loadMore / 轮询 / 无限滚动 / 列表尾部）。
 * settings tab 无列表：不进这些入口——它只在激活时挂载设置区块，区块自管理
 * fetch/保存/错误行。新增非列表 tab 时此函数是唯一需要改的判据。
 */
export function isListTab(tab: string): boolean {
  return tab !== 'settings'
}

// --- 记忆列表筛选（spec 2026-08-11-web-memory-filters §4.3）----------------

/** 四维筛选状态；空串 = 不筛该维度。跨 tab 共享（App 单一 state）。 */
export interface MemoryFilter { project: string; slug: string; category: string; valueClass: string }

export const EMPTY_MEMORY_FILTER: MemoryFilter = { project: '', slug: '', category: '', valueClass: '' }

/** 任一维非空 -> 筛选激活。 */
export function hasActiveFilter(f: MemoryFilter): boolean {
  return f.project !== '' || f.slug !== '' || f.category !== '' || f.valueClass !== ''
}