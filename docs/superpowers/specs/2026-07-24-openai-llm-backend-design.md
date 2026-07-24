# OpenAI 格式 LLM 后端 - 设计 spec

- 日期：2026-07-24
- 状态：Draft
- 分支：`feat/openai-llm-backend`（从 `origin/master` `a7dc93a` 切；基线含 LLMCall 契约 + callWithRetry 三道防线）
- 相关：`docs/superpowers/specs/2026-07-23-llm-seam-cleanup-design.md`（LLM seam 抽象清理，建立了 SDK-free 的 `LLMCall` 契约，其 N2 显式把"provider-swap"列为 YAGNI 推迟--本 spec 补这个被推迟项）

## 1. 背景与动机

memside 的 distill/dedup/valueFilter 经 `callWithRetry` 调 `callLLM: LLMCall` seam 消费 LLM。当前唯一实现是 `src/anthropic.ts` 的 `makeLLMCall`（`@anthropic-ai/sdk` + `loadClaudeCreds`），在组合根 `src/daemon.ts` 装配。`LLMCall` 契约（`src/llm.ts`）已 SDK-free、vendor-neutral--核心模块 `import type { LLMCall }`，物理上碰不到 SDK。

**新场景：公司内部 `codeagent`（基于 claude code，hooks 可用，仅路径/命名不一致）环境下，Anthropic 凭证被隐藏，员工只能用 codeagent；但部门另部署了 OpenAI 格式（`/chat/completions` 兼容）的内部大模型 API 供 memside 这类 sidecar 使用。** memside 需能在"只有 OpenAI API、无 Anthropic 凭证"的机器上跑 distill。

**已实验验证的关键结论**（隔离工作区 `scratch/codeagent-bridge/` 下 4 组对照实验 + Q1/Q2 追加）：

1. **seam 与格式无关**。`LLMCall = (system, user, opts?) => Promise<string>` 只认"给 system+user、拿回文字"；Anthropic vs OpenAI 只是电线格式不同，在 seam 处做翻译即可，核心模块零改动。
2. **干净直连避开了 CLI 壳子漂移**。对照实验：同一模型 deepseek，走 API 直连 9/9 完美遵从 distiller 格式；走 `claude -p` CLI（带 claude 自己的 ~2200 token 系统指令壳子）0/8 全废、加固后 8/9。根因是 CLI 壳子扰动模型生成，与 Anthropic/OpenAI 协议无关。**OpenAI 直连也是干净直连**（只发 system+user），故能拿到与 Anthropic API 同档的干净准确率。
3. **`--bare`/提示词加固到顶仍追不上 API**；`--json-schema` 在非 Claude 后端不强制；Write 工具文件输出在 `-p` 非交互模式被权限卡死。结论：提示词/输出模式技巧补不上 CLI 与 API 的差距，而 OpenAI 直连天然是 API 路径，无需这些兜底。

因此本需求不走 CLI 桥接，而是**新增一个 OpenAI 格式的 `LLMCall` 实现**，在组合根按配置选择后端。这是 LLM-seam-cleanup spec 当初显式推迟（N2）的 provider-swap，现在有了真实消费方。

## 2. 目标

- **G1**：新增 `src/openai.ts`，导出 `makeLLMCall(deps): LLMCall`（fetch 直连 `/chat/completions`，Bearer 鉴权，system+user 消息，取 `choices[0].message.content`）与 `loadOpenAiCreds()`；不加 `openai` npm 依赖（用内置 `fetch`）。
- **G2**：组合根按**混合规则**选后端--显式 `MEMSIDE_LLM_BACKEND=anthropic|openai` 覆盖；未设时有 `OPENAI_API_KEY` 用 openai，否则 anthropic。选择逻辑为 SDK-free 纯函数 `resolveLLMBackend(env)`，放 `src/llm.ts`，单测易写。
- **G3**：OpenAI 凭证只读 env（`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`）。`OPENAI_MODEL` 必配（无默认）。
- **G4**：核心模块（distiller/dedup/valueFilter/scheduler/retry）**零改动**；契约 `LLMCall` 不变。
- **G5**：失败语义对齐 Anthropic 实现--无凭据抛错、HTTP/网络/超时/响应异常抛错，全经既有 `callWithRetry` + 各层降级，不引入新失败模式。
- **G6**：`max_tokens` 用 `opts?.maxTokens ?? DEFAULT_LLM_MAX_TOKENS`（8192），与 Anthropic 实现一致。

## 3. 非目标

- **N1**：不用 OpenAI `response_format`（json_object / json_schema）强制 JSON--现有 `extractJsonObject` + `callWithRetry` 已兜底，YAGNI。
- **N2**：不做流式--distill 异步 fire-and-forget，非流式够用。
- **N3**：不做 OpenAI 专属限流/退避（429 等）--`callWithRetry` 重试 + scheduler job 退避已覆盖。
- **N4**：不做 per-call 调参（继承 LLM-seam spec N1）。
- **N5**：不读 `~/.claude/settings.json` 取 OpenAI 凭证--OpenAI 凭证不被 claude code 自动写入该文件，env 足矣。
- **N6**：不含 codeagent hooks 路径/命名适配--那是独立文档事项（README 另行），本 spec 只做 LLM 后端。
- **N7**：不做通用多 provider 抽象（`LLMProvider` 接口 / 配置驱动通用 HTTP caller）--只有第二个后端，YAGNI；`openai.ts` 与 `anthropic.ts` 对称即可。

## 4. 关键决策

| # | 决策点 | 选择 | 理由 |
|---|--------|------|------|
| 1 | OpenAI 实现 | 新建 `src/openai.ts`，`makeLLMCall` 返回 `LLMCall` | 与 `anthropic.ts` 对称；vendor 名留在实现层；契约 `LLMCall` 不动 |
| 2 | HTTP 客户端 | 内置 `fetch`，不加 `openai` SDK | 零新依赖；OpenAI chat completions 协议简单；Bun 自带 fetch |
| 3 | 凭证来源 | 只读 env（`OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_MODEL`） | 用户明确选择；OpenAI 凭证无标准写入位置；env 最简且跨平台 |
| 4 | `OPENAI_MODEL` | 必配，缺则抛错 | OpenAI 模型名各异无通用默认；对齐 Anthropic 无凭据抛错语义 |
| 5 | 后端选择 | 混合：显式 `MEMSIDE_LLM_BACKEND` 覆盖；未设时按 `OPENAI_API_KEY` 存在性探测 | 两环境零配置就绪 + 显式覆盖解歧义；用户确认 |
| 6 | 选择逻辑归属 | SDK-free 纯函数 `resolveLLMBackend(env)` 放 `src/llm.ts` | 纯函数单测极易；vendor-neutral 逻辑与契约同住；daemon 保持薄 |
| 7 | 未识别 `MEMSIDE_LLM_BACKEND` 值 | 抛错（防拼错静默回退） | 配置 typo 应显式失败，不静默走 anthropic |
| 8 | 超时 | `AbortController` 120s（可由 `OpenAiDeps.timeoutMs` 覆盖） | 避免单次 fetch 挂死阻塞 tick；对齐"网络错误抛错->重试降级" |
| 9 | `max_tokens` | `opts?.maxTokens ?? DEFAULT_LLM_MAX_TOKENS`（8192） | 与 Anthropic 实现一致；契约层默认值贯通 |
| 10 | 流式 / `response_format` | 不做 | N1/N2 |

## 5. 接口契约

### 5.1 `src/llm.ts`（SDK-free，扩一个纯函数）

既有 `LLMCall` / `LLMCallOpts` / `DEFAULT_LLM_MAX_TOKENS` 不变。新增：

```ts
export type LLMBackend = 'anthropic' | 'openai'

/**
 * 混合后端选择：显式 `MEMSIDE_LLM_BACKEND=anthropic|openai` 覆盖；未设（或空）
 * 时按 `OPENAI_API_KEY` 存在性探测--有则 openai，无则 anthropic。未识别的非空
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

### 5.2 `src/openai.ts`（新，OpenAI 实现）

```ts
import { DEFAULT_LLM_MAX_TOKENS, type LLMCall, type LLMCallOpts } from './llm'

export interface OpenAiCreds {
  apiKey: string
  baseURL: string   // 不含尾斜杠；chat/completions 拼在后面
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
 * `OPENAI_BASE_URL` 缺省 `https://api.openai.com/v1`。
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

### 5.3 `src/daemon.ts`（组合根，薄改造）

新增 import 与一个装配函数；`startDaemon` / `runDistillOnce` 把原 `makeLLMCall()`（来自 `@/anthropic`）替换为 `resolveCallLLM()`：

```ts
import { makeLLMCall as makeAnthropicCall } from '@/anthropic'
import { makeLLMCall as makeOpenAiCall } from '@/openai'
import { resolveLLMBackend, type LLMCall } from '@/llm'   // LLMCall 已 import，合并

/** 按 resolveLLMBackend 选后端，装配对应 makeLLMCall 为 callLLM。 */
function resolveCallLLM(): LLMCall {
  return resolveLLMBackend(process.env) === 'openai' ? makeOpenAiCall() : makeAnthropicCall()
}
```

- `runDistillOnce`：`const callLLM = deps.callLLM ?? resolveCallLLM()`（原为 `makeLLMCall({ loadClaudeCreds: ... })`）；测试仍可注入 `callLLM` / `loadClaudeCreds` 不变。
- `startDaemon`：`tickDeps.callLLM = resolveCallLLM()`（原为 `makeLLMCall()`）。
- `runDistillOnce` 的 `loadClaudeCreds` 注入保留（Anthropic 路径测试用）；OpenAI 路径测试走 `callLLM` 注入或 `loadOpenAiCreds` 注入。

### 5.4 数据模型

**零变更。** 不动 schema、不动 `creds.ts`、不动 store / pure / adapter / install / cli。

## 6. 数据流

seam 实现来源由"恒 Anthropic"变为"由 `resolveLLMBackend` 决定"，其余不变。tick 三阶段经 `callWithRetry` 2 参调 `callLLM`，8192 默认 `max_tokens` 贯通：

```
hook(Stop) -> events -> job(pending)
tick:
  loadTranscript(job) -> turns
  distillTranscript({ turns, callLLM })  -> callWithRetry -> callLLM(默认 8192) -> candidates
  judgeValue(candidates, deps.callLLM)   -> callWithRetry -> callLLM(默认 8192) -> valueVerdicts
  dedupCandidates(db, deps.callLLM, ...) -> judgeDuplicates({ callLLM }) -> callWithRetry -> callLLM -> verdicts
  keep -> createCandidate(valueClass) -> memories(candidate)
  job -> done

callLLM 的实现 = resolveLLMBackend(process.env) === 'openai'
  ? makeOpenAiCall()  // fetch /chat/completions, system+user messages, choices[0].message.content
  : makeAnthropicCall()  // @anthropic-ai/sdk + loadClaudeCreds（不变）

注入（不变）：SessionStart -> listApprovedByScope -> formatMemoryBlock
```

OpenAI 实现把 `(system, user)` 映射成两条 message；返回的文本对 distiller 而言与 Anthropic 返回无差别（`extractJsonObject` + `JSON.parse` + `distillShouldRetry` 照常工作）。

## 7. 与现有模块的耦合点

- **`LLMCall` 契约**（`src/llm.ts`）：不变；新增 `LLMBackend` 类型 + `resolveLLMBackend` 纯函数（SDK-free，不 import 实现）。
- **`src/anthropic.ts`**：**不动**。`makeLLMCall` / `DISTILL_MODEL` / `AnthropicDeps` 保留。
- **`src/openai.ts`**：新文件，与 `anthropic.ts` 对称（`makeLLMCall` + `loadOpenAiCreds` + `OpenAiDeps`）。
- **`src/daemon.ts`**：组合根加 `resolveCallLLM()`；`startDaemon` / `runDistillOnce` 装配点改用它；import 增加 `@/openai` + `resolveLLMBackend`。
- **`distiller` / `dedup` / `valueFilter` / `scheduler` / `retry`**：**零改动**（仍 `callLLM: LLMCall`）。
- **`creds.ts`**：不动（仅 Anthropic 路径用）。
- **依赖方向**：`daemon.ts -> @/anthropic | @/openai (实现) -> ./llm (契约, SDK-free)`；核心 `-> @/llm`。`@/openai` 不 import SDK，只 import `./llm` 契约 + 用内置 fetch。

## 8. 失败模式

| 场景 | 行为 |
|------|------|
| 无 `OPENAI_API_KEY`（且后端选到 openai） | `loadOpenAiCreds` 返回 null -> `makeLLMCall` 抛 "no OpenAI credentials" -> `callWithRetry` 重试耗尽 -> distiller 返回 `[]` / dedup 全 `duplicate:false` / valueFilter 全 keep+null；job 记 `lastError` |
| `OPENAI_API_KEY` 有、`OPENAI_MODEL` 缺 | `loadOpenAiCreds` 抛 "OPENAI_MODEL missing" -> 同上降级 |
| HTTP 401/403（key 错） | 抛 `OpenAI HTTP 401: ...` -> 重试耗尽降级 |
| HTTP 429 / 5xx | 抛 `OpenAI HTTP <status>` -> `callWithRetry` 重试；job 层退避 |
| 网络 / 超时（120s AbortController） | `AbortError` 抛出 -> 重试降级 |
| 响应缺 `choices[0].message.content` | 抛 "missing choices[0].message.content" -> 重试降级 |
| `MEMSIDE_LLM_BACKEND` 未识别值 | `resolveLLMBackend` 抛 "unknown MEMSIDE_LLM_BACKEND" -> daemon 启动即失败（显式配置错误，不静默） |
| 后端选 anthropic 但无 Anthropic 凭证 | 走原 `makeLLMCall`(anthropic) 抛 "no claude credentials" -> 降级（不变） |

**原则**：不引入新失败模式。OpenAI 实现的所有异常都抛 `Error`，交由既有 `callWithRetry`（重试 + 错误反馈）+ 各层 catch 降级 + scheduler job 退避。`MEMSIDE_LLM_BACKEND` 配置错是唯一"启动即失败"的新增点（显式优于静默）。

## 9. 测试策略

纯新增 + 一处组合根改造，无 UI。首选可断言面（`makeLLMCall` 经 mock fetch 直接断言请求形状；`resolveLLMBackend` 是纯函数）。

- **`tests/openai.test.ts`（新）**：mock global `fetch`（`globalThis.fetch = mock`），注入 `loadOpenAiCreds` 返回固定 creds。断言：
  1. 请求 URL = `${baseURL}/chat/completions`、`Authorization: Bearer <key>`、`Content-Type: application/json`。
  2. body 含 `model`、`messages: [system, user]`、`max_tokens` 默认 `DEFAULT_LLM_MAX_TOKENS`（=== 8192）。
  3. `opts.maxTokens` 透传（如 `{maxTokens:512}` -> body.max_tokens === 512）。
  4. 响应 `choices[0].message.content` 正确抽取（含多 choice 时取 `[0]`）。
  5. `loadOpenAiCreds` 返回 null -> 抛 "no OpenAI credentials"。
  6. `loadOpenAiCreds` 抛（model 缺）-> `makeLLMCall` 抛错。
  7. `resp.ok === false`（如 401）-> 抛 `OpenAI HTTP 401`。
  8. 响应缺 content -> 抛 "missing choices[0].message.content"。
  9. 超时：`timeoutMs` 极小 + fetch 不返回 -> 抛 AbortError（用 fake/可控 fetch）。
- **`tests/llm.test.ts`（扩）**：加 `resolveLLMBackend` 用例锁混合规则：
  - `{MEMSIDE_LLM_BACKEND:'openai'}` -> 'openai'（不论 key）。
  - `{MEMSIDE_LLM_BACKEND:'anthropic'}` -> 'anthropic'（即使有 OPENAI_API_KEY）。
  - `{}`（空）-> 'anthropic'。
  - `{OPENAI_API_KEY:'x'}`（无 explicit）-> 'openai'。
  - `{MEMSIDE_LLM_BACKEND:'', OPENAI_API_KEY:'x'}`（空字符串=未设）-> 'openai'。
  - `{MEMSIDE_LLM_BACKEND:'foo'}` -> 抛 "unknown MEMSIDE_LLM_BACKEND"。
  - 保留既有 `DEFAULT_LLM_MAX_TOKENS === 8192` 用例。
- **`tests/creds.test.ts` / `tests/anthropic.test.ts`**：无改动。
- **`tests/daemon.test.ts` / `tests/distiller.test.ts` / `tests/dedup.test.ts` / `tests/scheduler.test.ts` / `tests/e2e.test.ts`**：无改动（核心零改动；`runDistillOnce` 测试注入 mock `callLLM`，不经 `resolveCallLLM`）。若 `daemon.test.ts` 有断言"默认用 Anthropic"，加一条用例：`MEMSIDE_LLM_BACKEND=openai` + mock `@/openai` 时 `resolveCallLLM` 走 openai（可选，视现有测试结构）。
- **运行门槛**：`bun run typecheck && bun test` 全绿才能 push。

## 10. 落地流程（CLAUDE.md）

1. 已切 `feat/openai-llm-backend`，从 `origin/master` `a7dc93a`。
2. spec 落档 + commit（本文件）。
3. 调用 `writing-plans` skill 产出 `docs/superpowers/plans/2026-07-24-openai-llm-backend.md`。
4. 清理 `.superpowers/sdd/`（CLAUDE.md 强制：spec + plan 两份落档后、写代码前，删该目录下所有文件）。
5. 按计划实现 + 测试，`bun run typecheck && bun test` 全绿。
6. push -> PR 合 `master`。

## 11. 涉及文件

- 新增：`src/openai.ts`、`tests/openai.test.ts`
- 改：`src/llm.ts`（加 `LLMBackend` + `resolveLLMBackend`）、`src/daemon.ts`（`resolveCallLLM` + 装配点 + import）、`tests/llm.test.ts`（加 `resolveLLMBackend` 用例）
- 不动：`src/anthropic.ts`、`src/creds.ts`、`src/memory/*`、`src/scheduler.ts`、`src/db/*`、`src/server.ts`、`src/adapter/*`、`src/install.ts`、`src/cli.ts`、其余测试
- 落档：本 spec + `docs/superpowers/plans/2026-07-24-openai-llm-backend.md`
