# 候选记忆价值过滤（value filter）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 distill 后、dedup 前加一个中性 LLM 价值判定层 `judgeValue`，把候选分类到 6 类别，规则 1-2 丢弃进审计表、规则 3-6 带 `value_class` 入库，UI 按派生优先级排序 + 批量拒绝未评估；顺带中性化 dedup prompt。

**Architecture:** 新增纯函数模块 `src/memory/valueFilter.ts`（注入 `callAnthropic`，镜像 `dedup.ts`）。`memories` 加 `value_class` 单列（派生优先级），新 `memory_discards` 审计表。`scheduler.tick` 在 `distillTranscript` 与 `dedupCandidates` 之间插 `judgeValue` + `logDiscards`。丢弃是代码对 `public-knowledge|derivable` 类别的确定映射；prompt 只分类、不提 keep/discard。fallback：无合法分类 => 保留 `value_class=NULL`。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite (WAL) + zod + @anthropic-ai/sdk；前端 Vite + React 19。测试 bun:test。

## Global Constraints

- 运行门槛：`bun run typecheck && bun test` 必须全绿才能 push（CLAUDE.md）。
- prompt 中性：value filter 与 dedup 的 system prompt 不得出现 `discard`/`keep`/`dangerous`/`unsure`/`cautious`/`careful` 等引导词。
- 保守 fallback：judgeValue 任何失败（LLM 抛错/非 JSON/缺 index/幻觉类别）=> `{keep:true, valueClass:null}`，不冒泡到 tick catch，不让 job 退回 pending。
- 零 schema 破坏：`value_class` 用 PRAGMA 守卫幂等 ALTER（同 `source_cwd` 模式）；`memory_discards` 用 `CREATE TABLE IF NOT EXISTS`。
- distiller prompt 不动。dedup 仅删末句 "When unsure, emit isDuplicate:false."。
- 只管未来新候选；历史行 `value_class` 留 NULL，不回填。
- commit message 末尾带 `Co-Authored-By: Claude <noreply@anthropic.com>`。
- 测试用 EBUSY-safe 模式：`beforeAll` 擦 `root`、每 test 独立子目录、`afterEach` 关 `db.$client`（同现有 store/scheduler/schema 测试）。

---

## File Structure

- **新增** `src/memory/valueFilter.ts` — `judgeValue` 纯函数 + `VALUE_JUDGE_SYSTEM_PROMPT` + `ValueClass`/`ValueVerdict`/`DiscardReason` 类型。职责：把 `DistillCandidate[]` 分类成 6 类别，代码映射 keep/discard。
- **新增** `tests/valueFilter.test.ts` — 纯函数 + mock `callAnthropic`，覆盖 6 类别 / fallback / 中性断言。
- **改** `src/db/schema.ts` — `memories` 加 `valueClass` 列；新增 `memoryDiscards` 表导出。
- **改** `src/db/client.ts` — DDL 加 `memory_discards` 建表；迁移加 `value_class` ALTER（PRAGMA 守卫）；drizzle schema map 加 `memoryDiscards`。
- **改** `src/memory/store.ts` — `MemoryInput`/`Memory` 加 `valueClass`；`createCandidate` 写列、`rowToMemory` 读回；新增 `logDiscards` + `DiscardRecord`。
- **改** `src/memory/dedup.ts` — 删 `DEDUP_SYSTEM_PROMPT` 末句。
- **改** `src/scheduler.ts` — `tick` 插 `judgeValue` + `logDiscards`；`valueClass` 穿透 dedup 回挂。
- **改** `src/server.ts` — `POST /api/memories/bulk-promote` 端点。
- **改** `src/web/api.ts` — `MemoryItem` 加 `valueClass`；新增 `bulkPromote`。
- **改** `src/web/App.tsx` — 派生优先级排序 + valueClass 徽标 + "批量拒绝未评估" 按钮。
- **扩测试** `tests/schema.test.ts`、`tests/store-crud.test.ts`、`tests/dedup.test.ts`、`tests/scheduler.test.ts`、`tests/server.test.ts`、`tests/web-ui.test.ts`。

---

### Task 1: Schema — value_class 列 + memory_discards 表

**Files:**
- Modify: `src/db/schema.ts`

**Interfaces:**
- Produces: `memoryDiscards` 表导出（供 client.ts / store.ts import）；`memories.valueClass` 字段（drizzle JS key `valueClass` <-> DB 列 `value_class`）。

- [ ] **Step 1: 加 value_class 列到 memories 表**

在 `src/db/schema.ts` 的 `memories` 表定义里，`version` 之后加：

```ts
    version: integer('version').notNull().default(1),
    valueClass: text('value_class'), // nullable: decision|convention|trap|topology; null = unevaluated
```

- [ ] **Step 2: 加 memory_discards 表**

在 `src/db/schema.ts` 末尾（`memoryDistillEvents` 表之后）加：

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
    reason: text('reason').notNull(), // 'public-knowledge' | 'derivable'
    ts: integer('ts').notNull(),
  },
  (t) => ({
    tsIdx: index('idx_discards_ts').on(t.ts),
  }),
)
```

- [ ] **Step 3: typecheck**

Run: `bun run typecheck`
Expected: 干净（drizzle 类型生成不需要额外步骤，`text`/`integer`/`index` 已 import）。

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts
git commit -m "feat(schema): value_class 列 + memory_discards 审计表

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Migration — value_class ALTER + memory_discards 建表

**Files:**
- Modify: `src/db/client.ts`
- Test: `tests/schema.test.ts`

**Interfaces:**
- Consumes: `memoryDiscards` from `./schema`（Task 1）。
- Produces: `openDb` 在新库建 `memory_discards`、给旧库 ALTER 加 `value_class`；drizzle schema map 含 `memoryDiscards`。

- [ ] **Step 1: 写失败测试 — fresh db 有 value_class 列 + memory_discards 表**

在 `tests/schema.test.ts` 末尾加：

```ts
test('fresh db has value_class column', () => {
  db = openDb(join(dir, 'vc.db'))
  const cols = db.$client.prepare('PRAGMA table_info(memories)').all() as { name: string }[]
  expect(cols.some((c) => c.name === 'value_class')).toBe(true)
})

test('fresh db has memory_discards table', () => {
  db = openDb(join(dir, 'md.db'))
  const tables = db.$client.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_discards'").all() as { name: string }[]
  expect(tables.length).toBe(1)
})

test('migration adds value_class to pre-existing db, idempotent, no backfill', () => {
  const dbPath = join(dir, 'oldvc.db')
  const old = new Database(dbPath)
  old.exec(`CREATE TABLE memories (id TEXT PRIMARY KEY, scope_type TEXT NOT NULL CHECK (scope_type IN ('project','global')), scope_id TEXT, runtime TEXT, title TEXT NOT NULL, body_md TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, source_kind TEXT NOT NULL, source_cwd TEXT, source_event_id TEXT, distill_job_id TEXT, distill_action TEXT, supersedes_id TEXT, superseded_by_id TEXT, approved_at INTEGER, created_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1, CHECK ((scope_type='global' AND scope_id IS NULL) OR (scope_type='project' AND scope_id IS NOT NULL)))`)
  old.exec(`INSERT INTO memories (id, scope_type, scope_id, title, body_md, tags, status, source_kind, created_at, version) VALUES ('p1','project','/r','t','b','[]','candidate','manual',1,1)`)
  old.close()
  const migrated = openDb(dbPath)
  const cols = migrated.$client.prepare('PRAGMA table_info(memories)').all() as { name: string }[]
  expect(cols.some((c) => c.name === 'value_class')).toBe(true)
  // no backfill: existing row stays NULL
  const rows = migrated.$client.prepare('SELECT id, value_class FROM memories').all() as { id: string; value_class: string | null }[]
  expect(rows.find((r) => r.id === 'p1')!.value_class).toBeNull()
  migrated.$client.close()
  // idempotent: reopen doesn't throw (guard skips ALTER)
  const reopened = openDb(dbPath)
  expect((reopened.$client.prepare('PRAGMA table_info(memories)').all() as { name: string }[]).some((c) => c.name === 'value_class')).toBe(true)
  reopened.$client.close()
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/schema.test.ts`
Expected: 3 条新测试 FAIL（`value_class` 列/`memory_discards` 表不存在）。

- [ ] **Step 3: 实现 — client.ts DDL + 迁移 + schema map**

`src/db/client.ts`：

import 行（第 5 行）改为：
```ts
import { memories, memoryDistillJobs, memoryDistillEvents, memoryDiscards } from './schema'
```

drizzle schema map（第 14 行）改为：
```ts
  const db = drizzle(raw, { schema: { memories, memoryDistillJobs, memoryDistillEvents, memoryDiscards } })
```

DDL `raw.exec(...)` 模板里，在 `memory_distill_events` 建表 + 其索引之后（第 64 行 `idx_distill_events_job_attempt` 那条之后、闭合反引号之前）加：
```sql
    CREATE TABLE IF NOT EXISTS memory_discards (
      id TEXT PRIMARY KEY,
      distill_job_id TEXT NOT NULL REFERENCES memory_distill_jobs(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body_md TEXT NOT NULL,
      reason TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_discards_ts ON memory_discards(ts);
```

迁移块：在 `source_cwd` 迁移块（第 69-76 行的 `{ ... }`）之后、`return db` 之前加：
```ts
  // Idempotent migration: add value_class to pre-existing memories tables.
  // No backfill (future-only feature; existing rows stay NULL = unevaluated).
  {
    const cols = raw.prepare('PRAGMA table_info(memories)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'value_class')) {
      raw.exec('ALTER TABLE memories ADD COLUMN value_class TEXT')
    }
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/schema.test.ts`
Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/db/client.ts tests/schema.test.ts
git commit -m "feat(db): value_class 迁移 + memory_discards 建表

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: valueFilter.ts — judgeValue 纯函数 + 中性 prompt

**Files:**
- Create: `src/memory/valueFilter.ts`
- Test: `tests/valueFilter.test.ts`

**Interfaces:**
- Consumes: `DistillCandidate` from `@/memory/distiller`。
- Produces: `judgeValue(candidates, callAnthropic) -> ValueVerdict[]`、`VALUE_JUDGE_SYSTEM_PROMPT`、`ValueClass`/`ValueVerdict`/`DiscardReason` 类型（供 store.ts / scheduler.ts import）。

- [ ] **Step 1: 写失败测试**

创建 `tests/valueFilter.test.ts`：

```ts
import { test, expect } from 'bun:test'
import { judgeValue, VALUE_JUDGE_SYSTEM_PROMPT } from '@/memory/valueFilter'
import type { DistillCandidate } from '@/memory/distiller'

const cand = (title: string, bodyMd = 'b'): DistillCandidate =>
  ({ title, bodyMd, scopeType: 'project', runtime: null, distillAction: 'new' })

const verdictsJson = (...vs: object[]) => JSON.stringify({ verdicts: vs })

test('judgeValue maps public-knowledge/derivable to keep:false', async () => {
  const v = await judgeValue([cand('a'), cand('b')], async () => verdictsJson(
    { index: 0, category: 'public-knowledge' },
    { index: 1, category: 'derivable' },
  ))
  expect(v).toEqual([
    { index: 0, keep: false, reason: 'public-knowledge' },
    { index: 1, keep: false, reason: 'derivable' },
  ])
})

test('judgeValue maps decision/convention/trap/topology to keep:true with valueClass', async () => {
  const v = await judgeValue([cand('a'), cand('b'), cand('c'), cand('d')], async () => verdictsJson(
    { index: 0, category: 'decision' },
    { index: 1, category: 'convention' },
    { index: 2, category: 'trap' },
    { index: 3, category: 'topology' },
  ))
  expect(v).toEqual([
    { index: 0, keep: true, valueClass: 'decision' },
    { index: 1, keep: true, valueClass: 'convention' },
    { index: 2, keep: true, valueClass: 'trap' },
    { index: 3, keep: true, valueClass: 'topology' },
  ])
})

test('judgeValue returns all keep+null when LLM throws', async () => {
  const v = await judgeValue([cand('a')], async () => { throw new Error('api down') })
  expect(v).toEqual([{ index: 0, keep: true, valueClass: null }])
})

test('judgeValue returns all keep+null on non-JSON', async () => {
  const v = await judgeValue([cand('a')], async () => 'not json')
  expect(v).toEqual([{ index: 0, keep: true, valueClass: null }])
})

test('judgeValue returns all keep+null on missing verdicts field', async () => {
  const v = await judgeValue([cand('a')], async () => JSON.stringify({ foo: 'bar' }))
  expect(v).toEqual([{ index: 0, keep: true, valueClass: null }])
})

test('judgeValue treats hallucinated category as keep+null', async () => {
  const v = await judgeValue([cand('a')], async () => verdictsJson({ index: 0, category: 'nonsense' }))
  expect(v).toEqual([{ index: 0, keep: true, valueClass: null }])
})

test('judgeValue treats missing category as keep+null', async () => {
  const v = await judgeValue([cand('a')], async () => verdictsJson({ index: 0 }))
  expect(v).toEqual([{ index: 0, keep: true, valueClass: null }])
})

test('judgeValue treats missing indices as keep+null', async () => {
  const v = await judgeValue([cand('a'), cand('b')], async () => verdictsJson({ index: 0, category: 'decision' }))
  expect(v).toEqual([
    { index: 0, keep: true, valueClass: 'decision' },
    { index: 1, keep: true, valueClass: null },
  ])
})

test('judgeValue returns [] and skips LLM when candidates empty', async () => {
  let called = 0
  const v = await judgeValue([], async () => { called++; return 'x' })
  expect(called).toBe(0)
  expect(v).toEqual([])
})

test('judgeValue user prompt includes title and bodyMd', async () => {
  let captured = ''
  await judgeValue([cand('[category:x] title-here', 'body-here')], async (_sys, user) => { captured = user; return verdictsJson({ index: 0, category: 'decision' }) })
  expect(captured).toContain('title-here')
  expect(captured).toContain('body-here')
})

test('VALUE_JUDGE_SYSTEM_PROMPT is neutral (no bias words)', () => {
  // 锁中性：prompt 不得出现 keep/discard/dangerous/unsure/cautious/careful 等引导词
  const lower = VALUE_JUDGE_SYSTEM_PROMPT.toLowerCase()
  for (const w of ['discard', 'keep', 'dangerous', 'unsure', 'cautious', 'careful', 'reject']) {
    expect(lower).not.toContain(w)
  }
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/valueFilter.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 valueFilter.ts**

创建 `src/memory/valueFilter.ts`：

```ts
import type { DistillCandidate } from '@/memory/distiller'

export type ValueClass = 'decision' | 'convention' | 'trap' | 'topology'
export type DiscardReason = 'public-knowledge' | 'derivable'

export type ValueVerdict =
  | { index: number; keep: false; reason: DiscardReason }
  | { index: number; keep: true; valueClass: ValueClass }
  | { index: number; keep: true; valueClass: null }

export const VALUE_JUDGE_SYSTEM_PROMPT = `You are memside-value-judge. Classify each candidate memory into exactly one
category by these criteria:

1. public-knowledge - obtainable via Google / official docs / source within ~10s
   (language syntax, stdlib, third-party API, generic algorithms, public standards).
2. derivable - re-derivable by reading existing code/files/docs; only a file path
   or entry point would need remembering.
3. decision - the WHY behind a choice: abandoned alternatives, constraints that
   drove the decision.
4. convention - an unwritten team rule / reviewer preference not documented anywhere.
5. trap - counterintuitive behavior, known gotcha, recurring pitfall.
6. topology - a cross-boundary connection (cross-module/service/team/repo) invisible
   from any single vantage point.

Pick the best-fitting category for each candidate. Respond ONLY with JSON:
{"verdicts":[{"index":<n>,"category":"public-knowledge|derivable|decision|convention|trap|topology"}]}.
Emit one verdict per candidate, keyed by index.`

const VALID_CATEGORIES = new Set([
  'public-knowledge', 'derivable', 'decision', 'convention', 'trap', 'topology',
])
const DISCARD_CATEGORIES = new Set(['public-knowledge', 'derivable'])
const VALUE_CLASS_MAP: Record<string, ValueClass> = {
  decision: 'decision', convention: 'convention', trap: 'trap', topology: 'topology',
}

function renderUserPrompt(candidates: DistillCandidate[]): string {
  return candidates.map((c, i) => `[${i}] ${c.title}\n${c.bodyMd}`).join('\n---\n')
}

/**
 * Classify each candidate into one of 6 categories (rules 1-6). Code maps
 * public-knowledge/derivable => discard, decision/convention/trap/topology =>
 * keep with valueClass. No valid classification (LLM error / non-JSON / missing
 * index / hallucinated category) => keep with valueClass=null (unevaluated):
 * discard requires a positive rule-1/2 classification; absent that, keep. Never
 * throws, never blocks distill (mirrors dedup's judgeDuplicates).
 */
export async function judgeValue(
  candidates: DistillCandidate[],
  callAnthropic: (system: string, user: string) => Promise<string>,
): Promise<ValueVerdict[]> {
  const n = candidates.length
  if (n === 0) return []
  const keepNull = (): ValueVerdict[] =>
    candidates.map((_, i) => ({ index: i, keep: true, valueClass: null }))
  try {
    const raw = await callAnthropic(VALUE_JUDGE_SYSTEM_PROMPT, renderUserPrompt(candidates))
    const parsed = JSON.parse(raw) as { verdicts?: unknown }
    if (!parsed || !Array.isArray(parsed.verdicts)) return keepNull()
    const byIndex = new Map<number, ValueVerdict>()
    for (const v of parsed.verdicts) {
      if (!v || typeof v !== 'object') continue
      const o = v as { index?: unknown; category?: unknown }
      if (typeof o.index !== 'number' || o.index < 0 || o.index >= n) continue
      if (typeof o.category !== 'string' || !VALID_CATEGORIES.has(o.category)) {
        byIndex.set(o.index, { index: o.index, keep: true, valueClass: null })
        continue
      }
      if (DISCARD_CATEGORIES.has(o.category)) {
        byIndex.set(o.index, { index: o.index, keep: false, reason: o.category as DiscardReason })
      } else {
        byIndex.set(o.index, { index: o.index, keep: true, valueClass: VALUE_CLASS_MAP[o.category] })
      }
    }
    return candidates.map((_, i) => byIndex.get(i) ?? { index: i, keep: true, valueClass: null })
  } catch {
    return keepNull()
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/valueFilter.test.ts`
Expected: 全 PASS（11 条）。

- [ ] **Step 5: Commit**

```bash
git add src/memory/valueFilter.ts tests/valueFilter.test.ts
git commit -m "feat(valueFilter): judgeValue 中性 6 类别分类层

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: store.ts — valueClass 读写 + logDiscards

**Files:**
- Modify: `src/memory/store.ts`
- Test: `tests/store-crud.test.ts`

**Interfaces:**
- Consumes: `ValueClass` from `./valueFilter`（Task 3）；`memoryDiscards` from `@/db/schema`（Task 1）。
- Produces: `MemoryInput.valueClass`、`Memory.valueClass`、`logDiscards(db, distillJobId, discards)`、`DiscardRecord`。

- [ ] **Step 1: 写失败测试**

在 `tests/store-crud.test.ts` 末尾加：

```ts
import { logDiscards } from '@/memory/store'
import { memoryDiscards } from '@/db/schema'

test('createCandidate stores valueClass and reads it back', async () => {
  const m = await createCandidate(db, {
    scopeType: 'project', scopeId: '/r', title: 't', bodyMd: 'b',
    tags: [], sourceKind: 'manual', runtime: null, valueClass: 'decision',
  })
  expect(m.valueClass).toBe('decision')
  const got = await getMemoryById(db, m.id)
  expect(got?.memory.valueClass).toBe('decision')
})

test('createCandidate defaults valueClass to null when omitted', async () => {
  const m = await createCandidate(db, {
    scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b',
    tags: [], sourceKind: 'manual', runtime: null,
  })
  expect(m.valueClass).toBeNull()
})

test('logDiscards writes rows with title/bodyMd/reason/distillJobId', async () => {
  // need a distill job row for the FK
  db.insert(memoryDistillJobs).values({ id: 'j1', debounceKey: 'k', sourceEventId: 's', runtime: 'claude-code', cwd: '/r', status: 'done', attempts: 0, nextRunAt: 0, createdAt: 0 }).run()
  await logDiscards(db, 'j1', [
    { title: 't1', bodyMd: 'b1', reason: 'public-knowledge' },
    { title: 't2', bodyMd: 'b2', reason: 'derivable' },
  ])
  const rows = await db.select().from(memoryDiscards).orderBy(memoryDiscards.ts)
  expect(rows.length).toBe(2)
  expect(rows[0]!.title).toBe('t1')
  expect(rows[0]!.reason).toBe('public-knowledge')
  expect(rows[0]!.distillJobId).toBe('j1')
})

test('logDiscards is a no-op on empty list', async () => {
  db.insert(memoryDistillJobs).values({ id: 'j2', debounceKey: 'k', sourceEventId: 's', runtime: 'claude-code', cwd: '/r', status: 'done', attempts: 0, nextRunAt: 0, createdAt: 0 }).run()
  await logDiscards(db, 'j2', [])
  const rows = await db.select().from(memoryDiscards)
  expect(rows.length).toBe(0)
})
```

需在 store-crud.test.ts 顶部 import 加 `memoryDistillJobs`（从 `@/db/schema`，与现有 `memories` import 同行）。

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/store-crud.test.ts`
Expected: 4 条新测试 FAIL（valueClass 字段/logDiscards 不存在）。

- [ ] **Step 3: 实现 store.ts**

`src/memory/store.ts`：

import 行加 `memoryDiscards`（与现有 `memories` 同源）与 `ValueClass` 类型：
```ts
import { memories, memoryDiscards } from '@/db/schema'
import type { ValueClass } from './valueFilter'
```

`MemoryInput` 接口加字段（`distillAction` 之后）：
```ts
  distillAction?: 'new' | 'update_of' | 'duplicate_of' | 'conflict_with' | null
  valueClass?: ValueClass | null
```

`Memory` 接口加字段（`version` 之后）：
```ts
  version: number
  valueClass: ValueClass | null
```

`rowToMemory` 加读回（在 `version: r.version,` 之后）：
```ts
    version: r.version,
    valueClass: (r.valueClass ?? null) as ValueClass | null,
```

`createCandidate` 的 `db.insert(memories).values({...})` 加 `valueClass: input.valueClass ?? null,`，以及末尾 `rowToMemory({...})` 的对象字面量加 `valueClass: input.valueClass ?? null,`。

文件末尾加 `logDiscards`：
```ts
export interface DiscardRecord {
  title: string
  bodyMd: string
  reason: 'public-knowledge' | 'derivable'
}

/**
 * Persist value-filter-discarded candidates to the memory_discards audit table.
 * Best-effort: caller (scheduler.tick) swallows thrown errors so an audit-log
 * failure never blocks distill or retries the job. No-op on empty list.
 */
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
    })),
  )
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/store-crud.test.ts`
Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/memory/store.ts tests/store-crud.test.ts
git commit -m "feat(store): valueClass 读写 + logDiscards 审计写入

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: dedup.ts — prompt 中性化

**Files:**
- Modify: `src/memory/dedup.ts:24`
- Test: `tests/dedup.test.ts`

**Interfaces:** 无新接口。仅删 prompt 末句。

- [ ] **Step 1: 写失败测试 — 中性断言**

在 `tests/dedup.test.ts` 顶部 import 加 `DEDUP_SYSTEM_PROMPT`：
```ts
import { judgeDuplicates, DEDUP_SYSTEM_PROMPT, type ExistingMemoryForDedup } from '@/memory/dedup'
```

文件末尾加：
```ts
test('DEDUP_SYSTEM_PROMPT is neutral (no unsure tie-breaker)', () => {
  // 锁中性：删 "When unsure, emit isDuplicate:false." 后不得回退
  const lower = DEDUP_SYSTEM_PROMPT.toLowerCase()
  expect(lower).not.toContain('unsure')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/dedup.test.ts`
Expected: 1 条新测试 FAIL（prompt 仍含 "unsure"）。

- [ ] **Step 3: 实现 — 删末句**

`src/memory/dedup.ts` 第 24 行，把：
```
Respond ONLY with JSON: {"verdicts":[{"index":<n>,"isDuplicate":true,"duplicateOfId":"<id>"} | {"index":<n>,"isDuplicate":false}]}. Emit one verdict per new candidate, keyed by its index. duplicateOfId MUST be one of the existing ids. When unsure, emit isDuplicate:false.`
```
改为（删最后一句）：
```
Respond ONLY with JSON: {"verdicts":[{"index":<n>,"isDuplicate":true,"duplicateOfId":"<id>"} | {"index":<n>,"isDuplicate":false}]}. Emit one verdict per new candidate, keyed by its index. duplicateOfId MUST be one of the existing ids.`
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/dedup.test.ts`
Expected: 全 PASS（现有 9 条 + 新 1 条；代码层 fallback 行为不变）。

- [ ] **Step 5: Commit**

```bash
git add src/memory/dedup.ts tests/dedup.test.ts
git commit -m "feat(dedup): prompt 中性化（删 When unsure 偏向句）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: scheduler.ts — tick 插 judgeValue + logDiscards

**Files:**
- Modify: `src/scheduler.ts:103-158`（tick）
- Test: `tests/scheduler.test.ts`

**Interfaces:**
- Consumes: `judgeValue` from `@/memory/valueFilter`、`logDiscards` + `DiscardRecord` from `@/memory/store`（Task 3/4）。
- Produces: tick 现在按 distill -> judgeValue -> dedup -> createCandidate 顺序；keep 的 createCandidate 入参带 `valueClass`。

- [ ] **Step 1: 写失败测试 — 新增 value-filter 行为**

在 `tests/scheduler.test.ts` 末尾加：

```ts
test('tick discards value-filter public-knowledge, logs to memory_discards, no createCandidate', async () => {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let createCalls = 0
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => [{ role: 'user', content: 'x' }],
    callAnthropic: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:x] js array map', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
      if (callCount === 2) return JSON.stringify({ verdicts: [{ index: 0, category: 'public-knowledge' }] })
      return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] })
    },
    createCandidate: async () => { createCalls++; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(createCalls).toBe(0)
  const discards = await db.select().from(memoryDiscards)
  expect(discards.length).toBe(1)
  expect(discards[0]!.reason).toBe('public-knowledge')
  const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(rows[0]!.status).toBe('done')
})

test('tick passes valueClass into createCandidate for kept candidates', async () => {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let captured: any = null
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => [{ role: 'user', content: 'x' }],
    callAnthropic: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:x] chose A not B because', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
      if (callCount === 2) return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
      return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] })
    },
    createCandidate: async (_db, input) => { captured = input; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(captured.valueClass).toBe('decision')
})

test('tick keeps all as valueClass=null when judgeValue LLM throws, job still done', async () => {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let captured: any = null
  let createCalls = 0
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => [{ role: 'user', content: 'x' }],
    callAnthropic: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:x] new', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
      if (callCount === 2) throw new Error('value api down')
      return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] })
    },
    createCandidate: async (_db, input) => { captured = input; createCalls++; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(createCalls).toBe(1)
  expect(captured.valueClass).toBeNull()
  const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(rows[0]!.status).toBe('done')
})

test('tick runs judgeValue before dedup (3-phase call order)', async () => {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  const phases: string[] = []
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => [{ role: 'user', content: 'x' }],
    callAnthropic: async (_sys, user) => {
      callCount++
      if (callCount === 1) { phases.push('distill'); return JSON.stringify({ candidates: [{ title: '[category:x] new', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] }) }
      if (callCount === 2) { phases.push('judgeValue'); return JSON.stringify({ verdicts: [{ index: 0, category: 'trap' }] }) }
      phases.push('dedup'); return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] })
    },
    createCandidate: async () => ({ id: 'c1', status: 'candidate', version: 1 } as any),
  })
  expect(phases).toEqual(['distill', 'judgeValue', 'dedup'])
})
```

需在 scheduler.test.ts 顶部 import 加 `memoryDiscards`（从 `@/db/schema`，与现有 `memoryDistillJobs, memories` 同行）。

- [ ] **Step 2: 写失败测试 — 更新现有 4 条 3-phase mock**

现有 4 条测试用 `callCount === 1` (distill) / `callCount === 2` (dedup) 的两段式 mock。judgeValue 插在中间后，dedup 变 call 3。逐条把 mock 改成三段式（call 1 distill / call 2 judgeValue / call 3 dedup）：

- `'tick filters duplicate candidates (dedup marks duplicate, not persisted)'`（约 99 行）：mock 改为
  ```ts
  callAnthropic: async () => {
    callCount++
    if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:process] 14天退款', bodyMd: '14d', scope: 'project', runtime: null, distillAction: 'new' }] })
    if (callCount === 2) return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: true, duplicateOfId: ex.id }] })
  },
  ```
- `'tick keeps all candidates when dedup LLM throws (conservative, job still done)'`（约 118 行）：mock 改为
  ```ts
  callAnthropic: async () => {
    callCount++
    if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:x] new', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
    if (callCount === 2) return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    throw new Error('dedup api down')
  },
  ```
- `'tick skips dedup LLM when no existing memories in scope'`（约 139 行）：mock 改为三段式并把断言 `expect(callCount).toBe(1)` 改为 `expect(callCount).toBe(2)`（distill + judgeValue；dedup 因无 existing 跳过）：
  ```ts
  callAnthropic: async () => {
    callCount++
    if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:x] new', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
    return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
  },
  ```
  断言：`expect(callCount).toBe(2)` / `expect(createCalls).toBe(1)`。
- `'tick keeps sourceCwd/distillAction in createCandidate input after dedup'`（约 153 行）：mock 改为三段式（call 2 返回 value verdicts）：
  ```ts
  callAnthropic: async () => {
    callCount++
    if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:x] new', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
    if (callCount === 2) return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] })
  },
  ```
  断言不变（`captured.sourceCwd === '/r'` / `captured.distillAction === 'new'`）。

- [ ] **Step 3: 运行测试确认失败**

Run: `bun test tests/scheduler.test.ts`
Expected: 新 4 条 + 改 4 条 FAIL（judgeValue 未接入；现有 mock 顺序错）。

- [ ] **Step 4: 实现 — tick 接入 judgeValue + logDiscards**

`src/scheduler.ts` 顶部 import 加：
```ts
import { judgeValue } from '@/memory/valueFilter'
import { listForDedupByScope, logDiscards, type DiscardRecord } from '@/memory/store'
import type { ValueClass } from '@/memory/valueFilter'
```
（`listForDedupByScope` 已 import；合并到现有 store import 行即可，避免重复。）

tick 内，把现有（约 118-144 行）：
```ts
      const candidates: DistillCandidate[] = await distillTranscript({
        turns,
        runtime: job.runtime as 'claude-code' | 'opencode',
        cwd: job.cwd ?? '',
        callAnthropic: deps.callAnthropic,
      })
      const keep = await dedupCandidates(db, deps.callAnthropic, candidates, job.cwd ?? null)
      for (const c of keep) {
        await deps.createCandidate(db, {
          scopeType: c.scopeType,
          scopeId: resolveScopeId(c.scopeType, job.cwd ?? null),
          title: c.title,
          bodyMd: c.bodyMd,
          tags: [],
          sourceKind: 'conversation',
          sourceCwd: job.cwd ?? null,
          runtime: c.runtime,
          distillJobId: job.id,
          distillAction: c.distillAction,
          sourceEventId: job.sourceEventId,
        })
      }
```
改为：
```ts
      const candidates: DistillCandidate[] = await distillTranscript({
        turns,
        runtime: job.runtime as 'claude-code' | 'opencode',
        cwd: job.cwd ?? '',
        callAnthropic: deps.callAnthropic,
      })
      // Value filter: classify each candidate (rules 1-6). public-knowledge/
      // derivable => discard (audit-logged); decision/convention/trap/topology
      // => keep with valueClass; no valid classification => keep valueClass=null.
      // judgeValue swallows its own LLM errors (all keep+null), never bubbles.
      const verdicts = await judgeValue(candidates, deps.callAnthropic)
      const keepWithClass: { cand: DistillCandidate; valueClass: ValueClass | null }[] = []
      const discarded: DiscardRecord[] = []
      verdicts.forEach((v, i) => {
        const c = candidates[i]
        if (!c) return
        if (v.keep) keepWithClass.push({ cand: c, valueClass: v.valueClass })
        else discarded.push({ title: c.title, bodyMd: c.bodyMd, reason: v.reason })
      })
      if (discarded.length > 0) {
        // Best-effort audit log: a DB failure here must not block distill or
        // retry the job (audit is side-effect, not load-bearing).
        try { await logDiscards(db, job.id, discarded) } catch (e) { console.warn('memside: logDiscards failed', e) }
      }
      // Dedup survivors against same-scope existing (existing behavior).
      const keepCandidates = keepWithClass.map((k) => k.cand)
      const deduped = await dedupCandidates(db, deps.callAnthropic, keepCandidates, job.cwd ?? null)
      // Re-attach valueClass by reference: dedupCandidates returns a same-reference
      // subset of keepCandidates (scheduler.ts `candidates.filter(...)`), so the
      // cand object identity survives dedup and we can map back to its valueClass.
      const classByCand = new Map(keepWithClass.map((k) => [k.cand, k.valueClass]))
      for (const c of deduped) {
        await deps.createCandidate(db, {
          scopeType: c.scopeType,
          scopeId: resolveScopeId(c.scopeType, job.cwd ?? null),
          title: c.title,
          bodyMd: c.bodyMd,
          tags: [],
          sourceKind: 'conversation',
          sourceCwd: job.cwd ?? null,
          runtime: c.runtime,
          distillJobId: job.id,
          distillAction: c.distillAction,
          sourceEventId: job.sourceEventId,
          valueClass: classByCand.get(c) ?? null,
        })
      }
```

- [ ] **Step 5: 运行测试确认通过**

Run: `bun test tests/scheduler.test.ts`
Expected: 全 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/scheduler.ts tests/scheduler.test.ts
git commit -m "feat(scheduler): tick 插 judgeValue + logDiscards，valueClass 穿透 dedup

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: server.ts — bulk-promote 端点

**Files:**
- Modify: `src/server.ts`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: `promoteCandidate` from `@/memory/store`（已有）。
- Produces: `POST /api/memories/bulk-promote` `{ids:string[], action:'reject'}` -> `{rejected:number}`，逐条广播 `memory.promoted`。

- [ ] **Step 1: 写失败测试**

在 `tests/server.test.ts` 末尾加：

```ts
test('POST /api/memories/bulk-promote rejects multiple and broadcasts per id', async () => {
  const c1 = await createCandidate(db, { scopeType: 'global', scopeId: null, title: 't1', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  const c2 = await createCandidate(db, { scopeType: 'global', scopeId: null, title: 't2', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  const r = await req('/api/memories/bulk-promote', {
    method: 'POST',
    body: JSON.stringify({ ids: [c1.id, c2.id], action: 'reject' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(200)
  expect(r.body.rejected).toBe(2)
  expect(broadcastCalls.filter((m) => (m as any).type === 'memory.promoted').length).toBe(2)
  const after = await db.select().from(memories)
  expect(after.every((m) => m.status === 'rejected')).toBe(true)
})
```

需在 server.test.ts 顶部 import 加 `memories`（从 `@/db/schema`，与现有 `memoryDistillJobs, memoryDistillEvents` 同行）。

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/server.test.ts`
Expected: 1 条新测试 FAIL（404，端点不存在）。

- [ ] **Step 3: 实现 — server.ts 加路由**

`src/server.ts` 在 `app.post('/api/memories', ...)`（约 194 行）之前加：

```ts
  app.post('/api/memories/bulk-promote', async (c) => {
    const body = await c.req.json().catch(() => ({ ids: [] as string[], action: 'reject' }))
    const ids: string[] = Array.isArray(body.ids) ? body.ids.filter((x: unknown) => typeof x === 'string') : []
    let count = 0
    for (const id of ids) {
      try {
        const m = await promoteCandidate(deps.db, id, { action: 'reject' })
        deps.broadcast({ type: 'memory.promoted', memoryId: m.id, newStatus: m.status })
        count += 1
      } catch {
        // skip not-found / non-candidate (already terminal); continue with the rest
      }
    }
    return c.json({ rejected: count })
  })
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/server.test.ts`
Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat(server): bulk-promote 批量拒绝端点

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: UI — 排序 + valueClass 徽标 + 批量拒绝

**Files:**
- Modify: `src/web/api.ts`
- Modify: `src/web/App.tsx`
- Test: `tests/web-ui.test.ts`

**Interfaces:**
- Consumes: `MemoryItem.valueClass`（API 返回，drizzle camelCase 映射）。
- Produces: candidates 按高/中/未评估排序；卡片徽标；"批量拒绝未评估" 按钮（调 `bulkPromote`）。

- [ ] **Step 1: 写失败测试 — 源码层文本断言**

先读 `tests/web-ui.test.ts` 看现有结构。在合适位置加一条源码层文本断言（CLAUDE.md 运行时组件兜底）：

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

test('App.tsx renders valueClass badge labels and bulk-reject button (source text)', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf-8')
  // 派生优先级标签
  expect(src).toContain('高·决策')
  expect(src).toContain('未评估')
  // 批量拒绝未评估按钮
  expect(src).toContain('批量拒绝未评估')
})
```

（若 web-ui.test.ts 已 import `readFileSync`/`join` 则不重复 import；按现有文件调整。）

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/web-ui.test.ts`
Expected: 1 条新测试 FAIL（App.tsx 还没有这些文本）。

- [ ] **Step 3: 实现 — api.ts 加 valueClass + bulkPromote**

`src/web/api.ts` 的 `MemoryItem` 接口加字段（`version?` 之后）：
```ts
  version?: number
  valueClass?: string | null
```

文件末尾加：
```ts
/**
 * POST /api/memories/bulk-promote - reject multiple candidates in one call
 * (avoids N round-trips when clearing the unevaluated tail of the queue).
 */
export async function bulkPromote(
  ids: string[],
  action: 'reject',
  fetchFn: FetchLike = fetch,
): Promise<{ rejected: number }> {
  const res = await fetchFn('/api/memories/bulk-promote', {
    method: 'POST',
    body: JSON.stringify({ ids, action }),
    headers: { 'content-type': 'application/json' },
  })
  return (await res.json()) as { rejected: number }
}
```

- [ ] **Step 4: 实现 — App.tsx 排序 + 徽标 + 批量按钮**

`src/web/App.tsx`：

import 行加 `bulkPromote`：
```ts
import { listMemories, promoteMemory, patchMemory, getStatus, bulkPromote, type MemoryItem, type MemsideStatus } from './api'
```

在组件内（`edit` 函数之后、`const candidates = ...` 之前）加派生优先级 + 徽标 helper：
```ts
  function priority(vc: string | null | undefined): 'high' | 'medium' | 'unevaluated' {
    if (vc === 'decision' || vc === 'convention') return 'high'
    if (vc === 'trap' || vc === 'topology') return 'medium'
    return 'unevaluated'
  }
  const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, unevaluated: 2 }
  const VALUE_LABEL: Record<string, string> = {
    decision: '高·决策', convention: '高·约定', trap: '中·陷阱', topology: '中·拓扑',
  }
  function valueBadge(vc: string | null | undefined): string {
    return vc && VALUE_LABEL[vc] ? VALUE_LABEL[vc] : '未评估'
  }
```

把 `const candidates = items.filter((i) => i.status === 'candidate')` 改为排序：
```ts
  const candidates = items
    .filter((i) => i.status === 'candidate')
    .sort((a, b) => PRIORITY_RANK[priority(a.valueClass)] - PRIORITY_RANK[priority(b.valueClass)])
```

加批量拒绝 handler（在 `edit` 函数之后）：
```ts
  async function bulkRejectUnevaluated() {
    const ids = items.filter((i) => i.status === 'candidate' && priority(i.valueClass) === 'unevaluated').map((i) => i.id)
    if (ids.length === 0) return
    await bulkPromote(ids, 'reject')
    void refresh()
  }
```

在 `<p>{candidates.length} 条候选记忆待审</p>` 之后加批量按钮：
```tsx
      <p>{candidates.length} 条候选记忆待审</p>
      {candidates.some((m) => priority(m.valueClass) === 'unevaluated') ? (
        <button onClick={() => bulkRejectUnevaluated()} style={{ marginBottom: 12 }}>
          批量拒绝未评估
        </button>
      ) : null}
```

在 `MemoryCard` 渲染里，`<strong>{m.title}</strong>` 之后加徽标（在 editing ? : else 分支的 else 里，`<strong>` 后）：
```tsx
          <strong>{m.title}</strong>
          <span style={{ marginLeft: 8, fontSize: 12, color: '#888' }}>{valueBadge(m.valueClass)}</span>
          {m.bodyMd && <p style={{ color: '#555' }}>{m.bodyMd}</p>}
```

（`valueBadge` 需在 `App` 组件作用域可见；把它定义在模块顶层而非组件内，或提到 `App` 内并传给 `MemoryCard`。最简：把 `priority`/`VALUE_LABEL`/`valueBadge` 定义在文件模块顶层 `function App()` 之前，`MemoryCard` 直接用模块级 `valueBadge`。）

实现时把 `VALUE_LABEL` 与 `valueBadge` 提到模块顶层：
```ts
const VALUE_LABEL: Record<string, string> = {
  decision: '高·决策', convention: '高·约定', trap: '中·陷阱', topology: '中·拓扑',
}
function valueBadge(vc: string | null | undefined): string {
  return vc && VALUE_LABEL[vc] ? VALUE_LABEL[vc] : '未评估'
}
function priorityRank(vc: string | null | undefined): number {
  if (vc === 'decision' || vc === 'convention') return 0
  if (vc === 'trap' || vc === 'topology') return 1
  return 2
}
```
`App` 内排序用 `priorityRank`，`bulkRejectUnevaluated` 用 `priorityRank(...) === 2` 判未评估。

- [ ] **Step 5: 运行测试确认通过**

Run: `bun test tests/web-ui.test.ts`
Expected: 全 PASS。

- [ ] **Step 6: typecheck + 全量测试**

Run: `bun run typecheck && bun test`
Expected: 全绿。

- [ ] **Step 7: Commit**

```bash
git add src/web/api.ts src/web/App.tsx tests/web-ui.test.ts
git commit -m "feat(web): 价值优先级排序 + valueClass 徽标 + 批量拒绝未评估

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: 收尾 — 全量验证 + push + PR + 合并

**Files:** 无代码改动。

- [ ] **Step 1: 全量类型检查 + 测试**

Run: `bun run typecheck && bun test`
Expected: typecheck 干净；测试全绿（0 失败）。

- [ ] **Step 2: 推远端**

Run: `git push -u origin feat/candidate-value-filter`
Expected: 推送成功。

- [ ] **Step 3: 开 PR**

Run（gh CLI）：
```bash
gh pr create --base master --head feat/candidate-value-filter --title "feat: 候选记忆价值过滤（judgeValue + UI 排序 + dedup prompt 中性化）" --body "$(cat <<'EOF'
## 概要
distill 后、dedup 前加中性 LLM 价值判定层 `judgeValue`，把候选分类到 6 类别：规则 1-2（公共知识/可推导）丢弃进 `memory_discards` 审计表，规则 3-6（决策/约定/陷阱/拓扑）带 `value_class` 入库，无合法分类的以 `value_class=NULL` 未评估保留。UI 按派生优先级排序 + 徽标 + 批量拒绝未评估。顺带中性化 dedup prompt（删 "When unsure:false" 偏向句）。

## spec / plan
- spec: `docs/superpowers/specs/2026-07-23-candidate-value-filter-design.md`
- plan: `docs/superpowers/plans/2026-07-23-candidate-value-filter.md`

## 改动
- 新增 `src/memory/valueFilter.ts`（judgeValue 纯函数 + 中性 prompt）
- schema: `value_class` 列 + `memory_discards` 审计表 + 迁移
- store: valueClass 读写 + logDiscards
- scheduler: tick 插 judgeValue + logDiscards，valueClass 穿透 dedup
- dedup: prompt 中性化
- server: bulk-promote 端点
- web: 优先级排序 + 徽标 + 批量拒绝

## 测试
`bun run typecheck && bun test` 全绿。新增/扩展 valueFilter / schema / store-crud / dedup / scheduler / server / web-ui 测试。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
Expected: PR 创建成功，返回 PR URL。

- [ ] **Step 4: 合并 PR**

Run: `gh pr merge --squash --delete-branch`
Expected: 合并成功，远端分支删除。

- [ ] **Step 5: 本地清理**

Run:
```bash
git checkout master && git pull origin master && git fetch --prune && git branch -d feat/candidate-value-filter
```
Expected: master 更新到含新 commit；本地 feature 分支删除。

---

## Self-Review

**1. Spec coverage:**
- G1（分类 + 丢弃/打标/未评估）-> Task 3 (judgeValue) + Task 6 (tick) ✓
- G2（fallback 不丢不阻断）-> Task 3 (judgeValue fallback) + Task 6 (不冒泡) ✓
- G3（独立纯函数模块）-> Task 3 ✓
- G4（UI 排序 + 徽标 + 批量拒绝）-> Task 7 (bulk-promote) + Task 8 (UI) ✓
- G5（prompt 中性）-> Task 3 (VALUE_JUDGE 中性断言) + Task 5 (dedup 中性断言) ✓
- G6（dedup prompt 中性化）-> Task 5 ✓
- value_class 列 + memory_discards 表 + 迁移 -> Task 1/2 ✓
- valueClass 穿透 dedup -> Task 6 (classByCand by reference) ✓
- 只管未来 -> Task 2 (no backfill) ✓
- distiller 不动 -> 无 task 涉及 ✓

**2. Placeholder scan:** 无 TBD/TODO；每步有实际代码或确切命令。

**3. Type consistency:**
- `ValueClass` 定义在 valueFilter.ts（Task 3），store.ts（Task 4）与 scheduler.ts（Task 6）均 import 自 `@/memory/valueFilter` ✓
- `judgeValue(candidates, callAnthropic)` 签名 Task 3 定义、Task 6 调用一致 ✓
- `logDiscards(db, distillJobId, discards)` + `DiscardRecord` Task 4 定义、Task 6 调用一致 ✓
- `MemoryInput.valueClass?: ValueClass | null` Task 4 定义、Task 6 createCandidate 传 `valueClass: classByCand.get(c) ?? null` 一致 ✓
- `bulkPromote(ids, 'reject')` Task 8 api.ts 定义、App.tsx 调用一致 ✓
- scheduler 测试 3-phase mock（call 1 distill / 2 judgeValue / 3 dedup）与 Task 6 实现的调用顺序一致 ✓
