/**
 * Web UI API client (Task 15).
 *
 * Thin fetch wrappers for the Task 13 HTTP API (`src/server.ts`). Each function
 * takes an injectable `fetchFn` (defaulting to global `fetch`) so tests can mock
 * the network without touching a real server - this is the testable seam; the
 * React component that consumes these is not unit-tested for MVP.
 *
 * Response shapes mirror what `createApp` in `src/server.ts` returns:
 *   - GET  /api/memories            -> { items: MemoryRow[] }
 *   - POST /api/memories/:id/promote -> { memory: MemoryRow }
 *   - PATCH /api/memories/:id        -> { memory: MemoryRow, changedFields: string[] }
 */

export interface MemoryItem {
  id: string
  title: string
  bodyMd?: string
  status: string
  scopeType?: string
  runtime?: string | null
  sourceCwd?: string | null
  sourceKind?: string
  distillJobId?: string | null
  createdAt?: number
  version?: number
  valueClass?: string | null
  /** 出处（spec §R1）；老行/手动记忆为 null。user-stated|user-confirmed|agent-observed。 */
  origin?: string | null
  /** 出处原句摘抄（spec §R1）；老行/无标注为 null。 */
  evidence?: string | null
  subjectSlug?: string | null
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export async function listMemories(
  fetchFn: FetchLike = fetch,
  status?: string,
): Promise<MemoryItem[]> {
  const url = status ? `/api/memories?status=${encodeURIComponent(status)}` : '/api/memories'
  const res = await fetchFn(url)
  const data = await res.json()
  return (data.items ?? []) as MemoryItem[]
}

export async function promoteMemory(
  id: string,
  body: { action: 'approve' | 'reject' | 'approve_and_supersede'; supersedeIds?: string[] },
  fetchFn: FetchLike = fetch,
): Promise<MemoryItem> {
  const res = await fetchFn(`/api/memories/${id}/promote`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
  const data = await res.json()
  return data.memory as MemoryItem
}

export async function patchMemory(
  id: string,
  body: { title?: string; bodyMd?: string; tags?: string[]; scopeType?: 'project' | 'global'; scopeId?: string | null; subjectSlug?: string | null },
  fetchFn: FetchLike = fetch,
): Promise<MemoryItem> {
  const res = await fetchFn(`/api/memories/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
  const data = await res.json() as { memory?: MemoryItem; error?: string }
  if (!res.ok) throw new Error(data.error ?? 'patch failed')
  return data.memory as MemoryItem
}

export interface RescanReportDto { processed: number; discarded: number; skipped: number; keptUpdated: number; stopped: boolean }

export interface RescanState {
  running: boolean
  done: number
  total: number
  /** 实时累计判丢数;老 daemon 无此字段。 */
  discarded?: number
  /** 已请求停止(批边界停);老 daemon 无此字段。 */
  stopping?: boolean
  cancelRequested?: boolean
  report: RescanReportDto | null
  /** 运行级崩溃信息;老 daemon 无此字段。 */
  error?: string | null
}

export interface MemsideStatus {
  events: number
  jobs: Record<string, number>
  memories: Record<string, number>
  discards: number
  distillRuns?: { total: number; byOutcome: Record<string, number>; allTime?: number }
  lastError: { error: string } | null
  /** 存量回扫(Task 7)进度/最近报告;老 daemon 无此字段。 */
  rescan?: RescanState
  /** 未评估候选数（status='candidate' 且 valueClass 非保护类）；老 daemon 无此字段。 */
  unevaluatedCandidates?: number
  /** 累加中的 waiting job 数（spec §4.9：单列避免「pending 堆积」假象）；老 daemon 无此字段。 */
  waitingJobs?: number
  /** 暂停等人处置的 job 数（spec §6：3 次失败暂停）；老 daemon 无此字段。 */
  pausedJobs?: number
  /** LLM 实时活动（spec 2026-08-12 §5.8）；老 daemon 无此字段。 */
  llmActivity?: { phase: string; detail: string | null; since: number } | null
  /** 三阶段近 24h 次数与累计耗时；老 daemon 无此字段。 */
  llmStats24h?: {
    distill: { count: number; ms: number }
    dedup: { count: number; ms: number }
    judge: { count: number; ms: number }
  }
  /** 未读消息数（消息 tab 徽标 + 状态栏 🔔）；老 daemon 无此字段。 */
  unreadNotifications?: number
  /** 未读 llm_error 计数（警示条）；老 daemon 无此字段（spec 2026-08-14 §3.2）。 */
  unreadLlmErrors?: number
  /** 未读 degradation 计数（警示条）；老 daemon 无此字段。 */
  unreadDegradations?: number
  /** 未读 hook_missing 计数（🔔 角标琥珀 + 顶部警示条跳设置）；老 daemon 无此字段（spec 2026-08-19 显眼化 §3.3）。 */
  unreadHookMissing?: number
  /** 最新一条未读 hook_missing（警示条「最近：xxx」）；无则 null；老 daemon 无此字段。 */
  latestUnreadHookMissing?: { body: string | null; ts: number } | null
  /** 最新一条未读 llm_error（警示条「最近：xxx」）；无则 null；老 daemon 无此字段。 */
  latestUnreadLlmError?: { body: string | null; ts: number } | null
  /** 回收站条目数（spec 2026-08-16 回收站 tab 徽标）；老 daemon 无此字段。 */
  trashCount?: number
}

/**
 * GET /api/status - daemon background activity for the status bar: how many
 * capture events, distill-job state counts (pending/running/done/failed),
 * memory counts by status, and the most recent distill error (if any).
 */
export async function getStatus(fetchFn: FetchLike = fetch): Promise<MemsideStatus> {
  const res = await fetchFn('/api/status')
  return (await res.json()) as MemsideStatus
}

/**
 * POST /api/memories/bulk-promote - reject multiple candidates in one call
 * (avoids N round-trips when clearing the unevaluated tail of the queue).
 */
export async function bulkPromote(
  ids: string[],
  action: 'reject',
  fetchFn: FetchLike = fetch,
): Promise<{ rejected: number }> {
  const res = await fetchFn('/api/memories/bulk-promote', {
    method: 'POST',
    body: JSON.stringify({ ids, action }),
    headers: { 'content-type': 'application/json' },
  })
  return (await res.json()) as { rejected: number }
}

export interface SourceTurn {
  role: string
  content: string
  isError?: boolean
  toolName?: string
  toolInputPath?: string
  toolCall?: string
}

export interface SourceInput {
  available: boolean
  title?: string
  bodyMd?: string
  valueClass?: string | null
  sourceCwd?: string | null
  createdAt?: number
  turnCount?: number
  charCount?: number
  turns?: SourceTurn[]
}

/**
 * GET /api/memories/:id/source-input - 懒加载产生这条记忆的「蒸馏时喂模型的过滤版
 * transcript」。遮罩层点击时拉取；不进列表轮询。available:false 表示无快照
 * （手动记忆 / 历史记忆 / 写失败）。
 */
export async function getSourceInput(id: string, fetchFn: FetchLike = fetch): Promise<SourceInput> {
  const res = await fetchFn(`/api/memories/${id}/source-input`)
  return (await res.json()) as SourceInput
}

// --- Task 7: memory audit views client ---------------------------------------
// Discards (AI 自动拒绝审计) + archive/unarchive/restore lifecycle. Fields
// mirror server DiscardRow (src/memory/store.ts); optional here because the
// client tolerates partial rows from older daemons.

export interface DiscardItem {
  id: string
  title: string
  bodyMd?: string
  reason: string
  ts?: number
  scopeType?: string | null
  sourceCwd?: string | null
  sourceKind?: string | null
  promotedMemoryId?: string | null
}

export async function listDiscards(fetchFn: FetchLike = fetch): Promise<DiscardItem[]> {
  const res = await fetchFn('/api/discards')
  const data = await res.json()
  return (data.items ?? []) as DiscardItem[]
}

export async function restoreMemory(id: string, fetchFn: FetchLike = fetch): Promise<MemoryItem> {
  const res = await fetchFn(`/api/memories/${id}/restore`, { method: 'POST' })
  const data = await res.json()
  return data.memory as MemoryItem
}

export async function archiveMemory(id: string, fetchFn: FetchLike = fetch): Promise<MemoryItem> {
  const res = await fetchFn(`/api/memories/${id}/archive`, { method: 'POST' })
  const data = await res.json()
  return data.memory as MemoryItem
}

export async function unarchiveMemory(id: string, fetchFn: FetchLike = fetch): Promise<MemoryItem> {
  const res = await fetchFn(`/api/memories/${id}/unarchive`, { method: 'POST' })
  const data = await res.json()
  return data.memory as MemoryItem
}

export async function promoteDiscard(id: string, fetchFn: FetchLike = fetch): Promise<MemoryItem> {
  const res = await fetchFn(`/api/discards/${id}/promote`, { method: 'POST' })
  const data = await res.json()
  return data.memory as MemoryItem
}

// --- Distill runs (工作记录透明化) client ------------------------------------

export type DistillOutcome = 'skipped_no_new_turns' | 'empty_output' | 'llm_error' | 'produced' | 'skipped_trivial' | 'parse_error'

export interface DistillRunListItem {
  distillJobId: string
  outcome: DistillOutcome
  rawCount: number
  acceptedCount: number
  dedupedCount: number
  filteredCount: number
  storedCount: number
  discardedCount: number
  durationMs: number
  errorMessage: string | null
  ts: number
  cwd: string | null
  runtime: string
  createdAt: number
  sourceAgentId: string | null
  /** spec §4.9 行降级徽标；详情端点（getDistillRun）不带此字段，故可选。 */
  hasDegradations?: boolean
  /** spec §4.1 暂停在哪步；非暂停 null。详情端点同样返回。 */
  pausedStep?: string | null
  /** job 整体尝试轮次（spec §6 重试轮次显示）；详情端点不带，故可选。 */
  attempts?: number
  /** 当前步骤失败计数（step_attempts 列，final-fix-3：暂停徽标读真实步骤重试轮次）。 */
  stepAttempts?: number
  /** 当前断点步骤（current_step 列，final-fix-3：状态栏「某步骤第 N 轮重试中」用）。 */
  currentStep?: string | null
}

export interface DistillRunDetail extends DistillRunListItem {
  rawOutput: unknown | null
  /** parse_error 时详情端点带出的模型原始输出（截断存储）；其余 outcome 为 null/缺省。 */
  rawText?: string | null
  /** spec §4.1 暂停在哪步；详情端点返回（run 行 paused_step 列）。 */
  pausedStep?: string | null
}

export async function listDistillRuns(fetchFn: FetchLike = fetch): Promise<DistillRunListItem[]> {
  const res = await fetchFn('/api/distill-runs')
  const data = await res.json()
  return (data.items ?? []) as DistillRunListItem[]
}

export async function getDistillRun(jobId: string, fetchFn: FetchLike = fetch): Promise<DistillRunDetail> {
  const res = await fetchFn(`/api/distill-runs/${jobId}`)
  return (await res.json()) as DistillRunDetail
}

export async function getDistillRunSourceInput(
  jobId: string, fetchFn: FetchLike = fetch,
): Promise<{ turnCount: number; charCount: number; turns: SourceTurn[] } | null> {
  const res = await fetchFn(`/api/distill-runs/${jobId}/source-input`)
  if (!res.ok) return null
  return (await res.json()) as { turnCount: number; charCount: number; turns: SourceTurn[] }
}

// --- 暂停 job 处置（spec §6）client ------------------------------------------
// retry/abandon no-throw 契约（与 restoreMemory 同模式）：404/409 返回 undefined，
// UI 操作后 refresh 收敛真实状态（paused -> pending/done），不静默吞错误。

/** POST /api/distill-runs/:jobId/retry — resetJobForRetry，回 pending 等下个 tick 重跑。 */
export async function retryJob(
  jobId: string, fetchFn: FetchLike = fetch,
): Promise<{ ok: boolean; error?: string } | undefined> {
  const res = await fetchFn(`/api/distill-runs/${encodeURIComponent(jobId)}/retry`, { method: 'POST' })
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string }
    return { ok: false, error: data.error ?? `retry failed (${res.status})` }
  }
  return { ok: true }
}

/** POST /api/distill-runs/:jobId/abandon — abandonJob，标 done 放弃重试。 */
export async function abandonJob(
  jobId: string, fetchFn: FetchLike = fetch,
): Promise<{ ok: boolean; error?: string } | undefined> {
  const res = await fetchFn(`/api/distill-runs/${encodeURIComponent(jobId)}/abandon`, { method: 'POST' })
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string }
    return { ok: false, error: data.error ?? `abandon failed (${res.status})` }
  }
  return { ok: true }
}

// --- 待审查候选（spec §6.4）client -------------------------------------------

/** GET /api/memories/pending-review?project=<cwd> — judge 暂停期间标的 pending_review 候选。 */
export async function listPendingReview(
  project: string, fetchFn: FetchLike = fetch,
): Promise<MemoryItem[]> {
  const qs = project ? `?project=${encodeURIComponent(project)}` : ''
  const res = await fetchFn(`/api/memories/pending-review${qs}`)
  const data = await res.json()
  return (data.items ?? []) as MemoryItem[]
}

/** POST /api/memories/:id/promote-pending-review — pending_review → candidate 进审批队列。 */
export async function promotePendingReview(
  id: string, fetchFn: FetchLike = fetch,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetchFn(`/api/memories/${id}/promote-pending-review`, { method: 'POST' })
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string }
    return { ok: false, error: data.error ?? `promote failed (${res.status})` }
  }
  return { ok: true }
}

// --- 降级可见化（spec §4.9）client --------------------------------------------

/** GET /api/distill-runs/:jobId/degradations — 该 job 的降级明细（modal 懒加载）。 */
export async function getRunDegradations(
  jobId: string, fetchFn: FetchLike = fetch,
): Promise<{ degradations: { id: string; ts: number; kind: string; detail: string | null }[] }> {
  const res = await fetchFn(`/api/distill-runs/${encodeURIComponent(jobId)}/degradations`)
  return (await res.json()) as { degradations: { id: string; ts: number; kind: string; detail: string | null }[] }
}

/** valueClass 筛「未评估」的 URL 哨兵值（= value_class IS NULL），与 store 常量同值。 */
export const UNEVALUATED = 'unevaluated'

export interface FacetValue { value: string; count: number }
export interface Facets {
  projects: FacetValue[]
  categories: FacetValue[]
  slugs: FacetValue[]
  valueClasses: FacetValue[]
}

/** 带筛选下拉的四个 tab；GET /api/facets?tab= 的参数（spec per-tab-memory-filters §4.3）。 */
export type FacetTab = 'candidate' | 'approved' | 'rejected' | 'discards'

/** GET /api/facets?tab= — 按 tab 圈定的下拉选项（随 3s 轮询刷新）。 */
export async function getFacets(fetchFn: FetchLike = fetch, tab: FacetTab): Promise<Facets> {
  const res = await fetchFn(`/api/facets?tab=${tab}`)
  if (!res.ok) throw new Error(`facets ${res.status}`)
  return (await res.json()) as Facets
}

// --- 五 tab 无限滚动分页 client（spec 2026-08-07）--------------------------
// 统一分页形状；旧 daemon 不认识 limit 时返回 { items } 旧形状，hasMore/nextCursor
// 缺省降级 false/null（一页装全部，不崩）。

export interface PageDto<T> { items: T[]; hasMore: boolean; nextCursor: { ts: number; id: string } | null; total: number | null }

export const WEB_PAGE_SIZE = 20

export interface PageOpts { limit?: number; before?: { ts: number; id: string } }

function pageParams(opts?: PageOpts): URLSearchParams {
  const p = new URLSearchParams()
  p.set('limit', String(opts?.limit ?? WEB_PAGE_SIZE))
  if (opts?.before) {
    p.set('before', String(opts.before.ts))
    p.set('beforeId', opts.before.id)
  }
  return p
}

async function parsePage<T>(res: Response): Promise<PageDto<T>> {
  const data = await res.json()
  return {
    items: (data.items ?? []) as T[],
    hasMore: data.hasMore ?? false,
    nextCursor: data.nextCursor ?? null,
    total: data.total ?? null, // 旧 daemon 无 total -> null，UI 降级回已加载条数
  }
}

export async function listMemoriesPage(
  fetchFn: FetchLike = fetch,
  opts: { status: string; project?: string; slug?: string; category?: string; valueClass?: string } & PageOpts = { status: '' },
): Promise<PageDto<MemoryItem>> {
  const p = pageParams(opts)
  p.set('status', opts.status)
  // status 放最前，与测试锁定的 URL 顺序一致
  const qs = new URLSearchParams()
  qs.set('status', opts.status)
  for (const [k, v] of p) qs.set(k, v)
  // 筛选参数在分页参数之后，非空才拼入（空串 = 不筛该维度）
  if (opts.project) qs.set('project', opts.project)
  if (opts.slug) qs.set('slug', opts.slug)
  if (opts.category) qs.set('category', opts.category)
  if (opts.valueClass) qs.set('valueClass', opts.valueClass)
  return parsePage<MemoryItem>(await fetchFn(`/api/memories?${qs}`))
}

export async function listDiscardsPage(
  fetchFn: FetchLike = fetch,
  opts: { project?: string; category?: string } & PageOpts = {},
): Promise<PageDto<DiscardItem>> {
  const qs = pageParams(opts)
  if (opts.project) qs.set('project', opts.project)
  if (opts.category) qs.set('category', opts.category)
  return parsePage<DiscardItem>(await fetchFn(`/api/discards?${qs}`))
}

// --- 消息中心 client（spec 2026-08-12）-----------------------------------------

export interface NotificationItem {
  id: string
  ts: number
  kind: 'degradation' | 'llm_error' | 'parse_error' | 'hook_missing'
  title: string
  body: string | null
  refType: string | null
  refId: string | null
  readAt: number | null
}

export async function listNotificationsPage(
  fetchFn: FetchLike = fetch,
  opts: { kind?: string; unreadOnly?: boolean; q?: string } & PageOpts = {},
): Promise<PageDto<NotificationItem>> {
  const p = pageParams(opts)
  if (opts.kind) p.set('kind', opts.kind)
  if (opts.unreadOnly) p.set('unread', '1')
  if (opts.q) p.set('q', opts.q)
  return parsePage<NotificationItem>(await fetchFn(`/api/notifications?${p}`))
}

/** POST /api/notifications/:id/read — no-throw 契约（与 promote/restore 同模式）。 */
export async function markNotificationRead(id: string, fetchFn: FetchLike = fetch): Promise<void> {
  await fetchFn(`/api/notifications/${id}/read`, { method: 'POST' })
}

/** POST /api/notifications/read-all — no-throw 契约。 */
export async function markAllNotificationsRead(fetchFn: FetchLike = fetch): Promise<void> {
  await fetchFn('/api/notifications/read-all', { method: 'POST' })
}

export async function listDistillRunsPage(
  fetchFn: FetchLike = fetch, opts: PageOpts = {},
): Promise<PageDto<DistillRunListItem>> {
  return parsePage<DistillRunListItem>(await fetchFn(`/api/distill-runs?${pageParams(opts)}`))
}

/** POST /api/memories/bulk-reject-unevaluated — 服务端按条件清空未评估尾队。 */
export async function bulkRejectUnevaluated(fetchFn: FetchLike = fetch): Promise<{ rejected: number }> {
  const res = await fetchFn('/api/memories/bulk-reject-unevaluated', { method: 'POST' })
  return (await res.json()) as { rejected: number }
}

// --- LLM 设置（凭证 UI 配置）client -------------------------------------------

export interface LlmSettingsState {
  saved: { baseURL: string | null; model: string | null; tokenMasked: string; protocol?: 'anthropic' | 'openai' } | null
  effective: { source: string; baseURL: string | null; model: string | null; tokenMasked: string; protocol?: 'anthropic' | 'openai' } | null
}

/** GET /api/settings/llm — saved = UI 配置（打码）；effective = 当前凭证链生效级。 */
export async function getLlmSettings(fetchFn: FetchLike = fetch): Promise<LlmSettingsState> {
  const res = await fetchFn('/api/settings/llm')
  return (await res.json()) as LlmSettingsState
}

/** PUT /api/settings/llm — 字段级合并；clear:true 删除整级。返回最新状态。 */
export async function saveLlmSettings(
  body: { baseURL?: string; token?: string; model?: string; protocol?: 'anthropic' | 'openai'; clear?: boolean },
  fetchFn: FetchLike = fetch,
): Promise<LlmSettingsState> {
  const res = await fetchFn('/api/settings/llm', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
  return (await res.json()) as LlmSettingsState
}

/** POST /api/settings/llm/test — 不保存，当场验证凭证。空 body 测已保存配置。 */
export async function testLlmConnection(
  body: { baseURL?: string; token?: string; model?: string; protocol?: 'anthropic' | 'openai' },
  fetchFn: FetchLike = fetch,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetchFn('/api/settings/llm/test', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
  return (await res.json()) as { ok: boolean; error?: string }
}

/** POST /api/settings/llm/test-effective — 无 body，测当前生效的 API（非 UI 配置）。 */
export async function testEffectiveLlmConnection(
  fetchFn: FetchLike = fetch,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetchFn('/api/settings/llm/test-effective', {
    method: 'POST',
    body: JSON.stringify({}),
    headers: { 'content-type': 'application/json' },
  })
  return (await res.json()) as { ok: boolean; error?: string }
}

/** POST /api/rescan — 存量回扫(Task 7):fire-and-forget,进度走 /api/status 轮询。
 * 409 = 已在跑(不视为错误,进度由轮询显示);其它非 2xx 抛错,UI 显错误横幅不静默。 */
export async function startRescan(fetchFn: FetchLike = fetch): Promise<void> {
  const res = await fetchFn('/api/rescan', { method: 'POST' })
  if (res.status === 409) return
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(data.error ?? `rescan failed (${res.status})`)
  }
}

/** POST /api/rescan/cancel — 批边界停止(spec 2026-08-07 §3.2):只置标记,
 * 正在判的批照常判完。409(未在跑)静默返回——轮询自愈,不算错误。 */
export async function cancelRescan(fetchFn: FetchLike = fetch): Promise<void> {
  const res = await fetchFn('/api/rescan/cancel', { method: 'POST' })
  if (res.status === 409) return
  if (!res.ok) {
    const data = (await res.json()) as { error?: string }
    throw new Error(data.error ?? `cancel failed (${res.status})`)
  }
}

// --- 判定设置（judge mode + agent 预算）client ---------------------------------

export interface JudgeConfigDto { mode: 'quality' | 'economy'; maxRounds: number; timeBudgetS: number }

/** GET /api/settings/judge — 当前生效判定配置（脏数据已逐字段回默认/夹取）。 */
export async function fetchJudgeConfig(fetchFn: FetchLike = fetch): Promise<JudgeConfigDto> {
  const res = await fetchFn('/api/settings/judge')
  return (await res.json()) as JudgeConfigDto
}

/** PUT /api/settings/judge — 字段级保存；非法输入 server 400 拒绝。返回最新生效值。 */
export async function saveJudgeConfig(patch: Partial<JudgeConfigDto>, fetchFn: FetchLike = fetch): Promise<JudgeConfigDto> {
  const res = await fetchFn('/api/settings/judge', {
    method: 'PUT',
    body: JSON.stringify(patch),
    headers: { 'content-type': 'application/json' },
  })
  const data = (await res.json()) as JudgeConfigDto & { error?: string }
  if (!res.ok) throw new Error(data.error ?? 'save failed')
  return data
}

// --- 运行环境路径配置 client（spec 2026-08-19-runtime-settings-four-slots §3.7）---

export type RuntimeTarget = 'claude' | 'codeagent' | 'opencode' | 'nga'

export interface RuntimeSlotDefaults {
  claude: { dir: string; settingsFilename: string }
  codeagent: { dir: string; settingsFilename: string }
  opencode: { dir: string }
  nga: { dir: string }
}

export interface RuntimeSettingsState extends RuntimeSlotDefaults {
  defaults: RuntimeSlotDefaults
}

/** per-slot 字段级 patch（对齐 server PUT schema 与 src/settings.ts RuntimePathsPatch：
 * 每槽各字段可选，只传要改的槽/字段）。 */
export type RuntimeSlotPatch = {
  claude?: { dir?: string; settingsFilename?: string }
  codeagent?: { dir?: string; settingsFilename?: string }
  opencode?: { dir?: string }
  nga?: { dir?: string }
}

/** GET /api/settings/runtime — 当前生效路径（4 槽）+ 默认值对照。 */
export async function getRuntimeSettings(fetchFn: FetchLike = fetch): Promise<RuntimeSettingsState> {
  const res = await fetchFn('/api/settings/runtime')
  return (await res.json()) as RuntimeSettingsState
}

/** PUT /api/settings/runtime — per-slot 保存（空串=回默认）。返回更新后状态。
 * 非 2xx 抛错（对齐 saveJudgeConfig），让 App.tsx onSave 的 try/catch 显 msg。 */
export async function saveRuntimeSettings(
  patch: RuntimeSlotPatch,
  fetchFn: FetchLike = fetch,
): Promise<RuntimeSettingsState> {
  const res = await fetchFn('/api/settings/runtime', {
    method: 'PUT',
    body: JSON.stringify(patch),
    headers: { 'content-type': 'application/json' },
  })
  const data = (await res.json()) as RuntimeSettingsState & { error?: string }
  if (!res.ok) throw new Error(data.error ?? 'save runtime settings failed')
  return data
}

export interface RuntimeStatus {
  claude: { installed: boolean; path: string }
  codeagent: { installed: boolean; path: string }
  opencode: { installed: boolean; path: string }
  nga: { installed: boolean; path: string }
}

/** GET /api/settings/runtime/status — 4 槽实时安装状态（读磁盘探针）。 */
export async function getRuntimeStatus(fetchFn: FetchLike = fetch): Promise<RuntimeStatus> {
  const res = await fetchFn('/api/settings/runtime/status')
  return (await res.json()) as RuntimeStatus
}

/** POST /api/settings/runtime/install?target=claude|codeagent|opencode|nga — 读已存路径装 hooks/plugin。
 * 默认 claude 保后兼容。失败返回 {ok:false,error}。hooks 型带 settingsPath，plugin 型带 pluginPath。 */
export async function installRuntimeHooks(
  target: RuntimeTarget = 'claude', fetchFn: FetchLike = fetch,
): Promise<{ ok: boolean; settingsPath?: string; pluginPath?: string; error?: string }> {
  const res = await fetchFn(`/api/settings/runtime/install?target=${target}`, { method: 'POST' })
  return (await res.json()) as { ok: boolean; settingsPath?: string; pluginPath?: string; error?: string }
}

/** POST /api/settings/runtime/uninstall?target=claude|codeagent|opencode|nga — 移除 memside-managed 项（保留用户自写）。 */
export async function uninstallRuntimeHooks(
  target: RuntimeTarget = 'claude', fetchFn: FetchLike = fetch,
): Promise<{ ok: boolean; removed?: number; settingsPath?: string; pluginPath?: string; dirRemoved?: boolean; error?: string }> {
  const res = await fetchFn(`/api/settings/runtime/uninstall?target=${target}`, { method: 'POST' })
  return (await res.json()) as { ok: boolean; removed?: number; settingsPath?: string; pluginPath?: string; dirRemoved?: boolean; error?: string }
}

// --- 回收站 + 批量删除 + 导出/导入 client（spec 2026-08-16）----------------

export interface TrashItem {
  id: string
  originalMemoryId: string
  scopeType: string
  scopeId: string | null
  sourceCwd: string | null
  runtime: string | null
  deletedAt: number
  title: string
  valueClass: string | null
  subjectSlug: string | null
}

/** POST /api/memories/bulk-delete — 失败抛错（与 patchMemory 同模式，spec §失败可见）。 */
export async function bulkDelete(
  ids: string[], fetchFn: FetchLike = fetch,
): Promise<{ deleted: number; skipped: number }> {
  const res = await fetchFn('/api/memories/bulk-delete', {
    method: 'POST', body: JSON.stringify({ ids }), headers: { 'content-type': 'application/json' },
  })
  if (!res.ok) throw new Error('bulk-delete failed: ' + res.status)
  return (await res.json()) as { deleted: number; skipped: number }
}

/** POST /api/trash/empty — 失败抛错（与 patchMemory 同模式，spec §失败可见）。 */
export async function emptyTrash(fetchFn: FetchLike = fetch): Promise<{ emptied: number }> {
  const res = await fetchFn('/api/trash/empty', { method: 'POST' })
  if (!res.ok) throw new Error('empty-trash failed: ' + res.status)
  return (await res.json()) as { emptied: number }
}

/** POST /api/trash/:id/restore — no-throw 契约（与 restoreMemory 同模式，404/409 返回 undefined）。 */
export async function restoreFromTrash(
  id: string, fetchFn: FetchLike = fetch,
): Promise<MemoryItem | undefined> {
  const res = await fetchFn(`/api/trash/${id}/restore`, { method: 'POST' })
  if (!res.ok) return undefined
  const data = await res.json() as { memory?: MemoryItem }
  return data.memory
}

/** GET /api/trash — 分页（与 listMemoriesPage 同形状）。 */
export async function listTrashPage(
  fetchFn: FetchLike = fetch,
  opts: { project?: string; category?: string; slug?: string; valueClass?: string } & PageOpts = {},
): Promise<PageDto<TrashItem>> {
  const p = pageParams(opts)
  if (opts.project) p.set('project', opts.project)
  if (opts.category) p.set('category', opts.category)
  if (opts.slug) p.set('slug', opts.slug)
  if (opts.valueClass) p.set('valueClass', opts.valueClass)
  return parsePage<TrashItem>(await fetchFn(`/api/trash?${p}`))
}

/** GET /api/trash/:id — 单条回收站详情（含恢复后的 memory 视图）。 */
export async function getTrash(
  id: string, fetchFn: FetchLike = fetch,
): Promise<TrashItem & { memory: MemoryItem | null } | null> {
  const res = await fetchFn(`/api/trash/${id}`)
  if (!res.ok) return null
  const d = await res.json() as { trash?: TrashItem & { memory: MemoryItem | null } }
  return d.trash ?? null
}

/**
 * POST /api/memories/export — 返回 Blob（JSON/markdown 统一下载触发）。UI 用
 * URL.createObjectURL + <a download> 落盘（spec §Web UI §3）。
 */
export async function exportMemories(
  opts: { scope: 'selected' | 'filter' | 'all'; ids?: string[]; filter?: { sourceCwd?: string; subjectSlug?: string; category?: string; valueClass?: string }; statuses?: string[]; format: 'json' | 'markdown' },
  fetchFn: FetchLike = fetch,
): Promise<Blob> {
  const res = await fetchFn('/api/memories/export', {
    method: 'POST', body: JSON.stringify(opts), headers: { 'content-type': 'application/json' },
  })
  return res.blob()
}

/** POST /api/memories/import?conflict= — multipart 上传单文件。 */
export async function importMemories(
  file: File, conflict: 'skip' | 'overwrite' | 'newid', fetchFn: FetchLike = fetch,
): Promise<{ imported: number; skipped: number; overwritten: number; errors: string[] }> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetchFn(`/api/memories/import?conflict=${conflict}`, { method: 'POST', body: form })
  return (await res.json()) as { imported: number; skipped: number; overwritten: number; errors: string[] }
}
