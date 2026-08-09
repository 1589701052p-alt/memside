# 蒸馏上下文补全与攒量批处理 — 设计 spec

日期：2026-08-09
状态：已确认（brainstorming 多轮问答 + 三方案对比后用户批准方案 C）

## 1. 背景

对照 hermes-agent 记忆机制分析（2026-08-08/09 会话）发现 memside 蒸馏管线的两个结构性缺陷：

1. **distiller 上下文不全**。claude code 的 Stop hook 每轮触发一次 capture，每次建一个 distill job；tick 侧按 session offset 切片，distiller 只看得到"自上次蒸馏以来的新 turn"。live DB 实测（会话 `79caec90`）：一个 37+ turn 的会话产生 7 个 job，每个 job 输入仅 2~12 turn（1.4K~18.7K 字符）。distiller 拿着孤立切片判断"什么值得记"，缺少同会话前文与已审批记忆两个关键上下文。对照：hermes 的 background review fork 全量回放当前会话（`background_review.py:35-36`），且写记忆者在 system prompt 里看得到已有记忆。
2. **触发过多**。hermes 每 10 个用户回合提炼一次；memside 每次 Stop 都建 job——同一会话 hermes 提炼 1~2 次，memside 7 次。代价：薄切片噪音、琐碎 job 必然空产白烧 LLM 调用、同主题跨切片重复生产（压力推给事后 dedup）。

但 char 阈值**不能**预测 produced vs empty_output：live DB 25 个有输入记录的 job 中，empty 的字符中位数（25K）≈ produced（26K）。空产主因是内容（话题已覆盖、纯执行无决策），不是切片薄。因此阈值的定位是"消灭薄切片噪音 + 攒出上下文厚度"，不是"预测空产"。样本量小（inputs 表上线不久），默认值取保守直觉档，上线后观测调整（**观测结果必须记录 STATE.md**——用户明确要求）。

### 已确认的关键决策（brainstorming 问答记录）

1. **攒量机制两侧统一**：claude code（Stop/SessionEnd）与 opencode（idle capture）都走同一套会话级累加。
2. **digest 双模式复用现有 judgeConfig.mode 开关**：质量模式 = 滚动 LLM 摘要，经济模式 = 确定性截断。不设独立开关。
3. **质量模式滚动摘要而非现场摘要**：每 session 一份滚动摘要存 DB，每次提炼后增量合并，成本摊薄；失败降级确定性截断。（hermes 的"全量原文 + prompt cache"路线依赖三个未验证外部事实——Ark context caching 支持/计费/TTL——不纳入本期，留后续探索。）
4. **已审批记忆以仅标题形态进 prompt**（project ∪ global，上限 100 条 / 2K 字符）。理由：distiller 对已有记忆只能做"跳过/提炼"二元判断（无合并通路），body 细节没有出口；标题盲区由 dedup 阶段兜底。
5. **阈值为代码常量**，进设置 tab 是 YAGNI。
6. **降级必须用户可见**：不允许只写 console.warn 的静默降级，统一走 `memory_degradations` 审计表 + UI 呈现（§8）。
7. **架构方案 C**：会话级累加 job（一个 session 一个活跃 job，events 一 job 一行 upsert），而非新建缓冲表（方案 A）或 tick 侧延迟放行（方案 B）。方案 C 顺手消掉 STATE.md 已知债务 #1 的主体（events 表 92MB 重复全量快照 → 每 session 一份）。

## 2. 目标 / 非目标

### 目标

- 会话级累加：一个 (runtime, sessionId) 同一时刻最多一个 `waiting` 状态的 distill job；capture 时 upsert 最新全量快照，攒够阈值才放行提炼。
- 三触发放行：阈值（主力，capture 时判）→ SessionEnd flush（claude 有序退出）→ TTL 2h 扫描（兜底：opencode 无会话结束事件、claude 崩溃/强杀时 SessionEnd 不可靠）。
- distiller 输入扩展：新切片 + 前文 digest（背景，禁止提炼）+ 已审批标题清单（禁止重复）+ slug 清单（现状保留）。
- 滚动摘要：质量模式每 session 一份 LLM 滚动摘要；经济模式确定性 digest。
- 降级全可见：`memory_degradations` 审计表 + 全局横幅 + 蒸馏记录行级徽标。
- 阈值常量：`DISTILL_RELEASE_MIN_CHARS=8000` / `DISTILL_RELEASE_MAX_TURNS=50` / `DISTILL_TRIVIAL_FLOOR_CHARS=1000` / `SESSION_FLUSH_TTL_MS=2h`。

### 非目标

- 不改 dedup / valueFilter / agent 终审 / 审批队列的任何逻辑。
- 不改注入侧（formatMemoryBlock / clipByBudget / adapter）。
- 不做 hermes 式全量原文回放（依赖未验证的 Ark prompt caching，留后续探索）。
- 不做"distiller 提议更新/合并已有记忆"通路（届时才需要 body 细节，另一特性）。
- 不动 subagent job 的一次性全量语义（天然完整，只叠加琐碎下限）。
- 阈值不进设置 tab；不做阈值自动调优。

## 3. 架构与数据流

### 3.1 核心不变量

- **不变量 A（累加唯一）**：一个 (runtime, sessionId) 同一时刻最多一个 waiting job。
- **不变量 B（waiting 单向流转）**：waiting → pending（放行）或 waiting → done（skipped_trivial）。无 pending → waiting 回退，无 waiting → running 直达。
- **不变量 C（原料不丢）**：被跳过的内容只有两种归宿——判琐碎（`skipped_trivial`，有审计）或随下次全量快照自然并入后续切片。无静默丢弃。
- **不变量 D（一 job 一行 event）**：`memory_distill_events` 对累加 job 从 append-only 变 upsert，任何时刻恰一行（最新全量快照）。

### 3.2 数据流

```
claude Stop / opencode idle                     claude SessionEnd
        │                                              │
        ▼                                              ▼
  capture 路由 (fire-and-forget, <50ms ack)      flush 路由 (fire-and-forget)
        │                                              │
        ├─ 解析全量 transcript（现状不变）               └─ memory_session_flushes
        ├─ findWaitingJob(runtime, sessionId)             upsert (session_id, ts)
        │    ├─ 无 → 建 job(status='waiting')
        │    └─ 有 → 复用
        ├─ upsertSessionEvent(jobId, 最新全量快照)
        ├─ job.last_capture_at = now
        ├─ 本地过滤 + computeSliceSignal（纯计算，不调 LLM）
        └─ shouldRelease ──→ 放行：status='pending', nextRunAt=now
                                                     │
┌────────────────────────────────────────────────────┘
▼
tick (1Hz loop)
  ├─ 提炼选择：status='pending'（waiting 不可见，现状逻辑不动）
  ├─ sweep（每 tick 一次廉价 SQL，自身 try/catch）：
  │     waiting job 且 ── 有 flush 标记 ──→ isTrivial？skipped_trivial 收场 : 放行
  │                      └─ isStale(TTL) ──→ 同上
  └─ 提炼时 loadTranscript 不变（events 拼 turns + offset 切片）
        │
        ▼
  distiller 输入 = 新切片（只从这里提炼）
                 + 前文 digest（背景，禁止从中提炼）
                 + 已审批标题清单（禁止重复提炼）
                 + slug 清单（现状保留）
        │
        ▼
  提炼成功（质量模式、非 subagent）→ mergeRollingSummary（LLM 1 次小调用）
  → upsertSessionDigest；失败 → 留旧摘要 + digest_llm_failed 落表
```

### 3.3 阈值常量（`src/memory/threshold.ts`）

```ts
export const DISTILL_RELEASE_MIN_CHARS = 8000   // 放行：过滤后切片字符量
export const DISTILL_RELEASE_MAX_TURNS = 50     // 护栏：防单 job 切片无限变厚
export const DISTILL_TRIVIAL_FLOOR_CHARS = 1000 // flush/TTL 时低于此判琐碎
export const SESSION_FLUSH_TTL_MS = 2 * 60 * 60 * 1000
```

## 4. 组件与接口

### 4.1 新纯函数 `src/memory/threshold.ts`

```ts
export interface SliceSignal { chars: number; turnCount: number }

/** 切片信号：turns.slice(offset) 经 filterTranscriptForDistill 后的字符/turn 数。
 *  复用现有过滤管线，保证「信号量 = distiller 实际会看到的量」。 */
export function computeSliceSignal(turns: readonly TranscriptTurn[], offset: number): SliceSignal

export function shouldRelease(signal: SliceSignal): boolean  // chars≥8000 || turnCount≥50
export function isTrivial(signal: SliceSignal): boolean      // chars<1000
export function isStale(lastCaptureAt: number, now: number): boolean
```

### 4.2 新纯函数 `src/memory/contextDigest.ts`

```ts
export const DIGEST_MAX_CHARS = 3000
export const DIGEST_LINE_MAX_CHARS = 300

/** 确定性 digest：user/assistant 每条截 300 字单行，tool 只留 `[tool: 名字]`，
 *  时间序拼接，超 3000 字从最早处截。同输入逐字节同输出（prompt 稳定性）。 */
export function buildDeterministicDigest(turns: readonly TranscriptTurn[], maxChars?: number): string
```

### 4.3 滚动摘要 `src/memory/rollingSummary.ts`

```ts
/** 中立压缩 prompt：只压缩不评判，禁止 keep/discard 倾向性措辞
 * （遵守项目记忆：LLM 判定 prompt 必须中立）。 */
export const ROLLING_SUMMARY_SYSTEM_PROMPT: string

/** 把本次切片增量并入既有摘要。返回新摘要；LLM 错误向外抛（调用方降级保留旧摘要）。 */
export async function mergeRollingSummary(
  priorDigest: string | null,
  newTurns: readonly TranscriptTurn[],
  callLLM: LLMCall,
): Promise<string>
```

产出约束（代码强制，不信任 LLM）：超长截断至 `DIGEST_MAX_CHARS`；空产出视为失败抛错。

### 4.4 store 层扩展（`src/memory/store.ts`）

```ts
findWaitingJob(db, runtime, sessionId): Promise<DistillJob | null>  // status='waiting'，排除 subagent
upsertSessionEvent(db, jobId, payloadJson): Promise<void>           // 同事务 delete+insert，不变量 D
releaseWaitingJob(db, jobId): Promise<void>                         // waiting → pending, nextRunAt=now
markFlush(db, sessionId): Promise<void>                             // upsert flush 行
consumeFlush(db, sessionId): Promise<boolean>                       // 有则删并返 true（一次性）
getSessionDigest(db, sessionId): Promise<{ digest: string; mode: string } | null>
upsertSessionDigest(db, sessionId, digest, mode): Promise<void>
logDegradation(db, entry: { kind: string; detail?: string; distillJobId?: string; sessionId?: string }): Promise<void>
listRecentDegradations(db, sinceTs: number): Promise<DegradationRow[]>
```

### 4.5 schema 迁移（幂等，`client.ts`，沿用既有 ALTER/CREATE IF NOT EXISTS 模式）

- `memory_distill_jobs` ALTER 加 `last_capture_at INTEGER`（可空；老行 NULL，TTL 判定时 NULL 视为不过期——老 job 不走 sweep）。
- `jobs.status` 加 `'waiting'` 枚举值：**免表重建**——已核实 live DB DDL `status TEXT NOT NULL` 无 CHECK 约束（drizzle `enum` 是 TS 级），只需 `schema.ts` enum 数组加值。
- 新表 `memory_session_flushes(session_id TEXT PRIMARY KEY, ts INTEGER NOT NULL)`。
- 新表 `memory_session_digests(session_id TEXT PRIMARY KEY, digest TEXT NOT NULL, mode TEXT NOT NULL, updated_at INTEGER NOT NULL)`；`mode ∈ 'llm' | 'deterministic-fallback'` 记录上次成功构建方式。
- 新表 `memory_degradations(id TEXT PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT, distill_job_id TEXT, session_id TEXT)`。

### 4.6 distiller 输入与 prompt（`distiller.ts`）

`DistillInput` 加两可选字段：`priorContext?: string | null`、`approvedTitles?: string[]`。prompt 按序组装（空节整节省略，保持无上下文时与现状 prompt 逐字节一致——向后兼容）：

```
[既有 system prompt 不动]
## 背景（仅供理解上下文，禁止从中提炼）
<digest 文本>
## 已记录的记忆标题（禁止重复提炼）
<- 标题1>
## 新增会话内容（只从这部分提炼）
<切片，现状不变>
```

### 4.7 scheduler.tick 接线

- `priorContext`：质量模式取 `getSessionDigest`；无摘要且 offset>0 时现场 `buildDeterministicDigest(prefixTurns)` 兜底（legacy 会话中途接入）；offset=0 时为空。经济模式恒 `buildDeterministicDigest(prefixTurns)`。读失败 → null + `digest_read_failed` 落表。
- `approvedTitles`：复用质量模式现有 `listApprovedByScope` 查询（scheduler.ts 现有同款），上限 100 条；失败 → 空清单 + `titles_query_failed` 落表。
- 提炼成功且质量模式且非 subagent：`mergeRollingSummary` 并入本次切片 → `upsertSessionDigest(mode='llm')`；抛错 → 留旧摘要 + `digest_llm_failed` 落表。
- sweep：每 tick 对 waiting job 查 flush 标记 / TTL；`isTrivial` → 标 done + saveDistillRun(outcome='skipped_trivial')；否则放行。sweep 整体 try/catch，抛错 → `sweep_error` 落表，不炸 tick 主循环。

### 4.8 capture 路由改造（`server.ts`）

- Stop / opencode capture 的 fire-and-forget IIFE 改为累加流程（§3.2）；解析/入 IIFE try/catch / 202 ack 等既有契约不动。
- 新增 `SessionEnd` 分支：fire-and-forget `markFlush(session_id)`；失败 → `flush_mark_failed` 落表（detail 注明"TTL 兜底仍生效"）。
- capture 侧过滤/阈值计算抛错 → **立即放行** + `threshold_compute_error` 落表（阈值是优化非正确性依赖，宁可多提不可丢料）。
- subagent / 无 sessionId legacy 路径：维持"一次 capture 一个立即放行 job"现状；subagent 额外叠加 `isTrivial` 判定（低于下限 → skipped_trivial 不调 LLM）。
- `install.ts`：`EVENTS` 加 `'SessionEnd'`。SessionEnd 全 hook 共享 1.5s 预算，memside fire-and-forget 202 ack 满足。

### 4.9 Web UI

- `/api/status` 加 `recentDegradations: { count24h: number; latest: { kind, detail, ts } | null; acknowledgedTs: number | null }`；jobs 计数把 waiting 单列（`waitingJobs: number`），避免"积压"假象。
- 顶部状态栏：琥珀色降级条（与 lastError 红条并列）："近 24h N 次降级：<latest kind 人话>"，点击确认（acknowledgedTs 写 app_settings，计数起点重置）。
- 蒸馏记录 tab：`skipped_trivial` 新 outcome 徽标（`formatOutcome` 显式认新值 + 未知 outcome 兜底文案不空白）；runs 行降级徽标（该 job 有 degradations 行）；`DistillRunModal` 列 degradations 明细（kind + detail）。

## 5. 降级矩阵（全部伴随 degradations 落表，无静默）

| # | 失败点 | 行为 | kind |
|---|---|---|---|
| 1 | capture 过滤/阈值计算抛错 | 立即放行（退回现状） | `threshold_compute_error` |
| 2 | event upsert / job 创建 DB 抛错 | 本次捕获丢失（memory.enqueue.failed broadcast 现状）；下个 Stop 全量快照天然恢复 | `capture_persist_failed` |
| 3 | SessionEnd 处理抛错 | flush 标记丢失；TTL 兜底仍生效 | `flush_mark_failed` |
| 4 | 并发 capture（Stop 与 SessionEnd 同时） | 幂等：重复放行 no-op；sweep 只查 waiting 不碰 done | —（不变量 B 保证） |
| 5 | 滚动摘要 LLM 失败 | 留旧摘要（有界过期，下次成功追平） | `digest_llm_failed` |
| 6 | 摘要读取失败 | priorContext=null，distill 照常 | `digest_read_failed` |
| 7 | legacy 会话无摘要且 offset>0 | 现场 deterministic 兜底 | —（正常路径非降级） |
| 8 | 摘要 LLM 产出超长/空 | 超长代码强制截断 / 空视为失败走 #5 | `digest_truncated` / `digest_llm_failed` |
| 9 | sweep 抛错 | tick 主循环存活 | `sweep_error` |
| 10 | 已审批标题查询失败 | 空清单 | `titles_query_failed` |

**唯一允许的 console-only 路径**：`logDegradation` 自身写表失败（审计系统自身故障，无可再降级出口）。

配套硬约束：**新增降级路径必须同时新增 kind + logDegradation 调用**（测试 §6.7 源码断言锁定）。

## 6. 测试策略

### 6.1 纯函数层

- `threshold.ts`：`computeSliceSignal` 空切片/offset 边界/与过滤管线一致性；`shouldRelease` 7999/8000/8001 + turnCount 49/50 + OR 语义；`isTrivial` 999/1000；`isStale` TTL ±1ms。
- `contextDigest.ts`：截断/tool 只留名/时间序/总量截断方向；**逐字节稳定性**（同输入两次全等，锁 prompt 稳定性回归）；空输入。
- `rollingSummary.ts`（mock LLM）：prior=null 首建、增量合并、超长强制截断（锁 §4.3）、空产出抛错。

### 6.2 store 层

- `findWaitingJob` 命中/不命中/排除 done+pending+subagent；`upsertSessionEvent` 重复调用恰一行（锁不变量 D）；flush mark/consume 幂等+一次性；digest upsert 覆盖；迁移幂等（老库 openDb 两次不炸）。

### 6.3 capture 路由

- 首 Stop → waiting job 建成、未放行、无 LLM 调用；次 Stop → 同 job 复用（总数 1）+ event 恰一行；阈值跨越 → 放行；SessionEnd → flush 落表；subagent/无 sessionId 旧行为回归；threshold 抛错 → 立即放行 + 落表。

### 6.4 tick sweep

- flush+足量 → 放行；flush+不足量 → skipped_trivial + done + 无 LLM 调用；TTL 两分支；未过期不动；running/done 不被触碰（锁不变量 B）；sweep 抛错 → 落表 + tick 存活。

### 6.5 distiller 集成

- priorContext/approvedTitles 进 prompt（**源码层文本断言**两节标题存在——CLAUDE.md 运行时兜底面）；经济/质量两路径；读失败降级 + 落表；滚动摘要失败留旧 + 落表。
- **向后兼容锁**：priorContext 与 approvedTitles 均空时，prompt 与现状逐字节一致。

### 6.6 e2e 门禁（核心回归）

一个 session 三次 Stop：前两次不足阈值 → 零 LLM 调用零候选；第三次跨阈值 → 一次调用 + done + offset 结算正确；SessionEnd flush 尾巴 → 第四次调用。锁"攒量不丢原料"。

### 6.7 降级可见化

- **源码断言：每个降级点都有 logDegradation 调用**（grep 级守卫）。
- `/api/status` recentDegradations 形状；UI 横幅/徽标/确认动作文本断言；`skipped_trivial` outcome 徽标 + 未知 outcome 兜底。

### 6.8 运行门槛

`bun run typecheck && bun test` 全绿才 push。

## 7. 上线后观测（用户明确要求记录 STATE.md）

- 观察蒸馏记录：waiting→放行的分布、`skipped_trivial` 占比、阈值是否过松/过紧；
- 观察 degradations 24h 计数：哪个 kind 高频（调整实现或常量）；
- 观察滚动摘要质量：质量模式候选与既有记忆的重复率是否下降；
- 结论与阈值调整全部记录 STATE.md。

## 8. 后续探索项（明确不做，仅记账）

- Ark prompt caching 实测：若支持且 TTL 合适，质量模式可加"全量回放"档（hermes 质量路径的复刻）。
- distiller 提议更新已有记忆（supersede 通路）——届时 approvedTitles 升级为标题+body。
- 阈值进设置 tab（待观测数据支撑默认值后）。
