# LLM 调用 seam 抽象清理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把核心记忆模块对 AI 调用层的依赖收敛到一个 SDK-free 的 `LLMCall` 契约（`src/llm.ts`），seam 改 vendor-neutral 名 `callLLM`，`max_tokens` 可配（默认 8192），唯一行为变更是 2048->8192。

**Architecture:** 新建 SDK-free 契约模块 `src/llm.ts`（`LLMCall` / `LLMCallOpts` / `DEFAULT_LLM_MAX_TOKENS=8192`，不 import SDK）；`src/anthropic.ts` 保留为实现（`makeCallAnthropic`->`makeLLMCall`，`opts.maxTokens` 透传）；核心 4 处（`distiller`/`dedup`/`scheduler`/`daemon`）seam 字段 `callAnthropic`->`callLLM` 并引用契约类型。核心 `import type { LLMCall } from '@/llm'` 物理上不碰 SDK。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite(WAL) + zod + @anthropic-ai/sdk；测试 bun:test。

## Global Constraints

- `bun run typecheck && bun test` 必须全绿才能 push（CLAUDE.md 运行门槛）。
- 严禁直推 `master`；本分支 `refactor/llm-seam-cleanup`（基线 `origin/master` `4e52cee`，spec commit `7bc73fe`），PR 合 `master`。
- 任何生产代码改动必须带测试；纯函数/纯数据层为首选可断言面（CLAUDE.md）。
- 唯一运行时行为变更：`max_tokens` 2048 -> 8192。其余纯重构零行为变更；不改 prompt、不改 distiller/dedup 降级语义、不动 `creds.ts`、零 schema 变更。
- 契约模块 `src/llm.ts` 刻意不 import `@anthropic-ai/sdk` / `./creds`；SDK 只存在于 `src/anthropic.ts`。
- commit message 末尾带 `Co-Authored-By: Claude <noreply@anthropic.com>`（CLAUDE.md）。
- 完成全部任务后、写代码前已清理 `.superpowers/sdd/`（本计划落地流程 step 4，CLAUDE.md 强制）。

## File Structure

| 文件 | 职责 | 本计划动作 |
|------|------|-----------|
| `src/llm.ts`（新） | SDK-free LLM 调用契约 | 新建 `LLMCall`/`LLMCallOpts`/`DEFAULT_LLM_MAX_TOKENS` |
| `tests/llm.test.ts`（新） | 契约常量锁定 | 新建，锁 8192 |
| `src/anthropic.ts` | Anthropic SDK 实现 | `makeCallAnthropic`->`makeLLMCall` + opts + import `./llm` |
| `tests/anthropic.test.ts` | 实现测试 | 符号改名 + 加 max_tokens 测试 |
| `src/memory/distiller.ts` | distill | seam 字段 `callAnthropic`->`callLLM: LLMCall` |
| `src/memory/dedup.ts` | dedup | seam 字段 `callAnthropic`->`callLLM: LLMCall` |
| `src/scheduler.ts` | tick | `TickDeps.callAnthropic`->`callLLM: LLMCall` + 透传 |
| `src/daemon.ts` | 组合根 | `makeLLMCall` 装配 + seam 字段改名 + import 类型 |
| 5 个测试文件 | mock 字段改名 | `callAnthropic:`->`callLLM:`（~22 处） |

依赖方向（无循环）：`src/llm.ts`（无依赖）；`src/anthropic.ts` -> `./llm` + `./creds` + SDK；核心 -> `@/llm`（type only）；`src/daemon.ts` -> `@/anthropic` + `@/llm`。

---

## Task 1: SDK-free 契约模块 `src/llm.ts`

**Files:**
- Create: `src/llm.ts`
- Test: `tests/llm.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `LLMCall`（`(system, user, opts?) => Promise<string>`）、`LLMCallOpts`（`{ maxTokens?: number }`）、`DEFAULT_LLM_MAX_TOKENS`（`8192`）。Task 2 的 `makeLLMCall` 返回 `LLMCall` 并用 `DEFAULT_LLM_MAX_TOKENS` 作默认；Task 3 的核心模块 `import type { LLMCall }`。

- [ ] **Step 1: 写失败测试**

新建 `tests/llm.test.ts`：

```ts
import { test, expect } from 'bun:test'
import { DEFAULT_LLM_MAX_TOKENS } from '@/llm'

// 锁定契约层默认 max_tokens。该值由 makeLLMCall（src/anthropic.ts）在
// opts.maxTokens 缺省时透传给 messages.create；改动此常量须同步审视 distill
// 输出是否会被截断。见 spec §5.1 / §9。
test('DEFAULT_LLM_MAX_TOKENS is 8192 (locks the 2048->8192 bump)', () => {
  expect(DEFAULT_LLM_MAX_TOKENS).toBe(8192)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/llm.test.ts`
Expected: FAIL，错误含 `Cannot find module '@/llm'` 或 `DEFAULT_LLM_MAX_TOKENS is not defined`。

- [ ] **Step 3: 写最小实现**

新建 `src/llm.ts`：

```ts
/** 单次 LLM 调用的可选参数。 */
export interface LLMCallOpts {
  /** 输出 token 上限；缺省时实现用 DEFAULT_LLM_MAX_TOKENS。 */
  maxTokens?: number
}

/**
 * vendor-neutral 的 LLM 调用 seam。核心记忆模块（distiller / dedup /
 * scheduler）依赖此类型，而非任何具体 provider。实现（src/anthropic.ts）
 * 只在组合根（daemon.ts）装配；测试注入 mock。返回模型响应的拼接文本。
 *
 * 本模块刻意不 import `@anthropic-ai/sdk` / `./creds`，使"核心不依赖 SDK"
 * 成为结构保证：核心 `import type { LLMCall }` 编译期擦除，运行时零 SDK
 * 依赖，且即便误写运行时 import 也碰不到 SDK。
 */
export type LLMCall = (system: string, user: string, opts?: LLMCallOpts) => Promise<string>

/** opts.maxTokens 缺省时的默认 max_tokens。 */
export const DEFAULT_LLM_MAX_TOKENS = 8192
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/llm.test.ts`
Expected: PASS（1 pass）。

Run: `bun run typecheck`
Expected: 无错误（`src/llm.ts` 无消费者，独立编译通过）。

- [ ] **Step 5: Commit**

```bash
git add src/llm.ts tests/llm.test.ts
git commit -m "feat(llm): add SDK-free LLMCall contract module (default max_tokens 8192)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: `src/anthropic.ts` -> `makeLLMCall` + opts；扩展 `tests/anthropic.test.ts`

**Files:**
- Modify: `src/anthropic.ts`
- Modify: `src/daemon.ts`（仅 import 名 + 2 处工厂调用改名，字段名留到 Task 3）
- Test: `tests/anthropic.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `LLMCall` / `LLMCallOpts` / `DEFAULT_LLM_MAX_TOKENS`（from `./llm`）。
- Produces: `makeLLMCall(deps: AnthropicDeps): LLMCall`（取代 `makeCallAnthropic`）。`DISTILL_MODEL` / `AnthropicDeps` 不变。Task 3 的核心模块仍用字段名 `callAnthropic`（Task 3 才改 `callLLM`）。

- [ ] **Step 1: 写失败测试（改名 + 新增 max_tokens 用例）**

将 `tests/anthropic.test.ts` 整体替换为：

```ts
import { test, expect, mock, beforeEach } from 'bun:test'
import { makeLLMCall, DISTILL_MODEL } from '@/anthropic'
import { DEFAULT_LLM_MAX_TOKENS } from '@/llm'

// These tests assert that the proxy auth fields resolved by `loadClaudeCreds`
// (baseURL + model) actually flow into the @anthropic-ai/sdk call:
//   - baseURL    -> `new Anthropic({ baseURL })`
//   - model      -> `client.messages.create({ model })`
//   - max_tokens -> `DEFAULT_LLM_MAX_TOKENS` (8192) by default, `opts.maxTokens` override
//
// We never make a live network call: `@anthropic-ai/sdk` is replaced with a
// recording fake. `mock.module` is hoisted above the `@/anthropic` import by
// bun:test, so `makeLLMCall` closes over the fake class at runtime.

const ctorCalls: Array<Record<string, unknown>> = []
const createCalls: Array<Record<string, unknown>> = []

function FakeAnthropic(this: any, opts: Record<string, unknown> = {}) {
  ctorCalls.push(opts)
  this.messages = {
    create: async (args: Record<string, unknown>) => {
      createCalls.push(args)
      return { content: [{ type: 'text', text: '{"candidates":[]}' }] }
    },
  }
}

mock.module('@anthropic-ai/sdk', () => ({ default: FakeAnthropic }))

beforeEach(() => {
  ctorCalls.length = 0
  createCalls.length = 0
})

test('constructs Anthropic client with creds baseURL and uses creds model (proxy path)', async () => {
  const callLLM = makeLLMCall({
    loadClaudeCreds: () => ({
      apiKey: 'ark-token',
      baseURL: 'https://ark.cn-beijing.volces.com/api/plan',
      model: 'deepseek-v4-flash[1m]',
      source: 'env:authToken',
    }),
  })
  await callLLM('sys', 'user')

  // baseURL flows into the SDK constructor
  expect(ctorCalls[0].apiKey).toBe('ark-token')
  expect(ctorCalls[0].baseURL).toBe('https://ark.cn-beijing.volces.com/api/plan')

  // creds model flows into messages.create (NOT DISTILL_MODEL)
  expect(createCalls[0].model).toBe('deepseek-v4-flash[1m]')
  expect(createCalls[0].model).not.toBe(DISTILL_MODEL)
})

test('falls back to DISTILL_MODEL when creds have no model (official key path)', async () => {
  const callLLM = makeLLMCall({
    loadClaudeCreds: () => ({ apiKey: 'sk-official', source: 'env:apiKey' }),
  })
  await callLLM('sys', 'user')
  expect(createCalls[0].model).toBe(DISTILL_MODEL)
})

test('omits baseURL from constructor when creds have none', async () => {
  const callLLM = makeLLMCall({
    loadClaudeCreds: () => ({ apiKey: 'sk-official', source: 'env:apiKey' }),
  })
  await callLLM('sys', 'user')
  expect(ctorCalls[0].baseURL).toBeUndefined()
  expect('baseURL' in ctorCalls[0]).toBe(false)
})

test('uses creds model even when baseURL is absent (official key + model override)', async () => {
  const callLLM = makeLLMCall({
    loadClaudeCreds: () => ({ apiKey: 'sk-official', model: 'claude-sonnet-x', source: 'env:apiKey' }),
  })
  await callLLM('sys', 'user')
  expect(createCalls[0].model).toBe('claude-sonnet-x')
  expect(createCalls[0].model).not.toBe(DISTILL_MODEL)
  expect(ctorCalls[0].baseURL).toBeUndefined()
})

test('extracts joined text from content blocks', async () => {
  const callLLM = makeLLMCall({
    loadClaudeCreds: () => ({ apiKey: 'k', model: 'm', source: 'test' }),
  })
  const out = await callLLM('sys', 'user')
  expect(out).toBe('{"candidates":[]}')
})

test('throws when no creds are resolvable and never constructs a client', async () => {
  const callLLM = makeLLMCall({
    loadClaudeCreds: () => ({ apiKey: null, source: 'none' }),
  })
  expect(callLLM('sys', 'user')).rejects.toThrow(/no claude credentials/)
  expect(ctorCalls.length).toBe(0)
})

test('DEFAULT_LLM_MAX_TOKENS is 8192 (locks the 2048->8192 bump)', () => {
  expect(DEFAULT_LLM_MAX_TOKENS).toBe(8192)
})

test('makeLLMCall uses DEFAULT_LLM_MAX_TOKENS when opts omitted', async () => {
  const callLLM = makeLLMCall({
    loadClaudeCreds: () => ({ apiKey: 'k', model: 'm', source: 'test' }),
  })
  await callLLM('sys', 'user')
  expect(createCalls[0].max_tokens).toBe(DEFAULT_LLM_MAX_TOKENS)
  expect(createCalls[0].max_tokens).toBe(8192)
})

test('makeLLMCall honors opts.maxTokens override', async () => {
  const callLLM = makeLLMCall({
    loadClaudeCreds: () => ({ apiKey: 'k', model: 'm', source: 'test' }),
  })
  await callLLM('sys', 'user', { maxTokens: 512 })
  expect(createCalls[0].max_tokens).toBe(512)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/anthropic.test.ts`
Expected: FAIL，错误含 `makeLLMCall is not a function` 或 `does not provide an export named 'makeLLMCall'`（`src/anthropic.ts` 仍导出 `makeCallAnthropic`）。

- [ ] **Step 3: 写实现 -- 改 `src/anthropic.ts`**

将 `src/anthropic.ts` 整体替换为（`DISTILL_MODEL` docstring 保持不变；仅改 import、工厂名、返回函数名/参数/max_tokens）：

```ts
import Anthropic from '@anthropic-ai/sdk'
import { loadClaudeCreds, type ClaudeCreds } from './creds'
import { DEFAULT_LLM_MAX_TOKENS, type LLMCall, type LLMCallOpts } from './llm'

export interface AnthropicDeps {
  /** Injectable for tests; production uses the real `loadClaudeCreds`. */
  loadClaudeCreds?: () => ClaudeCreds
}

/**
 * Model id for distill calls.
 *
 * This is the **fallback** used when the user has not configured a haiku model.
 * The user's `ANTHROPIC_DEFAULT_HAIKU_MODEL` (or `ANTHROPIC_MODEL`) env var /
 * `~/.claude/settings.json` `env` value takes precedence via `loadClaudeCreds`
 * and is passed straight through to `messages.create`; `DISTILL_MODEL` only
 * applies when no such override is present (e.g. the official
 * `ANTHROPIC_API_KEY` path with no model env). When routing through a proxy
 * (Volcengine Ark) the resolved model is typically a non-Anthropic id like
 * `deepseek-v4-flash[1m]`, so honoring it is required for the call to land.
 *
 * Verification debt (Task 17 live-smoke): the reachability of this exact id
 * with the user's credential is not locked by these tests (they mock the SDK).
 * If the id shape is wrong, the unit tests stay green while the live daemon
 * 4xx's. Confirm against `https://docs.anthropic.com/en/docs/about-claude/models`
 * during the Task 17 manual smoke.
 */
export const DISTILL_MODEL = 'claude-haiku-4-5-20251001'

/**
 * Build the `callLLM(system, user, opts?)` seam the distiller / dedup consume.
 * Production wires the real `@anthropic-ai/sdk` client using `loadClaudeCreds`;
 * tests inject a mock `callLLM` directly (or `loadClaudeCreds` here).
 *
 * The resolved credentials drive three SDK inputs:
 *   - `apiKey`: the auth key (official `ANTHROPIC_API_KEY` or a proxy
 *     `ANTHROPIC_AUTH_TOKEN`).
 *   - `baseURL`: forwarded only when present, so a proxy (Ark) endpoint is used
 *     while the official API keeps its default.
 *   - `model`: the creds model when configured, otherwise `DISTILL_MODEL`.
 *
 * `max_tokens` defaults to `DEFAULT_LLM_MAX_TOKENS` (8192); override per call
 * via `opts.maxTokens`. Throws if no credential is resolvable - the distiller's
 * top-level try/catch degrades that to "no candidates this round" and records
 * `lastError` on the job, so a misconfigured daemon never crashes the loop.
 */
export function makeLLMCall(deps: AnthropicDeps = {}): LLMCall {
  const load = deps.loadClaudeCreds ?? loadClaudeCreds
  return async function callLLM(system: string, user: string, opts?: LLMCallOpts): Promise<string> {
    const creds = load()
    if (!creds.apiKey) {
      throw new Error('no claude credentials; run memside with ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN (+ ANTHROPIC_BASE_URL), or log in to claude code')
    }
    const client = new Anthropic({
      apiKey: creds.apiKey,
      ...(creds.baseURL ? { baseURL: creds.baseURL } : {}),
    })
    const msg = await client.messages.create({
      model: creds.model ?? DISTILL_MODEL,
      max_tokens: opts?.maxTokens ?? DEFAULT_LLM_MAX_TOKENS,
      system,
      messages: [{ role: 'user', content: user }],
    })
    // extract text from content blocks (TextBlock has type:'text' + text:string;
    // ToolUseBlock is silently dropped). The `ContentBlock` union doesn't narrow
    // through `.filter` without a type predicate, so narrow explicitly.
    const text = msg.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('')
    return text
  }
}
```

- [ ] **Step 4: 改 `src/daemon.ts` 的 import 名 + 2 处工厂调用（字段名 `callAnthropic` 暂不动，留 Task 3）**

`src/daemon.ts:10`：
```ts
// before
import { makeCallAnthropic } from '@/anthropic'
// after
import { makeLLMCall } from '@/anthropic'
```

`src/daemon.ts:60`（`runDistillOnce` 内）：
```ts
// before
  const callAnthropic = deps.callAnthropic ?? makeCallAnthropic({ loadClaudeCreds: deps.loadClaudeCreds ?? loadClaudeCreds })
// after
  const callAnthropic = deps.callAnthropic ?? makeLLMCall({ loadClaudeCreds: deps.loadClaudeCreds ?? loadClaudeCreds })
```

`src/daemon.ts:117`（`startDaemon` 内）：
```ts
// before
    callAnthropic: makeCallAnthropic(),
// after
    callAnthropic: makeLLMCall(),
```

> 说明：`makeLLMCall()` 返回 `LLMCall`（3 参，opts 可选），赋给 `tickDeps.callAnthropic`（`TickDeps['callAnthropic']` 现仍为 2 参类型）。`(a,b,c?) => ...` 可赋给 `(a,b) => ...`，typecheck 通过。字段名 `callAnthropic` 与局部变量 `callAnthropic` 在本任务保持不变，Task 3 统一改 `callLLM`。

- [ ] **Step 5: 运行测试 + typecheck 确认通过**

Run: `bun test tests/anthropic.test.ts`
Expected: PASS（9 pass：原 6 条 + 新 3 条）。

Run: `bun run typecheck`
Expected: 无错误（`src/daemon.ts` 已改 import + 调用；核心字段名未动，仍编译通过）。

Run: `bun test`
Expected: 全绿（全套，含未改名的核心测试仍用 `callAnthropic` 字段，与未改名的 `TickDeps` 一致）。

- [ ] **Step 6: Commit**

```bash
git add src/anthropic.ts src/daemon.ts tests/anthropic.test.ts
git commit -m "refactor(llm): makeLLMCall with opts.maxTokens (default 8192), rename impl seam

- src/anthropic.ts: makeCallAnthropic->makeLLMCall, returned fn callAnthropic->callLLM,
  add opts.maxTokens (default DEFAULT_LLM_MAX_TOKENS=8192, up from hardcoded 2048)
- tests/anthropic.test.ts: rename symbols + lock 8192 default + opts override
- src/daemon.ts: import + call sites makeCallAnthropic->makeLLMCall (field name deferred to next task)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: seam 字段 `callAnthropic` -> `callLLM` 全量改名（核心 + daemon + 5 测试）

**Files:**
- Modify: `src/memory/distiller.ts`
- Modify: `src/memory/dedup.ts`
- Modify: `src/scheduler.ts`
- Modify: `src/daemon.ts`
- Modify: `tests/distiller.test.ts`、`tests/dedup.test.ts`、`tests/scheduler.test.ts`、`tests/daemon.test.ts`、`tests/e2e.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `LLMCall`（核心 `import type`）；Task 2 的 `makeLLMCall`（daemon 已用）。
- Produces: 核心类型 `DistillInput.callLLM`、`DedupInput.callLLM`、`TickDeps.callLLM`（均为 `LLMCall`）；`runDistillOnce` deps `callLLM?: LLMCall`。从此核心类型不带 vendor 名。

> 本任务必须**原子提交**：seam 字段名在 `TickDeps`/`DistillInput`/`DedupInput` 与所有 mock 之间互相依赖，分文件改会导致中间态 typecheck 失败。所有改动在同一 commit。

- [ ] **Step 1: 改 `src/memory/distiller.ts`**

加 import（`src/memory/distiller.ts:1` 之后新增一行）：
```ts
import type { LLMCall } from '@/llm'
```

`DistillInput` 字段（`src/memory/distiller.ts:45`）：
```ts
// before
  callAnthropic: (systemPrompt: string, userPrompt: string) => Promise<string>
// after
  callLLM: LLMCall
```

调用（`src/memory/distiller.ts:62`）：
```ts
// before
    const raw = await input.callAnthropic(DISTILLER_SYSTEM_PROMPT, userPrompt)
// after
    const raw = await input.callLLM(DISTILLER_SYSTEM_PROMPT, userPrompt)
```

- [ ] **Step 2: 改 `src/memory/dedup.ts`**

加 import（`src/memory/dedup.ts:2` 之后新增一行）：
```ts
import type { LLMCall } from '@/llm'
```

`DedupInput` 字段（`src/memory/dedup.ts:15`）：
```ts
// before
  callAnthropic: (system: string, user: string) => Promise<string>
// after
  callLLM: LLMCall
```

调用（`src/memory/dedup.ts:51`）：
```ts
// before
    const raw = await input.callAnthropic(DEDUP_SYSTEM_PROMPT, renderUserPrompt(input.newCandidates, input.existing))
// after
    const raw = await input.callLLM(DEDUP_SYSTEM_PROMPT, renderUserPrompt(input.newCandidates, input.existing))
```

- [ ] **Step 3: 改 `src/scheduler.ts`**

加 import（`src/scheduler.ts:9` 之后新增一行）：
```ts
import type { LLMCall } from '@/llm'
```

`TickDeps` 字段（`src/scheduler.ts:38`）：
```ts
// before
  callAnthropic: (systemPrompt: string, userPrompt: string) => Promise<string>
// after
  callLLM: LLMCall
```

`dedupCandidates` 参数（`src/scheduler.ts:65`）：
```ts
// before
  callAnthropic: TickDeps['callAnthropic'],
// after
  callLLM: LLMCall,
```

`judgeDuplicates` 调用（`src/scheduler.ts:83`）：
```ts
// before
      callAnthropic,
// after
      callLLM,
```

`distillTranscript` 调用（`src/scheduler.ts:122`）：
```ts
// before
        callAnthropic: deps.callAnthropic,
// after
        callLLM: deps.callLLM,
```

`dedupCandidates` 调用（`src/scheduler.ts:129`）：
```ts
// before
      const keep = await dedupCandidates(db, deps.callAnthropic, candidates, job.cwd ?? null)
// after
      const keep = await dedupCandidates(db, deps.callLLM, candidates, job.cwd ?? null)
```

- [ ] **Step 4: 改 `src/daemon.ts`（字段名 + 类型 + 局部变量）**

加 import（`src/daemon.ts:10` 附近新增一行）：
```ts
import type { LLMCall } from '@/llm'
```

`runDistillOnce` deps 类型 + 局部变量 + tickDeps 字段（`src/daemon.ts:57-63`）：
```ts
// before
    callAnthropic?: (systemPrompt: string, userPrompt: string) => Promise<string>
  } = {},
): Promise<number> {
  const callAnthropic = deps.callAnthropic ?? makeLLMCall({ loadClaudeCreds: deps.loadClaudeCreds ?? loadClaudeCreds })
  const tickDeps: TickDeps = {
    loadTranscript: makeLoadTranscript(db),
    callAnthropic,
    createCandidate,
  }
// after
    callLLM?: LLMCall
  } = {},
): Promise<number> {
  const callLLM = deps.callLLM ?? makeLLMCall({ loadClaudeCreds: deps.loadClaudeCreds ?? loadClaudeCreds })
  const tickDeps: TickDeps = {
    loadTranscript: makeLoadTranscript(db),
    callLLM,
    createCandidate,
  }
```

`startDaemon` tickDeps 字段（`src/daemon.ts:117`）：
```ts
// before
    callAnthropic: makeLLMCall(),
// after
    callLLM: makeLLMCall(),
```

（`src/daemon.ts` 顶部注释 `daemon.ts:46/50/94` 提到 `callAnthropic`/`makeCallAnthropic` 的，一并改 `callLLM`/`makeLLMCall` 以保持一致。）

- [ ] **Step 5: 改 5 个测试文件的 mock 字段 `callAnthropic:` -> `callLLM:`**

机械替换：把传入 `distillTranscript` / `judgeDuplicates` / `tick` / `runDistillOnce` 的 mock 对象属性键 `callAnthropic:` 改为 `callLLM:`。文件与站点数（grep 验证）：

| 文件 | mock 字段站点数 | 行号（近似） |
|------|----------------|-------------|
| `tests/distiller.test.ts` | 3 | 24, 35, 44 |
| `tests/dedup.test.ts` | 10 | 16, 24, 32, 40, 48, 56, 65, 75, 85, 94 |
| `tests/scheduler.test.ts` | 7 | 57, 75, 90, 108, 127, 146, 162 |
| `tests/daemon.test.ts` | 1 | 58 |
| `tests/e2e.test.ts` | 1 | 115 |

示例（`tests/distiller.test.ts:24`）：
```ts
// before
    callAnthropic: async () => JSON.stringify(fakeResponse),
// after
    callLLM: async () => JSON.stringify(fakeResponse),
```

> 这些 mock 都是 `async () => ...` 忽略入参，新增的可选第 3 参 `opts` 不影响。同时把注释里出现的 `callAnthropic` 改 `callLLM`（`tests/daemon.test.ts:38,43`、`tests/e2e.test.ts:66,103,105`、`tests/scheduler.test.ts:177`）。

- [ ] **Step 6: 运行 typecheck + 全套测试确认通过**

Run: `bun run typecheck`
Expected: 无错误（所有 seam 字段名一致：核心类型 + daemon + mock 全为 `callLLM`）。

Run: `bun test`
Expected: 全绿（100+ pass，与基线一致；本任务零行为变更，仅改名 + 类型来源切换）。

- [ ] **Step 7: Commit**

```bash
git add src/memory/distiller.ts src/memory/dedup.ts src/scheduler.ts src/daemon.ts \
        tests/distiller.test.ts tests/dedup.test.ts tests/scheduler.test.ts tests/daemon.test.ts tests/e2e.test.ts
git commit -m "refactor(llm): rename seam field callAnthropic->callLLM across core + tests

Core types (DistillInput/DedupInput/TickDeps) now use callLLM: LLMCall from the
SDK-free @/llm contract; daemon wires makeLLMCall() as callLLM; ~22 test mock
sites renamed. Zero behavior change (max_tokens already 8192 from prior task).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review（plan 作者自检，已完成）

1. **Spec 覆盖**：G1（单一 `LLMCall` 类型）-> Task 1 + Task 3；G2（vendor-neutral 名 `callLLM`）-> Task 2（impl）+ Task 3（core）；G3（`max_tokens` 可配，默认 8192）-> Task 1（常量）+ Task 2（opts + 默认 + 测试）；G4（契约 SDK-free）-> Task 1；G5（仅 2048->8192 行为变更）-> Task 2 + Task 3 零行为变更。§5 接口契约逐条落到 Task 1/2/3 代码块。§9 测试策略逐条落（anthropic.test.ts 改名+扩展、llm.test.ts 新建、5 文件 mock 改名）。§11 文件清单一致（已按 keep+new 修正 spec）。无遗漏。
2. **占位符扫描**：无 TBD/TODO；每个代码 step 均含完整代码。
3. **类型一致性**：`LLMCall` / `LLMCallOpts` / `DEFAULT_LLM_MAX_TOKENS`（Task 1 定义）在 Task 2/3 引用名一致；`makeLLMCall`（Task 2 定义）在 Task 3 daemon 引用一致；字段名 `callLLM` 跨 Task 3 全部站点一致。Task 2 中间态字段名保持 `callAnthropic`、Task 3 统一改 `callLLM`，已显式标注。
4. **绿提交链**：Task 1（独立）-> Task 2（impl 改名 + daemon import 改名，字段名不动，typecheck 过）-> Task 3（字段名全量改名，原子）。每任务末尾 `bun run typecheck && bun test` 全绿。

## 落地流程（CLAUDE.md）

1. 已切 `refactor/llm-seam-cleanup`（基线 `4e52cee`，spec `7bc73fe`）。
2. 本 plan 落档 + commit（含 spec §9/§11 test-file 组织微调）。
3. 清理 `.superpowers/sdd/`（CLAUDE.md 强制：spec + plan 落档后、写代码前）。
4. 按计划执行 Task 1 -> 2 -> 3，每任务 `bun run typecheck && bun test` 全绿。
5. push -> PR 合 `master`。
