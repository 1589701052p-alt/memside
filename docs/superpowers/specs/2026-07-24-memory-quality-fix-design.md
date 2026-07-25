# memside 记忆质量修复设计

- 日期：2026-07-24
- 分支：`feat/memory-quality-fix`（从 `origin/master` `1f08f98` 切出）
- 状态：设计阶段（brainstorming 产出，待 review -> writing-plans）

## 1. 背景

对生产库 `~/.memside/memside.db` 的诊断表明 distill 产出的候选记忆质量普遍偏低。

数据证据（2026-07-24 采样）：

- `memories` 表 2290 条：rejected 2214、candidate 74（分析期间 daemon 仍在跑，后续涨到 109）、approved 2。`status='rejected'` 仅由 `store.ts:200` 的 `reject` action 写入（Web UI 调用），无自动路径。
- 关于 rejected：Web UI 有"批量拒绝未评估"按钮（`App.tsx:152`，一键拒绝所有 `value_class=null` 候选）。2214 rejected **全部 value_class=null**，且 value_class 非 null 仅在 07-24 出现 -> rejected 数本身是清理 valueFilter 上线前的旧积压，**不是逐条质量否决的证据**。这条不作为质量证据。
- 真正的质量证据是**留存候选的内容**：109 条候选（valueFilter 判定保留）中 ~89 条（82%）是复述 memside 自身源码/注释（`distiller max_tokens 8192`、`parseTranscriptFile 跳过 tool_use`、`LLMCall 契约` 等），其余多为 LLM 后端实验流水账或 smoke-live 测试 fixture。
- 重复严重：退款 14 天规则出现 4+ 次、GLM 前缀问题 2+ 次、tool_use 跳过 3 次、max_tokens 多次。
- 输入信号噪比（单 job 采样 206 turn）：user 72 字符 / assistant 1053 字符 / **tool 67224 字符**。喂给 distiller 的输入 98% 是工具 I/O。
- 87% 的 distill job（1039/1187）来自 memside 自身开发会话（dogfood），transcript 里含大量 `Read` 出来的源码全文。

根因（三层）：

1. **输入侧**：`server.ts:115` 在 hook 触发时 `parseTranscriptFile` -> `JSON.stringify(turns)` 整段存入 `memory_distill_events.payload`；蒸馏时 `daemon.ts:makeLoadTranscript` 原样读出，`distiller.ts:renderUserPrompt` 全量拼接直送 LLM。无过滤、无截断预算。且 `parseTranscriptFile`（`transcript.ts:126`）**丢弃 `tool_use`**，distiller 只看到 tool_result 输出而不知调用了什么工具。transcript 里的文件源码被 LLM 当"架构知识"逐字背下。
2. **valueFilter**：把真业务硬规则（`[category:invariant]` 退款 14 天、`[category:integration]` Idempotency-Key，虽部分来自 smoke fixture）误判为 `derivable`/`public-knowledge` 丢弃；反而把代码复述型事实判成 `decision`/`trap` 保留。质量筛选倒挂。
3. **dedup**：`judgeDuplicates` 只比对"新候选 vs 已入库"，不比同批兄弟；同义改写全留存。dedup 在 valueFilter 之后跑，重复候选先被 valueFilter 各自误判、再各自通过/丢弃。

## 2. 目标 / 非目标

### 目标

1. distiller 输入不再含文件源码全文，按工具类型压缩 tool I/O，并套输入 token 预算（近期优先），从根本上消除"代码复述型"记忆。
2. valueFilter 不再丢弃 `invariant`/`integration`/`compliance` 类业务硬规则；同时能识别"本代码库自身实现细节"为 `derivable`。
3. dedup 在 valueFilter 之前执行，且同时覆盖"同批兄弟 + 已入库"，同义改写只留一条。
4. 全部以可断言的纯函数为实现主体，运行时层只接线。

### 非目标

- DB 253MB 膨胀 / `memory_distill_events` 保留策略：本次不做（独立后续 issue）。
- Web UI 改动：不动（"批量拒绝未评估"按钮保留）。
- 注入侧（`formatMemoryBlock` / `clipByBudget`）：不动。
- LLM 后端选择（anthropic/openai）：不动。过滤与后端无关。
- 历史 2214 条 rejected 数据不回溯重处理。

## 3. 接口契约

### 3.1 `TranscriptTurn` 扩展（`src/memory/pure.ts`）

向后兼容新增两个可选字段：

```ts
export interface TranscriptTurn {
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  isError?: boolean
  /** 配对自前一个 assistant 行的 tool_use 块；仅 role==='tool' 有值。 */
  toolName?: string
  /** 提取自 tool_use.input 的文件路径（file_path / notebook_path）；仅文件类工具有值。 */
  toolInputPath?: string
}
```

老 payload（无这两个字段）继续可读，过滤函数对缺失走启发式兜底。

### 3.2 `parseTranscriptFile` 配对改动（`src/claude/transcript.ts`）

当前实现丢弃 assistant 行的 `tool_use` 块。改为：

- assistant 行：`{type:'text'}` -> `{role:'assistant', content}`（不变）；`{type:'tool_use'}` -> 不再丢弃，缓存最近一个 `{name, input}` 到一个游标变量（同一条 assistant 消息内多个 tool_use 按序缓存，被后续 tool_result 依次消费）；`{type:'thinking'}` 仍跳过。
- user 行的 `{type:'tool_result'}`：配对到当前游标里的 `tool_use`（FIFO 消费），产出 `{role:'tool', content, isError, toolName, toolInputPath}`。`toolInputPath` 从 `input.file_path` / `input.notebook_path` / `input.path` 中取第一个存在的字符串值。
- 游标缺失（tool_result 没有前导 tool_use，或老格式）-> 产出 `{role:'tool', content, isError}`（无 toolName/toolInputPath）。

配对是"保留更多信号"而非有损过滤，不违背"蒸馏时过滤"原则。

### 3.3 `filterTranscriptForDistill`（`src/memory/pure.ts`）

```ts
export const DEFAULT_DISTILL_INPUT_BUDGET_TOKENS = 12000

export function filterTranscriptForDistill(
  turns: readonly TranscriptTurn[],
  budgetTokens?: number,
): TranscriptTurn[]
```

纯函数，永不抛。处理顺序：

1. **逐 turn 压缩**（不改 turn 数量，只改 content）：
   - `role==='tool'`：
     - `isError===true` -> content 原样保留（错误输出有信号）。
     - `toolName ∈ FILE_TOOLS = {Read, Edit, Write, MultiEdit, NotebookEdit}` 且非 error -> content 替换为占位 `[file: ${toolInputPath ?? '未知路径'}, 原文 ${lineCount} 行]`（`lineCount` = 原 content 换行数）。
     - `toolName` 存在但 `∉ FILE_TOOLS`（Bash / Grep / Glob / Task / 任意未知工具名）且非 error -> content 截断到 1500 字符，超出加 `…[truncated]` 后缀。
     - `toolName` 缺失（老 payload）且非 error -> 启发式：原 content > 1500 字符且匹配代码特征正则（`/(^|\n)\s*(import |export |function |const |class |interface |def |async |return )/` 或连续 4 行以上缩进） -> 按文件占位替换；否则截断到 1500。
   - `role==='user'` / `'assistant'` / `'system'`：content 原样保留，但单条超 4000 字符时截断到 4000 + `…[truncated]`（防单条超长 turn 吃满预算）。
2. **预算裁剪**（`estimateTokens`，`budgetTokens ?? DEFAULT_DISTILL_INPUT_BUDGET_TOKENS`）：
   - 优先级：`user` > `tool(isError)` > `assistant` > `tool(普通)` > `system`。同优先级内**近期优先**（数组靠后先留）。
   - 从最低优先级、最旧开始丢，直到总 token <= 预算。`user` 与 `tool(isError)` 在预算内必留（即使超预算也保留全部 user + error，仅从其余类别裁）。

### 3.4 `distiller.ts` 接入 + 提示词加固

- `distillTranscript` 在 `renderUserPrompt` 前调用 `filterTranscriptForDistill(input.turns)`，用过滤后的 turns 渲染。
- `DISTILLER_SYSTEM_PROMPT` 的 REJECT 段补一条："被开发仓库自身源码的实现细节（文件内容、内部实现、配置默认值、符号名）——可从源码重推导，不是记忆，REJECT。" 并在开头强调"优先提取用户或领域明确陈述的规则、决策与约束；不要总结 agent 读到的文件内容"。

### 3.5 valueFilter 修复（`src/memory/valueFilter.ts`）

**逻辑门**：新增纯函数

```ts
export function parseCategory(title: string): string | null
// 从 "[category:xxx] ..." 提取 xxx，小写；无前缀返回 null

export const VALUE_PROTECTED_CATEGORIES = new Set(['invariant', 'integration', 'compliance'])
```

`judgeValue` 拿到 LLM verdict 后，对每个候选：若 `VALUE_PROTECTED_CATEGORIES.has(parseCategory(c.title))`，**强制 keep**：`{keep:true, valueClass:'decision'}`。受保护类别不进 discard，无论 LLM 怎么判。

> valueClass 必须非 null 的硬性原因：Web UI 的"批量拒绝未评估"按钮（`App.tsx:152`）target `priorityRank(valueClass)===2`，即 `value_class IS NULL`（`App.tsx:17` priorityRank：decision/convention=0、trap/topology=1、null=2）。若受保护业务规则拿到 null，就会被一键批量清掉--与保护初衷相反。故统一映射 `decision`（rank 0，高优先级 + 免疫批量拒绝）。语义上业务硬规则也最接近"决策/约束"。后续若想细分 valueClass 可再迭代，v1 不做。

**提示词收紧**（`VALUE_JUDGE_SYSTEM_PROMPT`）：

- `derivable` 重定义："可从**本仓库当前源码/文档**不依赖本次对话重推导。**若候选描述的是被开发代码库自身的实现**（文件路径、函数/符号名、配置默认值、模块内部运作、文件内容），即使附带 rationale，也是 derivable。"
- `public-knowledge` 收紧："通用公开文档/标准约 10 秒可得（语言语法、stdlib、通用算法、公开标准）。**项目专属业务规则、合约、SLA 不是 public-knowledge。**"
- 显式条款："业务规则、invariant、集成合约、合规约束**永非** public-knowledge / derivable，必保留。"

### 3.6 dedup 修复（`src/memory/dedup.ts` + `src/scheduler.ts`）

**`scheduler.ts:tick` 顺序调整**：dedup 移到 valueFilter 之前。新流程：

```
load turns -> filterTranscriptForDistill -> distillTranscript (LLM) -> rawCandidates
  -> dedupCandidates (LLM, 同批+跨批) -> survivors
  -> judgeValue (逻辑门+提示词, LLM) -> keepWithClass + discarded
  -> logDiscards(discarded)
  -> createCandidate(each survivor, valueClass)
```

前置后不再需要现有"valueFilter 后用对象引用重挂 valueClass"的 hack（`scheduler.ts:147-150`）：survivors 先 dedup 再 classify，直接把 valueClass 写进 createCandidate。

**`judgeDuplicates` 扩展**：

- 比对集 = `[...existing, ...batchSiblings]`。同批候选用虚拟 id `new-${index}`。
- `DEDUP_SYSTEM_PROMPT` 改为要求：对每个 `new-i`，判断是否与"任意其他项"（existing 或 `new-j, j<i`）语义重复；`isDuplicate:true` 时 `duplicateOf` = 那个项的 id（existing 的真 id 或 `new-j`）。
- `renderUserPrompt` 输出 existing 行 + new 行（new 行带 `new-i` id）。
- `dedupShouldRetry` 校验放宽：`duplicateOf` 接受 existing id 或 `new-${number}`（且 `number < i`）。
- 保留逻辑：每个语义组只留**最早**的一条（`new-i` 若被判为某更早项的 dup -> 丢弃）。existing 的 dup -> 对应 new 丢弃。
- 保守兜底不变：LLM 失败 / 非法 verdict -> 该候选 `duplicate:false`（保留）。

`dedupCandidates`（`scheduler.ts`）的分组逻辑（按 scope 分组）不变；每组内调用扩展后的 `judgeDuplicates`。

## 4. 数据流

见 3.6 的新 tick 流程。关键变化点：

1. `makeLoadTranscript`（`daemon.ts`）不变，仍从 events 表读原始 turns。
2. `distillTranscript` 内部新增过滤步骤（在 `detectErrorSignals` 之前还是之后？——`detectErrorSignals` 应跑在**过滤前**的原始 turns 上，因为 tool 失败计数与 user 否定检测需要完整信号；过滤可能截断 user 内容影响否定性检测。所以 `distillTranscript` 顺序：`detectErrorSignals(input.turns)` -> `filterTranscriptForDistill(input.turns)` -> `renderUserPrompt(filtered)`）。**注意：`detectErrorSignals` 用原始 turns，`renderUserPrompt` 用过滤后 turns。**
3. `tick` 中 dedup / valueFilter 顺序互换（见 3.6）。

## 5. 与现有模块的耦合点

- `pure.ts`：`TranscriptTurn` 扩展会影响所有消费该类型的模块（distiller / dedup / valueFilter / daemon / tests）。新增字段可选，运行时兼容；测试需更新断言。
- `transcript.ts`：`parseTranscriptFile` 行为变更（tool_use 不再丢弃）。现有断言"tool_use 被跳过"的测试需改为"tool_use 与 tool_result 配对成带 toolName 的 tool turn"。
- `distiller.ts`：新增过滤调用 + prompt 改动。`distillShouldRetry` 不变（仍校验 `[category:]` 前缀）。
- `valueFilter.ts`：新增 `parseCategory` + 逻辑门 + prompt。`valueShouldRetry` 不变。
- `dedup.ts`：prompt + renderUserPrompt + shouldRetry 改动；`judgeDuplicates` 签名不变（仍 `(DedupInput) => DedupVerdict[]`），但 verdict 的 `duplicateOfId` 现在可能是 `new-j`。`scheduler.ts:dedupCandidates` 消费 verdict 时需识别 `new-j` 并丢弃对应候选。
- `scheduler.ts:tick`：重排 dedup/valueFilter 顺序，去掉 valueClass 重挂 hack。
- `server.ts` 捕获侧：**不动**（过滤在蒸馏侧）。新捕获的 payload 会带 toolName/toolInputPath（因 parseTranscriptFile 改了）；老 payload 没有，过滤函数兜底。

## 6. 失败模式

- **过滤函数异常**：纯函数永不抛（try/catch 兜底降级为截断/保留）。最坏情况返回原 turns（仅截断），不影响 distill。
- **配对错位**：transcript 里 tool_result 无前导 tool_use（异常格式）-> 游标缺失 -> 产出无 toolName 的 tool turn，走启发式。不影响其他 turn。
- **valueFilter 逻辑门误判**：`parseCategory` 对无前缀 title 返回 null -> 不受保护 -> 走原 valueFilter 逻辑。受保护类别被强制 keep，最坏是"多留了一条本可丢的"（用户可在 UI 拒绝），优于"误丢业务硬规则"。
- **dedup 同批误合并**：把两条本不重复的判为重复 -> 丢一条。保守兜底（LLM 失败全留）缓解；且 dedup 在 valueFilter 前，丢的是 raw 候选，不影响已入库记忆。可接受。
- **预算过小**：预算 12000 token 可能对小会话够、对大会话丢太多。`detectErrorSignals` 跑在过滤前，错误信号不丢；user turn 必留。最坏丢部分 assistant 叙述，可接受。
- **老 payload 兼容**：无 toolName 的 tool turn 走启发式，可能误把长命令输出当源码占位。影响有限（占位仍保留路径/行数信息），且新捕获数据不再有此问题。

## 7. 测试策略

CLAUDE.md 要求纯函数层足量覆盖 + 运行时层少量集成断言。

### 纯函数（重点）

- `filterTranscriptForDistill`（新 `tests/pure-transcript-filter.test.ts`）：
  - Read tool turn（非 error）-> content 替换为 `[file: 路径, 原文 N 行]`，源码不残留。
  - Read tool turn（isError）-> content 原样。
  - Bash tool turn -> 截断到 1500 + 后缀。
  - 老 payload（无 toolName）长内容 + 代码特征 -> 占位；长内容无代码特征 -> 截断。
  - 单条 user/assistant 超 4000 -> 截断。
  - 预算裁剪：超预算时从最旧、最低优先级丢；user 与 error 必留；近期优先于旧。
  - 永不抛（传 null / 异常输入 -> 降级）。
- `parseTranscriptFile` 配对（更新 `tests/transcript.test.ts` 或同类）：
  - assistant tool_use + 紧随 user tool_result -> 单个 tool turn，带 toolName + toolInputPath。
  - 多个 tool_use 顺序消费。
  - tool_result 无前导 tool_use -> 无 toolName 的 tool turn。
  - thinking 仍跳过。
- `parseCategory` + valueFilter 逻辑门（更新 `tests/value-filter.test.ts`）：
  - `[category:invariant]`/`[integration]`/`[compliance]` 候选，即使 LLM mock 返回 `derivable`/`public-knowledge`，也 keep，且 valueClass 严格等于 `'decision'`（非 null，免疫批量拒绝按钮）。
  - 其他类别不受门保护，正常 discard。
  - 无前缀 title -> null -> 不保护。
- `judgeDuplicates` 同批+跨批（更新 `tests/dedup.test.ts`）：
  - 同批两条同义（`new-0`/`new-2`）-> `new-2` 判为 `new-0` 的 dup -> 留 `new-0`。
  - 跨批：`new-0` 判为 existing id 的 dup -> 丢弃。
  - `duplicateOf` 接受 `new-j` 与 existing id。
  - 保守兜底：LLM 失败 -> 全留。

### 运行时 / 集成

- `tick` 顺序（更新 `tests/scheduler.test.ts` 或 `daemon.test.ts`，mock callLLM）：断言 dedup 在 valueFilter 之前调用；同批重复候选不进 valueFilter（valueFilter mock 调用次数 = dedup 后 survivor 数）。
- distiller 集成：mock callLLM，给一个含 Read 源码 turn 的 transcript，断言传给 LLM 的 user prompt 不含源码全文（含 `[file:` 占位）。

### 提示词源码层断言（兜底）

- `DISTILLER_SYSTEM_PROMPT` 含"被开发仓库自身源码的实现细节"REJECT 条款。
- `VALUE_JUDGE_SYSTEM_PROMPT` 含"项目专属业务规则…不是 public-knowledge"与"永非 derivable"条款。
- `DEDUP_SYSTEM_PROMPT` 含"同批兄弟"比对要求。

### 回归

- 现有 `bun test` 100 条全绿（更新因行为变更需要改的断言后）。
- `bun run typecheck` 干净。
