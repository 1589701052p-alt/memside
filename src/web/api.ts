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
  /** 降级可见化（spec §4.9）：24h 降级计数 + 最新一条 + ack 时间；老 daemon 无此字段。 */
  recentDegradations?: {
    count24h: number
    latest: { kind: string; detail: string | null; ts: number } | null
    acknowledgedTs: number | null
  }
  /** 累加中的 waiting job 数（spec §4.9：单列避免「pending 堆积」假象）；老 daemon 无此字段。 */
  waitingJobs?: number
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

export type DistillOutcome = 'skipped_no_new_turns' | 'empty_output' | 'llm_error' | 'produced' | 'skipped_trivial'

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
}

export interface DistillRunDetail extends DistillRunListItem {
  rawOutput: unknown | null
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

// --- 降级可见化（spec §4.9）client --------------------------------------------

/** POST /api/degradations/ack — 用户点「知道了」，ack ts = now 落 appSettings。 */
export async function ackDegradations(fetchFn: FetchLike = fetch): Promise<void> {
  await fetchFn('/api/degradations/ack', { method: 'POST' })
}

/** GET /api/distill-runs/:jobId/degradations — 该 job 的降级明细（modal 懒加载）。 */
export async function getRunDegradations(
  jobId: string, fetchFn: FetchLike = fetch,
): Promise<{ degradations: { id: string; ts: number; kind: string; detail: string | null }[] }> {
  const res = await fetchFn(`/api/distill-runs/${encodeURIComponent(jobId)}/degradations`)
  return (await res.json()) as { degradations: { id: string; ts: number; kind: string; detail: string | null }[] }
}

// --- 五 tab 无限滚动分页 client（spec 2026-08-07）--------------------------
// 统一分页形状；旧 daemon 不认识 limit 时返回 { items } 旧形状，hasMore/nextCursor
// 缺省降级 false/null（一页装全部，不崩）。

export interface PageDto<T> { items: T[]; hasMore: boolean; nextCursor: { ts: number; id: string } | null }

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
  }
}

export async function listMemoriesPage(
  fetchFn: FetchLike = fetch,
  opts: { status: string } & PageOpts = { status: '' },
): Promise<PageDto<MemoryItem>> {
  const p = pageParams(opts)
  p.set('status', opts.status)
  // status 放最前，与测试锁定的 URL 顺序一致
  const qs = new URLSearchParams()
  qs.set('status', opts.status)
  for (const [k, v] of p) qs.set(k, v)
  return parsePage<MemoryItem>(await fetchFn(`/api/memories?${qs}`))
}

export async function listDiscardsPage(
  fetchFn: FetchLike = fetch, opts: PageOpts = {},
): Promise<PageDto<DiscardItem>> {
  return parsePage<DiscardItem>(await fetchFn(`/api/discards?${pageParams(opts)}`))
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
