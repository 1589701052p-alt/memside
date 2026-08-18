import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import {
  listMemoriesPage, listDiscardsPage, listDistillRunsPage, WEB_PAGE_SIZE,
  promoteMemory, patchMemory, getStatus, getSourceInput,
  restoreMemory, archiveMemory, unarchiveMemory, promoteDiscard,
  getDistillRun, getDistillRunSourceInput, getRunDegradations,
  getLlmSettings, saveLlmSettings, testLlmConnection, testEffectiveLlmConnection,
  fetchJudgeConfig, saveJudgeConfig, startRescan, cancelRescan,
  getRuntimeSettings, saveRuntimeSettings, installRuntimeHooks, uninstallRuntimeHooks,
  getFacets, UNEVALUATED,
  listNotificationsPage, markNotificationRead, markAllNotificationsRead,
  bulkRejectUnevaluated as bulkRejectUnevaluatedApi,
  listTrashPage, emptyTrash, restoreFromTrash,
  bulkDelete, exportMemories, importMemories as importMemoriesApi,
  retryJob, abandonJob, listPendingReview, promotePendingReview,
  type MemoryItem, type MemsideStatus, type SourceInput, type SourceTurn, type DiscardItem,
  type DistillRunListItem, type LlmSettingsState, type JudgeConfigDto, type Facets, type FacetTab,
  type RuntimeSettingsState,
  type NotificationItem,
  type TrashItem,
} from './api'
import { formatMemoryTime, sortCandidatesByTime, formatSourceTurn, formatOutcome, formatRunCounts, llmSourceLabel, originBadge, discardReasonLabel, rescanPercent, degradationKindLabel, formatToolCall, projectDisplayName, categoryInfo, categoryFromTitle, stripCategoryPrefix, valueClassInfo, scopeInfo, runtimeLabel, runtimeTip, phaseLabel, formatElapsed, formatPhaseStat, notificationTitle, truncateAlertBody, SLUG_BADGE_TIP } from './ui-utils'
import { memoryTabFilter, shouldShowLoading, mergeAppend, mergeRefreshPage, nextCursorAfter, tabTotalCount, isListTab, hasActiveFilter, EMPTY_MEMORY_FILTER, type MemoryTabKey, type MemoryFilter } from './tab-cache'
import { resolveClaudePath, resolveOpencodePath } from './runtime-paths'

/**
 * 徽章 chip 通用样式（spec 2026-08-11-ui-clarity §6.1 规则 1）。语义映射全部在
 * ui-utils 纯函数（categoryInfo/valueClassInfo/scopeInfo/runtimeLabel），本文件
 * 只负责「分类：」「价值：」等前缀拼接与 title 悬停挂载。
 */
const CHIP_STYLE = {
  background: '#f5f5f5',
  border: '1px solid #e5e5e5',
  borderRadius: 4,
  padding: '2px 8px',
  fontSize: 12,
}

type TabKey = 'candidate' | 'approved' | 'rejected' | 'discards' | 'runs' | 'trash' | 'settings' | 'messages'

/** 带筛选条的 tab 判定（spec 2026-08-11-per-tab-memory-filters §4.4）。 */
function isFilterTab(t: TabKey): t is FacetTab {
  return t === 'candidate' || t === 'approved' || t === 'rejected' || t === 'discards'
}

/** 记忆三 tab 判定（spec 2026-08-16 task-10 多选）：只有这三 tab 有多选 + 批量操作条。 */
function isMemoryTab(t: TabKey): t is MemoryTabKey {
  return t === 'candidate' || t === 'approved' || t === 'rejected'
}

/**
 * 每 tab 的分页缓存形状（spec 2026-08-07 tab 列表分页）。items=已加载条目，
 * nextCursor=下一页游标（before），hasMore=是否还有更多。Task 8 无限滚动直接复用。
 */
interface TabPage<T> { items: T[]; nextCursor: { ts: number; id: string } | null; hasMore: boolean; total: number | null }
function emptyPage<T>(): TabPage<T> { return { items: [], nextCursor: null, hasMore: true, total: null } }

/**
 * 5+2 tab 视图：候选审批 / 已审批 / 已拒绝 / AI自动拒绝 / 蒸馏记录 五个列表 tab
 * + 设置 tab + 消息 tab（isListTab 判据区分，spec 2026-08-07 settings-tab）。顶部 tab 切换。每列表 tab
 * 独立数据源 + 操作 + 3s 轮询;切 tab 清旧 interval 建新的(useEffect 依赖 tab)。
 * 候选 tab 仍同时拉 status;其余 tab 也拉 status(计数徽标 + 状态栏)。
 *
 * 状态栏(后台可见性,spec 2026-08-12 §5.10):LLM 三阶段实况(蒸馏/去重/审查,
 * phaseLabel 双向映射 active 判定) + 🔔 消息入口(unreadNotifications 计数) +
 * 近24h 分阶段统计,让用户看到 daemon 在干活。fetch 失败显错误 banner,切 tab 显
 * 「加载中…」,空列表显对应文案,不静默 stall 出白页。
 *
 * 操作契约:no-throw(Task 7 carried finding)。restoreMemory/archiveMemory/
 * unarchiveMemory/promoteDiscard 不检查 res.ok,server 404/409 时返回 undefined。
 * UI 层不 catch,操作后调 refresh() 让列表自然更新(成功的会移动/消失,失败的因
 * 状态没变会留下),与现有 approve/reject 同模式。
 */
export default function App() {
  const [tab, setTab] = useState<TabKey>('candidate')
  const [memCache, setMemCache] = useState<Record<MemoryTabKey, TabPage<MemoryItem>>>({
    candidate: emptyPage(), approved: emptyPage(), rejected: emptyPage(),
  })
  const [discards, setDiscards] = useState<TabPage<DiscardItem>>(emptyPage())
  const [runs, setRuns] = useState<TabPage<DistillRunListItem>>(emptyPage())
  const [msgs, setMsgs] = useState<TabPage<NotificationItem>>(emptyPage())
  const [trash, setTrash] = useState<TabPage<TrashItem>>(emptyPage())
  // 待审查候选（spec §6.4）：judge 3 次失败暂停期间标的 pending_review 候选。
  // 候选审批 tab 用区块隔开显示，可手动 approve/reject/edit（复用 MemoryCard）。
  // 按当前 project 筛选拉取（sourceCwd，与 /api/memories?project= 同模式）。
  const [pendingReview, setPendingReview] = useState<MemoryItem[]>([])
  // 多选 + 批量操作条 + 导出/导入入口（spec 2026-08-16 task-10）：per-tab 选中集合，
  // 切 tab 清空（switchTab）。导出/导入用独立 modal，importResult 显导入摘要。
  const [selectedIds, setSelectedIds] = useState<Record<MemoryTabKey, Set<string>>>({ candidate: new Set(), approved: new Set(), rejected: new Set() })
  const [exportOpen, setExportOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importConflict, setImportConflict] = useState<'skip' | 'overwrite' | 'newid'>('skip')
  const [importResult, setImportResult] = useState<string | null>(null)
  // 消息筛选（spec §5.10）：kind 空串 = 全部；unreadOnly；q 关键词（300ms debounce 后入此态）
  const [msgFilter, setMsgFilter] = useState<{ kind: string; unreadOnly: boolean; q: string }>({ kind: '', unreadOnly: false, q: '' })
  const msgFilterRef = useRef(msgFilter)
  useEffect(() => { msgFilterRef.current = msgFilter })
  const [qInput, setQInput] = useState('')
  const qTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<Record<TabKey, boolean>>({ candidate: false, approved: false, rejected: false, discards: false, runs: false, trash: false, settings: false, messages: false })
  // candidate 初始 true:默认 tab 首帧即显「加载中…」,避免先闪一帧空态「暂无候选记忆」
  // (对齐重构前的初始 loading=true 行为)。
  const [pending, setPending] = useState<Record<TabKey, boolean>>({ candidate: true, approved: false, rejected: false, discards: false, runs: false, trash: false, settings: false, messages: false })
  // 四维筛选 per-tab 独立态（spec 2026-08-11-per-tab-memory-filters §4.4）：切 tab
  // 不携带筛选；空串 = 不筛该维度。facetsByTab = 每 tab 下拉选项缓存（SWR：切回
  // 立显本 tab 选项；undefined = 首访尚未加载成功）。filter/facets 是按当前 tab 的
  // 派生视图，JSX 标识符不变。
  const [filters, setFilters] = useState<Record<FacetTab, MemoryFilter>>({
    candidate: EMPTY_MEMORY_FILTER, approved: EMPTY_MEMORY_FILTER,
    rejected: EMPTY_MEMORY_FILTER, discards: EMPTY_MEMORY_FILTER,
  })
  const [facetsByTab, setFacetsByTab] = useState<Partial<Record<FacetTab, Facets>>>({})
  const filter = isFilterTab(tab) ? filters[tab] : EMPTY_MEMORY_FILTER
  const facets = isFilterTab(tab) ? facetsByTab[tab] ?? null : null
  const filterRef = useRef<MemoryFilter>(filter)
  const [status, setStatus] = useState<MemsideStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sourceInputFor, setSourceInputFor] = useState<string | null>(null)
  const [runDetailFor, setRunDetailFor] = useState<string | null>(null)
  const [rescanError, setRescanError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState<Record<TabKey, boolean>>({ candidate: false, approved: false, rejected: false, discards: false, runs: false, trash: false, settings: false, messages: false })
  const [loadMoreError, setLoadMoreError] = useState<Record<TabKey, string | null>>({ candidate: null, approved: null, rejected: null, discards: null, runs: null, trash: null, settings: null, messages: null })
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const loadMoreRef = useRef<(t: TabKey) => Promise<void>>(async () => {})

  async function refresh(target: TabKey, filterOverride?: MemoryFilter, msgOverride?: { kind: string; unreadOnly: boolean; q: string }) {
    if (!isListTab(target)) return // settings tab 无列表数据流（spec settings-tab §3.2）
    const f = filterOverride ?? filterRef.current
    setPending((p) => ({ ...p, [target]: true }))
    try {
      if (target === 'discards') {
        const [pg, st, fc] = await Promise.all([
          listDiscardsPage(fetch, { limit: WEB_PAGE_SIZE, project: f.project, category: f.category }),
          getStatus(),
          getFacets(fetch, target as FacetTab).catch(() => null), // facets 失败不拖垮列表刷新（spec 失败模式 F6）
        ])
        setDiscards((d) => ({ ...mergeRefreshPage(d, pg, (x) => x.id), total: pg.total ?? null }))
        setStatus(st)
        if (fc) setFacetsByTab((m) => ({ ...m, [target as FacetTab]: fc }))
      } else if (target === 'runs') {
        const [pg, st] = await Promise.all([listDistillRunsPage(fetch, { limit: WEB_PAGE_SIZE }), getStatus(fetch)])
        setRuns((r) => ({ ...mergeRefreshPage(r, pg, (x) => x.distillJobId), total: r.total }))
        setStatus(st)
      } else if (target === 'trash') {
        // 回收站 tab（spec 2026-08-16）：暂不接筛选下拉（decision Step 3o），分页
        // 调用不带 filter 参数。3s 轮询同其它列表 tab。
        const [pg, st] = await Promise.all([listTrashPage(fetch, { limit: WEB_PAGE_SIZE }), getStatus(fetch)])
        setTrash((t) => ({ ...mergeRefreshPage(t, pg, (x) => x.id), total: pg.total ?? null }))
        setStatus(st)
      } else if (target === 'messages') {
        const mf = msgOverride ?? msgFilterRef.current
        const [pg, st] = await Promise.all([
          listNotificationsPage(fetch, {
            limit: WEB_PAGE_SIZE,
            kind: mf.kind || undefined,
            unreadOnly: mf.unreadOnly,
            q: mf.q || undefined,
          }),
          getStatus(fetch),
        ])
        setMsgs((m) => ({ ...mergeRefreshPage(m, pg, (x) => x.id), total: pg.total ?? null }))
        setStatus(st)
      } else {
        const [pg, st, fc] = await Promise.all([
          listMemoriesPage(fetch, {
            status: memoryTabFilter(target as MemoryTabKey), limit: WEB_PAGE_SIZE,
            project: f.project, slug: f.slug, category: f.category, valueClass: f.valueClass,
          }),
          getStatus(),
          getFacets(fetch, target as FacetTab).catch(() => null),
        ])
        setMemCache((c) => ({
          ...c,
          [target as MemoryTabKey]: { ...mergeRefreshPage(c[target as MemoryTabKey], pg, (x) => x.id), total: pg.total ?? null },
        }))
        setStatus(st)
        if (fc) setFacetsByTab((m) => ({ ...m, [target as FacetTab]: fc }))
        // 候选 tab 同时拉待审查候选（spec §6.4）：按 project 筛选的 sourceCwd。
        // 失败不拖垮列表刷新（与 facets 同款 catch -> null 降级）。
        if (target === 'candidate') {
          listPendingReview(f.project).then(setPendingReview).catch(() => {})
        }
      }
      setLoaded((l) => ({ ...l, [target]: true }))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPending((p) => ({ ...p, [target]: false }))
    }
  }

  // 当前 tab 分页读取 helper：discards/runs/messages/trash 独立 state，其余走 memCache。
  function tabPageOf(target: TabKey): TabPage<MemoryItem> | TabPage<DiscardItem> | TabPage<DistillRunListItem> | TabPage<NotificationItem> | TabPage<TrashItem> {
    return target === 'discards' ? discards : target === 'runs' ? runs : target === 'messages' ? msgs : target === 'trash' ? trash : memCache[target as MemoryTabKey]
  }

  // 无限滚动加载下一页：守卫（首轮/加载中）-> 按游标拉下一页 -> mergeAppend 追加。
  // 失败记 loadMoreError，尾部显重试按钮，不静默。
  async function loadMore(target: TabKey) {
    if (!isListTab(target)) return // settings tab 无列表数据流（spec settings-tab §3.2）
    if (pending[target] || loadingMore[target]) return
    const f = filterRef.current
    const cur = tabPageOf(target)
    const before = nextCursorAfter(cur)
    if (!before) return // hasMore=false 或无游标
    setLoadingMore((l) => ({ ...l, [target]: true }))
    setLoadMoreError((e) => ({ ...e, [target]: null }))
    try {
      if (target === 'discards') {
        const pg = await listDiscardsPage(fetch, { limit: WEB_PAGE_SIZE, before, project: f.project, category: f.category })
        setDiscards((d) => ({ items: mergeAppend(d.items, pg.items, (x) => x.id), nextCursor: pg.nextCursor, hasMore: pg.hasMore, total: d.total }))
      } else if (target === 'runs') {
        const pg = await listDistillRunsPage(fetch, { limit: WEB_PAGE_SIZE, before })
        setRuns((r) => ({ items: mergeAppend(r.items, pg.items, (x) => x.distillJobId), nextCursor: pg.nextCursor, hasMore: pg.hasMore, total: r.total }))
      } else if (target === 'trash') {
        const pg = await listTrashPage(fetch, { limit: WEB_PAGE_SIZE, before })
        setTrash((t) => ({ items: mergeAppend(t.items, pg.items, (x) => x.id), nextCursor: pg.nextCursor, hasMore: pg.hasMore, total: t.total }))
      } else if (target === 'messages') {
        const mf = msgFilterRef.current
        const pg = await listNotificationsPage(fetch, {
          limit: WEB_PAGE_SIZE, before,
          kind: mf.kind || undefined,
          unreadOnly: mf.unreadOnly,
          q: mf.q || undefined,
        })
        setMsgs((m) => ({ items: mergeAppend(m.items, pg.items, (x) => x.id), nextCursor: pg.nextCursor, hasMore: pg.hasMore, total: m.total }))
      } else {
        const pg = await listMemoriesPage(fetch, {
          status: memoryTabFilter(target as MemoryTabKey), limit: WEB_PAGE_SIZE, before,
          project: f.project, slug: f.slug, category: f.category, valueClass: f.valueClass,
        })
        setMemCache((c) => ({
          ...c,
          [target as MemoryTabKey]: { items: mergeAppend(c[target as MemoryTabKey].items, pg.items, (x) => x.id), nextCursor: pg.nextCursor, hasMore: pg.hasMore, total: c[target as MemoryTabKey].total },
        }))
      }
    } catch (e) {
      setLoadMoreError((er) => ({ ...er, [target]: e instanceof Error ? e.message : String(e) }))
    } finally {
      setLoadingMore((l) => ({ ...l, [target]: false }))
    }
  }

  // loadMoreRef 每渲染同步最新闭包，避免 Observer 回调拿陈旧 state
  useEffect(() => { loadMoreRef.current = loadMore })

  // filterRef 每渲染同步（loadMoreRef 同模式）：轮询 interval 捕获建 effect 那帧
  // 的 refresh 闭包，闭包读 filter state 会拿陈旧值；一律读 ref（spec 失败模式 F5）。
  useEffect(() => { filterRef.current = filter })

  // 无限滚动哨兵：触底自动追加下一页；切 tab/卸载 disconnect（spec 决策 1）
  useEffect(() => {
    if (!isListTab(tab)) return // settings tab 无无限滚动
    const el = sentinelRef.current
    if (!el) return
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadMoreRef.current(tab)
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [tab])

  // 切 tab:不清空缓存,直接后台刷新(stale-while-revalidate),只轮询激活 tab。
  // cleanup 清旧 interval,无轮询泄漏。依赖 [tab],切 tab 才重建。
  useEffect(() => {
    setError(null)
    if (!isListTab(tab)) {
      // settings tab：不拉列表、不建轮询；一次性 status（断连 banner + 状态栏可见性）
      void getStatus().then(setStatus).catch((e) => setError(e instanceof Error ? e.message : String(e)))
      return
    }
    void refresh(tab)
    const t = setInterval(() => void refresh(tab), 3000)
    return () => clearInterval(t)
  }, [tab])

  // 回扫结束（完成/停止，running true->false 跳变）-> 候选池批量变更，
  // 页 1 merge 感知不到已移出条目，重置 candidate 缓存防滞留（spec 决策 8）
  const prevRescanRunning = useRef(false)
  useEffect(() => {
    const running = status?.rescan?.running === true
    if (prevRescanRunning.current && !running) {
      setMemCache((c) => ({ ...c, candidate: emptyPage() }))
      if (tab === 'candidate') void refresh('candidate')
    }
    prevRescanRunning.current = running
  }, [status])

  // 操作后本地移除该卡（approve/reject/restore 跨 tab 移动，即时消失不必等轮询）。
  function removeFromTab(target: TabKey, id: string) {
    if (target === 'candidate' || target === 'approved' || target === 'rejected') {
      setMemCache((c) => ({ ...c, [target]: { ...c[target], items: c[target].items.filter((x) => x.id !== id) } }))
    } else if (target === 'discards') {
      setDiscards((d) => ({ ...d, items: d.items.filter((x) => x.id !== id) }))
    } else if (target === 'trash') {
      setTrash((t) => ({ ...t, items: t.items.filter((x) => x.id !== id) }))
    }
  }

  // 操作后本地 patch 该卡字段（archive/unarchive 不换 tab，徽标/按钮即时切换）。
  function patchInMemTab(target: MemoryTabKey, id: string, patch: Partial<MemoryItem>) {
    setMemCache((c) => ({
      ...c,
      [target]: { ...c[target], items: c[target].items.map((x) => (x.id === id ? { ...x, ...patch } : x)) },
    }))
  }

  async function approve(id: string) {
    await promoteMemory(id, { action: 'approve' })
    removeFromTab(tab, id)
    setPendingReview((ps) => ps.filter((x) => x.id !== id))
    void refresh(tab)
  }
  async function reject(id: string) {
    await promoteMemory(id, { action: 'reject' })
    removeFromTab(tab, id)
    setPendingReview((ps) => ps.filter((x) => x.id !== id))
    void refresh(tab)
  }
  async function edit(id: string, title: string, bodyMd: string, scopeType: 'project' | 'global', subjectSlug: string | null) {
    await patchMemory(id, { title, bodyMd, scopeType, subjectSlug })
    void refresh(tab)
  }
  async function archive(id: string) {
    await archiveMemory(id)
    if (tab === 'approved') patchInMemTab('approved', id, { status: 'archived' })
    void refresh(tab)
  }
  async function unarchive(id: string) {
    await unarchiveMemory(id)
    if (tab === 'approved') patchInMemTab('approved', id, { status: 'approved' })
    void refresh(tab)
  }
  async function restore(id: string) {
    await restoreMemory(id)
    removeFromTab(tab, id)
    void refresh(tab)
  }
  async function promote(id: string) {
    const m = await promoteDiscard(id)
    if (m) setDiscards((d) => ({ ...d, items: d.items.map((x) => (x.id === id ? { ...x, promotedMemoryId: m.id } : x)) }))
    void refresh(tab)
  }

  // 点开未读消息：本地乐观标已读 + 服务端 read + status 刷新（徽标即时归位）。
  // no-throw：read 失败靠 3s 轮询自愈（未读会重新出现，不静默吞状态）。
  function openMessage(id: string) {
    setExpandedId((cur) => (cur === id ? null : id))
    const n = msgs.items.find((x) => x.id === id)
    if (n && n.readAt === null) {
      setMsgs((m) => ({ ...m, items: m.items.map((x) => (x.id === id ? { ...x, readAt: Date.now() } : x)) }))
      void markNotificationRead(id).then(() => getStatus(fetch).then(setStatus)).catch(() => {})
    }
  }

  async function markAllRead() {
    setMsgs((m) => ({ ...m, items: m.items.map((x) => (x.readAt === null ? { ...x, readAt: Date.now() } : x)) }))
    await markAllNotificationsRead()
    void refresh('messages')
  }

  // 筛选变化：作废缓存重置页 1，立即按新筛选重拉（changeFilter 同构）。
  function changeMsgFilter(next: { kind: string; unreadOnly: boolean; q: string }) {
    setMsgFilter(next)
    setMsgs(emptyPage())
    void refresh('messages', undefined, next)
  }

  // 关键词输入 300ms debounce 后进筛选。
  function onQChange(v: string) {
    setQInput(v)
    if (qTimerRef.current) clearTimeout(qTimerRef.current)
    qTimerRef.current = setTimeout(() => changeMsgFilter({ ...msgFilterRef.current, q: v.trim() }), 300)
  }

  // 存量回扫(Task 7):POST /api/rescan fire-and-forget,进度经 /api/status 轮询
  // (status.rescan)。失败显错误行不静默;409(已在跑)由 startRescan 内部吞掉。
  async function rescan() {
    setRescanError(null)
    try {
      await startRescan()
    } catch (e) {
      setRescanError(e instanceof Error ? e.message : String(e))
    }
    void refresh(tab)
  }

  // 暂停 job 处置（spec §6）：retry 调 resetJobForRetry 回 pending，abandon 调
  // abandonJob 标 done 放弃。no-throw 契约（与 restoreMemory 同模式）：失败返回
  // {ok:false,error}，UI 显错误行不静默；成功后 refresh 收敛真实状态。
  async function retryDistillJob(jobId: string) {
    const r = await retryJob(jobId)
    if (r && !r.ok) setError(r.error ?? 'retry failed')
    void refresh('runs')
  }
  async function abandonDistillJob(jobId: string) {
    const r = await abandonJob(jobId)
    if (r && !r.ok) setError(r.error ?? 'abandon failed')
    void refresh('runs')
  }

  // 服务端按条件批量（spec 决策 4）：POST /api/memories/bulk-reject-unevaluated
  // 清空整个未评估尾队，不限于已加载部分。返回后重置 candidate 缓存（决策 8）
  // 防已拒条目滞留，refresh 拉页 1 重建。
  async function bulkRejectUnevaluated() {
    await bulkRejectUnevaluatedApi()
    setMemCache((c) => ({ ...c, candidate: emptyPage() }))
    void refresh('candidate')
  }

  // 回收站清空（spec 2026-08-16）：confirm 二次确认（清空后不可恢复），调
  // emptyTrash() 后本地置空 + refresh 拉页 1。emptyTrash 失败抛错（spec §失败可见），
  // catch 显错误横幅不静默。
  async function emptyTrashClick() {
    if (!confirm('确认清空回收站？清空后不可恢复。')) return
    try {
      await emptyTrash()
      setTrash(emptyPage())
      void refresh('trash')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // 回收站单条恢复（spec 2026-08-16）：no-throw 契约（restoreFromTrash 404/409
  // 返回 undefined）。本地乐观移除该卡（即时消失），refresh 收敛真实状态。
  async function restoreTrash(id: string) {
    await restoreFromTrash(id)
    removeFromTab('trash', id)
    void refresh('trash')
  }

  // 切 tab（spec 2026-08-16 task-10）：包一层 setTab，同时清空三 tab 多选集合。
  // 切走再切回不应残留旧选中——选中只对当前 tab 的批量操作有意义。
  function switchTab(t: TabKey) {
    setTab(t)
    setSelectedIds({ candidate: new Set(), approved: new Set(), rejected: new Set() })
  }

  // 多选 helper（spec 2026-08-16 task-10）：toggleSelect 单条切换；selectAllPage
  // 选中当前 tab 已加载页全部 id；clearSelection 清空当前 tab 选中。非记忆 tab no-op。
  function toggleSelect(id: string) {
    if (!isMemoryTab(tab)) return
    setSelectedIds((s) => {
      const next = new Set(s[tab])
      if (next.has(id)) next.delete(id); else next.add(id)
      return { ...s, [tab]: next }
    })
  }
  function selectAllPage() {
    if (!isMemoryTab(tab)) return
    setSelectedIds((s) => ({ ...s, [tab]: new Set(memItems.map((m) => m.id)) }))
  }
  function clearSelection() {
    if (!isMemoryTab(tab)) return
    setSelectedIds((s) => ({ ...s, [tab]: new Set() }))
  }

  // 批量删除（spec 2026-08-16 task-10）：confirm 二次确认（可从回收站恢复），
  // bulkDelete 一次性软删，清选中 + 重置当前 tab 缓存防已删条目滞留 + refresh。
  // bulkDelete 失败抛错（spec §失败可见），catch 显错误横幅不静默清选中。
  async function bulkDeleteSelected() {
    if (!isMemoryTab(tab)) return
    const ids = [...selectedIds[tab]]
    if (ids.length === 0) return
    if (!window.confirm(`确认将 ${ids.length} 条移入回收站？可从回收站恢复`)) return
    try {
      await bulkDelete(ids)
      setSelectedIds((s) => ({ ...s, [tab]: new Set() }))
      setMemCache((c) => ({ ...c, [tab]: emptyPage() }))
      void refresh(tab)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  // 批量批准/拒绝（复用 promoteMemory 逐条；no-throw swallow，失败的靠 refresh 收敛）。
  async function bulkApproveSelected() {
    if (!isMemoryTab(tab)) return
    for (const id of selectedIds[tab]) {
      try { await promoteMemory(id, { action: 'approve' }) } catch {}
    }
    setSelectedIds((s) => ({ ...s, [tab]: new Set() }))
    setMemCache((c) => ({ ...c, [tab]: emptyPage() }))
    void refresh(tab)
  }
  async function bulkRejectSelected() {
    if (!isMemoryTab(tab)) return
    for (const id of selectedIds[tab]) {
      try { await promoteMemory(id, { action: 'reject' }) } catch {}
    }
    setSelectedIds((s) => ({ ...s, [tab]: new Set() }))
    setMemCache((c) => ({ ...c, [tab]: emptyPage() }))
    void refresh(tab)
  }
  // 批量归档/取消归档（仅 approved tab；逐条 archive/unarchive no-throw）。
  async function bulkArchiveSelected() {
    if (tab !== 'approved') return
    for (const id of selectedIds[tab]) { try { await archiveMemory(id) } catch {} }
    setSelectedIds((s) => ({ ...s, [tab]: new Set() }))
    void refresh(tab)
  }
  async function bulkUnarchiveSelected() {
    if (tab !== 'approved') return
    for (const id of selectedIds[tab]) { try { await unarchiveMemory(id) } catch {} }
    setSelectedIds((s) => ({ ...s, [tab]: new Set() }))
    void refresh(tab)
  }
  // 批量恢复（仅 rejected tab；逐条 restoreMemory no-throw）。
  async function bulkRestoreSelected() {
    if (tab !== 'rejected') return
    for (const id of selectedIds[tab]) { try { await restoreMemory(id) } catch {} }
    setSelectedIds((s) => ({ ...s, [tab]: new Set() }))
    setMemCache((c) => ({ ...c, [tab]: emptyPage() }))
    void refresh(tab)
  }

  // 筛选变化（per-tab 独立态，spec 2026-08-11-per-tab-memory-filters §4.4-4）：只作废
  // 当前 tab 缓存——其余 tab 缓存对应各自筛选，与本 tab 筛选变化无涉（推翻共享态
  // 时代的四缓存全作废）。仍须作废当前 tab：否则 mergeRefreshPage 把旧筛选条目当
  // 「掉出第一页的老数据」追加回来（spec 失败模式 F2）。立即按新筛选重拉，不等轮询。
  function changeFilter(next: MemoryFilter) {
    if (!isFilterTab(tab)) return
    setFilters((fs) => ({ ...fs, [tab]: next }))
    if (tab === 'discards') setDiscards(emptyPage())
    else if ((tab as TabKey) === 'trash') setTrash(emptyPage())
    else setMemCache((c) => ({ ...c, [tab]: emptyPage() }))
    void refresh(tab, next)
  }

  // 记忆列表按 createdAt 倒序(newest first)。memCache 在 candidate/approved/rejected
  // tab 分别是对应 status 的子集(server 已过滤),客户端再排一次保证顺序一致。
  const memItems = sortCandidatesByTime(memCache[tab as MemoryTabKey]?.items ?? [])
  const listEmpty = tab === 'messages' ? msgs.items.length === 0
    : tab === 'discards' ? discards.items.length === 0
    : tab === 'runs' ? runs.items.length === 0
    : tab === 'trash' ? trash.items.length === 0
    : (memCache[tab as MemoryTabKey]?.items ?? []).length === 0
  const showLoading = shouldShowLoading(loaded, pending, tab)

  // 回扫状态缩写(spec 2026-08-07 §3.2):rs 驱动进度条/停止按钮/结果卡片。
  const rs = status?.rescan
  const rsPct = rescanPercent(rs?.done ?? 0, rs?.total ?? 0)

  const tabs: ReadonlyArray<{ key: TabKey; label: string; count: number | null }> = [
    { key: 'candidate', label: '候选审批', count: tabTotalCount(status, 'candidate') ?? 0 },
    { key: 'approved', label: '已审批', count: tabTotalCount(status, 'approved') ?? 0 },
    { key: 'rejected', label: '已拒绝', count: tabTotalCount(status, 'rejected') ?? 0 },
    { key: 'discards', label: 'AI自动拒绝', count: tabTotalCount(status, 'discards') ?? 0 },
    { key: 'runs', label: '蒸馏记录', count: tabTotalCount(status, 'runs') ?? 0 },
    { key: 'trash', label: '回收站', count: status?.trashCount ?? null },
    { key: 'settings', label: '设置', count: null }, // 设置 tab 无计数徽标
    { key: 'messages', label: '消息', count: status?.unreadNotifications ?? null },
  ]

  return (
    <div style={{ fontFamily: 'system-ui', maxWidth: 900, margin: '0 auto', padding: 24 }}>
      <h1>memside · 审批队列</h1>

      {/* tab 栏 - 4 审计视图,active 高亮,计数徽标来自 status */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {tabs.map((t) => {
          const active = t.key === tab
          return (
            <button
              key={t.key}
              onClick={() => switchTab(t.key)}
              style={{
                padding: '8px 14px',
                borderRadius: 8,
                border: '1px solid #e0e0e0',
                background: active ? '#222' : '#f5f5f5',
                color: active ? '#fff' : '#444',
                cursor: 'pointer',
                fontSize: 14,
              }}
            >
              {t.label}
              {t.count !== null ? (
                <span style={{ marginLeft: 6, fontSize: 12, opacity: 0.85 }}>{t.count}</span>
              ) : null}
            </button>
          )
        })}
      </div>

      {/* 导出/导入入口工具栏（spec 2026-08-16 task-10）：仅记忆三 tab 显示。
          导出 = 打开 ExportTrigger modal（scope 全部/当前筛选/选中）；导入 =
          打开 ImportTrigger modal（选文件 + 冲突策略）。 */}
      {isMemoryTab(tab) ? (
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <button onClick={() => setExportOpen(true)}>导出</button>
          <button onClick={() => setImportOpen(true)}>导入</button>
        </div>
      ) : null}

      {/* 状态栏 - 后台可见性 */}
      <div
        style={{
          background: '#f5f5f5',
          border: '1px solid #e0e0e0',
          borderRadius: 8,
          padding: 12,
          marginBottom: 16,
          fontSize: 13,
          color: '#444',
        }}
      >
        {status ? (
          <>
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
              {(['distill', 'dedup', 'judge'] as const).map((p) => {
                const act = status.llmActivity
                const active = act != null && phaseLabel(act.phase) === phaseLabel(p)
                return (
                  <span key={p} style={{ color: active ? '#1565c0' : '#999' }}>
                    {phaseLabel(p)}{' '}
                    <b>{active && act ? `进行中·${formatElapsed(Date.now() - act.since)}` : '空闲'}</b>
                  </span>
                )
              })}
              <button
                style={{
                  marginLeft: 'auto',
                  fontSize: 12,
                  // 警示着色（spec 2026-08-14 §3.4）：未读 LLM 报错 -> 红色加粗；
                  // 无 LLM 报错但有未读降级 -> 琥珀色；都无保持默认。
                  color: (status.unreadLlmErrors ?? 0) > 0 ? '#c00'
                    : (status.unreadDegradations ?? 0) > 0 ? '#b26a00' : undefined,
                  fontWeight: (status.unreadLlmErrors ?? 0) > 0 ? 700 : undefined,
                }}
                onClick={() => setTab('messages')}
                title="查看消息"
              >
                🔔 {(status.unreadNotifications ?? 0) > 0 ? `${status.unreadNotifications} 未读` : '已读完'}
              </button>
            </div>
            {status.llmStats24h ? (
              <div style={{ marginTop: 6, color: '#666' }}>
                近24h 蒸馏 {formatPhaseStat(status.llmStats24h.distill.count, status.llmStats24h.distill.ms)}
                {' │ '}去重 {formatPhaseStat(status.llmStats24h.dedup.count, status.llmStats24h.dedup.ms)}
                {' │ '}审查 {formatPhaseStat(status.llmStats24h.judge.count, status.llmStats24h.judge.ms)}
              </div>
            ) : null}
            {/* 暂停 job 提示（spec §6）：3 次失败暂停等人处置，琥珀色醒目，点击跳蒸馏记录 tab。 */}
            {(status.pausedJobs ?? 0) > 0 ? (
              <button
                onClick={() => setTab('runs')}
                style={{
                  display: 'block', width: '100%', marginTop: 8, padding: '6px 10px',
                  background: '#fff3e0', color: '#b26a00', border: '1px solid #ffb300',
                  borderRadius: 6, cursor: 'pointer', textAlign: 'left', fontSize: 13,
                }}
              >
                ⏸ {status.pausedJobs} 个蒸馏任务已暂停（3 次失败），需重试或放弃 → 点击查看
              </button>
            ) : null}
            {/* 警示条（spec 2026-08-14 §3.4）：未读 LLM 报错/降级醒目提示，整条可点跳消息 tab。
                字段 optional（老 daemon 无），?? 0 兜底；未读清零后条件渲染自动消失，无独立关闭按钮。
                llm_error 红条在上，degradation 琥珀条在下，可同时存在。 */}
            {(status.unreadLlmErrors ?? 0) > 0 ? (
              <button
                onClick={() => setTab('messages')}
                style={{
                  display: 'block',
                  width: '100%',
                  marginTop: 8,
                  padding: '6px 10px',
                  background: '#d32f2f',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontSize: 13,
                }}
              >
                ⚠️ 蒸馏 LLM 报错 ×{status.unreadLlmErrors}
                （最近：{truncateAlertBody(status.latestUnreadLlmError?.body ?? null)}）→ 点击查看
              </button>
            ) : null}
            {(status.unreadDegradations ?? 0) > 0 ? (
              <button
                onClick={() => setTab('messages')}
                style={{
                  display: 'block',
                  width: '100%',
                  marginTop: 8,
                  padding: '6px 10px',
                  background: '#ffb300',
                  color: '#3e2723',
                  border: 'none',
                  borderRadius: 6,
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontSize: 13,
                }}
              >
                ⚠️ 降级 ×{status.unreadDegradations} → 点击查看
              </button>
            ) : null}
          </>
        ) : error ? (
          <span style={{ color: '#c00' }}>连不上 daemon</span>
        ) : (
          <span>读取状态中…</span>
        )}
      </div>

      {error ? (
        <div
          style={{
            background: '#fee',
            border: '1px solid #c00',
            borderRadius: 8,
            padding: 12,
            marginBottom: 16,
            color: '#c00',
          }}
        >
          连不上 daemon(端口 7777)。确认 daemon 在跑:<code> bun run src/cli.ts start</code>。错误: {error}
        </div>
      ) : null}

      {/* 筛选条（spec 2026-08-11-web-memory-filters §4.3）：四个记忆 tab（含 discards）
          可用；runs/settings 不渲染。选项来自 /api/facets（随 3s 轮询刷新，新 slug/
          项目无静默窗口）；facets 未就绪 -> 下拉禁用 + 灰字，不静默。discards tab
          只渲染有对应列的两维（项目/分类）。
          2026-08-11 ui-clarity：加标题/说明 + 维度改名 + 分类/价值选项中文化（映射走 ui-utils）。 */}
      {isFilterTab(tab) ? (
        <div style={{ display: 'flex', flexDirection: 'column', marginBottom: 16, padding: 10, border: '1px solid #e0e0e0', borderRadius: 8, background: '#fafafa' }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>筛选</div>
          <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>按以下条件缩小列表。每个 tab 的筛选相互独立。</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <FilterSelect label="源项目" disabled={facets === null} value={filter.project}
              onChange={(v) => changeFilter({ ...filter, project: v })}
              options={(facets?.projects ?? []).map((p) => ({
                value: p.value,
                label: `${projectDisplayName(p.value, (facets?.projects ?? []).map((x) => x.value))} (${p.count})`,
                title: p.value,
              }))} />
            <FilterSelect label="分类" disabled={facets === null} value={filter.category}
              onChange={(v) => changeFilter({ ...filter, category: v })}
              options={(facets?.categories ?? []).map((p) => ({
                value: p.value,
                label: `${categoryInfo(p.value)?.name ?? p.value} (${p.count})`,
                title: p.value,
              }))} />
            {tab !== 'discards' ? (
              <>
                <FilterSelect label="主题（slug）" disabled={facets === null} value={filter.slug}
                  onChange={(v) => changeFilter({ ...filter, slug: v })}
                  options={(facets?.slugs ?? []).map((p) => ({ value: p.value, label: `${p.value} (${p.count})` }))} />
                <FilterSelect label="价值" disabled={facets === null} value={filter.valueClass}
                  onChange={(v) => changeFilter({ ...filter, valueClass: v })}
                  options={(facets?.valueClasses ?? []).map((p) => {
                    const v = valueClassInfo(p.value === UNEVALUATED ? null : p.value)
                    return { value: p.value, label: `${v.name}${v.priority ? ` · ${v.priority}优先` : ''} (${p.count})` }
                  })} />
              </>
            ) : null}
            {facets === null ? (
              <span style={{ fontSize: 12, color: '#888' }}>筛选选项加载失败，稍后自动重试</span>
            ) : null}
            {hasActiveFilter(filter) ? (
              <button onClick={() => changeFilter(EMPTY_MEMORY_FILTER)}>清除筛选</button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* 列表 - 按 tab 渲染对应数据 + 操作;加载中 / 空 / 错误三态不静默 stall */}
      {tab === 'settings' ? (
        <>
          {/* 设置区块挂载点（spec 2026-08-07 settings-tab §3.5）：
              新增设置 = 新 section 组件 + 此处追加一行。
              section 约定：<section> 包裹 + <h3> 标题 + 自管理 fetch/保存/错误行。 */}
          <LlmSettings />
          <JudgeSettings />
          <RuntimeSettings />
        </>
      ) : tab === 'messages' ? (
        <div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
            <select
              value={msgFilter.kind}
              onChange={(e) => changeMsgFilter({ ...msgFilter, kind: e.target.value })}
              style={{ fontSize: 13 }}
            >
              <option value="">全部类型</option>
              <option value="degradation">降级</option>
              <option value="llm_error">LLM错误</option>
              <option value="parse_error">解析失败</option>
            </select>
            <label style={{ fontSize: 13 }}>
              <input
                type="checkbox"
                checked={msgFilter.unreadOnly}
                onChange={(e) => changeMsgFilter({ ...msgFilter, unreadOnly: e.target.checked })}
              />{' '}
              仅未读
            </label>
            <input
              value={qInput}
              onChange={(e) => onQChange(e.target.value)}
              placeholder="搜索消息关键词…"
              style={{ fontSize: 13, padding: '4px 8px', minWidth: 180 }}
            />
            <button onClick={() => { void markAllRead() }} style={{ fontSize: 12, marginLeft: 'auto' }}>全部已读</button>
          </div>
          {msgFilter.kind !== '' || msgFilter.unreadOnly || msgFilter.q !== '' ? (
            <p style={{ color: '#666' }}>共 {msgs.total ?? msgs.items.length} 条消息符合当前筛选</p>
          ) : null}
          {msgs.items.map((n) => {
            const unread = n.readAt === null
            const expanded = expandedId === n.id
            const chipColor = n.kind === 'degradation' ? '#e65100' : '#c00'
            const time = new Date(n.ts)
            const timeLabel = `${time.getMonth() + 1}/${time.getDate()} ${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
            return (
              <div
                key={n.id}
                onClick={() => openMessage(n.id)}
                style={{
                  border: '1px solid #e0e0e0', borderRadius: 8, padding: 12, marginBottom: 8,
                  background: unread ? '#fffdf0' : '#fff', cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                  {unread ? <span style={{ color: '#e65100' }}>●</span> : <span style={{ color: '#ccc' }}>○</span>}
                  <span style={{ ...CHIP_STYLE, color: chipColor, borderColor: chipColor }}>
                    {n.kind === 'llm_error' ? 'LLM错误' : n.kind === 'parse_error' ? '解析失败' : '降级'}
                  </span>
                  <b>{notificationTitle(n)}</b>
                  <span style={{ marginLeft: 'auto', color: '#999', fontSize: 12 }}>{timeLabel}</span>
                </div>
                {n.body ? (
                  <div style={{ marginTop: 6, fontSize: 12, color: '#666', whiteSpace: expanded ? 'pre-wrap' : 'nowrap', overflow: 'hidden', textOverflow: expanded ? undefined : 'ellipsis' }}>
                    {n.body}
                  </div>
                ) : null}
              </div>
            )
          })}
          {msgs.items.length === 0 && showLoading ? (
            <p style={{ color: '#666' }}>加载中…</p>
          ) : null}
          {msgs.items.length === 0 && !showLoading && (
            msgFilter.kind !== '' || msgFilter.unreadOnly || msgFilter.q !== '' ? (
              <p style={{ color: '#666' }}>没有匹配的消息</p>
            ) : (
              <p style={{ color: '#666' }}>暂无消息</p>
            )
          )}
        </div>
      ) : error ? null : showLoading && listEmpty ? (
        <p>加载中…</p>
      ) : tab === 'candidate' ? (
        <>
          <p>{hasActiveFilter(filter)
          ? `共 ${memCache.candidate.total ?? memItems.length} 条符合当前筛选`
          : `${tabTotalCount(status, 'candidate') ?? memItems.length} 条候选记忆待审`}</p>
          {isMemoryTab(tab) && selectedIds[tab].size > 0 ? (
            <MemoryBatchBar
              tab={tab}
              selectedCount={selectedIds[tab].size}
              onSelectAll={selectAllPage}
              onClear={clearSelection}
              onBulkApprove={() => void bulkApproveSelected()}
              onBulkReject={() => void bulkRejectSelected()}
              onBulkArchive={() => void bulkArchiveSelected()}
              onBulkUnarchive={() => void bulkUnarchiveSelected()}
              onBulkRestore={() => void bulkRestoreSelected()}
              onBulkDelete={() => void bulkDeleteSelected()}
            />
          ) : null}
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {(status?.unevaluatedCandidates ?? 0) > 0 ? (
                <button onClick={() => bulkRejectUnevaluated()}>
                  批量拒绝未评估 ({status!.unevaluatedCandidates})
                </button>
              ) : null}
              {/* 回扫端点 /api/rescan(开始)与 /api/rescan/cancel(批边界停止) */}
              {rs?.running ? (
                <button onClick={() => void cancelRescan().catch(() => {})}>
                  停止筛查
                </button>
              ) : (
                <button onClick={() => rescan()}>重新筛查全部候选</button>
              )}
              {rs?.running && rs?.stopping ? (
                <span style={{ fontSize: 13, color: '#b80' }}>正在停止(当前这批判完即停)…</span>
              ) : null}
            </div>
            <div style={{ fontSize: 12, color: '#888', margin: '6px 0' }}>
              把候选队列按当前判定模式全部重判一遍,判丢的进「AI自动拒绝」,可恢复。
            </div>
            {rs?.running ? (
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 }}>
                <div style={{ width: 240, height: 10, background: '#eee', borderRadius: 5, overflow: 'hidden' }}>
                  <div style={{ width: `${rsPct}%`, height: '100%', background: '#222', transition: 'width .3s' }} />
                </div>
                <span style={{ fontSize: 13, color: '#666' }}>
                  已处理 {rs.done}/{rs.total}({rsPct}%) · 已判丢 {rs.discarded ?? 0} 条
                </span>
              </div>
            ) : null}
            {!rs?.running && rs?.report ? (
              <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 10, marginBottom: 8, fontSize: 13, background: '#fafafa' }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                  {rs.report.stopped
                    ? `已停止(剩余 ${rs.total - rs.report.processed} 条未筛查)`
                    : '筛查完成'}
                </div>
                <div>
                  处理 {rs.report.processed} · 判丢 {rs.report.discarded} · 保留 {rs.report.keptUpdated} · 跳过 {rs.report.skipped}(目录已删除的项目)
                </div>
                {rs.report.discarded > 0 ? (
                  <button style={{ marginTop: 6, fontSize: 13 }} onClick={() => setTab('discards')}>
                    查看判丢的 {rs.report.discarded} 条 →
                  </button>
                ) : null}
              </div>
            ) : null}
            {rs?.error ? (
              <div style={{ fontSize: 13, color: '#c00' }}>回扫失败: {rs.error}</div>
            ) : null}
            {rescanError ? (
              <span style={{ fontSize: 13, color: '#c00' }}>回扫失败: {rescanError}</span>
            ) : null}
          </div>
          {memItems.map((m) => (
            <MemoryCard
              key={m.id}
              m={m}
              selected={selectedIds[tab].has(m.id)}
              onToggleSelect={() => toggleSelect(m.id)}
              onApprove={() => approve(m.id)}
              onReject={() => reject(m.id)}
              onEdit={(t, b, s, slug) => edit(m.id, t, b, s, slug)}
              onViewSource={() => setSourceInputFor(m.id)}
            />
          ))}
          {/* 待审查候选区块（spec §6.4）：judge 3 次失败暂停期间标的 pending_review
              候选。与正常候选同 tab 但用区块隔开（⏸ 待审查），可手动 approve/reject/edit
              （复用 MemoryCard 回调；promoteCandidate 已接受 pending_review 状态）。 */}
          {pendingReview.length > 0 ? (
            <div style={{ marginTop: 16, padding: 12, border: '1px solid #ffb300', borderRadius: 8, background: '#fffdf0' }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: '#b26a00', marginBottom: 8 }}>
                ⏸ 待审查（{pendingReview.length} 条）— judge 步暂停，可手动审批
              </div>
              {pendingReview.map((m) => (
                <MemoryCard
                  key={m.id}
                  m={m}
                  onApprove={() => approve(m.id)}
                  onReject={() => reject(m.id)}
                  onEdit={(t, b, s, slug) => edit(m.id, t, b, s, slug)}
                  onViewSource={() => setSourceInputFor(m.id)}
                />
              ))}
            </div>
          ) : null}
          {memItems.length === 0 && pendingReview.length === 0 && !showLoading && (
            hasActiveFilter(filter) ? (
              <p style={{ color: '#666' }}>
                没有符合当前筛选的记录 <button onClick={() => changeFilter(EMPTY_MEMORY_FILTER)}>清除筛选</button>
              </p>
            ) : (
              <p style={{ color: '#666' }}>
                暂无候选记忆。结束一个 claude code 会话后,后台会异步提炼(distill 约 15-30s),候选记忆会自动出现在这里。上方状态栏可看后台进度。
              </p>
            )
          )}
        </>
      ) : tab === 'approved' ? (
        <>
          <p>{hasActiveFilter(filter)
          ? `共 ${memCache.approved.total ?? memItems.length} 条符合当前筛选`
          : `${tabTotalCount(status, 'approved') ?? memItems.length} 条已审批记忆`}</p>
          {isMemoryTab(tab) && selectedIds[tab].size > 0 ? (
            <MemoryBatchBar
              tab={tab}
              selectedCount={selectedIds[tab].size}
              onSelectAll={selectAllPage}
              onClear={clearSelection}
              onBulkApprove={() => void bulkApproveSelected()}
              onBulkReject={() => void bulkRejectSelected()}
              onBulkArchive={() => void bulkArchiveSelected()}
              onBulkUnarchive={() => void bulkUnarchiveSelected()}
              onBulkRestore={() => void bulkRestoreSelected()}
              onBulkDelete={() => void bulkDeleteSelected()}
            />
          ) : null}
          {memItems.map((m) => (
            <MemoryCard
              key={m.id}
              m={m}
              selected={selectedIds[tab].has(m.id)}
              onToggleSelect={() => toggleSelect(m.id)}
              readOnlyReason={m.status === 'superseded' ? '已被取代' : undefined}
              onArchive={m.status === 'approved' ? () => archive(m.id) : undefined}
              onUnarchive={m.status === 'archived' ? () => unarchive(m.id) : undefined}
            />
          ))}
          {memItems.length === 0 && !showLoading && (
            hasActiveFilter(filter) ? (
              <p style={{ color: '#666' }}>
                没有符合当前筛选的记录 <button onClick={() => changeFilter(EMPTY_MEMORY_FILTER)}>清除筛选</button>
              </p>
            ) : (
              <p style={{ color: '#666' }}>暂无已审批记忆</p>
            )
          )}
        </>
      ) : tab === 'rejected' ? (
        <>
          <p>{hasActiveFilter(filter)
          ? `共 ${memCache.rejected.total ?? memItems.length} 条符合当前筛选`
          : `${tabTotalCount(status, 'rejected') ?? memItems.length} 条已拒绝记忆`}</p>
          {isMemoryTab(tab) && selectedIds[tab].size > 0 ? (
            <MemoryBatchBar
              tab={tab}
              selectedCount={selectedIds[tab].size}
              onSelectAll={selectAllPage}
              onClear={clearSelection}
              onBulkApprove={() => void bulkApproveSelected()}
              onBulkReject={() => void bulkRejectSelected()}
              onBulkArchive={() => void bulkArchiveSelected()}
              onBulkUnarchive={() => void bulkUnarchiveSelected()}
              onBulkRestore={() => void bulkRestoreSelected()}
              onBulkDelete={() => void bulkDeleteSelected()}
            />
          ) : null}
          {memItems.map((m) => (
            <MemoryCard
              key={m.id}
              m={m}
              selected={selectedIds[tab].has(m.id)}
              onToggleSelect={() => toggleSelect(m.id)}
              onRestore={() => restore(m.id)}
            />
          ))}
          {memItems.length === 0 && !showLoading && (
            hasActiveFilter(filter) ? (
              <p style={{ color: '#666' }}>
                没有符合当前筛选的记录 <button onClick={() => changeFilter(EMPTY_MEMORY_FILTER)}>清除筛选</button>
              </p>
            ) : (
              <p style={{ color: '#666' }}>暂无已拒绝记忆</p>
            )
          )}
        </>
      ) : tab === 'trash' ? (
        <div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
            <p style={{ margin: 0 }}>{tabTotalCount(status, 'trash') ?? trash.items.length} 条回收站记录</p>
            <button
              onClick={() => void emptyTrashClick()}
              disabled={trash.items.length === 0 && (status?.trashCount ?? 0) === 0}
              style={{ color: '#c00', borderColor: '#c00' }}
            >
              清空回收站
            </button>
            <span style={{ fontSize: 12, color: '#999' }}>清空后不可恢复</span>
          </div>
          {trash.items.map((t) => (
            <TrashCard key={t.id} t={t} onRestore={() => restoreTrash(t.id)} />
          ))}
          {trash.items.length === 0 && !showLoading && (
            <p style={{ color: '#666' }}>回收站为空</p>
          )}
        </div>
      ) : tab === 'runs' ? (
        <div>
          <p>共 {tabTotalCount(status, 'runs') ?? runs.items.length} 条蒸馏记录</p>
          {runs.items.map((r) => (
            <DistillRunRow key={r.distillJobId} r={r} onOpen={() => setRunDetailFor(r.distillJobId)}
              onRetry={() => retryDistillJob(r.distillJobId)}
              onAbandon={() => abandonDistillJob(r.distillJobId)} />
          ))}
          {runs.items.length === 0 && !showLoading && (
            <p style={{ color: '#666' }}>暂无蒸馏记录</p>
          )}
        </div>
      ) : (
        <>
          <p>{hasActiveFilter(filter)
          ? `共 ${discards.total ?? discards.items.length} 条符合当前筛选`
          : `${tabTotalCount(status, 'discards') ?? discards.items.length} 条 AI 自动拒绝记录`}</p>
          {discards.items.map((d) => (
            <DiscardCard key={d.id} d={d} onPromote={() => promote(d.id)} />
          ))}
          {discards.items.length === 0 && !showLoading && (
            hasActiveFilter(filter) ? (
              <p style={{ color: '#666' }}>
                没有符合当前筛选的记录 <button onClick={() => changeFilter(EMPTY_MEMORY_FILTER)}>清除筛选</button>
              </p>
            ) : (
              <p style={{ color: '#666' }}>暂无 AI 自动拒绝记录</p>
            )
          )}
        </>
      )}

      {isListTab(tab) ? (
        <>
          {/* 列表尾部（五列表 tab 共用，settings 由外层 isListTab 门控整体不渲染）。
              哨兵对列表 tab 无条件渲染、在内层 error/showLoading 门控块外：observer effect
              依赖 [tab] 只在切 tab 时跑一次，哨兵若藏进内层门控（首访 pending=true -> 不在 DOM）
              则 observer 首访永远挂不上、无限滚动死锁（评审 Important #1）。加载中/出错时
              哨兵相交是安全 no-op——loadMore 有 pending/loadingMore/nextCursorAfter 三重守卫。
              加载更多 / 失败重试 / 到底提示仍在内层门控内。 */}
          <div ref={sentinelRef} style={{ height: 1 }} />
          {error ? null : showLoading ? null : (
            <>
              {loadingMore[tab] ? <p style={{ color: '#888', fontSize: 13 }}>加载更多…</p> : null}
              {loadMoreError[tab] ? (
                <button style={{ fontSize: 13 }} onClick={() => void loadMore(tab)}>
                  加载更多失败，点击重试（{loadMoreError[tab]}）
                </button>
              ) : null}
              {!tabPageOf(tab).hasMore && !listEmpty ? (
                <p style={{ color: '#aaa', fontSize: 12 }}>没有更多了</p>
              ) : null}
            </>
          )}
        </>
      ) : null}

      {sourceInputFor ? (
        <SourceInputModal memoryId={sourceInputFor} onClose={() => setSourceInputFor(null)} />
      ) : null}

      {runDetailFor ? (
        <DistillRunModal jobId={runDetailFor} onClose={() => setRunDetailFor(null)} />
      ) : null}

      {/* 导出 modal（spec 2026-08-16 task-10）：选范围（全部/当前筛选/选中）+ 格式
          （memside JSON 高保真 / Markdown 低保真）→ 浏览器下载。selectedIds 传入使
          scope='selected' 时服务端只导选中（空选中 = 空导出，安全）。 */}
      {exportOpen ? (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }} onClick={() => setExportOpen(false)}>
          <div style={{ background: '#fff', padding: 24, borderRadius: 8, minWidth: 320 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>导出记忆</h3>
            <p style={{ fontSize: 13, color: '#666' }}>选择导出范围与格式。memside JSON 高保真（保留状态）；Markdown 低保真（人类可读）。</p>
            <ExportTrigger selectedIds={isMemoryTab(tab) ? [...selectedIds[tab]] : []} filter={filter} tab={tab as MemoryTabKey} onDone={() => setExportOpen(false)} />
          </div>
        </div>
      ) : null}

      {/* 导入 modal（spec 2026-08-16 task-10）：选冲突策略 + 选文件 → 上传。
          importConflict 状态提升到 App，ImportTrigger 受控渲染三选项。 */}
      {importOpen ? (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }} onClick={() => { setImportOpen(false); setImportResult(null) }}>
          <div style={{ background: '#fff', padding: 24, borderRadius: 8, minWidth: 320 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>导入记忆</h3>
            <p style={{ fontSize: 13, color: '#666' }}>支持 memside JSON 与 Markdown，自动识别格式。</p>
            <ImportTrigger conflict={importConflict} onConflictChange={setImportConflict} onResult={(msg) => { setImportResult(msg); void refresh(tab) }} />
            {importResult ? <p style={{ fontSize: 13, color: '#080' }}>{importResult}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * LLM 设置区块（spec：状态可见性 + 生效回显硬需求）。
 * 常驻生效回显行：当前生效来源 · baseURL · model · 打码 token。
 * 三输入框 + 保存 / 测试连接 / 清除；token 留空保存 = 保持原值。
 */
function LlmSettings() {
  const [state, setState] = useState<LlmSettingsState | null>(null)
  const [protocol, setProtocol] = useState<'anthropic' | 'openai'>('anthropic')
  const [baseURL, setBaseURL] = useState('')
  const [token, setToken] = useState('')
  const [model, setModel] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    try {
      const s = await getLlmSettings()
      setState(s)
      if (s?.saved?.protocol) setProtocol(s.saved.protocol) // 下拉跟随已存协议
      setError(null)
    }
    catch (e) { setError(String(e)) } // fetch 失败显错误（不静默）
  }
  useEffect(() => { void refresh() }, [])

  const onSave = async () => {
    setBusy(true); setMsg(null)
    try {
      const s = await saveLlmSettings({
        protocol,
        ...(baseURL !== '' ? { baseURL } : {}),
        ...(token !== '' ? { token } : {}),
        ...(model !== '' ? { model } : {}),
      })
      setState(s)
      if (s?.saved?.protocol) setProtocol(s.saved.protocol)
      setToken(''); setMsg('已保存')
    } catch (e) { setMsg(`保存失败: ${e}`) }
    finally { setBusy(false) }
  }
  // 「清除」只清空输入框，不动已保存的 UI 级凭证（spec bug fix 2026-08-17：
  // 旧版 onClear 发 {clear:true} 删整级 key，「当前生效」会回退到 settings.json/
  // env 里的下层凭证，用户看到的「已保存 api 被换掉」实为凭证链回退）。要真正
  // 删除已保存配置用下面的「删除已保存」（带二次确认 + 回退提示）。
  const onClear = async () => {
    setBaseURL(''); setToken(''); setModel(''); setProtocol('anthropic')
    setMsg('已清空输入框（未改动已保存配置）')
  }
  const onDelete = async () => {
    if (!state?.saved) { setMsg('没有已保存配置可删除'); return }
    if (!confirm('将删除已保存的 UI 配置，生效 API 会回退到 settings.json / 环境变量里的凭证。确认？')) return
    setBusy(true); setMsg(null)
    try { setState(await saveLlmSettings({ clear: true })); setBaseURL(''); setToken(''); setModel(''); setProtocol('anthropic'); setMsg('已删除已保存配置') }
    catch (e) { setMsg(`删除失败: ${e}`) }
    finally { setBusy(false) }
  }
  const onTest = async () => {
    setBusy(true); setMsg(null)
    try {
      const r = await testLlmConnection({
        protocol,
        ...(baseURL !== '' ? { baseURL } : {}),
        ...(token !== '' ? { token } : {}),
        ...(model !== '' ? { model } : {}),
      })
      setMsg(r.ok ? '连接成功' : `连接失败: ${r.error ?? '未知错误'}`)
    } catch (e) { setMsg(`测试失败: ${e}`) }
    finally { setBusy(false) }
  }
  const [effBusy, setEffBusy] = useState(false)
  const [effMsg, setEffMsg] = useState<string | null>(null)

  const onTestEffective = async () => {
    setEffBusy(true); setEffMsg(null)
    try {
      const r = await testEffectiveLlmConnection()
      setEffMsg(r.ok ? '生效连接成功' : `生效连接失败: ${r.error ?? '未知错误'}`)
    } catch (e) { setEffMsg(`生效测试失败: ${e}`) }
    finally { setEffBusy(false) }
  }

  const eff = state?.effective ?? null
  return (
    <section style={{ margin: '12px 0', padding: 12, border: '1px solid #ddd', borderRadius: 8 }}>
      <h3 style={{ margin: '0 0 8px' }}>LLM 设置</h3>
      {/* 生效回显行（硬需求）：让用户一眼看到当前实际生效的是哪套 API */}
      <div style={{ marginBottom: 8, fontSize: 13 }}>
        当前生效：{eff
          ? <><b>{llmSourceLabel(eff.source)}</b>{' · '}{eff?.protocol ?? 'anthropic'}{' · '}{eff.baseURL ?? '官方端点'}{' · '}{eff.model ?? '默认模型'}{' · '}token <code>{eff.tokenMasked}</code>
            {' '}<button disabled={effBusy} onClick={() => void onTestEffective()}>测试生效</button>{effBusy ? ' 测中…' : ''}</>
          : <b>未配置</b>}
        {effMsg ? <span style={{ color: effMsg.includes('失败') ? '#b00' : '#080' }}>{effMsg}</span> : null}
      </div>
      {error ? <div style={{ color: '#b00', marginBottom: 8 }}>设置加载失败: {error}</div> : null}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <label style={{ fontSize: 13 }}>协议</label>
        <select value={protocol} onChange={(e) => setProtocol(e.target.value as 'anthropic' | 'openai')}
          style={{ flex: '0 0 auto' }}>
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
        </select>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <input style={{ flex: '2 1 260px' }} placeholder={state?.saved?.baseURL ?? (protocol === 'openai' ? 'baseURL（OpenAI 格式，拼 /chat/completions）' : 'baseURL（留空=官方端点，拼 /v1/messages）')}
          value={baseURL} onChange={(e) => setBaseURL(e.target.value)} />
        <input style={{ flex: '2 1 260px' }} placeholder={state?.saved ? `token（留空保持 ${state.saved.tokenMasked}）` : 'token'}
          value={token} onChange={(e) => setToken(e.target.value)} />
        <input style={{ flex: '1 1 180px' }} placeholder={state?.saved?.model ?? 'model（留空=默认）'}
          value={model} onChange={(e) => setModel(e.target.value)} />
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button disabled={busy} onClick={() => void onSave()}>保存</button>
        <button disabled={busy} onClick={() => void onTest()}>测试连接</button>
        <button disabled={busy} onClick={() => void onClear()}>清除输入</button>
        <button disabled={busy || !state?.saved} onClick={() => void onDelete()} style={{ color: '#c00' }}>删除已保存</button>
        {busy ? <span style={{ color: '#888' }}>处理中…</span> : null}
        {msg ? <span style={{ color: msg.startsWith('连接失败') || msg.includes('失败') ? '#b00' : '#080' }}>{msg}</span> : null}
      </div>
      {/* 测试连接语义澄清（spec 2026-08-14 §3.4 G4）：消除「测试绿 = 蒸馏必成」错觉。 */}
      <div style={{ marginTop: 6, fontSize: 12, color: '#888' }}>
        仅验证端点可达；长蒸馏请求可能仍失败，失败会在状态栏警示条提示
      </div>
    </section>
  )
}

/**
 * 判定设置区块(spec 2026-08-07 §3.1)。模式卡片(radio 语义,带后果说明)+
 * 预算段(仅质量模式显示,完整中文 label)+ 保存行聚合(输入框初值=生效值,
 * 改动显「有未保存修改」)。fetch/保存失败显错误,不静默。scheduler 每 tick 现读,
 * UI 改动即时生效不重启 daemon。
 */
function JudgeSettings() {
  const [cfg, setCfg] = useState<JudgeConfigDto | null>(null)
  const [mode, setMode] = useState<'quality' | 'economy'>('quality')
  const [maxRounds, setMaxRounds] = useState('30')
  const [timeBudgetS, setTimeBudgetS] = useState('300')
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    try {
      const c = await fetchJudgeConfig()
      setCfg(c)
      setMode(c.mode)
      setMaxRounds(String(c.maxRounds))
      setTimeBudgetS(String(c.timeBudgetS))
      setError(null)
    }
    catch (e) { setError(String(e)) } // fetch 失败显错误（不静默）
  }
  useEffect(() => { void refresh() }, [])

  const onSave = async () => {
    setBusy(true); setMsg(null)
    try {
      const c = await saveJudgeConfig({
        mode,
        maxRounds: Number(maxRounds),
        timeBudgetS: Number(timeBudgetS),
      })
      setCfg(c)
      setMode(c.mode)
      setMaxRounds(String(c.maxRounds))
      setTimeBudgetS(String(c.timeBudgetS))
      setMsg('已保存,立即生效')
    } catch (e) { setMsg(`保存失败: ${e}`) }
    finally { setBusy(false) }
  }

  const dirty = cfg !== null && (
    mode !== cfg.mode
    || Number(maxRounds) !== cfg.maxRounds
    || Number(timeBudgetS) !== cfg.timeBudgetS)

  return (
    <section style={{ margin: '12px 0', padding: 12, border: '1px solid #ddd', borderRadius: 8 }}>
      <h3 style={{ margin: '0 0 8px' }}>判定</h3>
      <p style={{ margin: '0 0 10px', fontSize: 13, color: '#666' }}>
        每条候选记忆进审批队列前,AI 先判一遍值不值得记;被判丢的直接进「AI自动拒绝」,可恢复。
      </p>
      {error ? <div style={{ color: '#b00', marginBottom: 8 }}>设置加载失败: {error}</div> : null}
      {/* 模式卡片:radio 语义,选中高亮边框,带后果说明 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <div onClick={() => setMode('quality')}
          style={{
            flex: '1 1 260px', cursor: 'pointer', padding: 10, borderRadius: 8, fontSize: 13,
            border: mode === 'quality' ? '2px solid #222' : '1px solid #ddd',
            background: mode === 'quality' ? '#fafafa' : '#fff',
          }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            <input type="radio" checked={mode === 'quality'} onChange={() => setMode('quality')} style={{ marginRight: 6 }} />
            质量模式(默认)
          </div>
          <div style={{ color: '#666' }}>
            AI 会打开候选来源的项目仓库,亲手搜代码、读文件查证后再判决。判得准,但慢、费 token。
          </div>
        </div>
        <div onClick={() => setMode('economy')}
          style={{
            flex: '1 1 260px', cursor: 'pointer', padding: 10, borderRadius: 8, fontSize: 13,
            border: mode === 'economy' ? '2px solid #222' : '1px solid #ddd',
            background: mode === 'economy' ? '#fafafa' : '#fff',
          }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            <input type="radio" checked={mode === 'economy'} onChange={() => setMode('economy')} style={{ marginRight: 6 }} />
            经济模式
          </div>
          <div style={{ color: '#666' }}>
            AI 只看候选文字本身,一次出判决,不查仓库。快、省 token;拿不准时倾向把候选留下(不会误丢有用的)。
          </div>
        </div>
      </div>
      {/* 预算段:仅质量模式显示(经济模式不跑 agent,预算无意义) */}
      {mode === 'quality' ? (
        <div style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 6 }}>
            <label style={{ fontSize: 13 }}>
              查证次数上限
              <input type="number" min={1} max={200} value={maxRounds}
                onChange={(e) => setMaxRounds(e.target.value)}
                style={{ display: 'block', marginTop: 4, width: 120 }} />
              <span style={{ display: 'block', marginTop: 4, color: '#888', fontSize: 12, maxWidth: 240 }}>
                每批 15 条候选,AI 最多动手查多少次;查满就用已有信息直接判决。
              </span>
            </label>
            <label style={{ fontSize: 13 }}>
              查证时间上限(秒)
              <input type="number" min={30} max={3600} value={timeBudgetS}
                onChange={(e) => setTimeBudgetS(e.target.value)}
                style={{ display: 'block', marginTop: 4, width: 120 }} />
              <span style={{ display: 'block', marginTop: 4, color: '#888', fontSize: 12, maxWidth: 240 }}>
                每批最多花多少秒,超时同上。
              </span>
            </label>
          </div>
          <div style={{ fontSize: 12, color: '#888' }}>预算耗尽或出任何故障,结果都是「保留」,不会误丢。</div>
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button disabled={busy} onClick={() => void onSave()}>保存</button>
        {busy ? <span style={{ color: '#888' }}>处理中…</span> : null}
        {!busy && dirty ? <span style={{ color: '#b80', fontSize: 13 }}>有未保存修改</span> : null}
        {msg ? <span style={{ color: msg.includes('失败') ? '#b00' : '#080' }}>{msg}</span> : null}
      </div>
    </section>
  )
}

/**
 * 记忆三 tab 共用的批量操作条（spec 2026-08-16 task-10）。tab: MemoryTabKey（未
 * 收窄，candidate/approved/rejected 比较合法）决定显示哪组 tab 专属按钮；
 * selectedCount 显「已选 N 条」；onBulk* 由 App 注入对应批量 handler。
 */
function MemoryBatchBar({ tab, selectedCount, onSelectAll, onClear, onBulkApprove, onBulkReject, onBulkArchive, onBulkUnarchive, onBulkRestore, onBulkDelete }: {
  tab: MemoryTabKey
  selectedCount: number
  onSelectAll: () => void
  onClear: () => void
  onBulkApprove: () => void
  onBulkReject: () => void
  onBulkArchive: () => void
  onBulkUnarchive: () => void
  onBulkRestore: () => void
  onBulkDelete: () => void
}) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, padding: 8, border: '1px solid #e0e0e0', borderRadius: 8, background: '#fafafa' }}>
      <span style={{ fontSize: 13 }}>已选 {selectedCount} 条</span>
      <button onClick={onSelectAll}>全选当前页</button>
      <button onClick={onClear}>取消选择</button>
      <span style={{ marginLeft: 'auto' }} />
      {tab === 'candidate' ? (
        <>
          <button onClick={onBulkApprove}>批量批准</button>
          <button onClick={onBulkReject}>批量拒绝</button>
        </>
      ) : null}
      {tab === 'approved' ? (
        <>
          <button onClick={onBulkArchive}>批量归档</button>
          <button onClick={onBulkUnarchive}>批量取消归档</button>
        </>
      ) : null}
      {tab === 'rejected' ? (
        <button onClick={onBulkRestore}>批量恢复</button>
      ) : null}
      <button onClick={onBulkDelete} style={{ color: '#c00' }}>批量删除</button>
    </div>
  )
}

/**
 * 通用记忆卡片骨架。操作按钮按 tab 注入(可选回调):候选 tab 传 onApprove/
 * onReject/onEdit/onViewSource(现有行为);已审批 tab 传 onArchive/onUnarchive
 * (按 status 决定显示哪个),superseded 传 readOnlyReason='已被取代' 只读;已拒绝
 * tab 传 onRestore。未提供的回调不渲染对应按钮,保持各 tab 操作集干净。
 */
function MemoryCard({
  m,
  onApprove,
  onReject,
  onEdit,
  onViewSource,
  onArchive,
  onUnarchive,
  onRestore,
  readOnlyReason,
  selected,
  onToggleSelect,
}: {
  m: MemoryItem
  onApprove?: () => void
  onReject?: () => void
  onEdit?: (title: string, bodyMd: string, scopeType: 'project' | 'global', subjectSlug: string | null) => Promise<void>
  onViewSource?: () => void
  onArchive?: () => void
  onUnarchive?: () => void
  onRestore?: () => void
  readOnlyReason?: string
  /** 多选（spec 2026-08-16 task-10）：onToggleSelect 提供即渲染勾选框，selected 控制受控状态。 */
  selected?: boolean
  onToggleSelect?: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(m.title)
  const [body, setBody] = useState(m.bodyMd ?? '')
  const [scope, setScope] = useState<'project' | 'global'>(m.scopeType === 'project' ? 'project' : 'global')
  const [slug, setSlug] = useState(m.subjectSlug ?? '')
  const [editError, setEditError] = useState<string | null>(null)
  const sourceLabel = m.sourceCwd
    ? (m.sourceCwd.split(/[\\/]/).filter(Boolean).pop() ?? m.sourceCwd)
    : m.sourceKind === 'manual'
      ? '手动'
      : m.runtime === 'opencode'
        ? 'opencode'
        : '未知'
  const time = formatMemoryTime(m.createdAt)
  async function save() {
    setEditError(null)
    try {
      await onEdit?.(title, body, scope, slug.trim() === '' ? null : slug.trim())
      setEditing(false)
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 16, marginBottom: 12 }}>
      {editing && onEdit ? (
        <>
          <div style={{ marginBottom: 8 }}>
            <label style={{ marginRight: 12 }}>
              <input type="radio" checked={scope === 'project'} onChange={() => setScope('project')} /> project
            </label>
            <label>
              <input type="radio" checked={scope === 'global'} onChange={() => setScope('global')} /> global
            </label>
          </div>
          <input value={title} onChange={(e) => setTitle(e.target.value)} style={{ width: '100%', marginBottom: 8 }} />
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} style={{ width: '100%', marginBottom: 8 }} />
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="subject slug（kebab-case，可留空）"
            style={{ width: '100%', marginBottom: 8 }}
          />
          <button onClick={save}>保存</button>
          <button onClick={() => setEditing(false)}>取消</button>
          {editError && <div style={{ color: '#c00', fontSize: 12, marginTop: 6 }}>{editError}</div>}
        </>
      ) : (
        <>
          {onToggleSelect ? (
            <input type="checkbox" checked={selected ?? false} onChange={onToggleSelect} style={{ marginRight: 8 }} />
          ) : null}
          <strong>{stripCategoryPrefix(m.title)}</strong>
          {/* 徽章行：分类 -> 价值 -> 出处 -> 主题；各带字段名前缀 + 悬停 tip（spec §6.1） */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0' }}>
            {(() => { const cat = categoryInfo(categoryFromTitle(m.title)); return cat ? (
              <span title={cat.tip} style={{ ...CHIP_STYLE, color: '#444' }}>分类：{cat.name}</span>
            ) : null })()}
            {(() => { const v = valueClassInfo(m.valueClass); return (
              <span title={v.tip} style={{ ...CHIP_STYLE, color: '#444' }}>价值：{v.name}{v.priority ? ` · ${v.priority}优先` : ''}</span>
            ) })()}
            {(() => { const ob = originBadge(m.origin); return ob ? (
              <span title={ob.tip} style={{ ...CHIP_STYLE, color: ob.color }}>出处：{ob.label}</span>
            ) : null })()}
            {m.subjectSlug ? (
              <span title={SLUG_BADGE_TIP} style={{ ...CHIP_STYLE, color: '#36c' }}>主题：{m.subjectSlug}</span>
            ) : null}
          </div>
          {m.evidence ? (
            <p style={{ color: '#6a1b9a', fontSize: 13, margin: '4px 0' }}>出处：{m.evidence}</p>
          ) : null}
          {m.bodyMd && <p style={{ color: '#555' }}>{m.bodyMd}</p>}
          <small>
            {(() => { const s = scopeInfo(m.scopeType); return (
              <span title={s.tip}>范围: {s.name}</span>
            ) })()}
            {' · '}
            <span title={runtimeTip(m.runtime)}>会话工具: {runtimeLabel(m.runtime)}</span>
            {' · '}
            <span>源项目: <span title={m.sourceCwd ?? ''}>{sourceLabel}</span></span>
            {time ? <>{' · '}<span title="AI 从会话提炼出这条记忆的时间">提炼于: {time}</span></> : null}
          </small>
          <div style={{ marginTop: 8 }}>
            {readOnlyReason ? (
              <span style={{ color: '#888', fontSize: 13 }}>{readOnlyReason}</span>
            ) : (
              <>
                {onApprove && (
                  <button onClick={onApprove} style={{ marginRight: 8 }}>
                    批准
                  </button>
                )}
                {onReject && (
                  <button onClick={onReject} style={{ marginRight: 8 }}>
                    拒绝
                  </button>
                )}
                {onArchive && (
                  <button onClick={onArchive} style={{ marginRight: 8 }}>
                    归档
                  </button>
                )}
                {onUnarchive && (
                  <button onClick={onUnarchive} style={{ marginRight: 8 }}>
                    取消归档
                  </button>
                )}
                {onRestore && (
                  <button onClick={onRestore} style={{ marginRight: 8 }}>
                    撤回拒绝
                  </button>
                )}
                {onEdit && <button onClick={() => { setEditError(null); setEditing(true) }}>编辑</button>}
                {onViewSource && m.distillJobId ? (
                  <button onClick={onViewSource} style={{ marginLeft: 8 }}>
                    查看原始输入
                  </button>
                ) : null}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * AI 自动拒绝记录卡片(discards tab)。展示 title/bodyMd/reason 徽标/来源/时间。
 * promotedMemoryId 非 null -> 已提升为候选,显「已提升」标注并禁用 promote 按钮;
 * 否则显「提升为候选」按钮调 promoteDiscard(no-throw,操作后 refresh 自然更新)。
 */
function DiscardCard({ d, onPromote }: { d: DiscardItem; onPromote: () => void }) {
  const promoted = !!d.promotedMemoryId
  const sourceLabel = d.sourceCwd
    ? (d.sourceCwd.split(/[\\/]/).filter(Boolean).pop() ?? d.sourceCwd)
    : d.sourceKind === 'manual'
      ? '手动'
      : (d.sourceKind ?? '未知')
  const time = formatMemoryTime(d.ts)
  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 16, marginBottom: 12 }}>
      <strong>{stripCategoryPrefix(d.title)}</strong>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0' }}>
        {(() => { const cat = categoryInfo(categoryFromTitle(d.title)); return cat ? (
          <span title={cat.tip} style={{ ...CHIP_STYLE, color: '#444' }}>分类：{cat.name}</span>
        ) : null })()}
        <span title="AI 自动拒绝候选的理由。想找回可点「提升为候选」。" style={{ ...CHIP_STYLE, color: '#c00' }}>拒绝理由: {discardReasonLabel(d.reason)}</span>
      </div>
      {d.bodyMd && <p style={{ color: '#555' }}>{d.bodyMd}</p>}
      <small>
        {(() => { const s = scopeInfo(d.scopeType ?? null); return (
          <span title={s.tip}>范围: {s.name}</span>
        ) })()}
        {' · '}
        <span>源项目: <span title={d.sourceCwd ?? ''}>{sourceLabel}</span></span>
        {time ? <>{' · '}<span title="AI 自动拒绝这条候选的时间">拒绝于: {time}</span></> : null}
      </small>
      <div style={{ marginTop: 8 }}>
        {promoted ? (
          <span style={{ color: '#080', fontSize: 13 }}>已提升</span>
        ) : (
          <button onClick={onPromote}>提升为候选</button>
        )}
      </div>
    </div>
  )
}

/**
 * 回收站卡片(trash tab)。展示被软删记忆的 title/分类/价值/主题徽标 + 范围/
 * 会话工具/源项目/删除时间 meta。「恢复」按钮调 restoreFromTrash(no-throw，
 * 操作后本地移除 + refresh 自然收敛)。镜像 DiscardCard 结构以保持视觉一致。
 */
function TrashCard({ t, onRestore }: { t: TrashItem; onRestore: () => void }) {
  const sourceLabel = t.sourceCwd
    ? (t.sourceCwd.split(/[\\/]/).filter(Boolean).pop() ?? t.sourceCwd)
    : t.runtime === 'opencode'
      ? 'opencode'
      : '未知'
  const time = formatMemoryTime(t.deletedAt)
  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 16, marginBottom: 12 }}>
      <strong>{stripCategoryPrefix(t.title)}</strong>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0' }}>
        {(() => { const cat = categoryInfo(categoryFromTitle(t.title)); return cat ? (
          <span title={cat.tip} style={{ ...CHIP_STYLE, color: '#444' }}>分类：{cat.name}</span>
        ) : null })()}
        {(() => { const v = valueClassInfo(t.valueClass); return (
          <span title={v.tip} style={{ ...CHIP_STYLE, color: '#444' }}>价值：{v.name}{v.priority ? ` · ${v.priority}优先` : ''}</span>
        ) })()}
        {t.subjectSlug ? (
          <span title={SLUG_BADGE_TIP} style={{ ...CHIP_STYLE, color: '#36c' }}>主题：{t.subjectSlug}</span>
        ) : null}
      </div>
      <small>
        {(() => { const s = scopeInfo(t.scopeType); return (
          <span title={s.tip}>范围: {s.name}</span>
        ) })()}
        {' · '}
        <span title={runtimeTip(t.runtime)}>会话工具: {runtimeLabel(t.runtime)}</span>
        {' · '}
        <span>源项目: <span title={t.sourceCwd ?? ''}>{sourceLabel}</span></span>
        {time ? <>{' · '}<span title="被删除进入回收站的时间">删除于: {time}</span></> : null}
      </small>
      <div style={{ marginTop: 8 }}>
        <button onClick={onRestore}>恢复</button>
      </div>
    </div>
  )
}

/**
 * 蒸馏记录列表行(runs tab)。outcome 徽标 + 计数链 + 来源/时间/耗时 + 「查看详情」
 * 按钮（打开 DistillRunModal）。subagent 来源显 'subagent'，否则显 cwd 末段。
 * 复用 formatOutcome / formatRunCounts / formatMemoryTime 纯函数。
 * spec §4.9：hasDegradations 时在 outcome 徽标旁加琥珀色「降级」mini-badge
 * （明细在 modal 的 degradations 区，#e65100 与状态横幅同色）。
 * spec §6：pausedStep 非 null 时显「⏸ 已暂停-某步失败」徽标 + 重试轮次 + 重试/放弃
 * 按钮。重试 = resetJobForRetry 回 pending，放弃 = abandonJob 标 done。
 */
function DistillRunRow({ r, onOpen, onRetry, onAbandon }: { r: DistillRunListItem; onOpen: () => void; onRetry: () => void; onAbandon: () => void }) {
  const oc = formatOutcome(r.outcome)
  const cwdLabel = r.cwd ? (r.cwd.split(/[\\/]/).filter(Boolean).pop() ?? r.cwd) : '未知'
  const time = formatMemoryTime(r.createdAt)
  const paused = !!r.pausedStep
  return (
    <div style={{ border: '1px solid #eee', borderRadius: 6, padding: 12, marginBottom: 8, ...(paused ? { borderColor: '#ffb300', background: '#fffdf0' } : {}) }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>
          <span style={{ background: oc.color, color: '#fff', borderRadius: 4, padding: '2px 8px', fontSize: 12 }}>{oc.label}</span>
          {r.hasDegradations && (
            <span style={{ color: '#e65100', border: '1px solid #e65100', borderRadius: 4, padding: '1px 6px', fontSize: 11, marginLeft: 6 }}>降级</span>
          )}
          {paused ? (
            <span style={{ color: '#b26a00', border: '1px solid #ffb300', borderRadius: 4, padding: '1px 6px', fontSize: 11, marginLeft: 6 }}>
              ⏸ 已暂停-{r.pausedStep}失败
            </span>
          ) : null}
          {paused && r.attempts ? (
            <span style={{ color: '#888', fontSize: 11, marginLeft: 6 }}>第 {r.attempts} 轮重试</span>
          ) : null}
        </span>
        <span style={{ fontFamily: 'monospace', fontSize: 13 }}>{formatRunCounts({ distilled: r.rawCount, deduped: r.dedupedCount, filtered: r.filteredCount, stored: r.storedCount })}</span>
      </div>
      {r.outcome === 'llm_error' && r.errorMessage && (
        <div style={{ color: '#c00', fontSize: 12, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {r.errorMessage}
        </div>
      )}
      <div style={{ fontSize: 13, color: '#555', marginTop: 6 }}>
        {r.sourceAgentId ? 'subagent' : cwdLabel}{time ? ` · ${time}` : ''} · {r.durationMs}ms
      </div>
      <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
        <button onClick={onOpen}>查看详情</button>
        {paused ? (
          <>
            <button onClick={onRetry} style={{ color: '#1565c0' }}>重试</button>
            <button onClick={onAbandon} style={{ color: '#c00' }}>放弃</button>
          </>
        ) : null}
      </div>
    </div>
  )
}

function SourceInputModal({ memoryId, onClose }: { memoryId: string; onClose: () => void }) {
  const [data, setData] = useState<SourceInput | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setData(null)
    getSourceInput(memoryId)
      .then((d) => { if (!cancelled) setData(d) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [memoryId])

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0,0,0,0.5)', display: 'flex',
        alignItems: 'flex-start', justifyContent: 'center', padding: 40,
        overflow: 'auto', zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 8, maxWidth: 900, width: '100%',
          maxHeight: '85vh', overflow: 'auto', padding: 20,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <strong>{data?.title ?? '原始输入'}</strong>
          <button onClick={onClose} style={{ fontSize: 18, lineHeight: 1 }}>×</button>
        </div>

        {loading ? (
          <p style={{ color: '#666' }}>加载中…</p>
        ) : error ? (
          <p style={{ color: '#c00' }}>无法加载原始输入: {error}</p>
        ) : data && data.available ? (
          <>
            <p style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>
              蒸馏时喂给模型的过滤版（文件类工具已压缩、超长已截断）· {data.turnCount ?? 0} turn · 约 {data.charCount ?? 0} 字
            </p>
            {data.bodyMd ? <p style={{ color: '#555', marginBottom: 12 }}>{data.bodyMd}</p> : null}
            <div>
              {(data.turns ?? []).map((t: SourceTurn, i: number) => {
                const { label, color } = formatSourceTurn(t)
                return (
                  <div key={i} style={{ marginBottom: 8, border: '1px solid #eee', borderRadius: 4, padding: 8 }}>
                    <span style={{ color, fontWeight: 600, fontSize: 12 }}>[{label}]</span>
                    {formatToolCall(t.toolCall) && (
                      <div style={{ fontSize: 12, color: '#6a1b9a' }}>{formatToolCall(t.toolCall)}</div>
                    )}
                    <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13 }}>{t.content}</pre>
                  </div>
                )
              })}
            </div>
          </>
        ) : (
          <p style={{ color: '#666' }}>该记忆无原始输入快照</p>
        )}
      </div>
    </div>
  )
}

/**
 * 蒸馏记录详情遮罩层(runs tab 点「查看详情」打开)。三态:加载中 / 错误 / 数据。
 * ESC / × / 背景点击关闭(参照 SourceInputModal)。产出区按 outcome 分支:
 * produced -> rawOutput.candidates JSON 展示;empty_output/llm_error/skipped 各显
 * 对应文案。「模型返回 N 条，M 条格式不合格被丢弃」hint 仅在 rawCount >
 * acceptedCount 时出现。原始输入懒加载(点按钮才拉 getDistillRunSourceInput)。
 */
function DistillRunModal({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof getDistillRun>> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<{ turnCount: number; charCount: number; turns: SourceTurn[] } | null>(null)
  const [sourceLoading, setSourceLoading] = useState(false)
  const [sourceError, setSourceError] = useState<string | null>(null)
  const [sourceLoaded, setSourceLoaded] = useState(false)
  // 降级明细（spec §4.9）：modal 打开即懒加载 GET /api/distill-runs/:jobId/degradations，
  // 三态不静默——degs=null 加载中 / degsError 红字 / 列表。
  const [degs, setDegs] = useState<null | { kind: string; detail: string | null; ts: number }[]>(null)
  const [degsError, setDegsError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setDegs(null)
    setDegsError(null)
    getRunDegradations(jobId)
      .then((r) => { if (!cancelled) setDegs(r.degradations) })
      .catch((e) => { if (!cancelled) setDegsError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [jobId])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setDetail(null)
    getDistillRun(jobId)
      .then((d) => { if (!cancelled) setDetail(d) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [jobId])

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const loadSource = async () => {
    // Reset all source states on each load so prior results/errors don't linger.
    setSourceLoading(true)
    setSourceError(null)
    setSource(null)
    setSourceLoaded(false)
    try {
      setSource(await getDistillRunSourceInput(jobId))
      setSourceLoaded(true)
    } catch (e) {
      // fetch itself rejected (network error): getDistillRunSourceInput only
      // returns null on !res.ok; a transport failure throws and must surface
      // (CLAUDE.md state-visibility: no silent stalls).
      setSourceError(e instanceof Error ? e.message : String(e))
    } finally {
      setSourceLoading(false)
    }
  }

  const raw = detail?.rawOutput as { candidates?: unknown[]; agentTrace?: unknown; judgeFallback?: unknown } | null | undefined
  const cands = raw?.candidates
  // spec §4.5 透明化:agent 终审的探查轨迹 + 降级标记必须可回看。
  // 防御式渲染:旧 run 没有这两个键,agentTrace 元素形状也不假设。
  const agentTrace: { kind?: unknown; text?: unknown; toolName?: unknown; toolResult?: unknown }[] | null =
    Array.isArray(raw?.agentTrace) ? (raw.agentTrace as unknown[]).filter(
      (s): s is { kind?: unknown; text?: unknown; toolName?: unknown; toolResult?: unknown } => !!s && typeof s === 'object',
    ) : null
  const judgeFallback = typeof raw?.judgeFallback === 'string' ? raw.judgeFallback : null
  const oc = detail ? formatOutcome(detail.outcome) : null
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0,0,0,0.5)', display: 'flex',
        alignItems: 'flex-start', justifyContent: 'center', padding: 40,
        overflow: 'auto', zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 8, maxWidth: 900, width: '100%',
          maxHeight: '85vh', overflow: 'auto', padding: 20,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <strong>蒸馏记录详情</strong>
          <button onClick={onClose} style={{ fontSize: 18, lineHeight: 1 }}>×</button>
        </div>

        {loading ? (
          <p style={{ color: '#666' }}>加载中…</p>
        ) : error ? (
          <p style={{ color: '#c00' }}>无法加载: {error}</p>
        ) : detail && oc ? (
          <>
            <div style={{ marginBottom: 8 }}>
              <span style={{ background: oc.color, color: '#fff', borderRadius: 4, padding: '2px 8px', fontSize: 12 }}>{oc.label}</span>
              <span style={{ marginLeft: 8, fontFamily: 'monospace' }}>{formatRunCounts({ distilled: detail.rawCount, deduped: detail.dedupedCount, filtered: detail.filteredCount, stored: detail.storedCount })}</span>
              {detail.rawCount > detail.acceptedCount && (
                <span style={{ marginLeft: 8, color: '#999' }}>模型返回 {detail.rawCount} 条，{detail.rawCount - detail.acceptedCount} 条格式不合格被丢弃</span>
              )}
            </div>
            {judgeFallback ? (
              <div style={{ background: '#fff8e6', borderLeft: '3px solid #d90', color: '#775500', padding: 8, marginBottom: 12, fontSize: 13 }}>
                价值判定降级: {judgeFallback}(该批走了经济模式单发判定,未跑 agent 终审)
              </div>
            ) : null}
            <div style={{ marginBottom: 12 }}>
              <strong>产出：</strong>
              {detail.outcome === 'empty_output' ? <span>LLM 返回 0 候选</span>
                : detail.outcome === 'llm_error' ? (
                  <div>
                    <span style={{ color: '#c00' }}>LLM 调用失败</span>
                    {detail.errorMessage ? (
                      <pre style={{ background: '#fff4f4', color: '#c00', padding: 8, margin: '4px 0', whiteSpace: 'pre-wrap', borderLeft: '3px solid #c00' }}>{detail.errorMessage}</pre>
                    ) : <span style={{ color: '#999', marginLeft: 8 }}>（无错误描述）</span>}
                  </div>
                )
                : detail.outcome === 'parse_error' ? (
                  <div>
                    <span style={{ color: '#c00' }}>模型输出解析失败（重试 3 次均未获合法 JSON）</span>
                    {detail.errorMessage ? (
                      <pre style={{ background: '#fff4f4', color: '#c00', padding: 8, margin: '4px 0', whiteSpace: 'pre-wrap', borderLeft: '3px solid #c00' }}>{detail.errorMessage}</pre>
                    ) : <span style={{ color: '#999', marginLeft: 8 }}>（无错误描述）</span>}
                    <div style={{ marginTop: 8 }}>
                      <strong>模型原始输出</strong>
                      {detail.rawText ? (
                        <pre style={{ background: '#f7f7f7', padding: 8, margin: '4px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflow: 'auto', fontSize: 12 }}>{detail.rawText}</pre>
                      ) : <span style={{ color: '#999', marginLeft: 8 }}>（无留存）</span>}
                    </div>
                  </div>
                )
                : detail.outcome === 'skipped_no_new_turns' ? <span>该 job 无新 turn，未调用 LLM</span>
                : detail.outcome === 'skipped_trivial' ? <span>新增内容过少，未调用 LLM</span>
                : Array.isArray(cands) ? cands.map((c, i) => (
                    <pre key={i} style={{ background: '#f7f7f7', padding: 8, margin: '4px 0', whiteSpace: 'pre-wrap' }}>{JSON.stringify(c, null, 2)}</pre>
                  )) : <span>（无产出解析）</span>}
            </div>
            {/* 降级记录（spec §4.9）：loading / error / 列表三态；无降级不渲染。 */}
            {degsError ? (
              <div style={{ marginTop: 8, color: '#c00', fontSize: 13 }}>无法加载降级记录: {degsError}</div>
            ) : degs === null ? (
              <div style={{ marginTop: 8, color: '#999', fontSize: 13 }}>降级记录加载中…</div>
            ) : degs.length > 0 ? (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontWeight: 600 }}>降级记录</div>
                {degs.map((d) => (
                  <div key={d.kind + d.ts} style={{ color: '#e65100', fontSize: 13 }}>
                    {degradationKindLabel(d.kind)}{d.detail ? `：${d.detail}` : ''}
                  </div>
                ))}
              </div>
            ) : null}
            {agentTrace && agentTrace.length > 0 ? (
              <div style={{ marginBottom: 12 }}>
                <strong>agent 探查轨迹（{agentTrace.length} 步）：</strong>
                {agentTrace.map((s, i) => (
                  <div key={i} style={{ marginBottom: 8, border: '1px solid #eee', borderRadius: 4, padding: 8 }}>
                    <span style={{
                      color: s.kind === 'tool' ? '#06c' : s.kind === 'final' ? '#080' : '#c60',
                      fontWeight: 600, fontSize: 12,
                    }}>
                      [{typeof s.kind === 'string' ? s.kind : '?'}]{typeof s.toolName === 'string' ? ` ${s.toolName}` : ''}
                    </span>
                    {typeof s.text === 'string' && s.text ? (
                      <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13 }}>{s.text}</pre>
                    ) : null}
                    {typeof s.toolResult === 'string' && s.toolResult ? (
                      <pre style={{ background: '#f7f7f7', margin: '4px 0 0', padding: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13 }}>{s.toolResult}</pre>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
            <div>
              <button onClick={loadSource} disabled={sourceLoading}>{sourceLoading ? '加载中…' : '查看原始输入'}</button>
              {sourceError ? (
                <p style={{ color: '#c00', marginTop: 8 }}>无法加载原始输入: {sourceError}</p>
              ) : source === null && sourceLoaded ? (
                <p style={{ color: '#666', marginTop: 8 }}>该 job 无原始输入快照</p>
              ) : source ? (
                <div style={{ marginTop: 8 }}>
                  <p style={{ color: '#666' }}>{source.turnCount} turn · 约 {source.charCount} 字</p>
                  {source.turns.map((t, i) => {
                    const f = formatSourceTurn(t)
                    return (
                      <div key={i} style={{ borderLeft: `3px solid ${f.color}`, padding: '4px 8px', margin: '4px 0' }}>
                        <span style={{ color: f.color, fontWeight: 600, fontSize: 12 }}>[{f.label}]</span>
                        {formatToolCall(t.toolCall) && (
                          <div style={{ fontSize: 12, color: '#6a1b9a' }}>{formatToolCall(t.toolCall)}</div>
                        )}
                        <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13 }}>{t.content}</pre>
                      </div>
                    )
                  })}
                </div>
              ) : null}
            </div>
          </>
        ) : (
          <p style={{ color: '#666' }}>无记录</p>
        )}
      </div>
    </div>
  )
}

/**
 * 筛选条下拉（spec 2026-08-11-web-memory-filters §4.3）：首项「全部」= 不筛
 * 该维度；选项来自 /api/facets 动态生成带计数。
 */
function FilterSelect({ label, value, onChange, options, disabled }: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string; title?: string }[]
  disabled?: boolean
}) {
  return (
    <label style={{ fontSize: 13, color: '#444' }}>
      {label}{' '}
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} style={{ fontSize: 13 }}>
        <option value="">全部</option>
        {options.map((o) => (
          <option key={o.value} value={o.value} title={o.title}>{o.label}</option>
        ))}
      </select>
    </label>
  )
}

/**
 * 导出触发器（spec 2026-08-16 task-10 §Web UI §3）。内部维护 scope + format 两个
 * 选择 + busy 态。doExport 调 exportMemories → 拿 Blob → URL.createObjectURL +
 * <a download> 触发浏览器下载 → revoke → onDone 关闭 modal。scope='selected' 时
 * 透传 ids（空数组时服务端返回空导出，安全）。scope='filter' 时透传当前 tab 的
 * 四维筛选（project→sourceCwd 映射）+ tab 派生 statuses（memoryTabFilter(tab) 按
 * 逗号拆），服务端 listMemoriesForExport 据此圈定当前 tab 筛选集——否则会静默导出
 * 全表（spec §导出三档作用域 + §失败模式 #4）。
 */
function ExportTrigger({ selectedIds, filter, tab, onDone }: {
  selectedIds: string[]
  filter: MemoryFilter
  tab: MemoryTabKey
  onDone: () => void
}) {
  const [scope, setScope] = useState<'selected' | 'filter' | 'all'>('all')
  const [format, setFormat] = useState<'json' | 'markdown'>('json')
  const [busy, setBusy] = useState(false)
  async function doExport() {
    setBusy(true)
    try {
      const blob = await exportMemories({
        scope, format,
        ids: scope === 'selected' ? selectedIds : undefined,
        filter: scope === 'filter' ? { sourceCwd: filter.project, subjectSlug: filter.slug, category: filter.category, valueClass: filter.valueClass } : undefined,
        statuses: scope === 'filter' ? memoryTabFilter(tab).split(',') : undefined,
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = format === 'json' ? 'memside-export.json' : 'memside-export.md'
      a.click()
      URL.revokeObjectURL(url)
      onDone()
    } finally { setBusy(false) }
  }
  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <label><input type="radio" checked={scope === 'selected'} onChange={() => setScope('selected')} /> 导出选中</label>{' '}
        <label><input type="radio" checked={scope === 'filter'} onChange={() => setScope('filter')} /> 导出当前筛选</label>{' '}
        <label><input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} /> 导出全部</label>
      </div>
      <div style={{ marginBottom: 8 }}>
        <label><input type="radio" checked={format === 'json'} onChange={() => setFormat('json')} /> memside JSON</label>{' '}
        <label><input type="radio" checked={format === 'markdown'} onChange={() => setFormat('markdown')} /> Markdown</label>
      </div>
      <button onClick={doExport} disabled={busy}>{busy ? '导出中…' : '下载'}</button>
      <button onClick={onDone}>取消</button>
    </div>
  )
}

/**
 * 导入触发器（spec 2026-08-16 task-10 §Web UI §3）。冲突策略由 App 提升态传入
 * （importConflict），文件选择后调 importMemoriesApi(file, conflict) → onResult
 * 回显摘要；失败显错误行不静默。accept .json,.md，服务端按内容自动识别格式。
 */
function ImportTrigger({ conflict, onConflictChange, onResult }: {
  conflict: 'skip' | 'overwrite' | 'newid'
  onConflictChange: (c: 'skip' | 'overwrite' | 'newid') => void
  onResult: (msg: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true); setError(null)
    try {
      const r = await importMemoriesApi(file, conflict)
      onResult(`导入 ${r.imported} 条 · 跳过 ${r.skipped} · 覆盖 ${r.overwritten}` + (r.errors.length ? ` · 错误 ${r.errors.length}` : ''))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }
  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <label><input type="radio" checked={conflict === 'skip'} onChange={() => onConflictChange('skip')} /> 跳过已存在</label>{' '}
        <label><input type="radio" checked={conflict === 'overwrite'} onChange={() => onConflictChange('overwrite')} /> 覆盖已存在</label>{' '}
        <label><input type="radio" checked={conflict === 'newid'} onChange={() => onConflictChange('newid')} /> 全部新建</label>
      </div>
      <input type="file" accept=".json,.md" onChange={onFile} disabled={busy} />
      {busy ? <span style={{ fontSize: 13, color: '#888' }}>导入中…</span> : null}
      {error ? <p style={{ color: '#c00', fontSize: 13 }}>{error}</p> : null}
    </div>
  )
}

/**
 * 运行环境设置（spec runtime-settings-redesign §3.6）。
 * 双分组：claude/codeagent（claude-code fork）+ opencode/nga（opencode fork）。
 * 每组：可见标签字段 + 实时「→ 将写入」预览 + 「保存并安装」（先存再装，消除改了没存的脚枪）+「卸载」。
 * fetch/操作失败显错误不静默（CLAUDE.md 状态可见性）。不做持久「已装」徽标（无法可靠自检）。
 */
function RuntimeSettings() {
  const [state, setState] = useState<RuntimeSettingsState | null>(null)
  const [claudeDir, setClaudeDir] = useState('')
  const [settingsFilename, setSettingsFilename] = useState('')
  const [opencodeDir, setOpencodeDir] = useState('')
  const [claudeMsg, setClaudeMsg] = useState<string | null>(null)
  const [opencodeMsg, setOpencodeMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [claudeBusy, setClaudeBusy] = useState(false)
  const [opencodeBusy, setOpencodeBusy] = useState(false)

  const refresh = async () => {
    try {
      const s = await getRuntimeSettings()
      setState(s)
      setClaudeDir(s.claudeDir); setSettingsFilename(s.settingsFilename); setOpencodeDir(s.opencodeDir)
      setError(null)
    } catch (e) { setError(String(e)) }
  }
  useEffect(() => { void refresh() }, [])

  const defaults = state?.defaults ?? { claudeDir: '~/.claude', settingsFilename: 'settings.json', opencodeDir: '~/.config/opencode' }
  const claudePreview = resolveClaudePath(claudeDir, settingsFilename, defaults)
  const opencodePreview = resolveOpencodePath(opencodeDir, defaults)

  const onClaudeInstall = async () => {
    setClaudeBusy(true); setClaudeMsg(null)
    try {
      const s = await saveRuntimeSettings({ claudeDir, settingsFilename })
      setState(s); setClaudeDir(s.claudeDir); setSettingsFilename(s.settingsFilename)
      const r = await installRuntimeHooks('claude')
      setClaudeMsg(r.ok ? `✓ 已安装到 ${r.settingsPath ?? claudePreview}` : `安装失败: ${r.error ?? '未知错误'}`)
    } catch (e) { setClaudeMsg(`操作失败: ${e}`) }
    finally { setClaudeBusy(false) }
  }
  const onClaudeUninstall = async () => {
    setClaudeBusy(true); setClaudeMsg(null)
    try {
      const r = await uninstallRuntimeHooks('claude')
      setClaudeMsg(r.ok ? `✓ 已移除 ${r.removed ?? 0} 个 hook 组` : `卸载失败: ${r.error ?? '未知错误'}`)
    } catch (e) { setClaudeMsg(`卸载失败: ${e}`) }
    finally { setClaudeBusy(false) }
  }
  const onOpencodeInstall = async () => {
    setOpencodeBusy(true); setOpencodeMsg(null)
    try {
      const s = await saveRuntimeSettings({ opencodeDir })
      setState(s); setOpencodeDir(s.opencodeDir)
      const r = await installRuntimeHooks('opencode')
      setOpencodeMsg(r.ok ? `✓ 已安装到 ${r.pluginPath ?? opencodePreview}` : `安装失败: ${r.error ?? '未知错误'}`)
    } catch (e) { setOpencodeMsg(`操作失败: ${e}`) }
    finally { setOpencodeBusy(false) }
  }
  const onOpencodeUninstall = async () => {
    setOpencodeBusy(true); setOpencodeMsg(null)
    try {
      const r = await uninstallRuntimeHooks('opencode')
      setOpencodeMsg(r.ok
        ? `✓ 已移除 ${r.removed ?? 0} 个 plugin 条目${r.dirRemoved ? ' + 插件目录' : ''}`
        : `卸载失败: ${r.error ?? '未知错误'}`)
    } catch (e) { setOpencodeMsg(`卸载失败: ${e}`) }
    finally { setOpencodeBusy(false) }
  }

  const msgStyle = (m: string | null) => m === null ? undefined : (m.includes('失败') ? { color: '#b00' } : { color: '#080' })

  return (
    <section style={{ margin: '12px 0', padding: 12, border: '1px solid #ddd', borderRadius: 8 }}>
      <h3 style={{ margin: '0 0 8px' }}>运行环境</h3>
      <p style={{ margin: '0 0 10px', fontSize: 13, color: '#666' }}>
        memside 往你所用 agent 的配置里写 hooks/plugin，才能抓取会话 + 注入记忆。官方 Claude Code / opencode 用默认路径、无需改动；公司内部 agent（如 codeagent 读 <code>~/.cac/setting.json</code>）才需改路径。
      </p>
      {error ? <div style={{ color: '#b00', marginBottom: 8 }}>设置加载失败: {error}</div> : null}

      <div style={{ margin: '12px 0', padding: 10, border: '1px solid #eee', borderRadius: 6 }}>
        <h4 style={{ margin: '0 0 8px', fontSize: 14 }}>Claude Code / codeagent <span style={{ fontSize: 12, color: '#888' }}>claude-code fork</span></h4>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
          <label style={{ flex: '2 1 260px', fontSize: 12, color: '#555' }}>配置目录
            <input style={{ width: '100%', marginTop: 2 }} placeholder={defaults.claudeDir} value={claudeDir} onChange={(e) => setClaudeDir(e.target.value)} />
          </label>
          <label style={{ flex: '1 1 180px', fontSize: 12, color: '#555' }}>文件名
            <input style={{ width: '100%', marginTop: 2 }} placeholder={defaults.settingsFilename} value={settingsFilename} onChange={(e) => setSettingsFilename(e.target.value)} />
          </label>
        </div>
        <div style={{ margin: '4px 0 8px', fontSize: 12, color: '#888' }}>→ 将写入：<code>{claudePreview}</code></div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button disabled={claudeBusy} onClick={() => void onClaudeInstall()}>保存并安装</button>
          <button disabled={claudeBusy} onClick={() => void onClaudeUninstall()}>卸载</button>
          {claudeBusy ? <span style={{ color: '#888' }}>处理中…</span> : null}
          {claudeMsg ? <span style={msgStyle(claudeMsg)}>{claudeMsg}</span> : null}
        </div>
      </div>

      <div style={{ margin: '12px 0', padding: 10, border: '1px solid #eee', borderRadius: 6 }}>
        <h4 style={{ margin: '0 0 8px', fontSize: 14 }}>opencode / nga <span style={{ fontSize: 12, color: '#888' }}>opencode fork</span></h4>
        <label style={{ display: 'block', fontSize: 12, color: '#555', marginBottom: 6 }}>配置目录
          <input style={{ width: '100%', marginTop: 2 }} placeholder={defaults.opencodeDir} value={opencodeDir} onChange={(e) => setOpencodeDir(e.target.value)} />
        </label>
        <div style={{ margin: '4px 0 8px', fontSize: 12, color: '#888' }}>→ 将写入：<code>{opencodePreview}</code></div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button disabled={opencodeBusy} onClick={() => void onOpencodeInstall()}>保存并安装</button>
          <button disabled={opencodeBusy} onClick={() => void onOpencodeUninstall()}>卸载</button>
          {opencodeBusy ? <span style={{ color: '#888' }}>处理中…</span> : null}
          {opencodeMsg ? <span style={msgStyle(opencodeMsg)}>{opencodeMsg}</span> : null}
        </div>
      </div>

      <div style={{ marginTop: 6, fontSize: 12, color: '#888' }}>
        提示：codeagent 用户通常填 claude 目录 <code>~/.cac</code> + 文件名 <code>setting.json</code>。安装仅写入上述路径，请确认是 agent 实际读取的配置文件。卸载只移除 memside 管理的项，不影响你自己写的 hooks/plugins。
      </div>
    </section>
  )
}
