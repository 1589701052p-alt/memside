# Thinking 捕获 + 工具名渲染修复 — 设计 spec

日期：2026-08-09
分支：`feat/thinking-capture`
状态：已批准（brainstorming 三节设计逐节用户确认）

## 1. 背景与诊断

memside 的蒸馏输入存在两类信号缺口：

1. **AI 思考内容被整体丢弃**（用户判定「这很致命」）：
   - claude code 路径：`parseTranscriptFile`（`src/claude/transcript.ts:152`）刻意跳过
     `{type:'thinking'}` 块，JSDoc 理由是「内部推理会污染 retry 检测」。
   - opencode 路径：`parseOpencodeMessages`（`src/opencode/transcript.ts:54`）的
     `reasoning` part 走 default 分支被过滤。
   - 后果：2026-07-29 origin discipline 放宽后「agent 说过且被用户采纳的 rationale
     可记，但必须能在 transcript 找到原话出处」——thinking 正是 rationale 的主要
     载体，distiller 却永远看不到它，只能靠 assistant 正式回复碰巧复述的部分。
2. **工具名在蒸馏输入里全是 `[tool]`**：`parseTranscriptFile` 配对 tool_use↔tool_result
   时已把真实工具名存到 `toolName` 字段，但 `renderUserPrompt`
   （`src/memory/distiller.ts:137`）只渲染 `[${t.role}]`，LLM 分不清 Read/Bash/Edit，
   也看不懂「为什么有的 tool 保留正文、有的只有一句话」（三档压缩策略的语义对 LLM
   不可读）。Web 原始输入遮罩（`src/web/ui-utils.ts:43`）同样只显示 `tool`。

**用户裁决**：thinking 是 LLM 输出的一部分，信息量高，**与其他正式输出同等对待**
（同单条 cap、同预算优先级）；两个 runtime 都要改；工具名渲染修复纳入本次范围；
三档压缩策略本身（文件占位 / 3000 截断 / 错误原文）逐字不动。

## 2. 目标 / 非目标

### 目标

- G1：`TranscriptTurn.role` 加 `'thinking'`，两个 runtime 的 thinking/reasoning 内容
  进入蒸馏管线，与 assistant 正式输出同等对待（同 cap、同预算优先级），但身份可区分。
- G2：retry 检测不受 thinking 污染（结构性保证，非特判）。
- G3：蒸馏 prompt 与 Web 原始输入遮罩渲染真实工具名（`[tool:Read]`），压缩策略
  语义对 LLM 与用户可读。
- G4：任何字段名漂移 / 畸形输入的降级不得比现状更差（跳过即现状）。

### 非目标

- 不改三档压缩策略（文件类占位 / 非文件 3000 字符 / 错误原文）。
- 不改蒸馏预算（64000 token）与 cap 数值（20000 字符）。
- 不改 origin discipline 的 REJECT 规则与 JSON 模板，只加 thinking 说明文本。
- thinking 提炼结果不直接进注入块（注入内容仍由 distiller 候选 + 人工审批决定）。
- 不做 thinking 与 assistant 的区别定价/优先级（同等对待；未来要调只改
  `turnPriority` 一处）。
- 不处理 events 表体积清理（STATE.md 已知债务 #1，独立 issue）。

## 3. 已验证的事实（实现前取证，不靠记忆）

- claude code thinking 块形状（真实 transcript
  `~/.claude/projects/D--A03-MyProject-agent-workflow/*.jsonl` 取证）：
  `{"type":"thinking","thinking":"<文本>","signature":"..."}`，文本字段名 `thinking`。
  该文件无 `redacted_thinking`，但其无可读文本，解析按跳过处理。
- opencode reasoning part 形状（本机 `~/.local/share/opencode/opencode.db`
  `part` 表取证）：`{"type":"reasoning","text":"<文本>","time":{...}}`，
  文本字段名 `text`。
- Web 边界 `SourceTurn.role`（`src/web/api.ts:141`）是宽松 `string`，
  新增 role 无需跨层类型迁移。
- 滚动 digest（`src/memory/contextDigest.ts:24`）工具行已是
  `[tool: ${t.toolName ?? 'unknown'}]` 格式，无需改动。

## 4. 设计

### 4.1 类型与解析（方案 A：新 role）

`TranscriptTurn.role` 联合加 `'thinking'`（`src/memory/pure.ts:110`）。

**claude code**（`src/claude/transcript.ts`）：assistant 行 content 数组中
`it.type === 'thinking' && typeof it.thinking === 'string'` →
`turns.push({ role: 'thinking', content: it.thinking })`，按文件出现顺序原位插入
（thinking 通常排在该消息 text 之前，时序自然保持）。`redacted_thinking` 及
缺文本字段的块跳过。JSDoc 中「thinking is SKIPPED」段落更新为新行为与理由
（retry 污染顾虑由独立 role 结构性消除）。

**opencode**（`src/opencode/transcript.ts`）：`p.type === 'reasoning' &&
typeof p.text === 'string'` → `{ role: 'thinking', content: p.text }`，
挂到所属 assistant 消息的 turns 序列位置。`OpencodePart` 判别联合加
`{ type: 'reasoning'; text: string }` 成员。其余 part 过滤不变。

### 4.2 下游消费点矩阵（同等对待）

| 消费点 | 行为 | 改动 |
|---|---|---|
| `detectErrorSignals`（`pure.ts:129`） | retry/否定/失败计数只看 assistant/user/tool/system；thinking 自动排除 | 无（回归测试锁定） |
| `filterTranscriptForDistill` 单条 cap（`pure.ts:268`） | thinking 走非 tool 分支 → 20000 字符截断 | 无（自动落入） |
| `turnPriority`（`pure.ts:245`） | thinking = 2（与 assistant 同级） | 加一行 |
| `renderUserPrompt`（`distiller.ts:137`） | thinking → `[thinking] ...`；tool 见 §4.3 | 改渲染函数 |
| `contextDigest`（`contextDigest.ts:22-24`） | 加 `THINKING: ...` 行，同 `DIGEST_LINE_MAX_CHARS` 截断 | 加两行 |
| Web 遮罩 `formatSourceTurn`（`ui-utils.ts:40`） | thinking → `{ label: 'thinking', color: '#6a1b9a' }`（紫） | 加一行 |

### 4.3 工具名渲染修复

**蒸馏 prompt**（`distiller.ts` `renderUserPrompt`）：
`role==='tool' && toolName` 存在 → `[tool:${toolName}] ${content}`；
否则保持 `[tool] ${content}`（老 payload / 未配对结果兜底不变）。
thinking → `[thinking] ${content}`。其余 role 渲染不变。

**Web 遮罩**（`ui-utils.ts:43`）：tool 且带 toolName → label `tool:${toolName}`
（如 `tool:Read`）；配色逻辑（error 红 / 普通灰）不变。

压缩策略三档（`compactToolTurn`）逐字不动；本次只让「压成了什么」可读。

### 4.4 distiller prompt 增补

`DISTILLER_SYSTEM_PROMPT` 加一段说明（只加文本，不动 REJECT 规则 / JSON 模板 /
origin / evidence 契约）：

> `[thinking]` 是 agent 未对用户展示的内部推理。它可以作为 rationale 的「原话
> 出处」证据（evidence 可摘 thinking 原文）；但仅在 thinking 中出现、未在对话
> 浮现也未被用户采纳的推理，仍按 origin discipline 不得提取为候选。

### 4.5 数据流

```
claude transcript JSONL ──parseTranscriptFile──┐
                                                ├─► TranscriptTurn[]（含 thinking）
opencode messages ──parseOpencodeMessages──────┘         │
              ┌──────────────────────────────────────────┤
              ▼                                          ▼
   detectErrorSignals（原始 turns，          filterTranscriptForDistill
   thinking 自动排除）                        （cap 20000 / 预算 64000，
              │                               thinking 优先级=assistant）
              │                                          │
              └──────────► renderUserPrompt ◄────────────┘
                         [thinking] / [tool:Read] 标签
                              │
                              ▼
                         LLM distiller（prompt 含 §4.4 说明）
```

events payload 与 source input 快照随之包含 thinking 文本（截断后），DB 体积
增速上升——如实声明，纳入 §7 观测回填。thinking 仅存本地 DB，不出本机，与现有
transcript 存储同级。

## 5. 失败模式与降级

| 失败模式 | 行为 |
|---|---|
| claude code 升级致 `thinking` 字段改名/变形 | 取不到字符串即跳过该块 → 降级为现状（无 thinking），永不抛 |
| opencode reasoning part 形态不符 | 走 default 跳过（现状） |
| thinking 体积膨胀 | 单条 20000 cap + 64000 预算兜底；超预算时与 assistant 同序（最老先丢），user/错误必留 |
| prompt 增补致 LLM 过度提取 thinking | 既有 origin 门禁 + 人工审批兜底；prompt 文本仅说明性，不改规则 |
| subagent transcript 含 thinking | 同 parser 自动捕获；subagent origin 强制降级（2026-07-31）不受影响 |

## 6. 测试策略（纯函数层为主）

1. `tests/transcript.test.ts`：thinking 块 → thinking turn（位置时序保持）；
   `redacted_thinking` / 缺 `thinking` 字段块跳过；retry 检测回归——含 thinking
   turns 时 assistant 重试计数不变。
2. `tests/opencode-transcript.test.ts`：reasoning part → thinking turn；
   缺 `text` / 畸形 part 跳过不抛。
3. `tests/pure-transcript-filter.test.ts`：`turnPriority` thinking=2；thinking 走
   20000 cap；预算裁剪时 thinking 与 assistant 同级同序丢弃。
4. `tests/distiller.test.ts`：渲染行 `[thinking] …` / `[tool:Read] …` /
   无 toolName 兜底 `[tool] …`；SYSTEM_PROMPT 含 thinking 说明的源码层文本断言。
5. contextDigest 测试：`THINKING:` 行渲染 + `DIGEST_LINE_MAX_CHARS` 截断。
6. `tests/ui-*`：`formatSourceTurn` thinking label/配色 + `tool:Read` label。
7. e2e fixture：补带 thinking 块的 transcript 走 distill 闭环，断言不受影响。

回归防护命名：测试文件/describe 标题标明锁的是「thinking 捕获」与「工具名渲染」
两类回归。运行门槛：`bun run typecheck && bun test` 全绿。

## 7. 观测回填（合并进 STATE.md 既有「上线后观测」清单）

- thinking turn 占蒸馏输入的比例（distill runs 抽样）；
- events 表体积增速变化（对比 92MB 基线，STATE.md 已知债务 #1）；
- 含 thinking 出处（evidence 摘自 thinking）的候选质量——人工审批抽样；
- LLM 是否对 thinking 过度提取（候选 origin=agent-observed 且 evidence 仅出自
  thinking 的占比）。
