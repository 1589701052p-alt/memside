# 状态栏 LLM 实况 + 消息中心 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 状态栏改为蒸馏/去重/审查三阶段 LLM 实时状态 + 近 24h 统计 + 消息入口；新增第 7 个「消息」tab（降级 + LLM 报错，逐条已读 + 历史搜索，500 条保留）。

**Architecture:** 新建 `notifications` 统一消息表（`memory_degradations` 审计表原样保留、双写）；新模块 `src/activity.ts` 提供内存 ActivityTracker，scheduler 在 distill/dedup/judge/digest 四个 LLM 站点用包装 callLLM 置位/清除，daemon 持单例并经 `/api/status` 暴露；`memory_distill_runs` 加三个耗时列支撑 24h 统计。Web 侧状态栏整块重写 + 消息 tab 复用既有分页/轮询/缓存模式。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite（WAL）+ zod-free 手写校验 + React 19（inline style，无新依赖）。

## Global Constraints

- 测试一律 `bun test`（严禁 npm test）；每任务收尾跑 `bun run typecheck && bun test` 全绿才能 commit。
- 分支 `feat/llm-status-and-message-center` 已建好（基线 origin/master cd2b118）；禁止在 master 上 commit。
- 注入链路 / distiller prompt / 判定规则 / 状态机 / 蒸馏记录按 job 降级明细端点（`GET /api/distill-runs/:jobId/degradations`）：**零改动**。
- 存储/审计异常降级契约不变：消息写入失败只 console.warn，不得炸蒸馏管线。
- UI no-throw 契约：mutating wrapper 不检查 res.ok，失败靠轮询/refresh 自愈。
- 中文文案沿用现有风格；机器值（kind 等）存英文原值，人话映射在 `src/web/ui-utils.ts`。
- 不引入新依赖、不引入新样式框架、不动 vite proxy。
- spec 位置：`docs/superpowers/specs/2026-08-12-llm-status-and-message-center-design.md`（下文「spec §x」均指它）。

---

### Task 1: ActivityTracker 纯模块

**Files:**
- Create: `src/activity.ts`
- Test: `tests/activity.test.ts`

**Interfaces:**
- Consumes: `LLMCall` 类型（`src/llm.ts`，签名 `(system: string, user: string, opts?: LLMCallOpts) => Promise<string>`）
- Produces: `LlmPhase = 'distill' | 'dedup' | 'judge' | 'digest'`；`LlmActivity { phase: LlmPhase; detail: string | null; since: number }`；`PhaseHandle { end(): { calls: number; ms: number } }`；`ActivityTracker { begin(phase, detail?): PhaseHandle; wrapCall(call: LLMCall): LLMCall; get(): LlmActivity | null }`；`createActivityTracker(now?: () => number): ActivityTracker`。Task 4/5/6 依赖这些名字。

- [ ] **Step 1: 写失败测试**

`tests/activity.test.ts`：

```ts
import { test, expect } from 'bun:test'
import { createActivityTracker } from '@/activity'

test('begin -> get 返回阶段实况；end 后归 null', () => {
  let t = 1000
  const tr = createActivityTracker(() => t)
  expect(tr.get()).toBeNull()
  const h = tr.begin('distill', 'memside')
  expect(tr.get()).toEqual({ phase: 'distill', detail: 'memside', since: 1000 })
  t = 13000
  expect(h.end()).toEqual({ calls: 0, ms: 12000 })
  expect(tr.get()).toBeNull()
})

test('wrapCall 递增当前阶段 calls；无当前阶段仅透传', async () => {
  let t = 0
  const tr = createActivityTracker(() => t)
  let delegated = 0
  const wrapped = tr.wrapCall(async () => { delegated++; return 'ok' })
  await wrapped('s', 'u')            // 无 phase：透传不计数
  expect(delegated).toBe(1)
  const h = tr.begin('dedup')
  await wrapped('s', 'u')
  await wrapped('s', 'u')
  expect(h.end().calls).toBe(2)
  expect(delegated).toBe(3)
})

test('后 begin 覆盖前 handle：前 handle.end 不清新 current、返回零值', () => {
  let t = 0
  const tr = createActivityTracker(() => t)
  const h1 = tr.begin('distill', 'a')
  t = 5000
  const h2 = tr.begin('judge', 'b')
  expect(h1.end()).toEqual({ calls: 0, ms: 0 })
  expect(tr.get()?.phase).toBe('judge')   // h1 没有把 judge 清掉
  expect(h2.end().ms).toBeGreaterThan(0)
  expect(tr.get()).toBeNull()
})

test('detail 缺省为 null', () => {
  const tr = createActivityTracker(() => 0)
  tr.begin('digest')
  expect(tr.get()).toEqual({ phase: 'digest', detail: null, since: 0 })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/activity.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`src/activity.ts`：

```ts
import type { LLMCall } from '@/llm'

/** LLM 工作阶段（spec 2026-08-12 §5.5）。digest = 滚动账本压缩，UI 归入「蒸馏」列。 */
export type LlmPhase = 'distill' | 'dedup' | 'judge' | 'digest'

export interface LlmActivity { phase: LlmPhase; detail: string | null; since: number }
export interface PhaseHandle { end(): { calls: number; ms: number } }

export interface ActivityTracker {
  begin(phase: LlmPhase, detail?: string | null): PhaseHandle
  /** 包装 callLLM：每次调用递增当前阶段 calls；无当前阶段仅透传。LLM 模块零感知。 */
  wrapCall(call: LLMCall): LLMCall
  get(): LlmActivity | null
}

/**
 * 单槽内存活动跟踪器（spec §5.5）：蒸馏管线串行，任一时刻最多一个阶段在跑，
 * begin 覆盖语义；end 仅当 current 仍属本 handle 才清除（防覆盖后误清）。
 * now 注入仅为测试；生产用 Date.now。不落库——daemon 重启自然归零。
 */
export function createActivityTracker(now: () => number = Date.now): ActivityTracker {
  let current: { activity: LlmActivity; calls: number; handle: symbol } | null = null
  return {
    begin(phase, detail = null) {
      const handle = Symbol(phase)
      const since = now()
      current = { activity: { phase, detail, since }, calls: 0, handle }
      return {
        end() {
          if (current && current.handle === handle) {
            const result = { calls: current.calls, ms: now() - current.activity.since }
            current = null
            return result
          }
          return { calls: 0, ms: 0 }
        },
      }
    },
    wrapCall(call) {
      return async (system, user, opts) => {
        if (current) current.calls += 1
        return await call(system, user, opts)
      }
    },
    get() {
      return current ? current.activity : null
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/activity.test.ts`
Expected: PASS（4 条）

- [ ] **Step 5: 全量门禁 + commit**

Run: `bun run typecheck && bun test`
Expected: 全绿

```bash
git add src/activity.ts tests/activity.test.ts
git commit -m "feat(activity): LLM 阶段活动跟踪器（单槽 begin/end + wrapCall 计数）"
```

---

### Task 2: schema + 迁移（notifications 表 + runs 三耗时列）

**Files:**
- Modify: `src/db/schema.ts`（memoryDistillRuns 定义后 + memoryDegradations 定义后）
- Modify: `src/db/client.ts`（import、drizzle schema 对象、bootstrap DDL、ALTER 迁移块）
- Test: `tests/schema.test.ts`（追加）

**Interfaces:**
- Produces: drizzle 表 `notifications`（列：`id`/`ts`/`kind`/`title`/`body`/`refType`/`refId`/`readAt`）；`memoryDistillRuns` 新增可空列 `digestMs`/`dedupMs`/`judgeMs`。Task 3/4 依赖。

- [ ] **Step 1: 写失败测试**

追加到 `tests/schema.test.ts` 末尾（沿用该文件既有的 openDb/PRAGMA 风格；若该文件用别的断言风格，跟随文件内相邻测试的写法）：

```ts
test('notifications 表列齐全（spec 2026-08-12 §5.1）', () => {
  const cols = db.$client.prepare('PRAGMA table_info(notifications)').all() as { name: string }[]
  const names = cols.map((c) => c.name)
  for (const n of ['id', 'ts', 'kind', 'title', 'body', 'ref_type', 'ref_id', 'read_at']) {
    expect(names).toContain(n)
  }
})

test('memory_distill_runs 含 digest_ms/dedup_ms/judge_ms（spec §5.4）', () => {
  const cols = db.$client.prepare('PRAGMA table_info(memory_distill_runs)').all() as { name: string }[]
  const names = cols.map((c) => c.name)
  for (const n of ['digest_ms', 'dedup_ms', 'judge_ms']) expect(names).toContain(n)
})

test('notifications 索引存在', () => {
  const idx = db.$client.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='notifications'").all() as { name: string }[]
  const names = idx.map((i) => i.name)
  expect(names).toContain('idx_notifications_ts')
  expect(names).toContain('idx_notifications_read')
})
```

（`db` 变量名以 schema.test.ts 文件内实际使用的为准；若该文件每个 test 自建 db，照抄相邻 test 的脚手架。）

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/schema.test.ts`
Expected: FAIL（no such table: notifications / 缺列）

- [ ] **Step 3: schema.ts 加表与列**

`src/db/schema.ts` 的 `memoryDistillRuns` 定义中，`errorMessage` 行后追加：

```ts
    digestMs: integer('digest_ms'),   // 摘要（滚动账本）压缩耗时；未计量 NULL（spec 2026-08-12 §5.4）
    dedupMs: integer('dedup_ms'),     // 去重阶段耗时；未调 LLM NULL
    judgeMs: integer('judge_ms'),     // 审查阶段耗时；未调 LLM NULL
```

`memoryDegradations` 定义之后追加：

```ts
export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    ts: integer('ts').notNull(),
    kind: text('kind').notNull(),   // 'degradation' | 'llm_error'（spec 2026-08-12 §5.1）
    title: text('title').notNull(), // degradation: kind 原值；llm_error: 'llm_error'；人话映射在 UI 层
    body: text('body'),
    refType: text('ref_type'),      // 'distill_job' | null
    refId: text('ref_id'),
    readAt: integer('read_at'),     // null = 未读
  },
  (t) => ({
    tsIdx: index('idx_notifications_ts').on(t.ts),
    readIdx: index('idx_notifications_read').on(t.readAt),
  }),
)
```

- [ ] **Step 4: client.ts 接线**

4a. import 行（client.ts:5）加入 `notifications`；drizzle schema 对象（client.ts:14）同步加 `notifications`。

4b. bootstrap DDL 大块（`raw.exec` 模板串，memory_degradations 建表之后）追加：

```sql
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      ref_type TEXT,
      ref_id TEXT,
      read_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_ts ON notifications(ts);
    CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read_at);
```

并把 memory_distill_runs 建表 DDL 的 `error_message TEXT,` 之后加三行（新库直接带列）：

```sql
      digest_ms      INTEGER,
      dedup_ms       INTEGER,
      judge_ms       INTEGER,
```

4c. 文件末尾 `return db` 之前追加老库迁移块（与 error_message 迁移同模式）：

```ts
  // Idempotent migration: add digest_ms/dedup_ms/judge_ms to memory_distill_runs.
  // LLM 三阶段 24h 统计（spec 2026-08-12 §5.4）。无 backfill（老行 NULL = 未计量）。
  {
    const cols = raw.prepare('PRAGMA table_info(memory_distill_runs)').all() as { name: string }[]
    const have = (n: string) => cols.some((c) => c.name === n)
    if (!have('digest_ms')) raw.exec('ALTER TABLE memory_distill_runs ADD COLUMN digest_ms INTEGER')
    if (!have('dedup_ms')) raw.exec('ALTER TABLE memory_distill_runs ADD COLUMN dedup_ms INTEGER')
    if (!have('judge_ms')) raw.exec('ALTER TABLE memory_distill_runs ADD COLUMN judge_ms INTEGER')
  }
```

- [ ] **Step 5: 跑测试确认通过 + 全量门禁**

Run: `bun test tests/schema.test.ts && bun run typecheck && bun test`
Expected: 全绿

- [ ] **Step 6: commit**

```bash
git add src/db/schema.ts src/db/client.ts tests/schema.test.ts
git commit -m "feat(db): notifications 消息表 + distill_runs 三阶段耗时列（幂等迁移）"
```

---

### Task 3: store 消息层（写入/查询/已读/保留上限/双写）

**Files:**
- Modify: `src/memory/store.ts`
- Test: `tests/store-notifications.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2 的 `notifications` 表、既有 `PageCursor`/`PageWithTotal`/`clampPageLimit`、`memoryDistillRuns`。
- Produces（Task 4/5 依赖）：
  - `NOTIFICATION_RETENTION_CAP = 500`、`NOTIFICATION_BODY_CAP_CHARS = 2000`
  - `type NotificationKind = 'degradation' | 'llm_error'`；`NOTIFICATION_KINDS`
  - `interface NotificationRow { id: string; ts: number; kind: NotificationKind; title: string; body: string | null; refType: string | null; refId: string | null; readAt: number | null }`
  - `class NotificationNotFoundError extends Error`、`class InvalidNotificationFilterError extends Error`
  - `insertNotification(db, {kind, title, body?, refType?, refId?}): Promise<string>`
  - `logLlmErrorNotification(db, {jobId, message}): Promise<void>`（自身吞错只 warn）
  - `listNotificationsPage(db, {limit?, before?, kind?, unreadOnly?, q?}): Promise<PageWithTotal<NotificationRow>>`
  - `markNotificationRead(db, id): Promise<void>`（已读幂等；不存在抛 NotificationNotFoundError）
  - `markAllNotificationsRead(db): Promise<number>`
  - `updateDistillRunDigestMs(db, jobId, ms): Promise<void>`（无行 no-op）
  - `DistillRunRecord` 扩 `dedupMs?: number | null; judgeMs?: number | null`

- [ ] **Step 1: 写失败测试**

`tests/store-notifications.test.ts`（脚手架照抄 tests/store-page.test.ts 的 EBUSY-safe 模式：root 子目录 + beforeEach openDb + afterEach `db.$client.close()`）：

```ts
import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import {
  insertNotification, logLlmErrorNotification, listNotificationsPage,
  markNotificationRead, markAllNotificationsRead, updateDistillRunDigestMs,
  logDegradation, saveDistillRun, getDistillRun,
  NotificationNotFoundError, InvalidNotificationFilterError,
  NOTIFICATION_RETENTION_CAP,
} from '@/memory/store'

const root = join(import.meta.dir, '.tmp-store-notifications')
let dir = ''
let db: ReturnType<typeof openDb>

beforeAll(() => { rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true }) })
beforeEach(() => {
  dir = join(root, Math.random().toString(36).slice(2))
  mkdirSync(dir, { recursive: true })
  db = openDb(join(dir, 't.db'))
})
afterEach(() => { db.$client.close() })

test('insertNotification 落库全字段；body 超 2000 截断', async () => {
  const long = 'x'.repeat(2500)
  const id = await insertNotification(db, { kind: 'degradation', title: 'digest_truncated', body: long, refType: 'distill_job', refId: 'j1' })
  const pg = await listNotificationsPage(db, {})
  expect(pg.total).toBe(1)
  const n = pg.items[0]!
  expect(n.id).toBe(id)
  expect(n.kind).toBe('degradation')
  expect(n.title).toBe('digest_truncated')
  expect(n.body!.length).toBe(2000)
  expect(n.refType).toBe('distill_job')
  expect(n.refId).toBe('j1')
  expect(n.readAt).toBeNull()
})

test('保留上限：第 501 条写入后总数恒 500，最旧被删', async () => {
  for (let i = 0; i < NOTIFICATION_RETENTION_CAP + 1; i++) {
    await insertNotification(db, { kind: 'degradation', title: `t${i}` })
  }
  const pg = await listNotificationsPage(db, { limit: 1 })
  expect(pg.total).toBe(NOTIFICATION_RETENTION_CAP)
  expect(pg.items[0]!.title).toBe(`t${NOTIFICATION_RETENTION_CAP}`) // 最新在
  const all = await listNotificationsPage(db, { limit: 200 })
  expect(all.items.map((n) => n.title)).not.toContain('t0')         // 最旧被裁
})

test('logDegradation 双写：审计行 + 消息行同时出现', async () => {
  await logDegradation(db, { kind: 'digest_llm_failed', detail: 'boom', distillJobId: 'job-9', sessionId: 's1' })
  const pg = await listNotificationsPage(db, {})
  expect(pg.total).toBe(1)
  const n = pg.items[0]!
  expect(n.kind).toBe('degradation')
  expect(n.title).toBe('digest_llm_failed')
  expect(n.body).toBe('boom')
  expect(n.refId).toBe('job-9')
  // 无 jobId 的降级 refId=null
  await logDegradation(db, { kind: 'sweep_error', detail: 'x' })
  const pg2 = await listNotificationsPage(db, { kind: 'degradation' })
  const sweep = pg2.items.find((m) => m.title === 'sweep_error')!
  expect(sweep.refId).toBeNull()
})

test('logLlmErrorNotification 写 kind=llm_error', async () => {
  await logLlmErrorNotification(db, { jobId: 'jx', message: '502 Bad Gateway' })
  const pg = await listNotificationsPage(db, {})
  expect(pg.items[0]!).toMatchObject({ kind: 'llm_error', title: 'llm_error', body: '502 Bad Gateway', refId: 'jx' })
})

test('listNotificationsPage: 排序 / kind / unreadOnly / q / 游标翻页 + total', async () => {
  await insertNotification(db, { kind: 'degradation', title: 'digest_truncated', body: '切片压缩产出超限' })
  await insertNotification(db, { kind: 'llm_error', title: 'llm_error', body: 'timeout' })
  await insertNotification(db, { kind: 'degradation', title: 'sweep_error', body: null })
  await new Promise((r) => setTimeout(r, 5)) // 保证 ts 严格递增
  const all = await listNotificationsPage(db, {})
  expect(all.items.map((n) => n.title)).toEqual(['sweep_error', 'llm_error', 'digest_truncated']) // ts desc
  expect((await listNotificationsPage(db, { kind: 'llm_error' })).total).toBe(1)
  await markNotificationRead(db, all.items[0]!.id)
  expect((await listNotificationsPage(db, { unreadOnly: true })).total).toBe(2)
  expect((await listNotificationsPage(db, { q: '超时' })).total).toBe(1)     // body 命中
  expect((await listNotificationsPage(db, { q: 'sweep' })).total).toBe(1)    // title 命中
  const p1 = await listNotificationsPage(db, { limit: 2 })
  expect(p1.hasMore).toBe(true)
  const p2 = await listNotificationsPage(db, { limit: 2, before: p1.nextCursor! })
  expect(p2.items.length).toBe(1)
  expect(p2.hasMore).toBe(false)
})

test('listNotificationsPage: 非法 kind 抛 InvalidNotificationFilterError', async () => {
  await expect(listNotificationsPage(db, { kind: 'bogus' as any })).rejects.toBeInstanceOf(InvalidNotificationFilterError)
})

test('markNotificationRead 幂等；未知 id 抛 NotificationNotFoundError；markAll 只改未读', async () => {
  const id = await insertNotification(db, { kind: 'degradation', title: 'a' })
  await markNotificationRead(db, id)
  await markNotificationRead(db, id) // 幂等不抛
  await expect(markNotificationRead(db, 'nope')).rejects.toBeInstanceOf(NotificationNotFoundError)
  await insertNotification(db, { kind: 'degradation', title: 'b' })
  await insertNotification(db, { kind: 'llm_error', title: 'c' })
  expect(await markAllNotificationsRead(db)).toBe(2)
  expect((await listNotificationsPage(db, { unreadOnly: true })).total).toBe(0)
})

test('updateDistillRunDigestMs 回填；无行 no-op', async () => {
  await saveDistillRun(db, 'job-1', {
    outcome: 'produced', rawOutput: null, rawCount: 1, acceptedCount: 1,
    dedupedCount: 1, filteredCount: 1, storedCount: 1, discardedCount: 0,
    durationMs: 100, errorMessage: null, dedupMs: 20, judgeMs: 30,
  })
  await updateDistillRunDigestMs(db, 'job-1', 42)
  const run = await getDistillRun(db, 'job-1')
  expect(run!.digestMs).toBe(42)
  expect(run!.dedupMs).toBe(20)
  expect(run!.judgeMs).toBe(30)
  await updateDistillRunDigestMs(db, 'no-such-job', 1) // 不抛
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/store-notifications.test.ts`
Expected: FAIL（导出缺失）

- [ ] **Step 3: 实现 store 层**

`src/memory/store.ts`：

3a. import 追加：`like`（drizzle-orm）、`notifications`（schema）。

3b. `DistillRunRecord` 加两字段：`dedupMs?: number | null`、`judgeMs?: number | null`；`DistillRunRow` 加 `digestMs: number | null; dedupMs: number | null; judgeMs: number | null`；`saveDistillRun` 的 values 与 onConflictDoUpdate set 均加 `dedupMs: record.dedupMs ?? null, judgeMs: record.judgeMs ?? null`；`rowToRun` 映射加 `digestMs: r.digestMs ?? null, dedupMs: r.dedupMs ?? null, judgeMs: r.judgeMs ?? null`。注意：`DistillRunListRow`（若存在且用于列表端点）不需这些字段则不动；`getDistillRun` 返回类型经 rowToRun 自动带出。

3c. 文件末尾（listDegradationsForJob 之后）追加消息层：

```ts
// ---------------------------------------------------------------------------
// 消息中心（spec 2026-08-12 §5.1-5.3）：notifications 收件箱
// ---------------------------------------------------------------------------

export const NOTIFICATION_RETENTION_CAP = 500
export const NOTIFICATION_BODY_CAP_CHARS = 2000
export const NOTIFICATION_KINDS = ['degradation', 'llm_error'] as const
export type NotificationKind = typeof NOTIFICATION_KINDS[number]

export interface NotificationRow {
  id: string; ts: number; kind: NotificationKind; title: string
  body: string | null; refType: string | null; refId: string | null; readAt: number | null
}

export class NotificationNotFoundError extends Error {}
export class InvalidNotificationFilterError extends Error {}

/**
 * 写一条消息并执行保留裁剪（spec §5.2）：超过 NOTIFICATION_RETENTION_CAP
 * 删最旧。裁剪失败只 warn，不影响插入结果。
 */
export async function insertNotification(
  db: DbClient,
  input: { kind: NotificationKind; title: string; body?: string | null; refType?: string | null; refId?: string | null },
): Promise<string> {
  const id = ulid()
  const body = input.body == null ? null : input.body.slice(0, NOTIFICATION_BODY_CAP_CHARS)
  await db.insert(notifications).values({
    id, ts: Date.now(), kind: input.kind, title: input.title, body,
    refType: input.refType ?? null, refId: input.refId ?? null, readAt: null,
  }).run()
  try {
    await db.run(sql`DELETE FROM notifications WHERE id NOT IN (SELECT id FROM notifications ORDER BY ts DESC, id DESC LIMIT ${NOTIFICATION_RETENTION_CAP})`)
  } catch (e) { console.warn('memside: notification retention trim failed', e) }
  return id
}

/** scheduler llm_error 路径专用（spec §5.2）：自身吞错只 warn，不炸蒸馏。 */
export async function logLlmErrorNotification(db: DbClient, input: { jobId: string; message: string }): Promise<void> {
  try {
    await insertNotification(db, { kind: 'llm_error', title: 'llm_error', body: input.message, refType: 'distill_job', refId: input.jobId })
  } catch (e) { console.warn('memside: llm_error notification insert failed', e) }
}

export interface NotificationListOpts {
  limit?: number
  before?: PageCursor
  kind?: NotificationKind
  unreadOnly?: boolean
  q?: string
}

/** 消息分页（spec §5.3）：游标/排序/total 与 listDiscardsPage 同模式。 */
export async function listNotificationsPage(
  db: DbClient, opts: NotificationListOpts = {},
): Promise<PageWithTotal<NotificationRow>> {
  if (opts.kind && !(NOTIFICATION_KINDS as readonly string[]).includes(opts.kind)) {
    throw new InvalidNotificationFilterError(`invalid notification kind: ${opts.kind}`)
  }
  const limit = clampPageLimit(opts.limit)
  const baseConds: any[] = []
  if (opts.kind) baseConds.push(eq(notifications.kind, opts.kind))
  if (opts.unreadOnly) baseConds.push(isNull(notifications.readAt))
  if (opts.q) baseConds.push(or(like(notifications.title, `%${opts.q}%`), like(notifications.body, `%${opts.q}%`)))
  const conds = [...baseConds]
  if (opts.before) {
    conds.push(or(
      lt(notifications.ts, opts.before.ts),
      and(eq(notifications.ts, opts.before.ts), lt(notifications.id, opts.before.id)),
    ))
  }
  const rows = await db.select().from(notifications)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(notifications.ts), desc(notifications.id))
    .limit(limit + 1).all()
  const countRows = await db.select({ n: sql<number>`COUNT(*)` }).from(notifications)
    .where(baseConds.length > 0 ? and(...baseConds) : undefined).all()
  const hasMore = rows.length > limit
  const pageRows = rows.slice(0, limit)
  const last = pageRows[pageRows.length - 1]
  return {
    items: pageRows as NotificationRow[],
    hasMore,
    nextCursor: hasMore && last ? { ts: last.ts, id: last.id } : null,
    total: Number(countRows[0]?.n ?? 0),
  }
}

/** 标已读（spec §5.3）：已读行幂等成功；不存在抛 NotificationNotFoundError（server 404）。 */
export async function markNotificationRead(db: DbClient, id: string): Promise<void> {
  const rows = await db.update(notifications).set({ readAt: Date.now() })
    .where(and(eq(notifications.id, id), isNull(notifications.readAt)))
    .returning({ id: notifications.id })
  if (rows.length === 0) {
    const exists = await db.select({ id: notifications.id }).from(notifications)
      .where(eq(notifications.id, id)).limit(1)
    if (exists.length === 0) throw new NotificationNotFoundError(`notification ${id} not found`)
  }
}

/** 全部已读（spec §5.3）：返回本次标记条数。 */
export async function markAllNotificationsRead(db: DbClient): Promise<number> {
  const rows = await db.update(notifications).set({ readAt: Date.now() })
    .where(isNull(notifications.readAt)).returning({ id: notifications.id })
  return rows.length
}

/** digest 耗时回填（spec §5.4）：run 行在 saveDistillRun 时已写，此处二次 UPDATE；无行 no-op。 */
export async function updateDistillRunDigestMs(db: DbClient, jobId: string, ms: number): Promise<void> {
  await db.update(memoryDistillRuns).set({ digestMs: ms })
    .where(eq(memoryDistillRuns.distillJobId, jobId)).run()
}
```

3d. `logDegradation` 改双写（store.ts:1128 附近，保持「审计自身失败 console-only」契约）：

```ts
export async function logDegradation(
  db: DbClient,
  entry: { kind: string; detail?: string; distillJobId?: string; sessionId?: string },
): Promise<void> {
  try {
    await db.insert(memoryDegradations).values({
      id: ulid(), ts: Date.now(), kind: entry.kind,
      detail: entry.detail ?? null, distillJobId: entry.distillJobId ?? null,
      sessionId: entry.sessionId ?? null,
    })
  } catch (e) {
    console.warn('memside: logDegradation failed (audit self-failure, console-only by design)', e)
    return
  }
  // 消息双写（spec 2026-08-12 §5.2）：审计表 + 用户收件箱各一条。
  // 与审计同契约：失败只 warn，不炸调用方。
  try {
    await insertNotification(db, {
      kind: 'degradation', title: entry.kind, body: entry.detail ?? null,
      refType: entry.distillJobId ? 'distill_job' : null,
      refId: entry.distillJobId ?? null,
    })
  } catch (e) {
    console.warn('memside: degradation notification insert failed', e)
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/store-notifications.test.ts tests/store-crud.test.ts tests/store-page.test.ts tests/degradation-coverage.test.ts`
Expected: PASS（新文件 8 条 + 既有回归不破）

- [ ] **Step 5: 全量门禁 + commit**

Run: `bun run typecheck && bun test`
Expected: 全绿（既有 saveDistillRun 调用不传 dedupMs/judgeMs -> `?? null`，行为不变）

```bash
git add src/memory/store.ts tests/store-notifications.test.ts
git commit -m "feat(store): notifications 消息层（双写/分页/已读/500 保留/runs 耗时字段）"
```

---

### Task 4: server 端点 + status 扩展 + ack 退役

**Files:**
- Modify: `src/server.ts`
- Modify: `tests/server-degradations.test.ts`（recentDegradations/ack 用例替换为回归锁）
- Test: `tests/server-notifications.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 `ActivityTracker` 类型；Task 3 全部 store 函数与错误类。
- Produces: `GET /api/notifications`、`POST /api/notifications/:id/read`、`POST /api/notifications/read-all`；`/api/status` 新字段 `llmActivity`/`llmStats24h`/`unreadNotifications`，删 `recentDegradations`；删 `POST /api/degradations/ack`。`AppDeps` 加 `tracker?: ActivityTracker`。Task 8/9 依赖响应形状。

- [ ] **Step 1: 写失败测试**

`tests/server-notifications.test.ts`（沿用 server-degradations.test.ts 的 createApp + `app.request` 风格与临时 db 脚手架——先读该文件头部照抄脚手架）：

```ts
// 消息中心端点 + status 新字段（spec 2026-08-12 §5.8）。
import { test, expect, describe, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { createApp } from '@/server'
import { insertNotification, saveDistillRun } from '@/memory/store'
import { memoryDistillJobs } from '@/db/schema'
import { createActivityTracker } from '@/activity'

const root = join(import.meta.dir, '.tmp-server-notifications')
let dir = ''
let db: ReturnType<typeof openDb>
let app: ReturnType<typeof createApp>

function mkApp(tracker = createActivityTracker()) {
  return createApp({
    db,
    adapter: { inject: async () => null } as any,
    opencodeAdapter: { inject: async () => null } as any,
    enqueueDistillJob: async () => ({ jobId: 'j', nextRunAt: 0 }),
    broadcast: () => {},
    tracker,
  } as any)
}

beforeAll(() => { rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true }) })
beforeEach(() => {
  dir = join(root, Math.random().toString(36).slice(2))
  mkdirSync(dir, { recursive: true })
  db = openDb(join(dir, 't.db'))
  app = mkApp()
})
afterEach(() => { db.$client.close() })

describe('GET /api/notifications', () => {
  test('分页 + kind + unread + q + total', async () => {
    await insertNotification(db, { kind: 'degradation', title: 'digest_truncated', body: '切片超限' })
    await insertNotification(db, { kind: 'llm_error', title: 'llm_error', body: 'timeout' })
    const all = await app.request('/api/notifications?limit=20').then((r) => r.json() as any)
    expect(all.total).toBe(2)
    const onlyDegr = await app.request('/api/notifications?limit=20&kind=degradation').then((r) => r.json() as any)
    expect(onlyDegr.total).toBe(1)
    const unread = await app.request('/api/notifications?limit=20&unread=1').then((r) => r.json() as any)
    expect(unread.total).toBe(2)
    const hit = await app.request(`/api/notifications?limit=20&q=${encodeURIComponent('超时')}`).then((r) => r.json() as any)
    expect(hit.total).toBe(1)
  })
  test('非法 kind -> 400', async () => {
    expect((await app.request('/api/notifications?kind=bogus')).status).toBe(400)
  })
})

describe('已读端点', () => {
  test('read 单条幂等；未知 id -> 404', async () => {
    const id = await insertNotification(db, { kind: 'degradation', title: 'a' })
    expect((await app.request(`/api/notifications/${id}/read`, { method: 'POST' })).status).toBe(200)
    expect((await app.request(`/api/notifications/${id}/read`, { method: 'POST' })).status).toBe(200)
    expect((await app.request('/api/notifications/nope/read', { method: 'POST' })).status).toBe(404)
  })
  test('read-all 返回 marked 数', async () => {
    await insertNotification(db, { kind: 'degradation', title: 'a' })
    await insertNotification(db, { kind: 'llm_error', title: 'b' })
    const body = await app.request('/api/notifications/read-all', { method: 'POST' }).then((r) => r.json() as any)
    expect(body.marked).toBe(2)
  })
})

describe('/api/status 扩展', () => {
  test('unreadNotifications 计数；ack 路由退役 404；无 recentDegradations 键', async () => {
    await insertNotification(db, { kind: 'degradation', title: 'a' })
    const body = await app.request('/api/status').then((r) => r.json() as any)
    expect(body.unreadNotifications).toBe(1)
    expect(body.recentDegradations).toBeUndefined()
    expect((await app.request('/api/degradations/ack', { method: 'POST' })).status).toBe(404)
  })

  test('llmActivity 透传 tracker；空闲为 null', async () => {
    const tracker = createActivityTracker()
    const app2 = mkApp(tracker)
    expect((await app2.request('/api/status').then((r) => r.json() as any)).llmActivity).toBeNull()
    tracker.begin('distill', 'memside')
    const act = (await app2.request('/api/status').then((r) => r.json() as any)).llmActivity
    expect(act.phase).toBe('distill')
    expect(act.detail).toBe('memside')
  })

  test('llmStats24h：skipped 不计蒸馏次数；NULL 列不计去重/审查；digest 并入蒸馏', async () => {
    const now = Date.now()
    // produced：蒸馏 100ms + digest 50ms + 去重 20ms（无审查）
    await saveDistillRun(db, 'j1', { outcome: 'produced', rawOutput: null, rawCount: 1, acceptedCount: 1, dedupedCount: 1, filteredCount: 1, storedCount: 1, discardedCount: 0, durationMs: 100, errorMessage: null, dedupMs: 20, judgeMs: null })
    await db.update(require('@/db/schema').memoryDistillRuns).set({ digestMs: 50 }).where(undefined as any).run().catch(() => {}) // 见实现注记
    // skipped：duration=0 不计蒸馏
    await saveDistillRun(db, 'j2', { outcome: 'skipped_trivial', rawOutput: null, rawCount: 0, acceptedCount: 0, dedupedCount: 0, filteredCount: 0, storedCount: 0, discardedCount: 0, durationMs: 0, errorMessage: null })
    const s = (await app.request('/api/status').then((r) => r.json() as any)).llmStats24h
    expect(s.distill.count).toBe(1)
    expect(s.distill.ms).toBe(100) // digest 回填见实现注记；未回填时此值为 100
    expect(s.dedup).toEqual({ count: 1, ms: 20 })
    expect(s.judge).toEqual({ count: 0, ms: 0 })
  })
})
```

实现注记：`digest_ms` 回填那行的写法以真实 API 为准——用 `updateDistillRunDigestMs(db, 'j1', 50)`（Task 3 已提供）替换掉示意行，并把断言改为 `expect(s.distill.ms).toBe(150)`。

- [ ] **Step 2: 更新 tests/server-degradations.test.ts**

把 `describe('GET /api/status recentDegradations（spec §4.9）')` 整块（含 ack upsert 用例）删除或替换为一句话注释「recentDegradations/ack 已被消息中心取代（spec 2026-08-12），回归锁在 tests/server-notifications.test.ts」。该文件其余用例（waitingJobs 等）保留。文件头注释同步更新。

- [ ] **Step 3: 跑测试确认失败**

Run: `bun test tests/server-notifications.test.ts tests/server-degradations.test.ts`
Expected: FAIL（端点/字段缺失）

- [ ] **Step 4: server.ts 实现**

4a. import 追加：`notifications`（schema）；`isNull`（drizzle-orm，若未有）；store 的 `listNotificationsPage, markNotificationRead, markAllNotificationsRead, NotificationNotFoundError`；`type ActivityTracker`（`@/activity`）。移除 `listRecentDegradations` 的 import（server 不再用；store 函数本身保留）。

4b. `AppDeps` 加字段：

```ts
  /** LLM 实时活动跟踪器（spec 2026-08-12 §5.7）：scheduler 置位，status 读出。 */
  tracker?: ActivityTracker
```

4c. 删除 `app.post('/api/degradations/ack', ...)` 整个路由（server.ts:475 附近）。

4d. `/api/status`（server.ts:422 起）：删除 `degrRows` / `ackRow` / `acknowledgedTs` 三段及响应里的 `recentDegradations` 字段；`appSettings` 若仅此处使用则连 import 一并清理（注意：settings 相关路由也用 appSettings，确认 import 是否仍被引用再动）。在 `return c.json({...})` 前追加：

```ts
    // LLM 实况与统计（spec 2026-08-12 §5.8）
    const llmActivity = deps.tracker?.get() ?? null
    const statsRows = await deps.db.select({
      distillCount: sql<number>`SUM(CASE WHEN ${memoryDistillRuns.durationMs} > 0 THEN 1 ELSE 0 END)`,
      distillMs: sql<number>`COALESCE(SUM(${memoryDistillRuns.durationMs}), 0) + COALESCE(SUM(${memoryDistillRuns.digestMs}), 0)`,
      dedupCount: sql<number>`SUM(CASE WHEN ${memoryDistillRuns.dedupMs} IS NOT NULL THEN 1 ELSE 0 END)`,
      dedupMs: sql<number>`COALESCE(SUM(${memoryDistillRuns.dedupMs}), 0)`,
      judgeCount: sql<number>`SUM(CASE WHEN ${memoryDistillRuns.judgeMs} IS NOT NULL THEN 1 ELSE 0 END)`,
      judgeMs: sql<number>`COALESCE(SUM(${memoryDistillRuns.judgeMs}), 0)`,
    }).from(memoryDistillRuns).where(gt(memoryDistillRuns.ts, cutoff)).all()
    const st = statsRows[0]
    const unreadRows = await deps.db.select({ n: count() }).from(notifications)
      .where(isNull(notifications.readAt)).all()
```

（`sql` 已在 server.ts import 则复用；`cutoff` 复用该函数既有的 24h cutoff 常量。）响应对象追加：

```ts
      llmActivity,
      llmStats24h: {
        distill: { count: Number(st?.distillCount ?? 0), ms: Number(st?.distillMs ?? 0) },
        dedup: { count: Number(st?.dedupCount ?? 0), ms: Number(st?.dedupMs ?? 0) },
        judge: { count: Number(st?.judgeCount ?? 0), ms: Number(st?.judgeMs ?? 0) },
      },
      unreadNotifications: unreadRows[0]?.n ?? 0,
```

4e. 在 `parseBefore` 定义之后（memories 路由之前）加消息端点：

```ts
  // --- Notifications（消息中心，spec 2026-08-12 §5.8）------------------------
  app.get('/api/notifications', async (c) => {
    const kindParam = c.req.query('kind')
    let kind: 'degradation' | 'llm_error' | undefined
    if (kindParam !== undefined) {
      if (kindParam !== 'degradation' && kindParam !== 'llm_error') {
        return c.json({ error: `invalid kind: ${kindParam}` }, 400)
      }
      kind = kindParam
    }
    const limitParam = c.req.query('limit')
    const page = await listNotificationsPage(deps.db, {
      limit: limitParam !== undefined ? Number(limitParam) : undefined,
      before: parseBefore(c),
      kind,
      unreadOnly: c.req.query('unread') === '1',
      q: c.req.query('q') || undefined,
    })
    return c.json(page)
  })

  app.post('/api/notifications/read-all', async (c) => {
    const marked = await markAllNotificationsRead(deps.db)
    return c.json({ ok: true, marked })
  })

  app.post('/api/notifications/:id/read', async (c) => {
    try {
      await markNotificationRead(deps.db, c.req.param('id'))
      return c.json({ ok: true })
    } catch (e) {
      if (e instanceof NotificationNotFoundError) return c.json({ error: 'not found' }, 404)
      throw e
    }
  })
```

（`read-all` 注册在 `:id/read` 之前；两者段数不同本不冲突，顺序只是可读性。）

- [ ] **Step 5: 跑测试确认通过 + 全量门禁**

Run: `bun test tests/server-notifications.test.ts tests/server-degradations.test.ts && bun run typecheck && bun test`
Expected: 全绿（web-degradations.test.ts 的 App.tsx 文本断言此阶段仍通过——它锁的是 App.tsx 不是 server）

- [ ] **Step 6: commit**

```bash
git add src/server.ts tests/server-notifications.test.ts tests/server-degradations.test.ts
git commit -m "feat(server): 消息中心端点 + status LLM 实况/24h 统计/未读数，ack 退役"
```

---

### Task 5: scheduler 接线（阶段置位 + 耗时采集 + llm_error 消息）

**Files:**
- Modify: `src/scheduler.ts`
- Test: `tests/scheduler-activity.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 `ActivityTracker`/`LlmPhase`/`PhaseHandle`；Task 3 `logLlmErrorNotification`/`updateDistillRunDigestMs`、`DistillRunRecord.dedupMs/judgeMs`。
- Produces: `TickDeps.tracker?: ActivityTracker`；tick 内 distill/dedup/judge/digest 四站点置位与耗时落 run；llm_error 写消息。Task 6 依赖 TickDeps 形状。

- [ ] **Step 1: 写失败测试**

`tests/scheduler-activity.test.ts`（脚手架与 fake-callLLM 模式照抄 tests/scheduler.test.ts；economy 模式常量同抄）：

```ts
// LLM 阶段活动接线 + 三阶段耗时 + llm_error 消息（spec 2026-08-12 §5.6）。
import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { enqueueDistillJob, tick } from '@/scheduler'
import { getDistillRun, listNotificationsPage } from '@/memory/store'
import { memoryDistillJobs, memoryDistillRuns } from '@/db/schema'
import { createActivityTracker } from '@/activity'

const ECONOMY = { mode: 'economy', maxRounds: 30, timeBudgetS: 300 } as const

const root = join(import.meta.dir, '.tmp-sched-activity')
let dir = ''
let db: ReturnType<typeof openDb>

beforeAll(() => { rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true }) })
beforeEach(() => {
  dir = join(root, Math.random().toString(36).slice(2))
  mkdirSync(dir, { recursive: true })
  db = openDb(join(dir, 't.db'))
})
afterEach(() => { db.$client.close() })

const ONE_CANDIDATE = JSON.stringify({
  candidates: [{ title: '[category:invariant] x', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }],
})

async function seedDueJob(cwd = '/proj/memside') {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd, debounceKey: 'k', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  return jobId
}

test('一趟 job：tracker 依次 distill->dedup->judge，结束归 null；run 落 dedup_ms/judge_ms', async () => {
  const jobId = await seedDueJob()
  const tracker = createActivityTracker()
  const seen: string[] = []
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'hello world' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async (sys) => {
      const act = tracker.get()
      if (act) seen.push(act.phase)
      // distill 返候选；dedup/judge 的 prompt 返「无重复/全保留」语义的安全值
      if (act?.phase === 'distill') return ONE_CANDIDATE
      return JSON.stringify({})
    },
    createCandidate: async () => ({ id: 'c1', status: 'candidate', version: 1 } as any),
    loadJudgeConfig: () => ECONOMY,
    tracker,
  })
  expect(tracker.get()).toBeNull()
  expect(seen[0]).toBe('distill')
  expect(seen).toContain('judge')              // dedup 可能 0 调用（单候选短路），judge 必调
  const run = await getDistillRun(db, jobId)
  expect(run!.judgeMs).not.toBeNull()
})

test('0 候选短路：judge 未调 LLM -> judge_ms NULL', async () => {
  const jobId = await seedDueJob()
  const tracker = createActivityTracker()
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async () => JSON.stringify({ candidates: [] }),
    createCandidate: async () => ({ id: 'c', status: 'candidate', version: 1 } as any),
    loadJudgeConfig: () => ECONOMY,
    tracker,
  })
  const run = await getDistillRun(db, jobId)
  expect(run!.judgeMs).toBeNull()
  expect(tracker.get()).toBeNull()
})

test('llm_error 路径：写一条 kind=llm_error 消息，refId=jobId', async () => {
  const jobId = await seedDueJob()
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1, prefixTurns: [] }),
    callLLM: async () => { throw new Error('502 Bad Gateway') },
    createCandidate: async () => ({ id: 'c', status: 'candidate', version: 1 } as any),
    loadJudgeConfig: () => ECONOMY,
    tracker: createActivityTracker(),
  })
  const pg = await listNotificationsPage(db, { kind: 'llm_error' })
  expect(pg.total).toBe(1)
  expect(pg.items[0]!.refId).toBe(jobId)
  expect(pg.items[0]!.body).toContain('502')
})

test('降级经 logDegradation 也进消息（digest_llm_failed 之外的既有路径回归）', async () => {
  // loadTranscript 抛错 -> job 回退 pending（既有行为），本测试只锁 tracker 不复位残留
  const tracker = createActivityTracker()
  await seedDueJob()
  await tick(db, {
    loadTranscript: async () => { throw new Error('no transcript') },
    callLLM: async () => '[]',
    createCandidate: async () => ({ id: 'c', status: 'candidate', version: 1 } as any),
    loadJudgeConfig: () => ECONOMY,
    tracker,
  })
  expect(tracker.get()).toBeNull()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/scheduler-activity.test.ts`
Expected: FAIL（TickDeps 无 tracker / run 无 dedup_ms / 无 llm_error 消息）

- [ ] **Step 3: scheduler.ts 实现**

3a. import 追加：`basename`（`node:path`，与既有 `parse as parsePath` 同来源合并）；store 的 `logLlmErrorNotification, updateDistillRunDigestMs`；`type ActivityTracker, type LlmPhase`（`@/activity`）。

3b. `TickDeps` 加：

```ts
  /** LLM 阶段活动跟踪（spec 2026-08-12 §5.6）；不传 = 不跟踪（测试/runDistillOnce 不受影响）。 */
  tracker?: ActivityTracker
```

3c. tick 的 for-loop 内、`try {` 之后（loadTranscript 之前）加 helper：

```ts
    const jobDetail = job.cwd ? basename(job.cwd) : null
    const tracker = deps.tracker ?? null
    const tracked = (tracker
      ? tracker.wrapCall(deps.callLLM)
      : deps.callLLM)
    const phase = (p: LlmPhase): { end(): { calls: number; ms: number } } =>
      tracker ? tracker.begin(p, jobDetail) : { end: () => ({ calls: 0, ms: 0 }) }
```

注意：wrapCall 只包一次，四站点共用同一个 wrapped（tracker 内部按当前阶段计数）。

3d. distill 站点（scheduler.ts:307-318）改为：

```ts
      const t0 = Date.now()
      const pDistill = phase('distill')
      let distillOut: Awaited<ReturnType<typeof distillTranscript>>
      try {
        distillOut = await distillTranscript({
          turns: newTurns,
          runtime: job.runtime as 'claude-code' | 'opencode',
          cwd: job.cwd ?? '',
          existingSlugs,
          callLLM: tracked,
          sourceKind: job.sourceAgentId ? 'subagent' : 'conversation',
          priorContext,
          approvedTitles,
        })
      } finally { pDistill.end() }
      const { candidates, filteredTurns, rawOutput, rawCount, callThrew, errorMessage } = distillOut
      const durationMs = Date.now() - t0
```

3e. dedup 站点（:336）改为：

```ts
      const pDedup = phase('dedup')
      let dedupPhase = { calls: 0, ms: 0 }
      let deduped: DistillCandidate[]
      try {
        deduped = await dedupCandidates(db, tracked, exact.kept, job.cwd ?? null)
      } finally { dedupPhase = pDedup.end() }
      const dedupMs = dedupPhase.calls > 0 ? dedupPhase.ms : null
```

（`DistillCandidate` 类型已 import；若 `deduped` 原为 const，此处改 let 并保持后续引用不变。）

3f. judge 站点（:343-362 的模式分发整块）外层包 phase：

```ts
      const pJudge = phase('judge')
      let judgePhase = { calls: 0, ms: 0 }
      try {
        // ……既有 agentRootDir / if-else 分发逐字保留，仅把三处 deps.callLLM
        // （judgeValue(deduped, deps.callLLM) 两处 + judgeValueAgentic 的 callLLM）换成 tracked
      } finally { judgePhase = pJudge.end() }
      const judgeMs = judgePhase.calls > 0 ? judgePhase.ms : null
```

3g. saveDistillRun 调用（:408）record 末尾追加 `dedupMs, judgeMs,`。

3h. llm_error 块（:431）追加一行（仍在既有 try/catch 内、lastError 写入之后）：

```ts
        await logLlmErrorNotification(db, { jobId: job.id, message: errorMessage })
```

（logLlmErrorNotification 自身吞错，无需再包 try。）

3i. digest 站点（:448-461）重写为：

```ts
      if (!callThrew && judgeCfg.mode === 'quality' && job.sessionId && !job.sourceAgentId) {
        let digestPhase = { calls: 0, ms: 0 }
        try {
          const prior = await getSessionDigest(db, job.sessionId)
          const pDigest = phase('digest')
          try {
            const { digest: merged, truncated, overshoot } = await updateSessionLedger(prior?.digest ?? null, newTurns, tracked)
            if (merged !== (prior?.digest ?? '')) {
              await upsertSessionDigest(db, job.sessionId, merged, 'llm')
            }
            if (truncated && overshoot) {
              await logDegradation(db, { kind: 'digest_truncated', detail: `切片压缩产出 ${overshoot.actual} 字超配额 ${overshoot.budget} 字，按行裁剪保留最新`, distillJobId: job.id, sessionId: job.sessionId })
            }
          } finally { digestPhase = pDigest.end() }
        } catch (e) {
          await logDegradation(db, { kind: 'digest_llm_failed', detail: String(e), distillJobId: job.id, sessionId: job.sessionId })
        }
        if (digestPhase.calls > 0) {
          try { await updateDistillRunDigestMs(db, job.id, digestPhase.ms) }
          catch (e) { console.warn('memside: updateDistillRunDigestMs failed', e) }
        }
      }
```

- [ ] **Step 4: 跑测试确认通过 + 全量门禁**

Run: `bun test tests/scheduler-activity.test.ts tests/scheduler.test.ts tests/scheduler-judge-dispatch.test.ts tests/scheduler-distill-batching.test.ts && bun run typecheck && bun test`
Expected: 全绿（不传 tracker 时 helper 全部走 no-op 分支，既有 scheduler 测试行为不变）

- [ ] **Step 5: commit**

```bash
git add src/scheduler.ts tests/scheduler-activity.test.ts
git commit -m "feat(scheduler): LLM 四阶段活动置位 + 耗时采集 + llm_error 消息"
```

---

### Task 6: daemon 接线（tracker 单例双侧注入）

**Files:**
- Modify: `src/daemon.ts`
- Test: `tests/daemon-activity.test.ts`（新建，源码层断言 + createApp 集成）

**Interfaces:**
- Consumes: Task 1 `createActivityTracker`；Task 4 `AppDeps.tracker`；Task 5 `TickDeps.tracker`。
- Produces: `startDaemon` 内唯一 tracker 实例同时进 `createApp` deps 与 `tickDeps`。

- [ ] **Step 1: 写失败测试**

`tests/daemon-activity.test.ts`：

```ts
// tracker 单例双侧注入（spec 2026-08-12 §5.7）：startDaemon 源码层断言兜底。
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(import.meta.dir, '..', 'src', 'daemon.ts'), 'utf8')

test('startDaemon 创建唯一 tracker 并注入 createApp 与 tickDeps', () => {
  expect(src).toContain("import { createActivityTracker } from './activity'")
  expect(src).toContain('const tracker = createActivityTracker()')
  expect(src).toContain('tracker')  // 双侧注入见下两条精确断言
  expect(src).toMatch(/createApp\(\{[^}]*tracker/s)
  expect(src).toMatch(/const tickDeps: TickDeps = \{[^}]*tracker/s)
})

test('tracker 只创建一次（单例）', () => {
  expect(src.match(/createActivityTracker\(\)/g)?.length).toBe(1)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/daemon-activity.test.ts`
Expected: FAIL

- [ ] **Step 3: daemon.ts 实现**

import 行追加：`import { createActivityTracker } from './activity'`。

`startDaemon` 内、`const adapter = new ClaudeCodeAdapter(db)` 之前加：

```ts
  // LLM 实时活动单例（spec 2026-08-12 §5.7）：scheduler 侧置位，server 侧读出。
  const tracker = createActivityTracker()
```

`createApp({...})` 参数追加 `tracker`（与 callLLM 并列）。`tickDeps` 对象追加 `tracker`。

- [ ] **Step 4: 跑测试确认通过 + 全量门禁**

Run: `bun test tests/daemon-activity.test.ts && bun run typecheck && bun test`
Expected: 全绿

- [ ] **Step 5: commit**

```bash
git add src/daemon.ts tests/daemon-activity.test.ts
git commit -m "feat(daemon): activity tracker 单例注入 scheduler 与 server"
```

---

### Task 7: ui-utils 纯函数（阶段/耗时/统计/消息标题）

**Files:**
- Modify: `src/web/ui-utils.ts`
- Test: `tests/ui-utils.test.ts`（追加 describe）

**Interfaces:**
- Produces（Task 9/10 依赖）：`phaseLabel(phase: string): string`；`formatElapsed(ms: number): string`；`formatPhaseStat(count: number, ms: number): string`；`notificationTitle(n: { kind: string; title: string }): string`。

- [ ] **Step 1: 写失败测试**

追加到 `tests/ui-utils.test.ts`：

```ts
describe('LLM 实况与消息文案（spec 2026-08-12 §5.11）', () => {
  test('phaseLabel：digest 归蒸馏；未知原样兜底', () => {
    expect(phaseLabel('distill')).toBe('蒸馏')
    expect(phaseLabel('digest')).toBe('蒸馏')
    expect(phaseLabel('dedup')).toBe('去重')
    expect(phaseLabel('judge')).toBe('审查')
    expect(phaseLabel('weird')).toBe('weird')
  })

  test('formatElapsed 边界：59s/60s/59分/60分', () => {
    expect(formatElapsed(59_000)).toBe('59秒')
    expect(formatElapsed(60_000)).toBe('1分')
    expect(formatElapsed(3_599_000)).toBe('59分')
    expect(formatElapsed(3_600_000)).toBe('1小时0分')
    expect(formatElapsed(-5)).toBe('0秒')
  })

  test('formatPhaseStat：0 次不带耗时；正常「N次·X」', () => {
    expect(formatPhaseStat(0, 123456)).toBe('0次')
    expect(formatPhaseStat(19, 8 * 60_000)).toBe('19次·8分')
    expect(formatPhaseStat(2, 45_000)).toBe('2次·45秒')
  })

  test('notificationTitle：降级走 degradationKindLabel；llm_error 固定文案；未知兜底', () => {
    expect(notificationTitle({ kind: 'degradation', title: 'digest_truncated' })).toBe('摘要压缩超限')
    expect(notificationTitle({ kind: 'degradation', title: 'unknown_kind' })).toBe('unknown_kind')
    expect(notificationTitle({ kind: 'llm_error', title: 'llm_error' })).toBe('蒸馏 LLM 报错')
  })
})
```

（import 行补 `phaseLabel, formatElapsed, formatPhaseStat, notificationTitle`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/ui-utils.test.ts`
Expected: FAIL（函数未导出）

- [ ] **Step 3: 实现**

追加到 `src/web/ui-utils.ts` 末尾：

```ts
/** LLM 阶段 -> 中文列名（spec 2026-08-12 §5.11）。digest（账本压缩）归「蒸馏」列。 */
export function phaseLabel(phase: string): string {
  if (phase === 'distill' || phase === 'digest') return '蒸馏'
  if (phase === 'dedup') return '去重'
  if (phase === 'judge') return '审查'
  return phase
}

/** 耗时人话：<60s 显秒；<60分 显整分；>=1小时 显「N小时M分」。负值归 0。 */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}分`
  return `${Math.floor(m / 60)}小时${m % 60}分`
}

/** 24h 统计单元格：「19次·8分」；0 次省略耗时。 */
export function formatPhaseStat(count: number, ms: number): string {
  if (count <= 0) return '0次'
  return `${count}次·${formatElapsed(ms)}`
}

/** 消息标题人话（spec §5.11）：degradation 复用降级 kind 映射；llm_error 固定文案。 */
export function notificationTitle(n: { kind: string; title: string }): string {
  if (n.kind === 'llm_error') return '蒸馏 LLM 报错'
  if (n.kind === 'degradation') return degradationKindLabel(n.title)
  return n.title
}
```

- [ ] **Step 4: 跑测试确认通过 + 全量门禁 + commit**

Run: `bun test tests/ui-utils.test.ts && bun run typecheck && bun test`

```bash
git add src/web/ui-utils.ts tests/ui-utils.test.ts
git commit -m "feat(ui-utils): 阶段/耗时/统计/消息标题纯函数"
```

---

### Task 8: web/api.ts 类型与 wrapper

**Files:**
- Modify: `src/web/api.ts`
- Test: `tests/web-api.test.ts`（追加；如有 ackDegradations 旧断言一并删除）

**Interfaces:**
- Consumes: Task 4 端点契约。
- Produces（Task 9/10 依赖）：`MemsideStatus.llmActivity?/llmStats24h?/unreadNotifications?`（删 `recentDegradations?`）；`NotificationItem`；`listNotificationsPage(fetchFn, opts)`；`markNotificationRead(id, fetchFn)`；`markAllNotificationsRead(fetchFn)`；删 `ackDegradations`。

- [ ] **Step 1: 写失败测试**

追加到 `tests/web-api.test.ts`（沿用该文件既有的 fake-fetch/Response 风格）：

```ts
test('listNotificationsPage 序列化 kind/unread/q/cursor', async () => {
  let url = ''
  const fakeFetch: FetchLike = async (u) => { url = String(u); return new Response(JSON.stringify({ items: [], hasMore: false, nextCursor: null, total: 0 })) }
  await listNotificationsPage(fakeFetch, { kind: 'degradation', unreadOnly: true, q: '摘要', before: { ts: 9, id: 'x' }, limit: 20 })
  expect(url).toContain('/api/notifications?')
  expect(url).toContain('kind=degradation')
  expect(url).toContain('unread=1')
  expect(url).toContain(`q=${encodeURIComponent('摘要')}`)
  expect(url).toContain('before=9')
  expect(url).toContain('beforeId=x')
})

test('markNotificationRead / markAllNotificationsRead 方法与路径', async () => {
  const calls: { url: string; method?: string }[] = []
  const fakeFetch: FetchLike = async (u, init) => { calls.push({ url: String(u), method: init?.method }); return new Response('{}') }
  await markNotificationRead('n1', fakeFetch)
  await markAllNotificationsRead(fakeFetch)
  expect(calls[0]).toEqual({ url: '/api/notifications/n1/read', method: 'POST' })
  expect(calls[1]).toEqual({ url: '/api/notifications/read-all', method: 'POST' })
})

test('MemsideStatus 新字段类型存在（编译期锁定）', () => {
  const s: MemsideStatus = {
    events: 0, jobs: {}, memories: {}, discards: 0, lastError: null,
    llmActivity: { phase: 'distill', detail: null, since: 1 },
    llmStats24h: { distill: { count: 1, ms: 2 }, dedup: { count: 0, ms: 0 }, judge: { count: 0, ms: 0 } },
    unreadNotifications: 3,
  }
  expect(s.unreadNotifications).toBe(3)
})
```

（import 行补新 wrapper 与类型。）

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/web-api.test.ts`
Expected: FAIL

- [ ] **Step 3: api.ts 实现**

3a. `MemsideStatus`：删除 `recentDegradations?` 字段；追加：

```ts
  /** LLM 实时活动（spec 2026-08-12 §5.8）；老 daemon 无此字段。 */
  llmActivity?: { phase: string; detail: string | null; since: number } | null
  /** 三阶段近 24h 次数与累计耗时；老 daemon 无此字段。 */
  llmStats24h?: {
    distill: { count: number; ms: number }
    dedup: { count: number; ms: number }
    judge: { count: number; ms: number }
  }
  /** 未读消息数（消息 tab 徽标 + 状态栏 🔔）；老 daemon 无此字段。 */
  unreadNotifications?: number
```

3b. 删除 `ackDegradations` 函数与其注释块。

3c. 追加消息 wrapper（放在分页 wrapper 区域）：

```ts
export interface NotificationItem {
  id: string
  ts: number
  kind: 'degradation' | 'llm_error'
  title: string
  body: string | null
  refType: string | null
  refId: string | null
  readAt: number | null
}

export async function listNotificationsPage(
  fetchFn: FetchLike = fetch,
  opts: { kind?: string; unreadOnly?: boolean; q?: string } & PageOpts = {},
): Promise<PageDto<NotificationItem>> {
  const p = pageParams(opts)
  if (opts.kind) p.set('kind', opts.kind)
  if (opts.unreadOnly) p.set('unread', '1')
  if (opts.q) p.set('q', opts.q)
  return parsePage<NotificationItem>(await fetchFn(`/api/notifications?${p}`))
}

/** POST /api/notifications/:id/read — no-throw 契约（与 promote/restore 同模式）。 */
export async function markNotificationRead(id: string, fetchFn: FetchLike = fetch): Promise<void> {
  await fetchFn(`/api/notifications/${id}/read`, { method: 'POST' })
}

/** POST /api/notifications/read-all — no-throw 契约。 */
export async function markAllNotificationsRead(fetchFn: FetchLike = fetch): Promise<void> {
  await fetchFn('/api/notifications/read-all', { method: 'POST' })
}
```

- [ ] **Step 4: 跑测试确认通过 + 全量门禁**

Run: `bun test tests/web-api.test.ts && bun run typecheck && bun test`
Expected: 全绿（App.tsx 仍 import ackDegradations 的话 typecheck 会红——Task 9 才删；若此步 typecheck 因 App.tsx 报 ackDegradations 缺失，则把 App.tsx 第 6 行 import 里的 `ackDegradations,` 一并删掉，其唯一使用点在降级横幅，Task 9 会整块移除；若横幅 JSX 因此刻报未定义，先把 Task 9 Step 3 的横幅移除提前到本步一起做，保持每步全绿）

- [ ] **Step 5: commit**

```bash
git add src/web/api.ts tests/web-api.test.ts src/web/App.tsx
git commit -m "feat(web-api): 消息端点 wrapper + status 新字段，ackDegradations 退役"
```

---

### Task 9: App.tsx 状态栏重写（LLM 实况 + 🔔）

**Files:**
- Modify: `src/web/App.tsx`
- Modify: `tests/web-degradations.test.ts`（横幅断言替换为反向回归锁）
- Test: `tests/web-statusbar.test.ts`（新建）

**Interfaces:**
- Consumes: Task 7 纯函数；Task 8 `MemsideStatus` 新字段。
- Produces: 新状态栏 JSX（行 1 三阶段 + 🔔 按钮 onClick setTab('messages')——messages tab 本体 Task 10 落地；本任务先把 TabKey 加上 'messages' 与空渲染占位，保证 typecheck 与按钮可点）。

- [ ] **Step 1: 写失败测试**

`tests/web-statusbar.test.ts`：

```ts
// 状态栏 LLM 实况接线 + 旧噪音移除（spec 2026-08-12 §5.10）。源码层文本断言兜底。
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')

test('状态栏接 LLM 实况与消息入口', () => {
  expect(src).toContain('llmActivity')
  expect(src).toContain('llmStats24h')
  expect(src).toContain('unreadNotifications')
  expect(src).toContain('phaseLabel')
  expect(src).toContain('formatElapsed')
  expect(src).toContain('formatPhaseStat')
  expect(src).toContain("setTab('messages')")
  expect(src).toContain('近24h')
})

test('旧状态栏噪音不得复活（反向锁）', () => {
  expect(src).not.toContain('已捕获事件')
  expect(src).not.toContain('最近错误')
  expect(src).not.toContain('ackDegradations')
  expect(src).not.toContain('recentDegradations')
  expect(src).not.toContain('知道了')
})
```

同时把 `tests/web-degradations.test.ts` 中 `test('App.tsx 含降级横幅与 ack 调用')` 整条替换为：

```ts
  test('降级横幅与全局 ack 已由消息中心取代（反向锁）', () => {
    expect(src).not.toContain('recentDegradations')
    expect(src).not.toContain('/api/degradations/ack')
  })
```

（该文件其余针对蒸馏 modal degradations 区的断言保留不动。）

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/web-statusbar.test.ts tests/web-degradations.test.ts`
Expected: FAIL

- [ ] **Step 3: App.tsx 实现**

3a. TabKey：`type TabKey = 'candidate' | 'approved' | 'rejected' | 'discards' | 'runs' | 'settings' | 'messages'`。

3b. `loaded`/`pending`/`loadingMore`/`loadMoreError` 四个初始状态对象各加 `messages: false`（loadMoreError 为 `messages: null`）。

3c. tabs 数组 settings 之后追加：

```ts
    { key: 'messages', label: '消息', count: status?.unreadNotifications ?? null },
```

3d. import 行：删 `ackDegradations`；加 `listNotificationsPage, markNotificationRead, markAllNotificationsRead, type NotificationItem`；ui-utils import 加 `phaseLabel, formatElapsed, formatPhaseStat, notificationTitle`。

3e. 删除状态栏旧内容（App.tsx:371-414 的 status 分支整块）与 `const jobs = status?.jobs ?? {}` / `const running = ...` 两行（若他处仍引用 running/jobs 则保留——typecheck 裁决）。替换为：

```tsx
        {status ? (
          <>
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
              {(['distill', 'dedup', 'judge'] as const).map((p) => {
                const act = status.llmActivity
                const active = act != null && phaseLabel(act.phase) === phaseLabel(p)
                return (
                  <span key={p} style={{ color: active ? '#1565c0' : '#999' }}>
                    {phaseLabel(p)}{' '}
                    <b>{active && act ? `进行中·${formatElapsed(Date.now() - act.since)}` : '空闲'}</b>
                  </span>
                )
              })}
              <button
                style={{ marginLeft: 'auto', fontSize: 12 }}
                onClick={() => setTab('messages')}
                title="查看消息"
              >
                🔔 {(status.unreadNotifications ?? 0) > 0 ? `${status.unreadNotifications} 未读` : '已读完'}
              </button>
            </div>
            {status.llmStats24h ? (
              <div style={{ marginTop: 6, color: '#666' }}>
                近24h 蒸馏 {formatPhaseStat(status.llmStats24h.distill.count, status.llmStats24h.distill.ms)}
                {' │ '}去重 {formatPhaseStat(status.llmStats24h.dedup.count, status.llmStats24h.dedup.ms)}
                {' │ '}审查 {formatPhaseStat(status.llmStats24h.judge.count, status.llmStats24h.judge.ms)}
              </div>
            ) : null}
          </>
        ) : error ? (
          <span style={{ color: '#c00' }}>连不上 daemon</span>
        ) : (
          <span>读取状态中…</span>
        )}
```

3f. 列表渲染区（`tab === 'runs' ? ... : (...)` 链）：在 settings 分支同层给 'messages' 一个占位分支，避免掉进 discards 兜底：

```tsx
      ) : tab === 'messages' ? (
        <p style={{ color: '#666' }}>消息列表加载中…</p>
```

（占位文案随意，Task 10 替换为真实列表。注意既有 JSX 分支顺序：确认 'messages' 分支插在兜底之前。）

3g. `listEmpty` 计算加 messages 分支（本任务暂以 `true` 占位亦可，Task 10 改真值；若 typecheck 无碍，直接写 `tab === 'messages' ? msgs.items.length === 0` 并把 msgs state 留到 Task 10——二选一以编译通过为准，推荐本任务先 `tab === 'messages' ? false : ...`）。

- [ ] **Step 4: 跑测试确认通过 + 全量门禁**

Run: `bun test tests/web-statusbar.test.ts tests/web-degradations.test.ts && bun run typecheck && bun test`
Expected: 全绿

- [ ] **Step 5: commit**

```bash
git add src/web/App.tsx tests/web-statusbar.test.ts tests/web-degradations.test.ts
git commit -m "feat(web): 状态栏重写——LLM 三阶段实况 + 24h 统计 + 消息入口"
```

---

### Task 10: App.tsx 消息 tab（列表 + 筛选 + 已读）

**Files:**
- Modify: `src/web/App.tsx`
- Modify: `tests/tab-cache.test.ts`（追加 isListTab('messages') 断言）
- Test: `tests/web-notifications.test.ts`（新建，源码层断言）

**Interfaces:**
- Consumes: Task 8 wrapper；Task 7 notificationTitle；Task 9 TabKey/'messages'。
- Produces: 完整消息列表视图（分页、3s 轮询、kind/未读/关键词筛选、点开已读、全部已读、空态）。

- [ ] **Step 1: 写失败测试**

`tests/web-notifications.test.ts`：

```ts
// 消息 tab 接线（spec 2026-08-12 §5.10）。源码层文本断言兜底。
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const appSrc = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')

test('消息 tab 数据流接线', () => {
  expect(appSrc).toContain('listNotificationsPage')
  expect(appSrc).toContain('markNotificationRead')
  expect(appSrc).toContain('markAllNotificationsRead')
  expect(appSrc).toContain('notificationTitle')
  expect(appSrc).toContain('全部已读')
  expect(appSrc).toContain('暂无消息')
})

test('消息筛选三件：kind 下拉 / 仅未读 / 关键词', () => {
  expect(appSrc).toContain("kind === 'degradation'")
  expect(appSrc).toContain("kind === 'llm_error'")
  expect(appSrc).toContain('unreadOnly')
})
```

追加到 `tests/tab-cache.test.ts`：

```ts
test('isListTab: messages 走列表数据流（spec 2026-08-12）', () => {
  expect(isListTab('messages')).toBe(true)
  expect(isListTab('settings')).toBe(false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/web-notifications.test.ts tests/tab-cache.test.ts`
Expected: FAIL

- [ ] **Step 3: App.tsx 实现**

3a. state（与 runs 并列）：

```tsx
  const [msgs, setMsgs] = useState<TabPage<NotificationItem>>(emptyPage())
  // 消息筛选（spec §5.10）：kind 空串 = 全部；unreadOnly；q 关键词（300ms debounce 后入此态）
  const [msgFilter, setMsgFilter] = useState<{ kind: string; unreadOnly: boolean; q: string }>({ kind: '', unreadOnly: false, q: '' })
  const msgFilterRef = useRef(msgFilter)
  useEffect(() => { msgFilterRef.current = msgFilter })
  const [qInput, setQInput] = useState('')
  const qTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
```

3b. `refresh` 加第三参 `msgOverride?`，runs 分支后插入：

```tsx
      } else if (target === 'messages') {
        const mf = msgOverride ?? msgFilterRef.current
        const [pg, st] = await Promise.all([
          listNotificationsPage(fetch, {
            limit: WEB_PAGE_SIZE,
            kind: mf.kind || undefined,
            unreadOnly: mf.unreadOnly,
            q: mf.q || undefined,
          }),
          getStatus(fetch),
        ])
        setMsgs((m) => ({ ...mergeRefreshPage(m, pg, (x) => x.id), total: pg.total ?? null }))
        setStatus(st)
```

3c. `loadMore` 同样插 messages 分支（带 before，用 msgFilterRef.current）。

3d. `tabPageOf` 加：`target === 'messages' ? msgs : ...`。

3e. `listEmpty` 的 messages 分支改真值：`tab === 'messages' ? msgs.items.length === 0 : ...`。

3f. 操作函数（放在 markAll/promote 附近）：

```tsx
  // 点开未读消息：本地乐观标已读 + 服务端 read + status 刷新（徽标即时归位）。
  // no-throw：read 失败靠 3s 轮询自愈（未读会重新出现，不静默吞状态）。
  function openMessage(id: string) {
    setExpandedId((cur) => (cur === id ? null : id))
    const n = msgs.items.find((x) => x.id === id)
    if (n && n.readAt === null) {
      setMsgs((m) => ({ ...m, items: m.items.map((x) => (x.id === id ? { ...x, readAt: Date.now() } : x)) }))
      void markNotificationRead(id).then(() => getStatus(fetch).then(setStatus)).catch(() => {})
    }
  }

  async function markAllRead() {
    setMsgs((m) => ({ ...m, items: m.items.map((x) => (x.readAt === null ? { ...x, readAt: Date.now() } : x)) }))
    await markAllNotificationsRead()
    void refresh('messages')
  }

  // 筛选变化：作废缓存重置页 1，立即按新筛选重拉（changeFilter 同构）。
  function changeMsgFilter(next: { kind: string; unreadOnly: boolean; q: string }) {
    setMsgFilter(next)
    setMsgs(emptyPage())
    void refresh('messages', undefined, next)
  }

  // 关键词输入 300ms debounce 后进筛选。
  function onQChange(v: string) {
    setQInput(v)
    if (qTimerRef.current) clearTimeout(qTimerRef.current)
    qTimerRef.current = setTimeout(() => changeMsgFilter({ ...msgFilterRef.current, q: v.trim() }), 300)
  }
```

3g. 替换 Task 9 的占位分支为完整视图：

```tsx
      ) : tab === 'messages' ? (
        <div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
            <select
              value={msgFilter.kind}
              onChange={(e) => changeMsgFilter({ ...msgFilter, kind: e.target.value })}
              style={{ fontSize: 13 }}
            >
              <option value="">全部类型</option>
              <option value="degradation">降级</option>
              <option value="llm_error">LLM错误</option>
            </select>
            <label style={{ fontSize: 13 }}>
              <input
                type="checkbox"
                checked={msgFilter.unreadOnly}
                onChange={(e) => changeMsgFilter({ ...msgFilter, unreadOnly: e.target.checked })}
              />{' '}
              仅未读
            </label>
            <input
              value={qInput}
              onChange={(e) => onQChange(e.target.value)}
              placeholder="搜索消息关键词…"
              style={{ fontSize: 13, padding: '4px 8px', minWidth: 180 }}
            />
            <button onClick={() => { void markAllRead() }} style={{ fontSize: 12, marginLeft: 'auto' }}>全部已读</button>
          </div>
          {msgFilter.kind !== '' || msgFilter.unreadOnly || msgFilter.q !== '' ? (
            <p style={{ color: '#666' }}>共 {msgs.total ?? msgs.items.length} 条消息符合当前筛选</p>
          ) : null}
          {msgs.items.map((n) => {
            const unread = n.readAt === null
            const expanded = expandedId === n.id
            const chipColor = n.kind === 'llm_error' ? '#c00' : '#e65100'
            const time = new Date(n.ts)
            const timeLabel = `${time.getMonth() + 1}/${time.getDate()} ${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
            return (
              <div
                key={n.id}
                onClick={() => openMessage(n.id)}
                style={{
                  border: '1px solid #e0e0e0', borderRadius: 8, padding: 12, marginBottom: 8,
                  background: unread ? '#fffdf0' : '#fff', cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                  {unread ? <span style={{ color: '#e65100' }}>●</span> : <span style={{ color: '#ccc' }}>○</span>}
                  <span style={{ ...CHIP_STYLE, color: chipColor, borderColor: chipColor }}>
                    {n.kind === 'llm_error' ? 'LLM错误' : '降级'}
                  </span>
                  <b>{notificationTitle(n)}</b>
                  <span style={{ marginLeft: 'auto', color: '#999', fontSize: 12 }}>{timeLabel}</span>
                </div>
                {n.body ? (
                  <div style={{ marginTop: 6, fontSize: 12, color: '#666', whiteSpace: expanded ? 'pre-wrap' : 'nowrap', overflow: 'hidden', textOverflow: expanded ? undefined : 'ellipsis' }}>
                    {n.body}
                  </div>
                ) : null}
              </div>
            )
          })}
          {msgs.items.length === 0 && !showLoading && (
            msgFilter.kind !== '' || msgFilter.unreadOnly || msgFilter.q !== '' ? (
              <p style={{ color: '#666' }}>没有匹配的消息</p>
            ) : (
              <p style={{ color: '#666' }}>暂无消息</p>
            )
          )}
        </div>
```

（列表尾部的 sentinel/加载更多/空态兜底由既有列表尾部结构统一承担——确认既有尾部 JSX 对 messages 不需特判：isListTab('messages') 为真即自动接入。）

- [ ] **Step 4: 跑测试确认通过 + 全量门禁**

Run: `bun test tests/web-notifications.test.ts tests/tab-cache.test.ts && bun run typecheck && bun test`
Expected: 全绿

- [ ] **Step 5: commit**

```bash
git add src/web/App.tsx tests/web-notifications.test.ts tests/tab-cache.test.ts
git commit -m "feat(web): 消息 tab——降级/LLM 报错收件箱（筛选/搜索/逐条已读/全部已读）"
```

---

### Task 11: 文档同步 + 终局验证

**Files:**
- Modify: `CLAUDE.md`（「Web UI 改动」节状态栏参照描述）
- Modify: `STATE.md`（追加本节落档）

**Interfaces:**
- Consumes: 全部前置任务已完成且全绿。

- [ ] **Step 1: CLAUDE.md 更新**

把「状态可见性」条款里的「参考 `GET /api/status` + 顶部状态栏（已捕获事件 / distill 进行中 / 记忆计数 / 最近错误）」改为：

> 参考 `GET /api/status` + 顶部状态栏（LLM 三阶段实况：蒸馏/去重/审查 进行中与耗时 + 近 24h 统计 + 未读消息入口；降级与 LLM 报错统一进「消息」tab，逐条已读 + 历史搜索）。

其余措辞（不得静默 stall 出空白页、fetch 失败显错误横幅）不动。

- [ ] **Step 2: STATE.md 追加段落**

在文件末尾追加「状态栏 LLM 实况 + 消息中心（2026-08-12）」一节，按既有段落风格记录：问题背景（状态栏噪音 + 消息不人性化）、方案要点（notifications 表双写 / ActivityTracker / runs 三耗时列 / 状态栏与消息 tab / ack 退役）、执行方式与测试结果、spec/plan 路径、deferred minor（由终审评审后回填，先留占位小标题）。

- [ ] **Step 3: 终局门禁**

Run: `bun run typecheck && bun test`
Expected: 全绿（记录测试总数，回填 STATE.md）

- [ ] **Step 4: commit**

```bash
git add CLAUDE.md STATE.md
git commit -m "docs: 状态栏 LLM 实况 + 消息中心落档（CLAUDE.md 参照同步 + STATE.md）"
```

---

## Self-Review 结果

1. **Spec 覆盖**：§5.1→Task 2；§5.2→Task 3；§5.3→Task 3；§5.4→Task 2/3/5；§5.5→Task 1；§5.6→Task 5；§5.7→Task 6；§5.8→Task 4；§5.9→Task 8；§5.10→Task 9/10；§5.11→Task 7；§5.12→Task 11；§7 失败模式由各任务的 try/finally、best-effort、optional 守卫实现；§8 测试清单逐条映射到各 Task 测试步骤（#1→T1，#2→T7，#3-7→T3，#8-12→T5，#13-16→T4，#17→T8，#18→T9/T10，#19→T10）。无遗漏。
2. **占位符扫描**：Task 4 Step 1 的 digest 回填示意行已显式标注「实现注记」给出真实替换方式（用 updateDistillRunDigestMs），非 TBD。
3. **类型一致性**：`NotificationRow`（store）/`NotificationItem`（web）字段逐一对应；`PhaseHandle.end()` 返回形状在 T1/T5 一致；`DistillRunRecord.dedupMs/judgeMs` 在 T3 定义、T5 使用；`TickDeps.tracker`/`AppDeps.tracker` 同名同类型（T1 ActivityTracker）。
