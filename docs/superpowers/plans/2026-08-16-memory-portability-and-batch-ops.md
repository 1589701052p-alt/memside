# 记忆可移植性与批量操作 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 memside 增加回收站机制（删→可恢复/清空不可恢复）、批量删除、批量导出（memside JSON 高保真 + Markdown 低保真）、文件导入（两格式自动识别 + 三冲突策略），让记忆库可备份/迁移/分享。

**Architecture:** 新增 `memory_trash` 表（沿用 `memory_discards` 审计表模式）。新增纯函数层 `src/memory/exchange.ts`（serialize/parse JSON+Markdown，主力测试面）与 `src/memory/trash.ts`（快照往返）。存储层在 `store.ts` 加 `bulkDeleteMemories`/`restoreFromTrash`/`emptyTrash`/`importMemories`/`listMemoriesForExport`/`listTrashPage`/`listTrashFacets`。服务端 `server.ts` 加 7 路由。UI `App.tsx` 加回收站 tab + per-tab 多选 + 批量操作条 + 导出导入入口。`importMemories` 是恢复与文件导入共享的高保真 seam（绕过 `createCandidate` 的 `status:'candidate'` 硬编码）。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite + zod + React 19。无新依赖（multipart 用 Hono `c.req.parseBody`；Blob 下载用浏览器原生 API；ULID 复用现有 `ulid`）。

**Spec:** `docs/superpowers/specs/2026-08-16-memory-portability-and-batch-ops-design.md`

## Global Constraints

- **测试门禁**：`bun run typecheck && bun test` 必须全绿才 push。每个代码任务带测试（纯函数层写足、运行时层留集成断言 + UI 源码层文本兜底）。
- **路径别名**：`@/*` → `src/*`（tsconfig paths）。`src/web/` 无 `@` alias（vite 不配），web 副本走相对 import（既有 D7 决策）。
- **状态机不动**：`TRANSITIONS`（`pure.ts:155-161`）零改动。`createCandidate`（`store.ts:91`）不改；`importMemories` 是独立的新函数。
- **事务模式**：写路径用 `db.transaction((tx) => {...})`（bun:sqlite 同步，回调内不 await）；或裸 `db.$client.exec('BEGIN'/'ROLLBACK'/'COMMIT')`（见 `upsertSessionEvent` store.ts:1082）。删除 = 单事务内 `DELETE memories + INSERT memory_trash`。
- **迁移幂等**：`CREATE TABLE IF NOT EXISTS memory_trash`（client.ts DDL 块）。冗余列在 DDL 内，不需要 ALTER。
- **无分页导出上限**（YAGNI，3000 条量级可控）；导入条数 cap 10000（超限 400）。
- **冲突策略**：`'skip'`（已存在跳过）/`'overwrite'`（删旧写新，保留 id）/`'newid'`（生成新 ULID 新增）。恢复默认 `skip`（安全，不暴露 overwrite）；文件导入暴露三策略。
- **broadcast seam**：每个变更路由调 `deps.broadcast(...)`（`server.ts:36`）。批量删/恢复走 loop-and-swallow + 末尾单条聚合 broadcast（与 `bulk-reject-unevaluated` 同模式）。
- **vite proxy 陷阱**：新前端请求路径必须带尾斜杠前缀或与源码模块路径不冲突（既有 `/api/` 带尾斜杠）。
- **commit 规范**：commit 末尾带 `Co-Authored-By: Claude <noreply@anthropic.com>`。

---

## File Structure

**新增文件：**
- `src/memory/exchange.ts` — 纯函数层：memside JSON + Markdown 的 serialize/parse + 格式自动识别。单一职责，可充分单测。
- `src/memory/trash.ts` — 纯函数层：`snapshotMemory`/`restoreFromSnapshot`（Memory ↔ JSON 字符串往返，schema 演进容错）。
- `tests/exchange.test.ts` — exchange 纯函数测试（主力）。
- `tests/trash.test.ts` — trash 快照往返纯函数测试。
- `tests/store-trash-import.test.ts` — store 层 trash + importMemories + export list 事务/冲突测试。
- `tests/server-trash-import-export.test.ts` — 服务端 7 路由集成测试。

**修改文件：**
- `src/db/schema.ts` — 加 `memoryTrash` 表定义（drizzle）。
- `src/db/client.ts` — DDL 块加 `CREATE TABLE IF NOT EXISTS memory_trash`；`schema` map 注册 `memoryTrash`。
- `src/memory/store.ts` — 加 `TrashRow`/`listTrashPage`/`listTrashFacets`/`bulkDeleteMemories`/`restoreFromTrash`/`emptyTrash`/`importMemories`/`listMemoriesForExport`；导出 `TrashRow` 类型。
- `src/memory/pure.ts` — 不动核心；仅在文件末尾加 `MemoryStatus` 已有的地方无变更（确认）。
- `src/server.ts` — 加 7 路由 + `/api/status` 加 `trashCount`。
- `src/web/api.ts` — 加 `bulkDelete`/`exportMemories`/`importMemories`/`listTrashPage`/`getTrash`/`restoreFromTrash`/`emptyTrash` wrapper + `TrashItem` 类型 + `MemsideStatus.trashCount` 字段。
- `src/web/tab-cache.ts` — `isListTab` 加 `'trash'`；`tabTotalCount` 加 trash 分支。
- `src/web/App.tsx` — `TabKey` 加 `'trash'`；`selectedIds` per-tab state；`MemoryCard` 加 selection props；新 `TrashCard`；导出/导入入口 + 文件下载/上传；批量操作条。
- `src/web/ui-utils.ts` — （可选）若需要回收站专用徽标，复用既有 `categoryInfo`/`valueClassInfo`/`scopeInfo`。

**零改动：** `src/memory/distiller.ts`、`src/scheduler.ts`、`src/daemon.ts`、`src/install.ts`、`src/memory/pure.ts`（核心）。

---

## Task 1: memory_trash 表 schema + 迁移

**Files:**
- Modify: `src/db/schema.ts`（文件末尾追加表定义）
- Modify: `src/db/client.ts:5`（schema import）+ `:14`（schema map）+ `:145`（DDL 块末尾追加）
- Test: `tests/schema.test.ts`（既有文件，加一表存在性断言）

**Interfaces:**
- Consumes: 无（基础设施）
- Produces: `memoryTrash` drizzle 表（`src/db/schema.ts` 导出）；DDL 已落地，`openDb` 后 `memory_trash` 表存在。

**memory_trash 表定义**（spec §数据模型）：

```ts
export const memoryTrash = sqliteTable(
  'memory_trash',
  {
    id: text('id').primaryKey(),
    memorySnapshot: text('memory_snapshot').notNull(), // 完整 Memory JSON
    originalMemoryId: text('original_memory_id').notNull(),
    scopeType: text('scope_type').notNull(),
    scopeId: text('scope_id'),
    sourceCwd: text('source_cwd'),
    runtime: text('runtime'),
    deletedAt: integer('deleted_at').notNull(),
    title: text('title').notNull(),
    valueClass: text('value_class'),
    subjectSlug: text('subject_slug'),
  },
  (t) => ({
    deletedAtIdx: index('idx_trash_deleted_at').on(t.deletedAt),
    originalIdx: index('idx_trash_original').on(t.originalMemoryId),
  }),
)
```

- [ ] **Step 1: 写失败测试**

在 `tests/schema.test.ts` 末尾加（确认 `memory_trash` 表与列存在）：

```ts
test('memory_trash table exists with required columns', () => {
  const cols = db.$client.prepare('PRAGMA table_info(memory_trash)').all() as { name: string }[]
  const names = cols.map((c) => c.name)
  expect(names).toContain('id')
  expect(names).toContain('memory_snapshot')
  expect(names).toContain('original_memory_id')
  expect(names).toContain('deleted_at')
  expect(names).toContain('title')
  // 索引存在
  const idx = db.$client.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memory_trash'").all() as { name: string }[]
  expect(idx.some((i) => i.name === 'idx_trash_deleted_at')).toBe(true)
})
```

（若 `tests/schema.test.ts` 无既有 `db`/`beforeEach`，参考其现有 fixture 模式；该文件已有 openDb tmp 模式。）

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/schema.test.ts`
Expected: FAIL（`memory_trash` 表不存在，PRAGMA 返回空）

- [ ] **Step 3: 在 `src/db/schema.ts` 末尾加 `memoryTrash` 表定义**（用上面的代码块，import `index` 已在文件头 `import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'`）。

- [ ] **Step 4: 在 `src/db/client.ts:5` 的 import 加 `memoryTrash`**

```ts
import { memories, memoryDistillJobs, memoryDistillEvents, memoryDiscards, memorySessionOffsets, memoryDistillInputs, memoryDistillRuns, appSettings, memorySessionFlushes, memorySessionDigests, memoryDegradations, notifications, memoryTrash } from './schema'
```

- [ ] **Step 5: 在 `src/db/client.ts:14` 的 `drizzle(raw, { schema: {...} })` map 加 `memoryTrash`**

在 `notifications` 后加 `, memoryTrash`。

- [ ] **Step 6: 在 `src/db/client.ts` DDL 块（`:145` `idx_notifications_read` 之后、return 之前）追加 memory_trash 建表 DDL**

```ts
    CREATE TABLE IF NOT EXISTS memory_trash (
      id TEXT PRIMARY KEY,
      memory_snapshot TEXT NOT NULL,
      original_memory_id TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id TEXT,
      source_cwd TEXT,
      runtime TEXT,
      deleted_at INTEGER NOT NULL,
      title TEXT NOT NULL,
      value_class TEXT,
      subject_slug TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_trash_deleted_at ON memory_trash(deleted_at);
    CREATE INDEX IF NOT EXISTS idx_trash_original ON memory_trash(original_memory_id);
```

- [ ] **Step 7: 跑测试确认通过**

Run: `bun test tests/schema.test.ts`
Expected: PASS

- [ ] **Step 8: 全量门禁**

Run: `bun run typecheck && bun test`
Expected: PASS（既有全绿 + 新测试绿）

- [ ] **Step 9: Commit**

```bash
git add src/db/schema.ts src/db/client.ts tests/schema.test.ts
git commit -m "feat(db): memory_trash 回收站表 + 幂等迁移（spec §数据模型）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: trash 快照纯函数（snapshotMemory / restoreFromSnapshot）

**Files:**
- Create: `src/memory/trash.ts`
- Test: `tests/trash.test.ts`

**Interfaces:**
- Consumes: `Memory` 类型（`store.ts:41`，但为避免 store↔trash 循环依赖，trash.ts 只 import 类型）。`Memory` 是 `src/memory/store.ts` 的 interface。这里 import `type { Memory } from './store'`（类型 import 不产生运行时循环）。
- Produces:
  - `snapshotMemory(m: Memory): string` — Memory → JSON 字符串（用于写入 `memory_trash.memory_snapshot`）。
  - `restoreFromSnapshot(snapshot: string): Memory | null` — JSON 字符串 → Memory；解析失败/缺字段返回 null（schema 演进容错，缺失字段返回 null 而非崩溃）。

- [ ] **Step 1: 写失败测试**

`tests/trash.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { snapshotMemory, restoreFromSnapshot } from '@/memory/trash'
import type { Memory } from '@/memory/store'

// 回收站快照往返：Memory ↔ JSON 字符串全字段还原（spec §失败模式 #6 schema 演进容错）。
const base: Memory = {
  id: '01ABC', scopeType: 'project', scopeId: '/repo', runtime: 'claude-code',
  title: '[category:convention] x', bodyMd: 'body', tags: ['a', 'b'], status: 'approved',
  sourceKind: 'manual', sourceCwd: '/repo', sourceEventId: null, distillJobId: null,
  distillAction: null, supersedesId: null, supersededById: null, approvedAt: 123, createdAt: 456,
  version: 2, valueClass: 'convention', subjectSlug: 'my-slug', origin: 'user-stated', evidence: '原话',
}

test('snapshotMemory → restoreFromSnapshot 全字段往返', () => {
  const s = snapshotMemory(base)
  const restored = restoreFromSnapshot(s)
  expect(restored).toEqual(base)
})

test('restoreFromSnapshot 解析失败返回 null（不抛）', () => {
  expect(restoreFromSnapshot('not json')).toBeNull()
  expect(restoreFromSnapshot('{')).toBeNull()
  expect(restoreFromSnapshot('null')).toBeNull()
})

test('restoreFromSnapshot 缺字段容错（旧 snapshot 演进）', () => {
  // 旧 snapshot 没有 origin/evidence/valueClass —— 恢复时这些字段应回 null，不崩
  const old = { ...base, origin: undefined, evidence: undefined, valueClass: undefined, subjectSlug: undefined }
  const s = JSON.stringify(old)
  const r = restoreFromSnapshot(s)
  expect(r).not.toBeNull()
  expect(r!.origin).toBeNull()
  expect(r!.evidence).toBeNull()
  expect(r!.valueClass).toBeNull()
  expect(r!.subjectSlug).toBeNull()
})

test('restoreFromSnapshot tags 非数组降级为空数组', () => {
  const s = JSON.stringify({ ...base, tags: 'oops' })
  const r = restoreFromSnapshot(s)
  expect(r).not.toBeNull()
  expect(r!.tags).toEqual([])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/trash.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/memory/trash.ts`**

```ts
import type { Memory } from './store'
import type { MemoryScope, MemoryStatus, RuntimeTag } from './pure'
import type { ValueClass } from './valueFilter'
import type { DistillOrigin } from './distiller'

/** 空快照默认值（缺字段时回退，schema 演进容错）。 */
const EMPTY: Omit<Memory, 'id' | 'scopeType' | 'title' | 'bodyMd' | 'status' | 'sourceKind' | 'createdAt' | 'version' | 'tags'> = {
  scopeId: null, runtime: null, sourceCwd: null, sourceEventId: null, distillJobId: null,
  distillAction: null, supersedesId: null, supersededById: null, approvedAt: null,
  valueClass: null, subjectSlug: null, origin: null, evidence: null,
}

/** Memory → JSON 字符串快照（写入 memory_trash.memory_snapshot）。 */
export function snapshotMemory(m: Memory): string {
  return JSON.stringify(m)
}

function asString(v: unknown): string { return typeof v === 'string' ? v : '' }
function asStrOrNull(v: unknown): string | null { return typeof v === 'string' ? v : null }
function asNum(v: unknown): number { return typeof v === 'number' && Number.isFinite(v) ? v : 0 }
function asNumOrNull(v: unknown): number | null { return typeof v === 'number' && Number.isFinite(v) ? v : null }
function asStrArray(v: unknown): string[] { return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [] }

/**
 * JSON 字符串 → Memory。解析失败/非对象返回 null；缺失字段回默认（null/0/[]），
 * 永不抛（spec §失败模式 #6：未来 Memory 加字段时旧 snapshot 缺字段不崩）。
 */
export function restoreFromSnapshot(snapshot: string): Memory | null {
  let p: any
  try { p = JSON.parse(snapshot) } catch { return null }
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return null
  return {
    id: asString(p.id),
    scopeType: (p.scopeType === 'project' || p.scopeType === 'global' ? p.scopeType : 'global') as MemoryScope,
    scopeId: asStrOrNull(p.scopeId),
    runtime: (p.runtime === 'claude-code' || p.runtime === 'opencode' || p.runtime === null ? p.runtime : null) as RuntimeTag,
    title: asString(p.title),
    bodyMd: asString(p.bodyMd),
    tags: asStrArray(p.tags),
    status: (['candidate','approved','archived','superseded','rejected'].includes(p.status) ? p.status : 'candidate') as MemoryStatus,
    sourceKind: asString(p.sourceKind),
    sourceCwd: asStrOrNull(p.sourceCwd),
    sourceEventId: asStrOrNull(p.sourceEventId),
    distillJobId: asStrOrNull(p.distillJobId),
    distillAction: asStrOrNull(p.distillAction),
    supersedesId: asStrOrNull(p.supersedesId),
    supersededById: asStrOrNull(p.supersededById),
    approvedAt: asNumOrNull(p.approvedAt),
    createdAt: asNum(p.createdAt),
    version: asNum(p.version),
    valueClass: asStrOrNull(p.valueClass) as ValueClass | null,
    subjectSlug: asStrOrNull(p.subjectSlug),
    origin: asStrOrNull(p.origin) as DistillOrigin | null,
    evidence: asStrOrNull(p.evidence),
    ...EMPTY,
  }
}
```

注意：`...EMPTY` 在末尾确保缺字段回 null（但会覆盖已设的合法值？不——`...EMPTY` 只含永远-null 默认值的字段，若 `p` 已提供合法值，前面已显式赋值，`EMPTY` 覆盖会把它们变回 null）。**修正**：不用 `...EMPTY`，逐字段用 helper 已处理缺字段。删除 `EMPTY` 与 `...EMPTY` 行，保留逐字段赋值（缺失 → null/0/''/[]）。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/trash.test.ts`
Expected: PASS

- [ ] **Step 5: 全量门禁**

Run: `bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/memory/trash.ts tests/trash.test.ts
git commit -m "feat(memory): trash 快照纯函数 snapshotMemory/restoreFromSnapshot（spec §数据模型）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: exchange 纯函数 — memside JSON serialize/parse

**Files:**
- Create: `src/memory/exchange.ts`
- Test: `tests/exchange.test.ts`

**Interfaces:**
- Consumes: `Memory` 类型（`store.ts:41`，`type { Memory } from './store'`）。
- Produces（本任务只实现 JSON 部分；Markdown 在 Task 4）：
  - `serializeMemoriesJson(memories: Memory[]): string` — 返回 `{ format, version, exportedAt, memories }` envelope JSON 字符串。
  - `parseMemoriesJson(text: string): { memories: Memory[]; errors: string[] }` — 校验 envelope + 逐条解析；非法条目跳过计 errors。
  - 常量 `MEMSIDE_JSON_FORMAT = 'memside-memories'`、`MEMSIDE_JSON_VERSION = 1`。
  - `detectExchangeFormat(text: string): 'json' | 'markdown'` — 自动识别（本任务实现 json 分支：JSON.parse 成功且 `format===MEMSIDE_JSON_FORMAT` → 'json'；其余 → 'markdown'）。

envelope 结构（spec §导出/导入格式 §1）：

```json
{ "format": "memside-memories", "version": 1, "exportedAt": 1723760000000, "memories": [ ...Memory ] }
```

- [ ] **Step 1: 写失败测试**

`tests/exchange.test.ts`（JSON 部分；先写这些，Markdown 部分在 Task 4 追加）：

```ts
import { test, expect } from 'bun:test'
import { serializeMemoriesJson, parseMemoriesJson, detectExchangeFormat, MEMSIDE_JSON_FORMAT } from '@/memory/exchange'
import type { Memory } from '@/memory/store'

const mk = (over: Partial<Memory> = {}): Memory => ({
  id: '01A', scopeType: 'global', scopeId: null, runtime: null,
  title: '[category:convention] x', bodyMd: 'b', tags: ['t'], status: 'approved',
  sourceKind: 'manual', sourceCwd: null, sourceEventId: null, distillJobId: null,
  distillAction: null, supersedesId: null, supersededById: null, approvedAt: 100, createdAt: 200,
  version: 1, valueClass: 'convention', subjectSlug: 's', origin: 'user-stated', evidence: 'e',
  ...over,
})

test('serializeMemoriesJson → parseMemoriesJson 全字段往返', () => {
  const ms = [mk({ id: '1' }), mk({ id: '2', tags: ['a', 'b'], status: 'archived', approvedAt: null })]
  const text = serializeMemoriesJson(ms)
  const { memories, errors } = parseMemoriesJson(text)
  expect(errors).toEqual([])
  expect(memories).toEqual(ms)
})

test('serializeMemoriesJson 产出 envelope', () => {
  const text = serializeMemoriesJson([mk()])
  const obj = JSON.parse(text)
  expect(obj.format).toBe(MEMSIDE_JSON_FORMAT)
  expect(obj.version).toBe(1)
  expect(typeof obj.exportedAt).toBe('number')
  expect(Array.isArray(obj.memories)).toBe(true)
})

test('parseMemoriesJson 非法 format 拒绝', () => {
  const text = JSON.stringify({ format: 'something-else', version: 1, exportedAt: 0, memories: [] })
  const { memories, errors } = parseMemoriesJson(text)
  expect(memories).toEqual([])
  expect(errors.length).toBe(1)
})

test('parseMemoriesJson 缺 version 拒绝', () => {
  const text = JSON.stringify({ format: MEMSIDE_JSON_FORMAT, exportedAt: 0, memories: [] })
  const { memories, errors } = parseMemoriesJson(text)
  expect(memories).toEqual([])
  expect(errors.length).toBe(1)
})

test('parseMemoriesJson memories 非数组拒绝', () => {
  const text = JSON.stringify({ format: MEMSIDE_JSON_FORMAT, version: 1, exportedAt: 0, memories: 'nope' })
  const { memories, errors } = parseMemoriesJson(text)
  expect(memories).toEqual([])
  expect(errors.length).toBe(1)
})

test('parseMemoriesJson 非法条目跳过计 errors，不整批失败', () => {
  const obj = {
    format: MEMSIDE_JSON_FORMAT, version: 1, exportedAt: 0,
    memories: [mk({ id: 'ok' }), { id: 'bad', scopeType: 'WRONG', title: '', bodyMd: '' }, 'literal-string'],
  }
  const { memories, errors } = parseMemoriesJson(JSON.stringify(obj))
  expect(memories.length).toBe(1)
  expect(memories[0]!.id).toBe('ok')
  expect(errors.length).toBe(2)
})

test('parseMemoriesJson 畸形 JSON 返回空 + errors', () => {
  const { memories, errors } = parseMemoriesJson('{ not json')
  expect(memories).toEqual([])
  expect(errors.length).toBe(1)
})

test('detectExchangeFormat: memside JSON → json', () => {
  expect(detectExchangeFormat(serializeMemoriesJson([mk()]))).toBe('json')
})

test('detectExchangeFormat: 非法 JSON → markdown 兜底', () => {
  expect(detectExchangeFormat('# not json at all')).toBe('markdown')
  expect(detectExchangeFormat('{ malformed')).toBe('markdown')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/exchange.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/memory/exchange.ts`（JSON 部分 + detectExchangeFormat）**

```ts
import type { Memory } from './store'
import type { MemoryScope, MemoryStatus, RuntimeTag } from './pure'
import type { ValueClass } from './valueFilter'
import type { DistillOrigin } from './distiller'

export const MEMSIDE_JSON_FORMAT = 'memside-memories'
export const MEMSIDE_JSON_VERSION = 1

export interface ExchangeEnvelope {
  format: string
  version: number
  exportedAt: number
  memories: unknown[]
}

/** Memory[] → memside JSON envelope 字符串（高保真，spec §导出格式 §1）。 */
export function serializeMemoriesJson(memories: Memory[]): string {
  const env: ExchangeEnvelope = {
    format: MEMSIDE_JSON_FORMAT,
    version: MEMSIDE_JSON_VERSION,
    exportedAt: 0, // 调用方（server）写入时再覆盖；纯函数不用 Date.now
    memories,
  }
  return JSON.stringify(env)
}

const VALID_SCOPES = new Set(['project', 'global'])
const VALID_RUNTIMES = new Set(['claude-code', 'opencode', null])
const VALID_STATUSES = new Set(['candidate', 'approved', 'archived', 'superseded', 'rejected'])

function asStr(v: unknown): string { return typeof v === 'string' ? v : '' }
function asStrOrNull(v: unknown): string | null { return typeof v === 'string' ? v : null }
function asNum(v: unknown): number { return typeof v === 'number' && Number.isFinite(v) ? v : 0 }
function asNumOrNull(v: unknown): number | null { return typeof v === 'number' && Number.isFinite(v) ? v : null }
function asStrArray(v: unknown): string[] { return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [] }

/** 单条 Memory 解析；非法返回 null（spec §失败模式 #3 容错）。 */
function parseMemoryRecord(r: unknown): Memory | null {
  if (typeof r !== 'object' || r === null || Array.isArray(r)) return null
  const p = r as Record<string, unknown>
  const scopeType = (VALID_SCOPES.has(p.scopeType as string) ? p.scopeType : null) as MemoryScope | null
  if (!scopeType) return null
  const status = (VALID_STATUSES.has(p.status as string) ? p.status : null) as MemoryStatus | null
  if (!status) return null
  return {
    id: asStr(p.id),
    scopeType,
    scopeId: asStrOrNull(p.scopeId),
    runtime: (VALID_RUNTIMES.has(p.runtime as string) ? p.runtime : null) as RuntimeTag,
    title: asStr(p.title),
    bodyMd: asStr(p.bodyMd),
    tags: asStrArray(p.tags),
    status,
    sourceKind: asStr(p.sourceKind),
    sourceCwd: asStrOrNull(p.sourceCwd),
    sourceEventId: asStrOrNull(p.sourceEventId),
    distillJobId: asStrOrNull(p.distillJobId),
    distillAction: asStrOrNull(p.distillAction),
    supersedesId: asStrOrNull(p.supersedesId),
    supersededById: asStrOrNull(p.supersededById),
    approvedAt: asNumOrNull(p.approvedAt),
    createdAt: asNum(p.createdAt),
    version: asNum(p.version),
    valueClass: asStrOrNull(p.valueClass) as ValueClass | null,
    subjectSlug: asStrOrNull(p.subjectSlug),
    origin: asStrOrNull(p.origin) as DistillOrigin | null,
    evidence: asStrOrNull(p.evidence),
  }
}

/**
 * memside JSON envelope → { memories, errors }。envelope 校验失败（format/version/
 * memories）整体拒绝返回空 + 1 条 error；逐条解析失败跳过计 errors，不整批失败。
 */
export function parseMemoriesJson(text: string): { memories: Memory[]; errors: string[] } {
  const errors: string[] = []
  let p: ExchangeEnvelope
  try { p = JSON.parse(text) } catch { return { memories: [], errors: ['invalid JSON'] } }
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return { memories: [], errors: ['envelope not an object'] }
  if (p.format !== MEMSIDE_JSON_FORMAT) return { memories: [], errors: [`unexpected format: ${String(p.format)}`] }
  if (p.version !== MEMSIDE_JSON_VERSION) return { memories: [], errors: [`unexpected version: ${String(p.version)}`] }
  if (!Array.isArray(p.memories)) return { memories: [], errors: ['memories is not an array'] }
  const memories: Memory[] = []
  for (const r of p.memories) {
    const m = parseMemoryRecord(r)
    if (m) memories.push(m)
    else errors.push(`skipped invalid memory record at index ${memories.length + errors.length}`)
  }
  return { memories, errors }
}

/**
 * 自动识别导入格式：JSON.parse 成功且 format===memside-memories → 'json'；
 * 其余（含畸形 JSON、纯 markdown）→ 'markdown' 兜底。spec §格式自动识别。
 */
export function detectExchangeFormat(text: string): 'json' | 'markdown' {
  try {
    const p = JSON.parse(text)
    if (typeof p === 'object' && p !== null && !Array.isArray(p) && p.format === MEMSIDE_JSON_FORMAT) {
      return 'json'
    }
  } catch { /* fall through */ }
  return 'markdown'
}
```

注意 `serializeMemoriesJson` 的 `exportedAt: 0`——纯函数不用 `Date.now()`（与 `Date.now()` 在 workflow 不可用的约束同源，且纯函数不该有副作用）。server 层调用时 `JSON.parse` → 改 `exportedAt` → `JSON.stringify`，或在本函数加可选第二参 `exportedAt`。**修正**：加可选参，更干净：

```ts
export function serializeMemoriesJson(memories: Memory[], exportedAt?: number): string {
  const env: ExchangeEnvelope = {
    format: MEMSIDE_JSON_FORMAT,
    version: MEMSIDE_JSON_VERSION,
    exportedAt: exportedAt ?? 0,
    memories,
  }
  return JSON.stringify(env)
}
```

（server 层传 `Date.now()`；纯函数测试不传 → 0，往返测试断言不变。）

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/exchange.test.ts`
Expected: PASS

- [ ] **Step 5: 全量门禁**

Run: `bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/memory/exchange.ts tests/exchange.test.ts
git commit -m "feat(memory): exchange JSON serialize/parse + 格式自动识别（spec §导出格式 §1）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: exchange 纯函数 — Markdown serialize/parse

**Files:**
- Modify: `src/memory/exchange.ts`（追加 Markdown 函数）
- Test: `tests/exchange.test.ts`（追加 Markdown 测试）

**Interfaces:**
- Consumes: `Memory` 类型；`categoryFromTitle`（`pure.ts:348`，从 title 剥 `[category:xxx]`）。
- Produces:
  - `serializeMemoriesMd(memories: Memory[], exportedAt?: number): string` — 返回 markdown 文档（spec §导出格式 §2 结构）。
  - `parseMemoriesMd(text: string): { memories: MemoryInput[]; errors: string[] }` — 返回 `MemoryInput[]`（低保真，走 createCandidate；故返回 `MemoryInput` 形状而非 `Memory`——见下方契约）。实际上 Markdown 解析出的记录无法回填全部字段，返回一个精简的 `MemoryInput`-like 数组。

> **设计决策（Markdown 导入返回形状）**：Markdown 是低保真，导入走 `createCandidate`（成 candidate）。为复用 `MemoryInput` 类型（`store.ts:20`），`parseMemoriesMd` 返回 `{ inputs: MemoryInput[]; errors: string[] }`，每个 `MemoryInput` 填 `title`/`bodyMd`/`tags`/`scopeType`/`scopeId`/`runtime`/`sourceKind:'manual'`/`subjectSlug`，其余字段缺省（undefined）。server 层循环 `createCandidate`。

Markdown 结构（spec §导出格式 §2）：

```markdown
# memside 记忆导出

> 导出于 2026-08-16 · 共 3 条 · 来源:memside

---

## [category:convention] 用 bun 跑测试

- **范围**: project · claude-code
- **来源项目**: C:/Users/admin/Desktop/memside
- **标签**: testing, tooling
- **主题**: test-runner

必须用 `bun test` 跑测试。

---

## [category:decision] 端口 7777

- **范围**: global · claude-code

daemon 固定监听 7777。
```

- [ ] **Step 1: 写失败测试**（追加到 `tests/exchange.test.ts`）

```ts
import { serializeMemoriesMd, parseMemoriesMd } from '@/memory/exchange'

test('serializeMemoriesMd 产出 markdown 结构', () => {
  const text = serializeMemoriesMd([mk({ id: '1', scopeType: 'project', scopeId: '/repo', runtime: 'claude-code', subjectSlug: 'slug-a', tags: ['x', 'y'] })])
  expect(text).toContain('# memside 记忆导出')
  expect(text).toContain('## [category:convention] x')
  expect(text).toContain('**范围**: project · claude-code')
  expect(text).toContain('**来源项目**: /repo')
  expect(text).toContain('**标签**: x, y')
  expect(text).toContain('**主题**: slug-a')
  expect(text).toContain('---')
})

test('serializeMemoriesMd 无标签/无 slug 不渲染对应行', () => {
  const text = serializeMemoriesMd([mk({ id: '1', scopeType: 'global', scopeId: null, runtime: null, tags: [], subjectSlug: null, sourceCwd: null })])
  expect(text).not.toContain('**标签**')
  expect(text).not.toContain('**主题**')
  expect(text).not.toContain('**来源项目**')
  expect(text).toContain('**范围**: global')
})

test('parseMemoriesMd 往返基本场景', () => {
  const md = serializeMemoriesMd([mk({ id: '1', scopeType: 'project', scopeId: '/repo', runtime: 'claude-code', subjectSlug: 's1', tags: ['a', 'b'], bodyMd: '正文内容' })])
  const { inputs, errors } = parseMemoriesMd(md)
  expect(errors).toEqual([])
  expect(inputs.length).toBe(1)
  expect(inputs[0]!.title).toBe('[category:convention] x')
  expect(inputs[0]!.bodyMd).toBe('正文内容')
  expect(inputs[0]!.scopeType).toBe('project')
  expect(inputs[0]!.scopeId).toBe('/repo')
  expect(inputs[0]!.runtime).toBe('claude-code')
  expect(inputs[0]!.tags).toEqual(['a', 'b'])
  expect(inputs[0]!.subjectSlug).toBe('s1')
  expect(inputs[0]!.sourceKind).toBe('manual')
})

test('parseMemoriesMd 多条 + 标题无 category 前缀', () => {
  const md = [
    '# memside 记忆导出',
    '> 导出于 ...',
    '',
    '---',
    '',
    '## [category:decision] 标题A',
    '',
    '- **范围**: global',
    '',
    '内容A',
    '',
    '---',
    '',
    '## 标题B（无 category）',
    '',
    '- **范围**: project · opencode',
    '- **来源项目**: /r',
    '',
    '内容B 多行',
    '第二行',
  ].join('\n')
  const { inputs, errors } = parseMemoriesMd(md)
  expect(errors).toEqual([])
  expect(inputs.length).toBe(2)
  expect(inputs[0]!.title).toBe('[category:decision] 标题A')
  expect(inputs[0]!.scopeType).toBe('global')
  expect(inputs[1]!.title).toBe('标题B（无 category）')
  expect(inputs[1]!.scopeType).toBe('project')
  expect(inputs[1]!.runtime).toBe('opencode')
  expect(inputs[1]!.bodyMd).toBe('内容B 多行\n第二行')
})

test('parseMemoriesMd bodyMd 含 --- 不被误切', () => {
  const md = [
    '# memside 记忆导出', '', '---', '',
    '## [category:trap] X', '',
    '- **范围**: global', '',
    '正文',
    '---',  // 独立行分隔
    '正文继续',
    '',
    '## [category:trap] Y', '',
    '- **范围**: global', '',
    'B',
  ].join('\n')
  const { inputs, errors } = parseMemoriesMd(md)
  expect(errors.length).toBe(0)
  expect(inputs.length).toBe(2)
  expect(inputs[0]!.title).toBe('[category:trap] X')
  expect(inputs[1]!.title).toBe('[category:trap] Y')
})

test('parseMemoriesMd 空文档/无小节返回空', () => {
  expect(parseMemoriesMd('').inputs).toEqual([])
  expect(parseMemoriesMd('# memside 记忆导出\n\n无小节').inputs).toEqual([])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/exchange.test.ts`
Expected: FAIL（Markdown 函数未实现）

- [ ] **Step 3: 在 `src/memory/exchange.ts` 追加 Markdown 实现**

```ts
import type { MemoryInput } from './store'

/** 空值/非字符串 helper（Markdown 序列化用）。 */
function tagsLine(tags: string[]): string | null {
  if (!tags.length) return null
  return `**标签**: ${tags.join(', ')}`
}
function slugLine(slug: string | null): string | null {
  return slug ? `**主题**: ${slug}` : null
}
function cwdLine(cwd: string | null): string | null {
  return cwd ? `**来源项目**: ${cwd}` : null
}
function scopeLine(scopeType: string, runtime: string | null): string {
  const parts = [scopeType]
  if (runtime) parts.push(runtime)
  return `**范围**: ${parts.join(' · ')}`
}

/**
 * Memory[] → markdown 文档（低保真，人类可读，spec §导出格式 §2）。
 * exportedAt 缺省 0（纯函数不用 Date.now）；server 层传真实时间戳。
 */
export function serializeMemoriesMd(memories: Memory[], exportedAt?: number): string {
  const lines: string[] = [
    '# memside 记忆导出',
    '',
    `> 导出于 ${exportedAt ?? 0} · 共 ${memories.length} 条 · 来源:memside`,
    '',
  ]
  for (const m of memories) {
    lines.push('---', '')
    lines.push(`## ${m.title}`, '')
    lines.push(`- ${scopeLine(m.scopeType, m.runtime)}`)
    const cl = cwdLine(m.sourceCwd); if (cl) lines.push(`- ${cl}`)
    const tl = tagsLine(m.tags); if (tl) lines.push(`- ${tl}`)
    const sl = slugLine(m.subjectSlug); if (sl) lines.push(`- ${sl}`)
    lines.push('', m.bodyMd, '')
  }
  return lines.join('\n')
}

const META_RE = /^-\s+\*\*(\S+)\*\*:\s*(.*)$/

/** 解析 `## ` 小节 → MemoryInput（低保真，走 createCandidate，spec §Markdown 导入解析）。 */
export function parseMemoriesMd(text: string): { inputs: MemoryInput[]; errors: string[] } {
  const inputs: MemoryInput[] = []
  const errors: string[] = []
  const rawLines = text.split('\n')
  // 跳到第一个 `## ` 小节；之后按小节切分。小节边界 = 下一个行首 `## ` 或文档尾。
  let i = 0
  while (i < rawLines.length && !rawLines[i]!.startsWith('## ')) i++
  while (i < rawLines.length) {
    if (!rawLines[i]!.startsWith('## ')) { i++; continue }
    const title = rawLines[i]!.slice(3).trim()
    i++
    // 收集元信息行 + 正文，直到下一个 `## `
    const meta: Record<string, string> = {}
    const bodyLines: string[] = []
    let inBody = false
    while (i < rawLines.length && !rawLines[i]!.startsWith('## ')) {
      const ln = rawLines[i]!
      if (!inBody) {
        const mm = META_RE.exec(ln)
        if (mm) { meta[mm[1]!].slice(0, 0); meta[mm[1]!] = mm[2]!.trim(); i++; continue }
        // 空行 / 分隔行 `---` 视为元信息→正文过渡
        if (ln.trim() === '' || ln.trim() === '---') { inBody = true; i++; continue }
        // 非元信息非空行 -> 正文开始
        inBody = true
      }
      bodyLines.push(ln)
      i++
    }
    const scopeParts = (meta['范围'] ?? '').split('·').map((s) => s.trim()).filter(Boolean)
    const scopeType: 'project' | 'global' = scopeParts[0] === 'project' ? 'project' : 'global'
    const runtime = scopeParts[1] === 'claude-code' || scopeParts[1] === 'opencode' ? scopeParts[1] : null
    const scopeId = meta['来源项目'] ?? null
    const tags = (meta['标签'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const subjectSlug = meta['主题'] ?? undefined
    // bodyMd 去掉首尾空行
    const bodyMd = bodyLines.join('\n').replace(/^\n+/, '').replace(/\n+$/, '')
    if (!title && !bodyMd) { errors.push('empty section skipped'); continue }
    inputs.push({
      scopeType, scopeId, title, bodyMd, tags, sourceKind: 'manual', runtime,
      sourceCwd: scopeId, subjectSlug: subjectSlug ?? undefined,
    } as MemoryInput)
  }
  return { inputs, errors }
}
```

**注意**：上方 `meta[mm[1]!].slice(0,0)` 是残留错误行——删除它（`meta[mm[1]!] = mm[2]!.trim()` 一句即可）。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/exchange.test.ts`
Expected: PASS

- [ ] **Step 5: 全量门禁**

Run: `bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/memory/exchange.ts tests/exchange.test.ts
git commit -m "feat(memory): exchange Markdown serialize/parse（spec §导出格式 §2）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: store 层 — bulkDeleteMemories / emptyTrash / restoreFromTrash / importMemories / listMemoriesForExport / listTrashPage / listTrashFacets

**Files:**
- Modify: `src/memory/store.ts`（追加函数 + `TrashRow` 类型 + import memoryTrash）
- Modify: `src/memory/store.ts:4`（schema import 加 memoryTrash）+ `src/memory/store.ts:1`（drizzle import 补 `inArray` 已有；补 trash 表引用）
- Test: `tests/store-trash-import.test.ts`

**Interfaces:**
- Consumes: `Memory`/`MemoryInput`（store.ts 既有）；`snapshotMemory`/`restoreFromSnapshot`（Task 2，`./trash`）；`normalizeSubjectSlug`（`pure.ts:330`，已 import）；`memoryTrash` 表（Task 1）。
- Produces（全部从 store.ts 导出，供 server.ts Task 6 使用）：
  - `bulkDeleteMemories(db, ids: string[]): Promise<{ deleted: number; skipped: number }>` — 逐条事务删 memory + 写 trash；吞错计 skipped。
  - `restoreFromTrash(db, id: string, opts: { conflict: 'skip'|'overwrite'|'newid' }): Promise<Memory>` — 反序列化 snapshot → importMemories → 删 trash 行；trash 不存在抛 `MemoryNotFoundError`。
  - `emptyTrash(db): Promise<{ emptied: number }>` — `DELETE FROM memory_trash` 全表 + 返回删除条数。
  - `importMemories(db, records: Memory[], opts: { conflict: 'skip'|'overwrite'|'newid' }): Promise<{ imported: number; skipped: number; overwritten: number; errors: string[] }>` — 高保真导入 seam（恢复 + JSON 导入共用）。绕过 createCandidate 的 status 硬编码。
  - `listMemoriesForExport(db, opts: { scope: 'selected'|'filter'|'all'; ids?: string[]; statuses?: MemoryStatus[]; filter?: MemoryListFilter }): Promise<Memory[]>` — 无分页导出查询。
  - `listTrashPage(db, opts: { limit?: number; before?: PageCursor; filter?: MemoryListFilter }): Promise<PageWithTotal<TrashRow>>` — 回收站分页。
  - `listTrashFacets(db): Promise<Facets>` — 回收站四维筛选（slugs/valueClasses 恒空，表无对应列——与 discards 同）。
  - `getTrash(db, id: string): Promise<{ trash: TrashRow & { memory: Memory | null } } | null>` — 详情（含反序列化 snapshot）。
  - 类型 `TrashRow`。

**TrashRow 类型**（列表展示用，不含 snapshot 大字段）：

```ts
export interface TrashRow {
  id: string
  originalMemoryId: string
  scopeType: string
  scopeId: string | null
  sourceCwd: string | null
  runtime: string | null
  deletedAt: number
  title: string
  valueClass: string | null
  subjectSlug: string | null
}
```

- [ ] **Step 1: 写失败测试**

`tests/store-trash-import.test.ts`（沿用 store-crud.test.ts 的 tmp DB 模式）：

```ts
import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { memories, memoryTrash } from '@/db/schema'
import { createCandidate, bulkDeleteMemories, restoreFromTrash, emptyTrash, importMemories, listMemoriesForExport, listTrashPage, getTrash, promoteCandidate } from '@/memory/store'
import type { Memory } from '@/memory/store'

const root = join(import.meta.dir, '.tmp-store-trash')
let dir = ''
let db: ReturnType<typeof openDb>

beforeAll(() => { rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true }) })
beforeEach(() => { dir = join(root, Math.random().toString(36).slice(2)); mkdirSync(dir, { recursive: true }); db = openDb(join(dir, 't.db')) })
afterEach(() => { db.$client.close() })

async function mkCandidate(over: Record<string, unknown> = {}) {
  return createCandidate(db, { scopeType: 'global', scopeId: null, title: '[category:convention] t', bodyMd: 'b', tags: ['x'], sourceKind: 'manual', runtime: null, ...over } as any)
}
function mkMemory(id: string, over: Partial<Memory> = {}): Memory {
  return { id, scopeType: 'global', scopeId: null, runtime: null, title: '[category:c] T', bodyMd: 'b', tags: [], status: 'approved', sourceKind: 'manual', sourceCwd: null, sourceEventId: null, distillJobId: null, distillAction: null, supersedesId: null, supersededById: null, approvedAt: 1, createdAt: 2, version: 1, valueClass: 'convention', subjectSlug: null, origin: 'user-stated', evidence: 'e', ...over }
}

test('bulkDeleteMemories: 删 memory + 写 trash，approved 状态保留', async () => {
  const a = await mkCandidate(); await promoteCandidate(db, a.id, { action: 'approve' })
  const b = await mkCandidate()
  const r = await bulkDeleteMemories(db, [a.id, b.id])
  expect(r.deleted).toBe(2)
  expect(r.skipped).toBe(0)
  // memory 行已删
  const left = await db.select().from(memories).all()
  expect(left.length).toBe(0)
  // trash 行有 2 条，snapshot 含原 status
  const tr = await db.select().from(memoryTrash).all()
  expect(tr.length).toBe(2)
  expect(JSON.parse(tr[0]!.memorySnapshot).status).toBe('approved')
})

test('bulkDeleteMemories: 不存在的 id 计 skipped', async () => {
  const a = await mkCandidate()
  const r = await bulkDeleteMemories(db, [a.id, 'nope'])
  expect(r.deleted).toBe(1)
  expect(r.skipped).toBe(1)
})

test('bulkDeleteMemories: 重复删同 id 幂等（第二次计 skipped）', async () => {
  const a = await mkCandidate()
  await bulkDeleteMemories(db, [a.id])
  const r2 = await bulkDeleteMemories(db, [a.id])
  expect(r2.deleted).toBe(0)
  expect(r2.skipped).toBe(1)
  const tr = await db.select().from(memoryTrash).all()
  expect(tr.length).toBe(1) // 不产生第二条 trash
})

test('emptyTrash: 清空 memory_trash 全表 + 返回计数', async () => {
  const a = await mkCandidate(); const b = await mkCandidate()
  await bulkDeleteMemories(db, [a.id, b.id])
  const r = await emptyTrash(db)
  expect(r.emptied).toBe(2)
  const tr = await db.select().from(memoryTrash).all()
  expect(tr.length).toBe(0)
})

test('restoreFromTrash: 恢复后 memory 写回 + status 保留（approved）', async () => {
  const a = await mkCandidate(); await promoteCandidate(db, a.id, { action: 'approve' })
  await bulkDeleteMemories(db, [a.id])
  const tr = await db.select().from(memoryTrash).all()
  const restored = await restoreFromTrash(db, tr[0]!.id, { conflict: 'skip' })
  expect(restored.status).toBe('approved')
  // trash 行已删
  const tr2 = await db.select().from(memoryTrash).all()
  expect(tr2.length).toBe(0)
})

test('restoreFromTrash: 不存在抛 MemoryNotFoundError', async () => {
  await expect(restoreFromTrash(db, 'nope', { conflict: 'skip' })).rejects.toThrow()
})

test('restoreFromTrash: 同 id 已存在 + skip -> 计 skipped 不覆盖', async () => {
  // 删 a，恢复期间 a 又被新建（同 id）。用 importMemories newid 制造冲突场景：
  // 直接造一个 trash snapshot id='X'，库里已有 id='X'
  const existing = await mkCandidate()
  await importMemories(db, [mkMemory(existing.id)], { conflict: 'overwrite' }) // 确保库里有一条
  // 手写一条 trash（绕过 delete，模拟恢复时 id 已存在）
  await db.insert(memoryTrash).values({ id: 'trash1', memorySnapshot: JSON.stringify(mkMemory(existing.id)), originalMemoryId: existing.id, scopeType: 'global', scopeId: null, runtime: null, deletedAt: 1, title: 'T', valueClass: 'convention', subjectSlug: null }).run()
  const restored = await restoreFromTrash(db, 'trash1', { conflict: 'skip' })
  expect(restored.id).toBe(existing.id) // 原行仍在
})

test('importMemories newid: 生成新 ULID 新增', async () => {
  const r = await importMemories(db, [mkMemory('DUP')], { conflict: 'newid' })
  expect(r.imported).toBe(1)
  // 新行 id 不等于 'DUP'
  const rows = await db.select().from(memories).all()
  expect(rows.some((x) => x.id !== 'DUP')).toBe(true)
})

test('importMemories overwrite: 删旧写新保留 id', async () => {
  await importMemories(db, [mkMemory('K1', { title: 'old' })], { conflict: 'newid' })
  const r = await importMemories(db, [mkMemory('K1', { title: 'new' })], { conflict: 'overwrite' })
  expect(r.overwritten).toBe(1)
  const rows = await db.select().from(memories).where(eq(memories.id, 'K1')).all()
  // overwrite 后 id 仍 K1，title 变 new（注意 newid 可能改了 id——overwrite 按 originalMemoryId 查）
})

test('importMemories skip: 已存在跳过', async () => {
  await importMemories(db, [mkMemory('S1')], { conflict: 'newid' })
  const r = await importMemories(db, [mkMemory('S1')], { conflict: 'skip' })
  expect(r.skipped).toBe(1)
  expect(r.imported).toBe(0)
})

test('listMemoriesForExport selected: 按 ids 取', async () => {
  const a = await mkCandidate(); const b = await mkCandidate()
  const rows = await listMemoriesForExport(db, { scope: 'selected', ids: [a.id] })
  expect(rows.length).toBe(1)
  expect(rows[0]!.id).toBe(a.id)
})

test('listMemoriesForExport all: 全部不受分页限制', async () => {
  await mkCandidate(); await mkCandidate()
  const rows = await listMemoriesForExport(db, { scope: 'all' })
  expect(rows.length).toBe(2)
})

test('listTrashPage: 列表不含 snapshot 大字段', async () => {
  const a = await mkCandidate()
  await bulkDeleteMemories(db, [a.id])
  const page = await listTrashPage(db, { limit: 20 })
  expect(page.items.length).toBe(1)
  expect((page.items[0] as any).memorySnapshot).toBeUndefined()
  expect(page.items[0]!.title).toBe('[category:convention] t')
})

test('getTrash: 详情含反序列化 memory', async () => {
  const a = await mkCandidate(); await promoteCandidate(db, a.id, { action: 'approve' })
  await bulkDeleteMemories(db, [a.id])
  const tr = (await listTrashPage(db, { limit: 20 })).items[0]!
  const detail = await getTrash(db, tr.id)
  expect(detail).not.toBeNull()
  expect(detail!.trash.memory).not.toBeNull()
  expect(detail!.trash.memory!.status).toBe('approved')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/store-trash-import.test.ts`
Expected: FAIL（函数不存在）

- [ ] **Step 3: 在 `src/memory/store.ts` 顶部 schema import 加 `memoryTrash`**

修改 `store.ts:4`：

```ts
import { memories, memoryDiscards, memorySessionOffsets, memoryDistillInputs, memoryDistillRuns, memoryDistillJobs, memorySessionFlushes, memorySessionDigests, memoryDegradations, notifications, memoryTrash } from '@/db/schema'
```

加 import（Task 2 产出）：

```ts
import { snapshotMemory, restoreFromSnapshot } from './trash'
```

- [ ] **Step 4: 在 `src/memory/store.ts` 追加实现**（放在 `bulkRejectUnevaluated` 之后、或文件末尾合适处。复用 `rowToMemory`/`parseTags`/`memoryFilterConds` 等既有 helper）

```ts
// ---------------------------------------------------------------------------
// 回收站 + 批量删除 + 导入 + 导出查询（spec 2026-08-16）
// ---------------------------------------------------------------------------

export interface TrashRow {
  id: string
  originalMemoryId: string
  scopeType: string
  scopeId: string | null
  sourceCwd: string | null
  runtime: string | null
  deletedAt: number
  title: string
  valueClass: string | null
  subjectSlug: string | null
}

const TRASH_COLS = {
  id: memoryTrash.id, originalMemoryId: memoryTrash.originalMemoryId,
  scopeType: memoryTrash.scopeType, scopeId: memoryTrash.scopeId,
  sourceCwd: memoryTrash.sourceCwd, runtime: memoryTrash.runtime,
  deletedAt: memoryTrash.deletedAt, title: memoryTrash.title,
  valueClass: memoryTrash.valueClass, subjectSlug: memoryTrash.subjectSlug,
} as const

function rowToTrash(r: any): TrashRow {
  return {
    id: r.id, originalMemoryId: r.originalMemoryId,
    scopeType: r.scopeType, scopeId: r.scopeId ?? null, sourceCwd: r.sourceCwd ?? null,
    runtime: r.runtime ?? null, deletedAt: r.deletedAt, title: r.title,
    valueClass: r.valueClass ?? null, subjectSlug: r.subjectSlug ?? null,
  }
}

/**
 * 批量删除：逐条事务内 DELETE memory + INSERT memory_trash 快照。吞错计 skipped
 * （含 not-found / 重复删）。幂等：同 id 第二次删 memory 已不在 -> 计 skipped，不写第二条 trash。
 */
export async function bulkDeleteMemories(db: DbClient, ids: string[]): Promise<{ deleted: number; skipped: number }> {
  let deleted = 0, skipped = 0
  for (const id of ids) {
    try {
      await db.transaction((tx) => {
        const rows = tx.select().from(memories).where(eq(memories.id, id)).limit(1).all()
        if (rows.length === 0) throw new MemoryNotFoundError(`memory ${id} not found`)
        const m = rowToMemory(rows[0]!)
        tx.delete(memories).where(eq(memories.id, id)).run()
        tx.insert(memoryTrash).values({
          id: ulid(), memorySnapshot: snapshotMemory(m), originalMemoryId: m.id,
          scopeType: m.scopeType, scopeId: m.scopeId, sourceCwd: m.sourceCwd,
          runtime: m.runtime, deletedAt: Date.now(), title: m.title,
          valueClass: m.valueClass, subjectSlug: m.subjectSlug,
        }).run()
      })
      deleted += 1
    } catch {
      skipped += 1
    }
  }
  return { deleted, skipped }
}

/** 清空回收站：物理删全部 memory_trash 行（快照没了 -> 不可恢复，spec §数据模型）。 */
export async function emptyTrash(db: DbClient): Promise<{ emptied: number }> {
  const rows = await db.select({ n: sql<number>`COUNT(*)` }).from(memoryTrash).all()
  await db.delete(memoryTrash).run()
  return { emptied: Number(rows[0]?.n ?? 0) }
}

/**
 * 高保真导入 seam（恢复 + JSON 文件导入共用，spec §导入/恢复共享 seam）。
 * 绕过 createCandidate 的 status:'candidate' 硬编码，按记录 status 直接写入。
 * 冲突策略：skip（已存在跳过）/ overwrite（删旧写新保留 id）/ newid（生成新 ULID 新增）。
 * 非法记录跳过计 errors，不整批失败。subjectSlug 经 normalizeSubjectSlug 校验。
 */
export async function importMemories(
  db: DbClient,
  records: Memory[],
  opts: { conflict: 'skip' | 'overwrite' | 'newid' },
): Promise<{ imported: number; skipped: number; overwritten: number; errors: string[] }> {
  let imported = 0, skipped = 0, overwritten = 0
  const errors: string[] = []
  for (const rec of records) {
    try {
      if (!rec.id || !rec.title || !rec.bodyMd) { errors.push(`invalid record: ${rec.id ?? '(no id)'}`); continue }
      const slug = rec.subjectSlug !== null && rec.subjectSlug !== undefined
        ? normalizeSubjectSlug(rec.subjectSlug) : rec.subjectSlug ?? null
      const existing = await db.select({ id: memories.id }).from(memories).where(eq(memories.id, rec.id)).limit(1).all()
      const exists = existing.length > 0
      if (exists && opts.conflict === 'skip') { skipped += 1; continue }
      const writeId = (!exists || opts.conflict === 'newid') ? ulid() : rec.id
      const values = {
        id: writeId, scopeType: rec.scopeType, scopeId: rec.scopeId, runtime: rec.runtime,
        title: rec.title, bodyMd: rec.bodyMd, tags: JSON.stringify(rec.tags), status: rec.status,
        sourceKind: rec.sourceKind || 'manual', sourceCwd: rec.sourceCwd ?? null,
        sourceEventId: rec.sourceEventId ?? null, distillJobId: rec.distillJobId ?? null,
        distillAction: rec.distillAction ?? null, supersedesId: rec.supersedesId ?? null,
        supersededById: rec.supersededById ?? null, approvedAt: rec.approvedAt ?? null,
        createdAt: rec.createdAt || Date.now(), version: rec.version || 1,
        valueClass: rec.valueClass ?? null, subjectSlug: slug,
        origin: rec.origin ?? null, evidence: rec.evidence ?? null,
      }
      if (exists && opts.conflict === 'overwrite') {
        await db.delete(memories).where(eq(memories.id, rec.id)).run()
        await db.insert(memories).values(values).run()
        overwritten += 1
      } else {
        await db.insert(memories).values(values).run()
        imported += 1
      }
    } catch (e) {
      errors.push(`failed record ${rec.id}: ${(e as Error).message}`)
    }
  }
  return { imported, skipped, overwritten, errors }
}

/**
 * 恢复回收站条目：反序列化 snapshot -> importMemories(skip) -> 删 trash 行。
 * trash 不存在抛 MemoryNotFoundError。恢复默认 skip（安全：不暴露 overwrite，spec §失败模式 #4）。
 */
export async function restoreFromTrash(
  db: DbClient, id: string, opts: { conflict: 'skip' | 'overwrite' | 'newid' } = { conflict: 'skip' },
): Promise<Memory> {
  const rows = await db.select().from(memoryTrash).where(eq(memoryTrash.id, id)).limit(1).all()
  if (rows.length === 0) throw new MemoryNotFoundError(`trash ${id} not found`)
  const snap = restoreFromSnapshot(rows[0]!.memorySnapshot)
  if (!snap) throw new MemoryConflictError(`trash ${id} snapshot corrupt`)
  const r = await importMemories(db, [snap], opts)
  await db.delete(memoryTrash).where(eq(memoryTrash.id, id)).run()
  // 返回恢复的记忆（按 originalMemoryId 取回）
  const restored = await db.select().from(memories).where(eq(memories.id, snap.id)).limit(1).all()
  if (restored.length === 0) throw new MemoryConflictError(`restore reported ${JSON.stringify(r)} but memory not found`)
  return rowToMemory(restored[0]!)
}

/**
 * 无分页导出查询（spec §导出三档作用域）。selected 按 ids；filter 按 statuses+filter；
 * all 全部 statuses。不受 cursor 限制（导出量级可控，YAGNI 不流式）。
 */
export async function listMemoriesForExport(
  db: DbClient,
  opts: { scope: 'selected' | 'filter' | 'all'; ids?: string[]; statuses?: MemoryStatus[]; filter?: MemoryListFilter },
): Promise<Memory[]> {
  if (opts.scope === 'selected') {
    const ids = (opts.ids ?? []).filter((x): x is string => typeof x === 'string')
    if (ids.length === 0) return []
    const rows = await db.select().from(memories).where(inArray(memories.id, ids)).orderBy(desc(memories.createdAt)).all()
    return rows.map(rowToMemory)
  }
  const conds: any[] = []
  if (opts.scope === 'filter' && opts.statuses && opts.statuses.length > 0) {
    conds.push(inArray(memories.status, opts.statuses))
  }
  conds.push(...memoryFilterConds(opts.filter))
  const rows = await db.select().from(memories)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(memories.createdAt)).all()
  return rows.map(rowToMemory)
}

/** 回收站分页（与 listMemoriesPage 同模式，复合游标 deletedAt+id DESC）。 */
export async function listTrashPage(
  db: DbClient,
  opts: { limit?: number; before?: PageCursor; filter?: MemoryListFilter } = {},
): Promise<PageWithTotal<TrashRow>> {
  const limit = clampPageLimit(opts.limit)
  const baseConds: any[] = []
  if (opts.filter?.sourceCwd) baseConds.push(eq(memoryTrash.sourceCwd, opts.filter.sourceCwd))
  if (opts.filter?.category) baseConds.push(sql`instr(${memoryTrash.title}, ${'[category:' + opts.filter.category + ']'}) > 0`)
  if (opts.filter?.subjectSlug) baseConds.push(eq(memoryTrash.subjectSlug, opts.filter.subjectSlug))
  if (opts.filter?.valueClass) {
    if (opts.filter.valueClass === VALUE_CLASS_UNEVALUATED) baseConds.push(isNull(memoryTrash.valueClass))
    else if ((PROTECTED_VALUE_CLASSES as readonly string[]).includes(opts.filter.valueClass)) baseConds.push(eq(memoryTrash.valueClass, opts.filter.valueClass))
  }
  const conds = [...baseConds]
  if (opts.before) {
    conds.push(or(
      lt(memoryTrash.deletedAt, opts.before.ts),
      and(eq(memoryTrash.deletedAt, opts.before.ts), lt(memoryTrash.id, opts.before.id)),
    ))
  }
  const rows = await db.select(TRASH_COLS).from(memoryTrash)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(memoryTrash.deletedAt), desc(memoryTrash.id))
    .limit(limit + 1).all()
  const countRows = await db.select({ n: sql<number>`COUNT(*)` }).from(memoryTrash)
    .where(baseConds.length > 0 ? and(...baseConds) : undefined).all()
  const hasMore = rows.length > limit
  const pageRows = rows.slice(0, limit)
  const last = pageRows[pageRows.length - 1]
  return {
    items: pageRows.map(rowToTrash),
    hasMore,
    nextCursor: hasMore && last ? { ts: last.deletedAt, id: last.id } : null,
    total: Number(countRows[0]?.n ?? 0),
  }
}

/** 回收站详情（含反序列化 snapshot，恢复前预览）。 */
export async function getTrash(db: DbClient, id: string): Promise<{ trash: TrashRow & { memory: Memory | null } } | null> {
  const rows = await db.select().from(memoryTrash).where(eq(memoryTrash.id, id)).limit(1).all()
  if (rows.length === 0) return null
  const t = rowToTrash(rows[0]!)
  return { trash: { ...t, memory: restoreFromSnapshot(rows[0]!.memorySnapshot) } }
}

/** 回收站四维筛选下拉（slugs/valueClasses 恒空——表无对应列，与 discards 同模式）。 */
export async function listTrashFacets(db: DbClient): Promise<Facets> {
  const projects = new Map<string, number>()
  const projRows = await db.select({ v: memoryTrash.sourceCwd, n: sql<number>`COUNT(*)` })
    .from(memoryTrash).where(isNotNull(memoryTrash.sourceCwd)).groupBy(memoryTrash.sourceCwd).all()
  for (const r of projRows) if (r.v) projects.set(r.v, (projects.get(r.v) ?? 0) + Number(r.n))
  const cats = new Map<string, number>()
  const titleRows = await db.select({ t: memoryTrash.title }).from(memoryTrash).all()
  for (const r of titleRows) {
    const c = categoryFromTitle(r.t)
    if (c) cats.set(c, (cats.get(c) ?? 0) + 1)
  }
  const sortFacets = (m: Map<string, number>): FacetValue[] => [...m.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
    .slice(0, FACET_LIST_CAP)
  return { projects: sortFacets(projects), categories: sortFacets(cats), slugs: [], valueClasses: [] }
}
```

注意：`listTrashFacets` 里定义的局部 `sortFacets` 与文件已有的全局 `sortFacets`（store.ts:940）重名。**修正**：复用全局 `sortFacets`，删除局部定义。即：

```ts
export async function listTrashFacets(db: DbClient): Promise<Facets> {
  const projects = new Map<string, number>()
  const projRows = await db.select({ v: memoryTrash.sourceCwd, n: sql<number>`COUNT(*)` })
    .from(memoryTrash).where(isNotNull(memoryTrash.sourceCwd)).groupBy(memoryTrash.sourceCwd).all()
  for (const r of projRows) if (r.v) projects.set(r.v, (projects.get(r.v) ?? 0) + Number(r.n))
  const cats = new Map<string, number>()
  const titleRows = await db.select({ t: memoryTrash.title }).from(memoryTrash).all()
  for (const r of titleRows) {
    const c = categoryFromTitle(r.t)
    if (c) cats.set(c, (cats.get(c) ?? 0) + 1)
  }
  return { projects: sortFacets(projects), categories: sortFacets(cats), slugs: [], valueClasses: [] }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun test tests/store-trash-import.test.ts`
Expected: PASS

- [ ] **Step 6: 全量门禁**

Run: `bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/memory/store.ts tests/store-trash-import.test.ts
git commit -m "feat(store): 回收站+批量删除+导入+导出查询存储函数（spec §数据模型/§导入 seam）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: server 层 — 7 路由 + /api/status trashCount

**Files:**
- Modify: `src/server.ts:11`（store import 补 7 个新函数 + TrashRow 类型）
- Modify: `src/server.ts:11`（已有 import 行追加）
- Modify: `src/server.ts` `/api/status` 路由（`:482` return 加 `trashCount`）
- Modify: `src/server.ts`（在 bulk-reject-unevaluated 路由后追加 7 路由）
- Test: `tests/server-trash-import-export.test.ts`

**Interfaces:**
- Consumes: Task 5 的 store 函数；Task 3/4 的 exchange 函数；Hono `c.req.parseBody`（multipart）。
- Produces（HTTP 路由）：
  - `POST /api/memories/bulk-delete` body `{ ids: string[] }` → `{ deleted, skipped }`，broadcast `memories.bulk-deleted`。空 ids 400。
  - `GET /api/trash?limit&before&project&category&slug&valueClass` → `PageWithTotal<TrashRow>`。
  - `GET /api/trash/:id` → `{ trash }` 含 memory snapshot 或 404。
  - `POST /api/trash/:id/restore` → `{ memory }` 或 404；broadcast `memory.restored`。
  - `POST /api/trash/empty` → `{ emptied }`；broadcast `trash.emptied`。
  - `POST /api/memories/export` body `{ scope, ids?, filter?, statuses?, format }` → JSON envelope 或 markdown text（Content-Disposition）。
  - `POST /api/memories/import?conflict=skip|overwrite|newid` multipart 文件 → `{ imported, skipped, overwritten, errors }`；broadcast `memories.imported`。条数 cap 10000，超限 400。

- [ ] **Step 1: 写失败测试**

`tests/server-trash-import-export.test.ts`（沿用 server.test.ts 的 createApp + req 模式）：

```ts
import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { createCandidate, promoteCandidate } from '@/memory/store'
import { ClaudeCodeAdapter } from '@/adapter/claudeCode'
import { OpencodeAdapter } from '@/adapter/opencode'
import { createApp } from '@/server'
import { serializeMemoriesJson } from '@/memory/exchange'
import type { Memory } from '@/memory/store'

const root = join(import.meta.dir, '.tmp-server-trash')
let dir = ''
let db: ReturnType<typeof openDb>
let app: ReturnType<typeof createApp>
let broadcastCalls: unknown[]

beforeAll(() => { rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true }) })
beforeEach(() => {
  dir = join(root, Math.random().toString(36).slice(2)); mkdirSync(dir, { recursive: true })
  db = openDb(join(dir, 't.db'))
  broadcastCalls = []
  app = createApp({ db, adapter: new ClaudeCodeAdapter(db), opencodeAdapter: new OpencodeAdapter(db),
    enqueueDistillJob: async () => ({ jobId: 'j', nextRunAt: 0 }), broadcast: (m) => broadcastCalls.push(m) })
})
afterEach(() => { db.$client.close() })

async function req(path: string, init?: RequestInit) {
  const res = await app.fetch(new Request(`http://x${path}`, init))
  return { status: res.status, body: await res.json().catch(() => null), res }
}

async function mkCandidate() {
  return createCandidate(db, { scopeType: 'global', scopeId: null, title: '[category:convention] t', bodyMd: 'b', tags: ['x'], sourceKind: 'manual', runtime: null })
}
function mkMemory(id: string): Memory {
  return { id, scopeType: 'global', scopeId: null, runtime: null, title: '[category:c] T', bodyMd: 'b', tags: [], status: 'approved', sourceKind: 'manual', sourceCwd: null, sourceEventId: null, distillJobId: null, distillAction: null, supersedesId: null, supersededById: null, approvedAt: 1, createdAt: 2, version: 1, valueClass: 'convention', subjectSlug: null, origin: 'user-stated', evidence: 'e' }
}

test('POST /api/memories/bulk-delete 删 memory + broadcast', async () => {
  const a = await mkCandidate()
  const { status, body } = await req('/api/memories/bulk-delete', { method: 'POST', body: JSON.stringify({ ids: [a.id] }), headers: { 'content-type': 'application/json' } })
  expect(status).toBe(200)
  expect(body.deleted).toBe(1)
  expect(broadcastCalls.some((m) => (m as any).type === 'memories.bulk-deleted')).toBe(true)
})

test('POST /api/memories/bulk-delete 空 ids 400', async () => {
  const { status } = await req('/api/memories/bulk-delete', { method: 'POST', body: JSON.stringify({ ids: [] }), headers: { 'content-type': 'application/json' } })
  expect(status).toBe(400)
})

test('GET /api/trash 分页返回', async () => {
  const a = await mkCandidate()
  await req('/api/memories/bulk-delete', { method: 'POST', body: JSON.stringify({ ids: [a.id] }), headers: { 'content-type': 'application/json' } })
  const { status, body } = await req('/api/trash?limit=20')
  expect(status).toBe(200)
  expect(body.items.length).toBe(1)
  expect(body.total).toBe(1)
})

test('POST /api/trash/:id/restore 恢复 + memory 状态保留', async () => {
  const a = await mkCandidate(); await promoteCandidate(db, a.id, { action: 'approve' })
  await req('/api/memories/bulk-delete', { method: 'POST', body: JSON.stringify({ ids: [a.id] }), headers: { 'content-type': 'application/json' } })
  const trash = (await req('/api/trash?limit=20')).body.items[0]
  const { status, body } = await req(`/api/trash/${trash.id}/restore`, { method: 'POST' })
  expect(status).toBe(200)
  expect(body.memory.status).toBe('approved')
  expect(broadcastCalls.some((m) => (m as any).type === 'memory.restored')).toBe(true)
})

test('POST /api/trash/empty 清空', async () => {
  const a = await mkCandidate()
  await req('/api/memories/bulk-delete', { method: 'POST', body: JSON.stringify({ ids: [a.id] }), headers: { 'content-type': 'application/json' } })
  const { status, body } = await req('/api/trash/empty', { method: 'POST' })
  expect(status).toBe(200)
  expect(body.emptied).toBe(1)
})

test('POST /api/memories/export JSON envelope', async () => {
  const a = await mkCandidate()
  const { status, body } = await req('/api/memories/export', { method: 'POST', body: JSON.stringify({ scope: 'all', format: 'json' }), headers: { 'content-type': 'application/json' } })
  expect(status).toBe(200)
  expect(body.format).toBe('memside-memories')
  expect(body.memories.length).toBe(1)
})

test('POST /api/memories/export markdown Content-Disposition', async () => {
  await mkCandidate()
  const { status, res } = await req('/api/memories/export', { method: 'POST', body: JSON.stringify({ scope: 'all', format: 'markdown' }), headers: { 'content-type': 'application/json' } })
  expect(status).toBe(200)
  expect(res.headers.get('content-disposition')).toContain('attachment')
  const text = await res.text()
  expect(text).toContain('# memside 记忆导出')
})

test('POST /api/memories/import JSON 高保真', async () => {
  const env = serializeMemoriesJson([mkMemory('IMP1')], Date.now())
  const form = new FormData(); form.append('file', new Blob([env]), 'm.json')
  const { status, body } = await req('/api/memories/import?conflict=newid', { method: 'POST', body: form })
  expect(status).toBe(200)
  expect(body.imported).toBe(1)
  expect(broadcastCalls.some((m) => (m as any).type === 'memories.imported')).toBe(true)
})

test('POST /api/memories/import markdown 低保真成 candidate', async () => {
  const md = `# memside 记忆导出\n\n---\n\n## [category:c] X\n\n- **范围**: global\n\n正文\n`
  const form = new FormData(); form.append('file', new Blob([md]), 'm.md')
  const { status, body } = await req('/api/memories/import?conflict=newid', { method: 'POST', body: form })
  expect(status).toBe(200)
  expect(body.imported).toBe(1)
})

test('POST /api/memories/import 超 10000 条 400', async () => {
  const many = Array.from({ length: 10001 }, (_, i) => mkMemory(`I${i}`))
  const env = serializeMemoriesJson(many, Date.now())
  const form = new FormData(); form.append('file', new Blob([env]), 'big.json')
  const { status } = await req('/api/memories/import?conflict=newid', { method: 'POST', body: form })
  expect(status).toBe(400)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/server-trash-import-export.test.ts`
Expected: FAIL（路由不存在，404）

- [ ] **Step 3: 修改 `src/server.ts:11` store import，追加新函数**

```ts
import { promoteCandidate, patchMemory, createCandidate, getMemoryById, getSourceInput, archiveMemory, unarchiveMemory, restoreMemory, promoteDiscard, listDiscards, getDistillRun, listRecentDistillRuns, listMemoriesPage, listDiscardsPage, listDistillRunsPage, listFacets, bulkRejectUnevaluated, PROTECTED_VALUE_CLASSES, MemoryNotFoundError, MemoryConflictError, type PageCursor, type MemoryListFilter, type FacetScope, bulkDeleteMemories, restoreFromTrash, emptyTrash, importMemories, listMemoriesForExport, listTrashPage, listTrashFacets, getTrash, type TrashRow } from '@/memory/store'
```

并在 server.ts 顶部 import exchange 函数：

```ts
import { serializeMemoriesJson, parseMemoriesJson, serializeMemoriesMd, parseMemoriesMd, detectExchangeFormat, MEMSIDE_JSON_FORMAT, MEMSIDE_JSON_VERSION } from '@/memory/exchange'
```

- [ ] **Step 4: 在 `/api/status` 路由 return 对象（`:482`）加 `trashCount`**

在 `waitingJobs: waitingCount[0]?.n ?? 0,` 之后加：

```ts
      trashCount: (await deps.db.select({ n: count() }).from(memoryTrash).all())[0]?.n ?? 0,
```

并在 `:7` schema import 加 `memoryTrash`：

```ts
import { memories, memoryDistillJobs, memoryDistillEvents, memoryDiscards, memoryDistillRuns, notifications, memoryTrash } from '@/db/schema'
```

- [ ] **Step 5: 在 `bulk-reject-unevaluated` 路由（`:714`）之后追加 7 路由**

```ts
  // --- 批量删除（移入回收站，spec §数据模型）--------------------------------
  app.post('/api/memories/bulk-delete', async (c) => {
    const body = await c.req.json().catch(() => ({ ids: [] as string[] }))
    const ids: string[] = Array.isArray(body.ids) ? body.ids.filter((x: unknown) => typeof x === 'string') : []
    if (ids.length === 0) return c.json({ error: 'ids is empty' }, 400)
    const r = await bulkDeleteMemories(deps.db, ids)
    deps.broadcast({ type: 'memories.bulk-deleted', deleted: r.deleted, skipped: r.skipped })
    return c.json(r)
  })

  // --- 回收站（spec §数据模型）----------------------------------------------
  app.get('/api/trash', async (c) => {
    const filter: MemoryListFilter = {}
    const project = c.req.query('project'); if (project) filter.sourceCwd = project
    const category = c.req.query('category'); if (category) filter.category = category
    const slug = c.req.query('slug'); if (slug) filter.subjectSlug = slug
    const valueClass = c.req.query('valueClass'); if (valueClass) filter.valueClass = valueClass
    const page = await listTrashPage(deps.db, { limit: Number(c.req.query('limit')), before: parseBefore(c), filter })
    return c.json(page)
  })

  app.get('/api/trash/:id', async (c) => {
    const t = await getTrash(deps.db, c.req.param('id'))
    if (!t) return c.json({ error: 'not found' }, 404)
    return c.json({ trash: t.trash })
  })

  app.post('/api/trash/:id/restore', async (c) => {
    try {
      const m = await restoreFromTrash(deps.db, c.req.param('id'), { conflict: 'skip' })
      deps.broadcast({ type: 'memory.restored', memoryId: m.id, trashId: c.req.param('id') })
      return c.json({ memory: m })
    } catch (e) {
      if (e instanceof MemoryNotFoundError) return c.json({ error: (e as Error).message }, 404)
      return c.json({ error: (e as Error).message }, 409)
    }
  })

  app.post('/api/trash/empty', async (c) => {
    const r = await emptyTrash(deps.db)
    deps.broadcast({ type: 'trash.emptied', emptied: r.emptied })
    return c.json(r)
  })

  // --- 导出（spec §导出三档作用域 × 两格式）----------------------------------
  app.post('/api/memories/export', async (c) => {
    const body = await c.req.json().catch(() => ({ scope: 'all', format: 'json' }))
    const format: 'json' | 'markdown' = body.format === 'markdown' ? 'markdown' : 'json'
    const scope: 'selected' | 'filter' | 'all' = ['selected', 'filter', 'all'].includes(body.scope) ? body.scope : 'all'
    const filter: MemoryListFilter = {}
    if (body.filter?.sourceCwd) filter.sourceCwd = body.filter.sourceCwd
    if (body.filter?.subjectSlug) filter.subjectSlug = body.filter.subjectSlug
    if (body.filter?.category) filter.category = body.filter.category
    if (body.filter?.valueClass) filter.valueClass = body.filter.valueClass
    const statuses: MemoryStatus[] = Array.isArray(body.statuses) ? body.statuses.filter((s: unknown) => typeof s === 'string') : []
    const rows = await listMemoriesForExport(deps.db, { scope, ids: body.ids, statuses, filter })
    if (format === 'markdown') {
      const md = serializeMemoriesMd(rows, Date.now())
      c.header('Content-Disposition', 'attachment; filename="memside-export.md"')
      c.header('Content-Type', 'text/markdown; charset=utf-8')
      return c.body(md)
    }
    return c.json({ format: MEMSIDE_JSON_FORMAT, version: MEMSIDE_JSON_VERSION, exportedAt: Date.now(), memories: rows })
  })

  // --- 导入（spec §格式自动识别 + 三冲突策略 + 条数 cap）---------------------
  app.post('/api/memories/import', async (c) => {
    const conflict: 'skip' | 'overwrite' | 'newid' = ['skip', 'overwrite', 'newid'].includes(c.req.query('conflict') ?? '')
      ? (c.req.query('conflict') as 'skip' | 'overwrite' | 'newid') : 'skip'
    let fileContent: string
    try {
      const form = await c.req.parseBody()
      const file = form['file']
      if (!(file instanceof Blob)) return c.json({ error: 'no file uploaded' }, 400)
      fileContent = await file.text()
    } catch {
      return c.json({ error: 'invalid upload' }, 400)
    }
    const fmt = detectExchangeFormat(fileContent)
    if (fmt === 'json') {
      const { memories: records, errors } = parseMemoriesJson(fileContent)
      if (records.length > 10_000) return c.json({ error: 'too many records (max 10000)' }, 400)
      const r = await importMemories(deps.db, records, { conflict })
      deps.broadcast({ type: 'memories.imported', imported: r.imported, skipped: r.skipped, overwritten: r.overwritten })
      return c.json(r)
    }
    // markdown 低保真 -> createCandidate 循环
    const { inputs, errors } = parseMemoriesMd(fileContent)
    if (inputs.length > 10_000) return c.json({ error: 'too many records (max 10000)' }, 400)
    let imported = 0; const importErrors = [...errors]
    for (const inp of inputs) {
      try { await createCandidate(deps.db, inp); imported += 1 }
      catch (e) { importErrors.push(`failed: ${(e as Error).message}`) }
    }
    deps.broadcast({ type: 'memories.imported', imported, skipped: 0, overwritten: 0 })
    return c.json({ imported, skipped: 0, overwritten: 0, errors: importErrors })
  })
```

- [ ] **Step 6: 跑测试确认通过**

Run: `bun test tests/server-trash-import-export.test.ts`
Expected: PASS

- [ ] **Step 7: 全量门禁**

Run: `bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/server.ts tests/server-trash-import-export.test.ts
git commit -m "feat(server): 批量删除/回收站/导出/导入 7 路由 + status trashCount（spec §API）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: web api.ts — wrappers + TrashItem + status 字段

**Files:**
- Modify: `src/web/api.ts`（追加 wrappers + TrashItem 类型 + MemsideStatus.trashCount）
- Test: `tests/web-api-trash.test.ts`

**Interfaces:**
- Consumes: 无（纯 fetch wrapper，沿用 `FetchLike` seam）。
- Produces（供 App.tsx Task 8 使用）：
  - `bulkDelete(ids: string[], fetchFn?): Promise<{ deleted: number; skipped: number }>`
  - `emptyTrash(fetchFn?): Promise<{ emptied: number }>`
  - `restoreFromTrash(id: string, fetchFn?): Promise<MemoryItem | undefined>`（no-throw 契约，与 restoreMemory 同）
  - `listTrashPage(fetchFn?, opts): Promise<PageDto<TrashItem>>`
  - `getTrash(id: string, fetchFn?): Promise<TrashItem & { memory: MemoryItem | null } | null>`
  - `exportMemories(opts: { scope, ids?, filter?, statuses?, format }, fetchFn?): Promise<Blob>`（返回 Blob 供浏览器下载——JSON 和 markdown 都走 Blob 统一下载）
  - `importMemories(file: File, conflict: 'skip'|'overwrite'|'newid', fetchFn?): Promise<{ imported, skipped, overwritten, errors }>`
  - 类型 `TrashItem`（与 `TrashRow` 同构的 web 侧类型）
  - `MemsideStatus` 加 `trashCount?: number`

- [ ] **Step 1: 写失败测试**

`tests/web-api-trash.test.ts`：

```ts
import { test, expect } from 'bun:test'
import { bulkDelete, emptyTrash, restoreFromTrash, listTrashPage, exportMemories, importMemories as importApi, type TrashItem } from '../src/web/api'

function fakeFetch(responder: (url: string, init?: RequestInit) => Response) {
  return ((url: string, init?: RequestInit) => Promise.resolve(responder(url, init))) as any
}

test('bulkDelete posts ids', async () => {
  let captured: { url: string; body: string } | null = null
  const f = fakeFetch((url, init) => { captured = { url, body: init?.body as string }; return new Response(JSON.stringify({ deleted: 2, skipped: 0 }), { status: 200 }) })
  const r = await bulkDelete(['a', 'b'], f)
  expect(r.deleted).toBe(2)
  expect(captured!.url).toBe('/api/memories/bulk-delete')
  expect(JSON.parse(captured!.body).ids).toEqual(['a', 'b'])
})

test('exportMemories returns Blob', async () => {
  const f = fakeFetch(() => new Response('md content', { status: 200, headers: { 'content-type': 'text/markdown' } }))
  const blob = await exportMemories({ scope: 'all', format: 'markdown' }, f)
  expect(blob).toBeInstanceOf(Blob)
  expect(await blob.text()).toBe('md content')
})

test('importMemories uploads FormData with file', async () => {
  let capturedInit: RequestInit | null = null
  const f = fakeFetch((_url, init) => { capturedInit = init; return new Response(JSON.stringify({ imported: 1, skipped: 0, overwritten: 0, errors: [] }), { status: 200 }) })
  const file = new File(['content'], 'm.json', { type: 'application/json' })
  const r = await importApi(file, 'skip', f)
  expect(r.imported).toBe(1)
  expect(capturedInit!.body).toBeInstanceOf(FormData)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/web-api-trash.test.ts`
Expected: FAIL（函数不存在）

- [ ] **Step 3: 在 `src/web/api.ts` 追加实现**

先在 `MemsideStatus` interface（`:92` 附近）加字段：

```ts
  /** 回收站条目数（spec 2026-08-16 回收站 tab 徽标）；老 daemon 无此字段。 */
  trashCount?: number
```

在文件末尾追加 wrappers（复用 `PageDto`/`parsePage`/`pageParams`/`MemoryItem`）：

```ts
// --- 回收站 + 批量删除 + 导出/导入 client（spec 2026-08-16）----------------

export interface TrashItem {
  id: string
  originalMemoryId: string
  scopeType: string
  scopeId: string | null
  sourceCwd: string | null
  runtime: string | null
  deletedAt: number
  title: string
  valueClass: string | null
  subjectSlug: string | null
}

/** POST /api/memories/bulk-delete — no-throw 契约（与 bulkRejectUnevaluated 同）。 */
export async function bulkDelete(
  ids: string[], fetchFn: FetchLike = fetch,
): Promise<{ deleted: number; skipped: number }> {
  const res = await fetchFn('/api/memories/bulk-delete', {
    method: 'POST', body: JSON.stringify({ ids }), headers: { 'content-type': 'application/json' },
  })
  return (await res.json()) as { deleted: number; skipped: number }
}

/** POST /api/trash/empty — no-throw 契约。 */
export async function emptyTrash(fetchFn: FetchLike = fetch): Promise<{ emptied: number }> {
  const res = await fetchFn('/api/trash/empty', { method: 'POST' })
  return (await res.json()) as { emptied: number }
}

/** POST /api/trash/:id/restore — no-throw 契约（与 restoreMemory 同模式，404/409 返回 undefined）。 */
export async function restoreFromTrash(
  id: string, fetchFn: FetchLike = fetch,
): Promise<MemoryItem | undefined> {
  const res = await fetchFn(`/api/trash/${id}/restore`, { method: 'POST' })
  if (!res.ok) return undefined
  const data = await res.json() as { memory?: MemoryItem }
  return data.memory
}

/** GET /api/trash — 分页（与 listMemoriesPage 同形状）。 */
export async function listTrashPage(
  fetchFn: FetchLike = fetch,
  opts: { project?: string; category?: string; slug?: string; valueClass?: string } & PageOpts = {},
): Promise<PageDto<TrashItem>> {
  const p = pageParams(opts)
  if (opts.project) p.set('project', opts.project)
  if (opts.category) p.set('category', opts.category)
  if (opts.slug) p.set('slug', opts.slug)
  if (opts.valueClass) p.set('valueClass', opts.valueClass)
  return parsePage<TrashItem>(await fetchFn(`/api/trash?${p}`))
}

/**
 * POST /api/memories/export — 返回 Blob（JSON/markdown 统一下载触发）。UI 用
 * URL.createObjectURL + <a download> 落盘（spec §Web UI §3）。
 */
export async function exportMemories(
  opts: { scope: 'selected' | 'filter' | 'all'; ids?: string[]; filter?: { sourceCwd?: string; subjectSlug?: string; category?: string; valueClass?: string }; statuses?: string[]; format: 'json' | 'markdown' },
  fetchFn: FetchLike = fetch,
): Promise<Blob> {
  const res = await fetchFn('/api/memories/export', {
    method: 'POST', body: JSON.stringify(opts), headers: { 'content-type': 'application/json' },
  })
  return res.blob()
}

/** POST /api/memories/import?conflict= — multipart 上传单文件。 */
export async function importMemories(
  file: File, conflict: 'skip' | 'overwrite' | 'newid', fetchFn: FetchLike = fetch,
): Promise<{ imported: number; skipped: number; overwritten: number; errors: string[] }> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetchFn(`/api/memories/import?conflict=${conflict}`, { method: 'POST', body: form })
  return (await res.json()) as { imported: number; skipped: number; overwritten: number; errors: string[] }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/web-api-trash.test.ts`
Expected: PASS

- [ ] **Step 5: 全量门禁**

Run: `bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/web/api.ts tests/web-api-trash.test.ts
git commit -m "feat(web): api wrappers 批量删除/回收站/导出/导入 + trashCount（spec §Web UI）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: tab-cache.ts — isListTab + tabTotalCount 加 trash

**Files:**
- Modify: `src/web/tab-cache.ts:111`（`isListTab`）+ `:88`（`tabTotalCount`）
- Test: `tests/tab-cache.test.ts`（既有文件，加 trash 断言）

**Interfaces:**
- Consumes: 无
- Produces: `isListTab('trash') === true`；`tabTotalCount(s, 'trash')` 返回 `s.trashCount ?? 0`。

- [ ] **Step 1: 写失败测试**（追加到 `tests/tab-cache.test.ts`）

```ts
test('isListTab(trash) = true', () => {
  expect(isListTab('trash')).toBe(true)
})

test('tabTotalCount(trash) = trashCount', () => {
  expect(tabTotalCount({ memories: {}, discards: 0, trashCount: 5 } as any, 'trash')).toBe(5)
  expect(tabTotalCount({ memories: {}, discards: 0 } as any, 'trash')).toBe(0)
})
```

> 若 `tabTotalCount` 的第二个参数类型是 `'candidate'|'approved'|'rejected'|'discards'|'runs'` 联合，需扩展加 `'trash'`。检查 `tab-cache.ts:88-99` 的签名。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/tab-cache.test.ts`
Expected: FAIL（trash 未识别）

- [ ] **Step 3: 修改 `src/web/tab-cache.ts`**

`isListTab`（`:111`）已是 `tab !== 'settings'`，trash 天然为 true，无需改（确认测试是否已过——若过则 Task 仅扩 `tabTotalCount`）。

`tabTotalCount`（`:88`）签名扩 `'trash'`，加分支：

```ts
export function tabTotalCount(
  s: TabStatusCounts | null,
  tab: 'candidate' | 'approved' | 'rejected' | 'discards' | 'runs' | 'trash',
): number | null {
  if (!s) return null
  switch (tab) {
    case 'candidate': return s.memories.candidate ?? 0
    case 'approved': return (s.memories.approved ?? 0) + (s.memories.archived ?? 0) + (s.memories.superseded ?? 0)
    case 'rejected': return s.memories.rejected ?? 0
    case 'discards': return s.discards
    case 'runs': return s.distillRuns?.allTime ?? s.distillRuns?.total ?? 0
    case 'trash': return (s as { trashCount?: number }).trashCount ?? 0
  }
}
```

`TabStatusCounts` interface（`:74`）加 `trashCount?: number`：

```ts
export interface TabStatusCounts {
  memories: Record<string, number>
  discards: number
  distillRuns?: { total: number; allTime?: number }
  trashCount?: number
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/tab-cache.test.ts`
Expected: PASS

- [ ] **Step 5: 全量门禁**

Run: `bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/web/tab-cache.ts tests/tab-cache.test.ts
git commit -m "feat(web): tab-cache 支持 trash tab（isListTab + tabTotalCount）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: App.tsx — 回收站 tab + TrashCard + refresh/loadMore 接线

**Files:**
- Modify: `src/web/App.tsx`（TabKey 加 trash；trash state；refresh/loadMore 加 trash 分支；tabs 数组加 trash；TrashCard 组件；trash 渲染分支）
- Test: `tests/app-trash-tab.test.ts`（源码层文本断言兜底）

**Interfaces:**
- Consumes: Task 7 的 api wrappers；Task 8 的 tab-cache。
- Produces: 第 8 个 tab「回收站」可切换、可分页、可筛选、可恢复、可清空。

> 本任务只做回收站 tab 的**数据流**（state + refresh + loadMore + tab 注册 + 渲染骨架 + TrashCard + 恢复/清空按钮）。多选 + 批量操作条 + 导出导入入口在 Task 10。

- [ ] **Step 1: 写失败测试**（源码层文本断言，对齐既有运行时组件兜底模式）

`tests/app-trash-tab.test.ts`：

```ts
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

const src = readFileSync(join(import.meta.dir, '../src/web/App.tsx'), 'utf8')

// 回收站 tab 数据流接线（spec §Web UI §4）。源码层文本断言兜底——
// 运行时组件无法直接单测，锁住关键 token 防回归。
test('App.tsx 含回收站 tab key 与渲染分支', () => {
  expect(src).toContain("'trash'")
  expect(src).toContain('TrashCard')
})

test('App.tsx 含清空回收站 + 恢复按钮 token', () => {
  expect(src).toContain('清空回收站')
  expect(src).toContain('恢复')
})

test('App.tsx trash 走 listTrashPage / emptyTrash / restoreFromTrash', () => {
  expect(src).toContain('listTrashPage')
  expect(src).toContain('emptyTrash')
  expect(src).toContain('restoreFromTrash')
})
```

> import `join` from `node:path`。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/app-trash-tab.test.ts`
Expected: FAIL（token 不存在）

- [ ] **Step 3: 修改 `src/web/App.tsx`**

a) `:1` import 加新 wrapper：

```ts
import {
  listMemoriesPage, listDiscardsPage, listDistillRunsPage, WEB_PAGE_SIZE,
  promoteMemory, patchMemory, getStatus, getSourceInput,
  restoreMemory, archiveMemory, unarchiveMemory, promoteDiscard,
  getDistillRun, getDistillRunSourceInput, getRunDegradations,
  getLlmSettings, saveLlmSettings, testLlmConnection, testEffectiveLlmConnection,
  fetchJudgeConfig, saveJudgeConfig, startRescan, cancelRescan,
  getFacets, UNEVALUATED,
  listNotificationsPage, markNotificationRead, markAllNotificationsRead,
  bulkRejectUnevaluated as bulkRejectUnevaluatedApi,
  bulkDelete, emptyTrash, restoreFromTrash, listTrashPage,
  type MemoryItem, type MemsideStatus, type SourceInput, type SourceTurn, type DiscardItem,
  type DistillRunListItem, type LlmSettingsState, type JudgeConfigDto, type Facets, type FacetTab,
  type NotificationItem, type TrashItem,
} from './api'
```

b) `:32` `TabKey` 加 `'trash'`：

```ts
type TabKey = 'candidate' | 'approved' | 'rejected' | 'discards' | 'runs' | 'settings' | 'messages' | 'trash'
```

c) `:67` 附近加 trash state：

```ts
const [trash, setTrash] = useState<TabPage<TrashItem>>(emptyPage())
```

d) `loaded`/`pending`/`loadingMore`/`loadMoreError` 初始 Record 加 `trash` 键（既有对象字面量补 `trash: false` / `trash: true`（pending candidate 初始 true，trash 初始 false））。

e) `refresh`（`:103`）加 trash 分支（在 `messages` 之后、else 之前，或与 discards/runs 并列）。trash 拉列表 + status（不拉 facets，或拉 trash facets——本任务先只拉列表+status）：

```ts
      } else if (target === 'trash') {
        const f = filterOverride ?? filterRef.current
        const [pg, st] = await Promise.all([
          listTrashPage(fetch, { limit: WEB_PAGE_SIZE, project: f.project, category: f.category, slug: f.slug, valueClass: f.valueClass }),
          getStatus(fetch),
        ])
        setTrash((t) => ({ ...mergeRefreshPage(t, pg, (x) => x.id), total: pg.total ?? null }))
        setStatus(st)
      }
```

f) `loadMore`（`:166`）加 trash 分支：

```ts
      } else if (target === 'trash') {
        const f = filterRef.current
        const pg = await listTrashPage(fetch, { limit: WEB_PAGE_SIZE, before, project: f.project, category: f.category, slug: f.slug, valueClass: f.valueClass })
        setTrash((t) => ({ items: mergeAppend(t.items, pg.items, (x) => x.id), nextCursor: pg.nextCursor, hasMore: pg.hasMore, total: t.total }))
      }
```

g) `tabPageOf`（`:160`）加 trash 返回：

```ts
  function tabPageOf(target: TabKey): TabPage<MemoryItem> | TabPage<DiscardItem> | TabPage<DistillRunListItem> | TabPage<NotificationItem> | TabPage<TrashItem> {
    return target === 'discards' ? discards : target === 'runs' ? runs : target === 'messages' ? msgs : target === 'trash' ? trash : memCache[target as MemoryTabKey]
  }
```

h) `tabs` 数组（`:382`）加 trash：

```ts
    { key: 'trash', label: '回收站', count: status?.trashCount ?? null },
```

i) `removeFromTab`（`:254`）加 trash 分支：

```ts
    } else if (target === 'trash') {
      setTrash((t) => ({ ...t, items: t.items.filter((x) => x.id !== id) }))
    }
```

j) `changeFilter`（`:361`）加 trash 作废缓存：

```ts
    if (tab === 'discards') setDiscards(emptyPage())
    else if (tab === 'trash') setTrash(emptyPage())
    else setMemCache((c) => ({ ...c, [tab]: emptyPage() }))
```

k) `listEmpty`（`:372`）加 trash 判定：

```ts
  const listEmpty = tab === 'messages' ? msgs.items.length === 0
    : tab === 'discards' ? discards.items.length === 0
    : tab === 'runs' ? runs.items.length === 0
    : tab === 'trash' ? trash.items.length === 0
    : (memCache[tab as MemoryTabKey]?.items ?? []).length === 0
```

l) 渲染分支（在 `rejected` 分支之后、`runs` 之前，或在末尾 else 之后——按现有 `tab === 'xxx' ?` 链补）加 trash 分支。在 `:798` `runs` 分支前插入：

```tsx
      ) : tab === 'trash' ? (
        <>
          <p>{`${tabTotalCount(status, 'trash') ?? trash.items.length} 条回收站记忆`}</p>
          <div style={{ marginBottom: 12 }}>
            <button onClick={() => void emptyTrashClick()} style={{ color: '#c00' }}>清空回收站</button>
            <span style={{ fontSize: 12, color: '#888', marginLeft: 8 }}>清空后不可恢复</span>
          </div>
          {trash.items.map((t) => (
            <TrashCard key={t.id} t={t} onRestore={() => restoreTrash(t.id)} />
          ))}
          {trash.items.length === 0 && !showLoading && (
            <p style={{ color: '#666' }}>回收站为空</p>
          )}
        </>
      ) : tab === 'runs' ? (
```

注意原 `runs` 分支前是 `) : tab === 'runs' ? (`，需把它改成 `) : tab === 'trash' ? ( ... ) : tab === 'runs' ? (`。**修正**：在 rejected 分支结束 `)` 后、`runs` 分支前插入 trash 三元。

m) 加 handler：

```ts
  async function emptyTrashClick() {
    if (!window.confirm('确认清空回收站？清空后不可恢复。')) return
    await emptyTrash()
    setTrash(emptyPage())
    void refresh('trash')
  }
  async function restoreTrash(id: string) {
    await restoreFromTrash(id)
    removeFromTab('trash', id)
    void refresh('trash')
  }
```

n) 文件末尾加 `TrashCard` 组件（仿 DiscardCard `:1261`）：

```tsx
/**
 * 回收站卡片（trash tab）。展示标题（剥 category 前缀）+ 分类/价值徽标 + 来源项目 +
 * 删除时间 + 「恢复」按钮。恢复调 restoreFromTrash（no-throw，操作后 refresh）。
 */
function TrashCard({ t, onRestore }: { t: TrashItem; onRestore: () => void }) {
  const sourceLabel = t.sourceCwd
    ? (t.sourceCwd.split(/[\\/]/).filter(Boolean).pop() ?? t.sourceCwd)
    : t.runtime === 'opencode' ? 'opencode' : '未知'
  const time = formatMemoryTime(t.deletedAt)
  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 16, marginBottom: 12 }}>
      <strong>{stripCategoryPrefix(t.title)}</strong>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0' }}>
        {(() => { const cat = categoryInfo(categoryFromTitle(t.title)); return cat ? (
          <span title={cat.tip} style={{ ...CHIP_STYLE, color: '#444' }}>分类：{cat.name}</span>
        ) : null })()}
        {(() => { const v = valueClassInfo(t.valueClass); return (
          <span title={v.tip} style={{ ...CHIP_STYLE, color: '#444' }}>价值：{v.name}</span>
        ) })()}
        {t.subjectSlug ? (
          <span title={SLUG_BADGE_TIP} style={{ ...CHIP_STYLE, color: '#36c' }}>主题：{t.subjectSlug}</span>
        ) : null}
      </div>
      <small>
        {(() => { const s = scopeInfo(t.scopeType as 'project' | 'global'); return (
          <span title={s.tip}>范围: {s.name}</span>
        ) })()}
        {' · '}
        <span>源项目: <span title={t.sourceCwd ?? ''}>{sourceLabel}</span></span>
        {time ? <>{' · '}<span title="移入回收站的时间">删除于: {time}</span></> : null}
      </small>
      <div style={{ marginTop: 8 }}>
        <button onClick={onRestore}>恢复</button>
      </div>
    </div>
  )
}
```

o) `trash` tab 也要能筛选——`isFilterTab`（`:35`）当前不含 trash。**决策**：trash tab 复用筛选条。扩展 `isFilterTab` 加 `|| t === 'trash'`，并把 `FacetTab` 类型（api.ts）加 `'trash'`。需在 `src/web/api.ts` 的 `FacetTab` 类型加 `'trash'`，并在 server.ts `FACET_TAB_SCOPES` 加 `trash: { kind: 'discards' }`——但 trash 表 facets 与 discards 不同。**简化决策**：trash tab 筛选用独立 `listTrashFacets`，但为控制本任务范围，**trash tab 暂不接筛选下拉**（仅展示列表 + 分页），筛选留 follow-up。故 `isFilterTab('trash')` 保持 false（不渲染筛选条），`filter` 在 trash 分支用 `EMPTY_MEMORY_FILTER`。**修正 handler**：trash 的 refresh/loadMore 不用 filter，改用空 filter：

```ts
      } else if (target === 'trash') {
        const [pg, st] = await Promise.all([
          listTrashPage(fetch, { limit: WEB_PAGE_SIZE }),
          getStatus(fetch),
        ])
        setTrash((t) => ({ ...mergeRefreshPage(t, pg, (x) => x.id), total: pg.total ?? null }))
        setStatus(st)
      }
```

loadMore trash 分支同样只用 `{ limit: WEB_PAGE_SIZE, before }`。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/app-trash-tab.test.ts`
Expected: PASS

- [ ] **Step 5: 全量门禁**

Run: `bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/web/App.tsx tests/app-trash-tab.test.ts
git commit -m "feat(web): 回收站 tab + TrashCard + 恢复/清空（spec §Web UI §4）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 10: App.tsx — 多选 + 批量操作条 + 导出导入入口

**Files:**
- Modify: `src/web/App.tsx`（selectedIds state；MemoryCard selection props；批量操作条；导出导入入口 + 文件下载/上传）
- Test: `tests/app-batch-export-import.test.ts`（源码层文本断言兜底）

**Interfaces:**
- Consumes: Task 7 api wrappers（bulkDelete/exportMemories/importMemories）。
- Produces: 记忆三 tab 多选 + 批量操作条（删/批/批拒/归档等）+ 导出下拉 + 导入对话框 + 浏览器下载。

- [ ] **Step 1: 写失败测试**

`tests/app-batch-export-import.test.ts`：

```ts
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(import.meta.dir, '../src/web/App.tsx'), 'utf8')

test('App.tsx 含多选 + 批量操作条 token', () => {
  expect(src).toContain('selectedIds')
  expect(src).toContain('已选')
  expect(src).toContain('批量删除')
})

test('App.tsx 含导出/导入入口 token', () => {
  expect(src).toContain('导出')
  expect(src).toContain('导入')
  expect(src).toContain('exportMemories')
  expect(src).toContain('importMemories')
})

test('App.tsx 含冲突策略选项 token', () => {
  expect(src).toContain('跳过已存在')
  expect(src).toContain('覆盖已存在')
  expect(src).toContain('全部新建')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/app-batch-export-import.test.ts`
Expected: FAIL

- [ ] **Step 3: 修改 `src/web/App.tsx`**

a) import 加 `bulkDelete, exportMemories, importMemories as importMemoriesApi`（Task 9 已 import bulkDelete/emptyTrash/restoreFromTrash，补 exportMemories/importMemories）。

b) 加 state（`:76` 附近）：

```ts
  const [selectedIds, setSelectedIds] = useState<Record<MemoryTabKey, Set<string>>>({ candidate: new Set(), approved: new Set(), rejected: new Set() })
  const [exportOpen, setExportOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importConflict, setImportConflict] = useState<'skip' | 'overwrite' | 'newid'>('skip')
  const [importResult, setImportResult] = useState<string | null>(null)
```

c) 切 tab 清选择（`useEffect [tab]` 轮询重建处 `:229` 附近，或在 setTab 包一层）：

```ts
  const switchTab = (t: TabKey) => {
    setTab(t)
    setSelectedIds({ candidate: new Set(), approved: new Set(), rejected: new Set() })
  }
```

把 tabs 数组的 `onClick={() => setTab(t.key)}` 改为 `onClick={() => switchTab(t.key)}`。

d) 选择 helper：

```ts
  function toggleSelect(id: string) {
    if (!isMemoryTab(tab)) return
    setSelectedIds((s) => {
      const next = new Set(s[tab])
      if (next.has(id)) next.delete(id); else next.add(id)
      return { ...s, [tab]: next }
    })
  }
  function selectAllPage() {
    if (!isMemoryTab(tab)) return
    setSelectedIds((s) => ({ ...s, [tab]: new Set(memItems.map((m) => m.id)) }))
  }
  function clearSelection() {
    if (!isMemoryTab(tab)) return
    setSelectedIds((s) => ({ ...s, [tab]: new Set() }))
  }
```

加 `isMemoryTab` helper（`:35` 附近）：

```ts
function isMemoryTab(t: TabKey): t is MemoryTabKey {
  return t === 'candidate' || t === 'approved' || t === 'rejected'
}
```

e) 批量删除 handler：

```ts
  async function bulkDeleteSelected() {
    if (!isMemoryTab(tab)) return
    const ids = [...selectedIds[tab]]
    if (ids.length === 0) return
    if (!window.confirm(`确认将 ${ids.length} 条移入回收站？可从回收站恢复`)) return
    await bulkDelete(ids)
    setSelectedIds((s) => ({ ...s, [tab]: new Set() }))
    setMemCache((c) => ({ ...c, [tab]: emptyPage() }))
    void refresh(tab)
  }
```

f) MemoryCard 加 selection props。`:1111` 签名加 `selected?: boolean; onToggleSelect?: () => void`，卡片左上角渲染 checkbox（非 editing 时）：

在 MemoryCard props 类型加：

```ts
  selected?: boolean
  onToggleSelect?: () => void
```

在 `:1180` `<strong>` 之前加：

```tsx
          {onToggleSelect ? (
            <input type="checkbox" checked={selected ?? false} onChange={onToggleSelect} style={{ marginRight: 8 }} />
          ) : null}
```

调用处（candidate `:731`/approved `:758`/rejected `:782`）传 `selected={selectedIds[tab].has(m.id)} onToggleSelect={() => toggleSelect(m.id)}`。

g) 批量操作条：在记忆三 tab 的列表上方（各 `<p>...</p>` 之后）渲染。抽一个内联块（candidate/approved/rejected 共用）。在 candidate 分支 `:674` 的 `<p>` 后加：

```tsx
          {isMemoryTab(tab) && selectedIds[tab].size > 0 ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, padding: 8, border: '1px solid #e0e0e0', borderRadius: 8, background: '#fafafa' }}>
              <span style={{ fontSize: 13 }}>已选 {selectedIds[tab].size} 条</span>
              <button onClick={selectAllPage}>全选当前页</button>
              <button onClick={clearSelection}>取消选择</button>
              <span style={{ marginLeft: 'auto' }} />
              {tab === 'candidate' ? (
                <>
                  <button onClick={() => void bulkApproveSelected()}>批量批准</button>
                  <button onClick={() => void bulkRejectSelected()}>批量拒绝</button>
                </>
              ) : null}
              {tab === 'approved' ? (
                <>
                  <button onClick={() => void bulkArchiveSelected()}>批量归档</button>
                  <button onClick={() => void bulkUnarchiveSelected()}>批量取消归档</button>
                </>
              ) : null}
              {tab === 'rejected' ? (
                <button onClick={() => void bulkRestoreSelected()}>批量恢复</button>
              ) : null}
              <button onClick={() => void bulkDeleteSelected()} style={{ color: '#c00' }}>批量删除</button>
            </div>
          ) : null}
```

> 三 tab 各自的 `<p>` 之后都要这块。为 DRY 可抽一个 `<MemoryBatchBar tab={tab} />` 子组件，但为减小改动面，先在 candidate 分支放一份，approved/rejected 分支复制（既有代码风格也是各 tab 重复结构）。实际操作时复制三次。

h) 批量 approve/reject/archive/unarchive/restore handler（复用既有 bulkPromote API client + 逐条 archive/unarchive/restore）：

```ts
  async function bulkApproveSelected() {
    if (!isMemoryTab(tab)) return
    for (const id of selectedIds[tab]) {
      try { await promoteMemory(id, { action: 'approve' }) } catch {}
    }
    setSelectedIds((s) => ({ ...s, [tab]: new Set() }))
    setMemCache((c) => ({ ...c, [tab]: emptyPage() }))
    void refresh(tab)
  }
  async function bulkRejectSelected() {
    if (!isMemoryTab(tab)) return
    for (const id of selectedIds[tab]) {
      try { await promoteMemory(id, { action: 'reject' }) } catch {}
    }
    setSelectedIds((s) => ({ ...s, [tab]: new Set() }))
    setMemCache((c) => ({ ...c, [tab]: emptyPage() }))
    void refresh(tab)
  }
  async function bulkArchiveSelected() {
    if (tab !== 'approved') return
    for (const id of selectedIds[tab]) { try { await archiveMemory(id) } catch {} }
    setSelectedIds((s) => ({ ...s, [tab]: new Set() })); void refresh(tab)
  }
  async function bulkUnarchiveSelected() {
    if (tab !== 'approved') return
    for (const id of selectedIds[tab]) { try { await unarchiveMemory(id) } catch {} }
    setSelectedIds((s) => ({ ...s, [tab]: new Set() })); void refresh(tab)
  }
  async function bulkRestoreSelected() {
    if (tab !== 'rejected') return
    for (const id of selectedIds[tab]) { try { await restoreMemory(id) } catch {} }
    setSelectedIds((s) => ({ ...s, [tab]: new Set() }))
    setMemCache((c) => ({ ...c, [tab]: emptyPage() }))
    void refresh(tab)
  }
```

i) 导出/导入入口：在筛选条之前（或 tab 栏之后）加工具栏。在 `:392` `<div style={{...}}>` 主容器内、tab 栏 div 之后加：

```tsx
      {isMemoryTab(tab) ? (
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <button onClick={() => setExportOpen(true)}>导出</button>
          <button onClick={() => setImportOpen(true)}>导入</button>
        </div>
      ) : null}
```

j) 导出对话框：

```tsx
      {exportOpen ? (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }} onClick={() => setExportOpen(false)}>
          <div style={{ background: '#fff', padding: 24, borderRadius: 8, minWidth: 320 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>导出记忆</h3>
            <p style={{ fontSize: 13, color: '#666' }}>选择导出范围与格式。memside JSON 高保真（保留状态）；Markdown 低保真（人类可读）。</p>
            <ExportTrigger onDone={() => setExportOpen(false)} />
          </div>
        </div>
      ) : null}
```

`ExportTrigger` 组件（内部维护 scope + format 两个选择 + 导出按钮 → 下载）：

```tsx
function ExportTrigger({ onDone }: { onDone: () => void }) {
  const [scope, setScope] = useState<'selected' | 'filter' | 'all'>('all')
  const [format, setFormat] = useState<'json' | 'markdown'>('json')
  const [busy, setBusy] = useState(false)
  async function doExport() {
    setBusy(true)
    try {
      const blob = await exportMemories({ scope, format })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = format === 'json' ? 'memside-export.json' : 'memside-export.md'
      a.click()
      URL.revokeObjectURL(url)
      onDone()
    } finally { setBusy(false) }
  }
  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <label><input type="radio" checked={scope === 'selected'} onChange={() => setScope('selected')} /> 导出选中</label>{' '}
        <label><input type="radio" checked={scope === 'filter'} onChange={() => setScope('filter')} /> 导出当前筛选</label>{' '}
        <label><input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} /> 导出全部</label>
      </div>
      <div style={{ marginBottom: 8 }}>
        <label><input type="radio" checked={format === 'json'} onChange={() => setFormat('json')} /> memside JSON</label>{' '}
        <label><input type="radio" checked={format === 'markdown'} onChange={() => setFormat('markdown')} /> Markdown</label>
      </div>
      <button onClick={doExport} disabled={busy}>{busy ? '导出中…' : '下载'}</button>
      <button onClick={onDone}>取消</button>
    </div>
  )
}
```

> 注意：`scope:'selected'` 需要把当前 tab 选中 ids 传入。简化：ExportTrigger 接受 `selectedIds: string[]` prop，`scope==='selected'` 时传 `ids: selectedIds`。把 `<ExportTrigger selectedIds={isMemoryTab(tab) ? [...selectedIds[tab]] : []} onDone={...} />`。

k) 导入对话框：

```tsx
      {importOpen ? (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }} onClick={() => { setImportOpen(false); setImportResult(null) }}>
          <div style={{ background: '#fff', padding: 24, borderRadius: 8, minWidth: 320 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>导入记忆</h3>
            <p style={{ fontSize: 13, color: '#666' }}>支持 memside JSON 与 Markdown，自动识别格式。</p>
            <ImportTrigger onResult={(msg) => { setImportResult(msg); void refresh(tab) }} />
            {importResult ? <p style={{ fontSize: 13, color: '#080' }}>{importResult}</p> : null}
          </div>
        </div>
      ) : null}
```

`ImportTrigger` 组件（文件选择 + 冲突策略 + 上传）：

```tsx
function ImportTrigger({ onResult }: { onResult: (msg: string) => void }) {
  const [conflict, setConflict] = useState<'skip' | 'overwrite' | 'newid'>('skip')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true); setError(null)
    try {
      const r = await importMemoriesApi(file, conflict)
      onResult(`导入 ${r.imported} 条 · 跳过 ${r.skipped} · 覆盖 ${r.overwritten}` + (r.errors.length ? ` · 错误 ${r.errors.length}` : ''))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }
  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <label><input type="radio" checked={conflict === 'skip'} onChange={() => setConflict('skip')} /> 跳过已存在</label>{' '}
        <label><input type="radio" checked={conflict === 'overwrite'} onChange={() => setConflict('overwrite')} /> 覆盖已存在</label>{' '}
        <label><input type="radio" checked={conflict === 'newid'} onChange={() => setConflict('newid')} /> 全部新建</label>
      </div>
      <input type="file" accept=".json,.md" onChange={onFile} disabled={busy} />
      {busy ? <span style={{ fontSize: 13, color: '#888' }}>导入中…</span> : null}
      {error ? <p style={{ color: '#c00', fontSize: 13 }}>{error}</p> : null}
    </div>
  )
}
```

> `React.ChangeEvent` 需 import React 类型——App.tsx 当前 `import { useEffect, useRef, useState } from 'react'`，加 `import type { ChangeEvent } from 'react'` 并用 `ChangeEvent<HTMLInputElement>`。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/app-batch-export-import.test.ts`
Expected: PASS

- [ ] **Step 5: 全量门禁**

Run: `bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/web/App.tsx tests/app-batch-export-import.test.ts
git commit -m "feat(web): 多选 + 批量操作条 + 导出/导入入口（spec §Web UI §1-3）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 11: 最终验证 + STATE.md 落档

**Files:**
- Modify: `STATE.md`（追加本轮记录段）

**Interfaces:**
- Consumes: 全部前置任务。
- Produces: 全量门禁全绿 + STATE.md 记录。

- [ ] **Step 1: 全量门禁（最终）**

Run: `bun run typecheck && bun test`
Expected: PASS（全绿，含本轮所有新测试 + 既有 980+ 测试不回归）

- [ ] **Step 2: 推远端 + PR**

```bash
git push -u origin feat/memory-portability-and-batch-ops
```

用 `gh` 开 PR（目标 master）。PR 标题：`feat: 记忆批量删除（回收站）+ 导出/导入 + 多选批量操作`。PR body 说明实现的四块 + 测试数。

- [ ] **Step 3: STATE.md 落档**

在 `STATE.md` 顶部追加本轮记录段（仿既有 2026-08-1x 段格式），概述：
- 回收站机制（memory_trash 表 + 删/恢复/清空）
- 批量删除（多选 + per-tab 批量操作条 + bulk-delete 路由）
- 导出（三档作用域 × JSON/MD + export 路由 + 浏览器下载）
- 导入（multipart 上传 + 格式自动识别 + 三冲突策略 + 10000 cap + import 路由）
- importMemories 高保真 seam（恢复 + JSON 导入共用，绕过 createCandidate status 硬编码）
- 测试覆盖（exchange/trash/store/server/web-api/tab-cache/app 多层）
- 上线后观测清单 + deferred minor

- [ ] **Step 4: Commit STATE.md**

```bash
git add STATE.md
git commit -m "docs: 记忆批量删除+导出导入落档 STATE.md（spec 2026-08-16）

Co-Authored-By: Claude <noreply@anthropic.com>"
git push
```

---

## Self-Review

**1. Spec coverage:**
- 回收站机制（删/恢复/清空）→ Task 1（表）+ Task 2（快照）+ Task 5（store bulkDeleteMemories/restoreFromTrash/emptyTrash）+ Task 6（路由）+ Task 9（UI tab）✓
- 批量删除（多选 → 移入回收站）→ Task 5（bulkDeleteMemories）+ Task 6（bulk-delete 路由）+ Task 10（多选 + 批量操作条）✓
- 批量导出（三档作用域 × 两格式）→ Task 3（JSON）+ Task 4（MD）+ Task 5（listMemoriesForExport）+ Task 6（export 路由）+ Task 7（exportMemories wrapper）+ Task 10（导出入口）✓
- 导入（两格式自动识别 + 三冲突策略）→ Task 3（detectExchangeFormat）+ Task 4（parseMemoriesMd）+ Task 5（importMemories）+ Task 6（import 路由）+ Task 7（importMemories wrapper）+ Task 10（导入对话框）✓
- 回收站 tab + 计数徽标 → Task 6（status trashCount）+ Task 8（tab-cache）+ Task 9（tab + TrashCard）✓
- 共享 seam（恢复 + 导入）→ Task 5（importMemories 复用）✓

**2. Placeholder scan:** 无 TBD/TODO；所有代码块完整。`ExportTrigger`/`ImportTrigger` 组件代码完整。✓

**3. Type consistency:**
- `bulkDeleteMemories(db, ids)` 一致（Task 5/6/7）✓
- `restoreFromTrash(db, id, {conflict})` 一致；UI 层 `restoreFromTrash(id)` wrapper（no-throw）✓
- `importMemories(db, records, {conflict})` store fn vs `importMemories(file, conflict)` api wrapper——**命名冲突**。修正：api wrapper 在 Task 7 已 alias 为 `importMemories as importMemoriesApi`（Task 10 用 importMemoriesApi）。但 Task 7 的导出名仍是 `importMemories`，App.tsx import 时 alias。确认 Task 10 import 行用 `importMemories as importMemoriesApi`。✓（已在 Task 10 Step 3a 注明）
- `TrashRow`（store）/`TrashItem`（api）同名不同结构——store 的 TrashRow 含 originalMemoryId 等，api 的 TrashItem 同构。一致。✓
- `listMemoriesForExport` 签名 Task 5/6 一致 ✓

所有一致。Plan 完成。
