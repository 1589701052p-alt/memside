import { test, expect } from 'bun:test'
import {
  listMemories, promoteMemory, patchMemory, getSourceInput, listDiscards, restoreMemory, archiveMemory, unarchiveMemory, promoteDiscard,
  listDistillRuns, getDistillRun, getDistillRunSourceInput, getLlmSettings, saveLlmSettings, testLlmConnection, type MemoryItem,
  listMemoriesPage, listDiscardsPage, listDistillRunsPage, bulkRejectUnevaluated, WEB_PAGE_SIZE,
  getFacets, UNEVALUATED,
  listNotificationsPage, markNotificationRead, markAllNotificationsRead, type MemsideStatus, type FetchLike,
  getRuntimeSettings, saveRuntimeSettings, installRuntimeHooks, uninstallRuntimeHooks,
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

// --- 2026-08-11 web-memory-filters: 筛选参数 URL + facets + total ---------

test('listMemoriesPage: 筛选参数只在非空时拼入 URL（空串忽略）', async () => {
  const urls: string[] = []
  const fetchFn = (async (url: string) => {
    urls.push(url)
    return new Response(JSON.stringify({ items: [], hasMore: false, nextCursor: null, total: 0 }), { status: 200 })
  }) as any
  await listMemoriesPage(fetchFn, {
    status: 'candidate', limit: 20, project: 'C:/p/a', slug: '', category: 'trap', valueClass: UNEVALUATED,
  })
  expect(urls[0]).toBe(`/api/memories?status=candidate&limit=20&project=${encodeURIComponent('C:/p/a')}&category=trap&valueClass=unevaluated`)
  await listMemoriesPage(fetchFn, { status: 'rejected', limit: 20 })
  expect(urls[1]).toBe('/api/memories?status=rejected&limit=20')
})

test('listDiscardsPage: project/category 筛选参数拼在游标参数之后', async () => {
  let called = ''
  const fetchFn = (async (url: string) => {
    called = url
    return new Response(JSON.stringify({ items: [], hasMore: false, nextCursor: null, total: 0 }), { status: 200 })
  }) as any
  await listDiscardsPage(fetchFn, { limit: 20, project: 'C:/p/a', category: 'trap' })
  expect(called).toBe(`/api/discards?limit=20&project=${encodeURIComponent('C:/p/a')}&category=trap`)
})

test('getFacets: GET /api/facets?tab= 按 tab 圈定', async () => {
  let called = ''
  const fetchFn = (async (url: string) => {
    called = url
    return new Response(JSON.stringify({
      projects: [{ value: 'C:/x', count: 2 }], categories: [], slugs: [], valueClasses: [],
    }), { status: 200 })
  }) as any
  const f = await getFacets(fetchFn, 'approved')
  expect(called).toBe('/api/facets?tab=approved')
  expect(f.projects[0]).toEqual({ value: 'C:/x', count: 2 })
})

test('getFacets: 非 2xx throw（App catch -> null -> 灰字降级链路）', async () => {
  // 回归锁：getFacets 曾不查 res.ok 直接 res.json()——400 不 throw，App 的
  // .catch(() => null) 不触发，实际降级是「可用但空下拉」而非 spec 承诺的灰字禁用。
  const fetchFn = (async () => new Response(JSON.stringify({ error: 'invalid tab' }), { status: 400 })) as any
  await expect(getFacets(fetchFn, 'candidate')).rejects.toThrow('facets 400')
})

test('listMemoriesPage: before 游标 + 筛选参数共存，筛选排在分页参数之后', async () => {
  let called = ''
  const fetchFn = (async (url: string) => {
    called = url
    return new Response(JSON.stringify({ items: [], hasMore: false, nextCursor: null, total: 0 }), { status: 200 })
  }) as any
  await listMemoriesPage(fetchFn, {
    status: 'candidate', limit: 20, project: 'C:/x', category: 'trap', before: { ts: 9, id: 'z' },
  })
  // 分页参数（limit/before/beforeId）在前，筛选参数（project/category）在其后
  expect(called).toBe(`/api/memories?status=candidate&limit=20&before=9&beforeId=z&project=${encodeURIComponent('C:/x')}&category=trap`)
})

test('PageDto.total: 旧 daemon 无 total -> null（降级不崩）', async () => {
  const fetchFn = (async () =>
    new Response(JSON.stringify({ items: [], hasMore: false, nextCursor: null }), { status: 200 })) as any
  const page = await listMemoriesPage(fetchFn, { status: 'candidate' })
  expect(page.total).toBeNull()
})

// --- Task 8: notifications client (消息中心 + 状态栏新字段) ---
// Locks the notification endpoint wrappers and MemsideStatus new fields.

test('listNotificationsPage 序列化 kind/unread/q/cursor', async () => {
  let url = ''
  const fakeFetch: FetchLike = async (u) => { url = String(u); return new Response(JSON.stringify({ items: [], hasMore: false, nextCursor: null, total: 0 })) }
  await listNotificationsPage(fakeFetch, { kind: 'degradation', unreadOnly: true, q: '摘要', before: { ts: 9, id: 'x' }, limit: 20 })
  expect(url).toContain('/api/notifications?')
  expect(url).toContain('kind=degradation')
  expect(url).toContain('unread=1')
  expect(url).toContain(`q=${encodeURIComponent('摘要')}`)
  expect(url).toContain('before=9')
  expect(url).toContain('beforeId=x')
})

test('markNotificationRead / markAllNotificationsRead 方法与路径', async () => {
  const calls: { url: string; method?: string }[] = []
  const fakeFetch: FetchLike = async (u, init) => { calls.push({ url: String(u), method: init?.method }); return new Response('{}') }
  await markNotificationRead('n1', fakeFetch)
  await markAllNotificationsRead(fakeFetch)
  expect(calls[0]).toEqual({ url: '/api/notifications/n1/read', method: 'POST' })
  expect(calls[1]).toEqual({ url: '/api/notifications/read-all', method: 'POST' })
})

test('MemsideStatus 新字段类型存在（编译期锁定）', () => {
  const s: MemsideStatus = {
    events: 0, jobs: {}, memories: {}, discards: 0, lastError: null,
    llmActivity: { phase: 'distill', detail: null, since: 1 },
    llmStats24h: { distill: { count: 1, ms: 2 }, dedup: { count: 0, ms: 0 }, judge: { count: 0, ms: 0 } },
    unreadNotifications: 3,
  }
  expect(s.unreadNotifications).toBe(3)
})

// --- Task 5 (runtime-path-config): /api/settings/runtime* client ---------------
// Locks the web API contract for the runtime path settings endpoints (Task 3
// server): GET/PUT /api/settings/runtime + POST install/uninstall. Uses the same
// fake-fetch pattern as the other wrapper tests.
// 2026-08-19 spec 四槽：GET/PUT 形状换代为 4 槽 per-slot，下述断言同步更新。

test('getRuntimeSettings returns defaults shape', async () => {
  const fake: FetchLike = async () => new Response(JSON.stringify({
    claude: { dir: '/h/.claude', settingsFilename: 'settings.json' },
    codeagent: { dir: '/h/.cac', settingsFilename: 'setting.json' },
    opencode: { dir: '/h/.config/opencode' },
    nga: { dir: '/h/.config/opencode' },
    defaults: {
      claude: { dir: '/h/.claude', settingsFilename: 'settings.json' },
      codeagent: { dir: '/h/.cac', settingsFilename: 'setting.json' },
      opencode: { dir: '/h/.config/opencode' },
      nga: { dir: '/h/.config/opencode' },
    },
  }), { status: 200 })
  const r = await getRuntimeSettings(fake)
  expect(r.claude.dir).toBe('/h/.claude')
  expect(r.defaults.codeagent.settingsFilename).toBe('setting.json')
})

test('saveRuntimeSettings PUTs patch + returns updated state', async () => {
  let captured: any = null
  const fake: FetchLike = async (url, init) => {
    captured = { url, init }
    return new Response(JSON.stringify({
      claude: { dir: '/h/.cac', settingsFilename: 'setting.json' },
      codeagent: { dir: '/h/.cac', settingsFilename: 'setting.json' },
      opencode: { dir: '/h/.config/opencode' },
      nga: { dir: '/h/.config/opencode' },
      defaults: {
        claude: { dir: '/h/.claude', settingsFilename: 'settings.json' },
        codeagent: { dir: '/h/.cac', settingsFilename: 'setting.json' },
        opencode: { dir: '/h/.config/opencode' },
        nga: { dir: '/h/.config/opencode' },
      },
    }), { status: 200 })
  }
  const r = await saveRuntimeSettings({ claude: { dir: '/h/.cac', settingsFilename: 'setting.json' } }, fake)
  expect(captured.init?.method).toBe('PUT')
  expect(r.claude.dir).toBe('/h/.cac')
  expect(r.claude.settingsFilename).toBe('setting.json')
})

test('installRuntimeHooks POSTs install + returns ok shape', async () => {
  let captured: any = null
  const fake: FetchLike = async (url, init) => {
    captured = { url, init }
    return new Response(JSON.stringify({ ok: true, settingsPath: '/h/.cac/setting.json' }), { status: 200 })
  }
  const r = await installRuntimeHooks('claude', fake)
  expect(captured.init?.method).toBe('POST')
  expect(captured.url).toContain('/api/settings/runtime/install?target=claude')
  expect(r.ok).toBe(true)
  expect(r.settingsPath).toBe('/h/.cac/setting.json')
})

test('uninstallRuntimeHooks POSTs uninstall + returns removed shape', async () => {
  const fake: FetchLike = async () => new Response(JSON.stringify({ ok: true, removed: 5, settingsPath: '/x/setting.json' }), { status: 200 })
  const r = await uninstallRuntimeHooks('claude', fake)
  expect(r.ok).toBe(true)
  expect(r.removed).toBe(5)
})
