# LLM 调用 seam 抽象清理 - 设计 spec

- 日期：2026-07-23
- 状态：Draft
- 分支：`refactor/llm-seam-cleanup`（已 rebase 到 `origin/master` `d662607`；基线含 valueFilter + callWithRetry 三道防线）
- 相关：`docs/superpowers/specs/2026-07-21-memside-design.md`（总体设计）、`docs/superpowers/specs/2026-07-23-candidate-dedup-design.md`（dedup 同样走 `callAnthropic` seam）

## 1. 背景与动机

对 memside 架构的审计结论：**核心功能与 AI 调用层在结构上已经解耦**--`@anthropic-ai/sdk` 只被 `src/anthropic.ts:1` import，凭据层 `creds.ts` 只被 `src/anthropic.ts:2`（实现）与 `src/daemon.ts:11`（组合根）引用，核心模块（`distiller` / `dedup` / `valueFilter` / `scheduler`）通过依赖注入的 `callAnthropic` seam 消费 AI 能力（distill/dedup/valueFilter 经 `callWithRetry` 中介调 seam），**不 import SDK、不 import `anthropic.ts`、不 import `creds.ts`**。测试印证：所有核心测试注入 mock `callAnthropic`，从不触网。

但解耦的**抽象卫生**有 4 处债务，本 spec 做清理（纯重构 + 一处行为微调）：

1. **seam 契约重复定义 6 次。** `(system: string, user: string) => Promise<string>` 作为内联类型字面量分别写在 `src/memory/distiller.ts:57`（`DistillInput`）、`src/memory/dedup.ts:16`（`DedupInput`）、`src/memory/valueFilter.ts:82`（`judgeValue` 参数）、`src/scheduler.ts:39`（`TickDeps`）、`src/memory/retry.ts:4`（`RetryOpts.call`）、`src/daemon.ts:57`（`runDistillOnce` deps）。没有单一命名类型拥有该契约；契约演进需 6 处同步改，易漂移。
2. **vendor 名泄漏进核心抽象。** seam 在核心类型里就叫 `callAnthropic`（上述 5 处 + `src/anthropic.ts:48` 的返回函数名）。核心本不该知道后端是 Anthropic--名字把具体 provider 写进了核心的接口声明。
3. **`max_tokens` 硬编码且过小。** `src/anthropic.ts:59` 写死 `max_tokens: 2048`，distill/dedup/valueFilter 经 `callWithRetry` 以 2 参调 seam 共用一份全局值，seam 形状 `(system, user) => string` 表达不了 per-call 覆盖。且 2048 对 distill（多条候选、每条 bodyMd ≤400 字）偏小，会被截断。
4. **seam 契约无归属模块。** `anthropic.ts` 拥有*实现*但不拥有*接口*；契约散落在 6 个消费方。没有 SDK-free 的契约模块让"核心不依赖 SDK"成为结构保证，而非靠大家自觉用 `import type`。

## 2. 目标

- **G1**：抽出单一命名类型 `LLMCall`，替换 6 处内联字面量；契约演进只改一处。
- **G2**：seam 改 vendor-neutral 名（`callAnthropic` -> `callLLM`），核心类型与 import 路径不再带 vendor 名（`retry.ts` 的字段名 `call` 已中性，仅类型改 `LLMCall`，名字保留）。
- **G3**：`max_tokens` 可配--seam 增加可选 `opts.maxTokens`，默认 `DEFAULT_LLM_MAX_TOKENS = 8192`（修正 2048 偏小）。
- **G4**：契约模块 `src/llm.ts` **SDK-free**（不 import `@anthropic-ai/sdk`）；SDK 仍只存在于实现文件 `src/anthropic.ts`。核心 `import type { LLMCall } from '@/llm'` 物理上碰不到 SDK。
- **G5**：除 `max_tokens` 默认值 2048 -> 8192 外，**零运行时行为变更**。

## 3. 非目标

- **N1**：不做 per-call-site 调参。distill/dedup/valueFilter 都经 `callWithRetry` 2 参调 seam，共用 8192 默认，不传 `opts`（"可配"是结构性能力，当前无消费方）。
- **N2**：不做 provider-swap 抽象（不引入 OpenAI adapter / 多后端选择 / `LLMProvider` 接口）。YAGNI--memside 硬绑 claude code 凭据。
- **N3**：不动 `creds.ts`（凭据解析已在正确边界：只被实现 + 组合根引用）。
- **N4**：不改 `distillTranscript` / `judgeDuplicates` / `judgeValue` 的 prompt 与判定逻辑；不改 `callWithRetry` 重试逻辑；不改各层失败降级语义。
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
| 7 | 参数命名 | 契约统一 `(system, user, opts?)`（取代 `(systemPrompt, userPrompt)` / `(system, user)` 混用） | 契约单一名；dedup/valueFilter 已是 `(system, user)`，distiller/scheduler 跟齐 |
| 8 | `retry.ts` 字段名 | `RetryOpts.call` 类型改 `LLMCall`，字段名 `call` 保留 | `call` 已 vendor-neutral，无需改名；仅归一类型即消除内联重复 |

## 5. 接口契约

### 5.1 新模块 `src/llm.ts`（SDK-free）

```ts
/** 单次 LLM 调用的可选参数。 */
export interface LLMCallOpts {
  /** 输出 token 上限；缺省时实现用 DEFAULT_LLM_MAX_TOKENS。 */
  maxTokens?: number
}

/**
 * vendor-neutral 的 LLM 调用 seam。核心记忆模块（distiller / dedup /
 * valueFilter / scheduler）与 callWithRetry 中介依赖此类型，而非任何具体
 * provider。实现（src/anthropic.ts）只在组合根（daemon.ts）装配；测试注入
 * mock。返回模型响应的拼接文本。
 *
 * 本模块刻意不 import `@anthropic-ai/sdk` / `./creds`，使"核心不依赖 SDK"
 * 成为结构保证：核心 `import type { LLMCall }` 编译期擦除，运行时零 SDK
 * 依赖，且即便误写运行时 import 也碰不到 SDK。
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

- **`src/memory/distiller.ts`**：`DistillInput.callAnthropic` -> `callLLM: LLMCall`（`import type { LLMCall } from '@/llm'`）；`distiller.ts:98` `callWithRetry({ call: input.callAnthropic, ... })` -> `call: input.callLLM`。distiller 不直接调 seam，经 `callWithRetry` 2 参调（走默认 8192）。
- **`src/memory/dedup.ts`**：`DedupInput.callAnthropic` -> `callLLM: LLMCall`；`dedup.ts:84` `callWithRetry({ call: input.callAnthropic, ... })` -> `call: input.callLLM`。
- **`src/memory/valueFilter.ts`**：`judgeValue` 参数 `callAnthropic` -> `callLLM: LLMCall`；`valueFilter.ts:90` `callWithRetry({ call: callAnthropic, ... })` -> `call: callLLM`。
- **`src/memory/retry.ts`**：`RetryOpts.call` 类型 `(system, user) => Promise<string>` -> `LLMCall`（`import type { LLMCall } from '@/llm'`）；字段名 `call` 保留。`callWithRetry` 内部 `opts.call(opts.system, currentUser)` 2 参调用不变。
- **`src/scheduler.ts`**：`TickDeps.callAnthropic` -> `callLLM: LLMCall`；`dedupCandidates` 参数 `callAnthropic: TickDeps['callAnthropic']` -> `callLLM: LLMCall`；`judgeDuplicates` 调用（`scheduler.ts:84`）`callAnthropic,` -> `callLLM,`；`distillTranscript` 调用（`:123`）`callAnthropic: deps.callAnthropic` -> `callLLM: deps.callLLM`；`judgeValue` 调用（`:129`）`judgeValue(candidates, deps.callAnthropic)` -> `judgeValue(candidates, deps.callLLM)`；`dedupCandidates` 调用（`:145`）`deps.callAnthropic` -> `deps.callLLM`。
- **`src/daemon.ts`**：`runDistillOnce` deps 类型 `callAnthropic?: (...) => Promise<string>` -> `callLLM?: LLMCall`；局部变量 `callAnthropic` -> `callLLM`；tickDeps 字段 `callAnthropic` -> `callLLM`（`runDistillOnce` + `startDaemon` 两处）；import `makeCallAnthropic` -> `makeLLMCall`（Task 2 已改）+ 新增 `import type { LLMCall } from '@/llm'`。

### 5.4 数据模型

**零变更。** 不动 schema、不动 `creds.ts`、不动 store / pure / adapter。

## 6. 数据流

seam 名 + `max_tokens` 默认值变；3 阶段 tick 的 LLM 调用全部经 `callWithRetry` 2 参调 seam，8192 默认值自动贯通 distill/dedup/valueFilter 三处：

```
hook(Stop) -> events -> job(pending)
tick:
  loadTranscript(job) -> turns
  distillTranscript({ turns, callLLM }) -> callWithRetry -> LLM(默认 8192) -> candidates   [改名]
  judgeValue(candidates, deps.callLLM) -> callWithRetry -> LLM(默认 8192) -> valueVerdicts   [改名，价值过滤]
  dedupCandidates(db, deps.callLLM, keepCandidates) -> judgeDuplicates({ callLLM }) -> callWithRetry -> LLM(默认 8192) -> verdicts   [改名]
  keep -> createCandidate(valueClass) -> memories(candidate)
  job -> done
注入（不变）：SessionStart -> listApprovedByScope -> formatMemoryBlock
```

distill/dedup/valueFilter 都不传 `opts`，经 `callWithRetry` 以 2 参调 seam，共用 8192 默认。**唯一运行时行为变更：每次 LLM 调用 `max_tokens` 2048 -> 8192。**

## 7. 与现有模块的耦合点

- **`distillTranscript` / `DistillCandidate`**（`distiller.ts`）：仅 seam 字段名 + 类型来源变；prompt、`callWithRetry` 重试、失败降级（`distiller.ts:127` catch -> 返回 `[]`）不变。
- **`judgeDuplicates`**（`dedup.ts`）：仅 seam 字段名 + 类型来源变；`callWithRetry` 重试、保守降级（`dedup.ts:106` catch -> 全 `duplicate:false`）不变。
- **`judgeValue`**（`valueFilter.ts`）：仅 seam 参数名 + 类型来源变；`callWithRetry` 重试、保守降级（`valueFilter.ts:112` catch -> 全 keep+null）不变。这是第 3 个 seam 消费者（spec 初版后新增）。
- **`callWithRetry`**（`retry.ts`）：`RetryOpts.call` 类型改 `LLMCall`，字段名 `call` 与内部 `opts.call(system, user)` 2 参调用不变；重试/反馈逻辑不变。retry.ts 属核心层（SDK-free，只 import `./pure`）。
- **`tick` / `TickDeps`**（`scheduler.ts`）：`TickDeps.callLLM` 透传给 distiller / judgeValue / dedup 三处，模式不变；3 阶段顺序（distill->judgeValue->dedup）、退避重试、pending-only select 不变。
- **`makeLLMCall` / `DISTILL_MODEL` / `AnthropicDeps`**（`anthropic.ts`）：工厂改名 + 加 opts；`DISTILL_MODEL` / `AnthropicDeps` 保留（实现关注点）。`creds.ts` 接口不变。
- **`daemon.ts` 组合根**：装配 `makeLLMCall()` 为 `callLLM` 注入 `TickDeps`；`runDistillOnce` 测试 seam 同步改名。
- **依赖方向**：`daemon.ts -> @/anthropic(实现) -> ./creds + ./llm + SDK`；`核心(distiller/dedup/valueFilter/scheduler/retry) -> @/llm(契约, SDK-free)`。核心永不 import `@/anthropic`，结构上碰不到 SDK。

## 8. 失败模式

| 场景 | 行为 |
|------|------|
| 无凭据（`creds.apiKey` 为空） | `makeLLMCall` 抛错（不变）；distiller/dedup/valueFilter 各自 catch 经 `callWithRetry` 重试耗尽后降级（无候选 / 全 new / 全 keep+null） |
| LLM 调用网络/502/超时 | 不变：`callWithRetry` 重试耗尽返回 `lastParsed`（或 undefined）-> 各层降级；scheduler tick 的 job 退避重试语义不变 |
| `opts` 缺省 | `opts?.maxTokens ?? DEFAULT_LLM_MAX_TOKENS` -> 8192，安全 |
| `opts.maxTokens` 非法（0/负/超限） | Anthropic SDK 拒绝 -> 抛错 -> 既有 catch 降级（YAGNI，不做前置校验，当前无调用方传 opts） |
| LLM 返回非 text block | 不变：`filter(b.type==='text')` 抽取，空则返回 `''`，`callWithRetry` 的 `extractJsonObject`/`JSON.parse` 失败触发重试 |

**原则**：本次清理不引入新失败模式；所有失败仍走既有 `callWithRetry` + 各层降级路径。`max_tokens` 增大（8192）只影响输出上限，不改变错误语义。

## 9. 测试策略

纯重构 + 一处行为微调，无 UI 改动。首选可断言面（`makeLLMCall` 经 FakeAnthropic mock 可直接断言 `messages.create` 入参）。

- **`tests/anthropic.test.ts`**（保留，测试 `src/anthropic.ts` 的 `makeLLMCall`；`mock.module('@anthropic-ai/sdk', ...)` 不变）：既有用例意图不变，局部变量 `callAnthropic` -> `callLLM`，import `{ makeLLMCall, DISTILL_MODEL }` from `@/anthropic`：creds 的 apiKey/baseURL/model 流入 `messages.create`、`creds.model` 优先于 `DISTILL_MODEL`、无 creds.model 时 fallback `DISTILL_MODEL`、text block 抽取、无凭据抛错。**新增 3 条**（锁本次变更，回归防护）：1. `DEFAULT_LLM_MAX_TOKENS === 8192`；2. 不传 opts 时 `createCalls[0].max_tokens === DEFAULT_LLM_MAX_TOKENS`（=== 8192）--锁 2048->8192；3. 传 `{ maxTokens: 512 }` 时 `createCalls[0].max_tokens === 512`--锁 opts 透传。
- **`tests/llm.test.ts`**（新，测试 `src/llm.ts` 契约）：`expect(DEFAULT_LLM_MAX_TOKENS).toBe(8192)`--锁 8192 默认值（test↔source 命名对齐）。
- **`tests/distiller.test.ts` / `tests/dedup.test.ts` / `tests/scheduler.test.ts` / `tests/daemon.test.ts` / `tests/e2e.test.ts`**：mock 字段 `callAnthropic:` -> `callLLM:`（~32 处，纯机械；这些 mock 忽略或部分用入参，可选第 3 参 `opts` 不影响）。逻辑不变，靠现有用例保持绿验证重构无行为回归。
- **`tests/valueFilter.test.ts` / `tests/retry.test.ts`**：**无需改动**。前者以位置参数 `judgeValue(cands, async () => ...)` 传 mock（无 `callAnthropic:` 字段）；后者用 `callWithRetry({ call: async () => ... })`（字段名 `call`）。
- **`tests/creds.test.ts`**：无改动（`creds.ts` 不变）。
- **运行门槛**：`bun run typecheck && bun test` 全绿才能 push。

## 10. 落地流程（CLAUDE.md）

1. 已切 `refactor/llm-seam-cleanup`，已 rebase 到 `origin/master` `d662607`（含 valueFilter + callWithRetry）。
2. spec 落档 + commit（`d0bc869`）。
3. 调用 `writing-plans` skill 产出 `docs/superpowers/plans/2026-07-23-llm-seam-cleanup.md`；rebase 后按 `d662607` 现状修订 spec §1/§5.3/§6/§7/§11 + plan。
4. 清理 `.superpowers/sdd/`（CLAUDE.md 强制：spec + plan 两份落档后、写任何代码前，删该目录下所有文件）。
5. 按计划实现 + 测试，`bun run typecheck && bun test` 全绿。
6. push -> PR 合 `master`。

## 11. 涉及文件

- 新增：`src/llm.ts`、`tests/llm.test.ts`
- 改：`src/anthropic.ts`（`makeLLMCall` + opts + import `./llm`）、`tests/anthropic.test.ts`（符号改名 + max_tokens 测试）、`src/memory/distiller.ts`、`src/memory/dedup.ts`、`src/memory/valueFilter.ts`、`src/memory/retry.ts`（`RetryOpts.call` 类型）、`src/scheduler.ts`、`src/daemon.ts`
- 改测试：`tests/distiller.test.ts`、`tests/dedup.test.ts`、`tests/scheduler.test.ts`、`tests/daemon.test.ts`、`tests/e2e.test.ts`（mock 字段改名）
- 不动：`src/creds.ts`、`src/db/*`、`src/server.ts`、`src/memory/store.ts`、`src/memory/pure.ts`、`src/adapter/*`、`src/install.ts`、`src/cli.ts`、`tests/valueFilter.test.ts`、`tests/retry.test.ts`、`tests/creds.test.ts`、`demo.ts`、`smoke-live.ts`
- 落档：本 spec + `docs/superpowers/plans/2026-07-23-llm-seam-cleanup.md`
