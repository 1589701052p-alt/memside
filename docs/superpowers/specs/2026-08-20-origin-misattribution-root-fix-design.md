# Origin 误标根治：捕获层来源归因（design spec）

- 日期：2026-08-20
- 分支：`worktree-fix-origin-misattribution`（PR 待开）
- 状态：设计阶段

## 1. 背景

memside 的「出处」（origin）是价值判定的承重字段：`user-stated` / `user-confirmed`
的候选享受 valueFilter 双重保护——derivable 免疫（`valueFilter.ts:157-158`）+ LLM 失败 /
幻觉兜底 `keep+decision`（`:150`、`:166-169`），即「永不自动丢弃」。这个保护的设计前提
是：**origin 准确反映候选内容是否来自真人陈述**。

### 事故（DB + 原始 transcript 双重实证）

live DB 候选 `01M0EMPV13JY139C35XJDD8JYP`「子代理任务报告的处理分支：
DONE/DONE_WITH_CONCERNS/NEEDS_CONTEXT/BLOCKED」，`origin=user-stated`、
`value_class=user-rule`、来自 distill job `01M0EKC0AGBAENJQ8KWS3E4PDQ`。

该 job 是一个 `/loop`（动态自调度）会话。dump 该 job 实际喂给蒸馏器的 45 个 turn，
关键证据在 turn 1/8/28/40，均为 `role:"user"`：

```
1  user  检查 Task 5 implementer (a11a0f3be1ceeb11c) 是否完成。若完成则处理
       report（DONE→生成 review package 派 task reviewer；...）
7  user  [1 prior /loop wakeup found nothing actionable; loop is healthy.]
```

turn 7 那句 `[N prior /loop wakeup ...]` 是 loop 框架自塞的注解，铁证这些 user 行
不是真人新输入，而是 **loop 框架在每次 ScheduleWakeup 唤醒时把同一条 loop prompt
机械重放成 user 行**。

dump 原始 transcript（`c48c0cd6-ccbd-4031-b443-3017b8200acf.jsonl`，211 个 user 行）
的 claude code 来源字段，taxonomy 完整：

| 来源特征 | 数量 | 是什么 |
|---|---|---|
| `origin.kind=human` + `promptSource=typed` | 6 | 真人陈述 |
| `promptSource=system` + `isMeta` | 20 | loop 重放 prompt + loop 注解 |
| `origin.kind=task-notification` + `promptSource=system` | 14 | task-notification XML |
| `isMeta=true`（其余） | 11 | 系统注入 / meta |
| `origin.kind=peer` + `promptSource=system` | 1 | peer-agent 消息（另一子 agent 回报） |
| `toolUseResult` 存在 | 159 | 工具结果（已被映成 `role:tool`，正确） |

**根因**：捕获层 `parseTranscriptFile`（`src/claude/transcript.ts:117`）把每个
`type:"user"` 行无脑映成 `role:"user"`，把 claude code 自带的来源字段（`origin.kind` /
`promptSource` / `isMeta`）全丢。蒸馏器看到 `[user] 检查 Task 5 implementer...`，合理
地判 `user-stated`；贴金防护（`distiller.ts:238`）只验 evidence 非空，而 evidence
确实在 user 行里逐字存在，防护通过——它没失职，它本就只验非空、不验说话人。
最终双重保护把 skill 派生 / 会话物流内容永久锁死，清不掉。

### 连带风险（已实测）

SessionStart 注入的记忆块会泄进 transcript 当 user 行（扫 200 个 transcript 文件命中
15 个）。这些行**连来源字段都没有**（`origin`/`promptSource`/`isMeta` 全空），即
claude 只标了 loop-replay，没标注入记忆块。后果：蒸馏器可能把自己上次注入的旧记忆
当新事实重新提炼成候选，闭环里产生自我复读的噪音候选。

### 已知 follow-up 同根

STATE.md「value-judge-prompt-accuracy」留的 follow-up #1「蒸馏器 origin 打标准确性
（C16 类：正文写'用户明确要求'却标 agent-observed）」是反向症状，都指向同一病根——
**蒸馏器没有可靠的说话人归因**。本 spec 从捕获层根治。

## 2. 目标 / 非目标

### 目标

1. 捕获层恢复 claude code transcript 的来源归因：真人 user 行保留 `role:"user"`，
   机器注入的 user 行（loop 重放 / 注入记忆 / task 通知 / peer / 其他 meta）重标
   `role:"system"`。
2. opencode 侧用内容 marker 兜底识别注入记忆块（无官方来源字段）。
3. 蒸馏器 origin discipline 加硬规则：只有 `[user]`（真人）行能锚定
   `user-stated`/`user-confirmed`；`[system]` 内容至多 `agent-observed`；注入记忆块
   不得当新规则重复提炼。
4. 代码兜底：过滤后输入若一条 `[user]`（真人）行都没有，强制把所有候选降级
   `agent-observed`，专治纯 loop 会话（本次 bug 场景）。
5. 系统注入内容在预算裁剪时优先丢弃（低价值），真人陈述永不丢（高价值）。

### 非目标

- **不回填存量**：DB 已有 2 条误标候选（task-report-triage ×2，`candidate` 状态）
  由用户在 Web UI 手动处置。本次只修前向。
- 不动 valueFilter 的双重保护逻辑本身（origin 一旦准确，保护就指向正确对象）。
- 不动 subagent 降级（`distiller.ts:241`，已有，正确——subagent role:user 是主 agent
  派发的 task brief，继续强制 agent-observed；本 spec 的捕获层标签是其补充而非替代）。
- 不动注入链路（`formatMemoryBlock` / SessionStart envelope）。
- 不做存量重判、不重跑历史 distill job。

## 3. 接口契约

### 3.1 `TranscriptTurn.role`（复用既有 `system` 槽）

`pure.ts:110` 的 `role` 联合已含 `'system'`，目前是空槽（无产出方）。本 spec 激活它：

```ts
export interface TranscriptTurn {
  role: 'user' | 'assistant' | 'tool' | 'system' | 'thinking'
  // ... 其余字段不变
}
```

**语义**：
- `user` = 真人陈述（claude: `origin.kind=human` 或 `promptSource=typed`，见 D2）。
- `system` = 机器注入的 user-position 内容（loop 重放 / 注入记忆块 / task 通知 /
  peer 消息 / 其他 meta）。保留内容供蒸馏器观察（agent-observed 记忆仍可能源自其中），
  但失去 `user-stated` 资格 + 预算裁剪优先丢弃。

### 3.2 claude 捕获层来源判定（`src/claude/transcript.ts`）

`parseTranscriptFile` 在映 `type:"user"` 行时，按下列**确定性、永不抛**规则判 role：

```
对每个 type:"user" 行（content 为字符串的分支）：
1. 若 content 含注入记忆块 marker（见 3.3）→ role: "system"。
2. 若该行有官方来源字段：
   - origin.kind === "human" 或 promptSource === "typed" → role: "user"（真人陈述）。
   - 否则 → role: "system"（含 task-notification / peer / 其他 system / meta）。
3. 若该行无官方来源字段（origin 与 promptSource 均缺席）：
   - 保守判 role: "system"（来源不明不能戴真人帽子）。
```

**关键决策 D1**：无来源字段的 user 行保守判 `system`。理由：注入记忆块恰好无字段（实测），
loop 框架的 prompt 重放有 `promptSource:system`，但真人陈述必有 `origin.kind=human`+`promptSource:typed`。
「无字段 = 机器生成」与实测一致，且宁可把极少数真人行误降级（agent-observed 仍可留为候选，
仅失双重保护），不可把机器行误升级成 `user`（错误享受删不掉保护，正是本次事故）。
方向性权衡：**误降级（可丢）优于误升级（锁死）**。

**关键决策 D2**：规则 2 用 OR（`origin.kind=human` **或** `promptSource=typed`）而非 AND。
实测两字段同现于真人行、机器行两字段皆非（promptSource=system / origin.kind=task-notification
等），OR 与 AND 在现有数据上分类完全一致；OR 对字段演进更鲁棒——未来版本若只带其中
一个字段（如 origin 结构调整），真人行不会因单字段缺席被误降级。OR 的理论风险（某类
机器行被标 promptSource=typed）在实测 200 文件中零出现，且被第三层代码兜底兜住。

**注意**：`toolUseResult` 行（工具结果，content 为 array）目前走 array 分支映成 `role:tool`，
本 spec 不动它——它们已经正确归类，不是 user-stated 资格来源。判定只作用于
`content` 为字符串的 user 行（真人 / loop / 注入记忆 / meta 纯文本）。

### 3.3 注入记忆块 marker（claude + opencode 共用）

`formatMemoryBlock`（`pure.ts`）产出的注入块用统一 marker（实测确认）：

```
## Learned context (auto-injected, advisory)

--- BEGIN INJECTED MEMORY ---
<记忆条目>
--- END INJECTED MEMORY ---
```

`isInjectedMemoryBlock(content)` 纯函数（新，置 `pure.ts`）：content 含
`--- BEGIN INJECTED MEMORY ---` 即 true。claude 捕获层与 opencode 捕获层共用，
是 opencode 侧唯一可用的来源信号（opencode 无官方来源字段）。

### 3.4 opencode 捕获层（`src/opencode/transcript.ts`）

`parseOpencodeMessages` 在映 `info.role === "user"` 的 text part 时：

```
对 user 角色的 text part：
1. 若 isInjectedMemoryBlock(text) → role: "system"。
2. 否则 → role: "user"（opencode 无官方来源字段，无法区分 loop 重放；
   注入记忆块是唯一可识别的机器注入来源）。
```

**已知局限**：opencode 的 loop 重放（若有）无字段可识别，会保留 `role:user`。
这是 opencode 无字段支持的客观限制，不是本 spec 引入的退化——opencode 侧
原本就全部当 user。本 spec 只在可识别处（注入记忆块）修对。

### 3.5 蒸馏器 prompt 硬规则（`DISTILLER_SYSTEM_PROMPT`）

origin discipline 段（`distiller.ts:28-35`）追加硬规则，明确 `[user]` / `[system]`
标签与 origin 的绑定关系：

```
- user-stated 只能锚定在 [user]（真人陈述）行的原话上。
- [system] 行的内容（loop 重放、注入的既有记忆块、task 通知、peer 消息）
  不是真人陈述，至多标 agent-observed。
- [system] --- BEGIN INJECTED MEMORY --- 块是你自己之前注入的旧记忆，
  不得当新规则重复提炼，不得作为 evidence 出处。
- 找不到原话出处仍不许标 user-stated / user-confirmed（既有贴金防护不变）。
```

`renderUserPrompt`（`distiller.ts:159`）已按 role 渲染 `[system] <content>`，零改动。

### 3.6 代码兜底（`parseDistillCandidates`，`distiller.ts`）

在贴金防护之后、subagent 降级之后，加「无真人行强制降级」：

```
const hasHumanUserTurn = input.turns（过滤前原始 turns）中是否存在 role === "user" 的 turn；
if (!hasHumanUserTurn) {
  对每个候选：origin = "agent-observed"（无论 LLM 标了什么）。
}
```

**数据来源**：用 `distillTranscript` 入参 `input.turns`（detectErrorSignals 同源的原始 turns）
判 `hasHumanUserTurn`，而非 `filteredTurns`——因为 filter 的预算裁剪可能丢掉真人行，
而「会话里有没有真人发言过」是 session 级事实，不该被预算裁剪影响判定。
（实测事故会话：真人 `[user]` 行根本不在 distill 的 turns 范围内——loop 跑时真人已离场，
turns 全是 `[system]`，此兜底一抓一个准。）

**放在哪一步**：`parseDistillCandidates(parsed, sourceKind, hasHumanUserTurn)` 加第三参，
默认 true（向后兼容：独立调用 / 旧测试无此参时不降级）。

## 4. 数据流

```
transcript JSONL
  ↓ parseTranscriptFile / parseOpencodeMessages
  ↓   真人 user 行 → role: "user"
  ↓   机器注入 user 行 → role: "system"（loop 重放 / 注入记忆 / task 通知 / peer / 无字段）
  ↓
TranscriptTurn[]（带正确 role）
  ↓ detectErrorSignals（读原始 turns；role:"system" 已有分支 pure.ts:140）
  ↓ filterTranscriptForDistill
  ↓   stripNoiseTurns：放宽 role 判断，连 system 行的 task-notification / compact 块也剔除
  ↓   budget 裁剪：turnPriority(user)=0 永不丢；system 落优先级 4 先丢
  ↓
renderUserPrompt → [user] <真人话> / [system] <机器话>
  ↓ distillTranscript（LLM 按 origin discipline 硬规则标 origin）
  ↓ parseDistillCandidates(parsed, sourceKind, hasHumanUserTurn)
  ↓   贴金防护（evidence 空 → 降级，既有）
  ↓   subagent 降级（既有）
  ↓   无真人行兜底（新：hasHumanUserTurn=false → 强制 agent-observed）
  ↓
DistillCandidate[]（origin 准确）
  ↓ judgeValue：只有 origin=user-stated/confirmed 享受双重保护
```

## 5. 与现有模块的耦合点

- **`pure.ts`**：新增 `isInjectedMemoryBlock` 纯函数；`stripNoiseTurns` 放宽 role
  判断（见 §7.2）；`turnPriority` / `detectErrorSignals` 已天然处理 system，零改动。
- **`claude/transcript.ts`**：`parseTranscriptFile` 的 user 行分支加来源判定。
- **`opencode/transcript.ts`**：`parseOpencodeMessages` 的 user text part 加注入块判定。
- **`distiller.ts`**：`DISTILLER_SYSTEM_PROMPT` 加硬规则；`parseDistillCandidates` 加
  `hasHumanUserTurn` 第三参 + 兜底；`distillTranscript` 透传 `hasHumanUserTurn`。
- **`valueFilter.ts`**：零改动（origin 一旦准确，双重保护指向正确对象）。
- **DB schema**：零迁移（`role` 是运行时内存字段，不落盘；transcript 入库的是
  `turns_json`，已解析后的 TranscriptTurn[]，新 role 自然进 turns_json，老行不受影响）。
- **subagent 降级**（`distiller.ts:241`）：保留不动，与新兜底叠加（subagent job
  hasHumanUserTurn 仍可能为 true，但 subagent 降级优先；二者叠加无害）。

## 6. 失败模式

1. **未来 claude 版本改来源字段名**：捕获层来源判定退化成"无字段 → system"保守路径。
   代码兜底（无真人行降级）仍兜住纯 loop 会话。prompt 硬规则仍约束 LLM。三层叠加任一
   层失守有余地。观测：distill runs 抽样 origin 分布异常时复核字段。
2. **opencode loop 重放无字段**：opencode 侧 loop 重放保留 `role:user`，可能仍误标。
   这是 opencode 无字段支持的客观限制；opencode 侧原本全当 user，本 spec 只在可识别处
   （注入记忆块）修对，不引入新退化。观测：opencode runtime 候选 origin 分布。
3. **真人行被误降级 system**（D1 保守判定的代价）：真人陈述失去双重保护，可能被
   valueFilter 判 derivable 丢掉。但「宁可误丢（用户可恢复 / 重派）不可误锁（删不掉）」
   是方向性权衡，与本次事故方向相反，可接受。观测：derivable 丢弃里有无真人陈述误伤。
4. **`hasHumanUserTurn` 用原始 turns 而非 filtered**：若用户担心 budget 裁剪丢真人行
   导致误判——已用 input.turns（过滤前）规避。纯 loop 会话 input.turns 本就无真人行，
   兜底正确触发。
5. **注入记忆块 marker 漂移**：`formatMemoryBlock` 改了 marker 会导致
   `isInjectedMemoryBlock` 失配。用源码层断言锁 marker（`--- BEGIN INJECTED MEMORY ---`），
   marker 变即红，强制同步。

## 7. 测试策略

测试首选可断言面：纯函数（`isInjectedMemoryBlock` / 来源判定逻辑 / `stripNoiseTurns` /
`parseDistillCandidates` 兜底）。运行时组件兜底用源码层文本断言。

### 7.1 `isInjectedMemoryBlock` 纯函数（`pure.ts`）
- 含 `--- BEGIN INJECTED MEMORY ---` → true。
- 含完整块（BEGIN + 内容 + END）→ true。
- 普通用户文本、loop 注解、task 通知 → false。
- 非 string 入参 → false（永不抛）。

### 7.2 `stripNoiseTurns` 放宽（`pure.ts`）
- 现状：只剔除 `role==="user"` 且含 task-notification / compact marker 的行。
- 改后：`role==="system"` 的同类内容也剔除（捕获层已重标 system，但防御性兼容老
  turns_json 行 + 双保险）。测试：system + task-notification → 剔除；user + 普通文本 → 保留；
  system + 普通文本 → 保留（供 agent-observed 观察，不剔除非噪声 system 内容）。

### 7.3 claude 捕获层来源判定（`claude/transcript.ts`）
用真实 transcript 结构的 fixture（基于实测 taxonomy），断言 role 映射：
- `origin.kind=human` + `promptSource=typed`（content 为字符串）→ `role:"user"`。
- 仅 `origin.kind=human`（promptSource 缺席，D2 OR 路径）→ `role:"user"`。
- 仅 `promptSource=typed`（origin 缺席，D2 OR 路径）→ `role:"user"`。
- `promptSource=system` + `isMeta`（loop 重放 prompt）→ `role:"system"`。
- `origin.kind=task-notification` → `role:"system"`。
- `origin.kind=peer` → `role:"system"`。
- 注入记忆块（无字段，content 含 marker）→ `role:"system"`。
- 无字段纯文本 → `role:"system"`（D1 保守）。
- `toolUseResult` 行（array content）→ 仍 `role:"tool"`（不变）。
- 解析器永不抛契约不变：缺字段 / 畸形 / 空 → 降级，不崩。

### 7.4 opencode 捕获层（`opencode/transcript.ts`）
- user text part 含注入记忆块 marker → `role:"system"`。
- user text part 普通文本 → `role:"user"`。
- assistant / tool / reasoning 不受影响。

### 7.5 蒸馏器 prompt 硬规则（`distiller.ts`）
源码层文本断言锁 `DISTILLER_SYSTEM_PROMPT` 含新硬规则文本（`[user]` 锚定 user-stated、
`[system]` 至多 agent-observed、注入记忆块不得重复提炼）。回归锁：marker 变即红。

### 7.6 代码兜底（`parseDistillCandidates`，`distiller.ts`）
- `hasHumanUserTurn=false`（纯 loop 会话 fixture，turns 全 system）→ LLM 标 user-stated
  的候选被强制降级 agent-observed。
- `hasHumanUserTurn=true` → origin 保留 LLM 标注（贴金防护仍生效，不变）。
- 第三参缺省（向后兼容）→ 不降级，旧测试语义不变。
- 贴金防护 + subagent 降级 + 无真人行兜底三者叠加顺序测试（互不干扰）。

### 7.7 既有回归
- 现有 distiller / valueFilter / scheduler 测试全绿（origin 准确化不破既有行为；
  真人 user 行仍 `role:"user"`，origin 仍可标 user-stated）。
- e2e 闭环锁（fixture 带真人 user 行）断言 `[user]` 抵达蒸馏器；新增 fixture 带
  loop 重放 system 行断言 `[system]` 抵达 + origin 降级。

### 7.8 运行门槛
`bun run typecheck && bun test` 必须全绿才能 push（PowerShell 5.1 不支持 `&&`，
该命令链在 Bash 工具中执行）。

## 8. 上线后观测（硬要求，结论回填）

1. 新会话产出的候选 origin 分布：`user-stated`/`user-confirmed` 是否只锚定真人陈述，
   loop 会话不再产出 user-stated 标的 skill 派生 / 会话物流候选。
2. 注入记忆块不再被当新规则重复提炼（候选标题与既有记忆重复率下降）。
3. derivable 丢弃里有无真人陈述误伤（D1 保守判定代价观测）。
4. 与本次事故同形态（/loop 驱动、promptSource=system）的新会话，候选 origin 是否
   正确降级 agent-observed。
