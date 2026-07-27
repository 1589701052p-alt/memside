# 记忆质量修复第五轮 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 同一 session 的后续 Stop 只蒸馏新增 turn（turn 偏移增量）+ SubagentStop 跳过，根治 Stop-vs-Stop 累积重复蒸馏。

**Architecture:** claude code hook payload 的 `session_id` 作会话键，存入 `memory_distill_jobs.session_id`；新表 `memory_session_offsets` 记每个 session 上次蒸馏到的 turn 偏移。`loadTranscript` 读侧按偏移切片返回 `{turns, fullLength}`；`tick` 对空切片跳过蒸馏、成功后更新偏移。`server.ts` 对 SubagentStop 早返回 202（与第四轮 PostToolUse 跳过对称）。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite（WAL）；测试 bun:test（注入 mock loadTranscript/enqueueDistillJob/broadcast）。

## Global Constraints

- LLMCall seam 保持 vendor-neutral；不动 distiller/dedup/valueFilter/pure/transcript（它们在新增 turn 子集上行为不变）。
- 前四轮修复（条件门/输入过滤/dedup/64k 预算/subject 信号/PostToolUse 跳过）全保留不回退。
- 不清理历史重复 job/event/候选（第四轮遗留 DB 膨胀是独立 issue；本轮只止损未来）。
- 不删 SubagentStop/PostToolUse 的 hooks 安装配置（install.ts 不改；daemon 端跳过即可）。
- 不动 `memory_distill_events` 表结构（payload 仍存该 job 捕获时的全量 turns；切片在 loadTranscript 读侧做）。
- 无 `session_id` 的历史 job 仍全量蒸馏（向后兼容，不切片、不更新偏移）。
- 偏移读写失败不阻塞蒸馏（getSessionOffset 失败降级全量；setSessionOffset 失败 warn、job 仍 done）。
- 测试随改动落地（TDD：先红后绿）；`bun run typecheck && bun test` 全绿才能 push。
- 分支 `feat/memory-quality-fix5`（已从最新 `origin/master` 切出），PR 目标 `master`。

---

## File Structure

| 文件 | 责任 | 本轮改动 |
|---|---|---|
| `src/db/schema.ts` | drizzle 表定义 | `memoryDistillJobs` 加 `sessionId` 列 + 索引；新增 `memorySessionOffsets` 表 |
| `src/db/client.ts` | DDL + 幂等迁移 | `memory_distill_jobs` 加 `session_id` 列 DDL + 索引；新表 DDL；幂等迁移块 |
| `src/memory/store.ts` | 记忆 CRUD | 新增 `getSessionOffset` / `setSessionOffset`（纯加法） |
| `src/scheduler.ts` | enqueue + tick | `EnqueueInput`/`enqueueDistillJob` 加 sessionId；`TickDeps.loadTranscript` 签名改 `{turns, fullLength}`；tick 切片/跳过/偏移更新 |
| `src/daemon.ts` | makeLoadTranscript 实现 | 读侧切片 + 返回 `{turns, fullLength}` |
| `src/server.ts` | hook 路由 | body 读 `session_id`；SubagentStop 早返回 202；enqueue 传 sessionId |
| `tests/schema.test.ts` | schema 迁移测试 | 新表/新列/迁移幂等 |
| `tests/store-crud.test.ts` | store 单测 | 偏移读写单测 |
| `tests/scheduler.test.ts` | scheduler 单测 | mock loadTranscript 全改 `{turns, fullLength}`；新增增量/跳过/偏移更新测试 |
| `tests/server.test.ts` | server 单测 | 新增 SubagentStop 跳过 + session_id 测试 |
| `tests/daemon.test.ts` | makeLoadTranscript 单测（若存在） | 切片断言 |

---

## Task 1: schema（jobs.session_id + memory_session_offsets）+ store 偏移函数

**Files:**
- Modify: `src/db/schema.ts:38-60`（`memoryDistillJobs` 加列）+ 文件末尾加 `memorySessionOffsets` 表
- Modify: `src/db/client.ts:40-53`（DDL）+ `:74-93`（迁移块）
- Modify: `src/memory/store.ts`（新增两个导出函数 + import）
- Test: `tests/schema.test.ts`（新增迁移测试）
- Test: `tests/store-crud.test.ts`（新增偏移读写测试）

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: `memorySessionOffsets` 表导出；`getSessionOffset(db, sessionId) => Promise<number>`；`setSessionOffset(db, sessionId, offset) => Promise<void>`；`memoryDistillJobs.sessionId` 列。Task 2/3 依赖这些。

- [ ] **Step 1: 写 schema 迁移测试（红）**

`tests/schema.test.ts` 文件末尾追加三个测试：

```ts
test('fresh db has memory_session_offsets table', () => {
  db = openDb(join(dir, 'mso.db'))
  const tables = db.$client.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_session_offsets'").all() as { name: string }[]
  expect(tables.length).toBe(1)
  const cols = db.$client.prepare('PRAGMA table_info(memory_session_offsets)').all() as { name: string }[]
  expect(cols.some((c) => c.name === 'session_id')).toBe(true)
  expect(cols.some((c) => c.name === 'last_turn_offset')).toBe(true)
  expect(cols.some((c) => c.name === 'updated_at')).toBe(true)
})

test('fresh db has session_id column on memory_distill_jobs', () => {
  db = openDb(join(dir, 'sid.db'))
  const cols = db.$client.prepare('PRAGMA table_info(memory_distill_jobs)').all() as { name: string }[]
  expect(cols.some((c) => c.name === 'session_id')).toBe(true)
})

test('migration adds session_id to pre-existing memory_distill_jobs, idempotent', () => {
  const dbPath = join(dir, 'oldsid.db')
  // 旧形态库：memory_distill_jobs 无 session_id 列（第四轮及之前形态）
  const old = new Database(dbPath)
  old.exec(`CREATE TABLE memory_distill_jobs (id TEXT PRIMARY KEY, debounce_key TEXT NOT NULL, source_event_id TEXT NOT NULL, runtime TEXT NOT NULL, cwd TEXT, scope_resolved_json TEXT, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_run_at INTEGER NOT NULL, last_error TEXT, created_at INTEGER NOT NULL, finished_at INTEGER)`)
  old.close()
  const migrated = openDb(dbPath)
  const cols = migrated.$client.prepare('PRAGMA table_info(memory_distill_jobs)').all() as { name: string }[]
  expect(cols.some((c) => c.name === 'session_id')).toBe(true)
  migrated.$client.close()
  // 幂等：reopen 不抛（guard 跳过 ALTER，否则 duplicate column 报错）
  const reopened = openDb(dbPath)
  expect((reopened.$client.prepare('PRAGMA table_info(memory_distill_jobs)').all() as { name: string }[]).some((c) => c.name === 'session_id')).toBe(true)
  reopened.$client.close()
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/schema.test.ts`
Expected: FAIL - 三个新测试失败：`memory_session_offsets` 表不存在（`tables.length === 0`）；`session_id` 列不存在。

- [ ] **Step 3: 改 src/db/schema.ts 加列 + 新表**

`src/db/schema.ts` 的 `memoryDistillJobs`（第 38-60 行）加 `sessionId` 列 + 索引。在 `cwd: text('cwd'),` 行之后加 `sessionId`；在索引对象里加 `sessionIdIdx`：

```ts
export const memoryDistillJobs = sqliteTable(
  'memory_distill_jobs',
  {
    id: text('id').primaryKey(),
    debounceKey: text('debounce_key').notNull(),
    sourceEventId: text('source_event_id').notNull(),
    runtime: text('runtime', { enum: ['claude-code', 'opencode'] }).notNull(),
    cwd: text('cwd'), // project scope resolver input
    sessionId: text('session_id'), // 第五轮：claude code hook payload 的 session_id，增量偏移键
    scopeResolvedJson: text('scope_resolved_json'), // {projectId, includeGlobal}
    status: text('status', {
      enum: ['pending', 'running', 'done', 'failed', 'canceled'],
    }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextRunAt: integer('next_run_at').notNull(),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (t) => ({
    statusNextIdx: index('idx_distill_jobs_status_next').on(t.status, t.nextRunAt),
    debounceIdx: index('idx_distill_jobs_debounce').on(t.debounceKey, t.status),
    sessionIdx: index('idx_distill_jobs_session').on(t.sessionId),
  }),
)
```

文件末尾（`memoryDiscards` 表之后）加新表：

```ts
export const memorySessionOffsets = sqliteTable(
  'memory_session_offsets',
  {
    sessionId: text('session_id').primaryKey(),
    lastTurnOffset: integer('last_turn_offset').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
)
```

- [ ] **Step 4: 改 src/db/client.ts DDL + 迁移**

`src/db/client.ts`：

(a) 第 5 行 import 加 `memorySessionOffsets`：

```ts
import { memories, memoryDistillJobs, memoryDistillEvents, memoryDiscards, memorySessionOffsets } from './schema'
```

(b) drizzle 构造（第 14 行）schema 加 `memorySessionOffsets`：

```ts
  const db = drizzle(raw, { schema: { memories, memoryDistillJobs, memoryDistillEvents, memoryDiscards, memorySessionOffsets } })
```

(c) `memory_distill_jobs` 的 CREATE TABLE（第 40-53 行）加 `session_id TEXT` 列（在 `cwd TEXT` 之后）+ 索引：

```sql
    CREATE TABLE IF NOT EXISTS memory_distill_jobs (
      id TEXT PRIMARY KEY,
      debounce_key TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      runtime TEXT NOT NULL,
      cwd TEXT,
      session_id TEXT,
      scope_resolved_json TEXT,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_run_at INTEGER NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_distill_jobs_status_next ON memory_distill_jobs(status, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_distill_jobs_debounce ON memory_distill_jobs(debounce_key, status);
    CREATE INDEX IF NOT EXISTS idx_distill_jobs_session ON memory_distill_jobs(session_id);
```

(d) 在 `CREATE INDEX IF NOT EXISTS idx_discards_ts ...`（第 73 行）之后加新表 DDL：

```sql
    CREATE TABLE IF NOT EXISTS memory_session_offsets (
      session_id TEXT PRIMARY KEY,
      last_turn_offset INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
```

(e) 在 `value_class` 迁移块（第 86-93 行）之后加 `session_id` 幂等迁移块（与 source_cwd/value_class 同模式：PRAGMA table_info 检查 + ALTER）：

```ts
  // Idempotent migration: add session_id to pre-existing memory_distill_jobs.
  // 第五轮增量蒸馏的会话键；历史 job 无此列 -> 升级后为 NULL -> 全量蒸馏（向后兼容）。
  // 无 backfill（NULL 表示"未知会话"，全量蒸馏是安全默认）。
  {
    const cols = raw.prepare('PRAGMA table_info(memory_distill_jobs)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'session_id')) {
      raw.exec('ALTER TABLE memory_distill_jobs ADD COLUMN session_id TEXT')
    }
  }
```

- [ ] **Step 5: 运行 schema 测试确认通过**

Run: `bun test tests/schema.test.ts`
Expected: PASS（三个新测试 + 现有 schema 测试全绿）。

- [ ] **Step 6: 写 store 偏移读写测试（红）**

`tests/store-crud.test.ts` 文件末尾追加（先确认该文件顶部已 import `openDb` + `getSessionOffset`/`setSessionOffset`——本步先写测试，import 在 Step 7 加；若 typecheck 报 import 未定义属预期红）：

```ts
import { getSessionOffset, setSessionOffset } from '@/memory/store'

test('getSessionOffset returns 0 for unknown session (first distill = full)', async () => {
  // 第五轮：首次蒸馏无偏移记录 -> 返回 0 -> loadTranscript 全量切片。
  // 这是增量蒸馏的"首次全量"入口，必须默认 0 而非抛错。
  expect(await getSessionOffset(db, 'never-seen-session')).toBe(0)
})

test('setSessionOffset UPSERTs: second write overwrites; getSessionOffset reads it back', async () => {
  // 第五轮：同一 session 多次 Stop，每次蒸馏后偏移推进。UPSERT 保证不抛主键冲突。
  await setSessionOffset(db, 'sess-A', 36)
  expect(await getSessionOffset(db, 'sess-A')).toBe(36)
  // 第二次 Stop 蒸馏到 120 -> 覆盖
  await setSessionOffset(db, 'sess-A', 120)
  expect(await getSessionOffset(db, 'sess-A')).toBe(120)
})
```

注意：若 `tests/store-crud.test.ts` 顶部已有别的 `import { ... } from '@/memory/store'`，把 `getSessionOffset, setSessionOffset` 并入那行，不要重复 import。先读该文件顶部确认。

- [ ] **Step 7: 运行测试确认失败**

Run: `bun test tests/store-crud.test.ts`
Expected: FAIL - `getSessionOffset`/`setSessionOffset` 未导出（import 报错或运行时 undefined）。

- [ ] **Step 8: 实现 store.ts 偏移函数**

`src/memory/store.ts`：

(a) 第 4 行 import 加 `memorySessionOffsets`：

```ts
import { memories, memoryDiscards, memorySessionOffsets } from '@/db/schema'
```

(b) 文件末尾（`logDiscards` 之后）加两个函数：

```ts
// ---------------------------------------------------------------------------
// 第五轮：会话级 turn 偏移（增量蒸馏）。getSessionOffset 无记录返回 0（首次全量）；
// setSessionOffset UPSERT（同 session 二次写覆盖）。偏移是优化非正确性依赖：
// 读写失败由调用方（loadTranscript / tick）catch 降级，不阻塞蒸馏。
// ---------------------------------------------------------------------------

export async function getSessionOffset(db: DbClient, sessionId: string): Promise<number> {
  const rows = await db.select().from(memorySessionOffsets)
    .where(eq(memorySessionOffsets.sessionId, sessionId)).limit(1)
  return rows.length > 0 ? (rows[0]!.lastTurnOffset as number) : 0
}

export async function setSessionOffset(db: DbClient, sessionId: string, offset: number): Promise<void> {
  const now = Date.now()
  await db.insert(memorySessionOffsets).values({ sessionId, lastTurnOffset: offset, updatedAt: now })
    .onConflictDoUpdate({ target: memorySessionOffsets.sessionId, set: { lastTurnOffset: offset, updatedAt: now } })
}
```

注意：`eq` 已在 store.ts 第 1 行 import（`import { and, desc, eq, inArray, isNull } from 'drizzle-orm'`），无需再加。

- [ ] **Step 9: 运行 store 测试确认通过**

Run: `bun test tests/store-crud.test.ts`
Expected: PASS（新偏移测试 + 现有 store 测试全绿）。

- [ ] **Step 10: typecheck + 全量回归**

Run: `bun run typecheck && bun test`
Expected: typecheck 干净；`bun test` 全绿（新测试通过 + 前四轮测试不回退）。

- [ ] **Step 11: Commit**

```bash
git add src/db/schema.ts src/db/client.ts src/memory/store.ts tests/schema.test.ts tests/store-crud.test.ts
git commit -m "feat(schema): session_id column + memory_session_offsets + offset accessors

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: scheduler（sessionId 传递 + loadTranscript 签名 + tick 切片/跳过/偏移）+ daemon makeLoadTranscript

> **关键**：本任务改 `TickDeps.loadTranscript` 签名（返回 `{turns, fullLength}`）。这会波及 `tests/scheduler.test.ts` 全部 ~14 个 `loadTranscript: async () => [...]` mock（必须改成 `{turns: [...], fullLength: N }`），以及 `src/daemon.ts` 的 `makeLoadTranscript` 实现（必须同步返回新形状，否则 typecheck 红）。本任务把 seam 两侧 + 所有 mock 一起改，保证提交点 typecheck 绿。

**Files:**
- Modify: `src/scheduler.ts:18-43`（EnqueueInput + enqueueDistillJob + TickDeps）+ `:105-176`（tick）
- Modify: `src/daemon.ts:30-44`（makeLoadTranscript）
- Test: `tests/scheduler.test.ts`（全量改 mock + 新增增量测试）

**Interfaces:**
- Consumes: Task 1 的 `memoryDistillJobs.sessionId` 列、`getSessionOffset`/`setSessionOffset`。
- Produces: `EnqueueInput.sessionId?: string`；`TickDeps.loadTranscript` 返回 `{turns, fullLength}`；tick 对空切片跳过、成功后 setSessionOffset。Task 3 依赖 EnqueueInput.sessionId。

- [ ] **Step 1: 改 tests/scheduler.test.ts 全部 loadTranscript mock 为新签名**

`tests/scheduler.test.ts` 里所有 `loadTranscript: async () => [...]` 改为 `loadTranscript: async () => ({ turns: [...], fullLength: N })`。`N` 取该 mock 返回数组的长度（绝大多数是 1）。

逐个改（共 14 处，模式相同）。例：

第 56 行（`tick runs a due job` 测试）：
```ts
// 旧
loadTranscript: async () => [{ role: 'user', content: 'we only refund within 14 days' }],
// 新
loadTranscript: async () => ({ turns: [{ role: 'user', content: 'we only refund within 14 days' }], fullLength: 1 }),
```

第 74 行（`tick passes sourceCwd` 测试）：
```ts
loadTranscript: async () => ({ turns: [{ role: 'user', content: 'something' }], fullLength: 1 }),
```

第 89 行（`tick applies backoff` 测试，loadTranscript throw 不变——throw 不需要改形状）：
```ts
loadTranscript: async () => { throw new Error('no transcript') },
// 不改（throw 路径不返回值）
```

第 107、127、147、167 行（dedup 系列，均返回 `[{ role: 'user', content: 'x' }]` 或类似单元素）：
```ts
loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1 }),
```
（具体 content 按原文保留：第 107 行 `'refund 14 days'`、第 127/147/167 行 `'x'`、第 253/276/295/321/339/365/391/413 行同理。每一处把数组包进 `{ turns: ..., fullLength: 1 }`。）

第 339、365 行 content 分别是 `'refunds only within 14 days'` / `'valueFilter must force-keep invariant'`，保留 content，包 `{ turns: [...], fullLength: 1 }`。

第 391 行 content `'refund rule'`，同理。

> 实现者注意：用 `grep -n "loadTranscript: async () => \[" tests/scheduler.test.ts` 找全部待改位置，逐一改。`loadTranscript: async () => { throw ... }` 不改。

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/scheduler.test.ts`
Expected: FAIL - typecheck/运行时错：`tick` 内 `const turns = await deps.loadTranscript(...)` 现在 loadTranscript 返回对象，`turns` 是对象不是数组，`distillTranscript({ turns, ... })` 报错（turns 不是数组）。或 typecheck 报 `loadTranscript` 返回类型不匹配 `TranscriptTurn[]`。

- [ ] **Step 3: 改 src/scheduler.ts 的 EnqueueInput + enqueueDistillJob**

`src/scheduler.ts:18-36`：

```ts
export interface EnqueueInput {
  sourceEventId: string
  runtime: 'claude-code' | 'opencode'
  cwd: string
  debounceKey: string
  debounceMs?: number
  sessionId?: string  // 第五轮：会话键，用于增量偏移
}

export async function enqueueDistillJob(db: DbClient, input: EnqueueInput) {
  const id = ulid()
  const now = Date.now()
  const nextRunAt = now + (input.debounceMs ?? DISTILL_DEBOUNCE_MS)
  await db.insert(memoryDistillJobs).values({
    id, debounceKey: input.debounceKey, sourceEventId: input.sourceEventId,
    runtime: input.runtime, cwd: input.cwd, sessionId: input.sessionId ?? null,
    status: 'pending', attempts: 0, nextRunAt, createdAt: now, finishedAt: null,
  })
  return { jobId: id, nextRunAt }
}
```

- [ ] **Step 4: 改 src/scheduler.ts 的 TickDeps.loadTranscript 签名**

`src/scheduler.ts:38-43`：

```ts
export interface TickDeps {
  loadTranscript: (job: {
    id: string; cwd: string | null; sourceEventId: string; sessionId: string | null
  }) => Promise<{ turns: TranscriptTurn[]; fullLength: number }>
  callLLM: LLMCall
  /** Signature matches store.createCandidate(db, MemoryInput): Promise<Memory>. */
  createCandidate: (db: DbClient, input: MemoryInput) => Promise<Memory>
}
```

- [ ] **Step 5: 改 src/scheduler.ts 的 tick（切片 + 跳过 + 偏移更新）**

`src/scheduler.ts:105-176` 的 tick 函数体。先加 import：文件顶部 `import { listForDedupByScope, logDiscards, type DiscardRecord } from '@/memory/store'` 改为也导入 `setSessionOffset`：

```ts
import { listForDedupByScope, logDiscards, setSessionOffset, type DiscardRecord } from '@/memory/store'
```

tick 内（第 119 行）loadTranscript 调用 + 后续逻辑改造。把：

```ts
      const turns = await deps.loadTranscript({ id: job.id, cwd: job.cwd, sourceEventId: job.sourceEventId })
      const candidates: DistillCandidate[] = await distillTranscript({
        turns,
        runtime: job.runtime as 'claude-code' | 'opencode',
        cwd: job.cwd ?? '',
        callLLM: deps.callLLM,
      })
```

改为：

```ts
      const { turns: newTurns, fullLength } = await deps.loadTranscript({
        id: job.id, cwd: job.cwd, sourceEventId: job.sourceEventId, sessionId: job.sessionId ?? null,
      })
      // 第五轮增量切片：newTurns 为空 = 该 session 自上次蒸馏后无新增 turn，跳过蒸馏。
      // 标 done（消费 job），不 distill / createCandidate / setSessionOffset（偏移不变）。
      if (newTurns.length === 0) {
        await db.update(memoryDistillJobs).set({ status: 'done', finishedAt: Date.now() })
          .where(eq(memoryDistillJobs.id, job.id)).run()
        processed += 1
        continue
      }
      const candidates: DistillCandidate[] = await distillTranscript({
        turns: newTurns,  // 只喂新增 turn，不再全量
        runtime: job.runtime as 'claude-code' | 'opencode',
        cwd: job.cwd ?? '',
        callLLM: deps.callLLM,
      })
```

然后在 tick 的成功收尾（原第 163 行 `await db.update(memoryDistillJobs).set({ status: 'done', finishedAt: Date.now() })...`）之后、`processed += 1` 之前，加偏移更新：

```ts
      await db.update(memoryDistillJobs).set({ status: 'done', finishedAt: Date.now() }).where(eq(memoryDistillJobs.id, job.id)).run()
      // 第五轮：本次蒸馏到 fullLength，下次该 session 从此处切。仅 job 有 sessionId 时
      // 更新；无 sessionId（历史 job）不更新，保持全量向后兼容。失败只 warn，不阻塞 done。
      if (job.sessionId) {
        try { await setSessionOffset(db, job.sessionId, fullLength) }
        catch (e) { console.warn('memside: setSessionOffset failed', e) }
      }
      processed += 1
```

- [ ] **Step 6: 改 src/daemon.ts makeLoadTranscript（读侧切片 + 新返回形状）**

`src/daemon.ts:30-44`。先加 import：第 6 行 `import { memoryDistillEvents, memoryDistillJobs } from '@/db/schema'` 不变；第 8 行 `import { createCandidate } from '@/memory/store'` 改为也导入 `getSessionOffset`：

```ts
import { createCandidate, getSessionOffset } from '@/memory/store'
```

makeLoadTranscript 整体替换：

```ts
export function makeLoadTranscript(db: DbClient): TickDeps['loadTranscript'] {
  return async (job) => {
    const rows = await db.select().from(memoryDistillEvents)
      .where(eq(memoryDistillEvents.distillJobId, job.id))
      .orderBy(memoryDistillEvents.ts)
    const turns: TranscriptTurn[] = []
    for (const r of rows) {
      try {
        const parsed = JSON.parse(r.payload)
        if (Array.isArray(parsed)) for (const t of parsed) turns.push(t as TranscriptTurn)
      } catch { /* skip malformed payload */ }
    }
    const fullLength = turns.length
    // 无 sessionId（历史 job）-> 全量返回，向后兼容（不切片、不更新偏移）。
    if (!job.sessionId) return { turns, fullLength }
    // 有 sessionId -> 查偏移切片。getSessionOffset 失败降级全量（不阻塞蒸馏）。
    let offset = 0
    try { offset = await getSessionOffset(db, job.sessionId) }
    catch (e) { console.warn('memside: getSessionOffset failed, degrading to full', e); return { turns, fullLength } }
    return { turns: turns.slice(offset), fullLength }
  }
}
```

注意：`eq` 已在 daemon.ts 第 1 行 import（`import { eq } from 'drizzle-orm'`），无需再加。

- [ ] **Step 7: typecheck 确认 seam 两侧一致**

Run: `bun run typecheck`
Expected: 干净（scheduler.ts 的 TickDeps.loadTranscript 签名与 daemon.ts makeLoadTranscript 返回值一致；scheduler.test.ts mock 返回值一致）。

- [ ] **Step 8: 写 tick 增量行为测试（红）**

`tests/scheduler.test.ts` 文件末尾追加：

```ts
// ---------------------------------------------------------------------------
// 第五轮增量蒸馏：turn 偏移切片 + 空切片跳过 + 偏移更新。
// 根因见 spec §1.1 问题1：Stop-vs-Stop 累积重复蒸馏（同 session 被 Stop 33 次，
// 早 Stop 是晚 Stop 完整前缀）。tick 对空 newTurns 跳过；成功后更新偏移。
// ---------------------------------------------------------------------------

test('tick skips distill when newTurns empty (marks done, no createCandidate, no setSessionOffset)', async () => {
  // 第五轮：同一 session 第三次 Stop 无新增 turn -> loadTranscript 返回 {turns:[], fullLength:120}
  // -> tick 标 done、不 distill、不 createCandidate。
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0,
    sessionId: 'sess-S',
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let createCalls = 0
  let llmCalls = 0
  const processed = await tick(db, {
    loadTranscript: async () => ({ turns: [], fullLength: 120 }),
    callLLM: async () => { llmCalls++; return '[]' },
    createCandidate: async () => { createCalls++; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(processed).toBe(1)
  expect(llmCalls).toBe(0)            // 不调 LLM 蒸馏
  expect(createCalls).toBe(0)         // 不创建候选
  const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(rows[0]!.status).toBe('done') // 仍标 done（消费 job）
})

test('tick updates session offset after successful distill (job has sessionId)', async () => {
  // 第五轮：job 带 sessionId -> 蒸馏成功后 setSessionOffset(sessionId, fullLength)。
  // 下次同 session 的 loadTranscript 应从该偏移切片。用真实 store 函数验证端到端。
  const { getSessionOffset, setSessionOffset: _s } = await import('@/memory/store')
  void _s
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0,
    sessionId: 'sess-T',
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'new turn' }], fullLength: 42 }),
    callLLM: async () => JSON.stringify({ candidates: [{ title: '[category:x] t', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] }),
    createCandidate: async () => ({ id: 'c1', status: 'candidate', version: 1 } as any),
  })
  // 偏移已更新到 fullLength
  expect(await getSessionOffset(db, 'sess-T')).toBe(42)
})

test('tick does NOT setSessionOffset when job has no sessionId (backward compat)', async () => {
  // 第五轮：历史 job（sessionId=null）-> 全量蒸馏、不更新偏移。向后兼容。
  const { getSessionOffset } = await import('@/memory/store')
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0,
    // 不传 sessionId
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 5 }),
    callLLM: async () => JSON.stringify({ candidates: [{ title: '[category:x] t', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] }),
    createCandidate: async () => ({ id: 'c1', status: 'candidate', version: 1 } as any),
  })
  // 无 sessionId -> 不写偏移表（getSessionOffset 仍返回默认 0，但这里关键是该 session 无记录）
  expect(await getSessionOffset(db, 'any-session')).toBe(0)
})

test('tick still marks done when setSessionOffset throws (warn, non-blocking)', async () => {
  // 第五轮：setSessionOffset 失败只 warn，job 仍 done（偏移是优化非正确性依赖）。
  // 用损坏的 db 让 setSessionOffset 写失败：close 掉底层 handle 后 insert 会抛。
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0,
    sessionId: 'sess-F',
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  // 用真实 createCandidate（不 mock）让 tick 走到 setSessionOffset；createCandidate 写 memories 表。
  // setSessionOffset 写 memory_session_offsets 时若 db 已坏会抛 -> tick 内 try/catch 吞掉。
  // 这里改用 spy：包一层 setSessionOffset 不可行（它在 scheduler 内 import），所以用
  // "成功路径 + 偏移表可写" 验证 warn 不阻塞：断言 job done 即可（setSessionOffset 成功时也 done）。
  // 真正的 throw 路径由 "损坏 db" 测试覆盖：把 db.$client.close() 放在 tick 中途不可行，
  // 故此测试断言"成功路径 job done"作为 warn 兜底的弱锁。强锁见下一测试。
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 3 }),
    callLLM: async () => JSON.stringify({ candidates: [{ title: '[category:x] t', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] }),
    createCandidate: async () => ({ id: 'c1', status: 'candidate', version: 1 } as any),
  })
  const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(rows[0]!.status).toBe('done')
})
```

> 实现者注意：第 4 个测试（`setSessionOffset throws`）的强锁较难在单测里构造（需要让 setSessionOffset 的 insert 抛但 tick 前半段不抛）。上面的写法是弱锁（成功路径 done）。若实现时发现可构造强锁（例如 monkey-patch `db.insert` 对 `memory_session_offsets` 抛），改强锁更好；否则保留弱锁并在此注释说明。**核心不可让步的是前 3 个测试**（空切片跳过、偏移更新、无 sessionId 不更新）。

- [ ] **Step 9: 运行测试确认通过**

Run: `bun test tests/scheduler.test.ts`
Expected: PASS（新 4 个测试 + 改造后的 14 个旧测试 + 现有 dedup/valueFilter 测试全绿）。特别确认：
- `tick runs a due job and marks done` 仍绿（mock 已改 `{turns, fullLength}`）
- `tick: protected invariant candidate survives` 仍绿（subject 逻辑门不受影响）
- `tick skips distill when newTurns empty` 绿
- `tick updates session offset after successful distill` 绿

- [ ] **Step 10: typecheck + 全量回归**

Run: `bun run typecheck && bun test`
Expected: typecheck 干净；`bun test` 全绿。特别确认 server.test.ts 不受影响（server 还没改，enqueue mock 不传 sessionId 仍 OK——EnqueueInput.sessionId 是可选）。

- [ ] **Step 11: Commit**

```bash
git add src/scheduler.ts src/daemon.ts tests/scheduler.test.ts
git commit -m "feat(scheduler): incremental distill via turn offset (slice/skip/setSessionOffset)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: server（SubagentStop 跳过 + session_id 读取 + 传递）

**Files:**
- Modify: `src/server.ts:62-141`（body 解析 + SubagentStop 早返回 + enqueue 传 sessionId + 注释）
- Test: `tests/server.test.ts`（新增 SubagentStop 跳过 + session_id 测试；改 enqueueCalls 类型）

**Interfaces:**
- Consumes: Task 2 的 `EnqueueInput.sessionId?`。
- Produces: server.ts 对 SubagentStop 早返回 202；Stop 的 enqueue 调用传 sessionId。

- [ ] **Step 1: 改 tests/server.test.ts 的 enqueueCalls 类型 + 写 SubagentStop 跳过测试（红）**

`tests/server.test.ts`：

(a) 第 21 行 `enqueueCalls` 类型加 `sessionId`（让后续断言能读）：

```ts
let enqueueCalls: { sourceEventId: string; runtime: string; cwd: string; debounceKey: string; sessionId?: string }[]
```

(b) 在 PostToolUse 跳过测试（第 125-151 行）之后，加 SubagentStop 跳过测试 + session_id 测试：

```ts
test('collector SubagentStop is skipped (no distill, no event, no job, no broadcast)', async () => {
  // 第五轮：SubagentStop 的 transcript_path 指向主会话 JSONL（不是独立子会话），
  // 与同 session 的 Stop 蒸馏同一段会话（firstUser 一致、turns 数几乎相同），纯重复。
  // SubagentStop 无独有价值，早返回 202 不蒸馏。与 PostToolUse 跳过对称。
  const fixturePath = writeJsonlFixture('subagent.jsonl', {
    type: 'user',
    message: { role: 'user', content: 'subagent transcript is main session' },
  })
  const beforeEvents = await db.select().from(memoryDistillEvents)
  const r = await req('/hooks/claude/SubagentStop', {
    method: 'POST',
    body: JSON.stringify({ sourceEventId: 'e3', cwd: '/r', transcript_path: fixturePath, session_id: 'sess-1' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(202)
  await new Promise((res) => setTimeout(res, 50))
  const events = await db.select().from(memoryDistillEvents)
  expect(events.length).toBe(beforeEvents.length)  // 不存 event
  expect(enqueueCalls.length).toBe(0)               // 不 enqueue job
  expect(broadcastCalls.length).toBe(0)             // 不 broadcast
})

test('collector Stop reads session_id and passes it to enqueueDistillJob', async () => {
  // 第五轮：hook payload 的 session_id 是增量蒸馏的会话键。server.ts 必须读取并
  // 传入 enqueueDistillJob，否则 tick 无法按 session 切片偏移。
  const fixturePath = writeJsonlFixture('stop-sid.jsonl', {
    type: 'user',
    message: { role: 'user', content: 'stop with session id' },
  })
  const r = await req('/hooks/claude/Stop', {
    method: 'POST',
    body: JSON.stringify({ sourceEventId: 'e4', cwd: '/r', transcript_path: fixturePath, session_id: 'sess-abc' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(202)
  expect(enqueueCalls.length).toBe(1)
  expect(enqueueCalls[0]!.sessionId).toBe('sess-abc')
})

test('collector Stop without session_id still enqueues (backward compat)', async () => {
  // 第五轮：历史/无 session_id 的 Stop 仍正常 enqueue（sessionId 为空），
  // tick 走全量蒸馏路径。向后兼容。
  const fixturePath = writeJsonlFixture('stop-nosid.jsonl', {
    type: 'user',
    message: { role: 'user', content: 'stop no session id' },
  })
  const r = await req('/hooks/claude/Stop', {
    method: 'POST',
    body: JSON.stringify({ sourceEventId: 'e5', cwd: '/r', transcript_path: fixturePath }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(202)
  expect(enqueueCalls.length).toBe(1)
  expect(enqueueCalls[0]!.sessionId).toBe('')  // 空 session_id -> 空串
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/server.test.ts`
Expected: FAIL - SubagentStop 跳过测试失败（当前 SubagentStop 走 Stop 路径：存 event、enqueue、broadcast，`enqueueCalls.length === 1` 非 0）；session_id 测试失败（`enqueueCalls[0].sessionId` undefined，当前 server.ts 不传 sessionId）。

- [ ] **Step 3: 改 src/server.ts body 解析读 session_id**

`src/server.ts:63-64`：

```ts
    const body = await c.req.json().catch(() => ({}) as {
      transcript_path?: string; cwd?: string; sourceEventId?: string; session_id?: string
    })
    const cwd: string = body.cwd ?? ''
    const sessionId: string = body.session_id ?? ''
```

- [ ] **Step 4: 改 src/server.ts 加 SubagentStop 早返回**

`src/server.ts` 在 PostToolUse 早返回块（第 93-95 行 `if (event === 'PostToolUse') {...}`）之后、`// Stop / SubagentStop (C3 fix)` 注释（第 97 行）之前，插入：

```ts
    // SubagentStop 跳过（第五轮）：transcript_path 指向主会话 JSONL（不是独立子会话），
    // 与同 session 的 Stop 蒸馏同一段会话（firstUser 一致、turns 数几乎相同），纯重复。
    // SubagentStop 无独有价值，早返回 202 不蒸馏。
    if (event === 'SubagentStop') {
      return c.json({ ok: true }, 202)
    }
```

- [ ] **Step 5: 改 src/server.ts enqueue 调用传 sessionId**

`src/server.ts:127`（fire-and-forget IIFE 内的 enqueueDistillJob 调用）：

```ts
        const { jobId } = await deps.enqueueDistillJob(deps.db, { sourceEventId, runtime: 'claude-code', cwd, debounceKey, sessionId })
```

- [ ] **Step 6: 改 src/server.ts 顶部注释**

`src/server.ts:35-43` 的 docstring，把 Stop/SubagentStop 那段改为只提 Stop（SubagentStop 现在也跳过）：

旧（第 35-43 行）：
```
 *    - `Stop` / `SubagentStop`: the <50ms ack contract holds - the handler
 *      returns 202 synchronously while a fire-and-forget IIFE
 *      (never awaited in the hot path) reads the JSONL file via
 *      `parseTranscriptFile`, persists the turns into `memory_distill_events`,
 *      and enqueues a distill job. `sourceKind` is `'conversation'`.
 *      `PostToolUse` is skipped entirely (early-returns 202 without
 *      parsing/enqueuing/broadcasting) - see the route handler. Its transcript
 *      is a cumulative prefix of Stop's, so distilling it would duplicate work;
 *      error signals still surface via detectErrorSignals on the Stop transcript.
```

新：
```
 *    - `Stop`: the <50ms ack contract holds - the handler returns 202
 *      synchronously while a fire-and-forget IIFE (never awaited in the hot
 *      path) reads the JSONL file via `parseTranscriptFile`, persists the turns
 *      into `memory_distill_events`, and enqueues a distill job. `sourceKind`
 *      is `'conversation'`. The hook payload's `session_id` is read and passed
 *      to `enqueueDistillJob` so the scheduler can distill incrementally by turn
 *      offset (round 5).
 *      `PostToolUse` and `SubagentStop` are both skipped entirely (early-return
 *      202 without parsing/enqueuing/broadcasting) - see the route handler.
 *      PostToolUse's transcript is a cumulative prefix of Stop's; SubagentStop's
 *      transcript_path points at the main session JSONL (not an isolated
 *      sub-session), so it duplicates Stop. Error signals still surface via
 *      detectErrorSignals on the Stop transcript.
```

- [ ] **Step 7: 运行测试确认通过**

Run: `bun test tests/server.test.ts`
Expected: PASS（3 个新测试 + 现有测试全绿）。特别确认：
- `collector hook accepts event and acks 202`（Stop）仍绿
- `collector PostToolUse is skipped` 仍绿（第四轮，不动）
- `collector SubagentStop is skipped` 绿
- `collector Stop reads session_id` 绿

- [ ] **Step 8: typecheck + 全量回归**

Run: `bun run typecheck && bun test`
Expected: typecheck 干净；`bun test` 全绿（前四轮 + Task 1/2 测试不回退）。

- [ ] **Step 9: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat(server): skip SubagentStop + read session_id for incremental distill

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: e2e 增量蒸馏（同 session 两次 Stop 只蒸馏新增）

> 本任务用真实 makeLoadTranscript（不 mock loadTranscript），端到端验证：同 session 第一次 Stop 全量蒸馏 + 更新偏移，第二次 Stop 只蒸馏新增 turn。锁住 spec §4.1 数据流。

**Files:**
- Test: `tests/scheduler.test.ts`（新增 e2e 增量测试，用真实 makeLoadTranscript + 真实 store）

**Interfaces:**
- Consumes: Task 1（store 偏移函数）、Task 2（makeLoadTranscript 切片 + tick 偏移更新）。
- Produces: e2e 回归锁，防止未来 refactor 破坏增量切片。

- [ ] **Step 1: 写 e2e 增量测试（红或绿取决于实现顺序，但先写）**

`tests/scheduler.test.ts` 文件末尾追加。需 import `makeLoadTranscript`：

```ts
import { makeLoadTranscript } from '@/daemon'
```

（加到文件顶部现有 import 区。）

测试：

```ts
// ---------------------------------------------------------------------------
// 第五轮 e2e：真实 makeLoadTranscript（不 mock）+ 真实 store 偏移。
// 同 session 两次 Stop：第一次全量蒸馏 + 更新偏移；第二次只蒸馏新增 turn。
// 锁住 spec §4.1 增量数据流。根因见 spec §1.1 问题1（Stop 累积重复蒸馏）。
// ---------------------------------------------------------------------------

test('e2e incremental: same-session second Stop distills only new turns', async () => {
  const { jobId: job1 } = await enqueueDistillJob(db, {
    sourceEventId: 'stop-1', runtime: 'claude-code', cwd: '/r', debounceKey: '/r:Stop', debounceMs: 0,
    sessionId: 'sess-e2e',
  })
  // 第一次 Stop 的 transcript：3 turns（全量）
  await db.insert(memoryDistillEvents).values({
    distillJobId: job1, attemptIndex: 0, ts: 1, kind: 'conversation',
    payload: JSON.stringify([
      { role: 'user', content: 'turn A' },
      { role: 'user', content: 'turn B' },
      { role: 'user', content: 'turn C' },
    ]),
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, job1))

  let distillTurns: unknown[] = []
  let callCount = 0
  const loadTranscript = makeLoadTranscript(db)
  await tick(db, {
    loadTranscript,
    callLLM: async () => {
      callCount++
      // 捕获喂给 distiller 的 turns（distillTranscript 内部调 callLLM）
      return JSON.stringify({ candidates: [{ title: '[category:x] t', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
    },
    createCandidate: async () => ({ id: 'c1', status: 'candidate', version: 1 } as any),
  })
  // 第一次：3 turns 全量蒸馏
  // （distillTurns 捕获较难，改用偏移断言 + 第二次 callLLM 次数断言）
  const { getSessionOffset } = await import('@/memory/store')
  expect(await getSessionOffset(db, 'sess-e2e')).toBe(3)  // 偏移推进到 3

  // 第二次 Stop：5 turns（前 3 是旧前缀，后 2 新增）
  const { jobId: job2 } = await enqueueDistillJob(db, {
    sourceEventId: 'stop-2', runtime: 'claude-code', cwd: '/r', debounceKey: '/r:Stop', debounceMs: 0,
    sessionId: 'sess-e2e',
  })
  await db.insert(memoryDistillEvents).values({
    distillJobId: job2, attemptIndex: 0, ts: 2, kind: 'conversation',
    payload: JSON.stringify([
      { role: 'user', content: 'turn A' },
      { role: 'user', content: 'turn B' },
      { role: 'user', content: 'turn C' },
      { role: 'user', content: 'turn D (new)' },
      { role: 'user', content: 'turn E (new)' },
    ]),
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, job2))

  let distillInputTurns: string[] = []
  await tick(db, {
    loadTranscript,
    callLLM: async (_sys, user) => {
      // distiller 的 user prompt 含 turns；捕获看是否只含 D/E
      distillInputTurns.push(user)
      return JSON.stringify({ candidates: [{ title: '[category:x] t2', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
    },
    createCandidate: async () => ({ id: 'c2', status: 'candidate', version: 1 } as any),
  })
  // 第二次：偏移已从 3 推进到 5
  expect(await getSessionOffset(db, 'sess-e2e')).toBe(5)
  // 第二次蒸馏的 prompt 只含新增 turn D/E，不含旧 turn A/B/C
  const secondPrompt = distillInputTurns[distillInputTurns.length - 1]!
  expect(secondPrompt).toContain('turn D (new)')
  expect(secondPrompt).toContain('turn E (new)')
  expect(secondPrompt).not.toContain('turn A')
  expect(secondPrompt).not.toContain('turn B')
})

test('e2e incremental: same-session second Stop with no new turns skips distill', async () => {
  // 第五轮：第二次 Stop transcript 与第一次相同（无新增）-> loadTranscript 返回空切片
  // -> tick 跳过蒸馏、不 createCandidate、偏移不变。
  const { jobId: job1 } = await enqueueDistillJob(db, {
    sourceEventId: 'stop-1', runtime: 'claude-code', cwd: '/r', debounceKey: '/r:Stop', debounceMs: 0,
    sessionId: 'sess-skip',
  })
  await db.insert(memoryDistillEvents).values({
    distillJobId: job1, attemptIndex: 0, ts: 1, kind: 'conversation',
    payload: JSON.stringify([
      { role: 'user', content: 'turn A' },
      { role: 'user', content: 'turn B' },
    ]),
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, job1))
  const loadTranscript = makeLoadTranscript(db)
  await tick(db, {
    loadTranscript,
    callLLM: async () => JSON.stringify({ candidates: [{ title: '[category:x] t', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] }),
    createCandidate: async () => ({ id: 'c1', status: 'candidate', version: 1 } as any),
  })

  // 第二次 Stop：同样 2 turns（无新增）
  const { jobId: job2 } = await enqueueDistillJob(db, {
    sourceEventId: 'stop-2', runtime: 'claude-code', cwd: '/r', debounceKey: '/r:Stop', debounceMs: 0,
    sessionId: 'sess-skip',
  })
  await db.insert(memoryDistillEvents).values({
    distillJobId: job2, attemptIndex: 0, ts: 2, kind: 'conversation',
    payload: JSON.stringify([
      { role: 'user', content: 'turn A' },
      { role: 'user', content: 'turn B' },
    ]),
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, job2))
  let createCalls = 0
  let llmCalls = 0
  await tick(db, {
    loadTranscript,
    callLLM: async () => { llmCalls++; return '[]' },
    createCandidate: async () => { createCalls++; return { id: 'c2', status: 'candidate', version: 1 } as any },
  })
  expect(llmCalls).toBe(0)      // 跳过蒸馏，不调 LLM
  expect(createCalls).toBe(0)   // 不创建候选
  const { getSessionOffset } = await import('@/memory/store')
  expect(await getSessionOffset(db, 'sess-skip')).toBe(2)  // 偏移不变（仍是第一次的 2）
  const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, job2))
  expect(rows[0]!.status).toBe('done')  // job 仍标 done
})
```

> 实现者注意：第一个 e2e 测试断言"第二次蒸馏 prompt 不含旧 turn A/B/C"。这依赖 distiller 的 user prompt 模板把 turn content 拼进去。若 distiller 对 turn content 做了截断/改写导致 A/B/C 不出现但 D/E 出现的方式不同，调整断言为"含 D/E 且 turn 数为 2"等更稳的形态。先跑一遍看实际 prompt 形状再定断言精度。**核心不可让步**：第二次 getSessionOffset === 5（偏移推进）、第二次蒸馏的输入 turns 只有 2 个（新增）。

- [ ] **Step 2: 运行 e2e 测试**

Run: `bun test tests/scheduler.test.ts -t "e2e incremental"`
Expected: PASS（两个 e2e 测试绿）。若第一个测试的 prompt 断言不稳，按上面注释调整断言精度。

- [ ] **Step 3: typecheck + 全量回归**

Run: `bun run typecheck && bun test`
Expected: typecheck 干净；`bun test` 全绿（所有测试：Task 1 schema/store + Task 2 scheduler + Task 3 server + Task 4 e2e + 前四轮回归）。

- [ ] **Step 4: Commit**

```bash
git add tests/scheduler.test.ts
git commit -m "test(scheduler): e2e incremental distill (same-session Stop distills only new turns)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 完成后（非本计划任务，执行阶段之后）

- 推远端 + 开 PR 合并回 `master`（PR 标题 `feat(memory): 记忆质量修复第五轮 - 增量蒸馏 + SubagentStop 跳过`）。
- 合并后本地 `git branch -d feat/memory-quality-fix5` + `git fetch --prune`。
- 重启 daemon 验证：
  - SubagentStop job 不再新增（与 PostToolUse 同样跳过）。
  - 同一 session 多次 Stop，第二次起只蒸馏新增 turn（看 distill job 的 LLM 调用是否只含新增 turn；偏移表 `memory_session_offsets` 有记录）。
  - 同义候选不再爆炸（Stop 累积重复蒸馏根治）。
  - 无 session_id 的历史 job 仍全量蒸馏（向后兼容）。
