# Subject-keyed 聚合层（第一期）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 approved 记忆加 subject slug 归组键，蒸馏时产出并入库、审批时可编辑、注入时按 slug 分节渲染（第一期纯分组渲染，无 LLM 合成）。

**Architecture:** distiller 输出 kebab-case `subjectSlug`（prompt 附现有 slug 清单促复用）→ `memories.subject_slug` 新列（幂等迁移，老行 NULL）→ store 层读写 + `listSubjectSlugs` 查询 → `formatMemoryBlock` 裁剪后分组渲染（预算语义零变更）。distiller 现有瞬态字段 `subject`（codebase|domain）机械改名 `ruleObject`。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite + zod；前端 Vite + React 19。测试 `bun test`，类型检查 `bun run typecheck`。

**Spec:** `docs/superpowers/specs/2026-07-28-subject-keyed-aggregation-design.md`（本计划小节号 §N 引用它）。

## Global Constraints

- slug 格式：正则 `^[a-z0-9]+(-[a-z0-9]+)*$`，最长 48 字符；解析先 trim + 转小写（spec §4.1）。
- slug 校验失败一律静默降级 NULL，不触发重试、不丢记忆（spec D6）。
- `clipByBudget` 顺序与语义一行不动；分组只是渲染层归拢（spec D5）；全 NULL slug 输出与现状逐字节一致。
- 老数据不回填，`subject_slug = NULL` = 未分组（spec §4.2）。
- 任何 commit 前 `bun run typecheck && bun test` 全绿（CLAUDE.md）。
- 分支 `feat/subject-keyed-aggregation`，禁止直推 master（CLAUDE.md）。

---

### Task 1: schema 列 + 幂等迁移

**Files:**
- Modify: `src/db/schema.ts:30`（`valueClass` 行之后）
- Modify: `src/db/client.ts:36`（CREATE TABLE DDL）+ `src/db/client.ts:106`（value_class 迁移块之后）
- Test: `tests/schema.test.ts`

**Interfaces:**
- Produces: `memories.subjectSlug`（drizzle 列，`text('subject_slug')`，nullable）；索引 `idx_memories_subject(scope_type, scope_id, subject_slug)`。后续所有任务依赖此列存在。

- [ ] **Step 1: 写失败测试**

在 `tests/schema.test.ts` 末尾（仿照现有 `value_class` 两个测试的模式）追加：

```ts
test('fresh db has subject_slug column + idx_memories_subject index', () => {
  db = openDb(join(dir, 'ss.db'))
  const cols = db.$client.prepare('PRAGMA table_info(memories)').all() as { name: string }[]
  expect(cols.some((c) => c.name === 'subject_slug')).toBe(true)
  const idx = db.$client.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memories_subject'").all() as { name: string }[]
  expect(idx.length).toBe(1)
})

test('migration adds subject_slug to pre-existing db, idempotent, no backfill', () => {
  const dbPath = join(dir, 'oldss.db')
  // 旧形态库：有 value_class、无 subject_slug（subject-keyed 聚合之前的形态）
  const old = new Database(dbPath)
  old.exec(`CREATE TABLE memories (id TEXT PRIMARY KEY, scope_type TEXT NOT NULL CHECK (scope_type IN ('project','global')), scope_id TEXT, runtime TEXT, title TEXT NOT NULL, body_md TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, source_kind TEXT NOT NULL, source_cwd TEXT, source_event_id TEXT, distill_job_id TEXT, distill_action TEXT, supersedes_id TEXT, superseded_by_id TEXT, approved_at INTEGER, created_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1, value_class TEXT, CHECK ((scope_type='global' AND scope_id IS NULL) OR (scope_type='project' AND scope_id IS NOT NULL)))`)
  old.exec(`INSERT INTO memories (id, scope_type, scope_id, title, body_md, tags, status, source_kind, created_at, version) VALUES ('p1','project','/r','t','b','[]','candidate','manual',1,1)`)
  old.close()
  const migrated = openDb(dbPath)
  const cols = migrated.$client.prepare('PRAGMA table_info(memories)').all() as { name: string }[]
  expect(cols.some((c) => c.name === 'subject_slug')).toBe(true)
  // no backfill: existing row stays NULL（NULL = 未分组，spec §4.2）
  const rows = migrated.$client.prepare('SELECT id, subject_slug FROM memories').all() as { id: string; subject_slug: string | null }[]
  expect(rows.find((r) => r.id === 'p1')!.subject_slug).toBeNull()
  migrated.$client.close()
  // 幂等：reopen 不抛（guard 跳过 ALTER，否则 duplicate column 报错）
  const reopened = openDb(dbPath)
  expect((reopened.$client.prepare('PRAGMA table_info(memories)').all() as { name: string }[]).some((c) => c.name === 'subject_slug')).toBe(true)
  reopened.$client.close()
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/schema.test.ts`
Expected: FAIL — 新列不存在。

- [ ] **Step 3: 实现 schema + 迁移**

`src/db/schema.ts`，在 `valueClass` 行后加：

```ts
    valueClass: text('value_class'), // nullable: decision|convention|trap|topology; null = unevaluated
    subjectSlug: text('subject_slug'), // nullable: kebab-case 主题归组键；null = 未分组（平铺注入）
```

`src/db/client.ts` CREATE TABLE DDL 中 `version` 行后加：

```ts
      version INTEGER NOT NULL DEFAULT 1,
      subject_slug TEXT,
```

`src/db/client.ts` 在 value_class 迁移块（约 106 行）之后加：

```ts
  // Idempotent migration: add subject_slug to pre-existing memories tables.
  // No backfill（NULL = 未分组，注入平铺，与旧行为一致，spec §4.2）。
  {
    const cols = raw.prepare('PRAGMA table_info(memories)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'subject_slug')) {
      raw.exec('ALTER TABLE memories ADD COLUMN subject_slug TEXT')
    }
    // Index here (after ALTER) not in DDL: CREATE TABLE IF NOT EXISTS is a no-op
    // on pre-existing tables, so a DDL index on subject_slug would fail with
    // "no such column" on older DBs before the ALTER runs (idx_distill_jobs_session 先例)。
    raw.exec('CREATE INDEX IF NOT EXISTS idx_memories_subject ON memories(scope_type, scope_id, subject_slug)')
  }
```

- [ ] **Step 4: 跑测试确认绿**

Run: `bun test tests/schema.test.ts && bun run typecheck`
Expected: PASS，tsc 干净。

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/client.ts tests/schema.test.ts
git commit -m "feat(schema): memories.subject_slug column + idempotent migration"
```

---

### Task 2: `normalizeSubjectSlug` 纯函数

**Files:**
- Modify: `src/memory/pure.ts`（文件末尾追加）
- Test: `tests/pure-subject-slug.test.ts`（新建）

**Interfaces:**
- Produces: `normalizeSubjectSlug(raw: unknown): string | null`、`SUBJECT_SLUG_MAX_LEN = 48`。Task 3（patchMemory 校验）与 Task 5（distiller 解析）消费。

- [ ] **Step 1: 写失败测试**

新建 `tests/pure-subject-slug.test.ts`：

```ts
import { test, expect } from 'bun:test'
import { normalizeSubjectSlug, SUBJECT_SLUG_MAX_LEN } from '@/memory/pure'

// subject-keyed 聚合（spec §4.1/D6）：slug 校验失败一律静默 null，永不抛。

test('accepts legal kebab-case slugs', () => {
  expect(normalizeSubjectSlug('refund-policy')).toBe('refund-policy')
  expect(normalizeSubjectSlug('a')).toBe('a')
  expect(normalizeSubjectSlug('hook-install-2')).toBe('hook-install-2')
})

test('normalizes case + surrounding whitespace', () => {
  expect(normalizeSubjectSlug('  Refund-Policy ')).toBe('refund-policy')
})

test('rejects illegal shapes -> null', () => {
  expect(normalizeSubjectSlug('refund policy')).toBeNull()   // 空格
  expect(normalizeSubjectSlug('refund_policy')).toBeNull()   // 下划线
  expect(normalizeSubjectSlug('-refund')).toBeNull()         // 前导连字符
  expect(normalizeSubjectSlug('refund-')).toBeNull()         // 尾随连字符
  expect(normalizeSubjectSlug('refund--policy')).toBeNull()  // 双连字符
  expect(normalizeSubjectSlug('退款')).toBeNull()             // 非 ascii
  expect(normalizeSubjectSlug('')).toBeNull()
  expect(normalizeSubjectSlug('   ')).toBeNull()
  expect(normalizeSubjectSlug('x'.repeat(SUBJECT_SLUG_MAX_LEN + 1))).toBeNull() // 超长
  expect(normalizeSubjectSlug('x'.repeat(SUBJECT_SLUG_MAX_LEN))).toBe('x'.repeat(SUBJECT_SLUG_MAX_LEN)) // 边界
})

test('non-string input -> null, never throws', () => {
  expect(normalizeSubjectSlug(undefined)).toBeNull()
  expect(normalizeSubjectSlug(null)).toBeNull()
  expect(normalizeSubjectSlug(42)).toBeNull()
  expect(normalizeSubjectSlug({})).toBeNull()
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/pure-subject-slug.test.ts`
Expected: FAIL — `normalizeSubjectSlug` 未导出。

- [ ] **Step 3: 实现**

`src/memory/pure.ts` 末尾追加：

```ts
// ---------------------------------------------------------------------------
// Subject-keyed 聚合（spec §4.1）：slug 规范化。纯函数、永不抛。
// ---------------------------------------------------------------------------

export const SUBJECT_SLUG_MAX_LEN = 48

const SUBJECT_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * 规范化 subject slug：trim + 转小写后校验 kebab-case（最长 48）；非法一律
 * 返回 null（= 未分组），永不抛。slug 是增强信号，任何非法输入都静默降级，
 * 不阻塞蒸馏 / 审批闭环（spec D6）。
 */
export function normalizeSubjectSlug(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim().toLowerCase()
  if (s.length === 0 || s.length > SUBJECT_SLUG_MAX_LEN) return null
  return SUBJECT_SLUG_RE.test(s) ? s : null
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `bun test tests/pure-subject-slug.test.ts && bun run typecheck`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/memory/pure.ts tests/pure-subject-slug.test.ts
git commit -m "feat(pure): normalizeSubjectSlug (kebab-case validation, fail-to-null)"
```

---

### Task 3: store 层 slug 读写 + `listSubjectSlugs` + patch 校验

**Files:**
- Modify: `src/memory/pure.ts:4-14`（`InjectableMemoryRow` 加可选字段）
- Modify: `src/memory/store.ts`（MemoryInput / Memory / createCandidate / rowToMemory / listApprovedByScope / patchMemory + 新增 listSubjectSlugs）
- Test: `tests/store-subject-slug.test.ts`（新建）

**Interfaces:**
- Consumes: `normalizeSubjectSlug`（Task 2）。
- Produces:
  - `MemoryInput.subjectSlug?: string | null`、`Memory.subjectSlug: string | null`
  - `InjectableMemoryRow.subjectSlug?: string | null`（Task 6 渲染消费）
  - `listSubjectSlugs(db, { scopeType: MemoryScope; scopeId: string | null }): Promise<string[]>`（Task 7 scheduler 消费）
  - `PatchInput.subjectSlug?: string | null`（Task 8 UI 经 server 透传消费）

- [ ] **Step 1: 写失败测试**

新建 `tests/store-subject-slug.test.ts`（DB 模式仿 `tests/schema.test.ts` 的 fresh-subdir 写法）：

```ts
import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb, type DbClient } from '@/db/client'
import {
  createCandidate, listApprovedByScope, listSubjectSlugs, patchMemory,
  MemoryConflictError, promoteCandidate,
} from '@/memory/store'

// subject-keyed 聚合 store 层（spec §4.4）：slug 写入/投影/清单查询/patch 校验。

const root = join(import.meta.dir, '.tmp-store-slug')
let dir = ''
let db: DbClient | null = null

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
  if (db) { db.$client.close(); db = null }
})

const base = {
  scopeType: 'project' as const, scopeId: '/repo', title: 't', bodyMd: 'b',
  tags: [] as string[], sourceKind: 'manual' as const, runtime: null,
}

test('createCandidate writes subjectSlug; listApprovedByScope projects it', async () => {
  const m = await createCandidate(db!, { ...base, subjectSlug: 'refund-policy' })
  expect(m.subjectSlug).toBe('refund-policy')
  await promoteCandidate(db!, m.id, { action: 'approve' })
  const set = await listApprovedByScope(db!, { projectId: '/repo', runtime: 'claude-code' })
  expect(set.byScope.project[0]!.subjectSlug).toBe('refund-policy')
})

test('createCandidate defaults subjectSlug to null', async () => {
  const m = await createCandidate(db!, base)
  expect(m.subjectSlug).toBeNull()
})

test('listSubjectSlugs: distinct, candidate+approved only, alphabetical', async () => {
  await createCandidate(db!, { ...base, subjectSlug: 'zeta' })
  await createCandidate(db!, { ...base, subjectSlug: 'alpha' })
  const dup = await createCandidate(db!, { ...base, subjectSlug: 'alpha' })
  const rejected = await createCandidate(db!, { ...base, subjectSlug: 'nope' })
  await promoteCandidate(db!, rejected.id, { action: 'reject' })
  await promoteCandidate(db!, dup.id, { action: 'approve' })
  const slugs = await listSubjectSlugs(db!, { scopeType: 'project', scopeId: '/repo' })
  expect(slugs).toEqual(['alpha', 'zeta'])
})

test('listSubjectSlugs: scope isolation (project vs global vs other project)', async () => {
  await createCandidate(db!, { ...base, subjectSlug: 'proj-a' })
  await createCandidate(db!, { ...base, scopeId: '/other', subjectSlug: 'proj-b' })
  await createCandidate(db!, { ...base, scopeType: 'global', scopeId: null, subjectSlug: 'glob' })
  expect(await listSubjectSlugs(db!, { scopeType: 'project', scopeId: '/repo' })).toEqual(['proj-a'])
  expect(await listSubjectSlugs(db!, { scopeType: 'global', scopeId: null })).toEqual(['glob'])
})

test('patchMemory sets / clears subjectSlug, counts as change', async () => {
  const m = await createCandidate(db!, base)
  const r1 = await patchMemory(db!, m.id, { subjectSlug: 'Hook-Install' })
  expect(r1.memory.subjectSlug).toBe('hook-install') // normalize 小写
  expect(r1.changedFields).toContain('subjectSlug')
  const r2 = await patchMemory(db!, m.id, { subjectSlug: null })
  expect(r2.memory.subjectSlug).toBeNull()
  expect(r2.changedFields).toContain('subjectSlug')
  // 无变化 -> 空 changedFields（冪等 no-op）
  const r3 = await patchMemory(db!, m.id, { subjectSlug: null })
  expect(r3.changedFields).toEqual([])
})

test('patchMemory rejects invalid subjectSlug with MemoryConflictError', async () => {
  const m = await createCandidate(db!, base)
  await expect(patchMemory(db!, m.id, { subjectSlug: 'refund policy' })).rejects.toThrow(MemoryConflictError)
  // 非法 patch 不落库
  const again = await listSubjectSlugs(db!, { scopeType: 'project', scopeId: '/repo' })
  expect(again).toEqual([])
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/store-subject-slug.test.ts`
Expected: FAIL — `listSubjectSlugs` 未导出 / `subjectSlug` 字段不存在。

- [ ] **Step 3: 实现**

`src/memory/pure.ts` 的 `InjectableMemoryRow` 加一行：

```ts
export interface InjectableMemoryRow {
  id: string
  scopeType: MemoryScope
  scopeId: string | null
  runtime: RuntimeTag
  title: string
  bodyMd: string
  createdAt: number
  version: number
  tags: string[]
  /** 主题归组键（spec §4.5）；null/缺省 = 未分组，平铺渲染。 */
  subjectSlug?: string | null
}
```

`src/memory/store.ts`：

1. import 行加 `asc, isNotNull`，并从 pure 引入 `normalizeSubjectSlug`：

```ts
import { and, asc, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
```

在现有 `} from './pure'` 的 import 列表中加 `normalizeSubjectSlug`。

2. `MemoryInput` 加字段（`valueClass` 行后）：

```ts
  valueClass?: ValueClass | null
  /** 主题归组键（spec §4.4）；缺省/null = 未分组。 */
  subjectSlug?: string | null
```

3. `Memory` 接口加（`valueClass` 行后）：

```ts
  valueClass: ValueClass | null
  subjectSlug: string | null
```

4. `rowToMemory` 的 return 对象加（`valueClass` 行后）：

```ts
    valueClass: (r.valueClass ?? null) as ValueClass | null,
    subjectSlug: r.subjectSlug ?? null,
```

5. `createCandidate`：`db.insert` values 加 `subjectSlug: input.subjectSlug ?? null,`；`rowToMemory({...})` 字面量同样加 `subjectSlug: input.subjectSlug ?? null,`。

6. `listApprovedByScope` 的 `toRow` 加：

```ts
  const toRow = (r: any) => ({
    id: r.id, scopeType: r.scopeType as MemoryScope, scopeId: r.scopeId, runtime: (r.runtime ?? null) as RuntimeTag,
    title: r.title, bodyMd: r.bodyMd, createdAt: r.createdAt, version: r.version, tags: parseTags(r.tags),
    subjectSlug: r.subjectSlug ?? null,
  })
```

7. 新增 `listSubjectSlugs`（放在 `DEDUP_EXISTING_LIMIT` 常量附近）：

```ts
export const SUBJECT_SLUG_LIST_LIMIT = 50

/**
 * 列出某 scope 下候选+已审批记忆已用的 subject slug（去重、字母序、LIMIT 50）。
 * scheduler 蒸馏前注入 distiller prompt，促进模型复用既有主题、对抗同义碎裂
 * （spec D3）。project = 精确 scopeId；global = scopeId IS NULL
 * （与 listForDedupByScope 同规则）。
 */
export async function listSubjectSlugs(
  db: DbClient,
  opts: { scopeType: MemoryScope; scopeId: string | null },
): Promise<string[]> {
  const scopeClause = opts.scopeId === null ? isNull(memories.scopeId) : eq(memories.scopeId, opts.scopeId)
  const rows = await db.selectDistinct({ slug: memories.subjectSlug }).from(memories).where(
    and(
      eq(memories.scopeType, opts.scopeType),
      scopeClause,
      inArray(memories.status, ['candidate', 'approved']),
      isNotNull(memories.subjectSlug),
    ),
  ).orderBy(asc(memories.subjectSlug)).limit(SUBJECT_SLUG_LIST_LIMIT).all()
  return rows.map((r) => r.slug).filter((s): s is string => typeof s === 'string')
}
```

8. `PatchInput` 加：

```ts
  /** 传 string 校验格式（非法抛 MemoryConflictError）；传 null 移出分组；不传不改。 */
  subjectSlug?: string | null
```

9. `patchMemory` 的 tags 处理之后、no-op 判断之前加：

```ts
    if (input.subjectSlug !== undefined) {
      if (input.subjectSlug !== null && normalizeSubjectSlug(input.subjectSlug) === null) {
        throw new MemoryConflictError(`invalid subjectSlug: ${JSON.stringify(input.subjectSlug)}`)
      }
      const nextSlug = input.subjectSlug === null ? null : normalizeSubjectSlug(input.subjectSlug)
      if (nextSlug !== (row.subjectSlug ?? null)) {
        changed.push('subjectSlug')
        set.subjectSlug = nextSlug
      }
    }
```

- [ ] **Step 4: 跑测试确认绿**

Run: `bun test tests/store-subject-slug.test.ts tests/store-crud.test.ts tests/store-promote.test.ts tests/store-scope-edit.test.ts && bun run typecheck`
Expected: PASS（含既有 store 测试无回归）。

- [ ] **Step 5: Commit**

```bash
git add src/memory/pure.ts src/memory/store.ts tests/store-subject-slug.test.ts
git commit -m "feat(store): subject_slug read/write + listSubjectSlugs + patch validation"
```

---

### Task 4: 瞬态字段 `subject` 机械改名 `ruleObject`

**Files:**
- Modify: `src/memory/distiller.ts`（字段、prompt 段、shouldRetry、解析）
- Modify: `src/memory/valueFilter.ts:30,103,145,175`（prompt 文案 + 3 处引用）
- Modify: `tests/distiller.test.ts`、`tests/valueFilter.test.ts`、`tests/dedup.test.ts`、`tests/scheduler.test.ts`（fixture + 断言同步）

**Interfaces:**
- Produces: `DistillCandidate.ruleObject: 'codebase' | 'domain'`（Task 5 在此类型上加 `subjectSlug`）。改名后 `DistillCandidate` 上**不再有** `subject` 字段。

**改名规则（逐字一致地全局替换，不改任何逻辑）：**

| 位置 | 改前 | 改后 |
|---|---|---|
| `distiller.ts` 字段 | `subject: 'codebase' \| 'domain'` | `ruleObject: 'codebase' \| 'domain'` |
| `distiller.ts` prompt | `对每条候选标记 subject：` | `对每条候选标记 ruleObject：` |
| `distiller.ts` JSON 模板 | `"subject": "codebase"` | `"ruleObject": "codebase"` |
| `distiller.ts` shouldRetry | `(c as { subject?: unknown }).subject` / ``候选 ${i} 的 subject 非法`` | `(c as { ruleObject?: unknown }).ruleObject` / ``候选 ${i} 的 ruleObject 非法`` |
| `distiller.ts` 解析 | `const rawSubject = o.subject` | `const rawSubject = o.ruleObject`；变量 `subject` → `ruleObject` |
| `valueFilter.ts:30` prompt | `subject hint` / `codebase-subject candidate` | `ruleObject hint` / `codebase-ruleObject candidate` |
| `valueFilter.ts:103` | `(subject: ${c.subject ?? 'codebase'})` | `(ruleObject: ${c.ruleObject ?? 'codebase'})` |
| `valueFilter.ts:145,175` | `c.subject === 'domain'` | `c.ruleObject === 'domain'` |
| 全部测试 fixture | `subject: 'domain'` / `subject: 'codebase'` | `ruleObject: 'domain'` / `ruleObject: 'codebase'` |
| `distiller.test.ts` | `'"subject"'` 断言、`.subject` 读取、注释中的 subject | `'"ruleObject"'`、`.ruleObject`、注释同步 |
| `valueFilter.test.ts:253,254,262` | `'(subject: codebase)'` / `'(subject: domain)'` | `'(ruleObject: codebase)'` / `'(ruleObject: domain)'` |
| `valueFilter.test.ts:268,269` | `'subject hint'` / `'codebase-subject candidate'` | `'ruleObject hint'` / `'codebase-ruleObject candidate'` |

注意：`distiller.ts` 中 `"对每条候选标记 subject："` 下方正文里的"subject"字样也同步改为 ruleObject（如 `拿不准时标 codebase` 不变，但"标 subject"/"subject=domain"等出现处统一改）。`scheduler.test.ts` 注释里的 `subject=domain`/`subject gate` 等描述性文字同步改。

- [ ] **Step 1: 改名（红 → 绿一体：先全局改，再跑测试）**

按上表逐文件替换。完成后用 grep 验证无残留（允许残留的例外：`valueFilter.ts` prompt 中 "Apply the 6 categories above as written" 等不含 subject 的文句；测试描述字符串里的普通英文单词）：

Run: `grep -rn "\.subject\b" src/ tests/` 与 `grep -rn "subject:" src/memory/ | grep -v ruleObject | grep -v subjectSlug`
Expected: 无输出（或仅注释中的自然语言描述）。

- [ ] **Step 2: 跑全量测试确认绿**

Run: `bun run typecheck && bun test`
Expected: 全绿（304/304 量级，纯改名无行为变化）。

- [ ] **Step 3: Commit**

```bash
git add src/memory/distiller.ts src/memory/valueFilter.ts tests/
git commit -m "refactor(distiller): rename transient subject field to ruleObject (free 'subject' for slug concept)"
```

---

### Task 5: distiller 输出 `subjectSlug` + existingSlugs 清单进 prompt

**Files:**
- Modify: `src/memory/distiller.ts`（类型、prompt、renderUserPrompt、shouldRetry、解析）
- Modify: `tests/distiller.test.ts`（新增用例）；`tests/dedup.test.ts`、`tests/valueFilter.test.ts`、`tests/scheduler.test.ts` 的 `DistillCandidate` fixture 补 `subjectSlug: null`
- Test: `tests/distiller.test.ts`

**Interfaces:**
- Consumes: `normalizeSubjectSlug`（Task 2）、`ruleObject` 改名后的类型（Task 4）。
- Produces: `DistillCandidate.subjectSlug: string | null`（必填）；`DistillInput.existingSlugs: string[]`（必填）。Task 7 scheduler 按此签名调用。

- [ ] **Step 1: 写失败测试**

`tests/distiller.test.ts` 追加：

```ts
// subject-keyed 聚合（spec §4.3）：subjectSlug 解析 + existingSlugs 清单进 prompt。

test('distillTranscript includes existingSlugs in user prompt', async () => {
  let captured = ''
  await distillTranscript({
    turns: [{ role: 'user', content: 'x' }],
    runtime: 'claude-code', cwd: '/repo',
    existingSlugs: ['refund-policy', 'hook-install'],
    callLLM: async (_sys, user) => { captured = user; return JSON.stringify({ candidates: [] }) },
  })
  expect(captured).toContain('refund-policy')
  expect(captured).toContain('hook-install')
})

test('distillTranscript parses legal subjectSlug', async () => {
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'x' }],
    runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async () => JSON.stringify({ candidates: [{ title: '[category:invariant] x', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new', ruleObject: 'domain', subjectSlug: 'refund-policy' }] }),
  })
  expect(result.candidates[0]!.subjectSlug).toBe('refund-policy')
})

test('distillTranscript degrades illegal subjectSlug to null WITHOUT retry', async () => {
  let calls = 0
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'x' }],
    runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async () => { calls++; return JSON.stringify({ candidates: [{ title: '[category:invariant] x', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new', subjectSlug: 'refund policy' }] }) },
  })
  expect(calls).toBe(1) // 不重试（spec D6）
  expect(result.candidates[0]!.subjectSlug).toBeNull()
})

test('distillTranscript defaults missing subjectSlug to null', async () => {
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'x' }],
    runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async () => JSON.stringify({ candidates: [{ title: '[category:invariant] x', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] }),
  })
  expect(result.candidates[0]!.subjectSlug).toBeNull()
})

test('DISTILLER_SYSTEM_PROMPT documents subjectSlug rules + reuse instruction', () => {
  expect(DISTILLER_SYSTEM_PROMPT).toContain('subjectSlug')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('kebab-case')
})
```

注意：`distillTranscript` 现有调用点（本文件其它用例）都要补 `existingSlugs: []`（`DistillInput` 新增必填字段）。`tests/dedup.test.ts`、`tests/valueFilter.test.ts`、`tests/scheduler.test.ts` 中所有 `DistillCandidate` 字面量补 `subjectSlug: null`。

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/distiller.test.ts && bun run typecheck`
Expected: FAIL — `existingSlugs` / `subjectSlug` 不存在。

- [ ] **Step 3: 实现**

`src/memory/distiller.ts`：

1. import 加 `normalizeSubjectSlug`（从 `./pure` 的既有 import 扩展）。

2. `DISTILLER_SYSTEM_PROMPT`：在 ruleObject 段落之后（"Cross-cutting properties" 之前）插入：

```
对每条候选标记 subjectSlug：这条记忆的主题标识（kebab-case，2~4 个英文小写
单词，如 refund-policy、hook-install）。同一主题的记忆必须共用同一个 slug--
优先从 user prompt 的 "Existing subject slugs" 清单里复用；只有确实是清单
没有的新主题才造新 slug。拿不准主题可以不输出该字段。
```

JSON 模板候选对象中加一行：

```
      "subjectSlug": "refund-policy"
```

3. `DistillCandidate` 接口加：

```ts
  /** 主题归组键（spec §4.3）。LLM 漏标/非法时 normalizeSubjectSlug 降级为 null。 */
  subjectSlug: string | null
```

4. `DistillInput` 加：

```ts
  /** 该 scope 现有 slug 清单（scheduler 查询注入），prompt 附给模型促复用（spec D3）。 */
  existingSlugs: string[]
```

5. `renderUserPrompt` 加参数并在返回值中附清单：

```ts
function renderUserPrompt(
  turns: TranscriptTurn[],
  runtime: string,
  cwd: string,
  signals: ReturnType<typeof detectErrorSignals>,
  existingSlugs: string[],
): string {
  const transcript = turns.map((t) => `[${t.role}] ${t.content}`).join('\n')
  const slugs = existingSlugs.length > 0 ? existingSlugs.join(', ') : '(none)'
  return `Runtime: ${runtime}\nCwd: ${cwd}\nError signals detected: ${JSON.stringify(signals)}\nExisting subject slugs (reuse these when a candidate matches an existing subject): ${slugs}\n\nTranscript:\n${transcript}\n\nExtract candidate memories as JSON per the system instructions.`
}
```

`distillTranscript` 内调用改为 `renderUserPrompt(filtered, input.runtime, input.cwd, signals, input.existingSlugs)`。

6. `distillShouldRetry` 的候选校验加（subjectSlug 存在且非 string → retry；**格式合法性不在此判断**，留给解析层降级）：

```ts
    const slug = (c as { subjectSlug?: unknown }).subjectSlug
    if (slug !== undefined && typeof slug !== 'string') {
      return `候选 ${i} 的 subjectSlug 必须是字符串`
    }
```

7. 解析循环中 `out.push({...})` 加：

```ts
      subjectSlug: normalizeSubjectSlug(o.subjectSlug),
```

- [ ] **Step 4: 跑测试确认绿**

Run: `bun run typecheck && bun test`
Expected: 全绿（含 dedup/valueFilter/scheduler fixture 补齐后）。

- [ ] **Step 5: Commit**

```bash
git add src/memory/distiller.ts tests/
git commit -m "feat(distiller): subjectSlug output + existing-slugs reuse list in prompt"
```

---

### Task 6: `formatMemoryBlock` 分组渲染

**Files:**
- Modify: `src/memory/pure.ts`（`formatMemoryBlock` + 新增内部 `renderRows`）
- Test: `tests/pure-inject.test.ts`

**Interfaces:**
- Consumes: `InjectableMemoryRow.subjectSlug`（Task 3）。
- Produces: 不变（`formatMemoryBlock(set, budget): string | null` 签名不变；全 NULL slug 输出逐字节兼容）。

- [ ] **Step 1: 写失败测试**

`tests/pure-inject.test.ts` 追加：

```ts
// subject-keyed 聚合（spec §4.5/D5）：裁剪后分组渲染；NULL slug 逐字节兼容。

function row(partial: Partial<InjectableMemoryRow> & { id: string }): InjectableMemoryRow {
  return {
    scopeType: 'project', scopeId: '/r', runtime: null,
    title: 't', bodyMd: 'b', createdAt: 1, version: 1, tags: [], ...partial,
  }
}

test('grouped rows render under a [slug] section header', () => {
  const block = formatMemoryBlock({
    byScope: {
      project: [
        row({ id: 'a', title: '退款须14天内', subjectSlug: 'refund-policy', createdAt: 3 }),
        row({ id: 'b', title: 'hook 装进 settings', subjectSlug: 'hook-install', createdAt: 2 }),
        row({ id: 'c', title: '退款期限不可丢弃', subjectSlug: 'refund-policy', createdAt: 1 }),
      ],
      global: [],
    },
  })
  const lines = block!.split('\n')
  const rIdx = lines.indexOf('[refund-policy]')
  const hIdx = lines.indexOf('[hook-install]')
  expect(rIdx).toBeGreaterThan(-1)
  expect(hIdx).toBeGreaterThan(-1)
  // 节位置由组内最先出现的成员决定（a 在 b 前 -> refund 节在 hook 节前）
  expect(rIdx).toBeLessThan(hIdx)
  // 组内成员保持裁剪后序列相对顺序，且省略 [scope] 前缀
  expect(lines[rIdx + 1]).toBe('- 退款须14天内 - b')
  expect(lines[rIdx + 2]).toBe('- 退款期限不可丢弃 - b')
  expect(lines[hIdx + 1]).toBe('- hook 装进 settings - b')
})

test('ungrouped rows keep the flat - [scope] format and stay in sequence position', () => {
  const block = formatMemoryBlock({
    byScope: {
      project: [
        row({ id: 'a', title: '未分组甲', subjectSlug: null, createdAt: 2 }),
        row({ id: 'b', title: '分组乙', subjectSlug: 'topic-x', createdAt: 1 }),
      ],
      global: [],
    },
  })
  expect(block).toContain('- [project] 未分组甲 - b')
  expect(block).toContain('[topic-x]')
  // 未分组行先于 topic-x 节（a 位置在前）
  expect(block!.indexOf('- [project] 未分组甲')).toBeLessThan(block!.indexOf('[topic-x]'))
})

test('all-NULL slugs render byte-identical to the legacy flat format', () => {
  const rows = [
    row({ id: 'a', title: '甲', createdAt: 2 }),
    row({ id: 'b', title: '乙', createdAt: 1 }),
  ]
  const block = formatMemoryBlock({ byScope: { project: rows, global: [] } })
  expect(block).toContain('- [project] 甲 - b\n- [project] 乙 - b')
  expect(block).not.toContain('[]')
})

test('budget-clipped group leaves no orphan section header', () => {
  // 预算只够第一行：分组行被裁掉 -> 不出现 [slug] 空节标题（D5：先裁后分组）
  const block = formatMemoryBlock(
    {
      byScope: {
        project: [
          row({ id: 'a', title: '未分组', subjectSlug: null, createdAt: 2 }),
          row({ id: 'b', title: '分组', subjectSlug: 'gone', createdAt: 1 }),
        ],
        global: [],
      },
    },
    { project: 6, global: 0 }, // 第一行约 5 token；两行约 10 token 超预算 -> 第二行被裁
  )
  expect(block).toContain('- [project] 未分组 - b')
  expect(block).not.toContain('[gone]')
})
```

文件顶部 import 补 `InjectableMemoryRow` 类型与 `formatMemoryBlock`（如既有 import 未含）。

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/pure-inject.test.ts`
Expected: FAIL — 分组渲染未实现。

- [ ] **Step 3: 实现**

`src/memory/pure.ts`，把 `formatMemoryBlock` 的渲染循环替换为分组渲染（裁剪逻辑不动）：

```ts
/**
 * 渲染裁剪后的行：带相同 subjectSlug 的行归拢为一节（节标题 `[slug]`，成员行
 * 省略 scope 前缀），NULL slug 行保持 `- [scope] title - bodyMd` 平铺。
 * 节位置由组内最先出现的成员在序列中的位置决定；组内保持序列相对顺序。
 * 全部 NULL slug 时输出与旧平铺格式逐字节一致（spec D5）。
 */
function renderRows(all: readonly InjectableMemoryRow[]): string[] {
  const bySlug = new Map<string, InjectableMemoryRow[]>()
  const slugOf = (m: InjectableMemoryRow): string | null =>
    typeof m.subjectSlug === 'string' && m.subjectSlug.length > 0 ? m.subjectSlug : null
  for (const m of all) {
    const slug = slugOf(m)
    if (slug === null) continue
    if (!bySlug.has(slug)) bySlug.set(slug, [])
    bySlug.get(slug)!.push(m)
  }
  const lines: string[] = []
  const emitted = new Set<string>()
  for (const m of all) {
    const slug = slugOf(m)
    if (slug === null) {
      lines.push(`- [${m.scopeType}] ${m.title} - ${m.bodyMd}`)
      continue
    }
    if (emitted.has(slug)) continue
    emitted.add(slug)
    lines.push(`[${slug}]`)
    for (const g of bySlug.get(slug)!) lines.push(`- ${g.title} - ${g.bodyMd}`)
  }
  return lines
}
```

`formatMemoryBlock` 中把 `for (const m of all) lines.push(...)` 一行替换为：

```ts
  for (const line of renderRows(all)) lines.push(line)
```

- [ ] **Step 4: 跑测试确认绿**

Run: `bun test tests/pure-inject.test.ts && bun run typecheck`
Expected: PASS（既有注入用例不回归——它们全是 NULL slug）。

- [ ] **Step 5: Commit**

```bash
git add src/memory/pure.ts tests/pure-inject.test.ts
git commit -m "feat(inject): subject-slug grouped rendering in formatMemoryBlock (clip-then-group)"
```

---

### Task 7: scheduler 接线（slug 清单进 distill + slug 入库）

**Files:**
- Modify: `src/scheduler.ts:133-138`（distillTranscript 调用）+ `src/scheduler.ts:160-175`（createCandidate 调用）
- Test: `tests/scheduler.test.ts`

**Interfaces:**
- Consumes: `listSubjectSlugs`（Task 3）、`DistillInput.existingSlugs` / `DistillCandidate.subjectSlug`（Task 5）。
- Produces: 无新接口。

- [ ] **Step 1: 写失败测试**

`tests/scheduler.test.ts` 追加（fixture/辅助函数沿用该文件既有模式）：

```ts
test('tick: existing slugs (project + global union) reach the distiller prompt; subjectSlug persisted', async () => {
  // spec §4.6：tick 查 listSubjectSlugs 并集喂 distiller；候选的 subjectSlug 随 createCandidate 入库。
  const db = openDb(join(dir, 'slug.db'))
  // 预置：project 域一个 slug、global 域一个 slug
  const proj = await createCandidate(db, {
    scopeType: 'project', scopeId: '/repo', title: 't', bodyMd: 'b', tags: [],
    sourceKind: 'manual', runtime: null, subjectSlug: 'refund-policy',
  })
  await createCandidate(db, {
    scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b', tags: [],
    sourceKind: 'manual', runtime: null, subjectSlug: 'global-topic',
  })
  await promoteCandidate(db, proj.id, { action: 'approve' })
  const { enqueueDistillJob, tick } = await import('@/scheduler')
  await enqueueDistillJob(db, { sourceEventId: 'se1', runtime: 'claude-code', cwd: '/repo', debounceKey: 'dk', debounceMs: 0 })
  let distillUserPrompt = ''
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user' as const, content: 'refund rule' }], fullLength: 1 }),
    callLLM: async (_sys, user) => {
      callCount++
      if (callCount === 1) {
        distillUserPrompt = user
        return JSON.stringify({ candidates: [{ title: '[category:invariant] 退款14天', bodyMd: '14d', scope: 'project', runtime: null, distillAction: 'new', ruleObject: 'domain', subjectSlug: 'refund-policy' }] })
      }
      // dedup / judgeValue：保守全留
      return JSON.stringify({ verdicts: [] })
    },
    createCandidate,
  })
  expect(distillUserPrompt).toContain('refund-policy')
  expect(distillUserPrompt).toContain('global-topic')
  const rows = await db.select().from(memories).where(eq(memories.title, '[category:invariant] 退款14天'))
  expect(rows[0]!.subjectSlug).toBe('refund-policy')
  db.$client.close()
})
```

注意：`memories`、`eq` 若该文件未 import 需补；`createCandidate`/`promoteCandidate`/`openDb`/`join/dir` 沿用文件既有 import（没有就补）。

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/scheduler.test.ts`
Expected: FAIL — tick 未传 existingSlugs / 未存 subjectSlug。

- [ ] **Step 3: 实现**

`src/scheduler.ts`：

1. import 加 `listSubjectSlugs`（从 `@/memory/store` 既有 import 扩展）。

2. `tick` 中 `distillTranscript` 调用之前插入：

```ts
      // subject-keyed 聚合（spec §4.6）：取 project(job.cwd) ∪ global 的现有
      // slug 清单喂 distiller 促复用。查询失败 -> 空清单，distill 照常（spec §6）。
      let existingSlugs: string[] = []
      try {
        const [projSlugs, globalSlugs] = await Promise.all([
          listSubjectSlugs(db, { scopeType: 'project', scopeId: job.cwd ?? 'unknown' }),
          listSubjectSlugs(db, { scopeType: 'global', scopeId: null }),
        ])
        existingSlugs = [...new Set([...projSlugs, ...globalSlugs])].sort()
      } catch (e) {
        console.warn('memside: listSubjectSlugs failed', e)
      }
```

3. `distillTranscript` 调用加字段：

```ts
      const { candidates, filteredTurns } = await distillTranscript({
        turns: newTurns,  // 只喂新增 turn，不再全量
        runtime: job.runtime as 'claude-code' | 'opencode',
        cwd: job.cwd ?? '',
        existingSlugs,
        callLLM: deps.callLLM,
      })
```

4. `createCandidate` 调用加：

```ts
          valueClass: k.valueClass,
          subjectSlug: k.cand.subjectSlug,
```

- [ ] **Step 4: 跑测试确认绿**

Run: `bun run typecheck && bun test`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/scheduler.ts tests/scheduler.test.ts
git commit -m "feat(scheduler): feed existing subject slugs to distiller; persist subjectSlug"
```

---

### Task 8: Web UI（slug 徽标 + 审批编辑）

**Files:**
- Modify: `src/web/api.ts:15-28`（`MemoryItem`）、`src/web/api.ts:52-65`（`patchMemory` body 类型）
- Modify: `src/web/App.tsx:63-65`（`edit`）、`src/web/App.tsx:159-167`（MemoryCard 调用）、`src/web/App.tsx:181-259`（MemoryCard）
- Test: `tests/web-ui.test.ts`

server 侧**无需改动**：`PATCH /api/memories/:id`（`src/server.ts:231-240`）把整个 JSON body 透传给 `patchMemory`，`subjectSlug` 自动生效（非法时 `MemoryConflictError` → 409，spec §6）。

**Interfaces:**
- Consumes: `PatchInput.subjectSlug`（Task 3，经 server 透传）。

- [ ] **Step 1: 写失败测试（源代码层文本断言，CLAUDE.md 兜底模式）**

`tests/web-ui.test.ts` 追加：

```ts
// subject-keyed 聚合（spec §4.7）：卡片 slug 徽标 + 编辑表单 slug 输入框。
// React 组件不单测，源码文本断言锁住 UI 锚点，refactor 删除即变红。
test('App.tsx shows subject slug badge + edit input (source text)', () => {
  expect(src).toContain('subjectSlug')
  expect(src).toContain('subject slug')
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/web-ui.test.ts`
Expected: FAIL — App.tsx 无 `subjectSlug`。

- [ ] **Step 3: 实现**

`src/web/api.ts`：

1. `MemoryItem` 加：

```ts
  valueClass?: string | null
  subjectSlug?: string | null
```

2. `patchMemory` body 类型加：

```ts
  body: { title?: string; bodyMd?: string; tags?: string[]; scopeType?: 'project' | 'global'; scopeId?: string | null; subjectSlug?: string | null },
```

`src/web/App.tsx`：

3. `edit` 函数改为带 slug：

```ts
  async function edit(id: string, title: string, bodyMd: string, scopeType: 'project' | 'global', subjectSlug: string | null) {
    await patchMemory(id, { title, bodyMd, scopeType, subjectSlug })
```

4. MemoryCard 调用处：`onEdit={(t, b, s, slug) => edit(m.id, t, b, s, slug)}`；`onEdit` 类型改为：

```ts
  onEdit: (title: string, bodyMd: string, scopeType: 'project' | 'global', subjectSlug: string | null) => Promise<void>
```

5. MemoryCard 加 state（`scope` state 行后）：

```ts
  const [slug, setSlug] = useState(m.subjectSlug ?? '')
```

6. 编辑表单中（textarea 之后、保存按钮之前）加输入框：

```tsx
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="subject slug（kebab-case，可留空）"
            style={{ width: '100%', marginBottom: 8 }}
          />
```

7. `save` 改为透传 slug（空串 → null = 未分组）：

```ts
      await onEdit(title, body, scope, slug.trim() === '' ? null : slug.trim())
```

8. 非编辑态标题行加徽标（valueBadge 那个 span 之后）：

```tsx
          {m.subjectSlug ? (
            <span style={{ marginLeft: 8, fontSize: 12, color: '#36c' }}>[{m.subjectSlug}]</span>
          ) : null}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `bun run typecheck && bun test`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/web/api.ts src/web/App.tsx tests/web-ui.test.ts
git commit -m "feat(web): subject slug badge + editable input on approval card"
```

---

## 验收清单（全部任务完成后）

- [ ] `bun run typecheck && bun test` 全绿
- [ ] `grep -rn "\.subject\b" src/ tests/` 无残留（ruleObject 改名彻底）
- [ ] 老库（无 subject_slug 列）openDb 后自动补列，老行 NULL（schema 测试锁定）
- [ ] 全 NULL slug 注入输出与旧格式逐字节一致（pure-inject 测试锁定）
- [ ] e2e 冒烟（可选但推荐）：`NO_PROXY=127.0.0.1,localhost bun run smoke-live.ts`，审批一条带 slug 的候选后开新会话确认分节渲染

## 依赖关系

```
Task 1 (schema) ──┬──> Task 3 (store) ──┬──> Task 7 (scheduler)
Task 2 (normalize) ┘                     └──> Task 8 (web UI)
Task 4 (ruleObject 改名) ──> Task 5 (distiller slug) ──> Task 7
Task 3 ──> Task 6 (渲染分组)
```

严格按 1→2→3→4→5→6→7→8 顺序执行即可满足全部依赖。
