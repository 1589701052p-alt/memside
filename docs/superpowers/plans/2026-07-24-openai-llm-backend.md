# OpenAI 格式 LLM 后端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 memside 在"只有 OpenAI 格式 API、无 Anthropic 凭证"的机器上也能跑 distill——新增一个 OpenAI `/chat/completions` 的 `LLMCall` 实现，组合根按混合规则选后端，核心模块零改动。

**Architecture:** `LLMCall = (system, user, opts?) => Promise<string>` 契约已 SDK-free、vendor-neutral（`src/llm.ts`）。新增 `src/openai.ts` 用内置 `fetch` 直连 OpenAI chat completions，与 `src/anthropic.ts` 对称；新增纯函数 `resolveLLMBackend(env)` 放 `src/llm.ts` 决定后端；组合根 `src/daemon.ts` 加 `resolveCallLLM()` 装配。distiller/dedup/valueFilter/scheduler/retry 全不动——它们只认 `LLMCall`。

**Tech Stack:** Bun + TypeScript（`@/*` -> `src/*` path alias）、`bun:test`、内置 `fetch` + `AbortController`（零新依赖）。

## Global Constraints

- 分支 `feat/openai-llm-backend`，基线 `origin/master` `a7dc93a`（已切，含 LLMCall 契约 + callWithRetry 三道防线）。PR 目标 `master`，禁直推。
- **零新 npm 依赖**——OpenAI 实现用 Bun 内置 `fetch`，不装 `openai` SDK。
- **核心模块零改动**——`src/memory/*`（distiller/dedup/valueFilter/store/pure/adapter）、`src/scheduler.ts`、`src/retry.ts`、`src/anthropic.ts`、`src/creds.ts`、`src/db/*`、`src/server.ts`、`src/install.ts`、`src/cli.ts` 一行不改；`LLMCall` 契约不变。
- `OPENAI_MODEL` **必配**（无默认）；缺则抛错。`OPENAI_BASE_URL` 缺省 `https://api.openai.com/v1`，尾斜杠剥除。凭证只读 env，不读 `~/.claude/settings.json`。
- `max_tokens = opts?.maxTokens ?? DEFAULT_LLM_MAX_TOKENS`（`DEFAULT_LLM_MAX_TOKENS === 8192`），与 Anthropic 实现一致。
- **失败语义**：OpenAI 实现所有异常（无凭据 / HTTP 非 2xx / 超时 / 响应缺字段）均 `throw new Error(...)`，交由既有 `callWithRetry` 重试 + 各层 catch 降级 + scheduler job 退避；不引入新失败模式。唯一"启动即失败"的新增点是 `MEMSIDE_LLM_BACKEND` 未识别值（显式优于静默回退）。
- **运行门槛**：`bun run typecheck && bun test` 全绿才能 push。
- **测试风格**：沿用仓库现有 `bun:test` 裸 `test()` 风格（不用 `describe`），测试文件顶端注释说明"为什么这条测试存在"。

## Pre-implementation gate（CLAUDE.md 强制，不得跳过）

spec + plan 两份已落档到 `docs/superpowers/specs/` 与 `docs/superpowers/plans/`。**开始写任何代码前**，必须清理 brainstorming 中间产物：

- [ ] **Step 0: 清理 `.superpowers/sdd/`**

```bash
# 删除 brainstorming 中间工作产物（spec/plan 已落档到 docs/superpowers/）
rm -rf .superpowers/sdd
# 确认目录已空或不存在
ls .superpowers/sdd 2>&1 || echo "sdd cleaned"
```

Expected: `sdd cleaned`（或 `ls` 报 No such file）。这是"设计阶段结束 -> 执行阶段开始"的闸门，未清理不算落档完成。

---

## File Structure

| 文件 | 责任 | 动作 |
|------|------|------|
| `src/llm.ts` | `LLMCall` 契约 + `DEFAULT_LLM_MAX_TOKENS`；**新增** `LLMBackend` 类型 + `resolveLLMBackend(env)` 纯函数（SDK-free，不 import 实现） | 改 |
| `src/openai.ts` | OpenAI 格式 `LLMCall` 实现：`loadOpenAiCreds()`（读 env）+ `makeLLMCall(deps): LLMCall`（fetch 直连 `/chat/completions`）；`OpenAiCreds` / `OpenAiDeps` 类型 | 新建 |
| `src/daemon.ts` | 组合根：**新增** `resolveCallLLM(deps)` 装配函数；`runDistillOnce` / `startDaemon` 装配点改用它；import 调整 | 改 |
| `tests/llm.test.ts` | 锁 `DEFAULT_LLM_MAX_TOKENS`（既有）+ **新增** `resolveLLMBackend` 混合规则用例 | 改 |
| `tests/openai.test.ts` | mock `globalThis.fetch`，断言 `makeLLMCall` 请求形状 / `max_tokens` 透传 / 响应抽取 / 全部错误路径；`loadOpenAiCreds` env 行为 | 新建 |

依赖方向：`daemon.ts -> @/anthropic | @/openai (实现) -> ./llm (契约, SDK-free)`；核心模块 `-> @/llm`。`@/openai` 不 import SDK，只 import `./llm` 契约 + 用内置 fetch。

任务依赖：Task 1（`resolveLLMBackend`）与 Task 2（`openai.ts`）互不依赖，可任意序；Task 3（daemon 装配）依赖两者。按 1 -> 2 -> 3 线性执行。

---

## Task 1: `resolveLLMBackend` 纯函数（`src/llm.ts`）

**Files:**
- Modify: `src/llm.ts`（在文件末尾追加 `LLMBackend` 类型 + `resolveLLMBackend` 函数）
- Test: `tests/llm.test.ts`（追加 `resolveLLMBackend` 用例 + import）

**Interfaces:**
- Consumes: 无（纯函数，入参 `env: Record<string, string | undefined>`）。
- Produces: `export type LLMBackend = 'anthropic' | 'openai'`；`export function resolveLLMBackend(env: Record<string, string | undefined>): LLMBackend`。Task 3 的 `resolveCallLLM` 调 `resolveLLMBackend(process.env)`。

- [ ] **Step 1: 写失败测试**

把 `tests/llm.test.ts` 整体替换为（保留既有 `DEFAULT_LLM_MAX_TOKENS` 用例，追加 `resolveLLMBackend` import 与 6 条用例）：

```ts
import { test, expect } from 'bun:test'
import { DEFAULT_LLM_MAX_TOKENS, resolveLLMBackend } from '@/llm'

// 锁定契约层默认 max_tokens。该值由 makeLLMCall（src/anthropic.ts 与 src/openai.ts）
// 在 opts.maxTokens 缺省时透传；distill/dedup/valueFilter 经 callWithRetry 以 2 参调用
// seam，故 8192 默认值贯通三处。改动此常量须同步审视 distill 输出是否会被截断。
// 见 spec §5.1 / §9。
test('DEFAULT_LLM_MAX_TOKENS is 8192 (locks the 2048->8192 bump)', () => {
  expect(DEFAULT_LLM_MAX_TOKENS).toBe(8192)
})

// resolveLLMBackend 锁混合后端选择规则（spec §5.1 / §4 决策 5/7 / §9）：
//   - 显式 MEMSIDE_LLM_BACKEND=anthropic|openai 覆盖一切；
//   - 未设（或空串）时按 OPENAI_API_KEY 存在性探测——有则 openai，无则 anthropic；
//   - 未识别的非空值抛错（防拼错静默回退到 anthropic）。
// 该纯函数是 daemon.resolveCallLLM 的选择核心，daemon.test.ts 注入 mock callLLM
// 不经此路径，故选择逻辑必须在此单测覆盖。
test('resolveLLMBackend: explicit openai wins regardless of OPENAI_API_KEY', () => {
  expect(resolveLLMBackend({ MEMSIDE_LLM_BACKEND: 'openai' })).toBe('openai')
  expect(resolveLLMBackend({ MEMSIDE_LLM_BACKEND: 'openai', OPENAI_API_KEY: 'x' })).toBe('openai')
})

test('resolveLLMBackend: explicit anthropic wins even when OPENAI_API_KEY present', () => {
  expect(resolveLLMBackend({ MEMSIDE_LLM_BACKEND: 'anthropic', OPENAI_API_KEY: 'x' })).toBe('anthropic')
})

test('resolveLLMBackend: empty env defaults to anthropic', () => {
  expect(resolveLLMBackend({})).toBe('anthropic')
})

test('resolveLLMBackend: no explicit backend + OPENAI_API_KEY present -> openai', () => {
  expect(resolveLLMBackend({ OPENAI_API_KEY: 'x' })).toBe('openai')
})

test('resolveLLMBackend: empty-string MEMSIDE_LLM_BACKEND treated as unset', () => {
  // 空串 = 未设：仍按 OPENAI_API_KEY 探测
  expect(resolveLLMBackend({ MEMSIDE_LLM_BACKEND: '', OPENAI_API_KEY: 'x' })).toBe('openai')
  expect(resolveLLMBackend({ MEMSIDE_LLM_BACKEND: '' })).toBe('anthropic')
})

test('resolveLLMBackend: unknown MEMSIDE_LLM_BACKEND throws (no silent fallback)', () => {
  expect(() => resolveLLMBackend({ MEMSIDE_LLM_BACKEND: 'foo' })).toThrow(/unknown MEMSIDE_LLM_BACKEND/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/llm.test.ts`
Expected: FAIL —— `resolveLLMBackend` 未从 `@/llm` 导出（`import` 拿到 `undefined`，调用即 `TypeError: resolveLLMBackend is not a function`）。

- [ ] **Step 3: 写最小实现**

在 `src/llm.ts` 末尾（`export const DEFAULT_LLM_MAX_TOKENS = 8192` 之后）追加：

```ts
/** 组合根可选的 LLM 后端实现。vendor 名留在实现层（anthropic.ts / openai.ts）。 */
export type LLMBackend = 'anthropic' | 'openai'

/**
 * 混合后端选择：显式 `MEMSIDE_LLM_BACKEND=anthropic|openai` 覆盖；未设（或空串）
 * 时按 `OPENAI_API_KEY` 存在性探测——有则 openai，无则 anthropic。未识别的非空
 * 值抛错（防拼错静默回退）。纯函数、SDK-free、不 import 任何实现，易单测。
 *
 * 不取 `hasAnthropicCreds` 参数：无 OPENAI_API_KEY 时默认 anthropic，若 anthropic
 * 凭证也缺，由 `makeLLMCall`(anthropic) 在调用时抛 "no credentials"，语义正确。
 */
export function resolveLLMBackend(env: Record<string, string | undefined>): LLMBackend {
  const e = env.MEMSIDE_LLM_BACKEND
  if (e === 'openai') return 'openai'
  if (e === 'anthropic') return 'anthropic'
  if (e !== undefined && e !== '') throw new Error(`unknown MEMSIDE_LLM_BACKEND: ${e} (want 'anthropic' | 'openai')`)
  return env.OPENAI_API_KEY ? 'openai' : 'anthropic'
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/llm.test.ts`
Expected: PASS（7 条全绿：1 条既有 `DEFAULT_LLM_MAX_TOKENS` + 6 条 `resolveLLMBackend`）。

- [ ] **Step 5: 类型检查**

Run: `bun run typecheck`
Expected: 无错误（`resolveLLMBackend` 导出与 import 类型对齐）。

- [ ] **Step 6: 提交**

```bash
git add src/llm.ts tests/llm.test.ts
git commit -m "feat(llm): add resolveLLMBackend pure function for hybrid backend selection"
```

---

## Task 2: OpenAI 实现（`src/openai.ts`）

**Files:**
- Create: `src/openai.ts`
- Test: `tests/openai.test.ts`

**Interfaces:**
- Consumes: `import { DEFAULT_LLM_MAX_TOKENS, type LLMCall, type LLMCallOpts } from './llm'`（Task 1 之前已存在，不依赖 Task 1 新增的 `resolveLLMBackend`）。
- Produces:
  - `export interface OpenAiCreds { apiKey: string; baseURL: string; model: string }`
  - `export interface OpenAiDeps { loadOpenAiCreds?: () => OpenAiCreds | null; timeoutMs?: number }`
  - `export function loadOpenAiCreds(): OpenAiCreds | null`
  - `export function makeLLMCall(deps?: OpenAiDeps): LLMCall`
  - Task 3 的 `resolveCallLLM` 调 `makeOpenAiCall({ loadOpenAiCreds })`，并 `import type { OpenAiCreds }`。

- [ ] **Step 1: 写失败测试**

创建 `tests/openai.test.ts`：

```ts
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { makeLLMCall, loadOpenAiCreds } from '@/openai'
import { DEFAULT_LLM_MAX_TOKENS } from '@/llm'

// 这些测试锁 OpenAI 格式 LLMCall 实现（src/openai.ts，spec §5.2 / §9）：
//   - 请求形状：POST {baseURL}/chat/completions，Bearer 鉴权，system+user 两条 message，
//     max_tokens 默认 DEFAULT_LLM_MAX_TOKENS(8192)、opts.maxTokens 可覆盖。
//   - 响应抽取 choices[0].message.content（多 choice 取 [0]）。
//   - 失败语义对齐 Anthropic：无凭据 / creds loader 抛错 / HTTP 非 2xx / 响应缺字段 /
//     超时(AbortController) 均 throw，交由 callWithRetry 重试降级。
// 全程 mock globalThis.fetch，不发真实网络请求；loadOpenAiCreds 走注入，不读 env
// （loadOpenAiCreds 自身的 env 行为单独覆盖）。

const CREDS = { apiKey: 'sk-test', baseURL: 'https://internal.example.com/v1', model: 'internal-model' }
const ENV_KEYS = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'] as const

let origFetch: typeof fetch
let fetchCalls: Array<{ url: string; init: RequestInit }>
let fetchImpl: typeof fetch
const savedEnv: Record<string, string | undefined> = {}

function okResp(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  origFetch = globalThis.fetch
  fetchCalls = []
  // 默认 fetch 实现返回空 200；每个测试可覆盖 fetchImpl 定制响应/行为
  fetchImpl = async () => new Response('{}', { status: 200 })
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), init: init ?? {} })
    return fetchImpl(input as RequestInfo | URL, init)
  }) as typeof fetch
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k] }
})

afterEach(() => {
  globalThis.fetch = origFetch
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

// ---- loadOpenAiCreds：env 行为（spec §5.2 / §4 决策 3/4）----

test('loadOpenAiCreds returns null when OPENAI_API_KEY missing', () => {
  process.env.OPENAI_MODEL = 'm'
  expect(loadOpenAiCreds()).toBeNull()
})

test('loadOpenAiCreds throws when OPENAI_API_KEY set but OPENAI_MODEL missing', () => {
  process.env.OPENAI_API_KEY = 'k'
  expect(() => loadOpenAiCreds()).toThrow(/OPENAI_MODEL missing/)
})

test('loadOpenAiCreds defaults baseURL to https://api.openai.com/v1 and strips trailing slash', () => {
  process.env.OPENAI_API_KEY = 'k'
  process.env.OPENAI_MODEL = 'm'
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1/'
  const c = loadOpenAiCreds()!
  expect(c.apiKey).toBe('k')
  expect(c.model).toBe('m')
  expect(c.baseURL).toBe('https://api.openai.com/v1')
})

// ---- makeLLMCall：请求形状 + 响应抽取（spec §9 断言 1-4）----

test('makeLLMCall posts to {baseURL}/chat/completions with Bearer auth + system/user messages + default max_tokens', async () => {
  fetchImpl = async () => okResp({ choices: [{ message: { content: 'hello' } }] })
  const call = makeLLMCall({ loadOpenAiCreds: () => CREDS })
  const out = await call('SYS', 'USR')
  expect(out).toBe('hello')
  expect(fetchCalls).toHaveLength(1)
  expect(fetchCalls[0]!.url).toBe('https://internal.example.com/v1/chat/completions')
  const headers = new Headers(fetchCalls[0]!.init.headers as HeadersInit)
  expect(headers.get('authorization')).toBe('Bearer sk-test')
  expect(headers.get('content-type')).toBe('application/json')
  const body = JSON.parse(fetchCalls[0]!.init.body as string)
  expect(body.model).toBe('internal-model')
  expect(body.messages).toEqual([
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'USR' },
  ])
  expect(body.max_tokens).toBe(DEFAULT_LLM_MAX_TOKENS)
  expect(body.max_tokens).toBe(8192)
})

test('makeLLMCall honors opts.maxTokens override', async () => {
  fetchImpl = async () => okResp({ choices: [{ message: { content: 'x' } }] })
  const call = makeLLMCall({ loadOpenAiCreds: () => CREDS })
  await call('s', 'u', { maxTokens: 512 })
  const body = JSON.parse(fetchCalls[0]!.init.body as string)
  expect(body.max_tokens).toBe(512)
})

test('makeLLMCall extracts choices[0].message.content (first of many choices)', async () => {
  fetchImpl = async () => okResp({
    choices: [
      { message: { content: 'first' } },
      { message: { content: 'second' } },
    ],
  })
  const call = makeLLMCall({ loadOpenAiCreds: () => CREDS })
  const out = await call('s', 'u')
  expect(out).toBe('first')
})

// ---- makeLLMCall：失败语义（spec §9 断言 5-9 / §8）----

test('makeLLMCall throws "no OpenAI credentials" and never calls fetch when loadOpenAiCreds returns null', async () => {
  const call = makeLLMCall({ loadOpenAiCreds: () => null })
  await expect(call('s', 'u')).rejects.toThrow(/no OpenAI credentials/)
  expect(fetchCalls).toHaveLength(0)
})

test('makeLLMCall propagates loadOpenAiCreds errors (e.g. missing model) without calling fetch', async () => {
  const call = makeLLMCall({ loadOpenAiCreds: () => { throw new Error('OPENAI_MODEL missing') } })
  await expect(call('s', 'u')).rejects.toThrow(/OPENAI_MODEL missing/)
  expect(fetchCalls).toHaveLength(0)
})

test('makeLLMCall throws "OpenAI HTTP <status>" on non-2xx', async () => {
  fetchImpl = async () => new Response('{"error":"bad key"}', { status: 401 })
  const call = makeLLMCall({ loadOpenAiCreds: () => CREDS })
  await expect(call('s', 'u')).rejects.toThrow(/OpenAI HTTP 401/)
})

test('makeLLMCall throws when response missing choices[0].message.content', async () => {
  fetchImpl = async () => okResp({ choices: [{ message: {} }] })
  const call = makeLLMCall({ loadOpenAiCreds: () => CREDS })
  await expect(call('s', 'u')).rejects.toThrow(/missing choices\[0\]\.message\.content/)
})

test('makeLLMCall aborts after timeoutMs when fetch never resolves', async () => {
  // 永不 resolve 的 fetch；timeoutMs 极小 -> AbortController 触发 -> fetch reject
  fetchImpl = () => new Promise<Response>(() => {})
  const call = makeLLMCall({ loadOpenAiCreds: () => CREDS, timeoutMs: 50 })
  await expect(call('s', 'u')).rejects.toThrow()
  expect(fetchCalls).toHaveLength(1)
  // signal 必须随请求下发
  expect(fetchCalls[0]!.init.signal).toBeInstanceOf(AbortSignal)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/openai.test.ts`
Expected: FAIL —— `@/openai` 模块不存在，`import { makeLLMCall, loadOpenAiCreds } from '@/openai'` 解析失败。

- [ ] **Step 3: 写实现**

创建 `src/openai.ts`（与 `src/anthropic.ts` 对称；spec §5.2 原样）：

```ts
import { DEFAULT_LLM_MAX_TOKENS, type LLMCall, type LLMCallOpts } from './llm'

export interface OpenAiCreds {
  apiKey: string
  baseURL: string // 不含尾斜杠；chat/completions 拼在后面
  model: string
}

export interface OpenAiDeps {
  /** Injectable for tests; production reads env. */
  loadOpenAiCreds?: () => OpenAiCreds | null
  /** 单次请求硬超时；默认 120s。 */
  timeoutMs?: number
}

/**
 * 从 env 读 OpenAI 凭证。`OPENAI_API_KEY` 缺 -> 返回 null（调用方抛错）。
 * `OPENAI_API_KEY` 有但 `OPENAI_MODEL` 缺 -> 抛错（明确的配置错误）。
 * `OPENAI_BASE_URL` 缺省 `https://api.openai.com/v1`，尾斜杠剥除。
 */
export function loadOpenAiCreds(): OpenAiCreds | null {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return null
  const baseURL = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '')
  const model = process.env.OPENAI_MODEL
  if (!model) throw new Error('OPENAI_API_KEY set but OPENAI_MODEL missing; set OPENAI_MODEL')
  return { apiKey, baseURL, model }
}

/**
 * 构造由 OpenAI /chat/completions 支撑的 LLMCall seam。fetch 直连，Bearer 鉴权，
 * system+user 两条 message，取 choices[0].message.content。max_tokens 走
 * opts?.maxTokens ?? DEFAULT_LLM_MAX_TOKENS。无凭据 / HTTP 非 2xx / 超时 / 响应异常
 * 均抛错，交由 callWithRetry 重试 + 各层降级。
 */
export function makeLLMCall(deps: OpenAiDeps = {}): LLMCall {
  const load = deps.loadOpenAiCreds ?? loadOpenAiCreds
  const timeoutMs = deps.timeoutMs ?? 120_000
  return async function callLLM(system: string, user: string, opts?: LLMCallOpts): Promise<string> {
    const c = load()
    if (!c) throw new Error('no OpenAI credentials; set OPENAI_API_KEY + OPENAI_BASE_URL + OPENAI_MODEL')
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const resp = await fetch(`${c.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` },
        body: JSON.stringify({
          model: c.model,
          max_tokens: opts?.maxTokens ?? DEFAULT_LLM_MAX_TOKENS,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: ctrl.signal,
      })
      if (!resp.ok) {
        const body = await resp.text().catch(() => '')
        throw new Error(`OpenAI HTTP ${resp.status}: ${body.slice(0, 200)}`)
      }
      const data = await resp.json() as { choices?: { message?: { content?: unknown } }[] }
      const text = data?.choices?.[0]?.message?.content
      if (typeof text !== 'string') throw new Error('OpenAI response missing choices[0].message.content')
      return text
    } finally {
      clearTimeout(timer)
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/openai.test.ts`
Expected: PASS（9 条全绿：3 条 `loadOpenAiCreds` + 6 条 `makeLLMCall`）。

- [ ] **Step 5: 类型检查**

Run: `bun run typecheck`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add src/openai.ts tests/openai.test.ts
git commit -m "feat(llm): add OpenAI-format LLMCall backend (fetch /chat/completions)"
```

---

## Task 3: 组合根装配（`src/daemon.ts`）

**Files:**
- Modify: `src/daemon.ts`（import 调整 + 新增 `resolveCallLLM` + `runDistillOnce` / `startDaemon` 装配点）

**Interfaces:**
- Consumes: Task 1 的 `resolveLLMBackend`；Task 2 的 `makeLLMCall as makeOpenAiCall` + `type OpenAiCreds`；既有 `makeLLMCall as makeAnthropicCall`（`@/anthropic`）+ `type ClaudeCreds`（`./creds`）。
- Produces: 模块私有 `resolveCallLLM(deps?: ResolveCallLLMDeps): LLMCall`（不导出——选择逻辑由 Task 1 的 `resolveLLMBackend` 单测覆盖，`daemon.test.ts` 注入 mock `callLLM` 不经此函数，spec §9）。

**说明（为何本任务无新测试文件）：** 本任务是纯装配胶水——把"按 `resolveLLMBackend(process.env)` 选后端"接到 `runDistillOnce` / `startDaemon`。后端**选择逻辑**的正确性由 Task 1 的 `resolveLLMBackend` 单测锁定；OpenAI **实现**的正确性由 Task 2 的 `makeLLMCall` 单测锁定；`daemon.test.ts:56` 注入 mock `callLLM` 直接绕过 `resolveCallLLM`，故本任务的验证面是"既有全套测试不回归 + 类型对齐"（spec §9 明确此举）。

- [ ] **Step 1: 调整 import**

把 `src/daemon.ts` 顶部这三行（第 10-12 行）：

```ts
import { makeLLMCall } from '@/anthropic'
import type { LLMCall } from '@/llm'
import { loadClaudeCreds, type ClaudeCreds } from './creds'
```

替换为：

```ts
import { makeLLMCall as makeAnthropicCall } from '@/anthropic'
import { makeLLMCall as makeOpenAiCall, type OpenAiCreds } from '@/openai'
import { resolveLLMBackend, type LLMCall } from '@/llm'
import { type ClaudeCreds } from './creds'
```

> 说明：`loadClaudeCreds` 不再在 daemon.ts 直接引用——anthropic 路径的默认 loader 已在 `anthropic.ts` 内部（`deps.loadClaudeCreds ?? loadClaudeCreds`），`resolveCallLLM` 不传 `loadClaudeCreds` 时 `makeAnthropicCall({})` 会用其自身默认 loader，行为与旧码等价。故移除该 import，仅保留 `type ClaudeCreds`。

- [ ] **Step 2: 新增 `resolveCallLLM`**

在 `src/daemon.ts` 的 `makeLoadTranscript` 函数（第 29-43 行）之后、`runDistillOnce`（第 54 行）之前，插入：

```ts
interface ResolveCallLLMDeps {
  loadClaudeCreds?: () => ClaudeCreds
  loadOpenAiCreds?: () => OpenAiCreds | null
}

/**
 * 组合根：按 `resolveLLMBackend(process.env)` 选后端，装配对应 `makeLLMCall` 为
 * `callLLM`。可选注入两套 creds 供测试避开网络；不传则各 `makeLLMCall` 用各自默认
 * loader（anthropic 读 `~/.claude` + env；openai 读 env）。后端选择逻辑由
 * `resolveLLMBackend` 单测覆盖（tests/llm.test.ts）；本函数是薄胶水。
 */
function resolveCallLLM(deps: ResolveCallLLMDeps = {}): LLMCall {
  return resolveLLMBackend(process.env) === 'openai'
    ? makeOpenAiCall(deps.loadOpenAiCreds ? { loadOpenAiCreds: deps.loadOpenAiCreds } : {})
    : makeAnthropicCall(deps.loadClaudeCreds ? { loadClaudeCreds: deps.loadClaudeCreds } : {})
}
```

- [ ] **Step 3: `runDistillOnce` 改用 `resolveCallLLM`**

把 `src/daemon.ts` 第 54-61 行：

```ts
export async function runDistillOnce(
  db: DbClient,
  deps: {
    loadClaudeCreds?: () => ClaudeCreds
    callLLM?: LLMCall
  } = {},
): Promise<number> {
  const callLLM = deps.callLLM ?? makeLLMCall({ loadClaudeCreds: deps.loadClaudeCreds ?? loadClaudeCreds })
```

替换为：

```ts
export async function runDistillOnce(
  db: DbClient,
  deps: {
    loadClaudeCreds?: () => ClaudeCreds
    loadOpenAiCreds?: () => OpenAiCreds | null
    callLLM?: LLMCall
  } = {},
): Promise<number> {
  const callLLM = deps.callLLM ?? resolveCallLLM({ loadClaudeCreds: deps.loadClaudeCreds, loadOpenAiCreds: deps.loadOpenAiCreds })
```

- [ ] **Step 4: `startDaemon` 改用 `resolveCallLLM`**

把 `src/daemon.ts` 第 118 行：

```ts
    callLLM: makeLLMCall(),
```

替换为：

```ts
    callLLM: resolveCallLLM(),
```

- [ ] **Step 5: 类型检查**

Run: `bun run typecheck`
Expected: 无错误。重点核对：
- `makeAnthropicCall` / `makeOpenAiCall` 别名无冲突；
- `resolveLLMBackend` / `OpenAiCreds` / `ClaudeCreds` / `LLMCall` 均已 import；
- 无 `makeLLMCall`（旧未别名 import）残留引用；
- 无 `loadClaudeCreds` 未定义引用（已从 import 移除，函数体不再用它）。

- [ ] **Step 6: 跑全套测试确认不回归**

Run: `bun test`
Expected: 全绿。重点确认：
- `tests/daemon.test.ts` —— `runDistillOnce` 用例注入 mock `callLLM`，绕过 `resolveCallLLM`，行为不变（spec §9）。
- `tests/anthropic.test.ts` —— 直接测 `@/anthropic` 的 `makeLLMCall`，不涉 daemon，不受影响。
- `tests/llm.test.ts` / `tests/openai.test.ts` —— Task 1/2 新增用例全绿。
- `tests/scheduler.test.ts` / `tests/e2e.test.ts` / `tests/distiller.test.ts` / `tests/dedup.test.ts` —— 调 `tick` 注入自己的 `callLLM`，不涉 `resolveCallLLM`，不受影响。

- [ ] **Step 7: 提交**

```bash
git add src/daemon.ts
git commit -m "feat(daemon): select LLM backend via resolveCallLLM (anthropic|openai)"
```

---

## 收尾：push + PR

- [ ] **Step 1: 最终门槛**

Run: `bun run typecheck && bun test`
Expected: 全绿（这是 CLAUDE.md 的 push 门槛）。

- [ ] **Step 2: push + 开 PR**

```bash
git push -u origin feat/openai-llm-backend
gh pr create --base master --title "feat(llm): OpenAI-format LLM backend" --body "..."
```

PR body 要点：引用 spec `docs/superpowers/specs/2026-07-24-openai-llm-backend-design.md` 与本 plan；说明核心模块零改动、混合后端选择规则、失败语义对齐 Anthropic、新增 `src/openai.ts` + `resolveLLMBackend` + `resolveCallLLM`。

---

## Self-Review（plan 作者自查）

**1. Spec 覆盖：**
- G1（openai.ts `makeLLMCall` + `loadOpenAiCreds`，fetch，零依赖）-> Task 2。✓
- G2（`resolveLLMBackend` 纯函数，混合规则，放 `src/llm.ts`）-> Task 1。✓
- G3（env-only 凭证，`OPENAI_MODEL` 必配）-> Task 2 `loadOpenAiCreds` 三条用例。✓
- G4（核心零改动）-> 仅 Task 3 改 `daemon.ts`；核心模块不在任何任务的 Modify 列表。✓
- G5（失败语义对齐）-> Task 2 错误用例（无凭据 / loader 抛错 / HTTP 401 / 缺 content / 超时）。✓
- G6（max_tokens 默认 8192）-> Task 2 `body.max_tokens === 8192` 断言。✓
- §5.3 daemon 装配（import + `resolveCallLLM` + `runDistillOnce` + `startDaemon`）-> Task 3 四个 Step。✓
- §9 全部测试断言 -> Task 1（6 条 `resolveLLMBackend`）+ Task 2（9 条：3 loadOpenAiCreds + 6 makeLLMCall）。✓
- §10 落地流程 step 4（清理 `.superpowers/sdd/`）-> Pre-implementation gate Step 0。✓
- §11 涉及文件清单 -> File Structure 表完全对应。✓

**2. 占位符扫描：** 无 TBD/TODO/"add error handling"/"similar to Task N"；每个 code step 均给出完整代码；每条命令给出 expected。

**3. 类型一致性：** `LLMBackend`、`resolveLLMBackend(env): LLMBackend`、`OpenAiCreds {apiKey,baseURL,model}`、`OpenAiDeps {loadOpenAiCreds?,timeoutMs?}`、`loadOpenAiCreds(): OpenAiCreds|null`、`makeLLMCall(deps?): LLMCall`、`ResolveCallLLMDeps {loadClaudeCreds?,loadOpenAiCreds?}`、`resolveCallLLM(deps?): LLMCall`——跨任务命名/签名一致；Task 3 import 别名 `makeAnthropicCall`/`makeOpenAiCall` 与 Task 2 导出的 `makeLLMCall` 对应。✓
