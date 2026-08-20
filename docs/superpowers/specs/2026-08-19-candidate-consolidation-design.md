# 候选记忆合并步（consolidate）设计 spec

> 2026-08-19。方案 A：把 scheduler 的「去重」（dedup）步从二元丢弃升级为「合并步」。
> 痛点（live DB 实测）：847 candidate / 8 approved / 2556 rejected；同一 subjectSlug
> 下十几个候选并存（test-pattern 19、subagent-workflow 11、ui-dual-protocol 10…）；
> 362 条候选无 subjectSlug（占 43%）。根因：dedup 只丢不并 + 跨会话只比最近 50 条 candidate。
> 人闸不动——所有合并产物仍以 candidate 入队待人工审批，不自动入档。

## 1. 目标 / 非目标

### 目标
1. **碎片熔合**：同一规则/决策/约束的不同侧面候选 → 熔成一条，不再 N 条并存。
2. **队列减负**：合并步吸收现有 dedup 的 1 次 LLM 调用（不新增调用），每会话产出锐减。
3. **跨会话全量比对**：按 subjectSlug 预筛既有记忆，不限 50 条，队列再大也不漏老重复。
4. **update_of 闭环**：对既有 approved 记忆的精炼作为「更新提案」入队，审批时
   `approve_and_supersede` 并回既有记忆，不堆独立重复条。

### 非目标
- 不动 liberal-capture 立场（蒸馏器照常 liberal 提取，合并步事后减量）。
- 不自动入档（人闸是最后一道，合并不绕过审批）。
- 不改蒸馏器 prompt 的提取范式（源头重写属方案 B，留后续）。
- 不给 judge 加 transcript grounding（盲判不变，属方案 C，留后续）。
- 不重判存量 3135 条候选（存量用现有「批量拒绝未评估」+ 手动审批清理）。

## 2. 现状回顾（为什么队列堆碎片）

- scheduler 四步机 `distill → dedup → judge → digest`。dedup 步内部：
  1. `exactDedupCandidates`（逐字去重，省 LLM，drops 不进后续）。
  2. `judgeDuplicates`（语义去重，1 次 LLM）：输入=本批候选 + 同 scope 既有记忆，
     输出=逐条二元判定（duplicate/not），重复的直接 drop。
- `listForDedupByScope`（store.ts:196）：approved 全量 + **最近 50 条 candidate**
  （`DEDUP_EXISTING_LIMIT=50`）。队列 847 条时，与 50 名外旧 candidate 重复的新候选
  不被识别 → 重新入队。
- `distillAction`（distill_action 列）schema 有 update_of/duplicate_of/conflict_with，
  但**下游无合并/取代逻辑消费**——纯元数据摆设。取代（supersedesId）只由人工
  UI `approve_and_supersede` 触发。
- dedup 的 existing 集合是 approved + candidate；judge 是盲判（只看 title/bodyMd/evidence）。

## 3. 架构：dedup 步升级为合并步

dedup 步内部实现替换，**对外步骤边界不变**（stepState 四步 `distill→dedup→judge→digest`
逐字不动，checkpoint 字段 current_step/step_attempts/step_error 全复用）。

### 3.1 合并步流程（替换 judgeDuplicates 的位置）
1. `exactDedupCandidates` 仍先跑（既有不变量，省 LLM，drops 不进合并步）。
2. **新合并步 `consolidateCandidates`**（1 次 LLM，替换原 `dedupCandidates` 的语义去重调用）：
   - 输入：exact 后幸存候选 + 同 scope 既有记忆（按 subjectSlug 预筛，见 §3.3）。
   - 输出：consolidated candidates，每条带 action（merge/keep/drop/update_of），见 §4。
3. 合并后候选 → judge 步（盲判，逐字不变）→ createCandidate 入库（含 update_of 透传
   supersedesId，见 §6）。

### 3.2 步骤名保持 dedup
- stepState / stepPrompt / runLlmSession 的 `step='dedup'` 全部复用。合并步逻辑替换
  `dedupCandidates`/`judgeDuplicates` 的语义，**step 名不改**（checkpoint 语义连续，
  断点续跑历史兼容）。LLM round 仍按 `step='dedup'` 落 memory_distill_events。

### 3.3 跨会话按 subjectSlug 全量预筛
- `listForDedupByScope`（store.ts:196）改：approved 全量（不变）+ candidate 不再
  `LIMIT 50` 取最近，改为**按本批候选的 subjectSlug 集合预筛**——只取 slug ∈ 本批 slug
  的 candidate（不限条数）+ 无 slug 的 candidate 不进 existing 比对集合（它们是合并步
  要归组的对象，不是比对基准）。
- 理由：队列 847 条时，与 50 名外旧 candidate 重复的新候选才需要进 existing；按 slug
  预筛只取相关主题，既不限条数又不爆 prompt（同 slug 的 candidate 通常个位数）。
- `DEDUP_EXISTING_LIMIT=50` 常量语义从「candidate 取最近 50」改为「无 slug fallback 上限」
  （本批全无 slug 时，existing candidate 仍限 50 防爆 prompt；有 slug 时按 slug 预筛不限）。

## 4. 合并步 LLM 契约

### 4.1 SYSTEM PROMPT（替换 DEDUP_SYSTEM_PROMPT）
新 `CONSOLIDATE_SYSTEM_PROMPT`（落 `src/memory/consolidate.ts`，新模块）：

角色：memside-consolidate。任务：把同主题的候选碎片熔合成最少条数，识别对既有记忆的
精炼（update_of），丢弃纯重复。**硬约束**：仅当确属同一规则/决策/约束的不同侧面才合并；
不同事实/规则/主题的记忆必须保持独立，宁可多留不可误并。merge 必须保留所有独特侧面，
不允许「为减量丢事实」。drop 仅限纯语义重复（同一规则换个说法）。update_of 仅当新候选
是对既有 approved 记忆同一主题的精炼/补充/纠正。

### 4.2 输出 JSON 契约
```json
{
  "groups": [
    {
      "action": "merge",
      "members": ["new-0", "new-2"],
      "mergedTitle": "[category:convention] <择优或综合>",
      "mergedBody": "<归并各侧面，≤400字>",
      "mergedEvidence": "<归并出处原句>",
      "mergedSlug": "test-pattern",
      "mergedOrigin": "agent-observed"
    },
    {
      "action": "update_of",
      "targetId": "A",
      "members": ["new-1"],
      "mergedTitle": "...", "mergedBody": "...",
      "mergedEvidence": "...", "mergedSlug": "test-pattern",
      "mergedOrigin": "agent-observed"
    },
    { "action": "keep", "members": ["new-3"] },
    { "action": "drop", "members": ["new-4"], "dropReason": "duplicate" }
  ]
}
```

### 4.3 合并后字段取舍规则（prompt 硬约束 + 代码兜底）
- **title**：合并组取最完整的一条或综合；必须保留 `[category:xxx]` 前缀；成员 category
  不一致时取合并后最贴切的（本质规则）。
- **bodyMd**：归并各成员不同侧面，≤400 字；超限时丢重复表述、保独特侧面。
- **evidence**：归并各成员 evidence 原句（去重）；成员 evidence 空则贡献空。
- **subjectSlug**：合并组必须有 slug。从成员复用；成员无 slug 但明显同主题时据内容造一个
  （kebab-case，复用 existing slug 清单优先）。**无 slug 的 362 条是合并步归组重点。**
- **origin（用户拍板：降级 observed）**：合并组 origin **一律降级 `agent-observed`**，
  不享受 stated 免疫 derivable，由 judge 正常判定，避免合并产物被赋予超过任何单一成员的
  置信度。代码兜底：LLM 漏标/非法 origin → agent-observed。**不设例外口子**（即使所有
  成员都是 user-stated 仍降级——合并是综合，综合产物按观察处理最保守）。

### 4.4 id 引用约束
- `members` 只能引用本批 new-i（j 可任意序，不再强制 j<i——合并是集合运算）。
- `update_of.targetId` 必须是 existing 集合内的既有记忆 id（approved only，见 §6.1）。
- 代码校验 targetId ∉ existing → 该组 fallback 为 keep（不标 update_of，独立入队）。

### 4.5 shouldRetry 校验
- parsed 是对象且有 `groups` 数组。
- 每个 group 有合法 `action`（merge/keep/drop/update_of）。
- members 是字符串数组、引用合法 new-i。
- update_of 必须有 `targetId` 且 targetId ∈ existing ids。
- merge/update_of 必须有 mergedTitle（含 `[category:`）/mergedBody/mergedSlug。
- 重试耗尽 → `{failed:true,reasons}` → step 失败分支（P1 不吞错）。
- 成功响应内单条幻觉（非法 id/category）→ 代码兜底 fallback keep（保守不丢内容，与人闸一致）。
- **必须覆盖每个 new-i**：所有 group 的 members 并集 = 全部 new-i；漏掉的 new-i → 兜底 keep。

## 5. 失败处理与断点续跑（复用现有机制）

- LLM 失败 → 合并步返回 `{failed:true,reasons}` → scheduler 走现有 step 失败路径
  （回 pending + 指数退避，stepAttempts 累计 3 次 → markJobPaused + llm_error 通知）。
  与现有 dedup 失败路径逐字一致，P1 不吞错。
- 断点续跑：合并步走 `runLlmSession`（step='dedup'），传 loadHistory 即带历史接续、
  单次只跑一轮新回合，历史落 memory_distill_events。中途崩溃 → 下 tick loadHistory 复放。
- **LLM 调用成本不新增**：合并步替换原 dedup 的 1 次调用，judge 仍是 1 次。
  总 = distill + 合并 + judge + digest，与现状相同。
- exact dedup 不动（仍先于合并步跑）。
- drop 走 `logDiscards`（reason='duplicate'），与现有一致。merge/update_of 不产生
  discard 审计行（合并/更新非丢弃）。

## 6. update_of 落库 + 审批闭环（全闭环）

### 6.1 target 限定 approved
- `promoteCandidate` 的 `approve_and_supersede` 守卫要求 target `status='approved'`
  （store.ts:267）。update_of 的 targetId 同步限定 **approved only**。
- 合并步若发现新候选是对某条 **candidate**（待审记忆）的精炼 → fallback 为 keep
  （独立入队，judge 后两条 candidate 并存，由人工合并）。target 是 candidate 的场景
  语义复杂，本期不做。

### 6.2 落库（scheduler 合并步之后、judge 之前）
- 合并步输出的 `update_of:targetId` 组 → 作为 candidate 入队（与 merge/keep 同走
  judge → createCandidate），`createCandidate` 传 `distillAction: 'update_of'` +
  `supersedesId: targetId`。
- 当前 scheduler 入库是 `distillAction: k.cand.distillAction`（来自 distiller 自报），
  需改为合并步产出的 action 覆盖：merge/update_of 组用合并后的 mergedTitle/mergedBody/
  mergedEvidence/mergedSlug + 对应 distillAction + supersedesId。

### 6.3 审批闭环（Web UI）
- MemoryCard 对 `distillAction='update_of'` 且 `supersedesId` 非空的候选，显示
  **「更新 #<targetId 短摘要>」紫色徽标**，让用户看出这是对既有记忆的精炼而非全新条目。
- 用户 approve → 复用现有 `approve_and_supersede` 路径（supersedeIds=[targetId]）：
  approve 此 candidate + targetId 记忆标 superseded + 建 supersedesId 关系。
  **不新增独立 approved 条目**，老记忆被取代而非堆叠。
- 用户 reject → 正常 reject，targetId 记忆不变。
- 状态可见性：合并组 members → merged 映射天然在 LLM 原始输出可见，复用现有蒸馏记录
  modal 的 raw output 展示，不额外做 UI。

### 6.4 边界
- targetId 指向的既有记忆在审批前被删/被另批 → `approve_and_supersede` 现有守卫处理
  （MemoryNotFoundError → 404 / scope mismatch → 409）。
- update_of 仍经 judge 正常判定——judge 判该更新提案 derivable（已写进文档的规则）
  则丢弃（与现有 derivable 语义一致，不因是 update_of 免疫）。

## 7. 数据流总览

```
transcript → distill(liberal 提取, 带 existingSlugs/approvedTitles)
  → exact dedup(逐字去重)
  → ★ 合并步 consolidateCandidates(1 LLM, 输出 merge/keep/drop/update_of)
     ├─ merge   → 1 条合并 candidate(distillAction='new', origin 降级 observed)
     ├─ keep    → 原样 candidate
     ├─ drop    → logDiscards(reason='duplicate')
     └─ update_of → candidate(distillAction='update_of', supersedesId=targetId)
  → judge(盲判 9 类, update_of 不免疫) → createCandidate 入库
  → 人工审批(merge/keep 走 approve; update_of 走 approve_and_supersede 并回既有记忆)
```

## 8. 改动面

| 文件 | 改动 |
|---|---|
| `src/memory/consolidate.ts`（新） | 合并步纯逻辑：SYSTEM_PROMPT、renderUserPrompt、shouldRetry、parseConsolidate、consolidateCandidates（走 runLlmSession step='dedup'）。吸收 dedup.ts 职责。 |
| `src/memory/dedup.ts` | 评估：合并步吸收其语义去重职责后，是否整体退役或保留 exact 之外的兜底。倾向退役 judgeDuplicates（exact dedup 独立模块不动）。 |
| `src/memory/store.ts` | `listForDedupByScope` 改按 subjectSlug 预筛（§3.3）；`DEDUP_EXISTING_LIMIT` 语义调整。 |
| `src/scheduler.ts` | dedup 步内部 `dedupCandidates` → `consolidateCandidates`；入库时合并 action 覆盖 distillAction/supersedesId/title/body/evidence/slug（§6.2）。 |
| `src/web/App.tsx` | MemoryCard 加「更新 #」紫色徽标（distillAction='update_of' && supersedesId）。 |
| `src/web/ui-utils.ts` | 徽标渲染纯函数。 |
| tests | consolidate 纯函数正向/边界/错误路径；slug 预筛查询；update_of 落库 + approve_and_supersede 闭环；幻觉 fallback keep；失败标识冒泡。 |

## 9. 测试策略

### 9.1 纯函数层（首选可断言面）
- `parseConsolidate`：合法 JSON → 正确 groups；形状突变 → null；单条幻觉 id → fallback keep；
  漏覆盖 new-i → 兜底 keep；origin 漏标 → agent-observed。
- `shouldRetry`：缺 groups/非法 action/非法 members/非法 targetId/缺 mergedTitle → 触发重试。
- 合并后字段取舍：title 保留 [category:]；evidence 归并去重；slug 强制；origin 降级规则。
- `listForDedupByScope` slug 预筛：本批有 slug → 只取同 slug candidate（不限条）；
  本批无 slug → fallback 最近 50。

### 9.2 集成层
- scheduler tick：合并步替换 dedup，exact 仍先跑，合并后候选进 judge → 入库。
- update_of 落库：candidate 带 distillAction='update_of' + supersedesId=targetId；
  approve 时 approve_and_supersede 把 targetId 标 superseded（不新增独立条）。
- 失败标识：合并步返回 {failed:true} → step 失败分支（不吞成 0 候选，P1）。
- 断点续跑：loadHistory 复放上一轮（step='dedup' 历史兼容）。

### 9.3 源码层文本断言（运行时巨型组件兜底）
- consolidate SYSTEM_PROMPT 含硬约束 token（"宁可多留不可误并"/"update_of 仅当对既有 approved"）。
- UI 徽标接线（「更新 #」紫标 + distillAction='update_of' 分支）。

### 9.4 既有回归
- exact dedup 不变（exactDedupCandidates 测试不动）。
- judge 盲判不变（valueFilter 测试不动）。
- stepState 四步不变（stepState 测试不动）。
- approve_and_supersede 现有守卫不变（store 测试不动，新增 update_of 自动路径用例）。

## 10. 失败模式

1. **误并**：把不同事实并成一条 → 丢事实。缓解：prompt 硬约束「宁可多留不可误并」
   + members 必须确属同一规则不同侧面 + 人闸兜底（合并候选仍需审批）。
2. **update_of target 漂移**：targetId 在审批前被删/被另批 → approve_and_supersede 现有守卫
   404/409，用户可见。
3. **合并步 LLM 失败**：断点续跑 3 轮后暂停 + 通知，不吞错（与 dedup 现状一致）。
4. **无 slug 候选无法归组**：合并步对无 slug 候选据内容造 slug 或归到现有 slug；
   造不出 slug 时 fallback keep（独立入队，不丢）。
5. **跨 scope 误并**：合并步按 (scopeType, scopeId) 分组，组间不串线（与现有 dedup 一致）。

## 11. 上线后观测（硬要求，结论回填）

1. 每 job 产出候选数对比 PR 前后（预期锐减——碎片熔合 + 跨会话全量比对）。
2. 同一 subjectSlug 下并存候选数（test-pattern 等高频 slug 的候选数下降幅度）。
3. 无 slug 候选占比（362/847 基线，预期合并步强制归 slug 后下降）。
4. update_of 候选数 + approve_and_supersede 使用率（验证更新闭环被采用 vs 堆独立条）。
5. 误并抽样：合并候选 body 是否丢事实（人工审批抽样）。
6. 合并步 LLM 失败率（对比 dedup 基线，验证不新增故障面）。
