# distill/dedup LLM 输出的 JSON 提取层（三道防线） - 设计 spec

- 日期：2026-07-23
- 状态：Draft
- 分支：`feat/distill-json-extract`（基线 `origin/master` `26b5418`）
- 相关：`STATE.md` "Known debt - codeagent 桥接遗留 (2026-07-23)" 第 1 项、`docs/superpowers/specs/2026-07-21-memside-design.md`（总体设计）、`docs/superpowers/specs/2026-07-23-candidate-dedup-design.md`（dedup 模块）

## 1. 背景与动机

`src/memory/distiller.ts:63` 与 `src/memory/dedup.ts:211` 各有一处 `JSON.parse(raw)`，直接消费 LLM 返回的原始文本。当模型输出被 markdown 围栏（```` ```json ... ``` ````）包裹、前后夹带解释文字（"好的，结果如下：{...}"）、或含尾逗号 / 单引号等不规范写法时，`JSON.parse` 抛错；两处各自的 try/catch 吞掉错误，导致：

- **distiller**（`distiller.ts:88` catch）静默返回空数组 -> **产出 0 候选记忆**。这是最难发现的失败模式：表面上"这段对话没啥值得记的"，实际是解析炸了。
- **dedup**（`judgeDuplicates` 的 catch）保守放行 -> **去重失效，全部当 `new` 入库**，加剧候选堆积。

实测：`claude -p` 两次调用，一次 `result` 被 ```` ```json ```` 围栏包裹、一次是纯 JSON，**间歇性**。后端模型（实测 `glm-5.2[1m]` / `deepseek-v4-flash[1m]`）指令遵从弱于 Claude，更易触发；未来 codeagent 桥接（用本地 codeagent CLI 替代 API 凭证）后端模型未知，风险更高。该问题对直连 Anthropic 模式同样存在（Claude 也可能偶尔加围栏）。

`STATE.md` 的 codeagent 桥接遗留第 1 项已标注"正在解决"。本 spec 用**三道防线**解决这一个脆弱点（围栏 / JSON 解析失败），三道都不依赖 codeagent 透传任何 flag，对直连 `@anthropic-ai/sdk` 与 CLI 两种模式都生效：

1. **第一道：`extractJsonObject`** -- 事后清洗，扒围栏 / 抠首个平衡 `{...}` 块。
2. **第二道：提示词加固 + JSON 模板** -- 事前约束，降低模型加围栏 / 写不规范 JSON / 业务违规的频率。
3. **第三道：`callWithRetry`** -- 兜底，前两道没挡住的（尾逗号、单引号、截断、业务规则违反）带错误反馈重试。

更强的结构化约束 `--json-schema`（实测在 claude CLI 上能让 `result` 无围栏且提供 `structured_output` 字段）依赖 codeagent 透传该 flag（**未验证的硬前提**），且直连 `@anthropic-ai/sdk` 没有此能力，留给 codeagent 桥接 spec，不在本 spec。

## 2. 目标

- **G1**：模型输出被围栏包裹 / 夹带解释文字时，distiller / dedup 仍能正确解析（修静默失败）。
- **G2**：通过提示词加固 + 带示例值的 JSON 模板，降低模型加围栏 / 写不规范 JSON / 业务违规（`[category:` 前缀缺失、`scope` / `distillAction` 枚举乱编）的频率。
- **G3**：通过 `callWithRetry` + 错误反馈，兜底前两道没挡住的解析失败与业务违规。
- **G4**：三道防线隔离为独立纯函数 / 高阶函数模块，可独立单测；**不改** distiller / dedup 现有业务处理逻辑（候选解析、过滤、丢弃、保守放行）。
- **G5**：**不改现有失败行为** -- 三道都失败时，distiller 仍返回空数组、dedup 仍全 `new`（保守）。
- **G6**：零 schema 变更。

## 3. 非目标

- **N1**：处理长 transcript 截断（第 3 个脆弱点，靠裁剪 transcript 治本，已记 `STATE.md` 遗留）。第三道重试能**检测**截断（parse 失败）并重试，但 transcript 超长导致反复截断时重试治不好。
- **N2**：放宽 `[category:xxx]` 前缀校验（第 2 个脆弱点，已记遗留）。第二道模板会**降低**前缀缺失频率，第三道重试会给模型补正机会，但校验逻辑（`distiller.ts:70` `includes('[category:')`）**不变**，耗尽后缺前缀的候选仍 `continue` 丢弃。
- **N3**：`--json-schema` 结构化约束（依赖 codeagent 透传，留给 codeagent 桥接 spec）。
- **N4**：改 distiller / dedup 现有业务处理逻辑（候选解析、过滤、丢弃、dedup 幻觉当 new 的保守逻辑）。
- **N5**：改 hooks / 捕获 / 注入路径（第 5 个脆弱点，闭环层面）。

## 4. 关键决策

| # | 决策点 | 选择 | 理由 |
|---|--------|------|------|
| 1 | 防线分层 | 提取（清洗）+ 提示词加固（事前）+ 重试（兜底） | 三道互补：事后补救 / 事前降概率 / 兜底剩余；分别经实测验证思路（提取 8/8 稳健、`--json-schema` 实测治格式、重试为业界 self-correction 模式） |
| 2 | 提取实现 | 字符级状态机（无正则） | 正则不擅长平衡嵌套（`{"title":"a{b}"}` 字符串内大括号翻车）；状态机 depth 计数 + 字符串感知，实测 8/8 case 精确、零误匹配 |
| 3 | 提取落点 | `src/memory/pure.ts` | 纯函数集中地，已有 `detectErrorSignals` 文本扫描 precedent；distiller / dedup 都 import `./pure`；不增文件 |
| 4 | 重试落点 | 新文件 `src/memory/retry.ts` | `callWithRetry` 是 async 且依赖 `callAnthropic` seam，不适合 `pure.ts`（纯同步）；distiller / dedup 共用 |
| 5 | 重试业务校验 | `shouldRetry` 回调注入 | distiller / dedup 业务规则不同（candidates vs verdicts）；回调让重试逻辑通用且能收拾业务违规（前缀缺失、幻觉 id），而非只管格式 |
| 6 | 重试耗尽语义 | 返回最后成功 parse 的 `lastParsed`，走现有兜底 | 不改现有失败行为（distiller 空数组 / dedup 全 new）；重试只是多给几次机会补正 |
| 7 | 第二道手段 | 提示词加固 + JSON 模板（非 `--json-schema`） | `--json-schema` 依赖 codeagent 透传 + 直连没有；提示词加固不依赖任何 flag，对两种模式都生效 |
| 8 | 模板形式 | 带示例值的 few-shot 模板 | 类型签名式 JSON（`"title","bodyMd"`）模型易自编枚举（实测 scope 写成 `general`/`session`）；示例值让模型照抄结构 + 正确枚举 |
| 9 | 应用面 | distiller + dedup 共用 | 两处 `JSON.parse(raw)` 同源风险；`extractJsonObject` / `callWithRetry` 通用，一次修两处避免重复 spec |
| 10 | schema | 零变更 | 不增列不改列；三道都是解析层，不触存储 |

## 5. 接口契约

### 5.1 `extractJsonObject`（`src/memory/pure.ts`，纯函数）

```ts
/**
 * Extract the first balanced {...} object from raw LLM output. Strips markdown
 * fences (```json...``` / ```...``` / ~~~...~~~) and surrounding prose by
 * locating the first '{' and scanning to its matching '}' with string-aware
 * depth counting (braces inside "..." / \"...\" are NOT counted). No regex.
 *
 * - No '{' in raw -> return raw (caller's JSON.parse fails into its existing catch).
 * - Matched -> return the [start..i] substring.
 * - Unbalanced (truncated) -> return raw.slice(start) (parse fails, existing catch).
 *
 * Property: only turns a "false failure" (valid {...} buried in noise) into
 * success; genuinely-non-JSON input is passed through unchanged.
 */
export function extractJsonObject(raw: string): string
```

行为已实测验证（8 case 全中，见 §9）。

### 5.2 `callWithRetry`（`src/memory/retry.ts`，新）

```ts
export interface RetryOpts {
  call: (system: string, user: string) => Promise<string>
  system: string
  user: string
  /** Return an error message to retry, or null to accept the parsed output. */
  shouldRetry: (parsed: unknown) => string | null
  maxRetries?: number  // default 2 (3 total attempts)
}

/**
 * Call `call` -> extractJsonObject -> JSON.parse -> shouldRetry. On any failure
 * (call throws, parse fails, shouldRetry returns an error), feed the error back
 * to the model in natural language and retry, up to maxRetries times.
 *
 * Returns the last successfully-parsed object (or undefined if parse never
 * succeeded), so the caller's existing `!parsed` / `!Array.isArray(...)` guards
 * still catch the exhausted case -> existing fallback behavior unchanged.
 */
export async function callWithRetry(opts: RetryOpts): Promise<unknown>
```

- 重试时 `user` 拼接：`${opts.user}\n\n[修正] 你上次的回答有问题：${error}。请只输出纯 JSON 对象，不要 markdown 围栏，不要解释文字，键与字符串值用双引号，最后一个属性后无逗号。`
- `call` 抛错（网络 / 502 / 超时）也触发重试（catch 后带错误反馈）。
- 维护 `lastParsed`：每次 `JSON.parse` 成功即更新；`shouldRetry` 返回 null 时立即返回当前 parsed；耗尽返回 `lastParsed`（可能 undefined）。

### 5.3 提示词加固 + JSON 模板

**`DISTILLER_SYSTEM_PROMPT`（`src/memory/distiller.ts:3-30`）** 末尾的类型签名式 JSON 替换为带示例值的 few-shot 模板 + 显式格式要求：

```
输出格式如下（仅示范结构，勿照抄内容；只输出这一个 JSON 对象，不要 markdown 围栏，
不要在 JSON 前后加任何解释文字，键与字符串值用双引号，最后一个属性后无逗号，不要用单引号）：
{
  "candidates": [
    {
      "title": "[category:convention] 每个 PR 必须在 CHANGELOG.md 的 Unreleased 部分加一条",
      "bodyMd": "项目约定：PR 合并前需在 CHANGELOG.md 的 Unreleased 段落补充变更条目。",
      "scope": "project",
      "runtime": "claude-code",
      "distillAction": "new"
    }
  ]
}
```

**`DEDUP_SYSTEM_PROMPT`（`src/memory/dedup.ts:181-183`）** 同理给 verdicts 模板：

```
输出格式如下（仅示范结构，勿照抄内容；只输出这一个 JSON 对象，无 markdown 围栏，无解释文字）：
{
  "verdicts": [
    {"index": 0, "isDuplicate": false},
    {"index": 1, "isDuplicate": true, "duplicateOfId": "A"}
  ]
}
```

模板同时示范：`[category:xxx]` 完整前缀、`scope` 只能 `project`/`global`、`distillAction` 只能 `new`/`update_of`/`duplicate_of`/`conflict_with`、双引号、无尾逗号、无围栏。

### 5.4 distiller / dedup 集成

**`src/memory/distiller.ts`**：`distillTranscript` 里 `distiller.ts:62-63` 的 `callAnthropic + JSON.parse` 段改为 `callWithRetry`，后续候选解析 / 过滤（`distiller.ts:64-86`）**不变**：

```ts
const parsed = await callWithRetry({
  call: input.callAnthropic,
  system: DISTILLER_SYSTEM_PROMPT,
  user: userPrompt,
  shouldRetry: distillShouldRetry,
}) as { candidates?: unknown } | undefined
if (!parsed || !Array.isArray(parsed.candidates)) return []
// ... 现有 for 循环（含 includes('[category:') 丢弃）不变
```

新增 `distillShouldRetry`（模块内私有）：parsed 非对象 / 缺 `candidates` 数组 / 某候选缺 `title`/`bodyMd` / 某候选 `title` 缺 `[category:` 前缀 -> 返回错误信息；否则 null。

**`src/memory/dedup.ts`**：`judgeDuplicates` 里 `dedup.ts:210-211` 的 `callAnthropic + JSON.parse` 段同样改为 `callWithRetry`，后续 verdict 处理（含 `existingIds.has` 幻觉检查）**不变**：

```ts
const parsed = await callWithRetry({
  call: input.callAnthropic,
  system: DEDUP_SYSTEM_PROMPT,
  user: renderUserPrompt(...),
  shouldRetry: dedupShouldRetry(existingIds),
}) as { verdicts?: unknown } | undefined
if (!parsed || !Array.isArray(parsed.verdicts)) {
  return input.newCandidates.map((_, i) => ({ index: i, duplicate: false }))  // 现有保守兜底
}
// ... 现有 verdict 处理（含幻觉当 new）不变
```

新增 `dedupShouldRetry(existingIds)`（闭包捕获 `existingIds`）：parsed 非对象 / 缺 `verdicts` 数组 / 某 verdict 缺 `index` 或 `isDuplicate` / `isDuplicate:true` 但 `duplicateOfId` 不在 `existingIds`（幻觉）-> 返回错误信息；否则 null。

**关键性质**：`shouldRetry` 只是"检测到违规就先重试给模型机会补正"；耗尽后 distiller / dedup 仍走现有兜底（缺前缀 `continue` 丢弃、幻觉当 new），**现有业务行为不变**。

## 6. 数据流

```
distiller:
  callWithRetry:
    call(DISTILLER_SYSTEM_PROMPT, user)        [第二道：加固后的 prompt 事前约束]
      -> raw
    extractJsonObject(raw) -> cleaned          [第一道：扒围栏/抠{...}]
    JSON.parse(cleaned) -> parsed
    distillShouldRetry(parsed) -> null ? 返回 : 带错误反馈重试   [第三道：兜底]
    （耗尽返回 lastParsed）
  现有候选解析/过滤（丢弃缺 [category: 前缀的）-> DistillCandidate[]

dedup: 同构（verdicts + dedupShouldRetry + 幻觉兜底）
```

## 7. 与现有模块的耦合点

- **`distiller.ts`**：`DISTILLER_SYSTEM_PROMPT` 改（模板）、parse 段改用 `callWithRetry`、新增 `distillShouldRetry`。候选解析 / 过滤逻辑不变。新增 import `extractJsonObject`（`./pure`，distiller 已从 pure import 类型）+ `callWithRetry`（`./retry`）。
- **`dedup.ts`**：`DEDUP_SYSTEM_PROMPT` 改（模板）、parse 段改用 `callWithRetry`、新增 `dedupShouldRetry`。verdict 处理 / 幻觉兜底不变。新增 import `extractJsonObject` + `callWithRetry`。
- **`pure.ts`**：新增 `extractJsonObject`。无其他改动。
- **`retry.ts`（新）**：`callWithRetry`，import `extractJsonObject` from `./pure`。无 `callAnthropic` 依赖（seam 经 `RetryOpts.call` 注入）。
- **`TickDeps.callAnthropic` seam**（`scheduler.ts:38`）：**不变**。`callWithRetry` 在 seam 之上包装，distiller / dedup 仍通过 `input.callAnthropic` / `deps.callAnthropic` 调用。
- **`daemon.ts`**：无改动（`tickDeps.callAnthropic` 不变）。
- **`store.ts`**：无改动。

## 8. 失败模式

| 场景 | 行为 |
|------|------|
| 模型输出围栏包裹 | 第一道扒掉，parse 成功，正常提取 / 判定 |
| 模型输出夹带解释文字 | 第一道抠出 `{...}`，parse 成功 |
| 模型输出尾逗号 / 单引号 | 第一道提取后 parse 失败 -> 第三道重试带错误反馈 -> 重试成功或耗尽 |
| 模型输出截断未闭合 | 第一道返回 `raw.slice(start)`，parse 失败 -> 第三道重试（超长反复截断则治不好，靠 N1 裁剪） |
| 候选缺 `[category:` 前缀 | `distillShouldRetry` 检测 -> 第三道重试给机会补；耗尽仍走现有 `continue` 丢弃（N2 不变） |
| `duplicateOfId` 幻觉 | `dedupShouldRetry` 检测 -> 重试；耗尽仍走现有当 new（dedup 幻觉处理不变） |
| `call` 抛错（网络 / 502 / 超时） | 第三道重试；耗尽返回 `lastParsed`（可能 undefined）-> distiller `!parsed` 返回 [] / dedup 全 new |
| 重试耗尽（3 次都失败） | 返回 `lastParsed`，distiller / dedup 现有兜底（空数组 / 全 new），行为不变 |
| 模型输出纯文本无 `{` | 第一道返回原文本，parse 失败 -> 第三道重试 -> 耗尽兜底 |

**原则**：三道防线只在"模型输出含可补救的 `{...}`"时把假失败修成真成功；真不可补救时原样透传到现有 catch，**不制造新行为、不丢信息、不阻断 distill**。

## 9. 测试策略

纯函数 / 高阶函数层为主（CLAUDE.md），无 UI 改动。

- **`tests/pure-json-extract.test.ts`（新，纯函数）**：围栏（```` ```json ```` / ```` ``` ```` / `~~~`）、夹带文字、字符串内大括号（`{"title":"a{b}"}`）、嵌套对象、多对象取首个、纯文本无 `{`、截断未闭合、空串、无语言标签围栏。锁定状态机行为。
- **`tests/retry.test.ts`（新，高阶函数 + mock call）**：首次成功不重试、parse 失败重试成功、`shouldRetry` 触发重试、重试耗尽返回 `lastParsed`、`call` 抛错重试、错误反馈 prompt 含上次错误信息、`maxRetries` 边界（默认 2）。断言重试时 `user` 含 `[修正]` 与原错误信息。
- **`tests/distiller.test.ts`（扩）**：
  - `callAnthropic` 返回**围栏包裹**的 candidates JSON -> `distillTranscript` 正确解析出候选（回归：之前返回 `[]`）。
  - `shouldRetry` 业务违规场景（首次缺 `[category:` 前缀 -> 重试 -> 第二次合规）。
  - 重试耗尽仍返回 `[]`（兜底不变）。
  - prompt 断言：`DISTILLER_SYSTEM_PROMPT` 含模板关键结构（`[category:` / `"scope": "project"` / 仅示范结构）。
- **`tests/dedup.test.ts`（扩）**：
  - `callAnthropic` 返回**围栏包裹**的 verdicts JSON -> `judgeDuplicates` 正确判定（回归：之前全 new）。
  - `shouldRetry` 场景（首次幻觉 `duplicateOfId` -> 重试 -> 第二次合规）。
  - 重试耗尽仍全 new（兜底不变）。
  - prompt 断言：`DEDUP_SYSTEM_PROMPT` 含模板（`"isDuplicate"` / `"duplicateOfId"`）。
- distiller / dedup 各保留一条"纯文本非 JSON 仍走原兜底"case，锁定兜底行为不变。

## 10. 落地流程（CLAUDE.md）

1. 已切 `feat/distill-json-extract`（基线 `origin/master` `26b5418`）。
2. 本 spec 落档 + commit。
3. 调用 `writing-plans` skill 产出 `docs/superpowers/plans/2026-07-23-distill-json-extract.md`。
4. 清理 `.superpowers/sdd/`（brainstorming 中间产物）。
5. 按计划实现 + 测试，`bun run typecheck && bun test` 全绿。
6. push -> PR 合 `master`。

## 11. 涉及文件

- 新增：`src/memory/retry.ts`、`tests/pure-json-extract.test.ts`、`tests/retry.test.ts`
- 改：`src/memory/pure.ts`（加 `extractJsonObject`）、`src/memory/distiller.ts`（`DISTILLER_SYSTEM_PROMPT` 模板 + parse 段改 `callWithRetry` + `distillShouldRetry`）、`src/memory/dedup.ts`（`DEDUP_SYSTEM_PROMPT` 模板 + parse 段改 `callWithRetry` + `dedupShouldRetry`）
- 扩测试：`tests/distiller.test.ts`、`tests/dedup.test.ts`
- 落档：本 spec + `docs/superpowers/plans/2026-07-23-distill-json-extract.md`
