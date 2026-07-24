# LLM 调用 seam 抽象清理 - 设计 spec

- 日期：2026-07-23
- 状态：Draft
- 分支：`refactor/llm-seam-cleanup`（基线 `origin/master` `4e52cee`）
- 相关：`docs/superpowers/specs/2026-07-21-memside-design.md`（总体设计）、`docs/superpowers/specs/2026-07-23-candidate-dedup-design.md`（dedup 同样走 `callAnthropic` seam）

## 1. 背景与动机

对 memside 架构的审计结论：**核心功能与 AI 调用层在结构上已经解耦**——`@anthropic-ai/sdk` 只被 `src/anthropic.ts:1` import，凭据层 `creds.ts` 只被 `src/anthropic.ts:2`（实现）与 `src/daemon.ts:11`（组合根）引用，核心模块（`distiller` / `dedup` / `scheduler`）通过依赖注入的 `callAnthropic` seam 消费 AI 能力，**不 import SDK、不 import `anthropic.ts`、不 import `creds.ts`**。测试印证：所有核心测试注入 mock `callAnthropic`，从不触网。

但解耦的**抽象卫生**有 4 处债务，本 spec 做清理（纯重构 + 一处行为微调）：

1. **seam 契约重复定义 4 次。** `(systemPrompt: string, userPrompt: string) => Promise<string>` 作为内联类型字面量分别写在 `src/memory/distiller.ts:45`（`DistillInput`）、`src/memory/dedup.ts:15`（`DedupInput`）、`src/scheduler.ts:38`（`TickDeps`）、`src/daemon.ts:57`（`runDistillOnce` deps）。没有单一命名类型拥有该契约；契约演进需 4 处同步改，易漂移。
2. **vendor 名泄漏进核心抽象。** seam 在核心类型里就叫 `callAnthropic`（上述 4 处 + `src/anthropic.ts:48` 的返回函数名）。核心本不该知道后端是 Anthropic——名字把具体 provider 写进了核心的接口声明。
3. **`max_tokens` 硬编码且过小。** `src/anthropic.ts:59` 写死 `max_tokens: 2048`，distill 与 dedup 共用一份全局值，seam 形状 `(system, user) => string` 表达不了 per-call 覆盖。且 2048 对 distill（多条候选、每条 bodyMd ≤400 字）偏小，会被截断。
4. **seam 契约无归属模块。** `anthropic.ts` 拥有*实现*但不拥有*接口*；契约散落在 4 个消费方。没有 SDK-free 的契约模块让"核心不依赖 SDK"成为结构保证，而非靠大家自觉用 `import type`。

## 2. 目标

- **G1**：抽出单一命名类型 `LLMCall`，替换 4 处内联字面量；契约演进只改一处。
- **G2**：seam 改 vendor-neutral 名（`callAnthropic` -> `callLLM`），核心类型与 import 路径不再带 vendor 名。
- **G3**：`max_tokens` 可配——seam 增加可选 `opts.maxTokens`，默认 `DEFAULT_LLM_MAX_TOKENS = 8192`（修正 2048 偏小）。
- **G4**：契约模块 `src/llm.ts` **SDK-free**（不 import `@anthropic-ai/sdk`）；SDK 仍只存在于实现文件 `src/anthropic.ts`。核心 `import type { LLMCall } from '@/llm'` 物理上碰不到 SDK。
- **G5**：除 `max_tokens` 默认值 2048 -> 8192 外，**零运行时行为变更**。

## 3. 非目标

- **N1**：不做 per-call-site 调参。distill 与 dedup 都走 8192 默认，不传 `opts`（"可配"是结构性能力，当前无消费方）。
- **N2**：不做 provider-swap 抽象（不引入 OpenAI adapter / 多后端选择 / `LLMProvider` 接口）。YAGNI——memside 硬绑 claude code 凭据。
- **N3**：不动 `creds.ts`（凭据解析已在正确边界：只被实现 + 组合根引用）。
- **N4**：不改 `distillTranscript` / `judgeDuplicates` 的 prompt 与判定逻辑；不改 distiller/dedup 的失败降级语义。
- **N5**：不加 `maxTokens` 校验（0 / 负数 / 超限）。当前无调用方传 `opts`，非法值由 Anthropic SDK 拒绝、被既有 try/catch 降级，YAGNI。
- **N6**：不重命名 / 不迁移 `creds.ts`，不删 `distillAction` 列等历史债（不在本 spec）。

## 4. 关键决策

| # | 决策点 | 选择 | 理由 |
|---|--------|------|------|
| 1 | 契约归属 | 新建 SDK-free `src/llm.ts` 拥有 `LLMCall` 类型 | 让"核心不依赖 SDK"成为结构保证而非约定；契约演进单点；直接服务解耦诉求 |
| 2 | 实现文件 | 保留 `src/anthropic.ts` 作为 Anthropic 实现 | 文件名诚实地标注"这是 Anthropic 的实现"；vendor 名留在实现层（该出现的地方），不进核心 |
| 3 | seam 命名 | `callAnthropic` -> `callLLM`；工厂 `makeCallAnthropic` -> `makeLLMCall` | vendor-neutral；与契约类型 `LLMCall` 一致；核心 import 路径变 `@/llm` |
| 4 | max_tokens 形态 | seam 加可选 `opts?: { maxTokens?: number }`，默认 `DEFAULT_LLM_MAX_TOKENS = 8192` | per-call 可配（结构性能力）+ 修正 2048 偏小；缺省安全（`opts?.maxTokens ?? DEFAULT`） |
| 5 | 默认值归属 | `DEFAULT_LLM_MAX_TOKENS` 放 SDK-free 的 `src/llm.ts` | 它是契约 `opts.maxTokens` 的缺省语义，属契约层；实现引用它 |
| 6 | 行为变更 | 仅 `max_tokens` 2048 -> 8192 | 用户明确要求 8192；其余纯重构零行为变更 |
| 7 | 参数命名 | 契约统一 `(system, user, opts?)`（取代 `(systemPrompt, userPrompt)` / `(system, user)` 混用） | 契约单一名；dedup 已是 `(system, user)`，distiller/scheduler 跟齐 |

## 5. 接口契约

### 5.1 新模块 `src/llm.ts`（SDK-free）

```ts
/** 单次 LLM 调用的可选参数。 */
export interface LLMCallOpts {
  /** 输出 token 上限；缺省时实现用 DEFAULT_LLM_MAX_TOKENS。 */
  maxTokens?: number
}

/**
 * vendor-neutral 的 LLM 调用 seam。核心记忆模块（distiller / dedup / scheduler）
 * 依赖此类型，而非任何具体 provider。实现（src/anthropic.ts）只在组合根
 * （daemon.ts）装配；测试注入 mock。返回模型响应的拼接文本。
 */
export type LLMCall = (system: string, user: string, opts?: LLMCallOpts) => Promise<string>

/** opts.maxTokens 缺省时的默认 max_tokens。 */
export const DEFAULT_LLM_MAX_TOKENS = 8192
```

- 该文件**不 import** `@anthropic-ai/sdk`、不 import `./creds`。核心 `import type { LLMCall }` 由此引入，编译期擦除，运行时零 SDK 依赖。

### 5.2 实现 `src/anthropic.ts`（保留，改造）

```ts
import Anthropic from '@anthropic-ai/sdk'
import { loadClaudeCreds, type ClaudeCreds } from './creds'
import { DEFAULT_LLM_MAX_TOKENS, type LLMCall, type LLMCallOpts } from './llm'

export interface AnthropicDeps {
  loadClaudeCreds?: () => ClaudeCreds
}

export const DISTILL_MODEL = 'claude-haiku-4-5-20251001'  // 不变：无 creds.model 时的 fallback

/** 构造由 @anthropic-ai/sdk + loadClaudeCreds 支撑的 LLMCall seam。 */
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
    const text = msg.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('')
    return text
  }
}
```

- 与现状 diff：`makeCallAnthropic` -> `makeLLMCall`；返回函数 `callAnthropic` -> `callLLM`；参数 `(systemPrompt, userPrompt)` -> `(system, user, opts?)`；`max_tokens: 2048` -> `opts?.maxTokens ?? DEFAULT_LLM_MAX_TOKENS`；新增 `import { DEFAULT_LLM_MAX_TOKENS, type LLMCall, type LLMCallOpts } from './llm'`。其余（creds 解析、baseURL 透传、text block 抽取、无凭据抛错）不变。

### 5.3 核心模块改名 + 引用契约类型

- **`src/memory/distiller.ts`**：`DistillInput.callAnthropic: (systemPrompt, userPrompt) => Promise<string>` -> `callLLM: LLMCall`（`import type { LLMCall } from '@/llm'`）；`distiller.ts:62` 调用 `input.callAnthropic(...)` -> `input.callLLM(...)`，**不传 opts**（走默认 8192）。
- **`src/memory/dedup.ts`**：`DedupInput.callAnthropic` -> `callLLM: LLMCall`；`dedup.ts:51` `input.callAnthropic(...)` -> `input.callLLM(...)`，不传 opts。
- **`src/scheduler.ts`**：`TickDeps.callAnthropic` -> `callLLM: LLMCall`；`dedupCandidates(db, callAnthropic: TickDeps['callAnthropic'], ...)` -> `dedupCandidates(db, callLLM: LLMCall, ...)`；`scheduler.ts:83/122/129` 透传 `deps.callLLM`。`distillTranscript({ ..., callAnthropic: deps.callAnthropic })` -> `callLLM: deps.callLLM`。
- **`src/daemon.ts`**：`runDistillOnce` deps 类型 `callAnthropic?: (...) => Promise<string>` -> `callLLM?: LLMCall`；`daemon.ts:60` `makeCallAnthropic(...)` -> `makeLLMCall(...)`，局部变量 `callAnthropic` -> `callLLM`；`daemon.ts:63` tickDeps 字段 `callAnthropic` -> `callLLM`；`daemon.ts:117` `startDaemon` 的 `callAnthropic: makeCallAnthropic()` -> `callLLM: makeLLMCall()`。import 由 `import { makeCallAnthropic } from '@/anthropic'` 改为 `import { makeLLMCall } from '@/anthropic'` + `import type { LLMCall } from '@/llm'`。

### 5.4 数据模型

**零变更。** 不动 schema、不动 `creds.ts`、不动 store / pure / adapter。

## 6. 数据流

不变，仅 seam 名 + `max_tokens` 默认值变：

```
hook(Stop) -> events -> job(pending)
tick:
  loadTranscript(job) -> turns
  distillTranscript({ turns, callLLM }) -> LLM(默认 max_tokens=8192) -> candidates   [改名]
  dedupCandidates(db, callLLM, candidates) -> judgeDuplicates({ callLLM }) -> LLM(默认 8192) -> verdicts   [改名]
  keep -> createCandidate -> memories(candidate)
  job -> done
注入（不变）：SessionStart -> listApprovedByScope -> formatMemoryBlock
```

distill 与 dedup 都不传 `opts`，共用 8192 默认。**唯一运行时行为变更：每次 LLM 调用 `max_tokens` 2048 -> 8192。**

## 7. 与现有模块的耦合点

- **`distillTranscript` / `DistillCandidate`**（`distiller.ts`）：仅 seam 字段名 + 类型来源变；prompt、JSON 解析、失败降级（`distiller.ts:88` catch -> 返回 `[]`）不变。
- **`judgeDuplicates`**（`dedup.ts`）：仅 seam 字段名 + 类型来源变；保守降级（`dedup.ts:70` catch -> 全 `duplicate:false`）不变。
- **`tick` / `TickDeps`**（`scheduler.ts`）：`TickDeps.callLLM` 透传给 distiller 与 dedup，模式不变；退避重试、pending-only select 不变。
- **`makeLLMCall` / `DISTILL_MODEL` / `AnthropicDeps`**（`anthropic.ts`）：工厂改名 + 加 opts；`DISTILL_MODEL` / `AnthropicDeps` 保留（实现关注点）。`creds.ts` 接口不变。
- **`daemon.ts` 组合根**：装配 `makeLLMCall()` 为 `callLLM` 注入 `TickDeps`；`runDistillOnce` 测试 seam 同步改名。
- **依赖方向**：`daemon.ts -> @/anthropic(实现) -> ./creds + ./llm + SDK`；`核心 -> @/llm(契约, SDK-free)`。核心永不 import `@/anthropic`，结构上碰不到 SDK。

## 8. 失败模式

| 场景 | 行为 |
|------|------|
| 无凭据（`creds.apiKey` 为空） | `makeLLMCall` 抛错（不变）；distiller 顶层 catch 降级为"本轮无候选"，dedup catch 降级为"全 new" |
| LLM 调用网络/502/超时 | 不变：抛错冒泡到 distiller/dedup 各自 catch，降级同上；scheduler tick 的 job 退避重试语义不变 |
| `opts` 缺省 | `opts?.maxTokens ?? DEFAULT_LLM_MAX_TOKENS` -> 8192，安全 |
| `opts.maxTokens` 非法（0/负/超限） | Anthropic SDK 拒绝 -> 抛错 -> 既有 catch 降级（YAGNI，不做前置校验，当前无调用方传 opts） |
| LLM 返回非 text block | 不变：`filter(b.type==='text')` 抽取，空则返回 `''`，distiller JSON.parse 失败 -> `[]` |

**原则**：本次清理不引入新失败模式；所有失败仍走既有降级路径。`max_tokens` 增大（8192）只影响输出上限，不改变错误语义。

## 9. 测试策略

纯重构 + 一处行为微调，无 UI 改动。首选可断言面（`makeLLMCall` 经 FakeAnthropic mock 可直接断言 `messages.create` 入参）。

- **`tests/anthropic.test.ts`**（保留，测试 `src/anthropic.ts` 的 `makeLLMCall`；`mock.module('@anthropic-ai/sdk', ...)` 不变）：
  - 既有用例意图不变，局部变量 `callAnthropic` -> `callLLM`，import `{ makeLLMCall, DISTILL_MODEL }` from `@/anthropic`：creds 的 apiKey/baseURL/model 流入 `messages.create`、`creds.model` 优先于 `DISTILL_MODEL`、无 creds.model 时 fallback `DISTILL_MODEL`、text block 抽取、无凭据抛错。
  - **新增 2 条**（锁本次变更，回归防护）：
    1. 不传 opts 时 `createCalls[0].max_tokens === DEFAULT_LLM_MAX_TOKENS`（=== 8192）——锁 2048->8192。
    2. 传 `{ maxTokens: 512 }` 时 `createCalls[0].max_tokens === 512`——锁 opts 透传。
- **`tests/llm.test.ts`**（新，测试 `src/llm.ts` 契约）：`expect(DEFAULT_LLM_MAX_TOKENS).toBe(8192)`--锁 8192 默认值（test↔source 命名对齐）。
- **`tests/distiller.test.ts` / `tests/dedup.test.ts` / `tests/scheduler.test.ts` / `tests/daemon.test.ts` / `tests/e2e.test.ts`**：mock 字段 `callAnthropic:` -> `callLLM:`（~22 处，纯机械；这些 mock 忽略入参，可选第 3 参 `opts` 不影响）。逻辑不变，靠现有用例保持绿验证重构无行为回归。
- **`tests/creds.test.ts`**：无改动（`creds.ts` 不变）。
- **运行门槛**：`bun run typecheck && bun test` 全绿才能 push。

## 10. 落地流程（CLAUDE.md）

1. 已切 `refactor/llm-seam-cleanup`（基线 `origin/master` `4e52cee`）。
2. 本 spec 落档 + commit。
3. 调用 `writing-plans` skill 产出 `docs/superpowers/plans/2026-07-23-llm-seam-cleanup.md`。
4. 清理 `.superpowers/sdd/`（CLAUDE.md 强制：spec + plan 两份落档后、写任何代码前，删该目录下所有文件）。
5. 按计划实现 + 测试，`bun run typecheck && bun test` 全绿。
6. push -> PR 合 `master`。

## 11. 涉及文件

- 新增：`src/llm.ts`、`tests/llm.test.ts`
- 改：`src/anthropic.ts`（`makeLLMCall` + opts + import `./llm`）、`tests/anthropic.test.ts`（符号改名 + max_tokens 测试）、`src/memory/distiller.ts`、`src/memory/dedup.ts`、`src/scheduler.ts`、`src/daemon.ts`
- 改测试：`tests/distiller.test.ts`、`tests/dedup.test.ts`、`tests/scheduler.test.ts`、`tests/daemon.test.ts`、`tests/e2e.test.ts`（mock 字段改名）
- 不动：`src/creds.ts`、`src/db/*`、`src/server.ts`、`src/memory/store.ts`、`src/memory/pure.ts`、`src/adapter/*`、`src/install.ts`、`src/cli.ts`、`demo.ts`、`smoke-live.ts`
- 落档：本 spec + `docs/superpowers/plans/2026-07-23-llm-seam-cleanup.md`
