# 可编辑 scope 分类 + 标注来源项目 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在审批队列 UI 把记忆的 global/project 分类在 global⇄project 间切换（纠正 AI 误判），并在每条记忆上标注其来源项目（cwd）。

**Architecture:** `memories` 表新增独立 `source_cwd` 列（与 scope 解耦，蒸馏时从 `job.cwd` 写入，global 记忆不再丢失来源）；`patchMemory` 处理 `scopeType↔scopeId` 的 CHECK 耦合（global 清空 scopeId、project 回落 sourceCwd）；Web UI 加 scope 选择器与来源徽标。注入路径（`listApprovedByScope`/`formatMemoryBlock`）本就读行的 scope，编辑后自动生效，无需改动。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite(WAL) + React 19 + Vite；测试 bun:test。

## Global Constraints

- `bun run typecheck && bun test` 必须全绿才能 push（CLAUDE.md 运行门槛）。
- 严禁直推 `master`；本分支 `feat/editable-scope-and-source-project`，PR 合 `master`。
- 任何生产代码改动必须带测试；纯函数/纯数据层为首选可断言面，UI 层最低保留一条源代码层文本断言兜底。
- Web UI 复用 `src/web/App.tsx` 既有 inline 样式，不引新框架/不重写 chrome。
- `vite.config.ts` 的 proxy 键保持 `/api/`（带尾斜杠），勿与源码模块路径冲突。
- claude code/opencode 行为以源码为准；本计划不改动 hook 协议。

## File Structure

| 文件 | 职责 | 本计划动作 |
|------|------|-----------|
| `src/db/schema.ts` | drizzle 表定义 | 加 `sourceCwd` 列 |
| `src/db/client.ts` | openDb + DDL bootstrap | DDL 加列 + 幂等迁移 |
| `src/memory/store.ts` | 记忆 CRUD/状态机 | 透传 sourceCwd + patchMemory scope 耦合 |
| `src/scheduler.ts` | distill tick | tick 传 sourceCwd |
| `src/web/api.ts` | Web fetch 客户端 | 扩展 patchMemory 类型 + 错误抛出 |
| `src/web/App.tsx` | 审批队列 UI | 来源徽标 + scope 选择器 |
| `tests/schema.test.ts` | schema/迁移 | 加迁移测试 |
| `tests/store-crud.test.ts` | createCandidate | 加 sourceCwd 读写测试 |
| `tests/store-scope-edit.test.ts` | scope 编辑（新） | patch 单测 + 注入回归 |
| `tests/scheduler.test.ts` | tick | 加 sourceCwd 传入测试 |
| `tests/server.test.ts` | HTTP 契约 | 加 PATCH scope 测试 |
| `tests/web-api.test.ts` | 客户端契约 | 加 patchMemory scopeType + 错误测试 |
| `tests/web-ui.test.ts` | UI 兜底（新） | 源码层文本断言 |

---

## Task 1: DB schema + 旧库幂等迁移

**Files:**
- Modify: `src/db/schema.ts`（memories 表加列）
- Modify: `src/db/client.ts`（DDL 加列 + 迁移块）
- Test: `tests/schema.test.ts`

**Interfaces:**
- Produces: `memories.sourceCwd` 列（drizzle `sourceCwd: text('source_cwd')`，DB `source_cwd TEXT`，可空）；`openDb` 对旧库幂等 `ALTER TABLE ADD COLUMN source_cwd` + 回填 `source_cwd=scope_id WHERE scope_type='project'`。

- [ ] **Step 1: 写失败的迁移测试**

在 `tests/schema.test.ts` 顶部 import 区加 `import { Database } from 'bun:sqlite'`（保留现有 import）。在文件末尾追加：

```ts
test('fresh db has source_cwd column', () => {
  db = openDb(join(dir, 't3.db'))
  const cols = db.$client.prepare('PRAGMA table_info(memories)').all() as { name: string }[]
  expect(cols.some((c) => c.name === 'source_cwd')).toBe(true)
})

test('migration adds source_cwd to pre-existing db, backfills project rows, idempotent', () => {
  const dbPath = join(dir, 'old.db')
  // 旧形态库：无 source_cwd 列
  const old = new Database(dbPath)
  old.exec(`CREATE TABLE memories (id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_id TEXT, runtime TEXT, title TEXT NOT NULL, body_md TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, source_kind TEXT NOT NULL, source_event_id TEXT, distill_job_id TEXT, distill_action TEXT, supersedes_id TEXT, superseded_by_id TEXT, approved_at INTEGER, created_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1)`)
  old.exec(`INSERT INTO memories (id, scope_type, scope_id, title, body_md, tags, status, source_kind, created_at, version) VALUES ('p1','project','/oldproj','t','b','[]','candidate','manual',1,1)`)
  old.exec(`INSERT INTO memories (id, scope_type, scope_id, title, body_md, tags, status, source_kind, created_at, version) VALUES ('g1','global',NULL,'t','b','[]','candidate','manual',1,1)`)
  old.close()

  // openDb 跑 CREATE IF NOT EXISTS(no-op) + 迁移(ALTER + 回填)
  const migrated = openDb(dbPath)
  const cols = migrated.$client.prepare('PRAGMA table_info(memories)').all() as { name: string }[]
  expect(cols.some((c) => c.name === 'source_cwd')).toBe(true)
  const rows = migrated.$client.prepare('SELECT id, source_cwd FROM memories').all() as { id: string; source_cwd: string | null }[]
  expect(rows.find((r) => r.id === 'p1')!.source_cwd).toBe('/oldproj')
  expect(rows.find((r) => r.id === 'g1')!.source_cwd).toBeNull()
  migrated.$client.close()

  // 幂等：reopen 不抛（guard 跳过 ALTER，否则 duplicate column 报错）
  const reopened = openDb(dbPath)
  expect((reopened.$client.prepare('PRAGMA table_info(memories)').all() as { name: string }[]).some((c) => c.name === 'source_cwd')).toBe(true)
  reopened.$client.close()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/schema.test.ts`
Expected: 两个新测试 FAIL（`source_cwd` 列不存在，`cols.some(...)` 为 false）。

- [ ] **Step 3: 给 schema.ts 加列**

`src/db/schema.ts` 的 `memories` 表对象中，在 `sourceEventId: text('source_event_id'),` 这一行**之前**插入：

```ts
    sourceCwd: text('source_cwd'), // 来源项目 cwd；蒸馏来自 job.cwd，手动记忆为 null
```

- [ ] **Step 4: 给 client.ts DDL 加列 + 迁移块**

`src/db/client.ts` 的 `memories` CREATE TABLE 语句里，在 `source_event_id TEXT,` 这一行**之前**插入 `source_cwd TEXT,`。

然后在 `raw.exec(\`...\`)` 大块 DDL 之后、`return db` 之前，插入迁移块：

```ts
  // Idempotent migration: add source_cwd to pre-existing memories tables.
  // CREATE TABLE IF NOT EXISTS is a no-op on existing tables, so a column
  // added in a later release needs an explicit ALTER + backfill.
  {
    const cols = raw.prepare('PRAGMA table_info(memories)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'source_cwd')) {
      raw.exec('ALTER TABLE memories ADD COLUMN source_cwd TEXT')
      raw.exec("UPDATE memories SET source_cwd = scope_id WHERE scope_type = 'project' AND source_cwd IS NULL")
    }
  }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun test tests/schema.test.ts`
Expected: PASS（含两个新测试 + 原有两个测试仍绿）。

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/db/client.ts tests/schema.test.ts
git commit -m "feat(db): add source_cwd column with idempotent migration"
```

---

## Task 2: Store 透传 sourceCwd

**Files:**
- Modify: `src/memory/store.ts`（MemoryInput / Memory / rowToMemory / createCandidate）
- Test: `tests/store-crud.test.ts`

**Interfaces:**
- Consumes: `memories.sourceCwd` 列（Task 1）。
- Produces: `MemoryInput.sourceCwd?: string | null`；`Memory.sourceCwd: string | null`；`createCandidate` 写入并返回 `sourceCwd`；`rowToMemory` 透传；`getMemoryById` 读回。

- [ ] **Step 1: 写失败测试**

在 `tests/store-crud.test.ts` 末尾追加（文件已 import `createCandidate, getMemoryById`）：

```ts
test('createCandidate stores sourceCwd and reads it back', async () => {
  const m = await createCandidate(db, {
    scopeType: 'project', scopeId: '/r', title: 't', bodyMd: 'b',
    tags: [], sourceKind: 'conversation', runtime: null, sourceCwd: '/r',
  })
  expect(m.sourceCwd).toBe('/r')
  const got = await getMemoryById(db, m.id)
  expect(got?.memory.sourceCwd).toBe('/r')
})

test('createCandidate defaults sourceCwd to null when omitted', async () => {
  const m = await createCandidate(db, {
    scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b',
    tags: [], sourceKind: 'manual', runtime: null,
  })
  expect(m.sourceCwd).toBeNull()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/store-crud.test.ts`
Expected: FAIL（`m.sourceCwd` 为 `undefined`）。

- [ ] **Step 3: 改 store.ts**

在 `MemoryInput` 接口的 `runtime: RuntimeTag` 行之后加：

```ts
  sourceCwd?: string | null
```

在 `Memory` 接口的 `sourceKind: string` 行之后加：

```ts
  sourceCwd: string | null
```

在 `rowToMemory` 返回对象里（`sourceKind: r.sourceKind,` 之后）加：

```ts
    sourceCwd: r.sourceCwd ?? null,
```

在 `createCandidate` 的 `db.insert(memories).values({...})` 对象里（`sourceKind: input.sourceKind,` 之后）加：

```ts
    sourceCwd: input.sourceCwd ?? null,
```

在 `createCandidate` 的 `return rowToMemory({...})` 对象里（`sourceKind: input.sourceKind,` 之后）加：

```ts
    sourceCwd: input.sourceCwd ?? null,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/store-crud.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/memory/store.ts tests/store-crud.test.ts
git commit -m "feat(store): carry sourceCwd through MemoryInput/Memory/createCandidate"
```

---

## Task 3: patchMemory scope 耦合

**Files:**
- Modify: `src/memory/store.ts`（patchMemory 的 scope diff 块）
- Test: `tests/store-scope-edit.test.ts`（新）

**Interfaces:**
- Consumes: `Memory.sourceCwd`（Task 2）；`MemoryConflictError`（已 export）。
- Produces: `patchMemory` 在 `scopeType` 变更时自动管理 `scopeId`（global⇒null、project⇒sourceCwd），避免撞 CHECK；`scopeId`-only 改动仍校验不变量。

- [ ] **Step 1: 写失败测试**

新建 `tests/store-scope-edit.test.ts`：

```ts
import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { createCandidate, patchMemory, MemoryConflictError } from '@/memory/store'

const root = join(import.meta.dir, '.tmp-scope-edit')
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

afterEach(() => {
  db.$client.close()
})

test('patch project->global clears scopeId and bumps version', async () => {
  const m = await createCandidate(db, {
    scopeType: 'project', scopeId: '/r', title: 't', bodyMd: 'b',
    tags: [], sourceKind: 'conversation', runtime: null, sourceCwd: '/r',
  })
  const r = await patchMemory(db, m.id, { scopeType: 'global' })
  expect(r.memory.scopeType).toBe('global')
  expect(r.memory.scopeId).toBeNull()
  expect(r.memory.version).toBe(2)
  expect(r.changedFields).toContain('scopeType')
  expect(r.changedFields).toContain('scopeId')
})

test('patch global->project sets scopeId to sourceCwd', async () => {
  const m = await createCandidate(db, {
    scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b',
    tags: [], sourceKind: 'conversation', runtime: null, sourceCwd: '/r',
  })
  const r = await patchMemory(db, m.id, { scopeType: 'project' })
  expect(r.memory.scopeType).toBe('project')
  expect(r.memory.scopeId).toBe('/r')
  expect(r.changedFields).toContain('scopeType')
})

test('patch global->project without sourceCwd throws MemoryConflictError', async () => {
  const m = await createCandidate(db, {
    scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b',
    tags: [], sourceKind: 'manual', runtime: null,
  })
  await expect(patchMemory(db, m.id, { scopeType: 'project' })).rejects.toThrow(MemoryConflictError)
})

test('patch scopeId-only violating invariant throws', async () => {
  const m = await createCandidate(db, {
    scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b',
    tags: [], sourceKind: 'manual', runtime: null,
  })
  await expect(patchMemory(db, m.id, { scopeId: '/x' })).rejects.toThrow(MemoryConflictError)
})

test('patch scope unchanged is idempotent no-op', async () => {
  const m = await createCandidate(db, {
    scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b',
    tags: [], sourceKind: 'manual', runtime: null,
  })
  const r = await patchMemory(db, m.id, { scopeType: 'global' })
  expect(r.changedFields).toEqual([])
  expect(r.memory.version).toBe(1)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/store-scope-edit.test.ts`
Expected: FAIL（project->global 不会清 scopeId，会撞 CHECK 抛错或断言不符；global->project 不设 scopeId）。

- [ ] **Step 3: 改 patchMemory**

在 `src/memory/store.ts` 的 `patchMemory` 里，把这段：

```ts
    const changed: string[] = []
    const set: Record<string, unknown> = {}
    if (input.scopeType !== undefined && input.scopeType !== row.scopeType) {
      changed.push('scopeType')
      set.scopeType = input.scopeType
    }
    if (input.scopeId !== undefined && input.scopeId !== (row.scopeId ?? null)) {
      changed.push('scopeId')
      set.scopeId = input.scopeId
    }
```

替换为：

```ts
    const changed: string[] = []
    const set: Record<string, unknown> = {}
    if (input.scopeType !== undefined && input.scopeType !== row.scopeType) {
      changed.push('scopeType')
      set.scopeType = input.scopeType
      if (input.scopeType === 'global') {
        // global ⇒ scopeId must be null (CHECK invariant); auto-clear so a
        // scopeType-only patch can't leave a stale scopeId that violates it.
        if (row.scopeId !== null) { changed.push('scopeId'); set.scopeId = null }
      } else {
        // project ⇒ scopeId must be non-null; fall back to the memory's
        // source cwd (origin project), else require an explicit scopeId.
        const desired = input.scopeId !== undefined ? input.scopeId : (row.sourceCwd ?? null)
        if (desired === null) {
          throw new MemoryConflictError('project scope requires a sourceCwd or explicit scopeId')
        }
        if (desired !== (row.scopeId ?? null)) { changed.push('scopeId'); set.scopeId = desired }
      }
    } else if (input.scopeId !== undefined && input.scopeId !== (row.scopeId ?? null)) {
      // scopeId-only change (pre-existing capability): enforce the CHECK
      // invariant for the unchanged scopeType.
      if (row.scopeType === 'global' && input.scopeId !== null) {
        throw new MemoryConflictError('global scope requires null scopeId')
      }
      if (row.scopeType === 'project' && input.scopeId === null) {
        throw new MemoryConflictError('project scope requires non-null scopeId')
      }
      changed.push('scopeId')
      set.scopeId = input.scopeId
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/store-scope-edit.test.ts`
Expected: PASS（5 个测试全绿）。

- [ ] **Step 5: Commit**

```bash
git add src/memory/store.ts tests/store-scope-edit.test.ts
git commit -m "feat(store): patchMemory couples scopeType<->scopeId (global clears, project falls back to sourceCwd)"
```

---

## Task 4: 编辑 scope 后的注入回归

**Files:**
- Modify: `tests/store-scope-edit.test.ts`（追加回归测试，无生产代码改动）
- Test: 同上

**Interfaces:**
- Consumes: `patchMemory`（Task 3）、`listApprovedByScope`（已存在）、`memories`/`eq`（已存在）。

- [ ] **Step 1: 写测试**

在 `tests/store-scope-edit.test.ts` 顶部 import 行补 `eq`、`memories`、`listApprovedByScope`：

```ts
import { eq } from 'drizzle-orm'
import { memories } from '@/db/schema'
import { createCandidate, patchMemory, listApprovedByScope, MemoryConflictError } from '@/memory/store'
```

在文件末尾追加：

```ts
test('project->global then approved injects in any cwd', async () => {
  const m = await createCandidate(db, {
    scopeType: 'project', scopeId: '/r', title: 't', bodyMd: 'b',
    tags: [], sourceKind: 'conversation', runtime: null, sourceCwd: '/r',
  })
  await patchMemory(db, m.id, { scopeType: 'global' })
  await db.update(memories).set({ status: 'approved' }).where(eq(memories.id, m.id)).run()
  const set = await listApprovedByScope(db, { projectId: '/other', runtime: 'claude-code' })
  expect(set.byScope.global.length).toBe(1)
  expect(set.byScope.project.length).toBe(0)
})

test('global->project then approved injects only in source cwd', async () => {
  const m = await createCandidate(db, {
    scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b',
    tags: [], sourceKind: 'conversation', runtime: null, sourceCwd: '/r',
  })
  await patchMemory(db, m.id, { scopeType: 'project' })
  await db.update(memories).set({ status: 'approved' }).where(eq(memories.id, m.id)).run()
  const inSource = await listApprovedByScope(db, { projectId: '/r', runtime: 'claude-code' })
  expect(inSource.byScope.project.length).toBe(1)
  const inOther = await listApprovedByScope(db, { projectId: '/other', runtime: 'claude-code' })
  expect(inOther.byScope.project.length).toBe(0)
  expect(inOther.byScope.global.length).toBe(0)
})
```

- [ ] **Step 2: 跑测试确认通过**

Run: `bun test tests/store-scope-edit.test.ts`
Expected: PASS（含两个回归测试）。

- [ ] **Step 3: Commit**

```bash
git add tests/store-scope-edit.test.ts
git commit -m "test(store): regression - edited scope changes injection scope"
```

---

## Task 5: Scheduler tick 传 sourceCwd

**Files:**
- Modify: `src/scheduler.ts`（tick 的 createCandidate 调用）
- Test: `tests/scheduler.test.ts`

**Interfaces:**
- Consumes: `MemoryInput.sourceCwd`（Task 2）；`job.cwd`（已存在）。
- Produces: `tick` 把 `sourceCwd: job.cwd ?? null` 传入 `createCandidate`。

- [ ] **Step 1: 写失败测试**

在 `tests/scheduler.test.ts` 末尾追加（文件已 import `eq`、`enqueueDistillJob`、`tick`、`memoryDistillJobs`）：

```ts
test('tick passes sourceCwd from job.cwd into createCandidate', async () => {
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/proj/x', debounceKey: 'k1', debounceMs: 0,
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let captured: any = null
  await tick(db, {
    loadTranscript: async () => [{ role: 'user', content: 'something' }],
    callAnthropic: async () => JSON.stringify({
      candidates: [{ title: '[category:invariant] x', bodyMd: 'b', scope: 'global', runtime: null, distillAction: 'new' }],
    }),
    createCandidate: async (_db, input) => { captured = input; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(captured.sourceCwd).toBe('/proj/x')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/scheduler.test.ts`
Expected: FAIL（`captured.sourceCwd` 为 `undefined`）。

- [ ] **Step 3: 改 scheduler.ts**

在 `src/scheduler.ts` 的 `tick` 里，把 `await deps.createCandidate(db, { ... })` 调用对象中 `sourceKind: 'conversation',` 这一行之后加：

```ts
          sourceCwd: job.cwd ?? null,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/scheduler.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/scheduler.ts tests/scheduler.test.ts
git commit -m "feat(scheduler): pass job.cwd as sourceCwd into createCandidate"
```

---

## Task 6: Server PATCH scope HTTP 契约

**Files:**
- Modify: `tests/server.test.ts`（追加测试，无生产代码改动--`PATCH /api/memories/:id` 已透传 body）
- Test: 同上

**Interfaces:**
- Consumes: `patchMemory`（Task 3）、`createCandidate`（Task 2）。

- [ ] **Step 1: 写测试**

在 `tests/server.test.ts` 末尾追加（文件已 import `createCandidate`、`req`、`broadcastCalls`）：

```ts
test('PATCH /api/memories/:id edits scope project->global', async () => {
  const c = await createCandidate(db, {
    scopeType: 'project', scopeId: '/r', title: 't', bodyMd: 'b',
    tags: [], sourceKind: 'conversation', runtime: null, sourceCwd: '/r',
  })
  const r = await req(`/api/memories/${c.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ scopeType: 'global' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(200)
  expect(r.body.memory.scopeType).toBe('global')
  expect(r.body.memory.scopeId).toBeNull()
  expect(r.body.changedFields).toContain('scopeType')
  expect(broadcastCalls.some((m) => (m as any).type === 'memory.updated')).toBe(true)
})

test('PATCH /api/memories/:id global->project without sourceCwd returns 409', async () => {
  const c = await createCandidate(db, {
    scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b',
    tags: [], sourceKind: 'manual', runtime: null,
  })
  const r = await req(`/api/memories/${c.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ scopeType: 'project' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(409)
  expect(r.body.error).toBeTruthy()
})
```

- [ ] **Step 2: 跑测试确认通过**

Run: `bun test tests/server.test.ts`
Expected: PASS（route 已透传 body，Task 3 的 patchMemory 处理 scope）。

- [ ] **Step 3: Commit**

```bash
git add tests/server.test.ts
git commit -m "test(server): PATCH scope edit contract (200 + 409)"
```

---

## Task 7: Web api.ts 类型 + 错误抛出

**Files:**
- Modify: `src/web/api.ts`（MemoryItem + patchMemory 类型 + !res.ok 抛错）
- Test: `tests/web-api.test.ts`

**Interfaces:**
- Produces: `MemoryItem.sourceCwd?: string | null`、`MemoryItem.sourceKind?: string`；`patchMemory` body 接受 `scopeType?: 'project'|'global'`、`scopeId?: string|null`，且 `!res.ok` 时 `throw new Error(data.error ?? 'patch failed')`。

- [ ] **Step 1: 写失败测试**

在 `tests/web-api.test.ts` 顶部 import 改为 `import { listMemories, promoteMemory, patchMemory } from '@/web/api'`。末尾追加：

```ts
test('patchMemory PATCHes /api/memories/:id with scopeType in body', async () => {
  let captured: { url: string; method: string; body: string } | null = null
  const fetchFn = (async (url: string, init: any) => {
    captured = { url, method: init.method, body: init.body }
    return new Response(JSON.stringify({ memory: { id: '1', status: 'candidate' }, changedFields: ['scopeType'] }), { status: 200 })
  }) as any
  await patchMemory('1', { scopeType: 'global' }, fetchFn)
  expect(captured!.url).toBe('/api/memories/1')
  expect(captured!.method).toBe('PATCH')
  expect(captured!.body).toContain('scopeType')
})

test('patchMemory throws on non-OK response with server error message', async () => {
  const fetchFn = (async () =>
    new Response(JSON.stringify({ error: 'project scope requires a sourceCwd' }), { status: 409 })) as any
  await expect(patchMemory('1', { scopeType: 'project' }, fetchFn)).rejects.toThrow('sourceCwd')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/web-api.test.ts`
Expected: FAIL（`patchMemory` 未抛错；scopeType body 测试可能因类型缺失编译错--先跑看）。

- [ ] **Step 3: 改 api.ts**

`src/web/api.ts` 的 `MemoryItem` 接口，在 `runtime?: string | null` 之后加：

```ts
  sourceCwd?: string | null
  sourceKind?: string
```

把 `patchMemory` 的 body 类型与实现替换为：

```ts
export async function patchMemory(
  id: string,
  body: { title?: string; bodyMd?: string; tags?: string[]; scopeType?: 'project' | 'global'; scopeId?: string | null },
  fetchFn: FetchLike = fetch,
): Promise<MemoryItem> {
  const res = await fetchFn(`/api/memories/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
  const data = await res.json() as { memory?: MemoryItem; error?: string }
  if (!res.ok) throw new Error(data.error ?? 'patch failed')
  return data.memory as MemoryItem
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/web-api.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/web/api.ts tests/web-api.test.ts
git commit -m "feat(web): patchMemory accepts scopeType and throws on non-OK"
```

---

## Task 8: Web UI 来源徽标 + scope 选择器

**Files:**
- Modify: `src/web/App.tsx`（MemoryCard 来源展示 + scope 选择器；App.edit 签名）
- Test: `tests/web-ui.test.ts`（新，源码层文本断言）

**Interfaces:**
- Consumes: `MemoryItem.sourceCwd`/`sourceKind`、`patchMemory` scopeType（Task 7）。

- [ ] **Step 1: 写失败测试（源码层兜底）**

新建 `tests/web-ui.test.ts`：

```ts
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// 源代码层文本断言兜底（CLAUDE.md）：React 组件不便于单测，至少锁住"来源"
// 标注与 scope 编辑入口存在于 App.tsx。一旦被 refactor 删除会立刻变红。
const src = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')

test('App.tsx annotates source project', () => {
  expect(src).toContain('来源')
  expect(src).toContain('sourceCwd')
})

test('App.tsx exposes a scope edit control', () => {
  expect(src).toContain('scopeType')
})

test('App.tsx surfaces edit errors (spec §8)', () => {
  expect(src).toContain('editError')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/web-ui.test.ts`
Expected: FAIL（App.tsx 当前无 "来源" / scopeType 选择器）。

- [ ] **Step 3: 改 App.tsx**

把 `App.tsx` 顶部的 `edit` 函数替换为（接收 scopeType，交由 store 推导 scopeId）：

```tsx
  async function edit(id: string, title: string, bodyMd: string, scopeType: 'project' | 'global') {
    await patchMemory(id, { title, bodyMd, scopeType })
    void refresh()
  }
```

把 `MemoryCard` 的 props 类型里 `onEdit` 改为：

```tsx
  onEdit: (title: string, bodyMd: string, scopeType: 'project' | 'global') => Promise<void>
```

把 `MemoryCard` 组件体替换为（`save` 异步等待 `onEdit` 并捕获 409 等错误，避免 floating promise；spec §8 要求 UI 提示无来源项目等失败）：

```tsx
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(m.title)
  const [body, setBody] = useState(m.bodyMd ?? '')
  const [scope, setScope] = useState<'project' | 'global'>(m.scopeType === 'project' ? 'project' : 'global')
  const [editError, setEditError] = useState<string | null>(null)
  const sourceLabel = m.sourceCwd
    ? (m.sourceCwd.split(/[\\/]/).filter(Boolean).pop() ?? m.sourceCwd)
    : m.sourceKind === 'manual'
      ? '手动'
      : '未知'
  async function save() {
    setEditError(null)
    try {
      await onEdit(title, body, scope)
      setEditing(false)
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 16, marginBottom: 12 }}>
      {editing ? (
        <>
          <div style={{ marginBottom: 8 }}>
            <label style={{ marginRight: 12 }}>
              <input type="radio" checked={scope === 'project'} onChange={() => setScope('project')} /> project
            </label>
            <label>
              <input type="radio" checked={scope === 'global'} onChange={() => setScope('global')} /> global
            </label>
          </div>
          <input value={title} onChange={(e) => setTitle(e.target.value)} style={{ width: '100%', marginBottom: 8 }} />
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} style={{ width: '100%', marginBottom: 8 }} />
          <button onClick={save}>保存</button>
          <button onClick={() => setEditing(false)}>取消</button>
          {editError && <div style={{ color: '#c00', fontSize: 12, marginTop: 6 }}>{editError}</div>}
        </>
      ) : (
        <>
          <strong>{m.title}</strong>
          {m.bodyMd && <p style={{ color: '#555' }}>{m.bodyMd}</p>}
          <small>
            {m.scopeType} · {m.runtime ?? '任意 runtime'} · 来源: <span title={m.sourceCwd ?? ''}>{sourceLabel}</span>
          </small>
          <div style={{ marginTop: 8 }}>
            <button onClick={onApprove} style={{ marginRight: 8 }}>
              批准
            </button>
            <button onClick={onReject} style={{ marginRight: 8 }}>
              拒绝
            </button>
            <button onClick={() => { setEditError(null); setEditing(true) }}>编辑</button>
          </div>
        </>
      )}
    </div>
  )
```

把 `App` 里传给 `MemoryCard` 的 `onEdit` 改为：

```tsx
          onEdit={(t, b, s) => edit(m.id, t, b, s)}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/web-ui.test.ts`
Expected: PASS。

- [ ] **Step 5: 全量验证**

Run: `bun run typecheck && bun test`
Expected: typecheck 干净；全部测试绿（含原有 100+ 与新增测试）。

- [ ] **Step 6: Commit**

```bash
git add src/web/App.tsx tests/web-ui.test.ts
git commit -m "feat(web): show source-project badge and scope selector in approval card"
```

---

## 收尾：push + PR

- [ ] **Step 1: 最终门禁**

Run: `bun run typecheck && bun test`
Expected: 全绿。

- [ ] **Step 2: 推远端 + 开 PR**

```bash
git push -u origin feat/editable-scope-and-source-project
gh pr create --base master --title "feat: 可编辑 scope 分类 + 标注来源项目" --body "..."
```

PR body 摘要：来源项目建模为 `source_cwd` 列（与 scope 解耦）；UI 可 global⇄project 切换纠正 AI 误判；patchMemory 处理 scope↔scopeId CHECK 耦合；旧库幂等迁移+回填。

---

## Self-Review（写计划后自检）

**1. Spec 覆盖：**
- G1（编辑 scope）-> Task 3（patchMemory 耦合）+ Task 6（HTTP）+ Task 8（UI 选择器）。✅
- G2（标注来源）-> Task 1（source_cwd 列）+ Task 2（透传）+ Task 5（蒸馏写入）+ Task 8（UI 徽标）。✅
- §5.6 旧库迁移 -> Task 1 Step 4 + 测试。✅
- §8 失败模式（无 sourceCwd 抛 409）-> Task 3 + Task 6 + Task 7（客户端抛错）。✅
- §9 测试策略各项 -> Task 1/2/3/4/5/6/7/8 全覆盖。✅

**2. 占位扫描：** 无 TBD/TODO；每步含完整代码或确切命令。✅

**3. 类型一致性：** `sourceCwd` 在 MemoryInput/Memory/rowToMemory/createCandidate/scheduler 统一为 `string | null`；`MemoryConflictError` 引用一致；`patchMemory` 客户端 body 的 `scopeType` 类型与 App.edit 一致。✅
