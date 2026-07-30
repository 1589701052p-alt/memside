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

export interface MemsideStatus {
  events: number
  jobs: Record<string, number>
  memories: Record<string, number>
  discards: number
  distillRuns?: { total: number; byOutcome: Record<string, number> }
  lastError: { error: string } | null
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

export type DistillOutcome = 'skipped_no_new_turns' | 'empty_output' | 'llm_error' | 'produced'

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

// --- LLM 设置（凭证 UI 配置）client -------------------------------------------

export interface LlmSettingsState {
  saved: { baseURL: string | null; model: string | null; tokenMasked: string } | null
  effective: { source: string; baseURL: string | null; model: string | null; tokenMasked: string } | null
}

/** GET /api/settings/llm — saved = UI 配置（打码）；effective = 当前凭证链生效级。 */
export async function getLlmSettings(fetchFn: FetchLike = fetch): Promise<LlmSettingsState> {
  const res = await fetchFn('/api/settings/llm')
  return (await res.json()) as LlmSettingsState
}

/** PUT /api/settings/llm — 字段级合并；clear:true 删除整级。返回最新状态。 */
export async function saveLlmSettings(
  body: { baseURL?: string; token?: string; model?: string; clear?: boolean },
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
  body: { baseURL?: string; token?: string; model?: string },
  fetchFn: FetchLike = fetch,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetchFn('/api/settings/llm/test', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
  return (await res.json()) as { ok: boolean; error?: string }
}
