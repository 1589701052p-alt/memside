# 工具调用信息捕获 - 设计 spec

日期：2026-08-09
分支：`feat/tool-call-capture`
状态：已批准（brainstorming 三节设计逐节用户确认）

## 1. 背景与诊断

接 thinking 捕获 PR #54 之后，工具名渲染修复让 distiller 看到 `[tool:Read]` 标签，
但**工具调用的 input（调用本身）仍被整体丢弃**：

- claude code：`parseTranscriptFile`（`src/claude/transcript.ts`）配对 tool_use↔tool_result
  时只从 `tool_use.input` 提取 `toolName` 与 `toolInputPath`，其余字段（Bash 的
  `command`、Grep 的 `pattern`、Agent 的 `description`/`prompt` 等）全部丢弃。
- opencode：`parseOpencodeMessages`（`src/opencode/transcript.ts`）按 callID 记
  `toolName`，同样不取 `input`。

后果：distiller 看到一段工具结果（如测试输出），却不知道是哪条命令跑出来的--
"bash 命令执行了什么"等调用意图信息缺失。origin discipline 的 rationale 出处、
踩坑证据高度依赖调用本身，信号缺口真实存在。

**已取证的真实 input 形状**（本机 transcript）：

| 工具 | claude input 形状 | opencode input 形状 | 信号价值 |
|---|---|---|---|
| Bash | `{command, description}` | （走 callID） | 命令是踩坑/流程记忆核心证据 |
| Grep | `{pattern, path, -n, output_mode, ...}` | `{pattern}` | agent 在找什么 |
| Glob | `{pattern}` | `{pattern}` | 同上 |
| Read | `{file_path}` | `{filePath}` | 已被 toolInputPath 覆盖 |
| Edit | `{file_path, old_string, new_string}` | - | old/new 可能很大 |
| Write | `{file_path, content}` | - | content 可达几十 KB |
| Agent/Task | `{description, prompt, model}` | - | prompt 可达几千字 |

**核心张力**：体积差异巨大--Bash 命令几十字（全宝），Write content 几十 KB（全垃圾，
文件在仓库里翻代码就有）。全量捕获会重演"tool I/O 吃掉 98% 预算"事故（PR #13 修过）。

## 2. 目标 / 非目标

### 目标

- G1：`TranscriptTurn` 加 `toolCall?: string` 字段，捕获工具调用的 input（紧凑 JSON
  字符串），单条截断 300 字（常量 `TOOL_INPUT_CAP_CHARS`）。
- G2：全链路呈现：蒸馏 prompt 两段式（`调用: {...}` + `结果: ...`）+ digest tool 行
  带调用摘要（截 100 字）+ Web 原始输入遮罩展示调用。
- G3：预算诚实化--`filterTranscriptForDistill` 计量含 toolCall，否则 300 字 × N 个
  工具调用会绕过 64000 token 预算。
- G4：任何 input 缺失 / 畸形 / 非对象的降级不得比现状更差（无 toolCall 即现状）。
- G5：无按工具特判（一刀切）--新工具 / 字段名变更自动覆盖。

### 非目标

- 不改三档压缩策略（`compactToolTurn`：文件类占位 / 非文件 3000 字符 / 错误原文）--
  它只作用于 content，不影响 toolCall。
- 不改蒸馏预算（64000 token）与 thinking cap（20000 字符）。
- 不做按工具的精华提取表（YAGNI，新工具会漏）。
- 不改 origin discipline / REJECT 规则 / JSON 模板。
- 不改 schema（无迁移）。

## 3. 已验证的事实（实现前取证，不靠记忆）

- claude code `tool_use` 块形状：`{type:'tool_use', id, name, input:{...}}`，
  input 为对象（取证：Bash `{command, description}`、Grep `{pattern, path, -n, output_mode}`、
  Edit `{file_path, old_string, new_string}`、Write `{file_path, content}`、Agent
  `{description, prompt, model}`）。
- opencode tool part 的 input：取证 `glob => {pattern}`、`read => {filePath}`，形状
  与 claude 类似（部分工具字段名 camelCase 差异）。
- 现有 FIFO 配对：claude `pendingToolUses`（`transcript.ts:93,124-134`）已从
  `tool_use.input` 提 `toolInputPath`；opencode 按 callID 记 `toolName`
  （`transcript.ts:27-36`）。两者都有现成的 input 访问点。
- Web 边界 `SourceTurn`（`src/web/api.ts:140-146`）是宽松类型，加字段无需跨层迁移。
- digest 已有先例：`DIGEST_LINE_MAX_CHARS = 300`（`contextDigest.ts:5`），tool 行
  当前 `[tool: ${toolName ?? 'unknown'}]`。

## 4. 设计

### 4.1 数据模型与捕获（一刀切 + 截断）

`TranscriptTurn` 加字段（`src/memory/pure.ts:109-117`）：

```ts
export interface TranscriptTurn {
  role: 'user' | 'assistant' | 'tool' | 'system' | 'thinking'
  content: string
  isError?: boolean
  toolName?: string
  toolInputPath?: string
  /** 工具调用信息（input 紧凑 JSON，捕获时截 300 字）。无则缺失（老 payload/无 input）。 */
  toolCall?: string
}
```

常量（`pure.ts`）：

```ts
export const TOOL_INPUT_CAP_CHARS = 300
```

**claude code**（`parseTranscriptFile`）：`pendingToolUses` 项类型从
`{ name: string; inputPath?: string }` 扩为 `{ name: string; inputPath?: string; call?: string }`。
处理 `tool_use` 块时，除现有 `extractToolInputPath`，新增：把整个 `input` 对象
`JSON.stringify` 后截 300 字存入 `call`（截断加 `…[truncated]` 后缀，与既有 `truncate`
风格一致）。配对消费时落到 tool turn 的 `toolCall`。

**opencode**（`parseOpencodeMessages`）：第一遍扫描记 `toolName` 时，同步把 `input`
stringify+截 300 存入 Map（key=callID）。第二遍生成 tool turn 时带上。

**降级**：input 非对象 / 缺失 -> `call` 不设置（跳过），与既有"取不到即跳过"一致；
解析器永不抛契约不变。老 payload 无 `toolCall` -> 全链路走无调用分支，向后兼容。

### 4.2 全链路呈现

**蒸馏 prompt**（`renderUserPrompt`，`distiller.ts:137`）：tool turn 渲染为两段式--

```
[tool:Bash] 调用: {"command":"bun test","description":"跑测试"}
结果: <原 content（三档压缩不动）>
```

无 `toolCall` 时保持现状单行 `[tool:Name] <content>`（逐字节兼容）。三档压缩策略仍
只作用于 content，toolCall 不受影响（捕获时已截 300）。

**预算诚实化**（`filterTranscriptForDistill`，`pure.ts:270-281`）：预算计量
`used()` 与丢弃循环从 `estimateTokens(t.content)` 改为
`estimateTokens(t.content) + estimateTokens(t.toolCall ?? '')`。优先级/丢弃顺序不变
（turnPriority 不动）。`compactToolTurn` 不动（它只压 content）。

**滚动 digest**（`buildDeterministicDigest`，`contextDigest.ts:24`）：tool 行升级--

```
[tool: Bash] {"command":"bun test"}(截 100 字)
```

新常量 `DIGEST_TOOL_CALL_MAX_CHARS = 100`（digest 全篇 3000 字，比 prompt 紧）。
无 toolCall 时保持 `[tool: 名字]`。

**Web 遮罩**：`SourceTurn`（`web/api.ts:140-146`）加 `toolCall?: string`；蒸馏记录
modal 的原始输入 tool 行在 content 前附一行调用展示（沿用现有行渲染结构，不新增
样式框架）。`formatSourceTurn` 的 label/color 逻辑不动。

### 4.3 数据流

```
claude tool_use {input} ──parseTranscriptFile──┐  (stringify+截300 -> toolCall)
opencode tool part {input} ──parseOpencodeMessages──┘
              │
              ▼
   TranscriptTurn[]（含 toolCall）
              │
   ┌──────────┼──────────┐
   ▼          ▼          ▼
detectErrorSignals  filterTranscriptForDistill  buildDeterministicDigest
（不含 toolCall）     （计量含 toolCall；       （[tool:Name] <截100字>）
                       压缩不动）
              │
              ▼
   renderUserPrompt
   [tool:Name] 调用: {...}
   结果: <content>
              │
              ▼
   LLM distiller
```

### 4.4 与 thinking 捕获的关系

两者正交：thinking 是 assistant 行的内部推理块（role 扩展）；toolCall 是 tool turn
的调用信息（字段扩展）。同一 tool turn 可同时有 toolCall 与压缩后的 content，互不
干扰。预算计量两者都计入（thinking 走 content、toolCall 走 toolCall）。

## 5. 失败模式与降级

| 失败模式 | 行为 |
|---|---|
| input 缺失 / 畸形 / 非对象 | toolCall 不设置，全链路走无调用分支（= 现状），永不抛 |
| stringify 后超 300 字 | 捕获时截断（Write content 头部垃圾天然被掐），加 `…[truncated]` |
| 未配对的 tool_use | 与现状一致：不入 pending 消费，不产 turn |
| 预算膨胀 | 300 字/条 × 工具数计入 64000 预算（§4.2 诚实化），超预算时随 turn 按既有优先级丢弃 |
| subagent transcript | 同 parser 自动获得 toolCall；subagent origin 强制降级不受影响 |
| input 含循环引用 / bigint | JSON.stringify 抛 -> catch 降级不设 toolCall（永不抛契约） |

## 6. 测试策略（纯函数层为主）

1. `tests/transcript.test.ts`：Bash tool_use input -> 配对 tool turn 带 toolCall
   （含 command）；input 缺失/非对象 -> 无 toolCall；超 300 字 input 被截断（含后缀）。
2. `tests/opencode-transcript.test.ts`：tool part 带 input -> toolCall；缺 input ->
   无；截断同理。
3. `tests/pure-transcript-filter.test.ts`：预算计量含 toolCall（构造大 toolCall 证明
   确实计数）；turn 被压缩/丢弃时 toolCall 随 turn 整体走。
4. `tests/distiller.test.ts`：渲染两段式 `调用: {...}` + `结果: ...`；无 toolCall 时
   输出与旧格式逐字节一致（向后兼容锁）。
5. `tests/context-digest.test.ts`：`[tool: Bash] <截 100 字>` 与无 toolCall 兜底。
6. `tests/e2e.test.ts`：fixture 加一组 Bash tool_use+tool_result，断言
   `调用: {"command"...` 抵达 distiller 输入（闭环锁）。
7. Web：`SourceTurn` 类型加字段；渲染走既有结构（源码层文本断言兜底）。

回归防护命名：测试 describe 标题标明锁的是「工具调用信息捕获」。运行门槛：
`bun run typecheck && bun test` 全绿。

## 7. 观测回填（并入 STATE.md 既有清单）

- events 表体积增速变化（toolCall 入快照，每条 tool turn 至多 +300 字）；
- 蒸馏候选中 evidence 引自命令调用（`调用:` 行）的质量抽样；
- distill runs 抽样：toolCall 占蒸馏输入的比例。
