# 蒸馏工作记录透明化（distill work-record transparency）- 设计 spec

日期：2026-07-29
分支：`feat/distill-work-record`（基线 `origin/master`）
状态：设计已与用户逐段确认通过，待用户复核 spec 文件。

## 1. 背景

memside 的 distill 管线工作记录是黑盒。一个 distill job 跑完后能查到的只有：job 元数据
（`status`/`attempts`/`last_error`）、events 表里的完整 transcript（DB 膨胀元凶，667MB）、
过滤版输入（`memory_distill_inputs`，但**只在有候选入库时才存**）、被拒候选
（`memory_discards`）、入库候选（`memories`）。

缺失的部分：
1. **LLM 产出完全没落盘**--distiller 返回的 candidates（即使为空）没记录，dedup verdicts、
   valueFilter verdicts 中间态也没记录。
2. **0 产出的 job 不存输入**--`saveSourceInput` 有 `keepWithClass.length > 0` 条件门
   （`src/scheduler.ts:203`）。
3. **区分不出"增量跳过没调 LLM"**（`newTurns.length===0` 提前 `continue`，`scheduler.ts:131`）
   vs"真调了 LLM 返回空"--都是 `status='done'`。

### 实际痛点

2026-07-29 排查"近一天无新增记忆"时，只能靠反推 `memory_session_offsets` 表确认 LLM 被调了，
完全看不到模型到底返回了什么、为什么是 0。过去 24h 71 个 job 全部 `status=done`、0 候选、
0 discards，无法判断是"按设计拒绝自身实现"还是"LLM 调用静默失败被 catch 吞掉"。

### 相关旧 spec

- `2026-07-28-source-input-traceability`：已建 `memory_distill_inputs` 表存过滤版输入，但有
  条件门。本 spec 复用其过滤版快照哲学，去掉条件门。
- `2026-07-29-distill-signal-recovery`：放宽 origin discipline。本 spec 不动 distill 逻辑，
  只在产出侧加透明度。

## 2. 目标 / 非目标

### 目标

- 每个 distill job 落一条**运行记录**：outcome（四态）+ distiller 原始产出（LLM 返回的候选，
  含被格式校验丢弃的）+ 四道闸计数（distilled->deduped->filtered->stored）+ 耗时。
- **去掉输入条件门**：0 产出 job 也存过滤版输入，让你能看到"模型看到了什么却返回 0"。
- **Web UI 第 5 个 tab**「蒸馏记录」：列表展示计数链 + outcome 徽标，点开看产出/输入。
- 状态可见性：fetch 失败显示错误横幅，加载中显示 spinner，不静默 stall（CLAUDE.md 硬规则）。

### 非目标（YAGNI）

- ❌ dedup/valueFilter **中间判定明细**（哪几条判成重复/判成什么类）。本轮只记结果+计数；
  discards 表已记录 valueFilter 丢弃侧的 title/body/reason，dedup 丢弃侧不单独记。中间明细
  存储/复杂度过高，留后续。
- ❌ 存量回填。历史 job 没有运行记录，列表里查不到，不撒谎回填。
- ❌ 改 distiller 的格式校验丢弃逻辑。被丢候选通过 `rawOutput` 透明化，但丢弃行为不变。
- ❌ events 表清理 / TTL。那是 STATE.md 已知债务#1，本轮不碰。新表与 events 解耦。
- ❌ 完整原始版 transcript 展示。UI 只展示过滤版（模型实际所见），与 source-input-traceability
  哲学一致。

## 3. 用户确认的关键决策

| 决策 | 选项 | 用户选定 |
|------|------|----------|
| 主要消费者 | 运维排查（SQL）/ Web UI 可视 / 两者 | **Web UI 可视为主** |
| 记录粒度 | 结果+计数 / 含中间明细 / 仅 distiller 产出 | **结果+计数** |
| 输入展示版 | 过滤版+去门 / 复用 events 完整版 / 两版可切换 | **过滤版+去门** |
| UI 摆放 | 第 5 个 tab / 状态栏抽屉 / 独立页面 | **第 5 个 tab** |
| 存储架构 | 新建 runs 表 / 扩展 inputs 表 / 复用 events | **新建 `memory_distill_runs` 表**（方案 A） |

## 4. 数据模型

### 新表 `memory_distill_runs`（`src/db/schema.ts` + `src/db/client.ts`）

| 列 | 类型 | 说明 |
|----|------|------|
| `distill_job_id` | TEXT PRIMARY KEY | 1:1 随 job，逻辑键不设 FK（与 `memory_distill_inputs` 一致，解耦未来 job 清理/TTL） |
| `outcome` | TEXT NOT NULL | `skipped_no_new_turns` / `empty_output` / `llm_error` / `produced` |
| `raw_output_json` | TEXT | distiller 调 LLM 的原始解析输出（candidates 数组原样，含被格式校验丢弃的）。无候选/跳过/报错时为 null |
| `distilled_count` | INTEGER NOT NULL | LLM 原始返回的候选数（含格式不合格被丢的） |
| `accepted_count` | INTEGER NOT NULL | distiller 格式校验后通过的候选数（喂给 dedup 的） |
| `deduped_count` | INTEGER NOT NULL | dedup 后存活数 |
| `filtered_count` | INTEGER NOT NULL | valueFilter 后存活数 |
| `stored_count` | INTEGER NOT NULL | 最终入库候选数 |
| `discarded_count` | INTEGER NOT NULL | valueFilter 丢弃数（= accepted - filtered） |
| `duration_ms` | INTEGER NOT NULL | distillTranscript 耗时（仅 LLM 调用段，不含加载/入库） |
| `ts` | INTEGER NOT NULL | 写入时间 |

**outcome 四态**（直接治"区分不出跳过 vs 返回空"的痛点）：
- `skipped_no_new_turns`：`newTurns.length === 0` 提前 `continue`，没调 LLM（`scheduler.ts:131`）。
- `empty_output`：真调了 LLM，返回 0 候选（`callThrew=false` 且 `accepted_count===0`）。
- `llm_error`：callWithRetry 耗尽仍失败（`callThrew=true`）。
- `produced`：有候选产出（`accepted_count > 0`，无论最终是否入库）。

`raw_output_json` 存 LLM 返回的**原始**解析结果（`distillTranscript` 现在丢弃的格式不合格
候选也保留），配 `distilled_count`(原始) vs `accepted_count`(校验后) 能看出"LLM 返回 5 条但
2 条格式不对被 distiller 丢"。

### 迁移（`src/db/client.ts`）

套用现有幂等 `CREATE TABLE IF NOT EXISTS` 风格（与 `memory_distill_inputs` 同模式）：

```sql
CREATE TABLE IF NOT EXISTS memory_distill_runs (
  distill_job_id   TEXT PRIMARY KEY,
  outcome          TEXT NOT NULL,
  raw_output_json  TEXT,
  distilled_count  INTEGER NOT NULL,
  accepted_count   INTEGER NOT NULL,
  deduped_count    INTEGER NOT NULL,
  filtered_count   INTEGER NOT NULL,
  stored_count     INTEGER NOT NULL,
  discarded_count  INTEGER NOT NULL,
  duration_ms      INTEGER NOT NULL,
  ts               INTEGER NOT NULL
);
```

幂等、无列增删，老 DB 升级零风险。同步在 `openDb` 的 drizzle schema 注册对象 + raw DDL 块加表。

### `memory_distill_inputs` 去条件门

不改表结构，只改写入条件（见 §5）。0 产出 job 现在也写过滤版输入。

## 5. 写入侧

### `distillTranscript` 返回值扩展（`src/memory/distiller.ts`）

`DistillResult` 已有 `candidates` / `filteredTurns`，再加三段产出溯源：

```ts
export interface DistillResult {
  candidates: DistillCandidate[]        // 现有：格式校验通过的候选
  filteredTurns: TranscriptTurn[]       // 现有：喂给模型的过滤版输入
  rawOutput: unknown | null             // 新：LLM 原始解析输出（candidates 数组原样，含被丢的）
  rawCount: number                      // 新：LLM 返回的原始候选数
  callThrew: boolean                    // 新：底层 LLM 调用是否抛错（区分 llm_error vs empty_output）
}
```

- `rawOutput`：`callWithRetry` 返回的 parsed 对象原样存。即使格式校验把候选全丢，`rawOutput`
  仍留着模型到底返回了什么。
- `rawCount`：从 `rawOutput.candidates` 数组长度取（parsed 非 undefined 且有 candidates 数组时），
  否则 0。这是"模型自以为产出了几条"。
- `callThrew`：现有 `wrappedCall` 已在跟踪此标志（`distiller.ts:165-173`），只是没 return 出来。
  现在透出，让 scheduler 据此判定 `outcome=llm_error`。
- 失败降级（catch 吞错）返回 `{ candidates: [], filteredTurns: [], rawOutput: null, rawCount: 0, callThrew: true }`。
- `skipped_no_new_turns` 不走 distiller（scheduler 提前 continue），不会有 DistillResult。

### `scheduler.tick` 接线（`src/scheduler.ts`）

在 `distillTranscript` 调用点解构出新增三段，然后：

1. **outcome 判定**：`callThrew` -> `llm_error`；否则 `accepted_count === 0`（即
   `candidates.length===0`）-> `empty_output`；否则 `produced`。
2. **计数采集**：各闸计数现在散在 tick 里已有（`candidates.length` / `deduped.length` /
   `keepWithClass.length` / `discarded.length`），收集成 run record。`distilled_count` 来自
   `rawCount`，`accepted_count` = `candidates.length`。
3. **写 `memory_distill_runs`**：在现有 `saveSourceInput` 调用点（入库循环之后、`status='done'`
   之前）加一个 best-effort `saveDistillRun(db, job.id, record)`，与 `saveSourceInput`/
   `logDiscards`/`setSessionOffset` 同级。
4. **写 `memory_distill_inputs` 去门**：把 `scheduler.ts:203` 的
   `if (keepWithClass.length > 0)` 改为 `if (outcome !== 'skipped_no_new_turns')`，让 0 产出
   job 也存过滤版输入。
5. **`skipped_no_new_turns` 分支**：`scheduler.ts:131` 的提前 continue 处，加一个 best-effort
   `saveDistillRun` 写 `outcome='skipped_no_new_turns'`、各计数为 0、`raw_output_json=null`、
   `duration_ms=0`，再 continue。

### `saveDistillRun`（`src/memory/store.ts`，与 `saveSourceInput` 同模式）

UPSERT，`onConflictDoUpdate` 覆盖（job 重试场景）：

```ts
export async function saveDistillRun(db: DbClient, distillJobId: string, record: {
  outcome: DistillOutcome
  rawOutput: unknown | null
  rawCount: number
  acceptedCount: number
  dedupedCount: number
  filteredCount: number
  storedCount: number
  discardedCount: number
  durationMs: number
}): Promise<void>
```

`rawOutput` JSON 序列化进 `raw_output_json`（null 时存 NULL）。

### best-effort 契约

`saveDistillRun`/`saveSourceInput` 写失败只 warn、不阻塞 done（候选已入库，运行记录缺失只
影响透明度，不影响闭环）。与现有 `logDiscards` 完全同级。

### 透明度增益

distiller 内部格式校验丢弃路径（`distiller.ts:186` `if (!o.title.includes('[category:')) continue`）
现在被 `rawOutput` 透明化--你能在 `raw_output_json` 里看到被丢的那条原始内容，但
`accepted_count` 不含它。不需要改丢弃逻辑。

## 6. 读取侧

### store 读函数（`src/memory/store.ts`）

```ts
export type DistillOutcome = 'skipped_no_new_turns' | 'empty_output' | 'llm_error' | 'produced'

export interface DistillRunRow {
  distillJobId: string
  outcome: DistillOutcome
  rawOutput: unknown | null
  rawCount: number
  acceptedCount: number
  dedupedCount: number
  filteredCount: number
  storedCount: number
  discardedCount: number
  durationMs: number
  ts: number
}

export function getDistillRun(db: DbClient, distillJobId: string): DistillRunRow | null
export function listRecentDistillRuns(
  db: DbClient,
  limit?: number,
): (DistillRunRow & { cwd: string | null; runtime: string; createdAt: number; sourceAgentId: string | null })[]
```

- `getDistillRun`：单行查，`raw_output_json` 反序列化失败时 `rawOutput=null`（不崩，UI 降级
  显示"无法解析产出"）。
- `listRecentDistillRuns`：JOIN `memory_distill_jobs` 带出 `cwd`/`runtime`/`created_at`/
  `source_agent_id`（列表行需要这些展示），`ORDER BY ts DESC LIMIT 200`（默认，与 `listDiscards`
  同模式）。列表行**不含** `rawOutput`（可能很大，走专用端点）。

### server 端点（`src/server.ts`）

```
GET /api/distill-runs                   // 列表：最近 N 个 run，含 job 元数据，不含 rawOutput
GET /api/distill-runs/:jobId            // 详情：单个 run，含 rawOutput（点开看产出时拉）
GET /api/distill-runs/:jobId/source-input  // 该 job 的过滤版输入 turns（点"查看输入"时拉）
```

- `GET /api/distill-runs`：调 `listRecentDistillRuns`，响应每行含 outcome 徽标所需全字段 +
  cwd（UI 显示 basename）+ createdAt + sourceAgentId。`?limit=` 可选（默认 200，上限 500）。
- `GET /api/distill-runs/:jobId`：调 `getDistillRun`，无行 -> 404。有行 -> 返回完整
  `DistillRunRow`（含 `rawOutput`）。
- `GET /api/distill-runs/:jobId/source-input`：取 `memory_distill_inputs` 那行，逻辑同
  source-input-traceability 的 `getSourceInput`，只是键直接用 jobId（不反查 memory）。有行 ->
  返回 turns + turnCount + charCount；无行 -> 404。

**为什么不复用 `GET /api/memories/:id/source-input`**：那是按 memoryId 查，而 distill run 详情
  里要按 jobId 查（一个 job 可能产 0 候选，没有 memory 可关联）。走独立 jobId 端点。

### `/api/status` 加计数

参照已有 discards 计数，加最近 24h 的 run 数 + outcome 分布
（`{produced, empty_output, llm_error, skipped_no_new_turns}` 各几个），让顶部状态栏一眼看出
"今天 distill 在不在跑、产出健康度"。

## 7. Web UI（第 5 个 tab + 复用现有 chrome）

### tab 结构

在现有 4-tab 审计视图加第 5 个 tab「蒸馏记录」。计数徽标显示最近 24h 的 run 总数（与现有
tab 徽标风格一致）。

### 列表行（DistillRunRow 组件）

每行一个 job，展示：
- 时间（`createdAt` 相对时间）
- cwd basename（`sourceAgentId` 非空时显示 `subagent` 标记）
- **outcome 徽标**（四态各一色）：
  - `produced` 绿 · `empty_output` 灰 · `llm_error` 红 · `skipped_no_new_turns` 浅灰
- **计数链** `N->M->K->J`（distilled->deduped->filtered->stored）：直观显示"在哪一步被杀光"。
  例如 `5->3->1->1` vs `0->0->0->0`（empty_output）vs `0->0->0->0`（skipped，靠徽标区分）。
- 耗时（`durationMs`）

### 点开详情（DistillRunModal，复用 SourceInputModal 模式）

点击列表行打开遮罩层，分两区：
- **产出区**：展示 `rawOutput`（LLM 返回的候选 JSON）。按候选渲染--每条显示 title/bodyMd/scope，
  被 distiller 格式校验丢弃的标灰（通过比对 rawCount vs acceptedCount 提示"模型返回 N 条，
  M 条格式不合格被丢弃"）。`empty_output` 显示"LLM 返回 0 候选"；`llm_error` 显示错误态；
  `skipped` 显示"该 job 无新 turn，未调用 LLM"。
- **输入区**：「查看原始输入」按钮 -> 懒加载 `GET /api/distill-runs/:jobId/source-input` ->
  复用现有 `SourceInputModal` 的 turns 渲染逻辑（按 role 分色 `<pre>`）。不点不拉。

### 状态可见性（CLAUDE.md 硬规则）

- 列表 fetch 失败显示错误横幅，不空白 stall
- 加载中显示 spinner
- 切到该 tab 才轮询（`useEffect [tab]` + clearInterval，与现有 tab 切换轮询同模式，tabRef 防
  stale-fetch 竞态）
- 详情遮罩层三态：loading / error / data，绝不空白

### 复用约束

用 `src/web/App.tsx` 既有样式风格与 `MemoryCard`/`DiscardCard` 组件骨架，不引入新样式框架。
`DistillRunRow` 抽纯函数 `formatRunCounts` / `formatOutcome` 到 `src/web/ui-utils.ts`（纯函数层
测，与 `formatSourceTurn` 同策略）。

## 8. 错误处理

| 故障点 | 行为 | 依据 |
|--------|------|------|
| `saveDistillRun` 写库失败 | warn、不重试、不阻塞 done | 与 `logDiscards`/`saveSourceInput`/`setSessionOffset` 同级 best-effort；候选已入库，记录缺失只影响透明度 |
| `saveSourceInput` 写库失败（去门后） | warn、不阻塞 done | 同上 |
| `getDistillRun` 反序列化失败 | 返回 null（rawOutput=null） | UI 降级显示"无法解析产出"，不崩 |
| `GET /api/distill-runs/:jobId` 无行 | 404 | 与 `GET /api/memories/:id` 一致 |
| `GET /api/distill-runs/:jobId/source-input` 无行 | 404 | 无输入快照（skipped job / 存量） |
| 列表/详情 fetch 失败 | 显示错误横幅/错误态 | CLAUDE.md 状态可见性：不得静默 stall |
| 加载中 | 显示 spinner | 同上 |

## 9. 测试策略

按 CLAUDE.md「首选可断言面」--纯函数层测足，运行时/UI 层留少量集成断言。

### 纯函数层（重）

- `tests/distiller.test.ts`（扩）：`DistillResult` 返回 `rawOutput`/`rawCount`/`callThrew` 四态--
  正常产出（rawOutput=数组、rawCount=N、callThrew=false）/ LLM 报错降级（rawOutput=null、
  rawCount=0、callThrew=true）/ 返回空（rawOutput={candidates:[]}、rawCount=0、callThrew=false）/
  格式校验丢弃（rawCount > acceptedCount，rawOutput 保留被丢条目）。
- `tests/ui-utils.test.ts`（新）：`formatRunCounts(N,M,K,J)` 渲染、`formatOutcome` 四态->
  标签/颜色映射。

### store 层

- `tests/store.test.ts`（扩）：`saveDistillRun` insert + UPSERT 覆盖（job 重试）、`getDistillRun`
  命中/反序列化失败 null、`listRecentDistillRuns` JOIN job 元数据 + LIMIT 200 + DESC。

### scheduler 层（`tests/scheduler.test.ts` 扩）--核心回归锁定

1. **outcome 四态各一**：`skipped_no_new_turns`（newTurns 空 -> 写 run record 各计数 0 ->
   continue）/ `empty_output`（mock LLM 返回空 -> outcome 空、写入）/ `llm_error`（mock LLM
   抛错 -> outcome error、写入）/ `produced`（正常 -> outcome produced、计数链正确）。
2. **去门回归**：0 候选 job 现在也写 `memory_distill_inputs`（旧测试断言"0 候选不写
   source-input"需同步改为"0 候选也写"）。
3. **best-effort**：`saveDistillRun` 抛错 -> job 仍 done、候选仍入库（与 `saveSourceInput`/
   `logDiscards` 同级断言）。
4. **计数链正确性**：`produced` 路径下 `distilled_count >= accepted_count >= deduped_count >=
   filtered_count`，`stored_count` = 最终入库数，`discarded_count = accepted - filtered`。

### server 层（`tests/server.test.ts` 扩）

- `GET /api/distill-runs`：列表不含 rawOutput（文本断言）、含 job 元数据、LIMIT 生效。
- `GET /api/distill-runs/:jobId`：详情含 rawOutput / 404。
- `GET /api/distill-runs/:jobId/source-input`：有 turns / 无行 404。
- `/api/status` 含 distillRuns 计数。

### 运行门槛

`bun run typecheck && bun test` 必须全绿才能 push（CLAUDE.md 硬规则）。spec「测试策略」列的
case 必须跑绿才算交付。

## 10. 与现有模块的耦合点

- `src/memory/distiller.ts` `distillTranscript`：返回值类型扩展（`DistillResult` 加
  `rawOutput`/`rawCount`/`callThrew`），所有调用方（`scheduler.tick` + 测试）需同步。不改
  distill 逻辑、不改 `DISTILLER_SYSTEM_PROMPT`。
- `src/scheduler.ts` `tick`：`distillTranscript` 调用解构 + outcome 判定 + 计数采集 + 两个
  best-effort 写入分支（saveDistillRun 在 produced/empty/llm_error 分支 + skipped 分支）+
  `saveSourceInput` 去条件门。
- `src/db/schema.ts` + `src/db/client.ts`：新表 `memory_distill_runs` + DDL + drizzle 注册。
- `src/memory/store.ts`：`saveDistillRun` + `getDistillRun` + `listRecentDistillRuns` 三个新
  函数 + `DistillOutcome`/`DistillRunRow` 类型。
- `src/server.ts`：三个新 GET 路由 + `/api/status` 加 distillRuns 计数。
- `src/web/api.ts`：`listDistillRuns` / `getDistillRun` / `getDistillRunSourceInput` client +
  类型。
- `src/web/App.tsx`：第 5 个 tab + `DistillRunRow` + `DistillRunModal`。
- `src/web/ui-utils.ts`：`formatRunCounts` / `formatOutcome` 纯函数。

## 11. 失败模式

- **运行记录缺失但不影响闭环**：写入失败 / 存量 job -> 列表查不到或详情 404 -> 不影响候选
  审批、注入。最坏情况是"看不到某次运行记录"，不是"闭环断"。
- **rawOutput 与展示偏差**：不可能--存的就是 `callWithRetry` 返回的 parsed 对象原样，不经
  二次加工。
- **大内容拖垮列表**：不可能--rawOutput 走专用详情端点懒加载，列表接口不含 rawOutput；过滤版
  输入走独立 source-input 端点懒加载。
- **runs 表膨胀**：每 job 一行结构化记录（raw_output_json 可能较大但已是 LLM 产出，体积有界
  于模型输出 token 上限），与 events 表（存完整 transcript，667MB 元凶）解耦。未来随 events
  清理策略一起规划（STATE.md 已知债务#1），本轮不碰。
- **outcome 误判**：`callThrew` 标志由 `wrappedCall` 捕获底层 throw 设置，可靠区分 LLM 报错
  vs 返回空。`skipped` 由 scheduler 提前 continue 分支显式写入，不依赖推断。
