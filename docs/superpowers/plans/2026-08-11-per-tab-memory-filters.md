# 记忆列表筛选按 tab 圈定 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把四个记忆 tab 的筛选下拉选项与筛选状态从「全局共享」改为「按 tab 圈定 + 各 tab 独立」，修复 PR #56 上线后用户反馈的「所有 tab 的筛选全是候选审批这一个 tab 的」。

**Architecture:** `listFacets(db, scope)` 接受按 tab 的统计范围（memories 指定 statuses / discards 单表）；`GET /api/facets?tab=` 暴露四种范围（tab→statuses 映射与列表查询的 `memoryTabFilter` 一致）；前端筛选 state 与 facets 缓存都按 tab 一份，`changeFilter` 只作废当前 tab 缓存。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite（store/server）；React 19（web）；测试 bun:test。

## Global Constraints

- 本仓库测试一律用 `bun test` 运行，**严禁 npm test**。
- 无 schema 迁移、无新依赖；注入链路 / distiller / scheduler / 状态机零改动。
- facets 的 tab→statuses 映射必须与 `src/web/tab-cache.ts` `memoryTabFilter` 一致：
  candidate→`candidate`；approved→`approved,archived,superseded`；rejected→`rejected`。
- `unevaluated` 哨兵（store `VALUE_CLASS_UNEVALUATED` / web `UNEVALUATED`，同值 `'unevaluated'`）语义不变（严格 IS NULL）。
- UI 不得静默 stall：facets 未加载成功 → 下拉禁用 + 灰字提示。
- 排序规则不变：count 降序、同 count 按 value 字母序、截 `FACET_LIST_CAP`(200)。
- commit message 用中文，按各 task 给定的内容。

---

### Task 1: store + server —— listFacets scope 化 + /api/facets?tab=

**Files:**
- Rewrite: `tests/store-facets.test.ts`
- Modify: `src/memory/store.ts`（904-964 行的 facets 块）
- Modify: `src/server.ts`（11 行 import；672 行路由）
- Modify: `tests/server.test.ts`（1076-1084 行旧 facets 测试替换 + 新 helper）

**Interfaces:**
- Consumes: 既有 `sortFacets` / `categoryFromTitle` / `VALUE_CLASS_UNEVALUATED` / `FACET_LIST_CAP`（store.ts）；`seedMemFull`（server.test.ts:1007）、`memoryDistillJobs` / `memoryDiscards` 直插模式（`seedDiscardRow`，server.test.ts:577）。
- Produces: `FacetScope` 类型 + `listFacets(db, scope)`；`GET /api/facets?tab=`。Task 2 的 web client 消费该端点。

**为什么 store+server 同任务**：`listFacets` 签名变更后 server.ts 调用点必须同步改，否则 typecheck 红——一个红绿单元。

- [ ] **Step 1: 重写 tests/store-facets.test.ts（整文件替换）**

```ts
import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { memories, memoryDistillJobs } from '@/db/schema'
import { createCandidate, logDiscards, listFacets, VALUE_CLASS_UNEVALUATED, FACET_LIST_CAP, type FacetScope } from '@/memory/store'

// 回归锁定：listFacets 按 tab scope 统计（spec 2026-08-11-per-tab-memory-filters §4.1）。
// 推翻 2026-08-11-web-memory-filters 的全局口径（两表 UNION）：memories scope 只数
// 给定 statuses 的行；discards scope 只查 memory_discards（slugs/valueClasses 恒空）。
const root = join(import.meta.dir, '.tmp-store-facets')
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

const CANDIDATE: FacetScope = { kind: 'memories', statuses: ['candidate'] }
const APPROVED: FacetScope = { kind: 'memories', statuses: ['approved', 'archived', 'superseded'] }
const REJECTED: FacetScope = { kind: 'memories', statuses: ['rejected'] }
const DISCARDS: FacetScope = { kind: 'discards' }

async function seedMem(title: string, opts: { sourceCwd?: string | null; slug?: string | null; valueClass?: 'decision' | 'trap' | null; status?: 'candidate' | 'approved' | 'rejected' } = {}) {
  const m = await createCandidate(db, {
    scopeType: 'global', scopeId: null, title, bodyMd: 'b',
    tags: [], sourceKind: 'manual', runtime: null,
    sourceCwd: opts.sourceCwd ?? null, subjectSlug: opts.slug ?? null,
    valueClass: opts.valueClass ?? null,
  })
  if (opts.status && opts.status !== 'candidate') {
    await db.update(memories).set({ status: opts.status }).where(eq(memories.id, m.id))
  }
  return m
}

function seedDiscardJob() {
  db.insert(memoryDistillJobs).values({
    id: 'job-f', debounceKey: 'k', sourceEventId: 's', runtime: 'claude-code',
    cwd: '/r', status: 'done', attempts: 0, nextRunAt: 0, createdAt: 0,
  }).run()
}

test('memories scope: projects 只数 scope statuses 内的行（混播状态互相隔离）', async () => {
  await seedMem('[category:trap] A', { sourceCwd: 'C:/p/a' })
  await seedMem('[category:trap] B', { sourceCwd: 'C:/p/a', status: 'rejected' })
  await seedMem('[category:trap] C', { sourceCwd: 'C:/p/b', status: 'rejected' })
  await seedMem('[category:trap] D', { sourceCwd: null }) // NULL 不进选项
  expect((await listFacets(db, CANDIDATE)).projects).toEqual([{ value: 'C:/p/a', count: 1 }])
  expect((await listFacets(db, REJECTED)).projects).toEqual([
    { value: 'C:/p/a', count: 1 }, // 同 count 按 value 字母序
    { value: 'C:/p/b', count: 1 },
  ])
})

test('memories scope: approved scope 覆盖 approved/archived/superseded 三态', async () => {
  await seedMem('[category:trap] A', { sourceCwd: 'C:/p/a', status: 'approved' })
  const b = await seedMem('[category:trap] B', { sourceCwd: 'C:/p/a' })
  await db.update(memories).set({ status: 'archived' }).where(eq(memories.id, b.id))
  await seedMem('[category:trap] C', { sourceCwd: 'C:/p/a' }) // candidate，不应出现
  expect((await listFacets(db, APPROVED)).projects).toEqual([{ value: 'C:/p/a', count: 2 }])
})

test('memories scope: categories/slugs/valueClasses 同样按 scope（未评估桶只数 scope 内 NULL）', async () => {
  await seedMem('[category:invariant] X', { slug: 'refund-policy', valueClass: 'decision' })
  await seedMem('[category:invariant] Y', { slug: 'refund-policy', valueClass: null, status: 'rejected' })
  await seedMem('[category:test-pattern] Z', { slug: 'a-b', valueClass: null, status: 'rejected' })
  const f = await listFacets(db, CANDIDATE)
  expect(f.categories).toEqual([{ value: 'invariant', count: 1 }])
  expect(f.slugs).toEqual([{ value: 'refund-policy', count: 1 }])
  expect(f.valueClasses).toEqual([{ value: 'decision', count: 1 }])
  const r = await listFacets(db, REJECTED)
  expect(r.categories).toEqual([
    { value: 'invariant', count: 1 },    // 同 count 按 value 字母序
    { value: 'test-pattern', count: 1 },
  ])
  expect(r.slugs).toEqual([
    { value: 'a-b', count: 1 },            // 同 count 按 value 字母序：a-b < refund-policy
    { value: 'refund-policy', count: 1 },
  ])
  expect(r.valueClasses).toEqual([{ value: VALUE_CLASS_UNEVALUATED, count: 2 }])
})

test('discards scope: 只查 memory_discards，slugs/valueClasses 恒空；memories scope 不含 discard 行', async () => {
  await seedMem('[category:trap] A', { sourceCwd: 'C:/p/mem-only', slug: 's1', valueClass: 'decision' })
  seedDiscardJob()
  await logDiscards(db, 'job-f', [
    { title: '[category:trap] C', bodyMd: 'b', reason: 'fleeting' as const, scopeType: 'project' as const, scopeId: 'C:/p/d', sourceCwd: 'C:/p/d', runtime: null, sourceKind: 'conversation' as const },
    { title: '[category:trap] D', bodyMd: 'b', reason: 'fleeting' as const, scopeType: 'project' as const, scopeId: 'C:/p/d', sourceCwd: 'C:/p/d', runtime: null, sourceKind: 'conversation' as const },
  ])
  const f = await listFacets(db, DISCARDS)
  expect(f.projects).toEqual([{ value: 'C:/p/d', count: 2 }])
  expect(f.categories).toEqual([{ value: 'trap', count: 2 }])
  expect(f.slugs).toEqual([])
  expect(f.valueClasses).toEqual([])
  expect((await listFacets(db, CANDIDATE)).projects).toEqual([{ value: 'C:/p/mem-only', count: 1 }])
})

test('空表 -> 四个空数组（任何 scope）', async () => {
  expect(await listFacets(db, CANDIDATE)).toEqual({ projects: [], categories: [], slugs: [], valueClasses: [] })
  expect(await listFacets(db, DISCARDS)).toEqual({ projects: [], categories: [], slugs: [], valueClasses: [] })
})

// 回归锁定（spec web-memory-filters §4.1 + per-tab spec §2 G3）：
// FACET_LIST_CAP（200）截断在 scope 化后仍必须成立。
test('slugs 截断到 FACET_LIST_CAP（201 个不同 slug -> 200）', async () => {
  for (let i = 0; i < 201; i++) {
    await seedMem('[category:trap] s' + i, { slug: 'slug-' + i })
  }
  const f = await listFacets(db, CANDIDATE)
  expect(f.slugs.length).toBe(FACET_LIST_CAP)
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/store-facets.test.ts`
Expected: FAIL——`listFacets(db, CANDIDATE)` 签名不符（现实现只收 db）。

- [ ] **Step 3: 改 src/memory/store.ts——整块替换 904-964 行**

从 `// ---------------------------------------------------------------------------`（904 行，「四维筛选下拉选项」注释块头）到 `listFacets` 函数结束（964 行），整块替换为：

```ts
// ---------------------------------------------------------------------------
// 四维筛选下拉选项，按 tab scope（spec 2026-08-11-per-tab-memory-filters §4.1）
// ---------------------------------------------------------------------------

export interface FacetValue { value: string; count: number }
export interface Facets {
  projects: FacetValue[]
  categories: FacetValue[]
  slugs: FacetValue[]
  valueClasses: FacetValue[]
}
export const FACET_LIST_CAP = 200

/**
 * facets 统计范围：kind='memories' 只统计给定 statuses 的行；kind='discards'
 * 只查 memory_discards 表（该表无 slug/value_class 列，两组返回空）。
 * 推翻 2026-08-11-web-memory-filters 决策 D2 的全局口径（两表 UNION）：
 * 每个 tab 的下拉只列本 tab 数据里真实存在的值。
 */
export type FacetScope =
  | { kind: 'memories'; statuses: MemoryStatus[] }
  | { kind: 'discards' }

function sortFacets(m: Map<string, number>): FacetValue[] {
  return [...m.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
    .slice(0, FACET_LIST_CAP)
}

/**
 * 四维筛选的下拉选项（按 scope）：value_class NULL 聚成 VALUE_CLASS_UNEVALUATED 桶；
 * 各组 count 降序、同 count 按 value 字母序，截 FACET_LIST_CAP。
 * 调用方保证 memories scope 的 statuses 非空（server 层校验非法/缺失 tab -> 400）。
 */
export async function listFacets(db: DbClient, scope: FacetScope): Promise<Facets> {
  const bump = (m: Map<string, number>, v: string, n: number) => m.set(v, (m.get(v) ?? 0) + n)

  if (scope.kind === 'discards') {
    const projects = new Map<string, number>()
    const disProj = await db.select({ v: memoryDiscards.sourceCwd, n: sql<number>`COUNT(*)` })
      .from(memoryDiscards).where(isNotNull(memoryDiscards.sourceCwd)).groupBy(memoryDiscards.sourceCwd).all()
    for (const r of disProj) if (r.v) bump(projects, r.v, Number(r.n))
    const cats = new Map<string, number>()
    const disTitles = await db.select({ t: memoryDiscards.title }).from(memoryDiscards).all()
    for (const r of disTitles) {
      const c = categoryFromTitle(r.t)
      if (c) bump(cats, c, 1)
    }
    return { projects: sortFacets(projects), categories: sortFacets(cats), slugs: [], valueClasses: [] }
  }

  const statusCond = inArray(memories.status, scope.statuses)
  const projects = new Map<string, number>()
  const memProj = await db.select({ v: memories.sourceCwd, n: sql<number>`COUNT(*)` })
    .from(memories).where(and(isNotNull(memories.sourceCwd), statusCond)).groupBy(memories.sourceCwd).all()
  for (const r of memProj) if (r.v) bump(projects, r.v, Number(r.n))

  const cats = new Map<string, number>()
  const memTitles = await db.select({ t: memories.title }).from(memories).where(statusCond).all()
  for (const r of memTitles) {
    const c = categoryFromTitle(r.t)
    if (c) bump(cats, c, 1)
  }

  const slugs = new Map<string, number>()
  const slugRows = await db.select({ v: memories.subjectSlug, n: sql<number>`COUNT(*)` })
    .from(memories).where(and(isNotNull(memories.subjectSlug), statusCond)).groupBy(memories.subjectSlug).all()
  for (const r of slugRows) if (r.v) bump(slugs, r.v, Number(r.n))

  const vcs = new Map<string, number>()
  const vcRows = await db.select({ v: memories.valueClass, n: sql<number>`COUNT(*)` })
    .from(memories).where(statusCond).groupBy(memories.valueClass).all()
  for (const r of vcRows) bump(vcs, r.v ?? VALUE_CLASS_UNEVALUATED, Number(r.n))

  return {
    projects: sortFacets(projects),
    categories: sortFacets(cats),
    slugs: sortFacets(slugs),
    valueClasses: sortFacets(vcs),
  }
}
```

`sql` / `and` / `inArray` / `isNotNull` / `MemoryStatus` / `categoryFromTitle` / `memoryDiscards` 均已在 store.ts 现有 import 中（旧 listFacets 与 listMemoriesPage 已用），无需新增。

- [ ] **Step 4: 改 src/server.ts**

4a. 第 11 行 store import 末尾追加 `, type FacetScope`（加在 `type MemoryListFilter` 之后）。

4b. 672 行路由整行替换：

旧：
```ts
  app.get('/api/facets', async (c) => c.json(await listFacets(deps.db)))
```

新：
```ts
  // 四维筛选下拉选项按 tab 圈定（spec 2026-08-11-per-tab-memory-filters §4.2）。
  // tab→statuses 映射与 web memoryTabFilter 一致：保证下拉选到的值在本 tab 列表必命中。
  // 缺失/非法 tab -> 400（client catch -> null -> 灰字降级，不崩）。
  const FACET_TAB_SCOPES: Record<string, FacetScope> = {
    candidate: { kind: 'memories', statuses: ['candidate'] },
    approved: { kind: 'memories', statuses: ['approved', 'archived', 'superseded'] },
    rejected: { kind: 'memories', statuses: ['rejected'] },
    discards: { kind: 'discards' },
  }
  app.get('/api/facets', async (c) => {
    const scope = FACET_TAB_SCOPES[c.req.query('tab') ?? '']
    if (!scope) return c.json({ error: 'invalid tab' }, 400)
    return c.json(await listFacets(deps.db, scope))
  })
```

- [ ] **Step 5: 改 tests/server.test.ts——替换 1076-1084 行旧 facets 测试**

旧测试（`test('GET /api/facets 形状 + 数据驱动', …)`）整体替换为下面的 helper + 三个测试：

```ts
async function seedDiscardRowForFacets(id: string, title: string, sourceCwd: string) {
  const now = Date.now()
  await db.insert(memoryDistillJobs).values({
    id: `job-${id}`, debounceKey: 'k', sourceEventId: 'e', runtime: 'claude-code',
    cwd: '/p', sessionId: null, sourceAgentId: null, scopeResolvedJson: null,
    status: 'done', attempts: 0, nextRunAt: now, lastError: null, createdAt: now, finishedAt: now,
  })
  await db.insert(memoryDiscards).values({
    id, distillJobId: `job-${id}`, title, bodyMd: 'db', reason: 'public-knowledge', ts: now,
    scopeType: 'project', scopeId: sourceCwd,
    sourceCwd, runtime: 'claude-code', sourceKind: 'conversation',
    promotedMemoryId: null,
  })
}

test('GET /api/facets?tab= 按 tab 圈定统计（混播状态互相隔离）', async () => {
  await seedMemFull({ ts: 1000, sourceCwd: 'C:/p/a', slug: 's1', valueClass: 'decision' })
  await seedMemFull({ ts: 2000, sourceCwd: 'C:/p/a', slug: 's2', valueClass: null, status: 'rejected' })
  const cand = await req('/api/facets?tab=candidate')
  expect(cand.status).toBe(200)
  expect(cand.body.projects).toEqual([{ value: 'C:/p/a', count: 1 }])
  expect(cand.body.slugs).toEqual([{ value: 's1', count: 1 }])
  expect(cand.body.categories).toEqual([{ value: 'convention', count: 1 }])
  expect(cand.body.valueClasses).toEqual([{ value: 'decision', count: 1 }])
  const rej = await req('/api/facets?tab=rejected')
  expect(rej.body.projects).toEqual([{ value: 'C:/p/a', count: 1 }])
  expect(rej.body.slugs).toEqual([{ value: 's2', count: 1 }])
  expect(rej.body.valueClasses).toEqual([{ value: 'unevaluated', count: 1 }])
})

test('GET /api/facets?tab=discards 只查 discards 表，memories scope 不含 discard 行', async () => {
  await seedMemFull({ ts: 1000, sourceCwd: 'C:/p/mem', slug: 's1', valueClass: 'decision' })
  await seedDiscardRowForFacets('df1', '[category:trap] D1', 'C:/p/dis')
  await seedDiscardRowForFacets('df2', '[category:trap] D2', 'C:/p/dis')
  const r = await req('/api/facets?tab=discards')
  expect(r.status).toBe(200)
  expect(r.body.projects).toEqual([{ value: 'C:/p/dis', count: 2 }])
  expect(r.body.categories).toEqual([{ value: 'trap', count: 2 }])
  expect(r.body.slugs).toEqual([])
  expect(r.body.valueClasses).toEqual([])
  const cand = await req('/api/facets?tab=candidate')
  expect(cand.body.projects).toEqual([{ value: 'C:/p/mem', count: 1 }])
})

test('GET /api/facets 缺失/非法 tab -> 400', async () => {
  expect((await req('/api/facets')).status).toBe(400)
  expect((await req('/api/facets?tab=runs')).status).toBe(400)
})
```

注意：`seedMemFull` 默认 title `[category:convention] t-<ts>`，故 candidate scope categories 断言 `convention`。`memoryDistillJobs` / `memoryDiscards` 已在 server.test.ts 第 10 行 import。

- [ ] **Step 6: 确认绿**

Run: `bun test tests/store-facets.test.ts tests/server.test.ts`
Expected: PASS。

- [ ] **Step 7: 全量门槛**

Run: `bun run typecheck && bun test`
Expected: 全绿（web 侧尚未改，getFacets 旧调用不受影响——本 task 不动 api.ts/App.tsx）。

- [ ] **Step 8: 提交**

```bash
git add tests/store-facets.test.ts src/memory/store.ts src/server.ts tests/server.test.ts
git commit -m "feat(facets): listFacets + /api/facets 按 tab scope 圈定（废除全局口径）"
```

---

### Task 2: web api client + App.tsx —— 按 tab 的 facets 与独立筛选态

**Files:**
- Modify: `src/web/api.ts`（getFacets，约 291-295 行）
- Modify: `src/web/App.tsx`（import、TabKey 后、state 块 73-77、refresh 两处、filterRef 注释、changeFilter、筛选条 JSX 门控）
- Modify: `tests/web-api.test.ts`（getFacets 测试，约 336-347 行）
- Modify: `tests/web-ui.test.ts`（筛选接线测试，约 362-380 行）

**Interfaces:**
- Consumes: Task 1 的 `GET /api/facets?tab=candidate|approved|rejected|discards`。
- Produces: 完整 UI 行为——每 tab 独立筛选态 + 每 tab facets 缓存 + 收窄的缓存作废。

**为什么 api+App 同任务**：`getFacets` 加必填 tab 参数后 App.tsx 调用点必须同步改，否则 typecheck 红。

- [ ] **Step 1: 改 tests/web-api.test.ts——替换 getFacets 测试**

旧测试（`test('getFacets: GET /api/facets 解析形状', …)`，约 336-347 行）整体替换为：

```ts
test('getFacets: GET /api/facets?tab= 按 tab 圈定', async () => {
  let called = ''
  const fetchFn = (async (url: string) => {
    called = url
    return new Response(JSON.stringify({
      projects: [{ value: 'C:/x', count: 2 }], categories: [], slugs: [], valueClasses: [],
    }), { status: 200 })
  }) as any
  const f = await getFacets(fetchFn, 'approved')
  expect(called).toBe('/api/facets?tab=approved')
  expect(f.projects[0]).toEqual({ value: 'C:/x', count: 2 })
})
```

- [ ] **Step 2: 改 tests/web-ui.test.ts——替换筛选接线测试**

旧测试（`test('App.tsx wires memory list filters (source text)', …)` 及其上方注释，约 362-380 行）整体替换为：

```ts
// 2026-08-11 四维筛选按 tab 圈定（spec per-tab-memory-filters §4.4）：per-tab 独立
// 筛选态 + per-tab facets 缓存 + 收窄缓存作废 + filterRef 防轮换闭包 + 筛选态空态/计数。
// React 组件不单测，源码文本断言锁接线锚点，refactor 删除即变红。
// 注意：web-memory-filters 时代的「四缓存全作废」锚点（setMemCache({candidate:…,
// approved:…, rejected:…})）本轮**有意移除**——per-tab 独立态下其余 tab 缓存对应
// 各自筛选，changeFilter 只作废当前 tab（spec per-tab §4.4-4），不要当回归改回去。
test('App.tsx wires per-tab memory list filters (source text)', () => {
  expect(src).toContain('清除筛选')
  expect(src).toContain('没有符合当前筛选的记录')
  expect(src).toContain('符合当前筛选')
  expect(src).toContain('筛选选项加载失败')
  expect(src).toContain('filterRef')
  expect(src).toContain('hasActiveFilter')
  expect(src).toContain('getFacets')
  expect(src).toContain('projectDisplayName')
  expect(src).toContain('FilterSelect')
  // per-tab 独立筛选态 + per-tab facets 缓存（推翻跨 tab 共享）
  expect(src).toContain('Record<FacetTab, MemoryFilter>')
  expect(src).toContain('facetsByTab')
  expect(src).toContain('isFilterTab')
  // 缓存作废收窄到当前 tab（spec per-tab §4.4-4 / 失败模式 F2）：改筛选只清本 tab，
  // 其余 tab 缓存对应各自筛选不受影响。refactor 改回全量作废或漏清当前 tab 即红。
  expect(src).toContain('setMemCache((c) => ({ ...c, [tab]: emptyPage() }))')
  expect(src).toContain('setDiscards(emptyPage())')
})
```

- [ ] **Step 3: 跑测试确认红**

Run: `bun test tests/web-api.test.ts tests/web-ui.test.ts`
Expected: FAIL——getFacets 签名未改、App.tsx 无 per-tab 锚点。

- [ ] **Step 4: 改 src/web/api.ts——替换 getFacets 块（约 291-295 行）**

旧：
```ts
/** GET /api/facets — 四维筛选下拉选项（全局口径，随 3s 轮询刷新）。 */
export async function getFacets(fetchFn: FetchLike = fetch): Promise<Facets> {
  const res = await fetchFn('/api/facets')
  return (await res.json()) as Facets
}
```

新：
```ts
/** 带筛选下拉的四个 tab；GET /api/facets?tab= 的参数（spec per-tab-memory-filters §4.3）。 */
export type FacetTab = 'candidate' | 'approved' | 'rejected' | 'discards'

/** GET /api/facets?tab= — 按 tab 圈定的下拉选项（随 3s 轮询刷新）。 */
export async function getFacets(fetchFn: FetchLike = fetch, tab: FacetTab): Promise<Facets> {
  const res = await fetchFn(`/api/facets?tab=${tab}`)
  return (await res.json()) as Facets
}
```

- [ ] **Step 5: 改 src/web/App.tsx（六处）**

5a. **import**（约 14 行）：type 导入行尾 `type Facets,` 改为 `type Facets, type FacetTab,`。

5b. **模块级**：`type TabKey = …` 声明之后追加：

```ts
/** 带筛选条的 tab 判定（spec 2026-08-11-per-tab-memory-filters §4.4）。 */
function isFilterTab(t: TabKey): t is FacetTab {
  return t === 'candidate' || t === 'approved' || t === 'rejected' || t === 'discards'
}
```

5c. **state 块**（73-77 行）整块替换：

旧：
```ts
  // 四维筛选（spec 2026-08-11-web-memory-filters §4.3）：跨 tab 共享单一 state；
  // 空串 = 不筛该维度。facets = /api/facets 下拉选项（null = 尚未加载成功）。
  const [filter, setFilter] = useState<MemoryFilter>(EMPTY_MEMORY_FILTER)
  const [facets, setFacets] = useState<Facets | null>(null)
  const filterRef = useRef<MemoryFilter>(filter)
```

新：
```ts
  // 四维筛选 per-tab 独立态（spec 2026-08-11-per-tab-memory-filters §4.4）：切 tab
  // 不携带筛选；空串 = 不筛该维度。facetsByTab = 每 tab 下拉选项缓存（SWR：切回
  // 立显本 tab 选项；undefined = 首访尚未加载成功）。filter/facets 是按当前 tab 的
  // 派生视图，JSX 标识符不变。
  const [filters, setFilters] = useState<Record<FacetTab, MemoryFilter>>({
    candidate: EMPTY_MEMORY_FILTER, approved: EMPTY_MEMORY_FILTER,
    rejected: EMPTY_MEMORY_FILTER, discards: EMPTY_MEMORY_FILTER,
  })
  const [facetsByTab, setFacetsByTab] = useState<Partial<Record<FacetTab, Facets>>>({})
  const filter = isFilterTab(tab) ? filters[tab] : EMPTY_MEMORY_FILTER
  const facets = isFilterTab(tab) ? facetsByTab[tab] ?? null : null
  const filterRef = useRef<MemoryFilter>(filter)
```

5d. **refresh 两处 facets 拉取与落库**：

discards 分支（约 97、101 行）：
```ts
          getFacets().catch(() => null), // facets 失败不拖垮列表刷新（spec 失败模式 F6）
```
→
```ts
          getFacets(fetch, target as FacetTab).catch(() => null), // facets 失败不拖垮列表刷新（spec 失败模式 F6）
```
```ts
        if (fc) setFacets(fc)
```
→
```ts
        if (fc) setFacetsByTab((m) => ({ ...m, [target as FacetTab]: fc }))
```

记忆 tab 分支（约 113、120 行）做**同样两处**替换（文本相同）。

5e. **changeFilter**（约 289-297 行，含上方注释）整块替换：

旧：
```ts
  // 筛选变化：四个记忆 tab 缓存全部作废（筛选跨 tab 共享；只清当前 tab 会让
  // mergeRefreshPage 把旧筛选条目当「掉出第一页的老数据」追加回来，spec 失败模式 F2），
  // 立即按新筛选重拉，不等下个 3s 轮询周期。
  function changeFilter(next: MemoryFilter) {
    setFilter(next)
    setMemCache({ candidate: emptyPage(), approved: emptyPage(), rejected: emptyPage() })
    setDiscards(emptyPage())
    void refresh(tab, next)
  }
```

新：
```ts
  // 筛选变化（per-tab 独立态，spec 2026-08-11-per-tab-memory-filters §4.4-4）：只作废
  // 当前 tab 缓存——其余 tab 缓存对应各自筛选，与本 tab 筛选变化无涉（推翻共享态
  // 时代的四缓存全作废）。仍须作废当前 tab：否则 mergeRefreshPage 把旧筛选条目当
  // 「掉出第一页的老数据」追加回来（spec 失败模式 F2）。立即按新筛选重拉，不等轮询。
  function changeFilter(next: MemoryFilter) {
    if (!isFilterTab(tab)) return
    setFilters((fs) => ({ ...fs, [tab]: next }))
    if (tab === 'discards') setDiscards(emptyPage())
    else setMemCache((c) => ({ ...c, [tab]: emptyPage() }))
    void refresh(tab, next)
  }
```

5f. **筛选条 JSX 门控**（约 435 行）：

旧：
```tsx
      {tab === 'candidate' || tab === 'approved' || tab === 'rejected' || tab === 'discards' ? (
```
新：
```tsx
      {isFilterTab(tab) ? (
```

filterRef 同步 effect（`useEffect(() => { filterRef.current = filter })`）**不改**——`filter` 已是派生当前 tab 的值。下拉选项 / 计数 / 空态 JSX 一律不改（读的都是派生 `filter` / `facets`）。

- [ ] **Step 6: 确认绿**

Run: `bun test tests/web-api.test.ts tests/web-ui.test.ts`
Expected: PASS。

- [ ] **Step 7: 全量门槛**

Run: `bun run typecheck && bun test`
Expected: 全绿。

- [ ] **Step 8: 提交**

```bash
git add src/web/api.ts src/web/App.tsx tests/web-api.test.ts tests/web-ui.test.ts
git commit -m "feat(web): 筛选与 facets 改为按 tab 独立（修复全局口径体验问题）"
```

---

### Task 3: 全量验证 + STATE.md + push + PR

**Files:**
- Modify: `STATE.md`（追加本节记录）

**Interfaces:**
- Consumes: Task 1-2 全部产出。
- Produces: 可合并的 PR。

- [ ] **Step 1: 全量门槛**

Run: `bun run typecheck && bun test`
Expected: 全绿（862 条既有测试按新签名更新后 + 新增全部通过；任何红 case 必须修复，不允许「重跑就过」）。

- [ ] **Step 2: STATE.md 追加章节**（文件末尾，风格对齐既有章节：背景一段 + 编号要点 + 执行方式 + 测试结果）

```markdown
## 记忆列表筛选按 tab 圈定（2026-08-11，修订 PR #56）

PR #56 上线后用户反馈：所有 tab 的筛选看起来都是候选审批 tab 的。根因是两个设计
决策——facets 全局口径（旧 spec 决策 D2）+ 筛选状态跨 tab 共享——在 live 数据极端
分布下（candidate 574 / approved 7 / rejected 2554 / discards 691）全面暴露：小 tab
下拉里全是本 tab 不存在的值、计数不属于本 tab、共享选择跨 tab 携带即空。设计
spec / 计划见 `docs/superpowers/specs|plans/2026-08-11-per-tab-memory-filters*`。

1. `listFacets(db, scope)`：scope = `{kind:'memories', statuses}` | `{kind:'discards'}`；
   废除两表 UNION 全局口径，每 tab 只数自己的数据；discards scope 的 slugs/
   valueClasses 恒空（表无对应列）。排序 / FACET_LIST_CAP / unevaluated 桶不变。
2. `GET /api/facets?tab=candidate|approved|rejected|discards`：tab→statuses 映射与
   `memoryTabFilter` 一致（approved 含 archived/superseded 三态）；缺失/非法 -> 400。
3. App.tsx：筛选态改 per-tab `Record<FacetTab, MemoryFilter>`（切 tab 不携带）；
   facets 按 tab 缓存 `facetsByTab`（SWR：切回立显，首访未载灰字禁用）；changeFilter
   收窄为只作废当前 tab 缓存（四缓存全作废是共享态配套，随共享态废除）；filterRef
   防轮换闭包模式不变。
4. 注入链路 / distiller / scheduler / 状态机零改动，无 schema 迁移。

执行：subagent-driven（实现 task 各 implementer + reviewer）。
`bun run typecheck && bun test` N/N 全绿。
```

（N/N 按实际数字填。）

- [ ] **Step 3: 提交并推送**

```bash
git add STATE.md
git commit -m "docs(state): 记忆列表筛选改按 tab 圈定"
git -c http.sslBackend=openssl push -u origin fix/per-tab-memory-filters
```

（注意 `-c` 在 `git` 后、`push` 前。）

- [ ] **Step 4: 开 PR**

```bash
gh pr create --base master --head fix/per-tab-memory-filters \
  --title "fix(web): 记忆列表筛选按 tab 圈定（选项 + 筛选态 per-tab）" \
  --body "spec: docs/superpowers/specs/2026-08-11-per-tab-memory-filters-design.md
plan: docs/superpowers/plans/2026-08-11-per-tab-memory-filters.md

修订 PR #56 的两个设计决策（用户实测反馈驱动）：
- facets 从全局口径改为按 tab 圈定：GET /api/facets?tab=…，每个 tab 的下拉
  只列本 tab 数据里真实存在的值（计数也按本 tab），tab→statuses 映射与
  memoryTabFilter 一致。
- 筛选状态从跨 tab 共享改为各 tab 独立（Record<FacetTab, MemoryFilter>），
  changeFilter 只作废当前 tab 缓存。
live 数据（candidate 574 / approved 7 / rejected 2554 / discards 691）下，
原全局选项在小 tab 里几乎全选不出东西。无 schema 迁移，注入链路零改动。

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## Self-Review 记录（计划作者自查）

1. **Spec 覆盖**：§4.1（Task 1 store）✓；§4.2（Task 1 server）✓；§4.3（Task 2 api）✓；
   §4.4 六点全部落 Task 2 Step 5（per-tab 态 / facetsByTab / 派生视图 / changeFilter
   收窄 / filterRef 不变 / JSX 门控）✓；§4.5 数据流由 5c/5d 组合达成 ✓；
   §5 失败模式：F1→5c filterRef 保留；F2→5e 注释 + web-ui 锚点；F3→facetsByTab
   隔离；F4→Task 1 Step 5 的 400 测试；F5→400/旧 daemon 路径均有 catch 降级；
   F6→无新查询开销；F7→unevaluated 桶测试保留；F8→discards scope 空组断言 ✓；
   §6 测试策略五条全部对应 Task 1-2 测试步骤 ✓。
2. **占位符扫描**：无 TBD/TODO；每个代码步骤含完整代码块（STATE.md 的 N/N 是运行
   时回填项，非占位符）。
3. **类型一致性**：`FacetScope`（Task 1 定义，server 消费）；`FacetTab`（Task 2 api
   定义，App isFilterTab/Record/facetsByTab 消费）；`listFacets(db, scope)` 两参签名
   Task 1 内 store/server/tests 一致；`getFacets(fetchFn, tab)` Task 2 内 api/App/tests
   一致；`VALUE_CLASS_UNEVALUATED` / `UNEVALUATED` 哨兵不动 ✓。
