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
  createdAt?: number
  version?: number
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export async function listMemories(fetchFn: FetchLike = fetch): Promise<MemoryItem[]> {
  const res = await fetchFn('/api/memories')
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
  body: { title?: string; bodyMd?: string; tags?: string[]; scopeType?: 'project' | 'global'; scopeId?: string | null },
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
