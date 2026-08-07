# Web UI 五 tab 统一无限滚动分页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 五个 tab（候选审批/已审批/已拒绝/AI自动拒绝/蒸馏记录）从「一次性全量加载」改为服务端游标分页 + 前端无限滚动，首屏只加载 50 条，加载/渲染成本与数据总量脱钩。

**Architecture:** 服务端三列表端点加 `limit`+复合游标 `(sortTs, id)` 分页（不带 limit 保持旧形状兼容）；store 层新增三个 `list*Page` 函数与 `bulkRejectUnevaluated`；前端每 tab 缓存升级为 `{ items, nextCursor, hasMore }`，3s 轮询只刷第 1 页按 id merge，`IntersectionObserver` 哨兵触底追加；「批量拒绝未评估」改服务端按条件批量端点。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite；前端 React 19（`src/web/`，无样式框架）；测试 `bun:test`。

**Spec:** `docs/superpowers/specs/2026-08-07-tab-list-pagination-design.md`（已批准）

## Global Constraints

- 门槛：每个 task 结束 `bun run typecheck && bun test` 全绿才能 commit；**严禁 npm test**。
- 页大小默认 50，clamp `[1, 200]`；非法 limit（NaN）按默认 50。
- 游标复合键 `(sortTs, id)`：memories 用 `createdAt`，discards/runs 用 `ts`；对外参数名统一 `before` / `beforeId`，返回 `nextCursor: { ts, id } | null`。
- 排序统一 `ORDER BY sortTs DESC, id DESC`（id 是 ULID，字典序=创建序，同毫秒撞车不重不漏）。schema 里 `created_at`/`ts` 均 `.notNull()`（`src/db/schema.ts:28,77,96,144`），无需 COALESCE——spec 失败模式 4 由 schema 约束兜底。
- **向后兼容锚点**：不带 `limit` 参数的请求返回旧形状旧数据（`/api/memories` 全量 `{ items }`；`/api/discards`、`/api/distill-runs` LIMIT 200 `{ items }`），既有测试逐字节不变。
- 非法游标（before 非数 / 缺 beforeId）宽松忽略按第一页处理，**不 400**（与 status 非法值同款风格）。
- 前端操作函数保持 no-throw 契约（操作后本地更新 + `void refresh(tab)`，UI 层不 catch；`rescan`/`loadMore` 等已有/新设的错误通道除外）。
- 「未评估」谓词 = `value_class IS NULL OR value_class NOT IN ('user-rule','decision','preference','convention','trap','topology')`，与前端 `priorityRank(...) === 2` 语义一致。
- UI 文案中文，与 App.tsx 现有风格一致；不引入新依赖、不引入样式框架。
- 不改 `listDiscards` / `listRecentDistillRuns` 旧函数（旧端点路径继续用），新分页函数并列新增。

---

### Task 1: store 层分页基元 + `listMemoriesPage`

**Files:**
- Modify: `src/memory/store.ts`（import 行 + 文件末尾新增段）
- Test: `tests/store-page.test.ts`（新建）

**Interfaces:**
- Produces（后续全部 task 依赖）:
  ```ts
  export interface PageCursor { ts: number; id: string }
  export interface Page<T> { items: T[]; hasMore: boolean; nextCursor: PageCursor | null }
  export const MEMORY_PAGE_DEFAULT_LIMIT = 50
  export const MEMORY_PAGE_MAX_LIMIT = 200
  export function clampPageLimit(limit?: number): number
  export async function listMemoriesPage(
    db: DbClient,
    opts: { statuses: MemoryStatus[]; limit?: number; before?: PageCursor },
  ): Promise<Page<Memory>>
  ```
- `Page<Memory>` 的 `items` 是 store `Memory` 类型（`rowToMemory` 结果），server 直接 JSON 序列化（与现有 `/api/memories` 返回 raw row 的字段集一致——`Memory` 是 camelCase 超集，前端 `MemoryItem` 可选字段容忍）。

- [ ] **Step 1: 写失败测试 `tests/store-page.test.ts`**

```ts
import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { memories } from '@/db/schema'
import {
  createCandidate, clampPageLimit, listMemoriesPage,
  MEMORY_PAGE_DEFAULT_LIMIT, MEMORY_PAGE_MAX_LIMIT,
} from '@/memory/store'

// 回归锁定：五 tab 无限滚动分页（spec 2026-08-07 §store）。
// 游标复合键 (createdAt, id) 保证同毫秒批量插入翻页不重不漏。
// EBUSY-safe 模式同 store-crud.test.ts（每 test 独立子目录）。
const root = join(import.meta.dir, '.tmp-store-page')
let dir = ''
let db: ReturnType<typeof openDb>

beforeAll(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
})
beforeEach(() => {
  dir = join(root, Math.random().toString(36).slice(2))
  mkdirSync(dir, { recursive: true })
  db = openDb(join(dir, 't.db'))
})
afterEach(() => { db.$client.close() })

/** 造一条 candidate 并把 createdAt 改成指定值（ULID 按创建序递增）。 */
async function seedMemory(createdAt: number, status = 'candidate' as string, valueClass: string | null = null) {
  const m = await createCandidate(db, {
    scopeType: 'global', scopeId: null, title: `t-${createdAt}`, bodyMd: 'b',
    tags: [], sourceKind: 'manual', runtime: null, valueClass,
  })
  await db.update(memories).set({ createdAt, status }).where(eq(memories.id, m.id)).run()
  return m.id
}

test('clampPageLimit: undefined/NaN -> 50, 0 -> 1, 9999 -> 200', () => {
  expect(clampPageLimit(undefined)).toBe(MEMORY_PAGE_DEFAULT_LIMIT)
  expect(clampPageLimit(NaN)).toBe(MEMORY_PAGE_DEFAULT_LIMIT)
  expect(clampPageLimit(0)).toBe(1)
  expect(clampPageLimit(9999)).toBe(MEMORY_PAGE_MAX_LIMIT)
  expect(MEMORY_PAGE_DEFAULT_LIMIT).toBe(50)
  expect(MEMORY_PAGE_MAX_LIMIT).toBe(200)
})

test('listMemoriesPage: 分页边界 hasMore/nextCursor 翻页不重不漏', async () => {
  for (const ts of [1000, 2000, 3000, 4000, 5000]) await seedMemory(ts)
  const p1 = await listMemoriesPage(db, { statuses: ['candidate'], limit: 2 })
  expect(p1.items.map((m) => m.createdAt)).toEqual([5000, 4000])
  expect(p1.hasMore).toBe(true)
  expect(p1.nextCursor).toEqual({ ts: 4000, id: p1.items[1]!.id })
  const p2 = await listMemoriesPage(db, { statuses: ['candidate'], limit: 2, before: p1.nextCursor! })
  expect(p2.items.map((m) => m.createdAt)).toEqual([3000, 2000])
  expect(p2.hasMore).toBe(true)
  const p3 = await listMemoriesPage(db, { statuses: ['candidate'], limit: 2, before: p2.nextCursor! })
  expect(p3.items.map((m) => m.createdAt)).toEqual([1000])
  expect(p3.hasMore).toBe(false)
  expect(p3.nextCursor).toBeNull()
})

test('listMemoriesPage: 同毫秒复合键 (createdAt, id) 不重不漏', async () => {
  // 同一 createdAt 三条（模拟回扫批量插入）；ULID 字典序 = 创建序
  const ids = [await seedMemory(1000), await seedMemory(1000), await seedMemory(1000)]
  const p1 = await listMemoriesPage(db, { statuses: ['candidate'], limit: 2 })
  expect(p1.items.map((m) => m.id)).toEqual([ids[2], ids[1]]) // id DESC
  const p2 = await listMemoriesPage(db, { statuses: ['candidate'], limit: 2, before: p1.nextCursor! })
  expect(p2.items.map((m) => m.id)).toEqual([ids[0]])
  expect(p2.hasMore).toBe(false)
})

test('listMemoriesPage: status inArray 过滤', async () => {
  await seedMemory(1000, 'candidate')
  await seedMemory(2000, 'rejected')
  const page = await listMemoriesPage(db, { statuses: ['rejected'], limit: 50 })
  expect(page.items.length).toBe(1)
  expect(page.items[0]!.status).toBe('rejected')
})

test('listMemoriesPage: 空表 -> 空页无游标', async () => {
  const page = await listMemoriesPage(db, { statuses: ['candidate'], limit: 50 })
  expect(page).toEqual({ items: [], hasMore: false, nextCursor: null })
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/store-page.test.ts`
Expected: FAIL（`clampPageLimit` / `listMemoriesPage` 未导出）

- [ ] **Step 3: 实现**

`src/memory/store.ts` import 行加 `lt, or`：

```ts
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm'
```

文件末尾新增：

```ts
// ---------------------------------------------------------------------------
// 五 tab 无限滚动分页（spec 2026-08-07）：复合游标 (sortTs, id) + limit+1 探测
// hasMore。schema created_at/ts 均 notNull，无需 COALESCE。旧全量/LIMIT-200
// 函数保留（无 limit 参数的兼容路径继续用），分页函数并列新增。
// ---------------------------------------------------------------------------

export interface PageCursor { ts: number; id: string }
export interface Page<T> { items: T[]; hasMore: boolean; nextCursor: PageCursor | null }

export const MEMORY_PAGE_DEFAULT_LIMIT = 50
export const MEMORY_PAGE_MAX_LIMIT = 200

/** limit clamp 到 [1, 200]；undefined/NaN -> 默认 50。 */
export function clampPageLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return MEMORY_PAGE_DEFAULT_LIMIT
  return Math.min(Math.max(Math.floor(limit), 1), MEMORY_PAGE_MAX_LIMIT)
}

export async function listMemoriesPage(
  db: DbClient,
  opts: { statuses: MemoryStatus[]; limit?: number; before?: PageCursor },
): Promise<Page<Memory>> {
  const limit = clampPageLimit(opts.limit)
  const conds = []
  if (opts.statuses.length > 0) conds.push(inArray(memories.status, opts.statuses))
  if (opts.before) {
    conds.push(or(
      lt(memories.createdAt, opts.before.ts),
      and(eq(memories.createdAt, opts.before.ts), lt(memories.id, opts.before.id)),
    ))
  }
  const rows = await db.select().from(memories)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(memories.createdAt), desc(memories.id))
    .limit(limit + 1).all()
  const hasMore = rows.length > limit
  const pageRows = rows.slice(0, limit)
  const last = pageRows[pageRows.length - 1]
  return {
    items: pageRows.map(rowToMemory),
    hasMore,
    nextCursor: hasMore && last ? { ts: last.createdAt, id: last.id } : null,
  }
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `bun test tests/store-page.test.ts`
Expected: 4 通过

- [ ] **Step 5: 全量回归 + commit**

```bash
bun run typecheck && bun test
git add src/memory/store.ts tests/store-page.test.ts
git commit -m "feat(store): 分页基元 Page/PageCursor/clampPageLimit + listMemoriesPage"
```

---

### Task 2: store 层 `listDiscardsPage` + `listDistillRunsPage`

**Files:**
- Modify: `src/memory/store.ts`（`listDiscards` 段 + `listRecentDistillRuns` 段 + 分页段追加）
- Test: `tests/store-page.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `Page`/`PageCursor`/`clampPageLimit`
- Produces:
  ```ts
  export async function listDiscardsPage(
    db: DbClient, opts?: { limit?: number; before?: PageCursor },
  ): Promise<Page<DiscardRow>>
  export async function listDistillRunsPage(
    db: DbClient, opts?: { limit?: number; before?: PageCursor },
  ): Promise<Page<DistillRunListRow>>
  ```
  （`DiscardRow` / `DistillRunListRow` 为既有导出类型，形状不变。）

- [ ] **Step 1: 追加失败测试**

`tests/store-page.test.ts` import 追加：

```ts
import { logDiscards, saveDistillRun, listDiscardsPage, listDistillRunsPage } from '@/memory/store'
import { memoryDistillJobs } from '@/db/schema'
```

测试（seed 辅助随测试给出；`logDiscards` 的 `ts` 由 `Date.now()` 生成，同毫秒天然成立，直接验证复合键；runs 用 `saveDistillRun` 写 run 行，job 元数据用直接 insert）：

```ts
async function seedDiscards(n: number) {
  // logDiscards 一次写 n 行（同一 ts = Date.now()，天然同毫秒批量）
  await logDiscards(db, 'job-d', Array.from({ length: n }, (_, i) => ({
    title: `d-${i}`, bodyMd: 'b', reason: 'fleeting' as const,
    scopeType: 'global' as const, scopeId: null, sourceCwd: null,
    runtime: null, sourceKind: 'conversation' as const,
  })))
}

test('listDiscardsPage: 同毫秒批量翻页不重不漏 + hasMore', async () => {
  await seedDiscards(3)
  const p1 = await listDiscardsPage(db, { limit: 2 })
  expect(p1.items.length).toBe(2)
  expect(p1.hasMore).toBe(true)
  const p2 = await listDiscardsPage(db, { limit: 2, before: p1.nextCursor! })
  expect(p2.items.length).toBe(1)
  expect(p2.hasMore).toBe(false)
  const allIds = [...p1.items, ...p2.items].map((d) => d.id)
  expect(new Set(allIds).size).toBe(3)
})

test('listDiscardsPage: 空表 -> 空页', async () => {
  expect(await listDiscardsPage(db, { limit: 50 })).toEqual({ items: [], hasMore: false, nextCursor: null })
})

async function seedRun(jobId: string) {
  await db.insert(memoryDistillJobs).values({
    id: jobId, sourceEventId: 'e', status: 'done', cwd: `C:/proj/${jobId}`, runtime: 'claude-code',
    payloadHash: jobId, attempts: 0, nextRunAt: 0, createdAt: 1,
  }).run()
  await saveDistillRun(db, jobId, {
    outcome: 'produced', rawOutput: null, rawCount: 1, acceptedCount: 1,
    dedupedCount: 1, filteredCount: 1, storedCount: 1, discardedCount: 0,
    durationMs: 10, errorMessage: null,
  })
}

test('listDistillRunsPage: 翻页 + job 元数据带出 + 孤儿 run cwd=null', async () => {
  await seedRun('j1')
  await seedRun('j2')
  // 孤儿 run（无 job 行）
  await saveDistillRun(db, 'j-orphan', {
    outcome: 'empty_output', rawOutput: null, rawCount: 0, acceptedCount: 0,
    dedupedCount: 0, filteredCount: 0, storedCount: 0, discardedCount: 0,
    durationMs: 1, errorMessage: null,
  })
  const p1 = await listDistillRunsPage(db, { limit: 2 })
  expect(p1.items.length).toBe(2)
  expect(p1.hasMore).toBe(true)
  const p2 = await listDistillRunsPage(db, { limit: 2, before: p1.nextCursor! })
  expect(p2.items.length).toBe(1)
  expect(p2.hasMore).toBe(false)
  const all = [...p1.items, ...p2.items]
  expect(new Set(all.map((r) => r.distillJobId)).size).toBe(3)
  const orphan = all.find((r) => r.distillJobId === 'j-orphan')!
  expect(orphan.cwd).toBeNull()
  const j1 = all.find((r) => r.distillJobId === 'j1')
  expect(j1?.cwd).toBe('C:/proj/j1')
})
```

> `memoryDistillJobs` 的必填列以 `src/db/schema.ts` 为准：实现者先读 schema 的 jobs 表定义校准 insert 字段（`payloadHash`/`sessionId`/`sourceAgentId` 等可空列按 schema 可空则省略，不可空则补合法值）。既有 `tests/store-crud.test.ts` 里 `saveDistillRun`/`listRecentDistillRuns` 的 seed 写法是同文件内现成参照，照抄其 insert 形状。

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/store-page.test.ts`
Expected: FAIL（`listDiscardsPage` / `listDistillRunsPage` 未导出）

- [ ] **Step 3: 实现**

`src/memory/store.ts` 三处改动：

（a）`listDiscards` 的映射抽成 `rowToDiscard`（`listDiscards` 本体改调它，行为不变）：

```ts
function rowToDiscard(r: any): DiscardRow {
  return {
    id: r.id, distillJobId: r.distillJobId, title: r.title, bodyMd: r.bodyMd, reason: r.reason,
    ts: r.ts, scopeType: r.scopeType ?? null, scopeId: r.scopeId ?? null, sourceCwd: r.sourceCwd ?? null,
    runtime: r.runtime ?? null, sourceKind: r.sourceKind ?? null, promotedMemoryId: r.promotedMemoryId ?? null,
  }
}
```

（b）`listRecentDistillRuns` 的 job 元数据拼接抽成共用函数（原函数改调它，行为不变）：

```ts
/** run 行（已按 ts/id 排好序、已截页）拼 job 元数据；孤儿 run -> cwd=null / createdAt=0。 */
async function attachRunJobMeta(
  db: DbClient,
  runRows: Array<{ distillJobId: string; outcome: string; rawCount: number; acceptedCount: number; dedupedCount: number; filteredCount: number; storedCount: number; discardedCount: number; durationMs: number; errorMessage: string | null; ts: number }>,
): Promise<DistillRunListRow[]> {
  if (runRows.length === 0) return []
  const jobRows = await db.select().from(memoryDistillJobs)
    .where(inArray(memoryDistillJobs.id, runRows.map((r) => r.distillJobId))).all()
  const jobById = new Map(jobRows.map((j) => [j.id, j]))
  return runRows.map((r) => {
    const j = jobById.get(r.distillJobId)
    return {
      ...r,
      cwd: j?.cwd ?? null,
      runtime: (j?.runtime ?? 'claude-code') as string,
      createdAt: (j?.createdAt as number | undefined) ?? 0,
      sourceAgentId: (j?.sourceAgentId as string | null | undefined) ?? null,
    }
  })
}
```

> `listRecentDistillRuns` 现有尾部 map 的字段名以源码为准（`src/memory/store.ts:696-710` 附近）；抽取时逐字段对齐，保证旧函数输出逐字节不变（既有 `tests/store-crud.test.ts` 的 listRecentDistillRuns 用例是回归锚点）。

（c）分页段追加两函数：

```ts
export async function listDiscardsPage(
  db: DbClient,
  opts: { limit?: number; before?: PageCursor } = {},
): Promise<Page<DiscardRow>> {
  const limit = clampPageLimit(opts.limit)
  const conds = opts.before
    ? [or(
        lt(memoryDiscards.ts, opts.before.ts),
        and(eq(memoryDiscards.ts, opts.before.ts), lt(memoryDiscards.id, opts.before.id)),
      )]
    : []
  const rows = await db.select().from(memoryDiscards)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(memoryDiscards.ts), desc(memoryDiscards.id))
    .limit(limit + 1).all()
  const hasMore = rows.length > limit
  const pageRows = rows.slice(0, limit)
  const last = pageRows[pageRows.length - 1]
  return {
    items: pageRows.map(rowToDiscard),
    hasMore,
    nextCursor: hasMore && last ? { ts: last.ts, id: last.id } : null,
  }
}

export async function listDistillRunsPage(
  db: DbClient,
  opts: { limit?: number; before?: PageCursor } = {},
): Promise<Page<DistillRunListRow>> {
  const limit = clampPageLimit(opts.limit)
  const cols = {
    distillJobId: memoryDistillRuns.distillJobId, outcome: memoryDistillRuns.outcome,
    rawCount: memoryDistillRuns.distilledCount, acceptedCount: memoryDistillRuns.acceptedCount,
    dedupedCount: memoryDistillRuns.dedupedCount, filteredCount: memoryDistillRuns.filteredCount,
    storedCount: memoryDistillRuns.storedCount, discardedCount: memoryDistillRuns.discardedCount,
    durationMs: memoryDistillRuns.durationMs, errorMessage: memoryDistillRuns.errorMessage,
    ts: memoryDistillRuns.ts,
  }
  const conds = opts.before
    ? [or(
        lt(memoryDistillRuns.ts, opts.before.ts),
        and(eq(memoryDistillRuns.ts, opts.before.ts), lt(memoryDistillRuns.distillJobId, opts.before.id)),
      )]
    : []
  const runRows = await db.select(cols).from(memoryDistillRuns)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(memoryDistillRuns.ts), desc(memoryDistillRuns.distillJobId))
    .limit(limit + 1).all()
  const hasMore = runRows.length > limit
  const pageRows = runRows.slice(0, limit)
  const last = pageRows[pageRows.length - 1]
  return {
    items: await attachRunJobMeta(db, pageRows),
    hasMore,
    nextCursor: hasMore && last ? { ts: last.ts, id: last.distillJobId } : null,
  }
}
```

- [ ] **Step 4: 跑测试确认绿 + 全量回归**

Run: `bun test tests/store-page.test.ts tests/store-crud.test.ts`
Expected: 全绿（store-crud 的 listDiscards/listRecentDistillRuns 旧用例不受抽取影响）

- [ ] **Step 5: commit**

```bash
bun run typecheck && bun test
git add src/memory/store.ts tests/store-page.test.ts
git commit -m "feat(store): listDiscardsPage/listDistillRunsPage 游标分页（抽取 rowToDiscard/attachRunJobMeta）"
```

---

### Task 3: store 层 `bulkRejectUnevaluated`

**Files:**
- Modify: `src/memory/store.ts`（import + 分页段追加）
- Test: `tests/store-page.test.ts`（追加）

**Interfaces:**
- Consumes: 既有 `promoteCandidate(db, id, { action: 'reject' })`（`src/memory/store.ts:231`）
- Produces:
  ```ts
  export const PROTECTED_VALUE_CLASSES: readonly string[]
  export async function bulkRejectUnevaluated(db: DbClient): Promise<{ rejected: number }>
  ```
  `PROTECTED_VALUE_CLASSES` 同时被 server `/api/status`（Task 4）复用做 JS 计数。

- [ ] **Step 1: 追加失败测试**

```ts
// import 追加：bulkRejectUnevaluated, PROTECTED_VALUE_CLASSES
import { bulkRejectUnevaluated, PROTECTED_VALUE_CLASSES } from '@/memory/store'

test('bulkRejectUnevaluated: 只拒未评估候选，保护类/非候选不动', async () => {
  const c1 = await seedMemory(1000, 'candidate', null)          // 拒（NULL）
  const c2 = await seedMemory(2000, 'candidate', 'weird-class')  // 拒（未知类）
  const k1 = await seedMemory(3000, 'candidate', 'decision')     // 留（保护类）
  const k2 = await seedMemory(4000, 'candidate', 'user-rule')    // 留
  const k3 = await seedMemory(5000, 'approved', null)            // 不动（非候选）
  const k4 = await seedMemory(6000, 'rejected', null)            // 不动（已终态）
  const r = await bulkRejectUnevaluated(db)
  expect(r.rejected).toBe(2)
  const statusOf = async (id: string) =>
    (await db.select().from(memories).where(eq(memories.id, id)).limit(1).all())[0]!.status
  expect(await statusOf(c1)).toBe('rejected')
  expect(await statusOf(c2)).toBe('rejected')
  expect(await statusOf(k1)).toBe('candidate')
  expect(await statusOf(k2)).toBe('candidate')
  expect(await statusOf(k3)).toBe('approved')
  expect(await statusOf(k4)).toBe('rejected')
  expect(PROTECTED_VALUE_CLASSES).toContain('decision')
  expect(PROTECTED_VALUE_CLASSES.length).toBe(6)
})

test('bulkRejectUnevaluated: 空队列 -> 0', async () => {
  expect((await bulkRejectUnevaluated(db)).rejected).toBe(0)
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/store-page.test.ts`
Expected: FAIL（未导出）

- [ ] **Step 3: 实现**

`src/memory/store.ts` import 加 `notInArray`，分页段追加：

```ts
/** 6 个保护类 valueClass（= 前端 priorityRank < 2 的全集）；其余候选视为「未评估」。 */
export const PROTECTED_VALUE_CLASSES: readonly string[] = [
  'user-rule', 'decision', 'preference', 'convention', 'trap', 'topology',
]

/**
 * 服务端按条件批量拒绝「未评估」候选（spec 2026-08-07 决策 4）：分页后前端只加载
 * 第一页，批量拒绝必须覆盖整个尾队。逐行走既有 promoteCandidate 路径（状态机 +
 * 审计一致）；not-found/终态竞态跳过继续（与 server bulk-promote 同款容错）。
 */
export async function bulkRejectUnevaluated(db: DbClient): Promise<{ rejected: number }> {
  const rows = await db.select({ id: memories.id }).from(memories)
    .where(and(
      eq(memories.status, 'candidate'),
      or(isNull(memories.valueClass), notInArray(memories.valueClass, [...PROTECTED_VALUE_CLASSES])),
    )).all()
  let rejected = 0
  for (const r of rows) {
    try {
      await promoteCandidate(db, r.id, { action: 'reject' })
      rejected += 1
    } catch {
      // 并发下已被处置的行跳过，继续其余
    }
  }
  return { rejected }
}
```

- [ ] **Step 4: 跑测试确认绿 + commit**

```bash
bun test tests/store-page.test.ts
bun run typecheck && bun test
git add src/memory/store.ts tests/store-page.test.ts
git commit -m "feat(store): bulkRejectUnevaluated 服务端按条件批量拒绝未评估候选"
```

---

### Task 4: server 三端点分页分流 + bulk-reject 端点 + status 计数

**Files:**
- Modify: `src/server.ts`（import 行、`/api/memories`（:419-427）、`/api/discards`（:509-512）、`/api/distill-runs`（:528-537）、`/api/status`（:347-371）、bulk-reject 新路由放 `/api/memories/bulk-promote`（:492-506）之后）
- Test: `tests/server.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1-3 全部 store 导出（`listMemoriesPage`/`listDiscardsPage`/`listDistillRunsPage`/`bulkRejectUnevaluated`/`PROTECTED_VALUE_CLASSES`/`PageCursor`）
- Produces（前端 Task 5 依赖的 HTTP 契约）:
  - `GET /api/memories?status=…&limit=N[&before=ms&beforeId=id]` → `{ items, hasMore, nextCursor }`
  - `GET /api/discards?limit=N[&before=…&beforeId=…]` → 同上
  - `GET /api/distill-runs?limit=N[&before=…&beforeId=…]` → 同上
  - `POST /api/memories/bulk-reject-unevaluated` → `{ rejected: number }`
  - `GET /api/status` 新增字段 `unevaluatedCandidates: number`

- [ ] **Step 1: 追加失败测试**

`tests/server.test.ts`（seed 直接用既有 `createCandidate` + raw update 改 createdAt/status，模式同 Task 1）：

```ts
// import 追加：logDiscards（已有 createCandidate/promoteCandidate）
import { logDiscards } from '@/memory/store'

async function seedMem(createdAt: number, status: string, valueClass: string | null = null) {
  const m = await createCandidate(db, {
    scopeType: 'global', scopeId: null, title: `t-${createdAt}`, bodyMd: 'b',
    tags: [], sourceKind: 'manual', runtime: null, valueClass,
  })
  const { eq } = await import('drizzle-orm')
  await db.update(memories).set({ createdAt, status }).where(eq(memories.id, m.id)).run()
  return m.id
}

test('GET /api/memories?limit 分页形状 + 游标翻页', async () => {
  for (const ts of [1000, 2000, 3000]) await seedMem(ts, 'candidate')
  const p1 = await req('/api/memories?status=candidate&limit=2')
  expect(p1.status).toBe(200)
  expect(p1.body.items.length).toBe(2)
  expect(p1.body.hasMore).toBe(true)
  expect(p1.body.nextCursor).toEqual({ ts: 2000, id: p1.body.items[1].id })
  const p2 = await req(`/api/memories?status=candidate&limit=2&before=${p1.body.nextCursor.ts}&beforeId=${p1.body.nextCursor.id}`)
  expect(p2.body.items.length).toBe(1)
  expect(p2.body.hasMore).toBe(false)
  expect(p2.body.nextCursor).toBeNull()
})

test('GET /api/memories 不带 limit -> 旧全量形状（兼容锚点）', async () => {
  for (const ts of [1000, 2000, 3000]) await seedMem(ts, 'candidate')
  const r = await req('/api/memories?status=candidate')
  expect(r.status).toBe(200)
  expect(r.body.items.length).toBe(3)
  expect('hasMore' in r.body).toBe(false)
})

test('GET /api/memories 非法游标宽松忽略不 400', async () => {
  await seedMem(1000, 'candidate')
  const r = await req('/api/memories?status=candidate&limit=50&before=abc&beforeId=x')
  expect(r.status).toBe(200)
  expect(r.body.items.length).toBe(1)
})

test('GET /api/memories limit clamp：0 -> 1 条，9999 -> 不报错', async () => {
  for (const ts of [1000, 2000, 3000]) await seedMem(ts, 'candidate')
  const r0 = await req('/api/memories?status=candidate&limit=0')
  expect(r0.body.items.length).toBe(1)
  const rBig = await req('/api/memories?status=candidate&limit=9999')
  expect(rBig.status).toBe(200)
  expect(rBig.body.hasMore).toBe(false)
})

test('GET /api/discards 分页/旧形状分流', async () => {
  await logDiscards(db, 'job-d', [1, 2, 3].map((i) => ({
    title: `d-${i}`, bodyMd: 'b', reason: 'fleeting' as const,
    scopeType: 'global' as const, scopeId: null, sourceCwd: null,
    runtime: null, sourceKind: 'conversation' as const,
  })))
  const legacy = await req('/api/discards')
  expect(legacy.body.items.length).toBe(3)
  expect('hasMore' in legacy.body).toBe(false)
  const p1 = await req('/api/discards?limit=2')
  expect(p1.body.items.length).toBe(2)
  expect(p1.body.hasMore).toBe(true)
})

test('GET /api/distill-runs 分页/旧形状分流', async () => {
  const legacy = await req('/api/distill-runs')
  expect(legacy.status).toBe(200)
  expect('hasMore' in legacy.body).toBe(false)
  const paged = await req('/api/distill-runs?limit=50')
  expect(paged.status).toBe(200)
  expect(paged.body).toEqual({ items: [], hasMore: false, nextCursor: null })
})

test('POST /api/memories/bulk-reject-unevaluated 按条件批量 + broadcast', async () => {
  await seedMem(1000, 'candidate', null)
  await seedMem(2000, 'candidate', 'decision')
  const r = await req('/api/memories/bulk-reject-unevaluated', { method: 'POST' })
  expect(r.status).toBe(200)
  expect(r.body.rejected).toBe(1)
  expect(broadcastCalls.some((m: any) => m?.type === 'memories.bulk-rejected')).toBe(true)
})

test('GET /api/status 含 unevaluatedCandidates 且数值正确', async () => {
  await seedMem(1000, 'candidate', null)
  await seedMem(2000, 'candidate', 'decision')
  await seedMem(3000, 'approved', null)
  const r = await req('/api/status')
  expect(r.body.unevaluatedCandidates).toBe(1)
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/server.test.ts`
Expected: FAIL（分页形状/端点/字段不存在）

- [ ] **Step 3: 实现**

`src/server.ts` import 行追加（现有 `import { promoteCandidate, … } from '@/memory/store'` 一行扩展）：

```ts
import { promoteCandidate, patchMemory, createCandidate, getMemoryById, getSourceInput, archiveMemory, unarchiveMemory, restoreMemory, promoteDiscard, listDiscards, getDistillRun, listRecentDistillRuns, listMemoriesPage, listDiscardsPage, listDistillRunsPage, bulkRejectUnevaluated, PROTECTED_VALUE_CLASSES, MemoryNotFoundError, type PageCursor } from '@/memory/store'
```

路由区加游标解析 helper（放 `/api/memories` 路由之前）：

```ts
/** 非法/缺省游标宽松忽略（undefined = 第一页），不 400（spec 契约）。 */
function parseBefore(c: { req: { query: (k: string) => string | undefined } }): PageCursor | undefined {
  const b = c.req.query('before')
  const bid = c.req.query('beforeId')
  if (!b || !bid) return undefined
  const ts = Number(b)
  if (!Number.isFinite(ts)) return undefined
  return { ts, id: bid }
}
```

`/api/memories`（:419-427）改分流（status 过滤逻辑原样保留）：

```ts
app.get('/api/memories', async (c) => {
  const statusParam = c.req.query('status') ?? ''
  const VALID: Set<string> = new Set(['candidate', 'approved', 'archived', 'superseded', 'rejected'])
  const wanted = statusParam.split(',').map((s) => s.trim()).filter((s): s is MemoryStatus => s.length > 0 && VALID.has(s))
  // 带 limit -> 游标分页（spec 2026-08-07）；不带 -> 旧全量形状（兼容锚点）
  if (c.req.query('limit') !== undefined) {
    const page = await listMemoriesPage(deps.db, {
      statuses: wanted,
      limit: Number(c.req.query('limit')),
      before: parseBefore(c),
    })
    return c.json(page)
  }
  const rows = wanted.length > 0
    ? await deps.db.select().from(memories).where(inArray(memories.status, wanted)).orderBy(desc(memories.createdAt)).all()
    : await deps.db.select().from(memories).orderBy(desc(memories.createdAt)).all()
  return c.json({ items: rows })
})
```

`/api/discards` 与 `/api/distill-runs` 同款分流：

```ts
app.get('/api/discards', async (c) => {
  if (c.req.query('limit') !== undefined) {
    return c.json(await listDiscardsPage(deps.db, { limit: Number(c.req.query('limit')), before: parseBefore(c) }))
  }
  const items = await listDiscards(deps.db)
  return c.json({ items })
})
```

```ts
app.get('/api/distill-runs', async (c) => {
  // 带 limit -> 游标分页；不带 -> 旧 LIMIT 200 形状（兼容锚点）
  if (c.req.query('limit') !== undefined) {
    return c.json(await listDistillRunsPage(deps.db, { limit: Number(c.req.query('limit')), before: parseBefore(c) }))
  }
  const items = await listRecentDistillRuns(deps.db, { limit: 200 })
  return c.json({ items })
})
```

> 旧 `/api/distill-runs` 的 `limit` 参数解析（cap 500）随分流删除——带 limit 现在走分页形状。现有 web UI 不传 limit（`App.tsx` 的 `listDistillRuns(fetch)`），无行为回退。

bulk-reject 新路由（放 `/api/memories/bulk-promote` 之后）：

```ts
// 服务端按条件批量拒绝「未评估」候选（spec 决策 4）：覆盖整个尾队，
// 不依赖前端分页加载了多少。
app.post('/api/memories/bulk-reject-unevaluated', async (c) => {
  const r = await bulkRejectUnevaluated(deps.db)
  deps.broadcast({ type: 'memories.bulk-rejected', rejected: r.rejected })
  return c.json(r)
})
```

`/api/status`（:347-371）`return c.json({...})` 里加字段（memRows 已全量加载，直接 JS 计数，不加查询——status 全表扫描优化是非目标）：

```ts
const protectedVc = new Set<string>(PROTECTED_VALUE_CLASSES)
const unevaluatedCandidates = memRows.filter(
  (m) => m.status === 'candidate' && (m.valueClass === null || !protectedVc.has(m.valueClass)),
).length
return c.json({
  // ……既有字段原样……
  unevaluatedCandidates,
  rescan: rescanState,
})
```

- [ ] **Step 4: 跑测试确认绿 + 全量回归**

Run: `bun test tests/server.test.ts`
Expected: 新增 8 条 + 既有多条全绿

- [ ] **Step 5: commit**

```bash
bun run typecheck && bun test
git add src/server.ts tests/server.test.ts
git commit -m "feat(server): 三列表端点游标分页分流 + bulk-reject-unevaluated + status 未评估计数"
```

---

### Task 5: web api.ts 分页 wrapper + bulk wrapper

**Files:**
- Modify: `src/web/api.ts`（`MemsideStatus` 接口 + 文件中段追加分页 client 段）
- Test: `tests/web-api.test.ts`（追加）

**Interfaces:**
- Consumes: Task 4 的 HTTP 契约
- Produces（Task 7/8 依赖）:
  ```ts
  export interface PageDto<T> { items: T[]; hasMore: boolean; nextCursor: { ts: number; id: string } | null }
  export const WEB_PAGE_SIZE = 50
  export async function listMemoriesPage(fetchFn?: FetchLike, opts?: { status: string; limit?: number; before?: { ts: number; id: string } }): Promise<PageDto<MemoryItem>>
  export async function listDiscardsPage(fetchFn?: FetchLike, opts?: { limit?: number; before?: { ts: number; id: string } }): Promise<PageDto<DiscardItem>>
  export async function listDistillRunsPage(fetchFn?: FetchLike, opts?: { limit?: number; before?: { ts: number; id: string } }): Promise<PageDto<DistillRunListItem>>
  export async function bulkRejectUnevaluated(fetchFn?: FetchLike): Promise<{ rejected: number }>
  // MemsideStatus 加字段: unevaluatedCandidates?: number
  ```

- [ ] **Step 1: 追加失败测试**

`tests/web-api.test.ts`（import 追加 `listMemoriesPage, listDiscardsPage, listDistillRunsPage, bulkRejectUnevaluated`）：

```ts
test('listMemoriesPage: URL 拼 status/limit/游标，解析分页形状', async () => {
  let called = ''
  const fetchFn = (async (url: string) => {
    called = url
    return new Response(JSON.stringify({ items: [{ id: '1' }], hasMore: true, nextCursor: { ts: 123, id: 'abc' } }), { status: 200 })
  }) as any
  const page = await listMemoriesPage(fetchFn, { status: 'candidate', limit: 50, before: { ts: 456, id: 'x/y' } })
  expect(called).toBe('/api/memories?status=candidate&limit=50&before=456&beforeId=x%2Fy')
  expect(page.hasMore).toBe(true)
  expect(page.nextCursor).toEqual({ ts: 123, id: 'abc' })
})

test('listMemoriesPage: 旧 daemon 无 hasMore -> false（兼容降级）', async () => {
  const fetchFn = (async () => new Response(JSON.stringify({ items: [{ id: '1' }] }), { status: 200 })) as any
  const page = await listMemoriesPage(fetchFn, { status: 'candidate' })
  expect(page.hasMore).toBe(false)
  expect(page.nextCursor).toBeNull()
})

test('listDiscardsPage / listDistillRunsPage: URL 与形状', async () => {
  const urls: string[] = []
  const fetchFn = (async (url: string) => {
    urls.push(url)
    return new Response(JSON.stringify({ items: [], hasMore: false, nextCursor: null }), { status: 200 })
  }) as any
  await listDiscardsPage(fetchFn, { limit: 50, before: { ts: 1, id: 'a' } })
  expect(urls[0]).toBe('/api/discards?limit=50&before=1&beforeId=a')
  await listDistillRunsPage(fetchFn, { limit: 50 })
  expect(urls[1]).toBe('/api/distill-runs?limit=50')
})

test('bulkRejectUnevaluated: POST 到按条件批量端点', async () => {
  let captured: { url: string; method: string } | null = null
  const fetchFn = (async (url: string, init: any) => {
    captured = { url, method: init.method }
    return new Response(JSON.stringify({ rejected: 3 }), { status: 200 })
  }) as any
  const r = await bulkRejectUnevaluated(fetchFn)
  expect(captured!.url).toBe('/api/memories/bulk-reject-unevaluated')
  expect(captured!.method).toBe('POST')
  expect(r.rejected).toBe(3)
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/web-api.test.ts`
Expected: FAIL（未导出）

- [ ] **Step 3: 实现**

`src/web/api.ts` 追加（放「Distill runs client」段之后、「LLM 设置」段之前）：

```ts
// --- 五 tab 无限滚动分页 client（spec 2026-08-07）--------------------------
// 统一分页形状；旧 daemon 不认识 limit 时返回 { items } 旧形状，hasMore/nextCursor
// 缺省降级 false/null（一页装全部，不崩）。

export interface PageDto<T> { items: T[]; hasMore: boolean; nextCursor: { ts: number; id: string } | null }

export const WEB_PAGE_SIZE = 50

export interface PageOpts { limit?: number; before?: { ts: number; id: string } }

function pageParams(opts?: PageOpts): URLSearchParams {
  const p = new URLSearchParams()
  p.set('limit', String(opts?.limit ?? WEB_PAGE_SIZE))
  if (opts?.before) {
    p.set('before', String(opts.before.ts))
    p.set('beforeId', opts.before.id)
  }
  return p
}

async function parsePage<T>(res: Response): Promise<PageDto<T>> {
  const data = await res.json()
  return {
    items: (data.items ?? []) as T[],
    hasMore: data.hasMore ?? false,
    nextCursor: data.nextCursor ?? null,
  }
}

export async function listMemoriesPage(
  fetchFn: FetchLike = fetch,
  opts: { status: string } & PageOpts = { status: '' },
): Promise<PageDto<MemoryItem>> {
  const p = pageParams(opts)
  p.set('status', opts.status)
  // status 放最前，与测试锁定的 URL 顺序一致
  const qs = new URLSearchParams()
  qs.set('status', opts.status)
  for (const [k, v] of p) qs.set(k, v)
  return parsePage<MemoryItem>(await fetchFn(`/api/memories?${qs}`))
}

export async function listDiscardsPage(
  fetchFn: FetchLike = fetch, opts: PageOpts = {},
): Promise<PageDto<DiscardItem>> {
  return parsePage<DiscardItem>(await fetchFn(`/api/discards?${pageParams(opts)}`))
}

export async function listDistillRunsPage(
  fetchFn: FetchLike = fetch, opts: PageOpts = {},
): Promise<PageDto<DistillRunListItem>> {
  return parsePage<DistillRunListItem>(await fetchFn(`/api/distill-runs?${pageParams(opts)}`))
}

/** POST /api/memories/bulk-reject-unevaluated — 服务端按条件清空未评估尾队。 */
export async function bulkRejectUnevaluated(fetchFn: FetchLike = fetch): Promise<{ rejected: number }> {
  const res = await fetchFn('/api/memories/bulk-reject-unevaluated', { method: 'POST' })
  return (await res.json()) as { rejected: number }
}
```

`MemsideStatus` 接口加一行：

```ts
  /** 未评估候选数（status='candidate' 且 valueClass 非保护类）；老 daemon 无此字段。 */
  unevaluatedCandidates?: number
```

- [ ] **Step 4: 跑测试确认绿 + commit**

```bash
bun test tests/web-api.test.ts
bun run typecheck && bun test
git add src/web/api.ts tests/web-api.test.ts
git commit -m "feat(web-api): list*Page 分页 wrapper + bulkRejectUnevaluated + status 未评估计数字段"
```

---

### Task 6: tab-cache.ts `mergePage` / `mergeAppend` / `nextCursorAfter`

**Files:**
- Modify: `src/web/tab-cache.ts`（追加）
- Test: `tests/tab-cache.test.ts`（追加）

**Interfaces:**
- Produces（Task 7/8 依赖）:
  ```ts
  export function mergePage<T>(loaded: T[], firstPage: T[], key: (t: T) => string): T[]
  export function mergeAppend<T>(loaded: T[], nextPage: T[], key: (t: T) => string): T[]
  export function nextCursorAfter<T>(page: { hasMore: boolean; nextCursor: { ts: number; id: string } | null }): { ts: number; id: string } | null
  ```

- [ ] **Step 1: 追加失败测试**

`tests/tab-cache.test.ts` 追加（import 追加 `mergePage, mergeAppend, nextCursorAfter`）：

```ts
test('mergePage: 第一页优先 + id 去重 + 老条目保序追加', () => {
  const loaded = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }, { id: 'c', v: 1 }]
  const first = [{ id: 'n', v: 9 }, { id: 'a', v: 2 }] // a 有新版本
  const merged = mergePage(loaded, first, (t) => t.id)
  expect(merged.map((t) => t.id)).toEqual(['n', 'a', 'b', 'c'])
  expect(merged[1]!.v).toBe(2) // 第一页数据赢
})

test('mergePage: 空 loaded / 空 firstPage', () => {
  expect(mergePage([], [{ id: 'x' }], (t) => t.id).map((t) => t.id)).toEqual(['x'])
  expect(mergePage([{ id: 'x' }], [], (t) => t.id).map((t) => t.id)).toEqual(['x'])
})

test('mergeAppend: 追加去重（重复拉同一页不产生重复卡片）', () => {
  const loaded = [{ id: 'a' }, { id: 'b' }]
  const next = [{ id: 'b', v: 2 }, { id: 'c' }]
  const merged = mergeAppend(loaded, next, (t) => t.id)
  expect(merged.map((t) => t.id)).toEqual(['a', 'b', 'c'])
  expect(merged[1]).toEqual({ id: 'b' }) // 已存在条目不被覆盖（保持 loaded 版）
})

test('nextCursorAfter: hasMore 真返回游标，假/缺游标返回 null', () => {
  expect(nextCursorAfter({ hasMore: true, nextCursor: { ts: 1, id: 'a' } })).toEqual({ ts: 1, id: 'a' })
  expect(nextCursorAfter({ hasMore: false, nextCursor: { ts: 1, id: 'a' } })).toBeNull()
  expect(nextCursorAfter({ hasMore: true, nextCursor: null })).toBeNull()
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/tab-cache.test.ts`
Expected: FAIL（未导出）

- [ ] **Step 3: 实现**

`src/web/tab-cache.ts` 追加：

```ts
// --- 无限滚动分页（spec 2026-08-07）----------------------------------------

/**
 * 轮询刷第 1 页后的合并：第一页（最新数据）原样置前；已加载列表中 id 不在
 * 第一页的条目按原顺序追加。第一页里的老 id 用第一页版本（状态可能已变）。
 */
export function mergePage<T>(loaded: T[], firstPage: T[], key: (t: T) => string): T[] {
  const inFirst = new Set(firstPage.map(key))
  return [...firstPage, ...loaded.filter((t) => !inFirst.has(key(t)))]
}

/** loadMore 追加合并：幂等去重（守卫失效导致重复拉同一页时不产生重复卡片）。 */
export function mergeAppend<T>(loaded: T[], nextPage: T[], key: (t: T) => string): T[] {
  const seen = new Set(loaded.map(key))
  return [...loaded, ...nextPage.filter((t) => !seen.has(key(t)))]
}

/** 翻页游标推进：hasMore=false 或无游标 -> null（不再发 loadMore）。 */
export function nextCursorAfter<T>(page: { hasMore: boolean; nextCursor: { ts: number; id: string } | null }): { ts: number; id: string } | null {
  return page.hasMore ? page.nextCursor : null
}
```

- [ ] **Step 4: 跑测试确认绿 + commit**

```bash
bun test tests/tab-cache.test.ts
bun run typecheck && bun test
git add src/web/tab-cache.ts tests/tab-cache.test.ts
git commit -m "feat(web): tab-cache 分页合并纯函数 mergePage/mergeAppend/nextCursorAfter"
```

---

### Task 7: App.tsx state 分页化 + refresh 页 1 merge + 渲染读取适配

**Files:**
- Modify: `src/web/App.tsx`（import 行、App() 内 state（:52-66）、`refresh`（:68-89）、`bulkRejectUnevaluated` 内联读（:141-148）、渲染读取（:151-158）、五分支 `.length`/`.map` 读取（:155-157, 277, 334, 352, 382, 392-393））
- Test: 无新增（既有 `tests/web-ui.test.ts` / `tests/tab-cache.test.ts` 全绿即回归锚点；本 task 是中间态，Task 8 才加新 UI 锚点）

**Interfaces:**
- Consumes: Task 5 的 `listMemoriesPage/listDiscardsPage/listDistillRunsPage/WEB_PAGE_SIZE/PageDto`、Task 6 的 `mergePage`
- Produces（Task 8 依赖）:
  ```ts
  interface TabPage<T> { items: T[]; nextCursor: { ts: number; id: string } | null; hasMore: boolean }
  function emptyPage<T>(): TabPage<T>
  ```
  （两个定义放 App.tsx 模块顶层，`MemoryCard` 之前；Task 8 直接复用，不改签名。）

**说明：** 本 task 只做「全量数组 → 分页结构」的机械迁移：每 tab 仍只拉第 1 页（尚无无限滚动），UI 暂时只显示最新 50 条。这是有意的中间态——Task 8 加 loadMore/哨兵后完整。

- [ ] **Step 1: 改 import 与 state**

`src/web/App.tsx` import 行（:2-12）调整：`listMemories, listDiscards, listDistillRuns` 三个旧 wrapper 的引用换成 `listMemoriesPage, listDiscardsPage, listDistillRunsPage, WEB_PAGE_SIZE`（`listMemories` 若无其他使用点则从 import 删除；`type MemoryItem` 等类型 import 保留）；`./tab-cache` import 加 `mergePage`。

`App()` state（:52-66）替换为：

```ts
interface TabPage<T> { items: T[]; nextCursor: { ts: number; id: string } | null; hasMore: boolean }
function emptyPage<T>(): TabPage<T> { return { items: [], nextCursor: null, hasMore: true } }
```

（放模块顶层 `MemoryCard` 之前。）

```ts
const [tab, setTab] = useState<TabKey>('candidate')
const [memCache, setMemCache] = useState<Record<MemoryTabKey, TabPage<MemoryItem>>>({
  candidate: emptyPage(), approved: emptyPage(), rejected: emptyPage(),
})
const [discards, setDiscards] = useState<TabPage<DiscardItem>>(emptyPage())
const [runs, setRuns] = useState<TabPage<DistillRunListItem>>(emptyPage())
// loaded/pending/status/error/其余 state 不变
```

- [ ] **Step 2: 改 refresh**

```ts
async function refresh(target: TabKey) {
  setPending((p) => ({ ...p, [target]: true }))
  try {
    if (target === 'discards') {
      const [pg, st] = await Promise.all([listDiscardsPage(fetch, { limit: WEB_PAGE_SIZE }), getStatus()])
      setDiscards((d) => ({ items: mergePage(d.items, pg.items, (x) => x.id), nextCursor: pg.nextCursor, hasMore: pg.hasMore }))
      setStatus(st)
    } else if (target === 'runs') {
      const [pg, st] = await Promise.all([listDistillRunsPage(fetch, { limit: WEB_PAGE_SIZE }), getStatus(fetch)])
      setRuns((r) => ({ items: mergePage(r.items, pg.items, (x) => x.distillJobId), nextCursor: pg.nextCursor, hasMore: pg.hasMore }))
      setStatus(st)
    } else {
      const [pg, st] = await Promise.all([listMemoriesPage(fetch, { status: memoryTabFilter(target), limit: WEB_PAGE_SIZE }), getStatus()])
      setMemCache((c) => ({ ...c, [target]: { items: mergePage(c[target].items, pg.items, (x) => x.id), nextCursor: pg.nextCursor, hasMore: pg.hasMore } }))
      setStatus(st)
    }
    setLoaded((l) => ({ ...l, [target]: true }))
    setError(null)
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e))
  } finally {
    setPending((p) => ({ ...p, [target]: false }))
  }
}
```

- [ ] **Step 3: 改渲染读取与 bulkReject 内联读**

- `bulkRejectUnevaluated`（:141-148）里的 `(memCache.candidate).filter(...)` 改 `(memCache.candidate.items).filter(...)`（本 task 暂保客户端收集 id 的旧逻辑，Task 8 才换端点）。
- 渲染读取（:151-158）：

```ts
const memItems = sortCandidatesByTime(memCache[tab as MemoryTabKey]?.items ?? [])
const listEmpty = tab === 'discards' ? discards.items.length === 0
  : tab === 'runs' ? runs.items.length === 0
  : (memCache[tab as MemoryTabKey]?.items ?? []).length === 0
```

- 五分支：`{memItems.length} 条…` 不变（memItems 已是 items）；`runs.map` → `runs.items.map`（:383）；`共 {runs.length} 条` → `共 {runs.items.length} 条`（:382）；`discards.map` → `discards.items.map`（:393）；`{discards.length} 条` → `{discards.items.length} 条`（:392）；`runs.length === 0`/`discards.length === 0` 空态判断同理改 `.items.length`。

- [ ] **Step 4: 全量回归（中间态验收）**

```bash
bun run typecheck && bun test
```

Expected: 全绿（web-ui 文本断言/tab-cache/web-api/server 既有用例均不受此重构影响；`memCache: Record<MemoryTabKey, MemoryItem[]>` 旧结构已不存在——确认 web-ui.test.ts 无针对它的断言，若有则该断言按 Task 8 计划本就要改，提前在本 task 调整为 `TabPage<MemoryItem>`）。

- [ ] **Step 5: commit**

```bash
git add src/web/App.tsx
git commit -m "refactor(web): App state 分页化 TabPage + refresh 页 1 merge（中间态，仅首 50 条）"
```

---

### Task 8: App.tsx 无限滚动 + 操作本地更新 + 批量拒绝端点 + 回扫重置

**Files:**
- Modify: `src/web/App.tsx`（import、`loadMore` + refs、`useEffect` 哨兵、操作函数（:100-127）、`bulkRejectUnevaluated`（:141-148）、批量拒绝按钮可见性（:280-284）、列表尾部 UI、回扫重置 effect）
- Test: `tests/web-ui.test.ts`（追加文本断言）

**Interfaces:**
- Consumes: Task 5 全部 wrapper、Task 6 的 `mergeAppend`/`nextCursorAfter`、Task 7 的 `TabPage`/`emptyPage`
- Produces: 无新跨 task 接口（最终 task）

**两处对 spec 决策 7 的细化（实现时发现，语义更准）：**
- `archive`/`unarchive` 后记忆仍属 approved tab（filter 含 archived），**不本地移除**，改为本地 patch 该卡 `status` 字段（徽标/按钮即时切换）。
- `promote(discard)` 后 discard 行仍在 discards tab（显「已提升」），改为本地 patch `promotedMemoryId`（仅当 wrapper 返回了 memory；返回 undefined 时靠 refresh 页 1 自愈）。

- [ ] **Step 1: 追加失败测试（文本断言锚点）**

`tests/web-ui.test.ts` 追加：

```ts
// 五 tab 无限滚动（spec 2026-08-07）：哨兵 + loadMore + 分页缓存结构 +
// 服务端批量拒绝 + 回扫完成缓存重置。refactor 删掉任一锚点即红。
test('App.tsx infinite scroll anchors (source text)', () => {
  expect(src).toContain('IntersectionObserver')
  expect(src).toContain('loadMore')
  expect(src).toContain('nextCursor')
  expect(src).toContain('hasMore')
  expect(src).toContain('加载更多失败')
  expect(src).toContain('没有更多了')
})

test('App.tsx bulk-reject moved to server-side endpoint (source text)', () => {
  expect(src).toContain('bulk-reject-unevaluated')
  expect(src).toContain('unevaluatedCandidates')
})

test('App.tsx resets candidate cache on rescan completion (source text)', () => {
  expect(src).toContain('prevRescanRunning')
  expect(src).toContain('emptyPage')
})

test('App.tsx no legacy full-array memCache (source text)', () => {
  expect(src).not.toContain('Record<MemoryTabKey, MemoryItem[]>')
})
```

Run: `bun test tests/web-ui.test.ts` → Expected: FAIL（锚点不存在）

- [ ] **Step 2: import + refs + loadMore**

import 调整：`./tab-cache` 加 `mergeAppend, nextCursorAfter`；`./api` 加 `bulkRejectUnevaluated as bulkRejectUnevaluatedApi`（避免与本地函数同名）；`useRef` 加入 react import。

`App()` 内追加 state/refs：

```ts
const [loadingMore, setLoadingMore] = useState<Record<TabKey, boolean>>({ candidate: false, approved: false, rejected: false, discards: false, runs: false })
const [loadMoreError, setLoadMoreError] = useState<Record<TabKey, string | null>>({ candidate: null, approved: null, rejected: null, discards: null, runs: null })
const sentinelRef = useRef<HTMLDivElement | null>(null)
const loadMoreRef = useRef<(t: TabKey) => Promise<void>>(async () => {})
```

当前 tab 分页读取 helper（放 `refresh` 之后）：

```ts
function tabPageOf(target: TabKey): TabPage<MemoryItem> | TabPage<DiscardItem> | TabPage<DistillRunListItem> {
  return target === 'discards' ? discards : target === 'runs' ? runs : memCache[target as MemoryTabKey]
}
```

`loadMore`（守卫 → 拉下一页 → `mergeAppend` 追加）：

```ts
async function loadMore(target: TabKey) {
  if (pending[target] || loadingMore[target]) return
  const cur = tabPageOf(target)
  const before = nextCursorAfter(cur)
  if (!before) return // hasMore=false 或无游标
  setLoadingMore((l) => ({ ...l, [target]: true }))
  setLoadMoreError((e) => ({ ...e, [target]: null }))
  try {
    if (target === 'discards') {
      const pg = await listDiscardsPage(fetch, { limit: WEB_PAGE_SIZE, before })
      setDiscards((d) => ({ items: mergeAppend(d.items, pg.items, (x) => x.id), nextCursor: pg.nextCursor, hasMore: pg.hasMore }))
    } else if (target === 'runs') {
      const pg = await listDistillRunsPage(fetch, { limit: WEB_PAGE_SIZE, before })
      setRuns((r) => ({ items: mergeAppend(r.items, pg.items, (x) => x.distillJobId), nextCursor: pg.nextCursor, hasMore: pg.hasMore }))
    } else {
      const pg = await listMemoriesPage(fetch, { status: memoryTabFilter(target), limit: WEB_PAGE_SIZE, before })
      setMemCache((c) => ({ ...c, [target]: { items: mergeAppend(c[target].items, pg.items, (x) => x.id), nextCursor: pg.nextCursor, hasMore: pg.hasMore } }))
    }
  } catch (e) {
    setLoadMoreError((er) => ({ ...er, [target]: e instanceof Error ? e.message : String(e) }))
  } finally {
    setLoadingMore((l) => ({ ...l, [target]: false }))
  }
}
```

- [ ] **Step 3: 哨兵 effect**

```ts
// loadMoreRef 每渲染同步最新闭包，避免 Observer 回调拿陈旧 state
useEffect(() => { loadMoreRef.current = loadMore })

// 无限滚动哨兵：触底自动追加下一页；切 tab/卸载 disconnect（spec 决策 1）
useEffect(() => {
  const el = sentinelRef.current
  if (!el) return
  const obs = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) void loadMoreRef.current(tab)
  })
  obs.observe(el)
  return () => obs.disconnect()
}, [tab])
```

- [ ] **Step 4: 操作函数本地更新**

`approve`/`reject`/`restore`：调用后本地移除 + refresh（其余操作函数照旧）：

```ts
function removeFromTab(target: TabKey, id: string) {
  if (target === 'candidate' || target === 'approved' || target === 'rejected') {
    setMemCache((c) => ({ ...c, [target]: { ...c[target], items: c[target].items.filter((x) => x.id !== id) } }))
  } else if (target === 'discards') {
    setDiscards((d) => ({ ...d, items: d.items.filter((x) => x.id !== id) }))
  }
}

function patchInMemTab(target: MemoryTabKey, id: string, patch: Partial<MemoryItem>) {
  setMemCache((c) => ({
    ...c,
    [target]: { ...c[target], items: c[target].items.map((x) => (x.id === id ? { ...x, ...patch } : x)) },
  }))
}

async function approve(id: string) {
  await promoteMemory(id, { action: 'approve' })
  removeFromTab(tab, id)
  void refresh(tab)
}
async function reject(id: string) {
  await promoteMemory(id, { action: 'reject' })
  removeFromTab(tab, id)
  void refresh(tab)
}
async function archive(id: string) {
  await archiveMemory(id)
  if (tab === 'approved') patchInMemTab('approved', id, { status: 'archived' })
  void refresh(tab)
}
async function unarchive(id: string) {
  await unarchiveMemory(id)
  if (tab === 'approved') patchInMemTab('approved', id, { status: 'approved' })
  void refresh(tab)
}
async function restore(id: string) {
  await restoreMemory(id)
  removeFromTab(tab, id)
  void refresh(tab)
}
async function promote(id: string) {
  const m = await promoteDiscard(id)
  if (m) setDiscards((d) => ({ ...d, items: d.items.map((x) => (x.id === id ? { ...x, promotedMemoryId: m.id } : x)) }))
  void refresh(tab)
}
```

- [ ] **Step 5: 批量拒绝换服务端端点 + 按钮计数**

`bulkRejectUnevaluated`（:141-148）整体替换：

```ts
// 服务端按条件批量（spec 决策 4）：清空整个未评估尾队，不限于已加载部分。
// 返回后重置 candidate 缓存（决策 8）防已拒条目滞留，refresh 拉页 1 重建。
async function bulkRejectUnevaluated() {
  await bulkRejectUnevaluatedApi()
  setMemCache((c) => ({ ...c, candidate: emptyPage() }))
  void refresh('candidate')
}
```

按钮可见性（:280-284）由服务端计数驱动：

```tsx
{(status?.unevaluatedCandidates ?? 0) > 0 ? (
  <button onClick={() => bulkRejectUnevaluated()}>
    批量拒绝未评估 ({status!.unevaluatedCandidates})
  </button>
) : null}
```

（`priorityRank` 若因此无其他调用点则保留——`VALUE_LABEL`/`valueBadge` 仍用；确认 `priorityRank` 仅剩排序用途时不动它，`sortCandidatesByTime` 不含优先级排序，无影响。）

- [ ] **Step 6: 回扫完成重置 candidate 缓存（决策 8）**

```ts
// 回扫结束（完成/停止，running true->false 跳变）-> 候选池批量变更，
// 页 1 merge 感知不到已移出条目，重置 candidate 缓存防滞留（spec 决策 8）
const prevRescanRunning = useRef(false)
useEffect(() => {
  const running = status?.rescan?.running === true
  if (prevRescanRunning.current && !running) {
    setMemCache((c) => ({ ...c, candidate: emptyPage() }))
    if (tab === 'candidate') void refresh('candidate')
  }
  prevRescanRunning.current = running
}, [status])
```

- [ ] **Step 7: 列表尾部 UI（五分支共用，放分支条件渲染之后、两个 Modal 之前）**

```tsx
{error ? null : showLoading ? null : (
  <>
    <div ref={sentinelRef} style={{ height: 1 }} />
    {loadingMore[tab] ? <p style={{ color: '#888', fontSize: 13 }}>加载更多…</p> : null}
    {loadMoreError[tab] ? (
      <button style={{ fontSize: 13 }} onClick={() => void loadMore(tab)}>
        加载更多失败，点击重试（{loadMoreError[tab]}）
      </button>
    ) : null}
    {!tabPageOf(tab).hasMore && !listEmpty ? (
      <p style={{ color: '#aaa', fontSize: 12 }}>没有更多了</p>
    ) : null}
  </>
)}
```

- [ ] **Step 8: 全量回归 + commit**

```bash
bun run typecheck && bun test
git add src/web/App.tsx tests/web-ui.test.ts
git commit -m "feat(web): 五 tab 无限滚动（哨兵 loadMore）+ 操作本地更新 + 服务端批量拒绝 + 回扫缓存重置"
```

---

## Self-Review 记录（计划落档前已跑）

- **Spec 覆盖**：服务端分页形状 → Task 1/2/4；bulkRejectUnevaluated → Task 3/4/5/8；status 计数 → Task 4/5/8；mergePage/nextCursorAfter → Task 6/7；IntersectionObserver/loadMore/尾部三态 → Task 8；决策 8 缓存重置 → Task 8（回扫跳变 + 批量拒绝）；失败模式 2 重试按钮 → Task 8 Step 7；兼容锚点 → Task 4 分流 + Task 5 缺省降级测试。
- **类型一致性**：`Page<T>`/`PageCursor`（Task 1）= server HTTP 形状（Task 4）= `PageDto<T>`（Task 5）= `TabPage<T>`（Task 7）；`nextCursorAfter` 入参结构兼容 `TabPage`（结构子类型）。`mergePage`/`mergeAppend` key 选择器：记忆/discards 用 `x.id`，runs 用 `x.distillJobId`（Task 7/8 一致）。
- **占位符扫描**：Task 2 的 jobs insert 字段以 schema 校准（已注明参照文件），其余代码块均为可落代码。
- **已知中间态**：Task 7 完成后 UI 暂时只显示首 50 条（无翻页入口），Task 8 补齐——两 task 必须同 PR 交付，不得单独 merge Task 7。
