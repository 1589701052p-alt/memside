# 状态栏 LLM 实况 + 消息中心 设计 spec

日期：2026-08-12
分支：`feat/llm-status-and-message-center`（基线 origin/master cd2b118）

## 1. 背景

顶部状态栏当前渲染：

```
已捕获事件 2877 · distill: 1 进行中 · 完成 19 · 记忆: 598 待审 / 7 已批准
最近错误: ...（红字，最近 20 job 里第一个 lastError）
近 24h 1 次降级: 摘要压缩超限  [知道了]（琥珀横幅，全局单一 ack 时间戳）
```

用户反馈两个问题：

1. **状态栏噪音大**：真正有用的只有「distill: 1 进行中」；且它只是 job 级
   状态——daemon 里的 LLM 工作实际分为**蒸馏 / 去重 / 审查**三类（串行管线，
   另有滚动摘要压缩属蒸馏管线、回扫是独立并行路径），状态栏看不到当前到底
   在跑哪类工作、跑了多久、24h 内各类工作量多少。
2. **消息通知不人性化**：降级消息只有「24h 计数 + 最新一条」的横幅 + 全局
   「知道了」；LLM 报错只有单条「最近错误」红字。没有逐条已读、没有历史
   查询——用户原话：「消息通知需要更加人性化，例如支持用户已读消息，并
   支持查找历史消息」。

数据基础已存在：降级逐条落在 `memory_degradations`（8 个 kind，含 detail /
ts / distillJobId）；LLM 错误落在 `memory_distill_runs.error_message`
（outcome=llm_error）与 `memory_distill_jobs.last_error`。缺的是面向用户的
统一「消息」视图与 LLM 工作实况。

## 2. 目标

1. 状态栏改为 **LLM 实况**：三阶段（蒸馏 / 去重 / 审查）实时状态
   （哪个在跑 + 已耗时）+ 近 24h 各类次数与累计耗时 + 消息入口徽标。
2. 新增第 7 个 tab「消息」：降级 + LLM 报错两类消息的收件箱，支持
   **逐条已读**（点开详情自动已读）+ **全部已读** + **历史查找**
   （关键词搜索 + 类型筛选 + 仅未读）。
3. 消息保留上限 500 条（写入时删最旧）。

## 3. 非目标

- 浏览器桌面通知 / 声音提醒。
- 消息手动删除（自动 500 上限即清理策略）。
- 相同 LLM 错误的聚合合并（每 llm_error job 一条消息；若日后刷屏再议）。
- 回扫（rescan）活动进 LLM 实况（它已有独立进度块 `status.rescan`）。
- WebSocket 推送（沿用 3s 轮询）。
- 存量 `memory_degradations` 历史行补写消息（只从上线后的新降级开始双写）。
- 注入链路 / distiller prompt / 判定规则 / 状态机：零改动。

## 4. 用户确认的决策

| # | 决策 | 选择 |
|---|------|------|
| D1 | 消息范围 | 只收降级 + LLM 报错两类 |
| D2 | 状态栏口径 | 实时三阶段状态 + 近 24h 各类次数/耗时 + 消息入口 |
| D3 | 消息位置 | 第 7 个 tab「消息」，🔔 徽标点击切到该 tab |
| D4 | 已读语义 | 点开详情自动已读 + 「全部已读」按钮 |
| D5 | 保留策略 | 最多 500 条，写入时超限删最旧 |
| D6 | 数据模型 | 方案 A：新建统一 `notifications` 表；`memory_degradations` 审计表原样保留（双写） |
| D7 | 实时活动实现 | 包装 callLLM + 阶段标签（ActivityTracker），蒸馏器/去重/审查模块零改动 |

## 5. 架构与模块改动点

### 5.1 新表 `notifications`（schema.ts + client.ts 幂等迁移）

```ts
export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),        // ulid
    ts: integer('ts').notNull(),        // 写入时刻
    kind: text('kind').notNull(),       // 'degradation' | 'llm_error'
    title: text('title').notNull(),     // degradation: kind 原值；llm_error: 'llm_error'
    body: text('body'),                 // detail / errorMessage，写入截断 2000 字
    refType: text('ref_type'),          // 'distill_job' | null（预留深链）
    refId: text('ref_id'),              // 关联 jobId，可 null
    readAt: integer('read_at'),         // null = 未读
  },
  (t) => ({
    tsIdx: index('idx_notifications_ts').on(t.ts),
    readIdx: index('idx_notifications_read').on(t.readAt),
  }),
)
```

迁移走 client.ts 既有幂等 `CREATE TABLE IF NOT EXISTS` + 索引模式。
`title` 存机器值（kind 原值），人话映射在 UI 层（复用
`degradationKindLabel`），与「筛选值传英文原值」的既有约定一致。

### 5.2 消息写入路径（双写 + LLM 错误）

1. **降级**：`logDegradation` 成功写入 `memory_degradations` 后，调用新
   store 函数 `insertNotification` 写一条 `kind='degradation'` 消息
   （title=kind，body=detail 截断，refType='distill_job'，
   refId=distillJobId ?? null）。`logDegradation` 既有契约「自身失败只
   console.warn 不炸管线」不变，消息写入同契约。
2. **LLM 错误**：scheduler tick 既有 `if (outcome === 'llm_error' &&
   errorMessage)` 块（现写 job.lastError 处）追加 best-effort
   `logLlmErrorNotification(db, { jobId: job.id, message: errorMessage })`
   → `kind='llm_error'`，title='llm_error'，body=message 截断，
   refType='distill_job'，refId=jobId。
3. **保留上限**：`insertNotification` 内部插入后执行裁剪——
   `DELETE FROM notifications WHERE id NOT IN (SELECT id FROM notifications
   ORDER BY ts DESC, id DESC LIMIT 500)`。常量
   `NOTIFICATION_RETENTION_CAP = 500`。裁剪失败只 warn，不影响插入结果。
4. body 截断常量 `NOTIFICATION_BODY_CAP_CHARS = 2000`。

### 5.3 消息查询 / 已读 store 函数

- `listNotificationsPaged(db, opts)` → `PageWithTotal<NotificationRow>`：
  完全复用 memories/discards 分页既有模式（`clampPageLimit`；游标
  `{ts, id}`，条件 `ts < c.ts OR (ts = c.ts AND id < c.id)`；ORDER BY
  ts DESC, id DESC；total = 同条件全表 COUNT）。
  筛选：`kind?`（两枚举，非法抛 `InvalidNotificationFilterError` →
  server 400）；`unreadOnly?`（readAt IS NULL）；`q?`（title/body
  LIKE %q%，参数化；500 行规模全扫无压力）。
- `markNotificationRead(db, id)`：UPDATE readAt=now WHERE id AND
  readAt IS NULL（幂等）；无此行抛 `NotificationNotFoundError` → server 404。
- `markAllNotificationsRead(db)`：UPDATE readAt=now WHERE readAt IS NULL，
  返回受影响行数。
- `updateDistillRunDigestMs(db, jobId, ms)`：UPDATE memory_distill_runs
  SET digest_ms WHERE job_id；无行 no-op（run 行缺失时 digest 耗时丢弃，
  best-effort 语义与 saveDistillRun 一致）。

### 5.4 `memory_distill_runs` 加三个耗时列

`digest_ms` / `dedup_ms` / `judge_ms`，均 INTEGER nullable（老行 NULL =
未计量）。client.ts 幂等 ALTER（同 error_message 列先例）。语义：

- `duration_ms`（既有）= 蒸馏阶段耗时，含义不变。
- `dedup_ms` / `judge_ms` = 该阶段**实际发生 LLM 调用**时的墙钟耗时；
  未调用（0 候选短路等）写 NULL。
- `digest_ms` = 滚动账本压缩耗时（质量模式 + 会话 job 才有）。
  因账本更新发生在 `saveDistillRun` 之后（scheduler.ts:448），用
  `updateDistillRunDigestMs` 二次 UPDATE 回填，不动 saveDistillRun 调用时序。

### 5.5 ActivityTracker（新文件 `src/activity.ts`）

```ts
export type LlmPhase = 'distill' | 'dedup' | 'judge' | 'digest'
export interface LlmActivity { phase: LlmPhase; detail: string | null; since: number }
export interface PhaseHandle { end(): { calls: number; ms: number } }
export interface ActivityTracker {
  begin(phase: LlmPhase, detail?: string | null): PhaseHandle
  wrapCall(call: LLMCall): LLMCall
  get(): LlmActivity | null
}
export function createActivityTracker(now?: () => number): ActivityTracker
```

- 单槽：`begin` 置 current = {phase, detail, since, calls:0}；后来的 begin
  覆盖前一个（蒸馏管线串行，单槽自洽；覆盖语义有测试锁定）。
- `wrapCall` 返回的函数每次被调递增 current 的 calls（无 current 时仅透传），
  然后委托原 callLLM——LLM 模块零感知。
- `end()` 清 current（仅当 current 仍是本 handle 的实例），返回
  {calls, ms}。调用方负责 try/finally。
- `now` 注入仅为测试；生产用 Date.now。

### 5.6 scheduler 接线

`TickDeps` 加可选 `tracker?: ActivityTracker`（runDistillOnce / 测试不传
不受影响）。tick 内五个 LLM 站点：

| 站点 | 阶段标签 | 耗时去向 |
|------|---------|---------|
| distillTranscript | `distill` | 既有 durationMs 不变（tracker 只供实况） |
| dedupCandidates | `dedup` | handle.end()：calls>0 → dedup_ms，否则 NULL |
| judgeValue / judgeValueAgentic | `judge` | 同上 → judge_ms |
| updateSessionLedger | `digest` | 同上 → digest_ms（经 updateDistillRunDigestMs 回填） |
| rescan（server.ts） | 不接 | 独立进度块已覆盖 |

detail = job.cwd 的 basename（无 cwd 为 null）。每个站点
`begin` 与 `end` 之间 try/finally，throw 路径也必清。
`saveDistillRun` 记录类型扩 dedupMs/judgeMs 两个可选字段（digestMs 走
5.3 的回填函数）。

### 5.7 daemon 接线

`startDaemon` 创建唯一 `tracker` 实例，两处注入：

1. `tickDeps.tracker = tracker`（scheduler 侧置位）。
2. `createApp({ ..., tracker })`（server 侧 `/api/status` 读取）。

`runDistillOnce` 不传 tracker（测试语义不变）。

### 5.8 server 端点

**新增**

- `GET /api/notifications?limit&cursor_ts&cursor_id&kind&unread=1&q`
  → `{items, hasMore, nextCursor, total}`（PageWithTotal 序列化，同
  memories/discards 模式）。kind 非法 → 400；unread 仅认 `=1`；
  q 空串忽略。
- `POST /api/notifications/:id/read` → `{ok:true}`；
  NotificationNotFoundError → 404。
- `POST /api/notifications/read-all` → `{ok:true, marked:n}`。

**修改 `/api/status`**

- 加 `llmActivity: {phase, detail, since} | null`（tracker.get()）。
- 加 `llmStats24h: {distill: {count, ms}, dedup: {count, ms}, judge: {count, ms}}`：
  单条 SQL 聚合 `memory_distill_runs WHERE ts > cutoff`（cutoff=24h）：
  - distill.count = `SUM(CASE WHEN duration_ms > 0 THEN 1 ELSE 0 END)`
    （skipped 类 run duration=0 不计）；
  - distill.ms = `COALESCE(SUM(duration_ms),0) + COALESCE(SUM(digest_ms),0)`
    （摘要压缩并入蒸馏口径，UI 三列与用户心智一致）；
  - dedup/judge：count = 对应列非 NULL 行数，ms = COALESCE(SUM(col),0)。
  此处直接 SQL 聚合（顺手避免既有 distillRuns 全量物化 JS 过滤的
  follow-up 老路）。
- 加 `unreadNotifications: COUNT(*) WHERE read_at IS NULL`。
- **删** `recentDegradations` 字段（唯一消费方是即将移除的横幅）。
- **保留** `lastError` 字段（廉价、诊断可用，仅 UI 不再渲染）。

**删除**

- `POST /api/degradations/ack` 路由整体移除（全局 ack 语义被逐条已读取代）。
  store 的 `listRecentDegradations` 函数保留不删（store 层查询能力无害，
  删除非本次必须）。

### 5.9 web/api.ts

- `MemsideStatus` 加 `llmActivity?` / `llmStats24h?` / `unreadNotifications?`
  （均 optional，老 daemon 兼容）；删 `recentDegradations?`；保留
  `lastError?`。
- 新 wrapper：`listNotifications(params)`（序列化 query，返回
  `PageWithTotal<Notification>`）、`markNotificationRead(id)`、
  `markAllNotificationsRead()`。no-throw 契约与既有 mutating wrapper 一致
  （不检查 res.ok，UI 层 refresh 自愈——与 promote/restore 同模式；
  read 404 场景 UI 无感知必要）。
- 删 `ackDegradations`。
- `Notification` 类型：{id, ts, kind, title, body, refType, refId, readAt}。

### 5.10 App.tsx

**状态栏重写**（整块替换 370-420 区域）：

```
┌─────────────────────────────────────────────────────┐
│ 蒸馏 进行中·12s │ 去重 空闲 │ 审查 空闲        🔔 3 未读 │
│ 近24h 蒸馏 19次·8分 │ 去重 15次·2分 │ 审查 15次·12分    │
└─────────────────────────────────────────────────────┘
```

- 行 1：三个 phase cell（phaseLabel：distill/digest→蒸馏，dedup→去重，
  judge→审查）。`llmActivity` 非空且 phase 命中 → 「进行中·formatElapsed
  (now-since)」高亮；否则「空闲」灰字。🔔 按钮：unread>0 显
  「🔔 N 未读」，0 显灰「🔔 已读完」；onClick → setTab('messages')。
- 行 2：「近24h」+ 三段 formatPhaseStat(count, ms)。
- status 缺新字段（老 daemon）：行 1 只剩 🔔，行 2 不渲染（optional 守卫）。
- 移除：已捕获事件 / 完成 / 失败 / 记忆计数 / 最近错误行 / 降级横幅与
  「知道了」按钮。
- 「连不上 daemon」「读取状态中…」两态不动；全局错误横幅不动。

**消息 tab**：

- `tabs` 数组加 `{key:'messages', label:'消息', count: status?.unreadNotifications ?? null}`。
- `isListTab('messages')` 自动为真（tab-cache 判据是 `!== 'settings'`，
  无需改 tab-cache；但补一条测试锁定）。
- 数据流复用既有列表模式：独立缓存（与 runs tab 同款）、limit 20、
  observer 无限滚动、3s 轮询第 1 页（mergeRefreshPage）、切 tab 清
  interval。筛选状态：kind 下拉（全部/降级/LLM错误）、仅未读勾选、
  关键词输入（300ms debounce 触发重置翻页）；筛选变更作废缓存重置到
  页 1（同记忆 tab 的 filterReference 模式）。
- NotificationCard：未读 ●、类型 chip（降级=琥珀 / LLM错误=红）、
  标题人话（notificationTitle）、body 截断行、时间；点击展开全文并
  触发 `markNotificationRead`（乐观本地标已读 + void refresh；失败靠
  轮询自愈，不静默吞按钮——按钮点击始终有本地反馈）。
- 工具行含「全部已读」按钮（void markAllNotificationsRead + refresh）。
- 列表头：筛选激活时显示服务端 total（`共 N 条消息`，同记忆 tab 的
  PageWithTotal 诚实计数模式）；无筛选不显示总数（tab 徽标已有未读数）。
- 空态：无消息「暂无消息」；筛选无结果「没有匹配的消息」。

### 5.11 ui-utils 纯函数

- `phaseLabel(phase: string): string` — distill/digest→「蒸馏」，
  dedup→「去重」，judge→「审查」；未知原样兜底。
- `formatElapsed(ms): string` — <60s 「Ns」；>=60s 「N分」（向下取整，
  >=60 分显「N小时M分」）。
- `formatPhaseStat(count, ms): string` — 「19次·8分」；count=0 →
  「0次」；ms 格式同 formatElapsed。
- `notificationTitle(n: {kind, title}): string` — degradation →
  `degradationKindLabel(title)`；llm_error → 「蒸馏 LLM 报错」；未知
  kind 原样兜底。

### 5.12 CLAUDE.md 同步

「Web UI 改动」一节的状态栏参照描述（「已捕获事件 / distill 进行中 /
记忆计数 / 最近错误」）更新为新形态（LLM 三阶段实况 + 消息入口），
避免后续 session 按过期描述回归旧状态栏。

## 6. 数据流

```
capture ─(既有)─▶ events/jobs
                    │
tick loop ─▶ [tracker.begin('distill')] distillTranscript ─▶ end()
         ─▶ [begin('dedup')] dedupCandidates ─▶ end() → dedup_ms
         ─▶ [begin('judge')] judgeValue/Agentic ─▶ end() → judge_ms
         ─▶ saveDistillRun(+dedup_ms/judge_ms)
         ─▶ outcome=llm_error ─▶ job.lastError + logLlmErrorNotification ─▶ notifications 行
         ─▶ [begin('digest')] updateSessionLedger ─▶ end() → updateDistillRunDigestMs
logDegradation(任一降级点) ─▶ memory_degradations 行 + notifications 行（双写）

GET /api/status ─▶ tracker.get() + runs 24h 聚合 + unread COUNT
GET /api/notifications ─▶ listNotificationsPaged
POST /api/notifications/:id/read ─▶ readAt=now
Web UI：状态栏（实况+统计+🔔） / 消息 tab（列表+筛选+已读）
```

## 7. 失败模式

| 场景 | 行为 |
|------|------|
| 阶段中 throw | scheduler try/finally 保证 end()，tracker 复位；job 走既有重试/失败路径 |
| daemon 崩溃重启 | tracker 内存态归零（状态栏自然回「空闲」）；notifications 已落库不丢 |
| insertNotification 失败 | 只 console.warn，不炸降级审计与蒸馏（与 logDegradation 同契约） |
| 500 裁剪 SQL 失败 | warn，不影响本条插入（下条再裁） |
| saveDistillRun 缺失时的 digest 回填 | updateDistillRunDigestMs no-op，best-effort |
| 老 daemon + 新 UI | 新 status 字段全 optional，UI 守卫后降级渲染（不白屏不抛） |
| rescan 与蒸馏管线并行 | rescan 不接 tracker，不会与管线阶段互相覆盖 |
| q 含 % / _ | LIKE 通配（500 行规模无害，不作缺陷处理；参数化已防注入） |
| 同一 LLM 错误反复发生 | 每 job 一条消息，诚实呈现；聚合留后续 |

## 8. 测试策略（必写 case）

**纯函数层**

1. ActivityTracker：begin/get/end 生命周期；end 后 get 归 null；wrapCall
   计 calls（含多次调用）；throw 后 finally end 仍复位；后 begin 覆盖前
   handle（前 handle.end 不再清新 current）；注入 now 断言 ms。
2. ui-utils：phaseLabel（digest→蒸馏、未知兜底）；formatElapsed 边界
   （59s/60s/3599s/3600s）；formatPhaseStat（0 次省略耗时、秒/分/时）；
   notificationTitle（已知 kind / 未知 kind / llm_error）。

**store 层（真 sqlite）**

3. insertNotification：字段落库；body 超 2000 截断；第 501 条写入后最旧
   被裁、新条在、计数恒 500。
4. logDegradation 双写：degradation 行 + notification 行同时出现
   （refId=distillJobId）；无 jobId 时 refId=null。
5. listNotificationsPaged：ts desc 排序；kind 筛选；unreadOnly 筛选；
   q 命中 title 与 body 各一例；游标翻页 + total；kind 非法抛错。
6. markNotificationRead：置 readAt；重复调幂等；未知 id 抛
   NotificationNotFoundError。markAllNotificationsRead 只改未读行、
   返回行数。
7. updateDistillRunDigestMs：有行更新；无行 no-op 不抛。

**scheduler 层（fake callLLM + tracker）**

8. 一趟 full job：tracker 阶段序列 distill→dedup→judge（质量模式再
   +digest）；结束后 get() 归 null；run 行 dedup_ms/judge_ms 非空。
9. 0 候选短路：judge 未调 LLM → judge_ms NULL（calls=0 判据）。
10. llm_error 路径：notifications 出一条 kind=llm_error、refId=job.id；
    job.lastError 行为不变。
11. throw 路径：callLLM 抛错 → tracker get() 仍归 null（finally 守卫）。
12. digest 回填：质量+会话 job → run.digest_ms 经二次 UPDATE 有值。

**server 层**

13. GET /api/notifications：limit clamp、cursor 续页、kind/unread/q
    组合、total；kind 非法 → 400。
14. POST read / read-all；未知 id → 404。
15. /api/status：unreadNotifications 计数；llmStats24h 聚合——24h 窗口
    内外行、skipped run 不计 distill.count、NULL 列不计 dedup/judge、
    digest_ms 并入 distill.ms；llmActivity 透传注入的 tracker。
16. ack 回归锁：POST /api/degradations/ack → 404；status 响应无
    recentDegradations 键。

**web 层**

17. api wrapper：listNotifications query 序列化（含 cursor/unread/q）；
    markNotificationRead / markAllNotificationsRead 路径与方法。
18. App.tsx 源码层文本断言（CLAUDE.md 兜底面）：
    - 正向：llmActivity / llmStats24h / unreadNotifications / phaseLabel /
      formatElapsed / formatPhaseStat / notificationTitle / '消息' tab 接线。
    - 反向：状态栏 JSX 中不得再出现「已捕获事件」「最近错误」「近 24h」
      降级横幅文案与「知道了」按钮字样。
19. isListTab('messages') === true。

**回归门禁**：`bun run typecheck && bun test` 全绿（既有 918+ 条不动）。

## 9. 兼容与迁移

- schema：1 张新表 + runs 表 3 个 nullable 列，全幂等；老库打开即用，
  老行 NULL 由 UI「未知/不计」语义吸收。
- API：status 仅增字段 + 删 recentDegradations（唯一消费方同批移除）；
  删 ack 路由（无外部消费者）。
- 既有蒸馏记录 modal 的按 job 降级明细（`/api/distill-runs/:jobId/degradations`）
  不动——它读 `memory_degradations` 审计表，与消息表互不依赖。
- 性能：status 新增 3 条轻量 SQL（unread COUNT / runs 24h 聚合 /
  tracker 读内存）；3s 轮询负担可忽略。

## 10. 与现有模块的耦合点

| 模块 | 改动 |
|------|------|
| src/db/schema.ts | notifications 表；runs 三列 |
| src/db/client.ts | 幂等迁移（建表 + ALTER） |
| src/memory/store.ts | insertNotification / logLlmErrorNotification / listNotificationsPaged / markRead / markAllRead / updateDistillRunDigestMs / logDegradation 双写 / saveDistillRun 扩字段 |
| src/activity.ts（新） | ActivityTracker |
| src/scheduler.ts | TickDeps.tracker + 五站点接线 + llm_error 消息 + 耗时采集 |
| src/daemon.ts | tracker 创建与双侧注入 |
| src/server.ts | notifications 三端点 + status 扩展 + ack 删除 |
| src/web/api.ts | 类型 + wrapper |
| src/web/App.tsx | 状态栏重写 + 消息 tab |
| src/web/ui-utils.ts | phaseLabel / formatElapsed / formatPhaseStat / notificationTitle |
| src/web/tab-cache.ts | 不改（补测试锁定 isListTab('messages')） |
| CLAUDE.md | 状态栏参照描述同步 |
