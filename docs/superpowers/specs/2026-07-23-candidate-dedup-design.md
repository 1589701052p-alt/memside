# 候选记忆去重机制 - 设计 spec

- 日期：2026-07-23
- 状态：Draft
- 分支：`feat/candidate-dedup`（基线 `origin/master` `937a8e3`，已含 editable-scope feature）
- 相关：`docs/superpowers/specs/2026-07-21-memside-design.md`（总体设计）、`STATE.md` "Known debt - candidate-queue audit"

## 1. 背景与动机

对实运行数据库 `~/.memside/memside.db` 的审计发现待审列表已失控：**571 条 candidate / 2 approved**，约 19 小时积累。根因不是产量本身，而是**无去重**：

1. **`distillAction` 是死字段。** `src/memory/distiller.ts` 的 `DISTILLER_SYSTEM_PROMPT`（`distiller.ts:30`）要求 LLM 对每个候选输出 `distillAction: new|update_of|duplicate_of|conflict_with`，`DistillCandidate` 类型也携带它（`distiller.ts:32-38`）。但 `src/memory/store.ts` 的 `createCandidate`（`store.ts:69-87`）对每个候选都直接 `INSERT`，**完全不消费 `distillAction`**--不查旧候选、不查已批准记忆、不合并。`scheduler.ts:84` 把 `c.distillAction` 透传进 `MemoryInput`，store 存进列里就再无下文。实数据印证：571 条 candidate 的 `distill_action` **100% 为 `new`**。

2. **distiller 是无状态批处理。** 每次 Stop hook 触发，`scheduler.tick`（`scheduler.ts:52-101`）调 `distillTranscript` 蒸馏当前 transcript，LLM 看不到已有记忆，必然反复"重新发现"同一条规则。

3. **重复以语义形态存在。** 严格 `title` 完全相同的只有 32 行；真正的问题是同一条规则因措辞 / `[category:]` 前缀 / scope 不同被反复入库（如 "Claude Code hook stdin carries transcript_path" 在不同 category、不同 scope 下出现 6+ 次）。精确字符串匹配抓不到。

`STATE.md` 的 Known debt 段已记录堆积问题；本 spec 设计真正的去重机制。其他 4 项遗留（events 清理、队列治理、cwd 归一化、stuck running）不在本 spec 范围。

## 2. 目标

- **G1**：distill 产出的新候选在落库前，与同 scope 已有记忆（candidate + approved）做语义去重；判定为重复的不入库。
- **G2**：去重失败（LLM 抛错 / 解析失败 / 幻觉）时**保守放行**（当 `new` 入库），永不丢信息、永不阻断 distill 流程。
- **G3**：去重逻辑隔离为独立纯函数模块（同 distiller 模式），可独立单测；store 保持纯数据语义不变。
- **G4**：零 schema 变更（不增列、不删列、零迁移）。

## 3. 非目标

- **N1**：处理历史 571 条堆积。去重只对未来新候选生效；历史堆积留作独立运维（手动审批 / 单独清理脚本）。
- **N2**：跨 scope 自动合并。global 与 project 的同规则不互相比对（那是 scope 标注问题，交给 editable-scope feature + 人工审批）。
- **N3**：`update_of` 自动合并/改写已有记忆。判定只输出 `new` / `duplicate`；duplicate 丢弃新候选，不改任何已有记忆（符合"用户审批"理念，新信息靠下次提取）。
- **N4**：改 distiller 本身。`distillTranscript` / `DISTILLER_SYSTEM_PROMPT` 不变；去重是 distill 之上的独立层。
- **N5**：删除 `distillAction` 列。删列需迁移、YAGNI；该列对落库候选事实上冗余（恒 `new`），保留现状，spec 标注为 provenance。

## 4. 关键决策

| # | 决策点 | 选择 | 理由 |
|---|--------|------|------|
| 1 | 去重粒度 | 语义级（LLM 判定） | DB 里大部分重复是"同规则不同措辞/category/scope"，精确匹配抓不到；memside 已有 LLM 基础设施 |
| 2 | 判定时机 | distill 后独立二次 LLM 调用 | 实现解耦、distill prompt 不变复杂；每批多一次调用可接受（distill 本就异步批处理） |
| 3 | 比对范围 | 同 scope（scopeType+scopeId）的 candidate + approved | 同 scope 内才是真重复；含 approved 才能挡住已批准规则被重新提取；跨 scope 合并有误杀风险 |
| 4 | update 语义 | 只 new/duplicate，duplicate 丢弃 | 零自动改写、符合审批理念、实现最简；update_of 自动合并风险高收益不明（YAGNI） |
| 5 | 历史堆积 | 只管未来，历史留遗 | feature 职责单一、不混数据迁移、零误删风险 |
| 6 | dedup 逻辑落点 | 独立 `src/memory/dedup.ts` 纯函数 | 隔离、纯函数+注入 callAnthropic（同 distiller 模式）、可测性好；store 不变 |
| 7 | schema | 零变更 | duplicate 不落库、new 无需标记；避免迁移 |

## 5. 接口契约

### 5.1 新模块 `src/memory/dedup.ts`（纯函数 + 注入 callAnthropic）

```ts
import type { DistillCandidate } from '@/memory/distiller'
import type { MemoryScope, MemoryStatus } from '@/memory/pure'

export interface ExistingMemoryForDedup {
  id: string
  title: string
  scopeType: MemoryScope
  scopeId: string | null
  status: MemoryStatus
}

export interface DedupInput {
  newCandidates: DistillCandidate[]          // 同 scope 的子集，由调用方分组后传入
  existing: ExistingMemoryForDedup[]         // 同 scope 的 candidate+approved，调用方查好
  callAnthropic: (system: string, user: string) => Promise<string>
}

export type DedupVerdict =
  | { index: number; duplicate: false }
  | { index: number; duplicate: true; duplicateOfId: string }

export async function judgeDuplicates(input: DedupInput): Promise<DedupVerdict[]>
```

- `index` 是 `newCandidates` 数组内的下标（0-based），调用方据此映射回全局候选。
- `existing=[]` 时**不调 LLM**，直接返回全 `duplicate:false`（省调用、无比对对象）。
- `newCandidates=[]` 时返回 `[]`，不调 LLM。

**LLM prompt**（system）：你是 memside-dedup，判断新候选记忆是否与同 scope 已有记忆**语义重复**（同一规则、同一事实，即便措辞/category/scope 标签不同）。仅返回 JSON。

**LLM prompt**（user）：

```
Existing memories (same scope):
<for each existing: "id=<id> | <title>">

New candidates:
<for each new, with its index: "[<index>] <title>\n<bodyMd>">

For EACH new candidate, decide if it is a semantic duplicate of any existing.
Respond ONLY with JSON: {"verdicts":[{"index":<n>,"isDuplicate":true,"duplicateOfId":"<id>"} | {"index":<n>,"isDuplicate":false}]}
```

- 只喂 `id+title`（existing）和 `index+title+bodyMd`（new），省 token。
- 失败/异常处理见 §8。

### 5.2 Store 新增查询 `src/memory/store.ts`

```ts
export async function listForDedupByScope(
  db: DbClient,
  opts: { scopeType: MemoryScope; scopeId: string | null },
): Promise<ExistingMemoryForDedup[]>
```

- 查同 `scopeType` + `scopeId`（project=精确 scopeId 匹配；global=scopeId IS NULL）且 `status IN ('candidate','approved')` 的行。
- **approved 全量 + candidate `createdAt DESC LIMIT DEDUP_EXISTING_LIMIT`** 合并去重--保证已批准规则不被新候选挤漏，candidate 限最近 N 条控 prompt。
- 只 SELECT `id, title, scope_type, scope_id, status`（省 token、不读 body）。
- 返回 `ExistingMemoryForDedup[]`，**不含 `runtime`**：dedup 按 scope 比对，runtime 不参与；跨 runtime 的同规则同 scope 仍算重复（符合"同 scope 真重复"语义）。
- `DEDUP_EXISTING_LIMIT = 50`（导出自 `store.ts`，仅 `listForDedupByScope` 使用；可调常量）。

### 5.3 Scheduler 改动 `src/scheduler.ts`

`tick`（`scheduler.ts:52-101`）在 `distillTranscript` 产出 `candidates`（`scheduler.ts:67-72`）后、`createCandidate` 循环（`scheduler.ts:73-87`）前，插入去重过滤：

```
1. 若 candidates 为空，跳过去重（原逻辑直接进 done）。
2. 按 (scopeType, scopeId) 分组。scopeId 推导同现有逻辑：
   project -> job.cwd ?? 'unknown'；global -> null。
3. 对每组：
   a. existing = await listForDedupByScope(db, {scopeType, scopeId})
   b. 若 existing 为空：该组全部当 new（不调 LLM）。
      否则：verdicts = await judgeDuplicates({
        newCandidates: <组内子集>, existing, callAnthropic: deps.callAnthropic })
   c. 收集 verdict.duplicate === false 的（组内 index -> 全局 index 映射）进 keep 集合。
4. 仅对 keep 集合内的候选调 deps.createCandidate(...)（入参不变，含 sourceCwd/distillAction 等）。
```

- `TickDeps` **不变**（仍 `loadTranscript` / `callAnthropic` / `createCandidate`）。`listForDedupByScope` 与 `judgeDuplicates` 由 `tick` 直接 import（读查询用真 `db`，dedup 用已注入的 `deps.callAnthropic`），与现有 `distillTranscript` 直接 import 的模式一致。
- `createCandidate` 入参**完全不变**（`scheduler.ts:74-86` 原样），只是外层套了 keep 过滤。
- `judgeDuplicates` 内部的 LLM 异常（网络/解析/幻觉）被 §8 保守逻辑吞掉（返回全 new），**不冒泡**到 `tick` 的 `catch`（`scheduler.ts:90`）--dedup 判定失败 ≠ distill 失败，不应让 job 退回 pending。注意：`listForDedupByScope`（store 查询）的 DB 异常仍会冒泡到 `tick` catch 并按现有退避重试，属基础设施故障，与 dedup 逻辑无关。

### 5.4 数据模型

**零变更。** `memories` 表不加列、不改列。`distillAction` 列保留：对落库候选恒为 `new`（duplicate 的未入库），该列现为 provenance 性质，未来可单独清理（不在本 spec）。

### 5.5 Daemon wiring `src/daemon.ts`

无改动。`tickDeps.callAnthropic`（`daemon.ts:117`）已被 `judgeDuplicates` 经 `deps.callAnthropic` 复用，无需额外注入。`runDistillOnce`（`daemon.ts:53-67`）的 `tickDeps` 同样无需改（dedup 走 `callAnthropic` seam）。

## 6. 数据流

```
hook(Stop) -> memory_distill_events(payload=transcript) -> job(pending)
tick:
  loadTranscript(job) -> turns
  distillTranscript(turns) -> candidates: DistillCandidate[]          [现有]
  --- 新增去重 ---
  group candidates by (scopeType, scopeId)
  for each group:
    listForDedupByScope(db, scope) -> existing (approved 全量 + candidate 最近50)
    if existing empty: keep all (no LLM)
    else: judgeDuplicates({newCandidates, existing, callAnthropic}) -> verdicts
    keep verdict.duplicate===false
  --- 去重结束 ---
  for each kept candidate: createCandidate(...) -> memories(candidate)  [现有]
  job -> done
注入（不变）：SessionStart -> listApprovedByScope -> formatMemoryBlock
```

## 7. 与现有模块的耦合点

- **`distillTranscript` / `DistillCandidate`**（`distiller.ts`）：dedup 消费其产出的 `DistillCandidate[]`，不改 distiller。`DistillCandidate.distillAction` 仍由 distiller 输出，dedup 不看它（dedup 用自己的 LLM 判定）。
- **`createCandidate`**（`store.ts:69-87`）：不变，仍纯 INSERT。dedup 在更上层过滤，store 纯数据语义保持。
- **`listApprovedByScope` / `formatMemoryBlock`**（`store.ts`/`pure.ts`）：dedup 只挡 candidate 入库，不动 approved，注入路径完全不变。
- **`TickDeps`**（`scheduler.ts:34-39`）：不变。dedup 复用 `deps.callAnthropic`；`listForDedupByScope` 用 `tick` 的 `db` 参数。
- **`patchMemory` scope 耦合**（editable-scope feature）：用户改过 scope 的 candidate，后续 dedup 按新 scope 比对，无冲突。
- **WS 广播**：dedup 丢弃 candidate 不产生广播（本就无 `memory.candidate.created`）；keep 的照常走现有 `createCandidate` 路径（server 层广播，scheduler 不广播）。

## 8. 失败模式

| 场景 | 行为 |
|------|------|
| `judgeDuplicates` 内 LLM 调用抛错（网络/502/超时） | 捕获，返回该组全 `duplicate:false`（全入库），不冒泡到 `tick` catch |
| LLM 返回非 JSON / 结构不符 / 缺 `verdicts` | 同上，全 `duplicate:false` |
| LLM 响应里某些 index 缺失 | 缺失的当 `duplicate:false` |
| LLM 返回 `duplicateOfId` 不在 `existing` 里（幻觉） | 该条当 `duplicate:false` |
| `existing=[]`（同 scope 无已有记忆） | 不调 LLM，该组全 `duplicate:false` |
| `newCandidates=[]` | 不调 LLM，返回 `[]` |
| `listForDedupByScope` 抛错（DB 异常） | 冒泡到 `tick` catch（`scheduler.ts:90`），job 按现有退避重试--这是基础设施故障，与 dedup 逻辑无关，沿用 distill 的重试语义 |

**原则**：dedup 判定只要不可信，就 fallback 到 `new`（保守入库）。dedup 是"尽力去重"，失败时退化为无 dedup 行为，绝不丢信息、绝不阻断 distill。

## 9. 测试策略

纯函数 / 纯数据层为主（CLAUDE.md），无 UI 改动。

- **`tests/dedup.test.ts`**（新，纯函数 + 注入 mock callAnthropic）：
  - LLM 返回 `isDuplicate:true` + 合法 `duplicateOfId` -> verdict `duplicate:true`，`duplicateOfId` 正确。
  - LLM 返回 `isDuplicate:false` -> verdict `duplicate:false`。
  - LLM 调用抛错 -> 整批全 `duplicate:false`（保守）。
  - LLM 返回非 JSON / 缺 `verdicts` / 缺字段 -> 全 `duplicate:false`。
  - LLM 响应缺某些 index -> 缺失的当 `duplicate:false`。
  - LLM 返回幻觉 `duplicateOfId`（不在 existing）-> 当 `duplicate:false`。
  - `existing=[]` -> **断言 `callAnthropic` 未被调用**，全 `duplicate:false`。
  - `newCandidates=[]` -> 返回 `[]`，`callAnthropic` 未被调用。
  - user prompt 含已有记忆的 `title`（断言 prompt 内容）。
  - verdict `index` 与 `newCandidates` 下标对齐。
- **`tests/scheduler.test.ts`**（扩）：
  - tick 调 dedup 后，duplicate 的不调 `createCandidate`、new 的调（mock `callAnthropic` 返回 verdict JSON，mock `createCandidate` 捕获调用次数/入参）。
  - dedup 失败（mock `callAnthropic` 抛错）-> 全部 `createCandidate`（保守，且 job 仍 `done` 不退回 pending）。
  - `existing=[]`（空 db）-> 全部 `createCandidate`，`callAnthropic` 未被调用。
  - 跨 scope 候选：project 与 global 候选各自只与同 scope existing 比对（预置不同 scope 的 existing，断言比对范围）。
  - keep 的 `createCandidate` 入参含 `sourceCwd`/`distillAction`（回归：dedup 不破坏现有入参）。
- **`tests/store-crud.test.ts`**（扩）：
  - `listForDedupByScope` 返回同 scope 的 candidate+approved，不含其他 scope、不含 archived/rejected/superseded。
  - approved 全量返回 + candidate `LIMIT 50` 生效（预置 >50 条 candidate 断言截断）。
  - project scope 按 scopeId 精确匹配；global scope scopeId IS NULL。
- **集成兜底**：`scheduler.test.ts` 的 tick 全流程已覆盖 dedup 与 distill/createCandidate 的协作。
- **无 web-ui 测试**：dedup 对用户透明（只看到候选变少），无 UI 改动。

## 10. 落地流程（CLAUDE.md）

1. 已切 `feat/candidate-dedup`（基线 `origin/master` `937a8e3`）。
2. 本 spec 落档 + commit。
3. 调用 `writing-plans` skill 产出 `docs/superpowers/plans/2026-07-23-candidate-dedup.md`。
4. 按计划实现 + 测试，`bun run typecheck && bun test` 全绿。
5. push -> PR 合 `master`。

## 11. 涉及文件

- 新增：`src/memory/dedup.ts`、`tests/dedup.test.ts`
- 改：`src/memory/store.ts`（加 `listForDedupByScope`）、`src/scheduler.ts`（`tick` 插去重过滤）
- 扩测试：`tests/scheduler.test.ts`、`tests/store-crud.test.ts`
- 落档：本 spec + `docs/superpowers/plans/2026-07-23-candidate-dedup.md`
