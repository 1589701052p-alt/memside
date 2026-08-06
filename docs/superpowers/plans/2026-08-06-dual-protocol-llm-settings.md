# 双协议 LLM 设置（Web UI 支持 Anthropic 与 OpenAI）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Web UI 的 LLM 设置面板同时支持 Anthropic 与 OpenAI 两种协议——distill 调用与「测试连接」都按用户选择的协议工作。

**Architecture:** 给 `UiLlmConfig` 加 `protocol` 字段（单配置 + 协议开关，UI 协议优先）。distill 每次调用现读 UI 配置 → 纯函数 `resolveCallLLMProtocol` 定协议 → 派发到 anthropic / openai 后端（都注入 UI 配置），切协议即时生效无需重启。openai 后端补 `loadUiConfig` 注入与 `testConnection`，server 的 test 端点按协议派发。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite + zod；前端 Vite + React 19。测试用 `bun test`。

## Global Constraints

- 测试一律 `bun test`，严禁 `npm test`（CLAUDE.md）。
- 分支 + PR，严禁直推 master；基线从 `origin/master` 切。
- `bun run typecheck && bun test` 必须全绿才能 push。
- 任何 API 路径不得回明文 token（`maskToken` 硬约束）。
- UI 配置读异常降级 `saved:null` / `effective:null`，不 500（现有 spec 约束保持）。
- 既有缺 `llm.protocol` 的配置默认 `'anthropic'`（向后兼容）。
- 免 brainstorming 的例外不适用本改动（触及生产代码，必须带测试）。

---

### Task 1: settings.ts — `UiLlmConfig` 加 `protocol` 字段

**Files:**
- Modify: `src/settings.ts`
- Test: `tests/settings.test.ts`

**Interfaces:**
- Produces: `UiLlmConfig` 现在含可选 `protocol?: 'anthropic' | 'openai'`；`saveUiLlmConfig` 的 `patch` 类型加 `protocol?: 'anthropic' | 'openai'`；`KEYS` 加 `protocol: 'llm.protocol'`。
- Consumes: 无（纯存储层）。

- [ ] **Step 1: 写失败测试**（追加到 `tests/settings.test.ts`）

```ts
test('save+load: protocol 随配置读写', () => {
  const db = tmpDb()
  saveUiLlmConfig(db, { token: 'sk-abcdefghijklmn', protocol: 'openai' })
  expect(loadUiLlmConfig(db)).toEqual({ token: 'sk-abcdefghijklmn', protocol: 'openai' })
})

test('protocol 缺省不写入 -> load 无 protocol 字段', () => {
  const db = tmpDb()
  saveUiLlmConfig(db, { token: 'sk-abcdefghijklmn' })
  expect(loadUiLlmConfig(db)).toEqual({ token: 'sk-abcdefghijklmn' })
})

test('clear:true 连带删除 protocol', () => {
  const db = tmpDb()
  saveUiLlmConfig(db, { token: 'sk-abcdefghijklmn', protocol: 'openai' })
  saveUiLlmConfig(db, { clear: true })
  expect(loadUiLlmConfig(db)).toBeNull()
})
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/settings.test.ts`
Expected: 3 个新用例 FAIL（`protocol` 未定义）。

- [ ] **Step 3: 实现**（`src/settings.ts`）

`UiLlmConfig` 接口加 `protocol?: 'anthropic' | 'openai'`；`KEYS` 加 `protocol: 'llm.protocol'`：

```ts
const KEYS = { baseURL: 'llm.base_url', token: 'llm.auth_token', model: 'llm.model', protocol: 'llm.protocol' } as const
```

`loadUiLlmConfig` 在找到 token 后读 protocol：

```ts
const out: UiLlmConfig = { token }
const protocol = map.get(KEYS.protocol)
if (protocol === 'openai' || protocol === 'anthropic') out.protocol = protocol
const baseURL = map.get(KEYS.baseURL)
const model = map.get(KEYS.model)
if (baseURL) out.baseURL = baseURL
if (model) out.model = model
return out
```

`saveUiLlmConfig` 的 `patch` 类型加 `protocol?: 'anthropic' | 'openai'`，并在合并段加：

```ts
if (patch.protocol) upsert(KEYS.protocol, patch.protocol)
```

`clear:true` 分支已遍历 `Object.values(KEYS)`，自动连带删 protocol，无需改。

- [ ] **Step 4: 运行确认通过**

Run: `bun test tests/settings.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/settings.ts tests/settings.test.ts
git commit -m "feat(settings): UiLlmConfig 加 protocol 字段（llm.protocol）"
```

---

### Task 2: openai.ts — `loadOpenAiUiCreds` + `loadUiConfig` 注入 + `testConnection`

**Files:**
- Modify: `src/openai.ts`
- Test: `tests/openai.test.ts`

**Interfaces:**
- Consumes: `UiLlmConfig`（`src/settings.ts`）。
- Produces:
  - `loadOpenAiUiCreds(ui: UiLlmConfig | null, env: Record<string, string | undefined>): OpenAiCreds | null` — UI token 存在用 UI creds（model/baseURL 缺省回 env，model 与 env 都缺则抛错）；否则回退 `loadOpenAiCreds()`（env）。
  - `OpenAiDeps` 加 `loadUiConfig?: () => UiLlmConfig | null`。
  - `testConnection(cfg: { baseURL?: string; token: string; model?: string }, opts?: { timeoutMs?: number }): Promise<{ ok: boolean; error?: string }>` — 发 `POST {baseURL}/chat/completions` 最小请求。

- [ ] **Step 1: 写失败测试**（追加到 `tests/openai.test.ts`，顶部 import 加 `loadOpenAiUiCreds, testConnection`）

```ts
// ---- loadOpenAiUiCreds：UI 级凭证合并（spec §接口契约）----

test('loadOpenAiUiCreds: UI token 存在用 UI creds（去尾斜杠）', () => {
  const c = loadOpenAiUiCreds({ token: 'sk-ui', baseURL: 'https://ui.example.com/v1/', model: 'ui-model' }, {})
  expect(c).toEqual({ apiKey: 'sk-ui', baseURL: 'https://ui.example.com/v1', model: 'ui-model' })
})

test('loadOpenAiUiCreds: UI model/baseURL 缺省回退 env', () => {
  const c = loadOpenAiUiCreds({ token: 'sk-ui' }, { OPENAI_MODEL: 'env-model', OPENAI_BASE_URL: 'https://env.example.com/v1/' })
  expect(c).toEqual({ apiKey: 'sk-ui', baseURL: 'https://env.example.com/v1', model: 'env-model' })
})

test('loadOpenAiUiCreds: UI model 与 env 都缺 -> 抛错', () => {
  expect(() => loadOpenAiUiCreds({ token: 'sk-ui' }, {})).toThrow(/OpenAI model missing/)
})

test('loadOpenAiUiCreds: UI 为 null -> 回退 env', () => {
  process.env.OPENAI_API_KEY = 'k'
  process.env.OPENAI_MODEL = 'm'
  expect(loadOpenAiUiCreds(null, {})).toEqual({ apiKey: 'k', baseURL: 'https://api.openai.com/v1', model: 'm' })
})

test('makeLLMCall 注入 loadUiConfig 时用 UI creds', async () => {
  fetchImpl = async () => okResp({ choices: [{ message: { content: 'hi' } }] })
  const call = makeLLMCall({
    loadUiConfig: () => ({ token: 'sk-ui', baseURL: 'https://ui.example.com/v1', model: 'ui-model' }),
  })
  await call('s', 'u')
  expect(fetchCalls[0]!.url).toBe('https://ui.example.com/v1/chat/completions')
  const headers = new Headers(fetchCalls[0]!.init.headers as HeadersInit)
  expect(headers.get('authorization')).toBe('Bearer sk-ui')
})

// ---- testConnection：OpenAI 最小请求（spec §测试连接）----

test('testConnection posts {baseURL}/chat/completions 最小请求', async () => {
  fetchImpl = async () => okResp({ choices: [{ message: { content: 'hi' } }] })
  const r = await testConnection({ baseURL: 'https://ui.example.com/v1/', token: 'sk', model: 'm' })
  expect(r.ok).toBe(true)
  expect(fetchCalls[0]!.url).toBe('https://ui.example.com/v1/chat/completions')
  const body = JSON.parse(fetchCalls[0]!.init.body as string)
  expect(body.max_tokens).toBe(1)
  expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
  expect(body.model).toBe('m')
})

test('testConnection 非 2xx -> {ok:false, error 含状态码}', async () => {
  fetchImpl = async () => new Response('{"error":"bad key"}', { status: 401 })
  const r = await testConnection({ token: 'sk', model: 'm' })
  expect(r.ok).toBe(false)
  expect(r.error).toMatch(/OpenAI HTTP 401/)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/openai.test.ts`
Expected: 新用例 FAIL（函数未定义）。

- [ ] **Step 3: 实现**（`src/openai.ts`）

顶部加 `import type { UiLlmConfig } from './settings'`。`OpenAiDeps` 加 `loadUiConfig?: () => UiLlmConfig | null`。

新增纯函数（放在 `loadOpenAiCreds` 之后）：

```ts
export function loadOpenAiUiCreds(
  ui: UiLlmConfig | null,
  env: Record<string, string | undefined> = process.env,
): OpenAiCreds | null {
  if (ui?.token) {
    const model = ui.model ?? env.OPENAI_MODEL
    if (!model) throw new Error('OpenAI model missing; set model in UI settings or OPENAI_MODEL')
    const baseURL = (ui.baseURL ?? env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '')
    return { apiKey: ui.token, baseURL, model }
  }
  return loadOpenAiCreds()
}
```

`makeLLMCall` 改为：`loadUiConfig` 存在时走 `loadOpenAiUiCreds(loadUi(), process.env)`，否则走注入/默认 loader：

```ts
export function makeLLMCall(deps: OpenAiDeps = {}): LLMCall {
  const load = deps.loadOpenAiCreds ?? loadOpenAiCreds
  const loadUi = deps.loadUiConfig
  const timeoutMs = deps.timeoutMs ?? 120_000
  return async function callLLM(system: string, user: string, opts?: LLMCallOpts): Promise<string> {
    const c = loadUi ? loadOpenAiUiCreds(loadUi(), process.env) : load()
    if (!c) throw new Error('no OpenAI credentials; set OPENAI_API_KEY + OPENAI_BASE_URL + OPENAI_MODEL')
    // ... 其余（AbortController + fetch {baseURL}/chat/completions + 抽取 choices[0].message.content）不变
  }
}
```

文件末尾新增 `testConnection`：

```ts
export async function testConnection(
  cfg: { baseURL?: string; token: string; model?: string },
  opts?: { timeoutMs?: number },
): Promise<{ ok: boolean; error?: string }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 15_000)
  try {
    const baseURL = (cfg.baseURL ?? 'https://api.openai.com/v1').replace(/\/$/, '')
    const resp = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({ model: cfg.model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal: ctrl.signal,
    })
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      return { ok: false, error: `OpenAI HTTP ${resp.status}: ${body.slice(0, 200)}` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timer)
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test tests/openai.test.ts`
Expected: PASS（含既有用例不回归）。

- [ ] **Step 5: Commit**

```bash
git add src/openai.ts tests/openai.test.ts
git commit -m "feat(openai): loadUiConfig 注入 + loadOpenAiUiCreds + testConnection"
```

---

### Task 3: llm.ts — 纯函数 `resolveCallLLMProtocol`

**Files:**
- Modify: `src/llm.ts`
- Test: `tests/llm.test.ts`

**Interfaces:**
- Produces: `export type LLMProtocol = LLMBackend`；`export function resolveCallLLMProtocol(uiConfig: { token?: string; protocol?: LLMProtocol } | null, env: Record<string, string | undefined>): LLMProtocol`。
- Consumes: 无（vendor-neutral，不 import settings）。

- [ ] **Step 1: 写失败测试**（追加到 `tests/llm.test.ts`，import `resolveCallLLMProtocol`）

```ts
// resolveCallLLMProtocol 锁「UI 协议优先、UI 未激活回退 env」选择规则（spec §决策 2）：
//   - ui.token 存在 -> 返回 ui.protocol ?? 'anthropic'（UI 优先，压过 env）
//   - ui.token 缺失 -> 回退 resolveLLMBackend(env)（现状）
test('resolveCallLLMProtocol: UI token + protocol=openai -> openai（压过 env anthropic）', () => {
  expect(resolveCallLLMProtocol({ token: 'x', protocol: 'openai' }, { MEMSIDE_LLM_BACKEND: 'anthropic' })).toBe('openai')
})

test('resolveCallLLMProtocol: UI token 有但 protocol 缺省 -> anthropic', () => {
  expect(resolveCallLLMProtocol({ token: 'x' }, { MEMSIDE_LLM_BACKEND: 'openai' })).toBe('anthropic')
})

test('resolveCallLLMProtocol: UI 无 token -> 回退 env 探测', () => {
  expect(resolveCallLLMProtocol(null, { OPENAI_API_KEY: 'x' })).toBe('openai')
  expect(resolveCallLLMProtocol({}, { OPENAI_API_KEY: 'x' })).toBe('openai')
  expect(resolveCallLLMProtocol(null, {})).toBe('anthropic')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/llm.test.ts`
Expected: 新用例 FAIL（函数未定义）。

- [ ] **Step 3: 实现**（`src/llm.ts`）

在 `resolveLLMBackend` 之后加：

```ts
export type LLMProtocol = LLMBackend

/**
 * 每次调用动态解析协议（spec §决策 3，即时生效）：
 * - UI 配置有 token 时，UI 存的 protocol 优先（缺省 anthropic），压过 env。
 * - UI 无 token（UI 级未激活）时回退 resolveLLMBackend(env)（现状）。
 * 纯函数、SDK-free、不 import settings（结构参数保持解耦）。
 */
export function resolveCallLLMProtocol(
  uiConfig: { token?: string; protocol?: LLMProtocol } | null,
  env: Record<string, string | undefined>,
): LLMProtocol {
  if (uiConfig?.token) return uiConfig.protocol ?? 'anthropic'
  return resolveLLMBackend(env)
}
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test tests/llm.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/llm.ts tests/llm.test.ts
git commit -m "feat(llm): resolveCallLLMProtocol 纯函数（UI 协议优先，env 回退）"
```

---

### Task 4: daemon.ts — `resolveCallLLM` 动态协议派发

**Files:**
- Modify: `src/daemon.ts`
- Test: `tests/daemon.test.ts`

**Interfaces:**
- Consumes: `resolveCallLLMProtocol`（Task 3）、`makeOpenAiCall` 的 `loadUiConfig`（Task 2）、`loadUiLlmConfig`（现有）。
- Produces: `resolveCallLLM(deps, db)` 返回的 `LLMCall` 每次调用现读 UI 配置定协议，派发到 anthropic / openai 后端并注入 `loadUiConfig`（UI 协议即时生效）。

- [ ] **Step 1: 写失败测试**（追加到 `tests/daemon.test.ts`）

```ts
// spec §动态协议派发器：UI protocol=openai 必须驱动 openai 后端（/chat/completions），
// 且 UI 协议压过 env 的 MEMSIDE_LLM_BACKEND=anthropic。mock fetch 不发真实网络。
test('resolveCallLLM: UI protocol=openai 驱动 openai 后端，压过 env', async () => {
  const prevBackend = process.env.MEMSIDE_LLM_BACKEND
  const prevKey = process.env.OPENAI_API_KEY
  const origFetch = globalThis.fetch
  process.env.MEMSIDE_LLM_BACKEND = 'anthropic' // 证明 UI 协议压过 env
  delete process.env.OPENAI_API_KEY
  const urls: string[] = []
  try {
    saveUiLlmConfig(db, {
      token: 'sk-openai-ui',
      protocol: 'openai',
      baseURL: 'https://ark.cn-beijing.volces.com/api/plan/v3',
      model: 'ark-code-latest',
    })
    const { jobId } = await enqueueDistillJob(db, {
      sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k', debounceMs: 0,
    })
    await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
    await db.insert(memoryDistillEvents).values({
      distillJobId: jobId, attemptIndex: 0, ts: 1, kind: 'conversation',
      payload: JSON.stringify([{ role: 'user', content: 'refund 14 days' }]),
    })
    globalThis.fetch = (async (input: unknown, _init?: RequestInit) => {
      urls.push(String(input))
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates: [] }) } }] }), { status: 200 })
    }) as typeof fetch
    await runDistillOnce(db, {})
    expect(urls.length).toBeGreaterThan(0)
    expect(urls[0]).toBe('https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions')
    expect(urls.every((u) => u.endsWith('/chat/completions'))).toBe(true)
  } finally {
    globalThis.fetch = origFetch
    if (prevBackend === undefined) delete process.env.MEMSIDE_LLM_BACKEND
    else process.env.MEMSIDE_LLM_BACKEND = prevBackend
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevKey
  }
})
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/daemon.test.ts`
Expected: 新用例 FAIL（当前 `resolveCallLLM` 按 env 选 backend，UI protocol 不驱动 openai）。

- [ ] **Step 3: 实现**（`src/daemon.ts`）

import 行调整：`import { resolveLLMBackend, resolveCallLLMProtocol, type LLMCall, type LLMCallOpts } from '@/llm'`（`resolution` 改为 `resolveCallLLMProtocol`）；`import { loadUiLlmConfig, type UiLlmConfig } from './settings'`。

把 `resolveCallLLM` 改为动态派发（替换现有 76-83 行）：

```ts
function resolveCallLLM(deps: ResolveCallLLMDeps = {}, db?: DbClient): LLMCall {
  return async function callLLM(system: string, user: string, opts?: LLMCallOpts): Promise<string> {
    // 每次调用现读 UI 配置；DB 读异常降级为无 UI 级（不炸 distill）
    let ui: UiLlmConfig | null = null
    if (db) { try { ui = loadUiLlmConfig(db) } catch { ui = null } }
    const proto = resolveCallLLMProtocol(ui, process.env)
    if (proto === 'openai') {
      const call = makeOpenAiCall({
        ...(deps.loadOpenAiCreds ? { loadOpenAiCreds: deps.loadOpenAiCreds } : {}),
        ...(db ? { loadUiConfig: () => ui } : {}),
      })
      return await call(system, user, opts)
    }
    const call = makeAnthropicCall({
      ...(deps.loadClaudeCreds ? { loadClaudeCreds: deps.loadClaudeCreds } : {}),
      ...(db ? { loadUiConfig: () => ui } : {}),
    })
    return await call(system, user, opts)
  }
}
```

更新 `resolveCallLLM` 上方 doc 注释（删除「openai 后端路径不接 UI 配置」的已知限制表述，改为动态派发说明）。

- [ ] **Step 4: 运行确认通过（含回归）**

Run: `bun test tests/daemon.test.ts`
Expected: 新用例 + 既有 openai 相关用例 PASS。特别注意既有 `runDistillOnce 的 anthropic 链带 db-backed loadUiConfig` 用例（UI protocol 缺省为 anthropic，仍走 anthropic 分支，captured 仍 `{ token }`）不回归。

- [ ] **Step 5: Commit**

```bash
git add src/daemon.ts tests/daemon.test.ts
git commit -m "feat(daemon): resolveCallLLM 动态协议派发（UI 协议即时生效）"
```

---

### Task 5: server.ts — 协议入 schema、回显、测试连接派发

**Files:**
- Modify: `src/server.ts`
- Test: `tests/settings-api.test.ts`

**Interfaces:**
- Consumes: `resolveCallLLMProtocol`（Task 3）、openai `testConnection`（Task 2）、anthropic `testConnection`（现有）。
- Produces:
  - `GET/PUT /api/settings/llm` 的 `saved` / `effective` 各加 `protocol: 'anthropic' | 'openai'`。
  - `PUT /api/settings/llm` 接受 `protocol`；`POST /api/settings/llm/test` 接受 `protocol` 并按协议派发。
  - 注入 dep `testConnection` 签名改为 `(cfg: { protocol: LLMProtocol; baseURL?: string; token: string; model?: string }) => Promise<{ ok: boolean; error?: string }>`。

- [ ] **Step 1: 先改既有测试的 mock 形状，再写新测试**

`tests/settings-api.test.ts` 的 `SavePatch` 类型加 `protocol?: 'anthropic' | 'openai'`；所有 `testConnection: async (cfg) => { calls.push(cfg); ... }` 的断言 `calls[0]).toEqual({...})` 补 `protocol: 'anthropic'`（默认）。`makeFakeUiStore` 的 `saveUiConfig` 合并逻辑加 protocol（与 Task 1 语义一致）。

追加新测试：

```ts
// spec §测试连接按协议派发：PUT 存 protocol，空 body test 用已存 protocol 派发到 openai。
test('PUT protocol=openai 保存；空 body test 派发到注入 testConnection 且带 protocol', async () => {
  const ui = makeFakeUiStore(null)
  const calls: { protocol: string; baseURL?: string; token: string; model?: string }[] = []
  const app = makeApp({
    ...ui,
    loadEffectiveCreds: () => ({ apiKey: null, source: 'none' }),
    testConnection: async (cfg) => { calls.push(cfg); return { ok: true } },
  })
  const put = await req(app, '/api/settings/llm', putJson({
    baseURL: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    token: 'sk-abcdefghijklmn',
    model: 'ark-code-latest',
    protocol: 'openai',
  }))
  expect(put.status).toBe(200)
  expect(put.body.saved).toMatchObject({ protocol: 'openai', tokenMasked: 'sk-abc…klmn' })

  const t = await req(app, '/api/settings/llm/test', postJson({}))
  expect(t.status).toBe(200)
  expect(calls[0]).toEqual({
    protocol: 'openai',
    baseURL: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    token: 'sk-abcdefghijklmn',
    model: 'ark-code-latest',
  })
})

test('PUT protocol 缺省 -> saved.protocol 默认 anthropic', async () => {
  const ui = makeFakeUiStore(null)
  const app = makeApp({
    ...ui,
    loadEffectiveCreds: () => ({ apiKey: null, source: 'none' }),
    testConnection: async () => ({ ok: true }),
  })
  const put = await req(app, '/api/settings/llm', putJson({ baseURL: 'https://a.example.com', token: 'sk-abcdefghijklmn' }))
  expect(put.status).toBe(200)
  expect(put.body.saved.protocol).toBe('anthropic')
})

test('PUT 非法 protocol -> 400', async () => {
  const ui = makeFakeUiStore(null)
  const app = makeApp({
    ...ui,
    loadEffectiveCreds: () => ({ apiKey: null, source: 'none' }),
    testConnection: async () => ({ ok: true }),
  })
  const r = await req(app, '/api/settings/llm', putJson({ token: 'sk-x', protocol: 'grpc' }))
  expect(r.status).toBe(400)
  expect(ui.patches.length).toBe(0)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/settings-api.test.ts`
Expected: 既有断言因 cfg 多 `protocol` 字段红了；新用例 FAIL（schema 不认 protocol）。

- [ ] **Step 3: 实现**（`src/server.ts`）

import 调整：`import { testConnection as defaultTestConnection } from './anthropic'`；`import { testConnection as openAiTestConnection } from './openai'`；`import { resolveCallLLMProtocol, type LLMProtocol } from '@/llm'`。

dep 类型（line 39）改为：

```ts
testConnection?: (cfg: { protocol: LLMProtocol; baseURL?: string; token: string; model?: string }) => Promise<{ ok: boolean; error?: string }>
```

默认 testConn 派发器（line 99 区域）：

```ts
const testConn = deps.testConnection ?? ((cfg: { protocol: LLMProtocol; baseURL?: string; token: string; model?: string }) =>
  cfg.protocol === 'openai'
    ? openAiTestConnection({ baseURL: cfg.baseURL, token: cfg.token, model: cfg.model })
    : defaultTestConnection({ baseURL: cfg.baseURL, token: cfg.token, model: cfg.model }),
)
```

`buildState` 的 `saved` / `effective` 各加 protocol（用 `resolveCallLLMProtocol` 算 effective 协议）：

```ts
const proto = resolveCallLLMProtocol(saved, process.env)
return {
  saved: saved?.token
    ? { protocol: saved.protocol ?? 'anthropic', baseURL: saved.baseURL ?? null, model: saved.model ?? null, tokenMasked: maskToken(saved.token) }
    : null,
  effective: effective?.apiKey
    ? { source: effective.source, protocol: proto, baseURL: effective.baseURL ?? null, model: effective.model ?? null, tokenMasked: maskToken(effective.apiKey) }
    : null,
}
```

`putSchema` 加 `protocol: z.enum(['anthropic', 'openai']).optional()`；`saveUi` dep 类型加 `protocol`。

`testSchema` 加 `protocol: z.enum(['anthropic', 'openai']).optional()`；test 端点：

```ts
const saved = loadUi()
const cfg = {
  protocol: (body.protocol ?? saved?.protocol ?? 'anthropic') as LLMProtocol,
  baseURL: body.baseURL ?? saved?.baseURL,
  token: body.token ?? saved?.token,
  model: body.model ?? saved?.model,
}
if (!cfg.token) return c.json({ ok: false, error: 'no credentials' })
return c.json(await testConn(cfg))
```

- [ ] **Step 4: 运行确认通过（含回归）**

Run: `bun test tests/settings-api.test.ts`
Expected: 新用例 + 更新后的既有断言 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/settings-api.test.ts
git commit -m "feat(server): protocol 入 schema/回显 + 测试连接按协议派发"
```

---

### Task 6: web/api.ts + App.tsx — 协议下拉 + 回显 + body 透传

**Files:**
- Modify: `src/web/api.ts`
- Modify: `src/web/App.tsx`
- Test: `tests/web-ui.test.ts`

**Interfaces:**
- Consumes: Task 5 的 API 响应（`saved`/`effective` 带 `protocol`）。
- Produces: `saveLlmSettings` / `testLlmConnection` body 透传 `protocol?: 'anthropic' | 'openai'`。

- [ ] **Step 1: 写失败测试**（追加到 `tests/web-ui.test.ts`）

```ts
// 双协议（2026-08-06）：LLM 设置面板必须有协议下拉（Anthropic/OpenAI），
// 且 save/test 透传 protocol。源码文本断言锁锚点，refactor 删除即变红。
test('App.tsx 含双协议下拉 + protocol 透传（source text）', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')
  expect(src).toContain('value="anthropic"')
  expect(src).toContain('value="openai"')
  expect(src).toContain('Anthropic')
  expect(src).toContain('OpenAI')
  expect(src).toContain('protocol')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/web-ui.test.ts`
Expected: 新用例 FAIL。

- [ ] **Step 3: 实现**

`src/web/api.ts`：
- `LlmSettingsState` 的 `saved` / `effective` 各加 `protocol: 'anthropic' | 'openai'`。
- `saveLlmSettings` body 类型加 `protocol?: 'anthropic' | 'openai'`。
- `testLlmConnection` body 类型加 `protocol?: 'anthropic' | 'openai'`。

`src/web/App.tsx` 的 `LlmSettings`：
- 加 `const [protocol, setProtocol] = useState<'anthropic' | 'openai'>('anthropic')`。
- 在输入框行上方加协议下拉：

```tsx
<select value={protocol} onChange={(e) => setProtocol(e.target.value as 'anthropic' | 'openai')}
  style={{ flex: '0 0 auto' }}>
  <option value="anthropic">Anthropic</option>
  <option value="openai">OpenAI</option>
</select>
```

- `onSave` / `onTest` 的 body 都带 `protocol`。
- `onClear` 里重置 `setProtocol('anthropic')`。
- baseURL placeholder 按协议提示：anthropic → `baseURL（留空=官方端点，拼 /v1/messages）`；openai → `baseURL（OpenAI 格式，拼 /chat/completions）`。
- 生效回显行（408-412）前缀协议：把 `eff` 改为显示 `{eff?.protocol ?? 'anthropic'}（{label}）`；`state.saved` 解码时 `protocol` 回填到 `setProtocol`（`useEffect` 里 `refresh` 后从 `state.saved?.protocol` 同步）。

> 同步技巧：`refresh()` 里 `setState(await getLlmSettings())` 后，若 `state?.saved?.protocol` 存在则 `setProtocol(state.saved.protocol)`，让下拉跟随已存协议。

- [ ] **Step 4: 运行确认通过（含 typecheck + 全量回归）**

Run: `bun run typecheck && bun test`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/web/api.ts src/web/App.tsx tests/web-ui.test.ts
git commit -m "feat(web): LLM 设置面板加协议下拉，save/test 透传 protocol"
```

---

## Self-Review

**Spec coverage：**
- 存储 `protocol` 字段 → Task 1。
- `loadOpenAiUiCreds` + `loadUiConfig` 注入 → Task 2。
- `resolveCallLLMProtocol` 纯函数 → Task 3。
- `resolveCallLLM` 动态派发（UI 协议即时生效）→ Task 4。
- 测试连接按协议派发 + server schema/回显 → Task 5。
- UI 协议下拉 + 回显 + body 透传 → Task 6。
- 测试策略 7 条全部映射到上面 6 个 Task（settings/openai/llm/daemon/settings-api/web-ui）。

**Placeholder scan：** 无 TBD/TODO；每步含具体代码。

**Type consistency：** `protocol: 'anthropic' | 'openai'` 与 `LLMProtocol` 全程一致；`loadOpenAiUiCreds(ui, env)` 签名在 Task 2/4 一致；`testConnection` 的 `{ protocol, baseURL?, token, model? }` 在 Task 2/5/6 一致；`resolveCallLLMProtocol(uiConfig, env)` 在 Task 3/4/5 一致。