# 候选记忆价值过滤（value filter）- 设计 spec

- 日期：2026-07-23
- 状态：Draft
- 分支：`feat/candidate-value-filter`（基线 `origin/master` `26b5418`，已含 candidate-dedup）
- 相关：`docs/superpowers/specs/2026-07-23-candidate-dedup-design.md`（去重，本 spec 的同构前驱）、`STATE.md` "Known debt - candidate-queue audit"

## 1. 背景与动机

STATE.md 的候选队列审计：**571 candidate / 2 approved**。dedup（PR #5）解决了"语义重复"堆积，但队列里仍大量是**低价值**记忆--公共知识（语言语法、标准库 API、通用算法、公开标准）和可从代码/文件推导的事实。这些即使去重后仍每条都要人审，审批工作量远超产出。

用户给出 6 条价值规则，分两类动作：
- 规则 1（公共知识）、规则 2（可推导）-> 自动丢弃。
- 规则 3（决策 Why）、规则 4（隐性约定）-> 高优先级记录。
- 规则 5（异常陷阱）、规则 6（关系拓扑）-> 中优先级记录。

distiller 的 system prompt（`src/memory/distiller.ts:3`）已有一句弱过滤（"Aggressively favor durable BUSINESS and ARCHITECTURE knowledge" + REJECT "fleeting status update"），但实测不足以挡住低价值候选。需要一个**独立、可测、中性**的价值判定层。

本 spec 设计 `judgeValue`：distill 后、dedup 前的二次 LLM 判定，把每条候选分类到 6 类别之一，代码层按类别映射丢弃/打标。与 dedup 同构（纯函数 + 注入 `callAnthropic` + 保守 fallback），但更简单（不查 DB、不分 scope、不要 existing 列表）。

## 2. 目标

- **G1**：distill 产出的候选在 dedup 前经 `judgeValue` 分类；规则 1/2 类别丢弃（写审计表），规则 3-6 类别带 `value_class` 入库，无合法分类的以 `value_class=NULL`（未评估）入库。
- **G2**：判定失败（LLM 抛错 / 非 JSON / 缺 index / 幻觉类别）时，受影响候选以 `value_class=NULL` 保留，永不静默丢弃、永不阻断 distill。
- **G3**：价值判定隔离为独立纯函数模块（同 distiller/dedup 模式），可独立单测；store 保持纯数据语义。
- **G4**：UI 按派生优先级排序 + 显示 valueClass 徽标 + 批量拒绝未评估候选，降低审批工作量。
- **G5**：prompt 中性--不出现 keep/discard/dangerous/unsure 等引导词，LLM 只做 6 类别分类，丢弃是代码层映射。
- **G6**：顺带中性化 dedup prompt（删 "When unsure, emit isDuplicate:false." 偏向句），与 value filter 中性原则一致。

## 3. 非目标

- **N1**：处理历史 571 条堆积。只对未来新候选生效；历史候选 `value_class` 留 NULL（未评估），UI 排最后。与 dedup N1 一致。
- **N2**：改 distiller prompt。distiller 完全不动（既不加 REJECT 强化，也不中性化 "Aggressively favor"）。judgeValue 是唯一价值判定层。
- **N3**：dedup 丢弃加审计。dedup 丢弃维持静默（不进 `memory_discards`）。仅 value filter 丢弃进审计表。
- **N4**：自动改写/合并候选。judgeValue 只分类，不修改候选内容；丢弃=不入库，保留=原样带标。
- **N5**：单独存 priority 列。优先级从 `value_class` 派生（decision/convention=>高，trap/topology=>中，NULL=>未评估），不另加列。
- **N6**：跨 scope 价值比对。每条候选独立判定，不与他人比较（比较是 dedup 的职责）。

## 4. 关键决策

| # | 决策点 | 选择 | 理由 |
|---|--------|------|------|
| 1 | 判定方式 | LLM 6 类别分类 | "是否可推导 / 是否 Why-决策"是语义判断，启发式做不了；memside 已有 LLM 基础设施 |
| 2 | 判定时机 | distill 后独立二次 LLM 调用，dedup 前 | 实现解耦、distiller 不变；先丢垃圾让 dedup 只跑幸存者更省 |
| 3 | prompt 中性 | 只分类，不提 keep/discard | 用户要求禁止引导；丢弃是代码对 public-knowledge/derivable 的确定映射 |
| 4 | fallback 语义 | 无合法分类 => 保留 value_class=NULL | 丢弃需明确的规则 1/2 分类；无分类依据则不丢弃（逻辑必然，非"怕丢所以留"） |
| 5 | 数据模型 | memories 加 value_class 单列 + 新 memory_discards 表 | 单列+派生优先级最省；审计表隔离丢弃记录、可 SQL 抽查 |
| 6 | 积压 | 只管未来 | 与 dedup 一致，职责单一，零回填误删风险 |
| 7 | dedup prompt | 删偏向句，不加审计 | 贯彻中性；接受误判重复丢弃概率略升（代码仍挡幻觉 id） |
| 8 | distiller | 不动 | 隔离；judgeValue 独立承重 |
| 9 | judgeValue JSON 解析 | 镜像 dedup 现状（plain `JSON.parse` + 保守 fallback） | 一致性；不依赖未合并的 extractJsonObject（feat/distill-json-extract 的活） |
| 10 | 价值判定落点 | 独立 `src/memory/valueFilter.ts` 纯函数 | 隔离、可测，同 distiller/dedup 模式 |

## 5. 接口契约

### 5.1 新模块 `src/memory/valueFilter.ts`（纯函数 + 注入 callAnthropic）

```ts
import type { DistillCandidate } from '@/memory/distiller'

export type ValueClass = 'decision' | 'convention' | 'trap' | 'topology'
export type DiscardReason = 'public-knowledge' | 'derivable'

export type ValueVerdict =
  | { index: number; keep: false; reason: DiscardReason }
  | { index: number; keep: true; valueClass: ValueClass }
  | { index: number; keep: true; valueClass: null }

export async function judgeValue(
  candidates: DistillCandidate[],
  callAnthropic: (system: string, user: string) => Promise<string>,
): Promise<ValueVerdict[]>
```

- `index` 是 `candidates` 数组内下标（0-based）。
- `candidates=[]` -> 返回 `[]`，不调 LLM（同 dedup）。
- 一次 LLM 调用判整批，index 对齐（同 dedup）。

**system prompt**（中性分类器，全程不出现 keep/discard/dangerous/unsure）：

```
You are memside-value-judge. Classify each candidate memory into exactly one
category by these criteria:

1. public-knowledge - obtainable via Google / official docs / source within ~10s
   (language syntax, stdlib, third-party API, generic algorithms, public standards).
2. derivable - re-derivable by reading existing code/files/docs; only a file path
   or entry point would need remembering.
3. decision - the WHY behind a choice: abandoned alternatives, constraints that
   drove the decision.
4. convention - an unwritten team rule / reviewer preference not documented anywhere.
5. trap - counterintuitive behavior, known gotcha, recurring pitfall.
6. topology - a cross-boundary connection (cross-module/service/team/repo) invisible
   from any single vantage point.

Pick the best-fitting category for each candidate. Respond ONLY with JSON:
{"verdicts":[{"index":<n>,"category":"public-knowledge|derivable|decision|convention|trap|topology"}]}.
Emit one verdict per candidate, keyed by index.
```

**user prompt**：每条候选 `[<index>] <title>\n<bodyMd>`（喂 title+bodyMd，body 常含区分规则 2 与规则 3 的 why）。

**代码层映射**（`judgeValue` 内，对每条 LLM 返回的 category）：
- `category ∈ {public-knowledge, derivable}` -> `{keep:false, reason:category}`
- `category ∈ {decision, convention, trap, topology}` -> `{keep:true, valueClass:category}`
- index 缺失 / category 不在 6 个里 / LLM 抛错 / 非 JSON / 缺 `verdicts` -> `{keep:true, valueClass:null}`

### 5.2 Store 改动 `src/memory/store.ts`

`MemoryInput` 加可选 `valueClass`：
```ts
export interface MemoryInput {
  ... // 现有字段不变
  valueClass?: 'decision' | 'convention' | 'trap' | 'topology' | null
}
```
`Memory` 接口加 `valueClass: ValueClass | null`。`createCandidate` 写 `value_class` 列（`input.valueClass ?? null`）。`rowToMemory` 读回。

新增 `logDiscards`：
```ts
export interface DiscardRecord {
  title: string
  bodyMd: string
  reason: 'public-knowledge' | 'derivable'
}
export async function logDiscards(
  db: DbClient,
  distillJobId: string,
  discards: DiscardRecord[],
): Promise<void>
```
- 批量 insert 进 `memory_discards`（distillJobId, title, body_md, reason, ts=`Date.now()`）。
- `discards=[]` -> no-op，不写。
- **best-effort**：调用方（tick）捕获其抛错并 swallow（见 §8），不阻断 distill。

### 5.3 数据模型 `src/db/schema.ts`

`memories` 表加列：
```ts
valueClass: text('value_class'),  // nullable: 'decision'|'convention'|'trap'|'topology'|NULL
```
无 CHECK 约束（便于将来加类别不改迁移）。

新增 `memory_discards` 表：
```ts
export const memoryDiscards = sqliteTable('memory_discards', {
  id: text('id').primaryKey(),
  distillJobId: text('distill_job_id').notNull()
    .references(() => memoryDistillJobs.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  bodyMd: text('body_md').notNull(),
  reason: text('reason').notNull(),  // 'public-knowledge' | 'derivable'
  ts: integer('ts').notNull(),
}, (t) => ({
  tsIdx: index('idx_discards_ts').on(t.ts),
}))
```

### 5.4 迁移 `src/db/client.ts`

在现有迁移机制里加（下次 daemon 启动生效，与 `source_cwd` 迁移同机制）：
- `ALTER TABLE memories ADD COLUMN value_class TEXT`（现有行默认 NULL，不回填）。
- `CREATE TABLE memory_discards (...)` + 索引。
- 用 `PRAGMA table_info` 守卫幂等（同现有迁移模式）：列已存在 / 表已存在则跳过。

### 5.5 Scheduler 改动 `src/scheduler.ts`

`tick`（`scheduler.ts:103`）在 `distillTranscript` 产出 `candidates`（现有）后、`dedupCandidates`（现有）前，插入价值过滤：

```
1. candidates 为空 -> 跳过价值过滤（原逻辑直接进 done）。
2. verdicts = await judgeValue(candidates, deps.callAnthropic)
3. partition:
   keep = candidates[i] where verdicts[i].keep === true   (携带 verdict.valueClass)
   discarded = { title, bodyMd, reason } where verdicts[i].keep === false
4. try { await logDiscards(db, job.id, discarded) } catch (e) { console.warn(e); /* swallow */ }
5. keep 子集 -> dedupCandidates(db, deps.callAnthropic, keep, jobCwd ?? null) -> deduped  [现有]
6. for each survivor: createCandidate(db, { ..., valueClass: <该候选 verdict.valueClass> })
```

- `TickDeps` 不变（仍 `loadTranscript` / `callAnthropic` / `createCandidate`）。`judgeValue` / `logDiscards` 由 tick 直接 import（同 dedup 直接 import 模式）。
- `createCandidate` 入参在现有基础上加 `valueClass`（取自该候选的 verdict.valueClass，可能为 null）。
- **valueClass 穿透 dedup**：`valueClass` 在 verdict 里，不在 `DistillCandidate` 上。tick 维持 `candidate -> valueClass` 映射（如 `{cand, valueClass}[]` 的 keep 列表），只把 `cand[]` 喂给 `dedupCandidates`；dedupCandidates 返回的 `DistillCandidate` 是输入数组的**同引用子集**（`scheduler.ts:89` 的 `candidates.filter(...)`），tick 据引用回挂 valueClass 给 survivor。dedupCandidates 签名/行为不变。
- `judgeValue` 的 LLM 异常被 §5.1 代码层映射吞掉（全 keep+null），**不冒泡**到 tick catch--价值判定失败 ≠ distill 失败，不应让 job 退回 pending（同 dedup 的 `judgeDuplicates`）。
- `logDiscards` 的 DB 异常被 tick 显式 swallow（best-effort 审计），不冒泡。
- `dedupCandidates` / `listForDedupByScope` 的 DB 异常仍冒泡到 tick catch，job 退避重试（沿用现有，不变）。

### 5.6 dedup prompt 中性化 `src/memory/dedup.ts`

删 `DEDUP_SYSTEM_PROMPT`（`dedup.ts:24`）末句 "When unsure, emit isDuplicate:false."。其余不变。代码层 fallback（`judgeDuplicates` 现有逻辑）全保留：LLM 抛错 / 非 JSON / 缺 verdicts / 缺 index / 幻觉 duplicateOfId => 全 `duplicate:false`。

### 5.7 UI 改动 `src/web/App.tsx` + `src/web/api.ts`

- **派生优先级**：`priority(valueClass)` = decision/convention => `'high'`，trap/topology => `'medium'`，null => `'unevaluated'`。
- **排序**：candidates 按 priority 排：high -> medium -> unevaluated。
- **徽标**：每张 `MemoryCard` 显示 `高·决策` / `高·约定` / `中·陷阱` / `中·拓扑` / `未评估`。
- **批量拒绝**：新端点 `POST /api/memories/bulk-promote` `{ids:string[], action:'reject'}`（`server.ts`），循环调 `promoteCandidate(db, id, {action:'reject'})`（逐条事务、逐条广播 `memory.promoted`）；UI 加"批量拒绝未评估"按钮，一键拒掉所有 `value_class=null` 候选。
- 样式复用 `MemoryCard` 既有 chrome，不引新框架。

### 5.8 Daemon wiring `src/daemon.ts`

无改动。`tickDeps.callAnthropic` 已被 `judgeValue` 经 `deps.callAnthropic` 复用。

## 6. 数据流

```
hook(Stop) -> events(payload=transcript) -> job(pending)
tick:
  loadTranscript(job) -> turns
  distillTranscript(turns) -> candidates: DistillCandidate[]          [现有]
  --- 新增价值过滤 ---
  judgeValue(candidates, callAnthropic) -> verdicts[]
    category public-knowledge/derivable      -> keep:false, reason
    category decision/convention/trap/topology -> keep:true, valueClass
    无合法分类                                -> keep:true, valueClass:null
  partition keep / discarded
  logDiscards(db, job.id, discarded) -> memory_discards              [best-effort]
  --- 价值过滤结束 ---
  dedupCandidates(db, callAnthropic, keep, jobCwd) -> deduped         [现有]
  for each survivor: createCandidate(..., valueClass) -> memories(candidate, value_class)
  job -> done
注入（不变）：SessionStart -> listApprovedByScope -> formatMemoryBlock
```

## 7. 与现有模块的耦合点

- **distillTranscript / DistillCandidate**（`distiller.ts`）：judgeValue 消费其产出，不改 distiller。
- **dedupCandidates**（`scheduler.ts`）：judgeValue 在其前跑，只把 keep 子集喂给 dedup。dedup 逻辑不变（仅 prompt 中性化）。
- **createCandidate**（`store.ts`）：入参加 valueClass，仍纯 INSERT。
- **listApprovedByScope / formatMemoryBlock**（`store.ts`/`pure.ts`）：不动 approved，注入路径完全不变。`value_class` 不参与注入（注入只读 title/bodyMd）。
- **TickDeps**（`scheduler.ts`）：不变。judgeValue 复用 `deps.callAnthropic`；`logDiscards` 用 tick 的 `db`。
- **迁移机制**（`client.ts`）：复用现有 PRAGMA 守卫幂等迁移，加列 + 建表。
- **WS 广播**：judgeValue 丢弃候选不产生广播；keep 的照常走 createCandidate 路径（server 层广播）。bulk-promote 逐条 reject 逐条广播 `memory.promoted`。

## 8. 失败模式

| 场景 | 行为 |
|------|------|
| `judgeValue` 内 LLM 调用抛错（网络/502/超时） | 整批全 `{keep:true, valueClass:null}`，不冒泡到 tick catch |
| LLM 返回非 JSON / 缺 `verdicts` | 同上，全未评估保留 |
| 某些 index 缺失 | 缺失的 `{keep:true, valueClass:null}` |
| category 幻觉（不在 6 个里） | 该条 `{keep:true, valueClass:null}` |
| `candidates=[]` | 返回 `[]`，不调 LLM |
| `logDiscards` DB 写失败 | tick 显式 swallow + console.warn，不冒泡（审计 best-effort，不为日志失败重跑 job） |
| `dedupCandidates` / `listForDedupByScope` DB 错 | 冒泡到 tick catch，job 退避重试（沿用现有） |
| 迁移未跑（daemon 未重启，value_class 列不存在） | createCandidate 写 value_class 抛错 -> 冒泡 tick catch -> 退避重试 -> failed。见 §11 风险 |

**原则**：judgeValue 判定只要拿不到合法分类，就退化为"保留未评估"。distill 流程不阻断、不重跑（同 dedup）。

## 9. 测试策略（镜像 dedup）

纯函数 / 纯数据层为主 + UI 源码层文本断言兜底（CLAUDE.md）。

- **`tests/valueFilter.test.ts`**（新，纯函数 + mock callAnthropic）：
  - 6 类别各一条 -> verdict 类别 + keep/valueClass/reason 正确映射。
  - public-knowledge/derivable -> `{keep:false, reason}`。
  - decision/convention/trap/topology -> `{keep:true, valueClass}`。
  - LLM 抛错 -> 全 `{keep:true, valueClass:null}`。
  - 非 JSON / 缺 `verdicts` -> 全 `{keep:true, valueClass:null}`。
  - 某些 index 缺失 -> 缺失的 `{keep:true, valueClass:null}`。
  - 幻觉 category（不在 6 个里）-> 该条 `{keep:true, valueClass:null}`。
  - `candidates=[]` -> 返回 `[]`，`callAnthropic` 未调用。
  - user prompt 含 title+bodyMd（断言内容）。
  - verdict `index` 与候选下标对齐。
  - **中性回归**：断言 `VALUE_JUDGE_SYSTEM_PROMPT` 不含 `discard`/`keep`/`dangerous`/`unsure`/`cautious`/`careful`（锁中性）。
- **`tests/dedup.test.ts`**（扩）：
  - **中性回归**：断言 `DEDUP_SYSTEM_PROMPT` 不含 `unsure`（锁住删除不回退）。
  - 现有 9 条全保留通过（改 prompt 不破坏代码层行为）。
- **`tests/scheduler.test.ts`**（扩）：
  - judgeValue 判 discard 的不调 `createCandidate`、不进 keep；keep 的进 dedup -> createCandidate。
  - judgeValue 失败（mock 抛错）-> 全 createCandidate（valueClass=null），job 仍 done 不退回。
  - keep 的 createCandidate 入参带正确 valueClass。
  - 顺序：judgeValue 在 dedupCandidates 之前（discard 的不进 dedup）。
  - `logDiscards` 被调用且入参含正确 title/bodyMd/reason。
  - `logDiscards` 抛错 -> swallow，keep 候选仍正常 createCandidate，job done。
- **`tests/store-crud.test.ts`**（扩）：
  - `createCandidate` 写 `value_class`（传 / 不传）。
  - `logDiscards` 写入 `memory_discards`，reason/title/bodyMd/distillJobId 正确；`discards=[]` no-op。
  - 迁移幂等：加 value_class 列 + memory_discards 表，PRAGMA 守卫跑两次不报错。
- **`tests/server.test.ts`**（扩）：`POST /api/memories/bulk-promote` 多 id reject 成功 + 逐条广播。
- **UI 兜底**：`App.tsx` 源码层文本断言（排序标签 `高·决策` 等 / "批量拒绝未评估"按钮存在），符合 CLAUDE.md 运行时组件最低保留一条源代码层文本断言。

## 10. 落地流程（CLAUDE.md）

1. 已切 `feat/candidate-value-filter`（基线 `origin/master` `26b5418`）。
2. 本 spec 落档 + commit。
3. 调用 `writing-plans` skill 产出 `docs/superpowers/plans/2026-07-23-candidate-value-filter.md`。
4. 按计划实现 + 测试，`bun run typecheck && bun test` 全绿。
5. push -> PR 合 master。

## 11. 风险

- **迁移未应用**：`value_class` 列在 daemon 重启前不存在。`createCandidate` 写 `value_class` 会在旧 schema 上抛错（未知列）-> 冒泡 tick catch -> 退避重试 -> failed。这与 `source_cwd` 迁移同风险（STATE.md debt #4）。缓解：迁移用 PRAGMA 守卫幂等；用户重启 daemon 即应用。**本 spec 不自动重启 daemon。**
- **dedup 中性化后误判重复丢弃概率上升**：删 "When unsure:false" 后，LLM 可能对边界相似候选判 true + 给合法 id 而静默丢弃。代码仍挡幻觉 id。用户已接受此风险（不加审计）。若未来发现误丢，可再开 spec 给 dedup 加审计。
- **judgeValue 多一次 LLM 调用**：每 distill 批多 ~12s 调用。distill 异步 + 5s debounce + 1Hz tick，不阻塞 hook ack。可接受（与 dedup 同量级）。

## 12. 涉及文件

- 新增：`src/memory/valueFilter.ts`、`tests/valueFilter.test.ts`
- 改：`src/memory/store.ts`（`MemoryInput`/`Memory` 加 valueClass、`createCandidate` 写列、`logDiscards`）、`src/scheduler.ts`（tick 插价值过滤）、`src/db/schema.ts`（value_class 列 + memory_discards 表）、`src/db/client.ts`（迁移）、`src/memory/dedup.ts`（删偏向句）、`src/server.ts`（bulk-promote 端点）、`src/web/App.tsx` + `src/web/api.ts`（排序/徽标/批量按钮）
- 扩测试：`tests/dedup.test.ts`、`tests/scheduler.test.ts`、`tests/store-crud.test.ts`、`tests/server.test.ts`
- 落档：本 spec + `docs/superpowers/plans/2026-07-23-candidate-value-filter.md`
