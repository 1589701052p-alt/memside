# 候选记忆去重机制 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** distill 产出的新候选在落库前与同 scope 已有记忆（candidate + approved）做语义去重，duplicate 丢弃、new 才入库；失败时保守放行，永不丢信息。

**Architecture:** 新增独立纯函数模块 `src/memory/dedup.ts`（`judgeDuplicates` + 注入 `callAnthropic`，同 distiller 模式）；store 新增 `listForDedupByScope` 查询（approved 全量 + candidate 最近 50）；`scheduler.tick` 在 distill 后、createCandidate 前按 scope 分组调 dedup 过滤。零 schema 变更；store.createCandidate / distiller / 注入路径均不变。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite(WAL) + zod + @anthropic-ai/sdk；测试 bun:test。

## Global Constraints

- `bun run typecheck && bun test` 必须全绿才能 push（CLAUDE.md 运行门槛）。
- 严禁直推 `master`；本分支 `feat/candidate-dedup`（基线 `origin/master` `937a8e3`），PR 合 `master`。
- 任何生产代码改动必须带测试；纯函数/纯数据层为首选可断言面（CLAUDE.md）。
- dedup 失败（LLM 抛错 / 解析失败 / 幻觉）一律保守放行（当 `new` 入库），永不丢信息、永不阻断 distill、不让 job 退回 pending。
- 零 schema 变更：不增列、不删列、不写迁移。
- claude code/opencode 行为以源码为准；本计划不改动 hook 协议。

## File Structure

| 文件 | 职责 | 本计划动作 |
|------|------|-----------|
| `src/memory/dedup.ts`（新） | 语义去重判定纯函数 | 新建 `judgeDuplicates` + 类型 + prompt |
| `src/memory/store.ts` | 记忆 CRUD/查询 | 加 `listForDedupByScope` + `DEDUP_EXISTING_LIMIT` |
| `src/scheduler.ts` | distill tick | tick 插 dedup 过滤 + `dedupCandidates` helper |
| `tests/dedup.test.ts`（新） | dedup 纯函数 | 全 case 单测 |
| `tests/store-crud.test.ts` | store 查询 | 加 `listForDedupByScope` 测试 |
| `tests/scheduler.test.ts` | tick | 加 dedup 集成测试 |

依赖方向（无循环）：`dedup.ts` →（type only）`distiller.ts`/`pure.ts`；`store.ts` →（type only）`dedup.ts`；`scheduler.ts` → `dedup.ts` + `store.ts` + `distiller.ts`。

---

## Task 1: dedup 纯函数模块

**Files:**
- Create: `src/memory/dedup.ts`
- Test: `tests/dedup.test.ts`

**Interfaces:**
- Consumes: `DistillCandidate`（`src/memory/distiller.ts:32-38`）、`MemoryScope`/`MemoryStatus`（`src/memory/pure.ts`）。
- Produces: `judgeDuplicates(input: DedupInput): Promise<DedupVerdict[]>`、`DedupInput`、`DedupVerdict`、`ExistingMemoryForDedup`、`DEDUP_SYSTEM_PROMPT`。`index` 为 `newCandidates` 数组内 0-based 下标。

- [ ] **Step 1: 写失败测试**

新建 `tests/dedup.test.ts`：

```ts
import { test, expect } from 'bun:test'
import { judgeDuplicates, type ExistingMemoryForDedup } from '@/memory/dedup'
import type { DistillCandidate } from '@/memory/distiller'

const existing: ExistingMemoryForDedup[] = [
  { id: 'A', title: '[category:invariant] refund within 14 days', scopeType: 'project', scopeId: '/r', status: 'approved' },
]
const newCand: DistillCandidate = {
  title: '[category:process] 退款必须在发货后14天内', bodyMd: '14天退款窗口',
  scopeType: 'project', runtime: null, distillAction: 'new',
}

test('judgeDuplicates marks duplicate with valid duplicateOfId', async () => {
  const v = await judgeDuplicates({
    newCandidates: [newCand], existing,
    callAnthropic: async () => JSON.stringify({ verdicts: [{ index: 0, isDuplicate: true, duplicateOfId: 'A' }] }),
  })
  expect(v).toEqual([{ index: 0, duplicate: true, duplicateOfId: 'A' }])
})

test('judgeDuplicates marks new when isDuplicate false', async () => {
  const v = await judgeDuplicates({
    newCandidates: [newCand], existing,
    callAnthropic: async () => JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] }),
  })
  expect(v).toEqual([{ index: 0, duplicate: false }])
})

test('judgeDuplicates returns all new when LLM throws', async () => {
  const v = await judgeDuplicates({
    newCandidates: [newCand], existing,
    callAnthropic: async () => { throw new Error('api down') },
  })
  expect(v).toEqual([{ index: 0, duplicate: false }])
})

test('judgeDuplicates returns all new on non-JSON response', async () => {
  const v = await judgeDuplicates({
    newCandidates: [newCand], existing,
    callAnthropic: async () => 'not json',
  })
  expect(v).toEqual([{ index: 0, duplicate: false }])
})

test('judgeDuplicates returns all new on missing verdicts field', async () => {
  const v = await judgeDuplicates({
    newCandidates: [newCand], existing,
    callAnthropic: async () => JSON.stringify({ foo: 'bar' }),
  })
  expect(v).toEqual([{ index: 0, duplicate: false }])
})

test('judgeDuplicates treats hallucinated duplicateOfId as new', async () => {
  const v = await judgeDuplicates({
    newCandidates: [newCand], existing,
    callAnthropic: async () => JSON.stringify({ verdicts: [{ index: 0, isDuplicate: true, duplicateOfId: 'NONEXISTENT' }] }),
  })
  expect(v).toEqual([{ index: 0, duplicate: false }])
})

test('judgeDuplicates skips LLM and returns all new when existing is empty', async () => {
  let called = 0
  const v = await judgeDuplicates({
    newCandidates: [newCand], existing: [],
    callAnthropic: async () => { called++; return 'x' },
  })
  expect(called).toBe(0)
  expect(v).toEqual([{ index: 0, duplicate: false }])
})

test('judgeDuplicates returns [] and skips LLM when newCandidates is empty', async () => {
  let called = 0
  const v = await judgeDuplicates({
    newCandidates: [], existing,
    callAnthropic: async () => { called++; return 'x' },
  })
  expect(called).toBe(0)
  expect(v).toEqual([])
})

test('judgeDuplicates treats missing indices as new', async () => {
  const two: DistillCandidate[] = [newCand, { ...newCand, title: '[category:x] second' }]
  const v = await judgeDuplicates({
    newCandidates: two, existing,
    callAnthropic: async () => JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] }),
  })
  expect(v).toEqual([{ index: 0, duplicate: false }, { index: 1, duplicate: false }])
})

test('user prompt includes existing titles and ids', async () => {
  let captured = ''
  await judgeDuplicates({
    newCandidates: [newCand], existing,
    callAnthropic: async (_sys, user) => { captured = user; return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] }) },
  })
  expect(captured).toContain('refund within 14 days')
  expect(captured).toContain('id=A')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/dedup.test.ts`
Expected: FAIL（`@/memory/dedup` 模块不存在，import 报错）。

- [ ] **Step 3: 实现 dedup.ts**

新建 `src/memory/dedup.ts`：

```ts
import type { DistillCandidate } from '@/memory/distiller'
import type { MemoryScope, MemoryStatus } from '@/memory/pure'

export interface ExistingMemoryForDedup {
  id: string
  title: string
  scopeType: MemoryScope
  scopeId: string | null
  status: MemoryStatus
}

export interface DedupInput {
  newCandidates: DistillCandidate[]
  existing: ExistingMemoryForDedup[]
  callAnthropic: (system: string, user: string) => Promise<string>
}

export type DedupVerdict =
  | { index: number; duplicate: false }
  | { index: number; duplicate: true; duplicateOfId: string }

export const DEDUP_SYSTEM_PROMPT = `You are memside-dedup. Decide whether each new candidate memory is a SEMANTIC DUPLICATE of any existing memory in the same scope - the same rule or fact, even if worded differently or tagged with a different [category:] prefix.

Respond ONLY with JSON: {"verdicts":[{"index":<n>,"isDuplicate":true,"duplicateOfId":"<id>"} | {"index":<n>,"isDuplicate":false}]}. Emit one verdict per new candidate, keyed by its index. duplicateOfId MUST be one of the existing ids. When unsure, emit isDuplicate:false.`

function renderUserPrompt(newCandidates: DistillCandidate[], existing: ExistingMemoryForDedup[]): string {
  const exLines = existing.length === 0
    ? '(none)'
    : existing.map((e) => `id=${e.id} | ${e.title}`).join('\n')
  const newLines = newCandidates.map((c, i) => `[${i}] ${c.title}\n${c.bodyMd}`).join('\n---\n')
  return `Existing memories (same scope):\n${exLines}\n\nNew candidates:\n${newLines}\n\nReturn JSON per the system instructions.`
}

/**
 * Judge each new candidate against same-scope existing memories for semantic
 * duplication. Pure + injectable `callAnthropic` (same seam as the distiller).
 *
 * Conservative fallback (never throws, never drops info): on LLM error, non-JSON,
 * missing `verdicts`, missing indices, or a hallucinated `duplicateOfId` not in
 * `existing`, the affected candidate is treated as `duplicate:false` (kept). When
 * `existing` is empty or `newCandidates` is empty, the LLM is not called at all.
 */
export async function judgeDuplicates(input: DedupInput): Promise<DedupVerdict[]> {
  const n = input.newCandidates.length
  if (n === 0) return []
  if (input.existing.length === 0) {
    return input.newCandidates.map((_, i) => ({ index: i, duplicate: false }))
  }
  const existingIds = new Set(input.existing.map((e) => e.id))
  try {
    const raw = await input.callAnthropic(DEDUP_SYSTEM_PROMPT, renderUserPrompt(input.newCandidates, input.existing))
    const parsed = JSON.parse(raw) as { verdicts?: unknown }
    if (!parsed || !Array.isArray(parsed.verdicts)) {
      return input.newCandidates.map((_, i) => ({ index: i, duplicate: false }))
    }
    const byIndex = new Map<number, DedupVerdict>()
    for (const v of parsed.verdicts) {
      if (!v || typeof v !== 'object') continue
      const o = v as { index?: unknown; isDuplicate?: unknown; duplicateOfId?: unknown }
      if (typeof o.index !== 'number' || o.index < 0 || o.index >= n) continue
      if (o.isDuplicate === true && typeof o.duplicateOfId === 'string' && existingIds.has(o.duplicateOfId)) {
        byIndex.set(o.index, { index: o.index, duplicate: true, duplicateOfId: o.duplicateOfId })
      } else {
        // isDuplicate:false OR hallucinated duplicateOfId -> treat as new
        byIndex.set(o.index, { index: o.index, duplicate: false })
      }
    }
    // Any index the LLM omitted -> new (conservative)
    return input.newCandidates.map((_, i) => byIndex.get(i) ?? { index: i, duplicate: false })
  } catch {
    return input.newCandidates.map((_, i) => ({ index: i, duplicate: false }))
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/dedup.test.ts`
Expected: PASS（10 个测试全绿）。

- [ ] **Step 5: Commit**

```bash
git add src/memory/dedup.ts tests/dedup.test.ts
git commit -m "feat(dedup): judgeDuplicates semantic dup gate with conservative fallback" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: store listForDedupByScope 查询

**Files:**
- Modify: `src/memory/store.ts`
- Test: `tests/store-crud.test.ts`

**Interfaces:**
- Consumes: `DbClient`、`memories` schema、`MemoryScope`/`MemoryStatus`（已 import）、`isNull`（drizzle-orm，新加）、`ExistingMemoryForDedup`（type-only，from `./dedup`，Task 1）。
- Produces: `listForDedupByScope(db, {scopeType, scopeId}): Promise<ExistingMemoryForDedup[]>`、`DEDUP_EXISTING_LIMIT = 50`。返回同 scope 的 approved 全量 + candidate `createdAt DESC LIMIT 50`，去重，仅含 `{id,title,scopeType,scopeId,status}`（不含 runtime/body）。

- [ ] **Step 1: 写失败测试**

在 `tests/store-crud.test.ts` 顶部 import 行（`import { createCandidate, listApprovedByScope, getMemoryById } from '@/memory/store'`）改为：

```ts
import { createCandidate, listApprovedByScope, getMemoryById, listForDedupByScope, DEDUP_EXISTING_LIMIT } from '@/memory/store'
```

在文件末尾追加：

```ts
test('listForDedupByScope returns candidate+approved in same scope', async () => {
  const c = await createCandidate(db, { scopeType: 'project', scopeId: '/r', title: 'cand', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  const a = await createCandidate(db, { scopeType: 'project', scopeId: '/r', title: 'appr', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  await db.update(memories).set({ status: 'approved' }).where(eq(memories.id, a.id)).run()
  const rows = await listForDedupByScope(db, { scopeType: 'project', scopeId: '/r' })
  expect(rows.map((r) => r.id).sort()).toEqual([a.id, c.id].sort())
  expect(rows.every((r) => r.status === 'candidate' || r.status === 'approved')).toBe(true)
})

test('listForDedupByScope excludes other scopes and terminal statuses', async () => {
  await createCandidate(db, { scopeType: 'project', scopeId: '/other', title: 'other scope', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  await createCandidate(db, { scopeType: 'global', scopeId: null, title: 'global scope', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  const rej = await createCandidate(db, { scopeType: 'project', scopeId: '/r', title: 'rejected', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  await db.update(memories).set({ status: 'rejected' }).where(eq(memories.id, rej.id)).run()
  const rows = await listForDedupByScope(db, { scopeType: 'project', scopeId: '/r' })
  expect(rows.length).toBe(0)
})

test('listForDedupByScope limits candidates to DEDUP_EXISTING_LIMIT', async () => {
  for (let i = 0; i < DEDUP_EXISTING_LIMIT + 5; i++) {
    await createCandidate(db, { scopeType: 'global', scopeId: null, title: `c${i}`, bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  }
  const rows = await listForDedupByScope(db, { scopeType: 'global', scopeId: null })
  expect(rows.length).toBe(DEDUP_EXISTING_LIMIT)
})

test('listForDedupByScope returns approved all + candidate limited', async () => {
  for (let i = 0; i < 3; i++) {
    const m = await createCandidate(db, { scopeType: 'global', scopeId: null, title: `a${i}`, bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
    await db.update(memories).set({ status: 'approved' }).where(eq(memories.id, m.id)).run()
  }
  for (let i = 0; i < DEDUP_EXISTING_LIMIT + 2; i++) {
    await createCandidate(db, { scopeType: 'global', scopeId: null, title: `c${i}`, bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  }
  const rows = await listForDedupByScope(db, { scopeType: 'global', scopeId: null })
  const approved = rows.filter((r) => r.status === 'approved')
  const candidates = rows.filter((r) => r.status === 'candidate')
  expect(approved.length).toBe(3)
  expect(candidates.length).toBe(DEDUP_EXISTING_LIMIT)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/store-crud.test.ts`
Expected: FAIL（`listForDedupByScope` / `DEDUP_EXISTING_LIMIT` 未导出）。

- [ ] **Step 3: 改 store.ts**

在 `src/memory/store.ts` 顶部 import 行 `import { and, desc, eq, inArray } from 'drizzle-orm'` 改为：

```ts
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
```

在 import 区（`import {` 块结束 `} from './pure'` 之后）加：

```ts
import type { ExistingMemoryForDedup } from './dedup'
```

在 `listApprovedByScope` 函数之后（`export { canTransition }` 之前）插入：

```ts
export const DEDUP_EXISTING_LIMIT = 50

/**
 * Load same-scope candidate + approved memories for dedup comparison. project =
 * exact scopeId match; global = scopeId IS NULL. Returns approved (all) + candidate
 * (createdAt DESC LIMIT DEDUP_EXISTING_LIMIT), de-duped by id, projecting only
 * {id,title,scopeType,scopeId,status} (no body/runtime, to keep the dedup prompt
 * small). Other statuses (archived/rejected/superseded) excluded.
 */
export async function listForDedupByScope(
  db: DbClient,
  opts: { scopeType: MemoryScope; scopeId: string | null },
): Promise<ExistingMemoryForDedup[]> {
  const scopeClause = opts.scopeId === null ? isNull(memories.scopeId) : eq(memories.scopeId, opts.scopeId)
  const cols = { id: memories.id, title: memories.title, scopeType: memories.scopeType, scopeId: memories.scopeId, status: memories.status }
  const approvedRows = await db.select(cols).from(memories).where(
    and(eq(memories.scopeType, opts.scopeType), scopeClause, eq(memories.status, 'approved')),
  ).orderBy(desc(memories.createdAt)).all()
  const candidateRows = await db.select(cols).from(memories).where(
    and(eq(memories.scopeType, opts.scopeType), scopeClause, eq(memories.status, 'candidate')),
  ).orderBy(desc(memories.createdAt)).limit(DEDUP_EXISTING_LIMIT).all()
  const seen = new Set<string>()
  const out: ExistingMemoryForDedup[] = []
  for (const r of [...approvedRows, ...candidateRows]) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    out.push({ id: r.id, title: r.title, scopeType: r.scopeType as MemoryScope, scopeId: r.scopeId, status: r.status as MemoryStatus })
  }
  return out
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/store-crud.test.ts`
Expected: PASS（含 4 个新测试 + 原有测试仍绿）。

- [ ] **Step 5: Commit**

```bash
git add src/memory/store.ts tests/store-crud.test.ts
git commit -m "feat(store): listForDedupByScope returns same-scope candidate+approved for dedup" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: scheduler.tick 集成 dedup 过滤

**Files:**
- Modify: `src/scheduler.ts`
- Test: `tests/scheduler.test.ts`

**Interfaces:**
- Consumes: `judgeDuplicates`（Task 1）、`listForDedupByScope`（Task 2）、`deps.callAnthropic`（已注入）、`db`（tick 参数）。`TickDeps` 不变。
- Produces: `tick` 在 distill 后按 scope 分组 dedup 过滤，仅对 `duplicate:false` 的调 `createCandidate`（入参不变）。

- [ ] **Step 1: 写失败测试**

在 `tests/scheduler.test.ts` 顶部 import 行 `import { enqueueDistillJob, tick, DISTILL_DEBOUNCE_MS } from '@/scheduler'` 之后加：

```ts
import { createCandidate as realCreateCandidate } from '@/memory/store'
```

把 `import { memoryDistillJobs } from '@/db/schema'` 改为：

```ts
import { memoryDistillJobs, memories } from '@/db/schema'
```

在文件末尾追加：

```ts
test('tick filters duplicate candidates (dedup marks duplicate, not persisted)', async () => {
  const ex = await realCreateCandidate(db, { scopeType: 'project', scopeId: '/r', title: '[category:invariant] refund within 14 days', bodyMd: '14d', tags: [], sourceKind: 'manual', runtime: null, sourceCwd: '/r' })
  await db.update(memories).set({ status: 'approved' }).where(eq(memories.id, ex.id)).run()
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let createCalls = 0
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => [{ role: 'user', content: 'refund 14 days' }],
    callAnthropic: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:process] 14天退款', bodyMd: '14d', scope: 'project', runtime: null, distillAction: 'new' }] })
      return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: true, duplicateOfId: ex.id }] })
    },
    createCandidate: async () => { createCalls++; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(createCalls).toBe(0)
})

test('tick keeps all candidates when dedup LLM throws (conservative, job still done)', async () => {
  const ex = await realCreateCandidate(db, { scopeType: 'project', scopeId: '/r', title: 'existing', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null, sourceCwd: '/r' })
  await db.update(memories).set({ status: 'approved' }).where(eq(memories.id, ex.id)).run()
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let createCalls = 0
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => [{ role: 'user', content: 'x' }],
    callAnthropic: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:x] new', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
      throw new Error('dedup api down')
    },
    createCandidate: async () => { createCalls++; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(createCalls).toBe(1)
  const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(rows[0]!.status).toBe('done')
})

test('tick skips dedup LLM when no existing memories in scope', async () => {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let callCount = 0
  let createCalls = 0
  await tick(db, {
    loadTranscript: async () => [{ role: 'user', content: 'x' }],
    callAnthropic: async () => { callCount++; return JSON.stringify({ candidates: [{ title: '[category:x] new', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] }) },
    createCandidate: async () => { createCalls++; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(callCount).toBe(1)
  expect(createCalls).toBe(1)
})

test('tick keeps sourceCwd/distillAction in createCandidate input after dedup', async () => {
  const ex = await realCreateCandidate(db, { scopeType: 'project', scopeId: '/r', title: 'existing', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null, sourceCwd: '/r' })
  await db.update(memories).set({ status: 'approved' }).where(eq(memories.id, ex.id)).run()
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let captured: any = null
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => [{ role: 'user', content: 'x' }],
    callAnthropic: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:x] new', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
      return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] })
    },
    createCandidate: async (_db, input) => { captured = input; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(captured.sourceCwd).toBe('/r')
  expect(captured.distillAction).toBe('new')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/scheduler.test.ts`
Expected: 第 1 个测试 FAIL（`createCalls` 为 1 而非 0--当前 tick 无 dedup，候选直接落库）；其余测试当前可能恰好通过（无 dedup 时 callCount=1、createCalls=1、job done、sourceCwd 透传）。第 1 个测试是红的驱动测试。

- [ ] **Step 3: 改 scheduler.ts**

在 `src/scheduler.ts` 顶部 import 区，`import { distillTranscript, type DistillCandidate } from '@/memory/distiller'` 之后加：

```ts
import { listForDedupByScope } from '@/memory/store'
import { judgeDuplicates } from '@/memory/dedup'
```

在 `tick` 函数之前（`startMemoryDistillLoop` 之前、`TickDeps` 之后）插入 helper：

```ts
/**
 * Filter semantic duplicates out of a distill batch. Groups candidates by
 * (scopeType, scopeId) - scopeId derived the same way createCandidate does
 * (project -> jobCwd, global -> null) - and for each group asks judgeDuplicates
 * to compare against same-scope existing memories. Returns the subset to keep.
 *
 * judgeDuplicates handles its own LLM-error fallback (all-new), so this never
 * throws on dedup failure. listForDedupByScope DB errors DO bubble to tick's
 * catch (infrastructure fault -> job retry), per spec §8.
 */
async function dedupCandidates(
  db: DbClient,
  callAnthropic: TickDeps['callAnthropic'],
  candidates: DistillCandidate[],
  jobCwd: string | null,
): Promise<DistillCandidate[]> {
  if (candidates.length === 0) return []
  const groups = new Map<string, { scopeType: DistillCandidate['scopeType']; scopeId: string | null; items: { c: DistillCandidate; globalIndex: number }[] }>()
  candidates.forEach((c, i) => {
    const scopeId = c.scopeType === 'project' ? (jobCwd ?? 'unknown') : null
    const key = `${c.scopeType}:${scopeId ?? ''}`
    if (!groups.has(key)) groups.set(key, { scopeType: c.scopeType, scopeId, items: [] })
    groups.get(key)!.items.push({ c, globalIndex: i })
  })
  const keepFlags = new Array(candidates.length).fill(false)
  for (const g of groups.values()) {
    const existing = await listForDedupByScope(db, { scopeType: g.scopeType, scopeId: g.scopeId })
    const verdicts = await judgeDuplicates({
      newCandidates: g.items.map((it) => it.c),
      existing,
      callAnthropic,
    })
    for (const v of verdicts) {
      if (!v.duplicate) keepFlags[g.items[v.index]!.globalIndex] = true
    }
  }
  return candidates.filter((_, i) => keepFlags[i])
}
```

把 `tick` 里的 distill + createCandidate 段：

```ts
      const candidates: DistillCandidate[] = await distillTranscript({
        turns,
        runtime: job.runtime as 'claude-code' | 'opencode',
        cwd: job.cwd ?? '',
        callAnthropic: deps.callAnthropic,
      })
      for (const c of candidates) {
        await deps.createCandidate(db, {
```

替换为：

```ts
      const candidates: DistillCandidate[] = await distillTranscript({
        turns,
        runtime: job.runtime as 'claude-code' | 'opencode',
        cwd: job.cwd ?? '',
        callAnthropic: deps.callAnthropic,
      })
      // Dedup: filter semantic duplicates against same-scope existing memories
      // (candidate + approved) before persisting. judgeDuplicates swallows LLM /
      // parse errors conservatively (all-new), so dedup failure never blocks
      // distill nor backs off the job. listForDedupByScope DB errors DO bubble
      // to the catch below (infrastructure fault -> retry), per spec §8.
      const keep = await dedupCandidates(db, deps.callAnthropic, candidates, job.cwd ?? null)
      for (const c of keep) {
        await deps.createCandidate(db, {
```

（`createCandidate` 入参对象完全不变，只把 `for (const c of candidates)` 改成 `for (const c of keep)`，并在前面插入 `const keep = await dedupCandidates(...)`。）

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/scheduler.test.ts`
Expected: PASS（含 4 个新测试 + 原有 5 个测试仍绿）。

- [ ] **Step 5: Commit**

```bash
git add src/scheduler.ts tests/scheduler.test.ts
git commit -m "feat(scheduler): tick dedups candidates against same-scope existing before persist" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 收尾：全量验证 + push + PR

- [ ] **Step 1: 最终门禁**

Run: `bun run typecheck && bun test`
Expected: typecheck 干净；全部测试绿（含原有 100+ 与 Task 1-3 新增测试）。

- [ ] **Step 2: 推远端 + 开 PR**

```bash
git push -u origin feat/candidate-dedup
gh pr create --base master --title "feat: 候选记忆语义去重（distill 后二次 LLM 判定）" --body "..."
```

PR body 摘要：dedup 为 distill 之上的独立判定层（`src/memory/dedup.ts` 纯函数 + 注入 callAnthropic）；store 新增 `listForDedupByScope`（同 scope approved 全量 + candidate 最近 50）；scheduler.tick 按 scope 分组调 dedup 过滤，duplicate 丢弃、new 入库；失败保守放行（全 new），零 schema 变更，store/distiller/注入路径不变。详见 `docs/superpowers/specs/2026-07-23-candidate-dedup-design.md`。

---

## Self-Review（写计划后自检）

**1. Spec 覆盖：**
- G1（同 scope 语义去重，duplicate 不入库）-> Task 1（judgeDuplicates）+ Task 2（listForDedupByScope）+ Task 3（tick 过滤）。✅
- G2（失败保守放行、不阻断）-> Task 1 catch/缺字段/幻觉全 new + Task 3 测试"dedup 抛错仍 done"。✅
- G3（独立纯函数模块、store 不变）-> Task 1 dedup.ts + Task 3 store.createCandidate 不变。✅
- G4（零 schema 变更）-> 全计划无 DDL/迁移。✅
- §5.1 接口（judgeDuplicates/DedupInput/DedupVerdict/ExistingMemoryForDedup/DEDUP_SYSTEM_PROMPT）-> Task 1。✅
- §5.2 listForDedupByScope（approved 全量 + candidate LIMIT 50、不含 runtime/body）-> Task 2。✅
- §5.3 tick 分组 + keep 过滤、TickDeps 不变、createCandidate 入参不变 -> Task 3。✅
- §5.4 零 schema 变更 -> 全计划。✅
- §5.5 daemon 无改动 -> 全计划未触 daemon.ts。✅
- §8 失败模式（抛错/非 JSON/缺字段/缺 index/幻觉/existing 空/new 空）-> Task 1 测试全覆盖。✅
- §9 测试策略（dedup.test.ts / scheduler.test.ts / store-crud.test.ts）-> Task 1/2/3。✅

**2. 占位扫描：** 无 TBD/TODO；每步含完整代码或确切命令。✅

**3. 类型一致性：** `ExistingMemoryForDedup` 在 Task 1（dedup.ts）定义、Task 2（store.ts）type-only import、Task 3 经 `listForDedupByScope` 返回值流入 `judgeDuplicates` 入参，签名一致。`judgeDuplicates` / `listForDedupByScope` / `DEDUP_EXISTING_LIMIT` / `dedupCandidates` 命名跨任务一致。`DedupVerdict.index` 在 Task 1（newCandidates 下标）与 Task 3（组内下标 -> globalIndex 映射）语义一致。`callAnthropic(system, user): Promise<string>` 与 `makeCallAnthropic` 产出及 distiller 消费的 seam 一致。✅
