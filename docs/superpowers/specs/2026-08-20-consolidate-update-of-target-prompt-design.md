# 设计 spec：合并步 update_of targetId 必挂修复 —— prompt 分区渲染 + 重试可收敛

- 日期：2026-08-20
- 分支：`fix/consolidate-update-of-target-prompt`
- 状态：已批准（对话内确认）

## 背景

公司环境实测 memside，合并步（consolidate，step 名沿用 `dedup`）报 LLM 输出解析失败：「重试 3 次均未获合法 JSON，group N targetId 不在 approved 集合内」，模型返回 3 组全被丢弃，job 走失败分支。

根因是 **prompt 与校验之间的信息不对称**（非模型随机错误）：

1. `listForDedupByScope`（`src/memory/store.ts:203`）返回 **approved + candidate 两种状态**的既有记忆，作为 `existing` 传给合并步。
2. `renderUserPrompt`（`src/memory/consolidate.ts:209`）渲染每条 existing 只带 `id / slug / title / body`，**不含 status** —— 模型无从区分 approved 与 candidate。
3. 系统提示（`consolidate.ts:24`）却要求「targetId 必须是本 prompt 列出的 existing 记忆中 status=approved 的 id 之一」—— 对模型不可执行的规则。
4. 校验 `consolidateShouldRetry`（`consolidate.ts:194`）只对 `approvedIds` 放行。

新部署典型时序：首批蒸馏记忆未审批（全 candidate）→ 次批对其中一条做 update_of → targetId 必然不在 approved 集合。重试时 prompt 不变、模型无新信息可修正 → **3 轮同错，确定性失败**。

次要隐患：系统提示输出示例的 `"targetId": "A"` 是假短 id，弱模型可能照抄。

## 目标

1. prompt 中 approved 与 candidate 记忆**分区列出**，status 对模型可见，update_of 合法 target 只限 approved 分区。
2. 系统提示与分区结构一致：规则可执行；approved 分区为空时明确禁用 update_of。
3. 重试路径可收敛：校验报错信息携带合法 targetId 引导（或「approved 为空不可用 update_of」），followup 轮模型有据可改。
4. 示例假 id 改为显式占位说明，杜绝照抄。

## 非目标

- 不改 `listForDedupByScope` 的查询（approved + candidate 两种状态仍要进 prompt——candidate 供 drop/merge 语义判定，是有意设计）。
- 不改校验语义：`approvedIds` 过滤与 `parseConsolidate` 的兜底 keep 保留为最后防线。
- 不放开「candidate 可作 update_of target」（裁决 #1 维持：只有 approved 可被 supersede）。
- 不动 stepState 四步、step 名、断点续跑协议。

## 接口契约与数据流

改动集中在 `src/memory/consolidate.ts`，无跨模块接口变更：

### 1. `renderUserPrompt`（导出以便测试）

现：单一 `Existing memories (same scope):` 区，每行 `id=<id> | slug=<slug> | <title>\n<bodyMd>`。

改：两分区，行格式不变，仅分区标题携带 status 语义：

```
Existing APPROVED memories (ONLY ids in this section are valid update_of targetId):
id=... | slug=... | <title>
<body>

Existing CANDIDATE memories (pending approval; NOT valid update_of targets — use only as context for drop/merge):
id=... | slug=... | <title>
<body>
```

- 两区各自为空时渲染 `(none)`。
- approved 区为空时，在 CANDIDATE 区标题前追加一行：`NOTE: no approved memories exist — update_of is NOT available in this batch.`
- `newCandidates` 段与 slug 清单段格式不变。

### 2. `CONSOLIDATE_SYSTEM_PROMPT`

- 硬规则第 3 条改写：user prompt 提供两个分区——APPROVED（update_of 的唯一合法 target 来源）与 CANDIDATE（仅作重复/合并判定上下文，绝不可作 target）；APPROVED 分区为 `(none)` 时禁止使用 update_of。
- 输出示例的 update_of 组 `"targetId": "A"` 改为 `"targetId": "<an id from the APPROVED section>"`，并在格式说明中注明占位符须替换为实际列出的 id。

### 3. `consolidateShouldRetry`（防御纵深）

targetId 不在 approved 集合时的报错从固定文案改为携带引导：

- approvedIds 非空：`group N targetId 不在 approved 集合内（合法 targetId 仅限 APPROVED 分区: <id1>, <id2>, ...）`
- approvedIds 为空：`group N targetId 不在 approved 集合内（本批 approved 为空，不可使用 update_of）`

纯函数签名不变（仍接收 `approvedIds: Set<string>`），报错字符串经 runLlmSession followup 抵达模型。

### 4. 校验层不动

`consolidateCandidates` 内 `approvedIds` 构造（`consolidate.ts:231`）、`parseConsolidate` 的裁决 #1 兜底 keep，均原样保留。

## 与现有模块的耦合点

- **断点续跑历史失配**：`consolidateCandidates` 按 `r.request.startsWith(userPrompt)` 过滤历史轮（`consolidate.ts:237`）。prompt 格式变更后，变更前在途 job 的旧 dedup 轮不再匹配 → 从头开始（maxAttempts 重算），不报错、不丢数据，仅多耗一次 LLM 调用。一次性影响，可接受。
- **live/e2e 测试**：mock e2e（`tests/e2e.test.ts` 等）若断言了旧 prompt 文案需同步；实测 consolidate 测试断言的是 parse/shouldRetry 与系统提示 token，不碰 userPrompt 全文。
- **Web UI**：无接口变更，无 UI 改动。

## 失败模式

| 场景 | 行为 |
|---|---|
| 模型仍指向 candidate id | 重试报错携带分区引导 → 收敛；3 轮耗尽仍失败 → job 失败分支（P1 不吞错，现状语义不变） |
| approved 为空且模型用 update_of | 报错明说不可用 → 模型改 keep/merge；仍耗尽 → job 失败 |
| 历史轮残留旧 prompt 格式 | startsWith 过滤自然丢弃，从头重跑 |

## 测试策略（`tests/consolidate.test.ts`，纯函数层）

1. **renderUserPrompt 分区归属**：approved 记忆只出现在 APPROVED 区、candidate 只出现在 CANDIDATE 区（按 id 断言所在分区标题之后）。
2. **空区渲染**：approved 空且 candidate 非空 → prompt 含「update_of 不可用」提示 + candidate 区有内容；两区皆空 → 各自 `(none)`。
3. **系统提示 token**：`CONSOLIDATE_SYSTEM_PROMPT` 含 APPROVED/CANDIDATE 分区规则与「APPROVED 为 (none) 时禁用 update_of」的关键词。
4. **shouldRetry 引导**：approvedIds 非空时报错含 id 列表；为空时报错含「不可使用 update_of」。
5. **回归锁**：现有 parseConsolidate / consolidateShouldRetry 用例全绿（裁决 #1 行为未变）。

## 验收清单

- [ ] `bun run typecheck && bun test` 全绿
- [ ] 新增测试覆盖上述 4 类断言
- [ ] 真实场景复现路径闭环：existing 含 candidate、新候选指向它 → 不再 3 轮同错（以单测模拟 followup 收敛逻辑覆盖）
