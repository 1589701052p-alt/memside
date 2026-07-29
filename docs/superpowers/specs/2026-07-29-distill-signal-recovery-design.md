# 蒸馏输入信号丢失（三层治）- 设计 spec

分支：`feat/distill-signal-recovery`（基线 `origin/master`）
日期：2026-07-29
状态：设计待审

## 背景

memside 的 distill 管线在三个环节把记忆信号丢光，导致 brainstorming / 设计类会话只能提取出 trivial 记忆（例：一键启动脚本会话，27 turn，最终只产出一条"需要同时覆盖生产与开发两种模式"）。三层根因均经源码核实：

- **第一层（subagent 不可见）**：`src/server.ts:113` 对 `SubagentStop` 早返回 202 不蒸馏，注释（`server.ts:110-112`）称其 transcript_path 指向主会话、无独有价值。但 subagent 的内部对话（推理、探索、发现）单独存于 `~/.claude/projects/<slug>/<sid>/subagents/agent-<agentId>.jsonl`，memside 从不读取。已在本机验证该目录结构与文件真实存在（含 memside 自身项目的多个 subagent 文件）。
- **第二层（过滤压细节）**：`src/memory/pure.ts:231-232` 把 Read/Edit/Write 结果替成 `[file: 路径, 原文 N 行]` 占位；`pure.ts:235` 其它工具结果截 3000 字；`pure.ts:268` user/assistant 文本截 8000 字。设计讨论里 agent 的方案对比与 rationale 是长段 assistant 文本，8000 字易腰斩。
- **第三层（origin discipline 与 architecture 类别自相矛盾）**：`src/memory/distiller.ts:56-65` 的 Origin discipline REJECT 第 3 条"agent 给出的建议或方案"与第 6 条"agent 推理链（即使被用户采纳也不记）"；但 `distiller.ts:15-16` 又要 `[category:architecture]` 提取带 rationale 的设计决策。brainstorming 会话里 rationale 全是 agent 产出，按起源判定该 REJECT、按 architecture 又该提取，模型只能取用户字面决策。此 origin discipline 系 2026-07-27 fix6（`STATE.md:199`）为治脑补记忆特意加。

三层中**第三层是主因**：即便信号已在过滤后的输入里，prompt 也叫模型把 rationale 丢掉。第一、二层是采集与截断问题，决定"有多少信号能到模型眼前"。

## 目标

让设计 / brainstorming 会话能提取出富记忆（设计 rationale、被采纳的设计决策、subagent 任务产出的推理），**同时不重新放开脑补 / 过度捕获**。

## 非目标

- 不改 valueFilter、taming 检测、dedup（它们作用于候选产出之后，与输入侧无关）。
- 不改注入侧（SessionStart 注入逻辑不动）。
- 不做"subagent 独立 sourceKind 的独立注入策略"——subagent 产出的记忆仍按现有 project/global scope 注入，只是来源标记不同。
- 不引入 LLM 文件摘要层（过度工程，且新增脑补面）。

## 接口契约与数据流

### 第三层：origin discipline 重平衡（distiller.ts）

改写 `DISTILLER_SYSTEM_PROMPT` 的 Origin discipline 段（`distiller.ts:56-65`）：

- **第 3 条「agent 给出的建议或方案」**：放宽为——transcript 里 agent 真的说过的设计建议、方案、rationale，且与用户最终决策方向一致，**可记**。仍 REJECT：transcript 里没有、模型自己补出来的。
- **第 6 条「agent 推理链，即使被用户采纳也不记」**：改写为——agent 自言自语的推理过程不记；但 agent 给出的、且被用户采纳的设计 rationale **可记**。
- **第 1 条「模型自己推出的结论/推断」**：维持 REJECT（脑补闸门）。
- **第 2、4、5 条**（前瞻计划 / 丰富化用户原话 / 道听途说）：维持 REJECT。

新增硬约束写入 prompt：「记 rationale 时必须能在所给 transcript 中找到 agent 原话出处；找不到出处的不记。」此约束是脑补兜底，使"agent 讲过就算"（用户已选的放宽线）不滑向"模型自己编"。

判定由 LLM 在蒸馏时做（依赖 transcript 内容，无法纯函数化）。最终脑补兜底仍有人工审批闸门（candidate → approve）。

### 第一层：subagent 单独蒸馏（server.ts + scheduler.ts + schema.ts）

**采集触发**：`SubagentStop` 钩子不再早返回（删 `server.ts:113` 的 early-return）。SubagentStop 的 stdin payload 含 `agent_id`（已核实：官方文档确认 SubagentStop 带 `agent_id`、`transcript_path`、`session_id`、`cwd` 等字段；`agent_id` 即 subagent 文件名 `agent-<agentId>.jsonl` 中的标识）。

**定位 subagent 文件**：新增纯函数 `subagentFilePathFromPayload(transcriptPath, agentId)`：
- 从 `transcriptPath`（主会话 `<slug>/<sid>.jsonl`）推出 `<slug>/<sid>/` 目录（去末尾 `.jsonl` 当目录名）。
- 拼 `subagents/agent-<agentId>.jsonl`。
- `agentId` 为空或 `transcriptPath` 非 `.jsonl` → 返回 null。

**读取策略**（双路兜底，因文档未 100% 坐实 SubagentStop 的 transcript_path 指主会话还是 subagent 自己）：
1. 优先用 `subagentFilePathFromPayload` 推出的路径读 subagent 自己的文件。
2. 推不出或读不到 → 退回直接用 payload 的 `transcript_path`。
3. 都读不到 → 空 turns，仍 enqueue（与 Stop 分支一致：保留捕获信号，不丢事件）。

subagent 文件格式与主会话一致（已验证：`type:user/assistant` + `message.content` + `tool_use`/`tool_result`），直接复用 `parseTranscriptFile`。

**蒸馏隔离**：每个 subagent 文件 = 一个独立蒸馏任务，产出各自的候选记忆。主会话 Stop 蒸馏**保持对 subagent 内容不可见**（主 agent 视角只关心 subagent 回了什么，不关心它怎么干）。Stop 分支不再回头扫 subagent 目录——subagent 已在各自 SubagentStop 时蒸完。

**sourceKind 标记与传递链**：`memories.source_kind` enum 增加 `'subagent'`（schema.ts:16-18）。传递链：SubagentStop 分支 enqueue 时给 job 带上 `source_agent_id`（见下）-> scheduler `tick` 判断 `job.source_agent_id` 非空 -> 非空则 `createCandidate` 传 `sourceKind: 'subagent'`，否则维持 `'conversation'`（替换 scheduler.ts:180 的硬编码）。

**agentId 落库**：`memory_distill_jobs` 增加可选列 `source_agent_id text`（subagent 蒸馏任务填 agent_id，主会话任务为 null）。溯源时据此知道"这条记忆来自哪个 subagent 干的任务"。memories 表不冗余存 agentId：通过 `distillJobId` 关联到 job 的 `source_agent_id` 即可。

**与增量蒸馏的关系**：scheduler 现有第五轮增量逻辑（`scheduler.ts:122-132`，按 sessionId + lastTurnOffset 切片）只适用于主会话。subagent 蒸馏任务**绕开增量**：subagent 是一次性任务，无"上次蒸馏到哪"的概念，其 loadTranscript 直接返回该 subagent 文件全量 turns、fullLength = turns 长度、不更新 session offset。判定方式：job 有 `source_agent_id` → subagent 任务 → 走全量路径；否则走原增量路径。

### 第二层：过滤放宽（pure.ts）

- **assistant 文本上限调高**：`NON_TOOL_CAP_CHARS`（`pure.ts:210`）当前 8000，调为 **20000**。设计/brainstorming 的 rationale 主要在 assistant 文本，放宽后配合第三层放开 origin discipline，rationale 才进得了候选。user 文本沿用同一常量（`pure.ts:268` 对非 tool 一律用 `NON_TOOL_CAP_CHARS`），故 user 也变 20000——可接受（user 文本通常远短于上限，调高不产生副作用，且省得分两个常量）。
- **subagent 文件按主会话同套过滤**：subagent turns 走 `filterTranscriptForDistill`，assistant 文本用调高后的上限，文件类工具结果仍压占位（不变），其它工具结果截断。
- **不动**：文件类工具结果压占位（设计正确，文件内容可从仓库重读）；预算裁剪机制（总预算超限按优先级丢，user/error 必留，兜底防喂爆）。

## 与现有模块的耦合点

- `src/server.ts`：SubagentStop 分支由 early-return 改为真正处理（enqueue + 落 events），参照 Stop 分支的 fire-and-forget IIFE 模式。
- `src/scheduler.ts`：`tick` 的 loadTranscript 调用需区分主会话（增量）与 subagent（全量）；`createCandidate` 的 `sourceKind` 由硬编码 `'conversation'` 改为按 job 类型决定（subagent job → `'subagent'`）。
- `src/memory/distiller.ts`：仅改 system prompt 文本，不动 `distillTranscript` 逻辑、不动 `DistillCandidate` 接口。
- `src/memory/pure.ts`：改一个常量值 + 可能拆分 user/assistant 上限（见上，倾向不拆）。
- `src/db/schema.ts` + `src/db/client.ts`：`source_kind` enum 加 `'subagent'`；`memory_distill_jobs` 加 `source_agent_id` 列。幂等 migration（CREATE TABLE IF NOT EXISTS 风格无列增删风险——但 enum 扩展与加列需按现有 dual-registration 模式处理：drizzle schema map + raw DDL，加列用 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 兼容旧库）。
- `src/claude/transcript.ts`：`parseTranscriptFile` 不动（subagent 文件同格式，已兼容）。

## 失败模式

- **SubagentStop payload 字段假设失效**：若某 claude code 版本的 SubagentStop 不带 `agent_id`，或 transcript_path 指向不同位置 → 双路兜底（先 agent_id 推路径，退回 transcript_path，再退回空 turns），最坏退化为"subagent 不蒸馏"，不崩、不污染主会话蒸馏。需在采集处记录 warn 日志便于发现。
- **origin discipline 放开导致脑补回潮**：硬约束"必须 transcript 有出处"+ 人工审批闸门兜底。测试用反向 fixture（transcript 无 rationale 但模型可能脑补）验证不放行。
- **assistant 上限调高撑爆预算**：预算裁剪机制兜底（单条变长但总预算不变，超限按优先级丢 assistant/tool）。
- **subagent 文件爆量**：单次 SubagentStop 只读一个 subagent 文件（精准定位，非全目录扫描），无爆量风险。
- **schema migration 在旧库失败**：加列用 `ADD COLUMN IF NOT EXISTS`，enum 扩展在 sqlite 是 text 列无强制约束，向后兼容。

## 测试策略

**第三层（origin discipline）**：集成测试。用受控 fixture transcript 喂 `distillTranscript`（mock callLLM 捕获实际 prompt 也可，或断言候选产出）：
- 正向：transcript 含 agent 说的 rationale + 用户采纳 → 产出带 rationale 的候选。
- 反向（脑补防护）：transcript 无 rationale、只有用户字面决策 → 不产出编造 rationale 的候选。
- 维持 REJECT：前瞻计划 / 道听途说 fixture 仍不出候选。

**第一层（subagent 采集）**：
- 纯函数 `subagentFilePathFromPayload(transcriptPath, agentId)`：正常路径 / agentId 空 / 非 .jsonl / 空串 → 各自正确返回。
- 采集落点：可注入 fake glob/fs 的纯函数测"双路兜底"三态（agent_id 路径命中 / 退回 transcript_path / 都空）。
- scheduler 区分主会话增量 vs subagent 全量：fixture job 带 source_agent_id → 走全量、不更新 offset；不带 → 走原增量。
- server.ts SubagentStop 分支：参照现有 `tests/server.test.ts:153` 的 SubagentStop 测试，改为断言"现在会 enqueue + 落 event"（原测试断言"被跳过"需同步改）。

**第二层（过滤）**：
- `NON_TOOL_CAP_CHARS` 调高后的边界：刚好等于上限不截断、超上限截断、空串。
- `filterTranscriptForDistill` 补一条：长 assistant 文本（>8000、<20000）在新上限内不被截断；超 20000 截断。

**运行门槛**：`bun run typecheck && bun test` 全绿。新增测试覆盖正向 / 边界 / 错误路径。

## 开放问题（设计阶段已定，记录备查）

- assistant 上限定 20000（而非更高）：平衡"装下完整方案对比"与"不单条撑爆"。可在实现后据真实 transcript 调。
- user/assistant 共用 `NON_TOOL_CAP_CHARS` 不拆分：user 文本通常短，调高无副作用，省一个常量。
