# 生效 API 回显与测试连接实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Web UI 的生效回显行显示真正生效的 API（按协议派发解析），并给该生效配置加一个「测试生效」按钮；保留原「测试连接」按钮。

**Architecture:** 给 `OpenAiCreds` 加 `source` 字段；`buildState` 按 `resolveCallLLMProtocol` 派发解析 effective（openai 走 `loadOpenAiUiCreds`，anthropic 走 `loadClaudeCreds`），全部收敛进一个 `resolveEffective` 辅助；新增 `POST /api/settings/llm/test-effective` 复用同一解析；UI 生效行内加「测试生效」按钮。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite + zod；前端 Vite + React 19。测试用 `bun test`。

## Global Constraints

- 测试一律 `bun test`，严禁 `npm test`（CLAUDE.md）。
- 分支 + PR，严禁直推 master；基线从 `origin/master` 切。
- `bun run typecheck && bun test` 必须全绿才能 push。
- 任何 API 路径不得回明文 token（`maskToken` 硬约束）。
- UI 配置 / 存储读异常降级 `saved:null` / `effective:null`，不 500。
- 原 `POST /api/settings/llm/test` 端点语义不变（测输入框 / 已保存 UI 配置）。
- 不为 OpenAI 引入 settings.json / credentials.json 链（UI -> env 两级）。
- 免 brainstorming 的例外不适用本改动（触及生产代码，必须带测试）。

---

### Task 1: openai.ts — `OpenAiCreds` 加 `source` 字段

**Files:**
- Modify: `src/openai.ts`
- Test: `tests/openai.test.ts`

**Interfaces:**
- Produces: `OpenAiCreds` 现在含 `source: string`；`loadOpenAiCreds()`（env）返回 `source: 'env:openai'`；`loadOpenAiUiCreds` 的 UI 分支返回 `source: 'ui'`、env 回退分支返回 `source: 'env:openai'`。
- Consumes: 无（`makeLLMCall` 只读 apiKey/baseURL/model，新增 source 不影响）。

- [ ] **Step 1: 先更新既有断言，再写新测试**（`tests/openai.test.ts`）

现有 `loadOpenAiCreds` / `loadOpenAiUiCreds` 的 `toEqual({ apiKey, baseURL, model })` 断言在加 `source` 后变红（strict toEqual）。把所有 `loadOpenAiCreds` 相关断言（约 3 处）与 `loadOpenAiUiCreds` 相关断言（约 3 处）的期望对象补上对应 `source`：

- `loadOpenAiCreds` 期望加 `source: 'env:openai'`。
- `loadOpenAiUiCreds` 的 UI 分支期望加 `source: 'ui'`；env 回退分支（`loadOpenAiUiCreds(null, ...)`）期望加 `source: 'env:openai'`。

追加 source 值断言：

```ts
test('loadOpenAiUiCreds: UI 分支 source=ui，env 回退 source=env:openai', () => {
  expect(loadOpenAiUiCreds({ token: 'sk-ui', baseURL: 'https://ui.example.com/v1', model: 'ui-model' }, {}).source).toBe('ui')
  process.env.OPENAI_API_KEY = 'k'
  process.env.OPENAI_MODEL = 'm'
  expect(loadOpenAiUiCreds(null, {})!.source).toBe('env:openai')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/openai.test.ts`
Expected: 既有 `toEqual` 断言 FAIL（source 缺失）。

- [ ] **Step 3: 实现**（`src/openai.ts`）

`OpenAiCreds` 接口加 `source: string`：

```ts
export interface OpenAiCreds {
  apiKey: string
  baseURL: string // 不含尾斜杠；chat/completions 拼在后面
  model: string
  source: string // 来源标识：'ui' | 'env:openai'
}
```

`loadOpenAiCreds` 返回对象加 `source: 'env:openai'`：

```ts
return { apiKey, baseURL, model, source: 'env:openai' }
```

`loadOpenAiUiCreds` 的 UI 分支：

```ts
return { apiKey: ui.token, baseURL, model, source: 'ui' }
```

（env 回退分支 `return loadOpenAiCreds()` 已带 `source: 'env:openai'`，无需改。）

- [ ] **Step 4: 运行确认通过**

Run: `bun test tests/openai.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/openai.ts tests/openai.test.ts
git commit -m "feat(openai): OpenAiCreds 加 source 字段（ui/env:openai）"
```

---

### Task 2: server.ts — `buildState` 按协议派发 effective

**Files:**
- Modify: `src/server.ts`
- Test: `tests/settings-api.test.ts`

**Interfaces:**
- Consumes: `resolveCallLLMProtocol`（`@/llm`）、`loadClaudeCreds`（`@/creds`）、`loadOpenAiUiCreds`（Task 1，带 source 的 OpenAiCreds）。
- Produces:
  - `AppDeps` 加 `loadEffectiveOpenAiCreds?: () => OpenAiCreds | null`（注入点，缺省 `() => loadOpenAiUiCreds(loadUi(), process.env)`）。
  - 内部 helper `resolveEffective(proto, loadAnthropic, loadOpenAi): { source: string; apiKey: string; baseURL?: string; model?: string } | null`。
  - `GET/PUT /api/settings/llm` 的 `effective` 按 `resolveCallLLMProtocol(saved, env)` 派发：openai 用 OpenAI creds，anthropic 用 ClaudeCreds。

- [ ] **Step 1: 写失败测试**（追加到 `tests/settings-api.test.ts`）

`makeApp` override 需支持新注入 `loadEffectiveOpenAiCreds`。在 `makeApp` 的 overrides 类型加 `loadEffectiveOpenAiCreds?: () => OpenAiCreds | null`，并透传给 `createApp`。加 import `type { OpenAiCreds } from '@/openai'`。

追加测试：

```ts
// spec §生效 API 解析：openai 协议下 effective 反映 OpenAI creds（非 Anthropic 链），
// source=ui/env:openai，token 打码。
test('GET openai 协议 -> effective 用 loadEffectiveOpenAiCreds（OpenAI creds，source 正确）', async () => {
  const ui = makeFakeUiStore({ token: 'sk-openai-abcdefghijkl', protocol: 'openai', baseURL: 'https://ark.example.cn/api/plan/v3', model: 'ark-code-latest' })
  const app = makeApp({
    ...ui,
    loadEffectiveOpenAiCreds: () => ({ apiKey: 'sk-openai-abcdefghijkl', baseURL: 'https://ark.example.cn/api/plan/v3', model: 'ark-code-latest', source: 'ui' }),
    loadEffectiveCreds: () => ({ apiKey: 'sk-wrong-anthropic', source: 'settings.json:authToken' }), // 证明 openai 不走它
    testConnection: async () => ({ ok: true }),
  })
  const r = await req(app, '/api/settings/llm')
  expect(r.status).toBe(200)
  expect(r.body.effective).toMatchObject({
    protocol: 'openai',
    source: 'ui',
    baseURL: 'https://ark.example.cn/api/plan/v3',
    model: 'ark-code-latest',
  })
  expect(r.body.effective.tokenMasked).toBe(maskToken('sk-openai-abcdefghijkl'))
  expect(JSON.stringify(r.body)).not.toContain('sk-openai-abcdefghijkl')
})

test('GET anthropic 协议（缺省）-> effective 仍用 loadEffectiveCreds（不回归）', async () => {
  const ui = makeFakeUiStore(null)
  const app = makeApp({
    ...ui,
    loadEffectiveCreds: () => ({ apiKey: 'sk-fallback-xyz', baseURL: 'https://a.example.com', source: 'settings.json:authToken' }),
    testConnection: async () => ({ ok: true }),
  })
  const r = await req(app, '/api/settings/llm')
  expect(r.status).toBe(200)
  expect(r.body.effective).toMatchObject({ protocol: 'anthropic', source: 'settings.json:authToken', baseURL: 'https://a.example.com' })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/settings-api.test.ts`
Expected: 新用例 FAIL（effective 仍恒走 loadEffectiveCreds，openai 用例拿不到 OpenAI creds）。

- [ ] **Step 3: 实现**（`src/server.ts`）

import 加 `import type { OpenAiCreds } from './openai'`（若尚未导入）。

`AppDeps` 加：

```ts
loadEffectiveOpenAiCreds?: () => OpenAiCreds | null
```

依赖解析区（line 94-105 附近）加：

```ts
const loadEffOpenAi = deps.loadEffectiveOpenAiCreds ?? (() => loadOpenAiUiCreds(loadUi(), process.env))
```

新增纯 helper（放 deps 解析之后）：

```ts
/** 按协议解析当前生效 creds，统一为 {source, apiKey, baseURL?, model?}；无 creds 返回 null。 */
function resolveEffective(
  proto: LLMProtocol,
  loadAnthropic: () => ClaudeCreds,
  loadOpenAi: () => OpenAiCreds | null,
): { source: string; apiKey: string; baseURL?: string; model?: string } | null {
  if (proto === 'openai') {
    const c = loadOpenAi()
    if (!c) return null
    return { source: c.source, apiKey: c.apiKey, baseURL: c.baseURL, model: c.model }
  }
  const c = loadAnthropic()
  if (!c.apiKey) return null
  return { source: c.source, apiKey: c.apiKey, ...(c.baseURL ? { baseURL: c.baseURL } : {}), ...(c.model ? { model: c.model } : {}) }
}
```

`buildState` 改为按协议派发：

```ts
const buildState = () => {
  let saved: UiLlmConfig | null = null
  try { saved = loadUi() } catch { /* 存储异常降级 saved:null，不 500 */ }
  let effective: { source: string; apiKey: string; baseURL?: string; model?: string } | null = null
  try {
    const proto = resolveCallLLMProtocol(saved, process.env)
    effective = resolveEffective(proto, loadEff, loadEffOpenAi)
  } catch { effective = null }
  const proto = resolveCallLLMProtocol(saved, process.env)
  return {
    saved: saved?.token
      ? { protocol: saved.protocol ?? 'anthropic', baseURL: saved.baseURL ?? null, model: saved.model ?? null, tokenMasked: maskToken(saved.token) }
      : null,
    effective: effective?.apiKey
      ? { source: effective.source, protocol: proto, baseURL: effective.baseURL ?? null, model: effective.model ?? null, tokenMasked: maskToken(effective.apiKey) }
      : null,
  }
}
```

> 注：`effective` 现在协议 openai 时来自 `loadOpenAiUiCreds`（带 source），anthropic 时来自 `loadClaudeCreds`；`proto` 仍由 `resolveCallLLMProtocol` 计算，回显 `protocol` 字段不变。

- [ ] **Step 4: 运行确认通过（含回归）**

Run: `bun test tests/settings-api.test.ts`
Expected: 新用例 + 既有用例 PASS（既有 `GET 无 UI 配置 -> effective 为注入的兜底级` 等仍走 anthropic 分支，不回归）。

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/settings-api.test.ts
git commit -m "feat(server): buildState 按协议派发 effective（resolveEffective 辅助）"
```

---

### Task 3: server.ts — `POST /api/settings/llm/test-effective`

**Files:**
- Modify: `src/server.ts`
- Test: `tests/settings-api.test.ts`

**Interfaces:**
- Consumes: `resolveCallLLMProtocol`、`resolveEffective` helper（Task 2）、`loadUi` / `loadEff` / `loadEffOpenAi` / `testConn`（Task 2 已接）。
- Produces: `POST /api/settings/llm/test-effective`——无 body，后端自解析生效 creds + 协议，按协议派发 `testConn`；无 creds -> `{ok:false, error:'no credentials'}`（HTTP 200）；存储读异常 -> `{ok:false, error:'no credentials'}`（不 500）。

- [ ] **Step 1: 写失败测试**（追加到 `tests/settings-api.test.ts`）

```ts
// spec §test-effective：无 body 解析生效 creds，按协议派发 testConn；无 creds -> no credentials。
test('POST test-effective openai -> 用生效 OpenAI creds 调 testConn', async () => {
  const ui = makeFakeUiStore({ token: 'sk-openai-abcdefghijkl', protocol: 'openai', baseURL: 'https://ark.example.cn/api/plan/v3', model: 'ark-code-latest' })
  const calls: { protocol: string; baseURL?: string; token: string; model?: string }[] = []
  const app = makeApp({
    ...ui,
    loadEffectiveOpenAiCreds: () => ({ apiKey: 'sk-openai-abcdefghijkl', baseURL: 'https://ark.example.cn/api/plan/v3', model: 'ark-code-latest', source: 'ui' }),
    loadEffectiveCreds: () => ({ apiKey: 'sk-wrong-anthropic', source: 'none' }),
    testConnection: async (cfg) => { calls.push(cfg); return { ok: true } },
  })
  const r = await req(app, '/api/settings/llm/test-effective', postJson({}))
  expect(r.status).toBe(200)
  expect(r.body).toEqual({ ok: true })
  expect(calls).toEqual([{ protocol: 'openai', baseURL: 'https://ark.example.cn/api/plan/v3', token: 'sk-openai-abcdefghijkl', model: 'ark-code-latest' }])
})

test('POST test-effective 无 creds -> {ok:false, error:"no credentials"}', async () => {
  const ui = makeFakeUiStore(null)
  const app = makeApp({
    ...ui,
    loadEffectiveOpenAiCreds: () => null,
    loadEffectiveCreds: () => ({ apiKey: null, source: 'none' }),
    testConnection: async () => ({ ok: true }),
  })
  const r = await req(app, '/api/settings/llm/test-effective', postJson({}))
  expect(r.status).toBe(200)
  expect(r.body).toEqual({ ok: false, error: 'no credentials' })
})

test('POST test-effective 存储读异常 -> no credentials 不 500', async () => {
  const app = makeApp({
    loadUiConfig: () => { throw new Error('SQLITE_BUSY') },
    saveUiConfig: () => {},
    loadEffectiveOpenAiCreds: () => null,
    loadEffectiveCreds: () => ({ apiKey: null, source: 'none' }),
    testConnection: async () => ({ ok: true }),
  })
  const r = await req(app, '/api/settings/llm/test-effective', postJson({}))
  expect(r.status).toBe(200)
  expect(r.body).toEqual({ ok: false, error: 'no credentials' })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/settings-api.test.ts`
Expected: 新用例 FAIL（端点 404）。

- [ ] **Step 3: 实现**（`src/server.ts`，在 `POST /api/settings/llm/test` 之后加）

```ts
// 「测试生效」：无 body，后端自解析当前生效的 creds + 协议（与 buildState 同源，
// 确保测的是 distill 实际会用的那套）。无 creds / 存储异常 -> {ok:false,error:'no credentials'}
// （HTTP 200——业务结果不是请求错误）。复用 testConn 派发器，测试注入零网络。
app.post('/api/settings/llm/test-effective', async (c) => {
  let saved: UiLlmConfig | null = null
  try { saved = loadUi() } catch { saved = null }
  let effective: { source: string; apiKey: string; baseURL?: string; model?: string } | null = null
  try {
    const proto = resolveCallLLMProtocol(saved, process.env)
    effective = resolveEffective(proto, loadEff, loadEffOpenAi)
  } catch { effective = null }
  if (!effective?.apiKey) return c.json({ ok: false, error: 'no credentials' })
  const proto = resolveCallLLMProtocol(saved, process.env)
  return c.json(await testConn({ protocol: proto, baseURL: effective.baseURL, token: effective.apiKey, model: effective.model }))
})
```

- [ ] **Step 4: 运行确认通过（含回归）**

Run: `bun test tests/settings-api.test.ts`
Expected: 3 个新用例 + 既有用例 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/settings-api.test.ts
git commit -m "feat(server): 新增 POST /api/settings/llm/test-effective（测生效 API）"
```

---

### Task 4: web — `testEffectiveLlmConnection` + 生效行「测试生效」按钮

**Files:**
- Modify: `src/web/api.ts`
- Modify: `src/web/App.tsx`
- Test: `tests/web-ui.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `POST /api/settings/llm/test-effective`。
- Produces: `testEffectiveLlmConnection(fetchFn?): Promise<{ok, error?}>`（api.ts）；App.tsx 生效行内「测试生效」按钮。

- [ ] **Step 1: 写失败测试**（追加到 `tests/web-ui.test.ts`）

```ts
// 生效 API 回显与测试（2026-08-06）：生效行内必须有「测试生效」按钮，api.ts 有
// testEffectiveLlmConnection。源码文本断言锁锚点，refactor 删除即变红。
test('App.tsx 生效行有「测试生效」按钮 + api.ts 有 testEffectiveLlmConnection', () => {
  const app = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')
  const api = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'api.ts'), 'utf8')
  expect(app).toContain('测试生效')
  expect(app).toContain('testEffectiveLlmConnection')
  expect(api).toContain('testEffectiveLlmConnection')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/web-ui.test.ts`
Expected: 新用例 FAIL。

- [ ] **Step 3: 实现**

`src/web/api.ts` 加（在 `testLlmConnection` 之后）：

```ts
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
```

`src/web/App.tsx` 的 `LlmSettings`：
- 加 `const [effBusy, setEffBusy] = useState(false)` 与 `const [effMsg, setEffMsg] = useState<string | null>(null)`（生效测试独立反馈，不与输入框测试互扰）。
- 加处理函数：

```tsx
const onTestEffective = async () => {
  setEffBusy(true); setEffMsg(null)
  try {
    const r = await testEffectiveLlmConnection()
    setEffMsg(r.ok ? '生效连接成功' : `生效连接失败: ${r.error ?? '未知错误'}`)
  } catch (e) { setEffMsg(`生效测试失败: ${e}`) }
  finally { setEffBusy(false) }
}
```

- 生效回显行（`eff` 非空时）行末加按钮：

```tsx
<div style={{ marginBottom: 8, fontSize: 13 }}>
  当前生效：{eff
    ? <><b>{llmSourceLabel(eff.source)}</b>{' · '}{eff?.protocol ?? 'anthropic'}{' · '}{eff.baseURL ?? '官方端点'}{' · '}{eff.model ?? '默认模型'}{' · '}token <code>{eff.tokenMasked}</code>
      {' '}<button disabled={effBusy} onClick={() => void onTestEffective()}>测试生效</button>{effBusy ? ' 测中…' : ''}</>
    : <b>未配置</b>}
  {effMsg ? <span style={{ color: effMsg.includes('失败') ? '#b00' : '#080' }}>{effMsg}</span> : null}
</div>
```

- import 加 `testEffectiveLlmConnection`（App.tsx 顶部从 `./api` import）。
- 底部「测试连接」按钮与 onTest 保持不变。

- [ ] **Step 4: 运行确认通过（含 typecheck + 全量回归）**

Run: `bun run typecheck && bun test`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/web/api.ts src/web/App.tsx tests/web-ui.test.ts
git commit -m "feat(web): 生效行加「测试生效」按钮，api.ts 加 testEffectiveLlmConnection"
```

---

## Self-Review

**Spec coverage：**
- `OpenAiCreds` 加 `source` + `loadEffectiveOpenAiCreds` 同源解析（UI->env）→ Task 1（用 `loadOpenAiUiCreds` 现成函数 + source，避免重复函数）。
- `buildState` 按协议派发 effective（openai 用 OpenAI creds，source 正确，token 打码）→ Task 2。
- 新增 `POST /api/settings/llm/test-effective`（无 body，后端自解析，按协议派发，无 creds/存储异常 -> no credentials 不 500）→ Task 3。
- UI 生效行「测试生效」按钮 + `testEffectiveLlmConnection` + 保留原「测试连接」→ Task 4。
- 测试策略 4 条映射到 Task 1-4（openai/settings-api/web-ui）。

**Placeholder scan：** 无 TBD/TODO；每步含具体代码。

**Type consistency：** `source: string` 贯穿 `OpenAiCreds`（Task 1）与 `resolveEffective` 返回（Task 2/3）；`resolveEffective(proto, loadAnthropic, loadOpenAi)` 签名在 Task 2/3 一致；`loadEffOpenAi`/`loadEffectiveOpenAiCreds` 命名在 Task 2/3 一致；`testEffectiveLlmConnection` 在 Task 3/4 一致。