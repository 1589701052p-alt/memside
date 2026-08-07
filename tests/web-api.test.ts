import { test, expect } from 'bun:test'
import {
  listMemories, promoteMemory, patchMemory, getSourceInput, listDiscards, restoreMemory, archiveMemory, unarchiveMemory, promoteDiscard,
  listDistillRuns, getDistillRun, getDistillRunSourceInput, getLlmSettings, saveLlmSettings, testLlmConnection, type MemoryItem,
  listMemoriesPage, listDiscardsPage, listDistillRunsPage, bulkRejectUnevaluated, WEB_PAGE_SIZE,
} from '@/web/api'

// Locks the web API client contract (Task 15). The React component itself is
// not unit-tested; this client is the testable seam — a `fetchFn` param lets
// tests inject a mock fetch instead of hitting the network. If the URL shape,
// HTTP method, or request body drifts from what server.ts (Task 13) expects,
// one of these two tests goes red.

test('listMemories calls GET /api/memories and returns items', async () => {
  let called = ''
  const fetchFn = (async (url: string) => {
    called = url
    return new Response(JSON.stringify({ items: [{ id: '1', title: 't', status: 'candidate' }] }), { status: 200 })
  }) as any
  const items = await listMemories(fetchFn)
  expect(called).toBe('/api/memories')
  expect(items.length).toBe(1)
})

test('promoteMemory POSTs to /api/memories/:id/promote', async () => {
  let captured: { url: string; method: string; body: string } | null = null
  const fetchFn = (async (url: string, init: any) => {
    captured = { url, method: init.method, body: init.body }
    return new Response(JSON.stringify({ memory: { id: '1', status: 'approved' } }), { status: 200 })
  }) as any
  await promoteMemory('1', { action: 'approve' }, fetchFn)
  expect(captured!.url).toBe('/api/memories/1/promote')
  expect(captured!.method).toBe('POST')
  expect(captured!.body).toContain('approve')
})

test('patchMemory PATCHes /api/memories/:id with scopeType in body', async () => {
  let captured: { url: string; method: string; body: string } | null = null
  const fetchFn = (async (url: string, init: any) => {
    captured = { url, method: init.method, body: init.body }
    return new Response(JSON.stringify({ memory: { id: '1', status: 'candidate' }, changedFields: ['scopeType'] }), { status: 200 })
  }) as any
  await patchMemory('1', { scopeType: 'global' }, fetchFn)
  expect(captured!.url).toBe('/api/memories/1')
  expect(captured!.method).toBe('PATCH')
  expect(captured!.body).toContain('scopeType')
})

test('patchMemory throws on non-OK response with server error message', async () => {
  const fetchFn = (async () =>
    new Response(JSON.stringify({ error: 'project scope requires a sourceCwd' }), { status: 409 })) as any
  await expect(patchMemory('1', { scopeType: 'project' }, fetchFn)).rejects.toThrow('sourceCwd')
})

test('getSourceInput calls GET /api/memories/:id/source-input', async () => {
  let captured: { url: string; method: string } | null = null
  const fetchFn = (async (url: string, init: any) => {
    captured = { url, method: init?.method ?? 'GET' }
    return new Response(JSON.stringify({ available: true, title: 't', turns: [{ role: 'user', content: 'x' }], turnCount: 1, charCount: 1 }), { status: 200 })
  }) as any
  const data = await getSourceInput('42', fetchFn)
  expect(captured!.url).toBe('/api/memories/42/source-input')
  expect(captured!.method).toBe('GET')
  expect(data.available).toBe(true)
  expect(data.turns!.length).toBe(1)
})

// --- Task 7: memory audit views client (status filter + discards/restore/archive/promote) ---
// Locks the web API client contract for the audit-views endpoints (Task 6
// server). listMemories now takes an optional status query; the five new
// wrappers hit the discard/restore/archive/promote routes. If the URL shape or
// HTTP method drifts from server.ts, one of these goes red.

test('listMemories passes status query when provided', async () => {
  let called = ''
  const fetchFn = (async (url: string) => { called = url; return new Response(JSON.stringify({ items: [] }), { status: 200 }) }) as any
  await listMemories(fetchFn, 'approved,archived')
  // encodeURIComponent encodes the comma -> %2C; Hono decodes it server-side
  // before splitting on ',', so both forms work, but the client emits encoded.
  expect(called).toBe('/api/memories?status=approved%2Carchived')
})

test('listMemories omits status when undefined', async () => {
  let called = ''
  const fetchFn = (async (url: string) => { called = url; return new Response(JSON.stringify({ items: [] }), { status: 200 }) }) as any
  await listMemories(fetchFn)
  expect(called).toBe('/api/memories')
})

test('listDiscards calls GET /api/discards', async () => {
  let called = ''
  const fetchFn = (async (url: string) => { called = url; return new Response(JSON.stringify({ items: [{ id: 'd1', title: 't', reason: 'taming' }] }), { status: 200 }) }) as any
  const items = await listDiscards(fetchFn)
  expect(called).toBe('/api/discards')
  expect(items.length).toBe(1)
})

test('restoreMemory POSTs /api/memories/:id/restore', async () => {
  let captured: { url: string; method: string } | null = null
  const fetchFn = (async (url: string, init: any) => { captured = { url, method: init.method }; return new Response(JSON.stringify({ memory: { id: '1', status: 'candidate' } }), { status: 200 }) }) as any
  await restoreMemory('1', fetchFn)
  expect(captured!.url).toBe('/api/memories/1/restore')
  expect(captured!.method).toBe('POST')
})

test('archiveMemory + unarchiveMemory POST correct paths', async () => {
  const seen: string[] = []
  const fetchFn = (async (url: string, init: any) => { seen.push(`${init.method} ${url}`); return new Response(JSON.stringify({ memory: { id: '1' } }), { status: 200 }) }) as any
  await archiveMemory('1', fetchFn)
  await unarchiveMemory('1', fetchFn)
  expect(seen).toContain('POST /api/memories/1/archive')
  expect(seen).toContain('POST /api/memories/1/unarchive')
})

test('promoteDiscard POSTs /api/discards/:id/promote', async () => {
  let captured: { url: string; method: string } | null = null
  const fetchFn = (async (url: string, init: any) => { captured = { url, method: init.method }; return new Response(JSON.stringify({ memory: { id: 'm1', status: 'candidate' } }), { status: 200 }) }) as any
  await promoteDiscard('d1', fetchFn)
  expect(captured!.url).toBe('/api/discards/d1/promote')
  expect(captured!.method).toBe('POST')
})

// --- Task 6: distill runs client (工作记录透明化) ---

test('listDistillRuns calls GET /api/distill-runs', async () => {
  let called = ''
  const fake = async (url: string) => { called = url; return new Response(JSON.stringify({ items: [{ distillJobId: 'j1', outcome: 'produced' }] }), { status: 200 }) }
  const rows = await listDistillRuns(fake as any)
  expect(called).toBe('/api/distill-runs')
  expect(rows.length).toBe(1)
  expect(rows[0].distillJobId).toBe('j1')
})

test('getDistillRun calls GET /api/distill-runs/:jobId', async () => {
  let called = ''
  const fake = async (url: string) => { called = url; return new Response(JSON.stringify({ distillJobId: 'j1', outcome: 'produced', rawOutput: { candidates: [] } }), { status: 200 }) }
  const r = await getDistillRun('j1', fake as any)
  expect(called).toBe('/api/distill-runs/j1')
  expect(r.distillJobId).toBe('j1')
  expect(r.rawOutput).toBeDefined()
})

test('getDistillRunSourceInput returns null on 404', async () => {
  let called = ''
  const fake = async (url: string) => { called = url; return new Response('not found', { status: 404 }) }
  const r = await getDistillRunSourceInput('j1', fake as any)
  expect(called).toBe('/api/distill-runs/j1/source-input')
  expect(r).toBeNull()
})

// --- Task 5: distill-error-capture -- errorMessage 类型 ---
// 锁回归：getDistillRun 返回的 detail 含 errorMessage 字段。
test('getDistillRun returns errorMessage in detail', async () => {
  let called = ''
  const fake = (url: string) => {
    called = url
    return Promise.resolve({ ok: true, json: async () => ({
      distillJobId: 'j1', outcome: 'llm_error', errorMessage: '500 boom',
      rawCount: 0, acceptedCount: 0, dedupedCount: 0, filteredCount: 0,
      storedCount: 0, discardedCount: 0, durationMs: 1, ts: 1,
      cwd: null, runtime: 'claude-code', createdAt: 1, sourceAgentId: null, rawOutput: null,
    }) } as any)
  }
  const r = await getDistillRun('j1', fake as any)
  expect(called).toBe('/api/distill-runs/j1')
  expect(r.errorMessage).toBe('500 boom')
})

// --- Task 6: LLM 设置 UI 配置 client ---
// Locks the web API client contract for the LLM settings endpoints (Task 5 server).
// get/save/test wrap GET/PUT/POST /api/settings/llm; saveLlmSettings uses field-level
// merge and clear:true deletes the saved level. testLlmConnection validates credentials
// without persisting them.

test('getLlmSettings 解析 saved/effective', async () => {
  let captured: { url: string; method: string } | null = null
  const fetchFn = (async (url: string, init: any) => {
    captured = { url, method: init?.method ?? 'GET' }
    return new Response(JSON.stringify({
      saved: { baseURL: 'https://a', model: 'm', tokenMasked: 'sk-kim…5678fh' },
      effective: { source: 'ui', baseURL: 'https://a', model: 'm', tokenMasked: 'sk-kim…5678fh' },
    }))
  }) as any
  const state = await getLlmSettings(fetchFn)
  expect(captured!.url).toBe('/api/settings/llm')
  expect(captured!.method).toBe('GET')
  expect(state.effective?.source).toBe('ui')
})

test('saveLlmSettings PUT 序列化 body（含 clear）并返回最新状态', async () => {
  const returned = {
    saved: null,
    effective: { source: 'settings.json', baseURL: 'https://b', model: 'm2', tokenMasked: 'sk-sets…json' },
  } as const
  let captured: { url: string; method: string; body: any } | null = null
  const result = await saveLlmSettings({ clear: true }, (async (_url: string, init: { method?: string; body?: BodyInit }) => {
    captured = { url: _url, method: init.method!, body: JSON.parse(String(init.body)) }
    return new Response(JSON.stringify(returned))
  }) as any)
  expect(captured!.url).toBe('/api/settings/llm')
  expect(captured!.method).toBe('PUT')
  expect(captured!.body).toEqual({ clear: true })
  expect(result).toEqual(returned)
})

test('testLlmConnection POST 到 /api/settings/llm/test 并透传 {ok,error}', async () => {
  let captured: { url: string; method: string; body: string } | null = null
  const fetchFn = (async (url: string, init: any) => {
    captured = { url, method: init.method, body: init.body }
    return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }))
  }) as any
  const r = await testLlmConnection({ baseURL: 'https://a', token: 'sk-test', model: 'm' }, fetchFn)
  expect(captured!.url).toBe('/api/settings/llm/test')
  expect(captured!.method).toBe('POST')
  expect(JSON.parse(captured!.body)).toEqual({ baseURL: 'https://a', token: 'sk-test', model: 'm' })
  expect(r.ok).toBe(false)
  expect(r.error).toBe('unauthorized')
})

// --- Task 5: origin/evidence 类型 + 透传（origin-driven value judgment）---
// 锁回归：MemoryItem 类型必须声明 origin/evidence（spec §R1），且 listMemories
// 把后端返回的对应字段原样穿出（不做字段筛选）。访问 items[0].origin/.evidence
// 在 TS 层即要求 MemoryItem 声明这两个字段--若类型漏声明，typecheck 直接红；
// 运行时断言锁定 listMemories 不丢字段。双向锁：类型 + 运行时。

// 类型层锁：MemoryItem 必须含可选 origin/evidence（与 valueClass 同 optionality）。
// 这两句在编译期求值；若 MemoryItem 漏掉任一字段，tsc 报 TS2339，typecheck 红。
const _task5TypeLockItem: MemoryItem = { id: '1', title: 't', status: 'candidate' }
const _task5OriginType: string | null | undefined = _task5TypeLockItem.origin
const _task5EvidenceType: string | null | undefined = _task5TypeLockItem.evidence
void _task5OriginType
void _task5EvidenceType

test('listMemories 透传 origin/evidence 字段', async () => {
  const fixture = {
    items: [{
      id: '1', title: 't', status: 'candidate',
      origin: 'user-stated', evidence: '用户原话摘抄',
    }],
  }
  const fetchFn = (async (_url: string) =>
    new Response(JSON.stringify(fixture), { status: 200 })) as any
  const items = await listMemories(fetchFn, 'candidate')
  // items: MemoryItem[] -- 访问 .origin/.evidence 要求类型声明这两个字段
  expect(items[0]!.origin).toBe('user-stated')
  expect(items[0]!.evidence).toBe('用户原话摘抄')
})

// --- Task 5: tab list pagination client (infinite scroll) ---
// Locks the paginated list wrappers: listMemoriesPage / listDiscardsPage /
// listDistillRunsPage build correct cursor URLs, parse PageDto, and degrade
// gracefully when an old daemon returns the legacy { items } shape.

test('listMemoriesPage: URL 拼 status/limit/游标，解析分页形状', async () => {
  let called = ''
  const fetchFn = (async (url: string) => {
    called = url
    return new Response(JSON.stringify({ items: [{ id: '1' }], hasMore: true, nextCursor: { ts: 123, id: 'abc' } }), { status: 200 })
  }) as any
  const page = await listMemoriesPage(fetchFn, { status: 'candidate', limit: 50, before: { ts: 456, id: 'x/y' } })
  expect(called).toBe('/api/memories?status=candidate&limit=50&before=456&beforeId=x%2Fy')
  expect(page.hasMore).toBe(true)
  expect(page.nextCursor).toEqual({ ts: 123, id: 'abc' })
})

test('listMemoriesPage: 旧 daemon 无 hasMore -> false（兼容降级）', async () => {
  const fetchFn = (async () => new Response(JSON.stringify({ items: [{ id: '1' }] }), { status: 200 })) as any
  const page = await listMemoriesPage(fetchFn, { status: 'candidate' })
  expect(page.hasMore).toBe(false)
  expect(page.nextCursor).toBeNull()
})

test('listDiscardsPage / listDistillRunsPage: URL 与形状', async () => {
  const urls: string[] = []
  const fetchFn = (async (url: string) => {
    urls.push(url)
    return new Response(JSON.stringify({ items: [], hasMore: false, nextCursor: null }), { status: 200 })
  }) as any
  await listDiscardsPage(fetchFn, { limit: 50, before: { ts: 1, id: 'a' } })
  expect(urls[0]).toBe('/api/discards?limit=50&before=1&beforeId=a')
  await listDistillRunsPage(fetchFn, { limit: 50 })
  expect(urls[1]).toBe('/api/distill-runs?limit=50')
})

// 页大小契约（2026-08-07 用户拍板）：一页 20 条，不显式传 limit 时 URL 用默认值。
test('WEB_PAGE_SIZE = 20，缺省 limit 走默认值', async () => {
  expect(WEB_PAGE_SIZE).toBe(20)
  let called = ''
  const fetchFn = (async (url: string) => {
    called = url
    return new Response(JSON.stringify({ items: [], hasMore: false, nextCursor: null }), { status: 200 })
  }) as any
  await listDiscardsPage(fetchFn)
  expect(called).toBe('/api/discards?limit=20')
})

test('bulkRejectUnevaluated: POST 到按条件批量端点', async () => {
  let captured: { url: string; method: string } | null = null
  const fetchFn = (async (url: string, init: any) => {
    captured = { url, method: init.method }
    return new Response(JSON.stringify({ rejected: 3 }), { status: 200 })
  }) as any
  const r = await bulkRejectUnevaluated(fetchFn)
  expect(captured!.url).toBe('/api/memories/bulk-reject-unevaluated')
  expect(captured!.method).toBe('POST')
  expect(r.rejected).toBe(3)
})
