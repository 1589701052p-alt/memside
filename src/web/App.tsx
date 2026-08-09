import { useEffect, useRef, useState } from 'react'
import {
  listMemoriesPage, listDiscardsPage, listDistillRunsPage, WEB_PAGE_SIZE,
  promoteMemory, patchMemory, getStatus, getSourceInput,
  restoreMemory, archiveMemory, unarchiveMemory, promoteDiscard,
  getDistillRun, getDistillRunSourceInput, getRunDegradations, ackDegradations,
  getLlmSettings, saveLlmSettings, testLlmConnection, testEffectiveLlmConnection,
  fetchJudgeConfig, saveJudgeConfig, startRescan, cancelRescan,
  bulkRejectUnevaluated as bulkRejectUnevaluatedApi,
  type MemoryItem, type MemsideStatus, type SourceInput, type SourceTurn, type DiscardItem,
  type DistillRunListItem, type LlmSettingsState, type JudgeConfigDto,
} from './api'
import { formatMemoryTime, sortCandidatesByTime, formatSourceTurn, formatOutcome, formatRunCounts, llmSourceLabel, originBadge, discardReasonLabel, rescanPercent, degradationKindLabel, formatToolCall } from './ui-utils'
import { memoryTabFilter, shouldShowLoading, mergeAppend, mergeRefreshPage, nextCursorAfter, tabTotalCount, isListTab, type MemoryTabKey } from './tab-cache'

/**
 * valueClass -> 中文徽标 / 优先级排序。模块顶层定义以便 MemoryCard 直接复用
 * valueBadge,不必经 props 透传。
 *
 * 6 筐优先级:user-rule/decision=高(0),preference/convention/trap/topology=中(1),
 * null=未评估(2)。候选队列按此排序,高价值先审;未评估条目可一键批量拒绝。
 * 出处驱动的价值判定（2026-07-30）扩 6 筐。
 */
const VALUE_LABEL: Record<string, string> = {
  'user-rule': '高·规矩', decision: '高·决策',
  preference: '中·偏好', convention: '中·约定', trap: '中·陷阱', topology: '中·拓扑',
}
function valueBadge(vc: string | null | undefined): string {
  return vc && VALUE_LABEL[vc] ? VALUE_LABEL[vc] : '未评估'
}
function priorityRank(vc: string | null | undefined): number {
  if (vc === 'user-rule' || vc === 'decision') return 0
  if (vc && VALUE_LABEL[vc]) return 1
  return 2
}

type TabKey = 'candidate' | 'approved' | 'rejected' | 'discards' | 'runs' | 'settings'

/**
 * 每 tab 的分页缓存形状（spec 2026-08-07 tab 列表分页）。items=已加载条目，
 * nextCursor=下一页游标（before），hasMore=是否还有更多。Task 8 无限滚动直接复用。
 */
interface TabPage<T> { items: T[]; nextCursor: { ts: number; id: string } | null; hasMore: boolean }
function emptyPage<T>(): TabPage<T> { return { items: [], nextCursor: null, hasMore: true } }

/**
 * 5+1 tab 视图：候选审批 / 已审批 / 已拒绝 / AI自动拒绝 / 蒸馏记录 五个列表 tab
 * + 设置 tab（isListTab 判据区分，spec 2026-08-07 settings-tab）。顶部 tab 切换。每列表 tab
 * 独立数据源 + 操作 + 3s 轮询;切 tab 清旧 interval 建新的(useEffect 依赖 tab)。
 * 候选 tab 仍同时拉 status;其余 tab 也拉 status(计数徽标 + 状态栏)。
 *
 * 状态栏(后台可见性)保持不动:已捕获事件 / distill 进行中 / 最近错误,让用户
 * 看到 daemon 在干活。fetch 失败显错误 banner,切 tab 显「加载中…」,空列表显
 * 对应文案,不静默 stall 出白页。
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
  const [loaded, setLoaded] = useState<Record<TabKey, boolean>>({ candidate: false, approved: false, rejected: false, discards: false, runs: false, settings: false })
  // candidate 初始 true:默认 tab 首帧即显「加载中…」,避免先闪一帧空态「暂无候选记忆」
  // (对齐重构前的初始 loading=true 行为)。
  const [pending, setPending] = useState<Record<TabKey, boolean>>({ candidate: true, approved: false, rejected: false, discards: false, runs: false, settings: false })
  const [status, setStatus] = useState<MemsideStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sourceInputFor, setSourceInputFor] = useState<string | null>(null)
  const [runDetailFor, setRunDetailFor] = useState<string | null>(null)
  const [rescanError, setRescanError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState<Record<TabKey, boolean>>({ candidate: false, approved: false, rejected: false, discards: false, runs: false, settings: false })
  const [loadMoreError, setLoadMoreError] = useState<Record<TabKey, string | null>>({ candidate: null, approved: null, rejected: null, discards: null, runs: null, settings: null })
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const loadMoreRef = useRef<(t: TabKey) => Promise<void>>(async () => {})

  async function refresh(target: TabKey) {
    if (!isListTab(target)) return // settings tab 无列表数据流（spec settings-tab §3.2）
    setPending((p) => ({ ...p, [target]: true }))
    try {
      if (target === 'discards') {
        const [pg, st] = await Promise.all([listDiscardsPage(fetch, { limit: WEB_PAGE_SIZE }), getStatus()])
        setDiscards((d) => mergeRefreshPage(d, pg, (x) => x.id))
        setStatus(st)
      } else if (target === 'runs') {
        const [pg, st] = await Promise.all([listDistillRunsPage(fetch, { limit: WEB_PAGE_SIZE }), getStatus(fetch)])
        setRuns((r) => mergeRefreshPage(r, pg, (x) => x.distillJobId))
        setStatus(st)
      } else {
        const [pg, st] = await Promise.all([listMemoriesPage(fetch, { status: memoryTabFilter(target as MemoryTabKey), limit: WEB_PAGE_SIZE }), getStatus()])
        setMemCache((c) => ({ ...c, [target as MemoryTabKey]: mergeRefreshPage(c[target as MemoryTabKey], pg, (x) => x.id) }))
        setStatus(st)
      }
      setLoaded((l) => ({ ...l, [target]: true }))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPending((p) => ({ ...p, [target]: false }))
    }
  }

  // 当前 tab 分页读取 helper：discards/runs 独立 state，其余走 memCache。
  function tabPageOf(target: TabKey): TabPage<MemoryItem> | TabPage<DiscardItem> | TabPage<DistillRunListItem> {
    return target === 'discards' ? discards : target === 'runs' ? runs : memCache[target as MemoryTabKey]
  }

  // 无限滚动加载下一页：守卫（首轮/加载中）-> 按游标拉下一页 -> mergeAppend 追加。
  // 失败记 loadMoreError，尾部显重试按钮，不静默。
  async function loadMore(target: TabKey) {
    if (!isListTab(target)) return // settings tab 无列表数据流（spec settings-tab §3.2）
    if (pending[target] || loadingMore[target]) return
    const cur = tabPageOf(target)
    const before = nextCursorAfter(cur)
    if (!before) return // hasMore=false 或无游标
    setLoadingMore((l) => ({ ...l, [target]: true }))
    setLoadMoreError((e) => ({ ...e, [target]: null }))
    try {
      if (target === 'discards') {
        const pg = await listDiscardsPage(fetch, { limit: WEB_PAGE_SIZE, before })
        setDiscards((d) => ({ items: mergeAppend(d.items, pg.items, (x) => x.id), nextCursor: pg.nextCursor, hasMore: pg.hasMore }))
      } else if (target === 'runs') {
        const pg = await listDistillRunsPage(fetch, { limit: WEB_PAGE_SIZE, before })
        setRuns((r) => ({ items: mergeAppend(r.items, pg.items, (x) => x.distillJobId), nextCursor: pg.nextCursor, hasMore: pg.hasMore }))
      } else {
        const pg = await listMemoriesPage(fetch, { status: memoryTabFilter(target as MemoryTabKey), limit: WEB_PAGE_SIZE, before })
        setMemCache((c) => ({ ...c, [target as MemoryTabKey]: { items: mergeAppend(c[target as MemoryTabKey].items, pg.items, (x) => x.id), nextCursor: pg.nextCursor, hasMore: pg.hasMore } }))
      }
    } catch (e) {
      setLoadMoreError((er) => ({ ...er, [target]: e instanceof Error ? e.message : String(e) }))
    } finally {
      setLoadingMore((l) => ({ ...l, [target]: false }))
    }
  }

  // loadMoreRef 每渲染同步最新闭包，避免 Observer 回调拿陈旧 state
  useEffect(() => { loadMoreRef.current = loadMore })

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
    void refresh(tab)
  }
  async function reject(id: string) {
    await promoteMemory(id, { action: 'reject' })
    removeFromTab(tab, id)
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

  // 服务端按条件批量（spec 决策 4）：POST /api/memories/bulk-reject-unevaluated
  // 清空整个未评估尾队，不限于已加载部分。返回后重置 candidate 缓存（决策 8）
  // 防已拒条目滞留，refresh 拉页 1 重建。
  async function bulkRejectUnevaluated() {
    await bulkRejectUnevaluatedApi()
    setMemCache((c) => ({ ...c, candidate: emptyPage() }))
    void refresh('candidate')
  }

  // 记忆列表按 createdAt 倒序(newest first)。memCache 在 candidate/approved/rejected
  // tab 分别是对应 status 的子集(server 已过滤),客户端再排一次保证顺序一致。
  const memItems = sortCandidatesByTime(memCache[tab as MemoryTabKey]?.items ?? [])
  const jobs = status?.jobs ?? {}
  const running = (jobs.running ?? 0) + (jobs.pending ?? 0)
  const listEmpty = tab === 'discards' ? discards.items.length === 0
    : tab === 'runs' ? runs.items.length === 0
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
    { key: 'settings', label: '设置', count: null }, // 设置 tab 无计数徽标
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
              onClick={() => setTab(t.key)}
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
            <span>
              已捕获事件 <b>{status.events}</b>
            </span>
            {' · '}
            <span>
              distill: <b>{running > 0 ? `${running} 进行中` : '空闲'}</b>
            </span>
            {jobs.done ? (
              <>
                {' · '}
                <span>完成 {jobs.done}</span>
              </>
            ) : null}
            {jobs.failed ? (
              <>
                {' · '}
                <span style={{ color: '#c00' }}>失败 {jobs.failed}</span>
              </>
            ) : null}
            {' · '}
            <span>
              记忆: {status.memories.candidate ?? 0} 待审 / {status.memories.approved ?? 0} 已批准
            </span>
            {status.lastError ? (
              <div style={{ marginTop: 6, color: '#c00' }}>
                最近错误: {String(status.lastError.error).slice(0, 160)}
              </div>
            ) : null}
            {/* 降级横幅（spec §4.9 降级可见化）：数据走既有 status 轮询不新增 fetch；
                只在 count24h>0 且（未 ack 或最新降级晚于 ack）时出现。「知道了」调
                POST /api/degradations/ack（ack_ts 落 appSettings）；ack 失败横幅
                自然留下（ack_ts 未落库），不静默吞错。 */}
            {status.recentDegradations && status.recentDegradations.count24h > 0 &&
             (status.recentDegradations.acknowledgedTs === null ||
              (status.recentDegradations.latest && status.recentDegradations.latest.ts > status.recentDegradations.acknowledgedTs)) ? (
              <div style={{ marginTop: 6, color: '#e65100' }}>
                近 24h {status.recentDegradations.count24h} 次降级
                {status.recentDegradations.latest ? `: ${degradationKindLabel(status.recentDegradations.latest.kind)}` : ''}
                <button style={{ marginLeft: 8, fontSize: 12 }} onClick={() => { void ackDegradations().then(() => refresh(tab)).catch(() => {}) }}>知道了</button>
              </div>
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

      {/* 列表 - 按 tab 渲染对应数据 + 操作;加载中 / 空 / 错误三态不静默 stall */}
      {tab === 'settings' ? (
        <>
          {/* 设置区块挂载点（spec 2026-08-07 settings-tab §3.5）：
              新增设置 = 新 section 组件 + 此处追加一行。
              section 约定：<section> 包裹 + <h3> 标题 + 自管理 fetch/保存/错误行。 */}
          <LlmSettings />
          <JudgeSettings />
        </>
      ) : error ? null : showLoading && listEmpty ? (
        <p>加载中…</p>
      ) : tab === 'candidate' ? (
        <>
          <p>{tabTotalCount(status, 'candidate') ?? memItems.length} 条候选记忆待审</p>
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
              onApprove={() => approve(m.id)}
              onReject={() => reject(m.id)}
              onEdit={(t, b, s, slug) => edit(m.id, t, b, s, slug)}
              onViewSource={() => setSourceInputFor(m.id)}
            />
          ))}
          {memItems.length === 0 && !showLoading && (
            <p style={{ color: '#666' }}>
              暂无候选记忆。结束一个 claude code 会话后,后台会异步提炼(distill 约 15-30s),候选记忆会自动出现在这里。上方状态栏可看后台进度。
            </p>
          )}
        </>
      ) : tab === 'approved' ? (
        <>
          <p>{tabTotalCount(status, 'approved') ?? memItems.length} 条已审批记忆</p>
          {memItems.map((m) => (
            <MemoryCard
              key={m.id}
              m={m}
              readOnlyReason={m.status === 'superseded' ? '已被取代' : undefined}
              onArchive={m.status === 'approved' ? () => archive(m.id) : undefined}
              onUnarchive={m.status === 'archived' ? () => unarchive(m.id) : undefined}
            />
          ))}
          {memItems.length === 0 && !showLoading && (
            <p style={{ color: '#666' }}>暂无已审批记忆</p>
          )}
        </>
      ) : tab === 'rejected' ? (
        <>
          <p>{tabTotalCount(status, 'rejected') ?? memItems.length} 条已拒绝记忆</p>
          {memItems.map((m) => (
            <MemoryCard
              key={m.id}
              m={m}
              onRestore={() => restore(m.id)}
            />
          ))}
          {memItems.length === 0 && !showLoading && (
            <p style={{ color: '#666' }}>暂无已拒绝记忆</p>
          )}
        </>
      ) : tab === 'runs' ? (
        <div>
          <p>共 {tabTotalCount(status, 'runs') ?? runs.items.length} 条蒸馏记录</p>
          {runs.items.map((r) => (
            <DistillRunRow key={r.distillJobId} r={r} onOpen={() => setRunDetailFor(r.distillJobId)} />
          ))}
          {runs.items.length === 0 && !showLoading && (
            <p style={{ color: '#666' }}>暂无蒸馏记录</p>
          )}
        </div>
      ) : (
        <>
          <p>{tabTotalCount(status, 'discards') ?? discards.items.length} 条 AI 自动拒绝记录</p>
          {discards.items.map((d) => (
            <DiscardCard key={d.id} d={d} onPromote={() => promote(d.id)} />
          ))}
          {discards.items.length === 0 && !showLoading && (
            <p style={{ color: '#666' }}>暂无 AI 自动拒绝记录</p>
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
  const onClear = async () => {
    setBusy(true); setMsg(null)
    try { setState(await saveLlmSettings({ clear: true })); setBaseURL(''); setModel(''); setProtocol('anthropic'); setMsg('已清除 UI 配置') }
    catch (e) { setMsg(`清除失败: ${e}`) }
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
        <button disabled={busy} onClick={() => void onClear()}>清除</button>
        {busy ? <span style={{ color: '#888' }}>处理中…</span> : null}
        {msg ? <span style={{ color: msg.startsWith('连接失败') || msg.includes('失败') ? '#b00' : '#080' }}>{msg}</span> : null}
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
          <strong>{m.title}</strong>
          <span style={{ marginLeft: 8, fontSize: 12, color: '#888' }}>{valueBadge(m.valueClass)}</span>
          {(() => { const ob = originBadge(m.origin); return ob ? (
            <span style={{ marginLeft: 8, fontSize: 12, color: ob.color }}>{ob.label}</span>
          ) : null })()}
          {m.subjectSlug ? (
            <span style={{ marginLeft: 8, fontSize: 12, color: '#36c' }}>[{m.subjectSlug}]</span>
          ) : null}
          {m.evidence ? (
            <p style={{ color: '#6a1b9a', fontSize: 13, margin: '4px 0' }}>出处：{m.evidence}</p>
          ) : null}
          {m.bodyMd && <p style={{ color: '#555' }}>{m.bodyMd}</p>}
          <small>
            {m.scopeType} · {m.runtime ?? '任意 runtime'} · 来源: <span title={m.sourceCwd ?? ''}>{sourceLabel}</span>
            {time ? ` · ${time}` : ''}
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
      <strong>{d.title}</strong>
      <span style={{ marginLeft: 8, fontSize: 12, color: '#c00' }}>{discardReasonLabel(d.reason)}</span>
      {d.bodyMd && <p style={{ color: '#555' }}>{d.bodyMd}</p>}
      <small>
        {d.scopeType ?? '未知 scope'} · 来源: <span title={d.sourceCwd ?? ''}>{sourceLabel}</span>
        {time ? ` · ${time}` : ''}
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
 * 蒸馏记录列表行(runs tab)。outcome 徽标 + 计数链 + 来源/时间/耗时 + 「查看详情」
 * 按钮（打开 DistillRunModal）。subagent 来源显 'subagent'，否则显 cwd 末段。
 * 复用 formatOutcome / formatRunCounts / formatMemoryTime 纯函数。
 * spec §4.9：hasDegradations 时在 outcome 徽标旁加琥珀色「降级」mini-badge
 * （明细在 modal 的 degradations 区，#e65100 与状态横幅同色）。
 */
function DistillRunRow({ r, onOpen }: { r: DistillRunListItem; onOpen: () => void }) {
  const oc = formatOutcome(r.outcome)
  const cwdLabel = r.cwd ? (r.cwd.split(/[\\/]/).filter(Boolean).pop() ?? r.cwd) : '未知'
  const time = formatMemoryTime(r.createdAt)
  return (
    <div style={{ border: '1px solid #eee', borderRadius: 6, padding: 12, marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>
          <span style={{ background: oc.color, color: '#fff', borderRadius: 4, padding: '2px 8px', fontSize: 12 }}>{oc.label}</span>
          {r.hasDegradations && (
            <span style={{ color: '#e65100', border: '1px solid #e65100', borderRadius: 4, padding: '1px 6px', fontSize: 11, marginLeft: 6 }}>降级</span>
          )}
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
      <button onClick={onOpen} style={{ marginTop: 8 }}>查看详情</button>
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
