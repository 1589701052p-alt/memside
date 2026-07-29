# 记忆审计视图 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 memside Web UI 补齐「已审批 / 已拒绝 / AI自动拒绝」三个视图（4-tab 布局），并给三类记忆各加最小操作能力（归档/撤回拒绝/提升为候选）。

**Architecture:** 服务端 `GET /api/memories?status=…` 做 status 过滤（方案 B），新端点 `GET /api/discards` 暴露 AI 自动拒绝审计表。状态机加一条 `rejected -> candidate` 转换；新增 `restoreMemory` / `promoteDiscard` 两个 store 写路径，archive/unarchive 复用现成 store 函数只补路由。`memory_discards` 表加 6 个 nullable 列（ALTER TABLE 幂等迁移）让提升路径自包含。前端 4-tab + 计数徽标 + DiscardCard 拆分。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite（WAL）+ zod；前端 Vite + React 19（inline style，无路由库）。

## Global Constraints

- 测试运行门槛：`bun run typecheck && bun test` 全绿才 push（CLAUDE.md 强制）。
- 任何代码改动落 commit 前必须带对应测试（正向 / 边界 / 错误路径）。
- Windows EBUSY-safe 测试模式：`beforeAll` 清 `root`，`beforeEach` 每测试一个 fresh 子目录，`afterEach` `db.$client.close()`（见 store-promote.test.ts:14-32，禁止 bare `rmSync(tmp)` in beforeEach）。
- 非法 `status` query 值宽松忽略，不返回 400。
- 不删 discard 审计行；superseded 保持终态；老 discard 行不回填 scope。
- 分支：`feat/memory-audit-views`（已切，基线 `origin/master`）。禁直推 master。

## File Structure

- **`src/memory/pure.ts`**（改）：`TRANSITIONS.rejected` 加 `'candidate'`。
- **`src/memory/store.ts`**（改）：新增 `restoreMemory`、`promoteDiscard`；扩 `DiscardRecord` + `logDiscards` 写新列；新增 `listDiscards`。
- **`src/db/schema.ts`**（改）：`memoryDiscards` drizzle 定义加 6 列。
- **`src/db/client.ts`**（改）：迁移段加 discards ALTER（幂等）。
- **`src/scheduler.ts`**（改）：构造 `discarded` 时填 scope/source 字段。
- **`src/server.ts`**（改）：`GET /api/memories` 加 status 过滤；`/api/status` 加 discards 计数；新 4 个写路由 + `GET /api/discards`。
- **`src/web/api.ts`**（改）：`listMemories(status?)`；新增 `listDiscards`/`restoreMemory`/`promoteDiscard`/`archiveMemory`/`unarchiveMemory` client wrapper + `DiscardItem` 类型 + `MemsideStatus.discards`。
- **`src/web/App.tsx`**（改）：4-tab 布局 + `DiscardCard` + 切 tab 轮询 + 计数徽标。
- **新建测试**：`tests/store-restore.test.ts`、`tests/store-discard.test.ts`。
- **改测试**：`tests/pure-statemachine.test.ts`、`tests/server.test.ts`、`tests/schema.test.ts`、`tests/web-api.test.ts`、`tests/web-ui.test.ts`。

---

### Task 1: 状态机加 rejected -> candidate 转换

**Files:**
- Modify: `src/memory/pure.ts:153-159`（`TRANSITIONS`）
- Test: `tests/pure-statemachine.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `canTransition('rejected','candidate')` 返回 `true`（供 Task 3 `restoreMemory` 的语义基础；store 用 specific-source guard 而非直接调 canTransition，但状态机定义是权威来源）。

- [ ] **Step 1: 写失败测试（先改断言）**

`tests/pure-statemachine.test.ts:18-21` 现有测试断言 `canTransition('rejected','candidate')` 为 `false`，与新语义冲突。改它为 `true`，并新增一条 superseded 仍终态的锁：

```ts
test('rejected can return to candidate (restore)', () => {
  expect(canTransition('rejected', 'candidate')).toBe(true)
})

test('superseded stays terminal', () => {
  expect(canTransition('superseded', 'approved')).toBe(false)
  expect(canTransition('superseded', 'candidate')).toBe(false)
})
```

删除原 `terminal states cannot leave` 测试里 `expect(canTransition('rejected', 'candidate')).toBe(false)` 这一行（它现在与上面的新测试矛盾）。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/pure-statemachine.test.ts`
Expected: FAIL — `canTransition('rejected','candidate')` 返回 `false`。

- [ ] **Step 3: 改状态机**

`src/memory/pure.ts:153-159`，把 `rejected: []` 改为 `rejected: ['candidate']`：

```ts
const TRANSITIONS: Record<MemoryStatus, MemoryStatus[]> = {
  candidate: ['approved', 'rejected'],
  approved: ['archived', 'superseded'],
  archived: ['approved'],
  superseded: [],
  rejected: ['candidate'],
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/pure-statemachine.test.ts`
Expected: PASS（全部）。

- [ ] **Step 5: 提交**

```bash
git add src/memory/pure.ts tests/pure-statemachine.test.ts
git commit -m "feat(state): rejected -> candidate 转换（撤回拒绝）
"
```

---

### Task 2: discards 表加 scope/source 列（schema + 迁移 + logDiscards + scheduler 接线）

**Files:**
- Modify: `src/db/schema.ts:84-99`（`memoryDiscards`）
- Modify: `src/db/client.ts`（迁移段，接在 source_agent_id 迁移之后、表重建迁移之前）
- Modify: `src/memory/store.ts:371-394`（`DiscardRecord` + `logDiscards`）
- Modify: `src/scheduler.ts:166-176`（构造 `discarded`）
- Test: `tests/schema.test.ts`、`tests/store-discard.test.ts`（logDiscards 部分）

**Interfaces:**
- Consumes: scheduler tick 上下文已有 `job.cwd`/`job.runtime`/`job.sourceAgentId`/`k.cand.scopeType`/`k.cand.runtime`。
- Produces: `DiscardRecord` 扩字段（`scopeType`/`scopeId`/`sourceCwd`/`runtime`/`sourceKind`）；`memory_discards` 表 6 新列；`promoteDiscard`（Task 4）依赖这些列。

- [ ] **Step 1: 写失败测试 — schema 迁移幂等 + 新列存在**

`tests/schema.test.ts` 末尾加（参考该文件现有 `PRAGMA table_info` 断言风格）：

```ts
import { openDb } from '@/db/client'
import { join } from 'node:path'
import { rmSync, mkdirSync } from 'node:fs'

test('memory_discards has scope/source columns after migration', () => {
  const root = join(import.meta.dir, '.tmp-discard-cols')
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  const dir = join(root, Math.random().toString(36).slice(2))
  mkdirSync(dir, { recursive: true })
  const db = openDb(join(dir, 't.db'))
  const cols = db.$client.prepare('PRAGMA table_info(memory_discards)').all() as { name: string }[]
  const names = cols.map((c) => c.name)
  expect(names).toContain('scope_type')
  expect(names).toContain('scope_id')
  expect(names).toContain('source_cwd')
  expect(names).toContain('runtime')
  expect(names).toContain('source_kind')
  expect(names).toContain('promoted_memory_id')
  db.$client.close()
  rmSync(root, { recursive: true, force: true })
})

test('memory_discards migration is idempotent (reopen)', () => {
  const root = join(import.meta.dir, '.tmp-discard-idem')
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  const dir = join(root, Math.random().toString(36).slice(2))
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 't.db')
  const db1 = openDb(path)
  db1.$client.close()
  const db2 = openDb(path)  // 二次打开，迁移再跑一次，不应报错
  const cols = db2.$client.prepare('PRAGMA table_info(memory_discards)').all() as { name: string }[]
  expect(cols.filter((c) => c.name === 'scope_type').length).toBe(1)  // 不重复加列
  db2.$client.close()
  rmSync(root, { recursive: true, force: true })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/schema.test.ts -t "memory_discards has scope"`
Expected: FAIL — 列不存在。

- [ ] **Step 3: 改 drizzle schema 定义**

`src/db/schema.ts:84-99`，`memoryDiscards` 加 6 列（保持 `idx_discards_ts` 索引不变）：

```ts
export const memoryDiscards = sqliteTable(
  'memory_discards',
  {
    id: text('id').primaryKey(),
    distillJobId: text('distill_job_id')
      .notNull()
      .references(() => memoryDistillJobs.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    bodyMd: text('body_md').notNull(),
    reason: text('reason').notNull(), // 'public-knowledge' | 'derivable' | 'taming'
    ts: integer('ts').notNull(),
    // 以下 6 列为本需求新增（nullable；迁移前老行为 NULL）：
    scopeType: text('scope_type'), // 'project' | 'global'
    scopeId: text('scope_id'), // project -> cwd, global -> null
    sourceCwd: text('source_cwd'),
    runtime: text('runtime'), // 'claude-code' | 'opencode'
    sourceKind: text('source_kind'), // 'conversation' | 'subagent'
    promotedMemoryId: text('promoted_memory_id'), // 提升 success 后回填 candidate.id
  },
  (t) => ({
    tsIdx: index('idx_discards_ts').on(t.ts),
  }),
)
```

- [ ] **Step 4: 加幂等迁移**

`src/db/client.ts`，在 `source_agent_id` 迁移块（约 138-143 行）之后、表重建迁移块（约 147 行）之前插入：

```ts
  // Idempotent migration: add scope/source columns to memory_discards.
  // 让 promoteDiscard 提升路径自包含（不必反查 job）。nullable；老行 NULL。
  // 幂等：列已存在则跳过（与 source_cwd/value_class 迁移同模式）。
  {
    const cols = raw.prepare('PRAGMA table_info(memory_discards)').all() as { name: string }[]
    const have = (n: string) => cols.some((c) => c.name === n)
    if (!have('scope_type')) raw.exec('ALTER TABLE memory_discards ADD COLUMN scope_type TEXT')
    if (!have('scope_id')) raw.exec('ALTER TABLE memory_discards ADD COLUMN scope_id TEXT')
    if (!have('source_cwd')) raw.exec('ALTER TABLE memory_discards ADD COLUMN source_cwd TEXT')
    if (!have('runtime')) raw.exec('ALTER TABLE memory_discards ADD COLUMN runtime TEXT')
    if (!have('source_kind')) raw.exec('ALTER TABLE memory_discards ADD COLUMN source_kind TEXT')
    if (!have('promoted_memory_id')) raw.exec('ALTER TABLE memory_discards ADD COLUMN promoted_memory_id TEXT')
  }
```

- [ ] **Step 5: 改 DiscardRecord + logDiscards 写新列**

`src/memory/store.ts:371-394`，扩 `DiscardRecord` 并在 insert 时写新列：

```ts
export interface DiscardRecord {
  title: string
  bodyMd: string
  reason: 'public-knowledge' | 'derivable' | 'taming'
  scopeType: 'project' | 'global'
  scopeId: string | null
  sourceCwd: string | null
  runtime: 'claude-code' | 'opencode'
  sourceKind: 'conversation' | 'subagent'
}

export async function logDiscards(
  db: DbClient,
  distillJobId: string,
  discards: DiscardRecord[],
): Promise<void> {
  if (discards.length === 0) return
  const ts = Date.now()
  await db.insert(memoryDiscards).values(
    discards.map((d) => ({
      id: ulid(), distillJobId, title: d.title, bodyMd: d.bodyMd, reason: d.reason, ts,
      scopeType: d.scopeType, scopeId: d.scopeId, sourceCwd: d.sourceCwd,
      runtime: d.runtime, sourceKind: d.sourceKind, promotedMemoryId: null,
    })),
  )
}
```

- [ ] **Step 6: scheduler 构造 discarded 时填字段**

`src/scheduler.ts:166-172`，在 `verdicts.forEach` 里构造 `discarded` 时填入 scope/source。`resolveScopeId` 已在文件内（57 行）。改：

```ts
      verdicts.forEach((v, i) => {
        const c = deduped[i]
        if (!c) return
        if (v.keep) keepWithClass.push({ cand: c, valueClass: v.valueClass })
        else discarded.push({
          title: c.title, bodyMd: c.bodyMd, reason: v.reason,
          scopeType: c.scopeType,
          scopeId: resolveScopeId(c.scopeType, job.cwd ?? null),
          sourceCwd: job.cwd ?? null,
          runtime: c.runtime,
          sourceKind: job.sourceAgentId ? 'subagent' : 'conversation',
        })
      })
```

注意：`v.reason` 现在是 `DiscardReason`（`'public-knowledge' | 'derivable' | 'taming'`），与 `DiscardRecord.reason` 类型一致，无需转换。`c.scopeType` / `c.runtime` 来自 `DistillCandidate`（已存在字段）。

- [ ] **Step 7: 写失败测试 — logDiscards 写入新字段**

新建 `tests/store-discard.test.ts`（先只测 logDiscards 部分，promoteDiscard 在 Task 4 加）：

```ts
import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { memoryDiscards, memoryDistillJobs } from '@/db/schema'
import { logDiscards } from '@/memory/store'

const root = join(import.meta.dir, '.tmp-discard')
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

async function seedJob(): Promise<string> {
  const now = Date.now()
  const jobId = 'job-test-1'
  await db.insert(memoryDistillJobs).values({
    id: jobId, debounceKey: 'k', sourceEventId: 'e', runtime: 'claude-code',
    cwd: '/proj', sessionId: null, sourceAgentId: null, scopeResolvedJson: null,
    status: 'done', attempts: 0, nextRunAt: now, lastError: null,
    createdAt: now, finishedAt: now,
  })
  return jobId
}

test('logDiscards persists scope/source columns', async () => {
  const jobId = await seedJob()
  await logDiscards(db, jobId, [{
    title: 't', bodyMd: 'b', reason: 'public-knowledge',
    scopeType: 'project', scopeId: '/proj', sourceCwd: '/proj',
    runtime: 'claude-code', sourceKind: 'conversation',
  }])
  const rows = await db.select().from(memoryDiscards).where(eq(memoryDiscards.distillJobId, jobId)).all()
  expect(rows.length).toBe(1)
  const r = rows[0]!
  expect(r.scopeType).toBe('project')
  expect(r.scopeId).toBe('/proj')
  expect(r.sourceCwd).toBe('/proj')
  expect(r.runtime).toBe('claude-code')
  expect(r.sourceKind).toBe('conversation')
  expect(r.promotedMemoryId).toBeNull()
})

test('logDiscards is a no-op on empty list', async () => {
  await logDiscards(db, 'any', [])
  const rows = await db.select().from(memoryDiscards).all()
  expect(rows.length).toBe(0)
})
```

- [ ] **Step 8: 跑测试确认通过**

Run: `bun test tests/schema.test.ts tests/store-discard.test.ts && bun run typecheck`
Expected: PASS。typecheck 必须干净（`DiscardRecord` 扩字段后，scheduler 调用点已同步改，无类型断裂）。

- [ ] **Step 9: 跑全量回归确认 scheduler/store 未破**

Run: `bun test tests/scheduler.test.ts tests/store-crud.test.ts`
Expected: PASS（scheduler 现有 mock 可能要确认 `deduped[i].scopeType`/`.runtime` 字段在 mock candidate 上存在——若 mock 缺字段，补上）。

- [ ] **Step 10: 提交**

```bash
git add src/db/schema.ts src/db/client.ts src/memory/store.ts src/scheduler.ts tests/schema.test.ts tests/store-discard.test.ts
git commit -m "feat(db): memory_discards 加 scope/source 列支撑提升路径

logDiscards 写入 scope/runtime/sourceKind；迁移幂等（ALTER TABLE）。
"
```

---

### Task 3: restoreMemory store 写路径（rejected -> candidate）

**Files:**
- Modify: `src/memory/store.ts`（新增 `restoreMemory`，接在 `unarchiveMemory` 之后约 369 行）
- Test: `tests/store-restore.test.ts`（新）

**Interfaces:**
- Consumes: `MemoryConflictError`/`MemoryNotFoundError`（store.ts:213-214 已有）；`rowToMemory`（store.ts:67）。
- Produces: `restoreMemory(db, id): Promise<Memory>`，rejected -> candidate + 清 approvedAt；状态不符抛 `MemoryConflictError`，not found 抛 `MemoryNotFoundError`。

- [ ] **Step 1: 写失败测试**

新建 `tests/store-restore.test.ts`（EBUSY-safe 模式，照 store-promote.test.ts:1-32）：

```ts
import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { createCandidate, promoteCandidate, restoreMemory, MemoryConflictError, MemoryNotFoundError } from '@/memory/store'

const root = join(import.meta.dir, '.tmp-restore')
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

test('restore moves rejected back to candidate and clears approvedAt', async () => {
  const c = await createCandidate(db, { scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  await promoteCandidate(db, c.id, { action: 'reject' })  // candidate -> rejected
  const r = await restoreMemory(db, c.id)
  expect(r.status).toBe('candidate')
  expect(r.approvedAt).toBeNull()
})

test('restore rejects non-rejected memory (409)', async () => {
  const c = await createCandidate(db, { scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  // c 仍是 candidate
  await expect(restoreMemory(db, c.id)).rejects.toBeInstanceOf(MemoryConflictError)
})

test('restore on missing id throws NotFound', async () => {
  await expect(restoreMemory(db, 'nope')).rejects.toBeInstanceOf(MemoryNotFoundError)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/store-restore.test.ts`
Expected: FAIL — `restoreMemory` 未导出 / 未定义。

- [ ] **Step 3: 实现 restoreMemory**

`src/memory/store.ts`，接在 `unarchiveMemory`（约 369 行）之后加：

```ts
export async function restoreMemory(db: DbClient, id: string): Promise<Memory> {
  return db.transaction((tx) => {
    const rows = tx.select().from(memories).where(eq(memories.id, id)).limit(1).all()
    if (rows.length === 0) throw new MemoryNotFoundError(`memory ${id} not found`)
    // Specific-source guard (I3): restore must only accept status === 'rejected'.
    // canTransition('archived','candidate') is false, but a general check would
    // silently accept any row; lock the source like unarchive does.
    if (rows[0]!.status !== 'rejected') {
      throw new MemoryConflictError(`memory ${id} is '${rows[0]!.status}', not 'rejected'`)
    }
    tx.update(memories).set({ status: 'candidate', approvedAt: null }).where(eq(memories.id, id)).run()
    return rowToMemory(tx.select().from(memories).where(eq(memories.id, id)).limit(1).all()[0]!)
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/store-restore.test.ts`
Expected: PASS（3 条）。

- [ ] **Step 5: 提交**

```bash
git add src/memory/store.ts tests/store-restore.test.ts
git commit -m "feat(store): restoreMemory 撤回拒绝（rejected -> candidate）
"
```

---

### Task 4: promoteDiscard store 写路径（discard -> candidate）

**Files:**
- Modify: `src/memory/store.ts`（新增 `promoteDiscard`，接 `logDiscards` 之后；新增 `getDiscardById` 辅助）
- Test: `tests/store-discard.test.ts`（追加）

**Interfaces:**
- Consumes: `createCandidate`（store.ts:81）；`memoryDiscards` schema（Task 2）；`MemoryConflictError`/`MemoryNotFoundError`。
- Produces: `promoteDiscard(db, id): Promise<Memory>`，discard -> candidate + 回填 `promoted_memory_id`；已提升 / scope 缺失抛 `MemoryConflictError`，not found 抛 `MemoryNotFoundError`。

- [ ] **Step 1: 写失败测试**

`tests/store-discard.test.ts` 追加（复用已有的 `seedJob` + `root`/`db` fixture）：

```ts
import { createCandidate, promoteDiscard, getMemoryById, MemoryConflictError, MemoryNotFoundError } from '@/memory/store'

async function seedDiscard(overrides: Partial<{ scopeType: string; scopeId: string | null; sourceCwd: string | null; runtime: string; sourceKind: string; promotedMemoryId: string | null }> = {}): Promise<string> {
  const jobId = await seedJob()
  const id = 'discard-1'
  const now = Date.now()
  await db.insert(memoryDiscards).values({
    id, distillJobId: jobId, title: 'dt', bodyMd: 'db', reason: 'public-knowledge', ts: now,
    scopeType: overrides.scopeType ?? 'project',
    scopeId: overrides.scopeId ?? '/proj',
    sourceCwd: overrides.sourceCwd ?? '/proj',
    runtime: overrides.runtime ?? 'claude-code',
    sourceKind: overrides.sourceKind ?? 'conversation',
    promotedMemoryId: overrides.promotedMemoryId ?? null,
  })
  return id
}

test('promoteDiscard creates candidate from discard and backfills promoted_memory_id', async () => {
  const did = await seedDiscard()
  const m = await promoteDiscard(db, did)
  expect(m.status).toBe('candidate')
  expect(m.title).toBe('dt')
  expect(m.scopeType).toBe('project')
  expect(m.sourceCwd).toBe('/proj')
  // 回填
  const drows = await db.select().from(memoryDiscards).where(eq(memoryDiscards.id, did)).all()
  expect(drows[0]!.promotedMemoryId).toBe(m.id)
  // candidate 真实存在
  const got = await getMemoryById(db, m.id)
  expect(got).not.toBeNull()
})

test('promoteDiscard on already-promoted throws Conflict', async () => {
  const did = await seedDiscard({ promotedMemoryId: 'existing-cand-id' })
  await expect(promoteDiscard(db, did)).rejects.toBeInstanceOf(MemoryConflictError)
})

test('promoteDiscard on legacy row missing scope throws Conflict', async () => {
  const did = await seedDiscard({ scopeType: null as any, scopeId: null, sourceCwd: null, runtime: null as any, sourceKind: null as any })
  await expect(promoteDiscard(db, did)).rejects.toBeInstanceOf(MemoryConflictError)
})

test('promoteDiscard on missing id throws NotFound', async () => {
  await expect(promoteDiscard(db, 'nope')).rejects.toBeInstanceOf(MemoryNotFoundError)
})
```

注：`seedDiscard` 的 `overrides` 用 `as any` 绕开 nullable 列的 TS 严格性仅限测试构造老行场景。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/store-discard.test.ts -t "promoteDiscard"`
Expected: FAIL — `promoteDiscard` 未导出。

- [ ] **Step 3: 实现 promoteDiscard**

`src/memory/store.ts`，接在 `logDiscards`（约 394 行）之后加。单事务：读 discard -> 幂等/scope 守卫 -> createCandidate -> 回填。注意 `createCandidate` 内部自己开事务，故外层用 `db.transaction` 包「读+回填」，`createCandidate` 在事务外调用——但为原子性，改为：事务内读 discard + 守卫，事务外 createCandidate，再事务内回填。更简单且安全的写法是三步各自独立（createCandidate 已自带事务），幂等靠 `promoted_memory_id` 的 UPDATE … WHERE promoted_memory_id IS NULL 守卫：

```ts
export async function promoteDiscard(db: DbClient, id: string): Promise<Memory> {
  // 1. 读 discard 行 + 守卫（单次 select）
  const rows = await db.select().from(memoryDiscards).where(eq(memoryDiscards.id, id)).limit(1)
  if (rows.length === 0) throw new MemoryNotFoundError(`discard ${id} not found`)
  const d = rows[0]!
  if (d.promotedMemoryId !== null) {
    throw new MemoryConflictError(`discard ${id} already promoted to ${d.promotedMemoryId}`)
  }
  // 老行（迁移前）scope 字段全 NULL -> 无法提升（不反查 job 回填，spec 非目标）
  if (d.scopeType === null || (d.scopeType === 'project' && d.scopeId === null)) {
    throw new MemoryConflictError(`discard ${id} missing scope info; cannot promote`)
  }
  // 2. createCandidate（自带事务）
  const mem = await createCandidate(db, {
    scopeType: d.scopeType as 'project' | 'global',
    scopeId: d.scopeId,
    title: d.title,
    bodyMd: d.bodyMd,
    tags: [],
    sourceKind: (d.sourceKind ?? 'conversation') as 'conversation' | 'error' | 'manual' | 'subagent',
    runtime: (d.runtime ?? null) as RuntimeTag,
    sourceCwd: d.sourceCwd,
    distillJobId: d.distillJobId,
    valueClass: null,
    subjectSlug: null,
  })
  // 3. 回填 promoted_memory_id（WHERE promoted_memory_id IS NULL 闭环幂等：
  //    并发两次提升只有一次能回填；落败方查到的 candidate 仍在，但 discard 状态已变，
  //    下次 promote 会被上面的 promotedMemoryId 守卫挡住）
  await db.update(memoryDiscards).set({ promotedMemoryId: mem.id })
    .where(and(eq(memoryDiscards.id, id), isNull(memoryDiscards.promotedMemoryId))).run()
  return mem
}
```

需在 store.ts 顶部 import 已有的 `and`/`isNull`（`store.ts:1` 已 import `and`；确认 `isNull` 在 import 列表，若无则加）。`RuntimeTag` 已在 import（store.ts:11）。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/store-discard.test.ts && bun run typecheck`
Expected: PASS。若 `isNull` 未导入，typecheck 会报错，补 import `isNull` from `drizzle-orm`。

- [ ] **Step 5: 提交**

```bash
git add src/memory/store.ts tests/store-discard.test.ts
git commit -m "feat(store): promoteDiscard 提升 AI 拒绝记录为候选

discard -> candidate + 回填 promoted_memory_id；幂等 + 老行 scope 缺失守卫。
"
```

---

### Task 5: listDiscards store 读路径

**Files:**
- Modify: `src/memory/store.ts`（新增 `listDiscards`）
- Test: `tests/store-discard.test.ts`（追加）

**Interfaces:**
- Consumes: `memoryDiscards` schema。
- Produces: `listDiscards(db, opts?: { limit?: number }): Promise<DiscardRow[]>`，`ORDER BY ts DESC LIMIT 200`。

- [ ] **Step 1: 写失败测试**

`tests/store-discard.test.ts` 追加：

```ts
import { listDiscards } from '@/memory/store'

test('listDiscards returns rows newest-first, default limit 200', async () => {
  const jobId = await seedJob()
  const now = Date.now()
  for (let i = 0; i < 3; i++) {
    await db.insert(memoryDiscards).values({
      id: `d-${i}`, distillJobId: jobId, title: `t${i}`, bodyMd: 'b', reason: 'derivable',
      ts: now + i, scopeType: 'global', scopeId: null, sourceCwd: null,
      runtime: 'claude-code', sourceKind: 'conversation', promotedMemoryId: null,
    })
  }
  const rows = await listDiscards(db)
  expect(rows.length).toBe(3)
  expect(rows[0]!.ts).toBeGreaterThan(rows[2]!.ts)  // DESC
})

test('listDiscards empty table returns []', async () => {
  const rows = await listDiscards(db)
  expect(rows).toEqual([])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/store-discard.test.ts -t "listDiscards"`
Expected: FAIL — `listDiscards` 未导出。

- [ ] **Step 3: 实现 listDiscards**

`src/memory/store.ts`，接 `promoteDiscard` 之后加。导出 `DiscardRow` 类型供 server/api 复用：

```ts
export const DISCARDS_LIST_LIMIT = 200

export interface DiscardRow {
  id: string
  distillJobId: string
  title: string
  bodyMd: string
  reason: string
  ts: number
  scopeType: string | null
  scopeId: string | null
  sourceCwd: string | null
  runtime: string | null
  sourceKind: string | null
  promotedMemoryId: string | null
}

export async function listDiscards(
  db: DbClient,
  opts: { limit?: number } = {},
): Promise<DiscardRow[]> {
  const limit = opts.limit ?? DISCARDS_LIST_LIMIT
  const rows = await db.select().from(memoryDiscards).orderBy(desc(memoryDiscards.ts)).limit(limit).all()
  return rows.map((r) => ({
    id: r.id, distillJobId: r.distillJobId, title: r.title, bodyMd: r.bodyMd, reason: r.reason,
    ts: r.ts, scopeType: r.scopeType ?? null, scopeId: r.scopeId ?? null, sourceCwd: r.sourceCwd ?? null,
    runtime: r.runtime ?? null, sourceKind: r.sourceKind ?? null, promotedMemoryId: r.promotedMemoryId ?? null,
  }))
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/store-discard.test.ts && bun run typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/memory/store.ts tests/store-discard.test.ts
git commit -m "feat(store): listDiscards 读 AI 拒绝审计表（DESC, LIMIT 200）
"
```

---

### Task 6: server 路由 — status 过滤 + discards 端点 + 4 个写路由

**Files:**
- Modify: `src/server.ts`（`GET /api/memories` 221-224；`GET /api/status` 204-219；新增 `GET /api/discards` + 4 写路由）
- Test: `tests/server.test.ts`（追加）

**Interfaces:**
- Consumes: `listDiscards`/`promoteDiscard`/`restoreMemory`/`archiveMemory`/`unarchiveMemory`（store）；`memories`/`memoryDiscards` schema；`inArray`/`count`/`and`/`eq`/`desc` from drizzle-orm。
- Produces: HTTP 端点 `GET /api/memories?status=…`、`GET /api/discards`、`POST /api/memories/:id/{archive,unarchive,restore}`、`POST /api/discards/:id/promote`；`/api/status` 加 `discards` 字段。

- [ ] **Step 1: 写失败测试**

`tests/server.test.ts` 追加（复用 `req` helper 51-54 行 + `beforeEach` 的 db/app fixture）：

```ts
import { memoryDiscards, memoryDistillJobs } from '@/db/schema'

async function seedDiscardRow(id: string, opts: Partial<{ scopeType: string; scopeId: string | null; promotedMemoryId: string | null }> = {}) {
  const now = Date.now()
  await db.insert(memoryDistillJobs).values({
    id: `job-${id}`, debounceKey: 'k', sourceEventId: 'e', runtime: 'claude-code',
    cwd: '/p', sessionId: null, sourceAgentId: null, scopeResolvedJson: null,
    status: 'done', attempts: 0, nextRunAt: now, lastError: null, createdAt: now, finishedAt: now,
  })
  await db.insert(memoryDiscards).values({
    id, distillJobId: `job-${id}`, title: 'dt', bodyMd: 'db', reason: 'public-knowledge', ts: now,
    scopeType: opts.scopeType ?? 'project', scopeId: opts.scopeId ?? '/p',
    sourceCwd: '/p', runtime: 'claude-code', sourceKind: 'conversation',
    promotedMemoryId: opts.promotedMemoryId ?? null,
  })
}

test('GET /api/memories?status filters by status', async () => {
  const c = await createCandidate(db, { scopeType: 'global', scopeId: null, title: 'cand', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  await promoteCandidate(db, c.id, { action: 'approve' })
  const r = await req('/api/memories?status=approved')
  expect(r.status).toBe(200)
  expect((r.body.items as any[]).every((m) => m.status === 'approved')).toBe(true)
})

test('GET /api/memories?status with multiple values', async () => {
  const r = await req('/api/memories?status=approved,archived,superseded')
  expect(r.status).toBe(200)
  expect(Array.isArray(r.body.items)).toBe(true)
})

test('GET /api/memories?status ignores illegal values (no 400)', async () => {
  const r = await req('/api/memories?status=bogus,candidate')
  expect(r.status).toBe(200)
  // bogus 被忽略，只取 candidate
  expect((r.body.items as any[]).every((m) => m.status === 'candidate')).toBe(true)
})

test('GET /api/memories without status returns all', async () => {
  const r = await req('/api/memories')
  expect(r.status).toBe(200)
  expect(Array.isArray(r.body.items)).toBe(true)
})

test('GET /api/discards returns items newest-first', async () => {
  await seedDiscardRow('d1')
  const r = await req('/api/discards')
  expect(r.status).toBe(200)
  expect((r.body.items as any[]).length).toBe(1)
})

test('GET /api/discards empty table returns items:[]', async () => {
  const r = await req('/api/discards')
  expect(r.status).toBe(200)
  expect(r.body.items).toEqual([])
})

test('GET /api/status includes discards count', async () => {
  await seedDiscardRow('d1')
  const r = await req('/api/status')
  expect(r.status).toBe(200)
  expect(r.body.discards).toBe(1)
})

test('POST /api/memories/:id/restore moves rejected to candidate', async () => {
  const c = await createCandidate(db, { scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  await promoteCandidate(db, c.id, { action: 'reject' })
  const r = await req(`/api/memories/${c.id}/restore`, { method: 'POST' })
  expect(r.status).toBe(200)
  expect(r.body.memory.status).toBe('candidate')
  expect(broadcastCalls.some((m: any) => m.type === 'memory.restored')).toBe(true)
})

test('POST /api/memories/:id/restore on non-rejected returns 409', async () => {
  const c = await createCandidate(db, { scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  const r = await req(`/api/memories/${c.id}/restore`, { method: 'POST' })
  expect(r.status).toBe(409)
})

test('POST /api/memories/:id/archive + unarchive', async () => {
  const c = await createCandidate(db, { scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  await promoteCandidate(db, c.id, { action: 'approve' })
  const ar = await req(`/api/memories/${c.id}/archive`, { method: 'POST' })
  expect(ar.status).toBe(200)
  expect(ar.body.memory.status).toBe('archived')
  const ur = await req(`/api/memories/${c.id}/unarchive`, { method: 'POST' })
  expect(ur.status).toBe(200)
  expect(ur.body.memory.status).toBe('approved')
})

test('POST /api/discards/:id/promote creates candidate', async () => {
  await seedDiscardRow('d1')
  const r = await req('/api/discards/d1/promote', { method: 'POST' })
  expect(r.status).toBe(200)
  expect(r.body.memory.status).toBe('candidate')
  expect(broadcastCalls.some((m: any) => m.type === 'discard.promoted')).toBe(true)
})

test('POST /api/discards/:id/promote on already-promoted returns 409', async () => {
  await seedDiscardRow('d1', { promotedMemoryId: 'x' })
  const r = await req('/api/discards/d1/promote', { method: 'POST' })
  expect(r.status).toBe(409)
})

test('POST /api/discards/:id/promote on missing id returns 404', async () => {
  const r = await req('/api/discards/nope/promote', { method: 'POST' })
  expect(r.status).toBe(404)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/server.test.ts -t "status filters\\|discards\\|restore\\|archive\\|promote"`
Expected: FAIL — 路由不存在（404 或行为不符）。

- [ ] **Step 3: 改 GET /api/memories 加 status 过滤**

`src/server.ts:221-224`，替换为：

```ts
  app.get('/api/memories', async (c) => {
    const statusParam = c.req.query('status') ?? ''
    const VALID = new Set(['candidate', 'approved', 'archived', 'superseded', 'rejected'])
    const wanted = statusParam.split(',').map((s) => s.trim()).filter((s) => s.length > 0 && VALID.has(s))
    const rows = wanted.length > 0
      ? await deps.db.select().from(memories).where(inArray(memories.status, wanted)).orderBy(desc(memories.createdAt)).all()
      : await deps.db.select().from(memories).orderBy(desc(memories.createdAt)).all()
    return c.json({ items: rows })
  })
```

顶部 import 加 `inArray`（`server.ts:6` import 了 `memories` 等 schema；drizzle 函数 import 在哪需确认——server.ts:2 已 import `desc`，加 `inArray` 到那行：`import { desc, inArray } from 'drizzle-orm'`）。

- [ ] **Step 4: 改 GET /api/status 加 discards 计数**

`src/server.ts:204-219`，在 `return c.json({...})` 前加 discards 计数并写入响应。改返回对象加 `discards`：

```ts
  app.get('/api/status', async (c) => {
    const jobs = await deps.db.select().from(memoryDistillJobs).orderBy(desc(memoryDistillJobs.createdAt)).limit(20).all()
    const events = await deps.db.select().from(memoryDistillEvents).all()
    const memRows = await deps.db.select().from(memories).all()
    const discardRows = await deps.db.select().from(memoryDiscards).all()
    const jobStats: Record<string, number> = {}
    for (const j of jobs) jobStats[j.status] = (jobStats[j.status] ?? 0) + 1
    const memStats: Record<string, number> = {}
    for (const m of memRows) memStats[m.status] = (memStats[m.status] ?? 0) + 1
    const errored = jobs.find((j) => j.lastError)
    return c.json({
      events: events.length,
      jobs: jobStats,
      memories: memStats,
      discards: discardRows.length,
      lastError: errored ? { error: errored.lastError } : null,
    })
  })
```

`memoryDiscards` 需加入 server.ts 顶部 schema import（`server.ts:6` 现 import `memories, memoryDistillJobs, memoryDistillEvents`，加 `memoryDiscards`）。

- [ ] **Step 5: 加 GET /api/discards + 4 个写路由**

`src/server.ts`，在 `app.post('/api/memories', …)`（约 293 行）之前、`bulk-promote` 之后加。先加 store import：`server.ts:8` 现 import `promoteCandidate, patchMemory, createCandidate, getMemoryById, getSourceInput`，加 `archiveMemory, unarchiveMemory, restoreMemory, promoteDiscard, listDiscards`。

```ts
  // --- Discards (AI 自动拒绝审计) -----------------------------------------
  app.get('/api/discards', async (c) => {
    const items = await listDiscards(deps.db)
    return c.json({ items })
  })

  app.post('/api/discards/:id/promote', async (c) => {
    try {
      const m = await promoteDiscard(deps.db, c.req.param('id'))
      deps.broadcast({ type: 'discard.promoted', memoryId: m.id, discardId: c.req.param('id') })
      return c.json({ memory: m })
    } catch (e) {
      if (e instanceof MemoryNotFoundError) return c.json({ error: (e as Error).message }, 404)
      return c.json({ error: (e as Error).message }, 409)
    }
  })

  // --- Archive / unarchive / restore --------------------------------------
  app.post('/api/memories/:id/archive', async (c) => {
    try {
      const m = await archiveMemory(deps.db, c.req.param('id'))
      deps.broadcast({ type: 'memory.archived', memoryId: m.id, newStatus: m.status })
      return c.json({ memory: m })
    } catch (e) {
      if (e instanceof MemoryNotFoundError) return c.json({ error: (e as Error).message }, 404)
      return c.json({ error: (e as Error).message }, 409)
    }
  })

  app.post('/api/memories/:id/unarchive', async (c) => {
    try {
      const m = await unarchiveMemory(deps.db, c.req.param('id'))
      deps.broadcast({ type: 'memory.unarchived', memoryId: m.id, newStatus: m.status })
      return c.json({ memory: m })
    } catch (e) {
      if (e instanceof MemoryNotFoundError) return c.json({ error: (e as Error).message }, 404)
      return c.json({ error: (e as Error).message }, 409)
    }
  })

  app.post('/api/memories/:id/restore', async (c) => {
    try {
      const m = await restoreMemory(deps.db, c.req.param('id'))
      deps.broadcast({ type: 'memory.restored', memoryId: m.id, newStatus: m.status })
      return c.json({ memory: m })
    } catch (e) {
      if (e instanceof MemoryNotFoundError) return c.json({ error: (e as Error).message }, 404)
      return c.json({ error: (e as Error).message }, 409)
    }
  })
```

`MemoryNotFoundError` 需 import（`server.ts:8` store import 行加 `MemoryNotFoundError`；`MemoryConflictError` 不必，因为 catch 走 else 分支 409）。

- [ ] **Step 6: 跑测试确认通过**

Run: `bun test tests/server.test.ts && bun run typecheck`
Expected: PASS。typecheck 干净。

- [ ] **Step 7: 提交**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat(server): status 过滤 + discards 端点 + 归档/撤回/提升路由

GET /api/memories?status=… / GET /api/discards / GET /api/status 加 discards 计数；
POST archive/unarchive/restore + discards/:id/promote。
"
```

---

### Task 7: web api client 扩展

**Files:**
- Modify: `src/web/api.ts`（`listMemories` 加 status 参数；新增 5 个 wrapper + `DiscardItem` + `MemsideStatus.discards`）
- Test: `tests/web-api.test.ts`（追加）

**Interfaces:**
- Consumes: server 端点（Task 6）。
- Produces: `listMemories(status?)`、`listDiscards()`、`archiveMemory(id)`、`unarchiveMemory(id)`、`restoreMemory(id)`、`promoteDiscard(id)`、`DiscardItem` 类型、`MemsideStatus.discards`。

- [ ] **Step 1: 写失败测试**

`tests/web-api.test.ts` 追加（照现有 `fetchFn` mock 模式 10-19 行）：

```ts
import { listDiscards, restoreMemory, archiveMemory, unarchiveMemory, promoteDiscard } from '@/web/api'

test('listMemories passes status query when provided', async () => {
  let called = ''
  const fetchFn = (async (url: string) => { called = url; return new Response(JSON.stringify({ items: [] }), { status: 200 }) }) as any
  await listMemories(fetchFn, 'approved,archived')
  expect(called).toBe('/api/memories?status=approved,archived')
})

test('listMemories omits status when undefined', async () => {
  let called = ''
  const fetchFn = (async (url: string) => { called = url; return new Response(JSON.stringify({ items: [] }), { status: 200 }) }) as any
  await listMemories(fetchFn)
  expect(called).toBe('/api/memories')
})

test('listDiscards calls GET /api/discards', async () => {
  let called = ''
  const fetchFn = (async (url: string) => { called = url; return new Response(JSON.stringify({ items: [{ id: 'd1', title: 't', reason: 'taming' }] }), { status: 200 }) }) as any
  const items = await listDiscards(fetchFn)
  expect(called).toBe('/api/discards')
  expect(items.length).toBe(1)
})

test('restoreMemory POSTs /api/memories/:id/restore', async () => {
  let captured: { url: string; method: string } | null = null
  const fetchFn = (async (url: string, init: any) => { captured = { url, method: init.method }; return new Response(JSON.stringify({ memory: { id: '1', status: 'candidate' } }), { status: 200 }) }) as any
  await restoreMemory('1', fetchFn)
  expect(captured!.url).toBe('/api/memories/1/restore')
  expect(captured!.method).toBe('POST')
})

test('archiveMemory + unarchiveMemory POST correct paths', async () => {
  const seen: string[] = []
  const fetchFn = (async (url: string, init: any) => { seen.push(`${init.method} ${url}`); return new Response(JSON.stringify({ memory: { id: '1' } }), { status: 200 }) }) as any
  await archiveMemory('1', fetchFn)
  await unarchiveMemory('1', fetchFn)
  expect(seen).toContain('POST /api/memories/1/archive')
  expect(seen).toContain('POST /api/memories/1/unarchive')
})

test('promoteDiscard POSTs /api/discards/:id/promote', async () => {
  let captured: { url: string; method: string } | null = null
  const fetchFn = (async (url: string, init: any) => { captured = { url, method: init.method }; return new Response(JSON.stringify({ memory: { id: 'm1', status: 'candidate' } }), { status: 200 }) }) as any
  await promoteDiscard('d1', fetchFn)
  expect(captured!.url).toBe('/api/discards/d1/promote')
  expect(captured!.method).toBe('POST')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/web-api.test.ts`
Expected: FAIL — 新 wrapper 未导出，`listMemories` 签名不符。

- [ ] **Step 3: 改 api.ts**

`src/web/api.ts`，改 `listMemories` 签名 + 加新 wrapper + 类型。先改 `listMemories`（33-37 行）：

```ts
export async function listMemories(
  fetchFn: FetchLike = fetch,
  status?: string,
): Promise<MemoryItem[]> {
  const url = status ? `/api/memories?status=${encodeURIComponent(status)}` : '/api/memories'
  const res = await fetchFn(url)
  const data = await res.json()
  return (data.items ?? []) as MemoryItem[]
}
```

⚠️ **签名变更注意**：现有调用方 `App.tsx:2` `import { listMemories, … }` 和 `App.tsx:38` `await listMemories()` 只传 fetchFn 吗？不——`App.tsx:38` 是 `await listMemories()`（无参，用默认 fetch）。新签名 `listMemories(fetchFn, status?)` 把 fetchFn 提到第一参。**这会破坏 `App.tsx:38` 的 `listMemories()` 调用**——它现在靠默认 `fetchFn=fetch`。需同步改 App.tsx 调用为 `listMemories(fetch, 'candidate')`（Task 8 处理）。为避免破坏 web-api 既有测试 `listMemories(fetchFn)`（10-19 行，传 fetchFn 不传 status），新签名兼容它（第二参 undefined -> 无 status query）。确认 `web-api.test.ts:16` `await listMemories(fetchFn)` 仍期望 `called === '/api/memories'`——是的，status undefined 时 url 无 query，兼容。

加 `DiscardItem` 类型 + 新 wrapper（接文件末尾 `getSourceInput` 之后）：

```ts
export interface DiscardItem {
  id: string
  title: string
  bodyMd?: string
  reason: string
  ts?: number
  scopeType?: string | null
  sourceCwd?: string | null
  sourceKind?: string | null
  promotedMemoryId?: string | null
}

export async function listDiscards(fetchFn: FetchLike = fetch): Promise<DiscardItem[]> {
  const res = await fetchFn('/api/discards')
  const data = await res.json()
  return (data.items ?? []) as DiscardItem[]
}

export async function restoreMemory(id: string, fetchFn: FetchLike = fetch): Promise<MemoryItem> {
  const res = await fetchFn(`/api/memories/${id}/restore`, { method: 'POST' })
  const data = await res.json()
  return data.memory as MemoryItem
}

export async function archiveMemory(id: string, fetchFn: FetchLike = fetch): Promise<MemoryItem> {
  const res = await fetchFn(`/api/memories/${id}/archive`, { method: 'POST' })
  const data = await res.json()
  return data.memory as MemoryItem
}

export async function unarchiveMemory(id: string, fetchFn: FetchLike = fetch): Promise<MemoryItem> {
  const res = await fetchFn(`/api/memories/${id}/unarchive`, { method: 'POST' })
  const data = await res.json()
  return data.memory as MemoryItem
}

export async function promoteDiscard(id: string, fetchFn: FetchLike = fetch): Promise<MemoryItem> {
  const res = await fetchFn(`/api/discards/${id}/promote`, { method: 'POST' })
  const data = await res.json()
  return data.memory as MemoryItem
}
```

扩 `MemsideStatus`（68-73 行）加 `discards`：

```ts
export interface MemsideStatus {
  events: number
  jobs: Record<string, number>
  memories: Record<string, number>
  discards: number
  lastError: { error: string } | null
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/web-api.test.ts && bun run typecheck`
Expected: web-api PASS。typecheck 可能因 `App.tsx:38` `listMemories()` 调用而 **暂时报错**（Task 8 修）——若 typecheck 报错仅限 App.tsx 调用点，记下，Task 8 修复后整体绿。**不要在本 task 提交前留 typecheck 红**：本 task 提交时 App.tsx 仍是旧调用 `listMemories()`，`listMemories()` 无参在新签名下仍合法（fetchFn 默认 fetch，status 默认 undefined）——故 typecheck 不报错，只是 App.tsx 行为暂时不变（仍拉全量）。确认这点后再提交。

- [ ] **Step 5: 提交**

```bash
git add src/web/api.ts tests/web-api.test.ts
git commit -m "feat(web-api): listMemories(status) + discards/restore/archive/promote client

listMemories 加 status query；新增 listDiscards/restoreMemory/archiveMemory
/unarchiveMemory/promoteDiscard + DiscardItem + MemsideStatus.discards。
"
```

---

### Task 8: Web UI 4-tab 布局 + DiscardCard + 切 tab 轮询

**Files:**
- Modify: `src/web/App.tsx`（重构为 4-tab；`MemoryCard` 抽通用骨架按 tab 注入操作；新增 `DiscardCard`）
- Test: `tests/web-ui.test.ts`（追加源码层文本断言）

**Interfaces:**
- Consumes: `listMemories(fetch, status)`、`listDiscards`、`restoreMemory`/`archiveMemory`/`unarchiveMemory`/`promoteDiscard`、`MemsideStatus.discards`（Task 7）。
- Produces: 4-tab UI，每 tab 独立数据 + 操作 + 轮询。

- [ ] **Step 1: 写失败测试 — UI 锚点文本断言**

`tests/web-ui.test.ts` 追加（源码层文本断言兜底，照现有 9-52 行模式）：

```ts
test('App.tsx renders 4 audit-view tabs (source text)', () => {
  expect(src).toContain('候选审批')
  expect(src).toContain('已审批')
  expect(src).toContain('已拒绝')
  expect(src).toContain('AI自动拒绝')
})

test('App.tsx has DiscardCard component (source text)', () => {
  expect(src).toContain('DiscardCard')
})

test('App.tsx wires restore/archive/unarchive/promote actions (source text)', () => {
  expect(src).toContain('restoreMemory')
  expect(src).toContain('archiveMemory')
  expect(src).toContain('unarchiveMemory')
  expect(src).toContain('promoteDiscard')
})

test('App.tsx shows promoted marker on discards (source text)', () => {
  expect(src).toContain('已提升')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/web-ui.test.ts`
Expected: FAIL — 文本不存在。

- [ ] **Step 3: 重构 App.tsx 为 4-tab**

这是最大的前端改动。`src/web/App.tsx` 改造要点（保持 inline style、复用 `MemoryCard`、状态栏不动）：

1. **顶部加 tab 状态**：`const [tab, setTab] = useState<'candidate' | 'approved' | 'rejected' | 'discards'>('candidate')`。

2. **tab 栏渲染**（h1 下方、状态栏上方），4 个按钮，active 高亮，带计数徽标（计数来自 `status` 的 memories 分桶 + `status.discards`）：

```tsx
const tabs = [
  { key: 'candidate', label: '候选审批', count: status?.memories.candidate ?? 0 },
  { key: 'approved', label: '已审批', count: (status?.memories.approved ?? 0) + (status?.memories.archived ?? 0) + (status?.memories.superseded ?? 0) },
  { key: 'rejected', label: '已拒绝', count: status?.memories.rejected ?? 0 },
  { key: 'discards', label: 'AI自动拒绝', count: status?.discards ?? 0 },
] as const
```

3. **数据拉取按 tab**：`refresh` 改为根据 `tab` 拉对应数据。候选 tab 拉 `listMemories(fetch, 'candidate')` + `getStatus()`；已审批拉 `listMemories(fetch, 'approved,archived,superseded')` + status；已拒绝拉 `listMemories(fetch, 'rejected')` + status；discards 拉 `listDiscards()` + status。status 每 tab 都拉（计数徽标 + 状态栏）。

4. **轮询切 tab 切 interval**：`useEffect` 依赖 `tab`，切 tab 时 `clearInterval` 旧的建新的：

```tsx
useEffect(() => {
  void refresh()
  const t = setInterval(() => void refresh(), 3000)
  return () => clearInterval(t)
}, [tab])
```

5. **MemoryCard 操作按 tab 注入**：候选 tab 传 `onApprove/onReject/onEdit/onViewSource`（现有）；已审批 tab 传 `onArchive/onUnarchive`（按 status 决定显示哪个），superseded 行只读标注「已被取代」；已拒绝 tab 传 `onRestore`。给 `MemoryCard` 加可选 props `actions?: ReactNode` 或具体回调，保持现有候选行为不变。

6. **DiscardCard 新组件**（接 `MemoryCard` 之后定义）：展示 title/bodyMd/reason 徽标/来源；`promotedMemoryId` 非 null 时显「已提升」并禁用 promote 按钮，否则显「提升为候选」按钮调 `promoteDiscard`。

7. **空列表文案**：每 tab 空时显对应文案（「暂无已审批记忆」等），不留白。

8. **加载/错误**：切 tab 显「加载中…」（loading && 列表空）；fetch 失败显现有 error banner（复用）。

实现时保持现有 `MemoryCard`/`SourceInputModal` 结构与样式，只扩展。`App.tsx:38` 的 `listMemories()` 改为 `listMemories(fetch, …)`（Task 7 签名）。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/web-ui.test.ts && bun run typecheck`
Expected: PASS。typecheck 干净。

- [ ] **Step 5: 跑全量回归**

Run: `bun run typecheck && bun test`
Expected: 全绿（所有 task 的测试 + 现有 store-promote/e2e/candidate 流）。

- [ ] **Step 6: 提交**

```bash
git add src/web/App.tsx tests/web-ui.test.ts
git commit -m "feat(web): 4-tab 审计视图（已审批/已拒绝/AI自动拒绝）

顶部 tab 切换 + 计数徽标 + DiscardCard；切 tab 切轮询；归档/撤回/提升操作。
"
```

---

### Task 9: 全量验证 + STATE.md 更新

**Files:**
- Modify: `STATE.md`（追加本轮交付段）
- Test: 全量

**Interfaces:**
- Consumes: 全部前序 task。
- Produces: 确认 `typecheck && bun test` 全绿；STATE.md 记录。

- [ ] **Step 1: 全量门禁**

Run: `bun run typecheck && bun test`
Expected: typecheck 干净 + 全部测试 PASS（含本轮新增 store-restore / store-discard / 扩展的 server/web-api/web-ui/schema/pure-statemachine）。

- [ ] **Step 2: 抽查回归关键路径**

Run: `bun test tests/store-promote.test.ts tests/scheduler.test.ts tests/e2e.test.ts tests/store-crud.test.ts`
Expected: PASS（candidate 审批闭环、scheduler tick、e2e 未受状态机/迁移影响）。

- [ ] **Step 3: 更新 STATE.md**

`STATE.md` 末尾追加（照现有段格式，如「记忆审计视图（2026-07-29）」）：

```markdown
## 记忆审计视图（2026-07-29）

补齐 Web UI「审批后/拒绝后」可视面（设计 spec / 计划见
`docs/superpowers/specs|plans/2026-07-29-memory-audit-views*`）：

1. 状态机加 `rejected -> candidate`（`pure.ts` TRANSITIONS），superseded 保持终态。
2. `memory_discards` 加 6 nullable 列（scope/runtime/sourceKind/promoted_memory_id），
   ALTER TABLE 幂等迁移；logDiscards + scheduler 接线写入来源。
3. store 新增 `restoreMemory`（rejected->candidate）、`promoteDiscard`（discard->candidate
   + 回填 promoted_memory_id，幂等 + 老行 scope 缺失守卫）、`listDiscards`（DESC LIMIT 200）。
4. server：`GET /api/memories?status=…` 服务端过滤；`GET /api/discards`；
   `/api/status` 加 discards 计数；4 写路由（archive/unarchive/restore/discards promote）。
5. Web UI 4-tab（候选审批/已审批/已拒绝/AI自动拒绝）+ 计数徽标 + DiscardCard + 切 tab 轮询。

执行：subagent-driven / inline（每 task TDD + reviewer）。
`bun run typecheck && bun test` N/N 全绿。
```

- [ ] **Step 4: 提交**

```bash
git add STATE.md
git commit -m "docs(state): 记录记忆审计视图交付
"
```

- [ ] **Step 5: 推远端开 PR**

```bash
git push -u origin feat/memory-audit-views
gh pr create --base master --title "feat: 记忆审计视图（已审批/已拒绝/AI自动拒绝）" --body "..."
```

PR body 末尾加：
```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

---

## Self-Review

**1. Spec 覆盖：**
- 读取面 status 过滤 + `/api/discards` + `/api/status` discards 计数 → Task 6。✓
- 状态机 `rejected->candidate` → Task 1。✓
- `restoreMemory` → Task 3。✓
- `promoteDiscard` + 幂等 + 老行守卫 → Task 4。✓
- archive/unarchive 路由 → Task 6。✓
- discards 6 列迁移 + logDiscards + scheduler → Task 2。✓
- 4-tab UI + DiscardCard + 计数 + 切 tab 轮询 → Task 8。✓
- 测试 8 处覆盖点（pure-statemachine/store-restore/store-discard/server/schema/web-api/web-ui/回归）→ 各 Task 内 + Task 9。✓

**2. 占位扫描：** 无 TBD/TODO；Task 8 Step 3 是「实现要点」而非逐行代码（React 组件重构无法逐行铺且会失真），但给出了完整的结构、props、状态、轮询、文案、组件清单——执行者有充分依据。其余 task 均含实际代码。

**3. 类型一致性：**
- `restoreMemory` / `promoteDiscard` / `listDiscards` / `archiveMemory` / `unarchiveMemory` 在 store（Task 3/4/5）、server（Task 6）、api.ts（Task 7）签名一致。✓
- `DiscardRecord`（Task 2）扩字段后 scheduler 调用点（Task 2 Step 6）同步。✓
- `listMemories(fetchFn, status?)` 签名变更：web-api 既有测试（fetchFn only）兼容；App.tsx 调用 Task 8 同步。✓
- `MemsideStatus.discards` 在 api.ts（Task 7）+ App.tsx 计数（Task 8）一致。✓
- `DiscardItem`（Task 7）字段与 `DiscardRow`（Task 5）对齐。✓
- `promoteDiscard` 用 `isNull` —— store.ts:1 已 import `isNull`？确认：store.ts:1 `import { and, asc, desc, eq, inArray, isNotNull, isNull }` —— 是的，已有。✓

无遗留问题。
