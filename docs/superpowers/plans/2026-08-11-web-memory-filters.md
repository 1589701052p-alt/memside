# Web UI 记忆列表多维筛选 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给候选审批 / 已审批 / 已拒绝 / AI自动拒绝四个 tab 加服务端多维筛选（项目 / slug / 分类 / 价值筐），下拉选项来自新 `/api/facets` 端点，筛选激活时列表头显示服务端 `total`。

**Architecture:** 分页架构下客户端筛选必错（前端只加载 20/页），所以筛选全部下沉服务端：store 分页函数加可选 filter 条件 + COUNT 出 total，server 路由解析查询参数，新 `listFacets` 从真实数据 DISTINCT 出下拉选项（项目/分类 UNION memories+discards 两表）。Web 端筛选条四个单选下拉，改筛选 = 四个记忆 tab 缓存作废 + 立即重拉，轮询经 `filterRef` 读最新筛选。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite；前端 React 19 inline style；测试 bun:test（纯函数层为主 + 源码文本断言兜底）。

**Spec:** `docs/superpowers/specs/2026-08-11-web-memory-filters-design.md`

## Global Constraints

- 分支 `feat/web-memory-filters`（已从 `origin/master` abac2b9 切出）；**严禁**在 master 上 commit / push；最终走 PR 合回 master。
- 测试只认 `bun test`（**严禁 npm test**）；运行门槛 `bun run typecheck && bun test` 全绿才 push。
- 每个代码改动任务必须带测试（红 → 绿）；纯函数层写足断言，App.tsx 运行时组件用源码层文本断言兜底。
- 无 schema 迁移、无新依赖；注入链路（formatMemoryBlock）/ distiller / scheduler / 状态机零改动。
- 哨兵值统一：`unevaluated` 表示 value_class IS NULL（store 常量 `VALUE_CLASS_UNEVALUATED`，web 常量 `UNEVALUATED`，字符串值相同）。
- git push 需 `-c http.sslBackend=openssl`（本机代理环境）。

---

### Task 1: 纯函数 `categoryFromTitle`（title 分类前缀提取）

**Files:**
- Modify: `src/memory/pure.ts`（文件末尾追加）
- Test: `tests/pure-category.test.ts`（新建）

**Interfaces:**
- Consumes: 无
- Produces: `export function categoryFromTitle(title: unknown): string | null` — Task 4 `listFacets` 用它解析两表 title 计数分类。

- [ ] **Step 1: 写失败测试**（新建 `tests/pure-category.test.ts`）

```ts
import { test, expect } from 'bun:test'
import { categoryFromTitle } from '@/memory/pure'

// 回归锁定：title 的 [category:xxx] 前缀提取（spec 2026-08-11-web-memory-filters §4.1）。
// 筛选 facets / category 过滤的可测面。提取不限定行首（用户可编辑 title 挪动前缀），
// 输出统一小写，任何输入永不抛。

test('categoryFromTitle: 行首前缀提取', () => {
  expect(categoryFromTitle('[category:invariant] 退款规则')).toBe('invariant')
})

test('categoryFromTitle: 中间前缀也能提取（编辑挪位容错）', () => {
  expect(categoryFromTitle('改过前缀 [category:convention] 规则')).toBe('convention')
})

test('categoryFromTitle: 大小写不敏感，输出转小写', () => {
  expect(categoryFromTitle('[CATEGORY:Invariant] X')).toBe('invariant')
  expect(categoryFromTitle('[Category:Data-Semantics] X')).toBe('data-semantics')
})

test('categoryFromTitle: 无前缀 / 空内部 / 非字符串 -> null（永不抛）', () => {
  expect(categoryFromTitle('没有前缀的标题')).toBeNull()
  expect(categoryFromTitle('[category:] 空')).toBeNull()
  expect(categoryFromTitle('[category:   ] 空白')).toBeNull()
  expect(categoryFromTitle('')).toBeNull()
  expect(categoryFromTitle(null)).toBeNull()
  expect(categoryFromTitle(undefined)).toBeNull()
  expect(categoryFromTitle(42)).toBeNull()
})

test('categoryFromTitle: 取第一个匹配', () => {
  expect(categoryFromTitle('[category:a] 与 [category:b]')).toBe('a')
})
```

- [ ] **Step 2: 运行确认红**

Run: `bun test tests/pure-category.test.ts`
Expected: FAIL — `categoryFromTitle` 未导出。

- [ ] **Step 3: 实现**（追加到 `src/memory/pure.ts` 末尾）

```ts
// ---------------------------------------------------------------------------
// 记忆 title 分类前缀提取（spec 2026-08-11-web-memory-filters §4.1）。
// ---------------------------------------------------------------------------

const CATEGORY_PREFIX_RE = /\[category:([^\]]*)\]/i

/**
 * 从记忆 title 提取 [category:xxx] 前缀的分类值（trim + 转小写）。
 * 提取不限定行首（用户可在审批卡片编辑 title 挪动前缀）；无匹配 / 空值 /
 * 非字符串输入一律返回 null，永不抛。与 exactDedup.ts 的剥离正则语义对齐。
 */
export function categoryFromTitle(title: unknown): string | null {
  if (typeof title !== 'string') return null
  const m = CATEGORY_PREFIX_RE.exec(title)
  if (!m) return null
  const v = m[1]!.trim().toLowerCase()
  return v.length > 0 ? v : null
}
```

- [ ] **Step 4: 运行确认绿**

Run: `bun test tests/pure-category.test.ts`
Expected: PASS（5 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/memory/pure.ts tests/pure-category.test.ts
git commit -m "feat(pure): categoryFromTitle 提取 title 分类前缀（筛选可测面）"
```

---

### Task 2: Web 纯函数 `MemoryFilter` / `hasActiveFilter` / `projectDisplayName`

**Files:**
- Modify: `src/web/tab-cache.ts`（末尾追加）
- Modify: `src/web/ui-utils.ts`（末尾追加）
- Test: `tests/tab-cache.test.ts`（追加）、`tests/ui-utils.test.ts`（追加）

**Interfaces:**
- Consumes: 无
- Produces（Task 7 App.tsx 使用）：
  - `export interface MemoryFilter { project: string; slug: string; category: string; valueClass: string }`（tab-cache.ts）
  - `export const EMPTY_MEMORY_FILTER: MemoryFilter`（四维全空串）
  - `export function hasActiveFilter(f: MemoryFilter): boolean`
  - `export function projectDisplayName(value: string, allValues: string[]): string`（ui-utils.ts）

- [ ] **Step 1: 写失败测试**

追加到 `tests/tab-cache.test.ts` 末尾（并在文件头部 import 里补上 `hasActiveFilter, EMPTY_MEMORY_FILTER`）：

```ts
// --- 2026-08-11 记忆列表筛选（spec web-memory-filters §4.3）---

test('hasActiveFilter: 全空 false，任一维非空 true', () => {
  expect(hasActiveFilter({ project: '', slug: '', category: '', valueClass: '' })).toBe(false)
  expect(hasActiveFilter({ project: 'C:/x', slug: '', category: '', valueClass: '' })).toBe(true)
  expect(hasActiveFilter({ project: '', slug: 's', category: '', valueClass: '' })).toBe(true)
  expect(hasActiveFilter({ project: '', slug: '', category: 'trap', valueClass: '' })).toBe(true)
  expect(hasActiveFilter({ project: '', slug: '', category: '', valueClass: 'unevaluated' })).toBe(true)
})

test('EMPTY_MEMORY_FILTER 四维全空且未激活', () => {
  expect(EMPTY_MEMORY_FILTER).toEqual({ project: '', slug: '', category: '', valueClass: '' })
  expect(hasActiveFilter(EMPTY_MEMORY_FILTER)).toBe(false)
})
```

追加到 `tests/ui-utils.test.ts` 末尾（import 补 `projectDisplayName`）：

```ts
// --- projectDisplayName（spec 2026-08-11-web-memory-filters §4.3）---

test('projectDisplayName: 取路径末段（正反斜杠 / 尾分隔符）', () => {
  expect(projectDisplayName('C:\\Users\\admin\\Desktop\\memside', ['C:\\Users\\admin\\Desktop\\memside'])).toBe('memside')
  expect(projectDisplayName('/home/u/proj/', ['/home/u/proj/'])).toBe('proj')
})

test('projectDisplayName: 末段撞名升级 父/子', () => {
  const all = ['C:\\a\\app', 'C:\\b\\app']
  expect(projectDisplayName('C:\\a\\app', all)).toBe('a/app')
  expect(projectDisplayName('C:\\b\\app', all)).toBe('b/app')
})

test('projectDisplayName: 无父段 / 空输入回退原值，永不抛', () => {
  expect(projectDisplayName('solo', ['solo', 'x/solo'])).toBe('solo')
  expect(projectDisplayName('', [''])).toBe('')
})
```

- [ ] **Step 2: 运行确认红**

Run: `bun test tests/tab-cache.test.ts tests/ui-utils.test.ts`
Expected: FAIL — 新导出不存在。

- [ ] **Step 3: 实现**

追加到 `src/web/tab-cache.ts` 末尾：

```ts
// --- 记忆列表筛选（spec 2026-08-11-web-memory-filters §4.3）----------------

/** 四维筛选状态；空串 = 不筛该维度。跨 tab 共享（App 单一 state）。 */
export interface MemoryFilter { project: string; slug: string; category: string; valueClass: string }

export const EMPTY_MEMORY_FILTER: MemoryFilter = { project: '', slug: '', category: '', valueClass: '' }

/** 任一维非空 -> 筛选激活。 */
export function hasActiveFilter(f: MemoryFilter): boolean {
  return f.project !== '' || f.slug !== '' || f.category !== '' || f.valueClass !== ''
}
```

追加到 `src/web/ui-utils.ts` 末尾：

```ts
/**
 * 项目下拉显示名：取路径末段（同时切 \ 与 /，去空段）；末段在同批值里撞名时
 * 升级为「父段/末段」；取不到段 -> 原值兜底。永不抛。
 * spec 2026-08-11-web-memory-filters §4.3。
 */
export function projectDisplayName(value: string, allValues: string[]): string {
  const segs = (v: string) => v.split(/[\\/]+/).filter(Boolean)
  const last = (v: string): string => {
    const s = segs(v)
    return s.length > 0 ? s[s.length - 1]! : v
  }
  const base = last(value)
  if (base === '') return value
  const collide = allValues.some((o) => o !== value && last(o) === base)
  if (!collide) return base
  const s = segs(value)
  if (s.length >= 2) return `${s[s.length - 2]}/${base}`
  return value
}
```

- [ ] **Step 4: 运行确认绿**

Run: `bun test tests/tab-cache.test.ts tests/ui-utils.test.ts`
Expected: PASS（原有测试 + 新增 5 个）

- [ ] **Step 5: 提交**

```bash
git add src/web/tab-cache.ts src/web/ui-utils.ts tests/tab-cache.test.ts tests/ui-utils.test.ts
git commit -m "feat(web): 筛选纯函数 MemoryFilter/hasActiveFilter/projectDisplayName"
```

---

### Task 3: store 四维筛选 + total（listMemoriesPage / listDiscardsPage）

**Files:**
- Modify: `src/memory/store.ts`（drizzle import 补 `sql`；分页段新增 filter 类型/条件函数；`listMemoriesPage` / `listDiscardsPage` 扩展；`Page` 旁新增 `PageWithTotal`）
- Modify: `tests/store-page.test.ts:90` 与 `:121`（空表断言补 `total: 0`）
- Test: `tests/store-filter.test.ts`（新建）

**Interfaces:**
- Consumes: `PROTECTED_VALUE_CLASSES`（store.ts:843 既有）；`memories` / `memoryDiscards` schema 列。
- Produces（Task 5 server 使用）：
  - `export const VALUE_CLASS_UNEVALUATED = 'unevaluated'`
  - `export interface MemoryListFilter { sourceCwd?: string; subjectSlug?: string; category?: string; valueClass?: string }`
  - `export interface PageWithTotal<T> extends Page<T> { total: number }`
  - `listMemoriesPage(db, opts: { statuses: MemoryStatus[]; limit?: number; before?: PageCursor; filter?: MemoryListFilter }): Promise<PageWithTotal<Memory>>`
  - `listDiscardsPage(db, opts: { limit?: number; before?: PageCursor; filter?: MemoryListFilter }): Promise<PageWithTotal<DiscardRow>>`
  - discards 的 filter 只读 `sourceCwd` / `category`（subjectSlug/valueClass 无列，忽略）。

- [ ] **Step 1: 写失败测试**（新建 `tests/store-filter.test.ts`）

```ts
import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { memories, memoryDistillJobs } from '@/db/schema'
import type { MemoryStatus } from '@/memory/pure'
import type { ValueClass } from '@/memory/valueFilter'
import {
  createCandidate, listMemoriesPage, listDiscardsPage, logDiscards,
  VALUE_CLASS_UNEVALUATED,
} from '@/memory/store'

// 回归锁定：四维服务端筛选 + total 计数（spec 2026-08-11-web-memory-filters §4.1）。
// EBUSY-safe 模式同 store-page.test.ts（每 test 独立子目录）。
const root = join(import.meta.dir, '.tmp-store-filter')
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

async function seedMem(opts: {
  ts: number; status?: MemoryStatus; valueClass?: ValueClass | null
  sourceCwd?: string | null; slug?: string | null; title?: string
}) {
  const m = await createCandidate(db, {
    scopeType: 'global', scopeId: null,
    title: opts.title ?? `[category:convention] t-${opts.ts}`, bodyMd: 'b',
    tags: [], sourceKind: 'manual', runtime: null,
    valueClass: opts.valueClass ?? null, sourceCwd: opts.sourceCwd ?? null,
    subjectSlug: opts.slug ?? null,
  })
  await db.update(memories).set({ createdAt: opts.ts, status: opts.status ?? 'candidate' })
    .where(eq(memories.id, m.id)).run()
  return m.id
}

test('filter.sourceCwd 精确匹配 + total', async () => {
  await seedMem({ ts: 1000, sourceCwd: 'C:/p/a' })
  await seedMem({ ts: 2000, sourceCwd: 'C:/p/b' })
  await seedMem({ ts: 3000, sourceCwd: null })
  const page = await listMemoriesPage(db, { statuses: [], limit: 50, filter: { sourceCwd: 'C:/p/a' } })
  expect(page.items.length).toBe(1)
  expect(page.items[0]!.sourceCwd).toBe('C:/p/a')
  expect(page.total).toBe(1)
})

test('filter.subjectSlug 精确匹配', async () => {
  await seedMem({ ts: 1000, slug: 'refund-policy' })
  await seedMem({ ts: 2000, slug: 'other' })
  await seedMem({ ts: 3000, slug: null })
  const page = await listMemoriesPage(db, { statuses: [], limit: 50, filter: { subjectSlug: 'refund-policy' } })
  expect(page.items.length).toBe(1)
  expect(page.items[0]!.subjectSlug).toBe('refund-policy')
})

test('filter.category: 带闭括号精确子串，不误中前缀相似值', async () => {
  await seedMem({ ts: 1000, title: '[category:arch] 短分类' })
  await seedMem({ ts: 2000, title: '[category:architecture] 长分类' })
  const page = await listMemoriesPage(db, { statuses: [], limit: 50, filter: { category: 'arch' } })
  expect(page.items.length).toBe(1)
  expect(page.items[0]!.title).toBe('[category:arch] 短分类')
})

test('filter.valueClass: 合法值精确 + unevaluated 哨兵命中 NULL 行', async () => {
  await seedMem({ ts: 1000, valueClass: 'decision' })
  await seedMem({ ts: 2000, valueClass: null })
  await seedMem({ ts: 3000, valueClass: 'trap' })
  const decided = await listMemoriesPage(db, { statuses: [], limit: 50, filter: { valueClass: 'decision' } })
  expect(decided.items.length).toBe(1)
  const uneval = await listMemoriesPage(db, { statuses: [], limit: 50, filter: { valueClass: VALUE_CLASS_UNEVALUATED } })
  expect(uneval.items.length).toBe(1)
  expect(uneval.items[0]!.valueClass).toBeNull()
  expect(uneval.total).toBe(1)
})

test('filter.valueClass 非法值 -> 条件忽略（返回全量）', async () => {
  await seedMem({ ts: 1000, valueClass: 'decision' })
  await seedMem({ ts: 2000, valueClass: null })
  const page = await listMemoriesPage(db, { statuses: [], limit: 50, filter: { valueClass: 'not-a-class' } })
  expect(page.items.length).toBe(2)
})

test('多维 AND + 与 status 条件共存', async () => {
  await seedMem({ ts: 1000, status: 'candidate', sourceCwd: 'C:/p/a', valueClass: 'decision' })
  await seedMem({ ts: 2000, status: 'rejected', sourceCwd: 'C:/p/a', valueClass: 'decision' })
  await seedMem({ ts: 3000, status: 'candidate', sourceCwd: 'C:/p/b', valueClass: 'decision' })
  const page = await listMemoriesPage(db, {
    statuses: ['candidate'], limit: 50, filter: { sourceCwd: 'C:/p/a', valueClass: 'decision' },
  })
  expect(page.items.length).toBe(1)
  expect(page.total).toBe(1)
})

test('无匹配 -> 空页 hasMore=false total=0', async () => {
  await seedMem({ ts: 1000, sourceCwd: 'C:/p/a' })
  const page = await listMemoriesPage(db, { statuses: [], limit: 50, filter: { sourceCwd: 'C:/nowhere' } })
  expect(page.items).toEqual([])
  expect(page.hasMore).toBe(false)
  expect(page.nextCursor).toBeNull()
  expect(page.total).toBe(0)
})

test('筛选与游标共存：翻页仍只含匹配行', async () => {
  for (let i = 0; i < 5; i++) {
    await seedMem({ ts: 1000 + i, sourceCwd: i % 2 === 0 ? 'C:/even' : 'C:/odd' })
  }
  const p1 = await listMemoriesPage(db, { statuses: [], limit: 2, filter: { sourceCwd: 'C:/even' } })
  expect(p1.items.length).toBe(2)
  expect(p1.items.every((m) => m.sourceCwd === 'C:/even')).toBe(true)
  expect(p1.hasMore).toBe(true)
  const p2 = await listMemoriesPage(db, { statuses: [], limit: 2, before: p1.nextCursor!, filter: { sourceCwd: 'C:/even' } })
  expect(p2.items.length).toBe(1)
  expect(p2.items[0]!.sourceCwd).toBe('C:/even')
  expect(p2.hasMore).toBe(false)
})

test('total = 同条件 COUNT，不随翻页变化', async () => {
  for (let i = 0; i < 3; i++) await seedMem({ ts: 1000 + i, sourceCwd: 'C:/x' })
  await seedMem({ ts: 9000, sourceCwd: 'C:/y' })
  const p1 = await listMemoriesPage(db, { statuses: [], limit: 2, filter: { sourceCwd: 'C:/x' } })
  expect(p1.total).toBe(3)
  const p2 = await listMemoriesPage(db, { statuses: [], limit: 2, before: p1.nextCursor!, filter: { sourceCwd: 'C:/x' } })
  expect(p2.total).toBe(3)
})

test('无 filter 回归锚：不传 filter 行为不变（total = 全表计数）', async () => {
  await seedMem({ ts: 1000 })
  const page = await listMemoriesPage(db, { statuses: [], limit: 50 })
  expect(page.items.length).toBe(1)
  expect(page.hasMore).toBe(false)
  expect(page.total).toBe(1)
})

test('listDiscardsPage filter: sourceCwd + category + AND', async () => {
  db.insert(memoryDistillJobs).values({
    id: 'job-f', debounceKey: 'k', sourceEventId: 's', runtime: 'claude-code',
    cwd: '/r', status: 'done', attempts: 0, nextRunAt: 0, createdAt: 0,
  }).run()
  await logDiscards(db, 'job-f', [
    { title: '[category:trap] 坑A', bodyMd: 'b', reason: 'fleeting' as const, scopeType: 'project' as const, scopeId: 'C:/p/a', sourceCwd: 'C:/p/a', runtime: null, sourceKind: 'conversation' as const },
    { title: '[category:convention] 约定B', bodyMd: 'b', reason: 'derivable' as const, scopeType: 'project' as const, scopeId: 'C:/p/a', sourceCwd: 'C:/p/a', runtime: null, sourceKind: 'conversation' as const },
    { title: '[category:trap] 坑C', bodyMd: 'b', reason: 'fleeting' as const, scopeType: 'global' as const, scopeId: null, sourceCwd: 'C:/p/b', runtime: null, sourceKind: 'conversation' as const },
  ])
  const byProject = await listDiscardsPage(db, { limit: 50, filter: { sourceCwd: 'C:/p/a' } })
  expect(byProject.items.length).toBe(2)
  expect(byProject.total).toBe(2)
  const byCat = await listDiscardsPage(db, { limit: 50, filter: { category: 'trap' } })
  expect(byCat.items.length).toBe(2)
  const both = await listDiscardsPage(db, { limit: 50, filter: { sourceCwd: 'C:/p/a', category: 'trap' } })
  expect(both.items.length).toBe(1)
  expect(both.items[0]!.title).toBe('[category:trap] 坑A')
})
```

同时修改 `tests/store-page.test.ts` 两处既有精确断言（新返回形状多 `total` 字段）：
- `listMemoriesPage: 空表 -> 空页无游标` 测试：`expect(page).toEqual({ items: [], hasMore: false, nextCursor: null })` → `expect(page).toEqual({ items: [], hasMore: false, nextCursor: null, total: 0 })`
- `listDiscardsPage: 空表 -> 空页` 测试：同样补 `total: 0`

- [ ] **Step 2: 运行确认红**

Run: `bun test tests/store-filter.test.ts tests/store-page.test.ts`
Expected: FAIL — `VALUE_CLASS_UNEVALUATED` 未导出 / filter 参数不识别 / total 缺失。

- [ ] **Step 3: 实现**（`src/memory/store.ts`）

3a. drizzle import 行补 `sql`：

```ts
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, notInArray, or, sql } from 'drizzle-orm'
```

3b. `Page<T>` 定义旁新增：

```ts
/** 带全表匹配计数的分页（memories/discards 筛选用；distill runs 不带）。 */
export interface PageWithTotal<T> extends Page<T> { total: number }
```

3c. `clampPageLimit` 之后、`listMemoriesPage` 之前插入筛选段：

```ts
// ---------------------------------------------------------------------------
// 四维服务端筛选（spec 2026-08-11-web-memory-filters §4.1）
// ---------------------------------------------------------------------------

/** valueClass 筛「未评估」的哨兵值（= value_class IS NULL）。六个合法
 *  value_class 里没有这个词，URL/接口层无歧义。 */
export const VALUE_CLASS_UNEVALUATED = 'unevaluated'

export interface MemoryListFilter {
  /** memories.source_cwd / discards.source_cwd 精确匹配。 */
  sourceCwd?: string
  /** memories.subject_slug 精确匹配（discards 无此列，忽略）。 */
  subjectSlug?: string
  /** instr(title, '[category:X]') > 0（带闭括号精确子串）。 */
  category?: string
  /** 'unevaluated' 哨兵 -> IS NULL；合法六值 -> eq；其余值忽略（宽松）。 */
  valueClass?: string
}

function memoryFilterConds(filter?: MemoryListFilter) {
  const conds = []
  if (!filter) return conds
  if (filter.sourceCwd) conds.push(eq(memories.sourceCwd, filter.sourceCwd))
  if (filter.subjectSlug) conds.push(eq(memories.subjectSlug, filter.subjectSlug))
  if (filter.category) {
    conds.push(sql`instr(${memories.title}, ${'[category:' + filter.category + ']'}) > 0`)
  }
  if (filter.valueClass) {
    if (filter.valueClass === VALUE_CLASS_UNEVALUATED) conds.push(isNull(memories.valueClass))
    else if ((PROTECTED_VALUE_CLASSES as readonly string[]).includes(filter.valueClass)) {
      conds.push(eq(memories.valueClass, filter.valueClass))
    }
    // 其余值 -> 忽略该条件（白名单宽松策略，与非法 status 同风格，spec §4.2）
  }
  return conds
}

function discardFilterConds(filter?: MemoryListFilter) {
  const conds = []
  if (!filter) return conds
  if (filter.sourceCwd) conds.push(eq(memoryDiscards.sourceCwd, filter.sourceCwd))
  if (filter.category) {
    conds.push(sql`instr(${memoryDiscards.title}, ${'[category:' + filter.category + ']'}) > 0`)
  }
  return conds
}
```

注意：`PROTECTED_VALUE_CLASSES` 定义在 store.ts 后段（约 843 行），函数体在执行期才引用，模块初始化顺序无碍。

3d. `listMemoriesPage` 改签名与实现（返回 `PageWithTotal<Memory>`）：

```ts
export async function listMemoriesPage(
  db: DbClient,
  opts: { statuses: MemoryStatus[]; limit?: number; before?: PageCursor; filter?: MemoryListFilter },
): Promise<PageWithTotal<Memory>> {
  const limit = clampPageLimit(opts.limit)
  const baseConds = []
  if (opts.statuses.length > 0) baseConds.push(inArray(memories.status, opts.statuses))
  baseConds.push(...memoryFilterConds(opts.filter))
  const conds = [...baseConds]
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
  // total 与筛选条件同 WHERE、不含游标（游标只切页不切计数）
  const countRows = await db.select({ n: sql<number>`COUNT(*)` }).from(memories)
    .where(baseConds.length > 0 ? and(...baseConds) : undefined).all()
  const hasMore = rows.length > limit
  const pageRows = rows.slice(0, limit)
  const last = pageRows[pageRows.length - 1]
  return {
    items: pageRows.map(rowToMemory),
    hasMore,
    nextCursor: hasMore && last ? { ts: last.createdAt, id: last.id } : null,
    total: Number(countRows[0]?.n ?? 0),
  }
}
```

3e. `listDiscardsPage` 同样改造（返回 `PageWithTotal<DiscardRow>`）：

```ts
export async function listDiscardsPage(
  db: DbClient,
  opts: { limit?: number; before?: PageCursor; filter?: MemoryListFilter } = {},
): Promise<PageWithTotal<DiscardRow>> {
  const limit = clampPageLimit(opts.limit)
  const baseConds = discardFilterConds(opts.filter)
  const conds = [...baseConds]
  if (opts.before) {
    conds.push(or(
      lt(memoryDiscards.ts, opts.before.ts),
      and(eq(memoryDiscards.ts, opts.before.ts), lt(memoryDiscards.id, opts.before.id)),
    ))
  }
  const rows = await db.select().from(memoryDiscards)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(memoryDiscards.ts), desc(memoryDiscards.id))
    .limit(limit + 1).all()
  const countRows = await db.select({ n: sql<number>`COUNT(*)` }).from(memoryDiscards)
    .where(baseConds.length > 0 ? and(...baseConds) : undefined).all()
  const hasMore = rows.length > limit
  const pageRows = rows.slice(0, limit)
  const last = pageRows[pageRows.length - 1]
  return {
    items: pageRows.map(rowToDiscard),
    hasMore,
    nextCursor: hasMore && last ? { ts: last.ts, id: last.id } : null,
    total: Number(countRows[0]?.n ?? 0),
  }
}
```

（`listDistillRunsPage` 不动，仍返回 `Page<DistillRunListRow>`。）

- [ ] **Step 4: 运行确认绿**

Run: `bun test tests/store-filter.test.ts tests/store-page.test.ts`
Expected: PASS（store-filter 11 个新测试 + store-page 原测试含改过断言的两个）

- [ ] **Step 5: 提交**

```bash
git add src/memory/store.ts tests/store-filter.test.ts tests/store-page.test.ts
git commit -m "feat(store): 分页四维筛选 + total 计数（服务端筛选下沉）"
```

---

### Task 4: store `listFacets`（四维下拉选项数据面）

**Files:**
- Modify: `src/memory/store.ts`（pure import 补 `categoryFromTitle`；分页段后新增 facets 段）
- Test: `tests/store-facets.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 `categoryFromTitle`；Task 3 `VALUE_CLASS_UNEVALUATED`。
- Produces（Task 5 server 使用）：
  - `export interface FacetValue { value: string; count: number }`
  - `export interface Facets { projects: FacetValue[]; categories: FacetValue[]; slugs: FacetValue[]; valueClasses: FacetValue[] }`
  - `export const FACET_LIST_CAP = 200`
  - `export async function listFacets(db: DbClient): Promise<Facets>`

- [ ] **Step 1: 写失败测试**（新建 `tests/store-facets.test.ts`）

```ts
import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { memoryDistillJobs } from '@/db/schema'
import { createCandidate, logDiscards, listFacets, VALUE_CLASS_UNEVALUATED } from '@/memory/store'

// 回归锁定：/api/facets 数据面（spec 2026-08-11-web-memory-filters §4.1 决策 D1/D2）。
// 项目/分类 UNION memories+discards 两表；value_class NULL 聚未评估桶；count 降序。
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

async function seedMem(title: string, opts: { sourceCwd?: string | null; slug?: string | null; valueClass?: 'decision' | 'trap' | null } = {}) {
  return createCandidate(db, {
    scopeType: 'global', scopeId: null, title, bodyMd: 'b',
    tags: [], sourceKind: 'manual', runtime: null,
    sourceCwd: opts.sourceCwd ?? null, subjectSlug: opts.slug ?? null,
    valueClass: opts.valueClass ?? null,
  })
}

function seedDiscardJob() {
  db.insert(memoryDistillJobs).values({
    id: 'job-f', debounceKey: 'k', sourceEventId: 's', runtime: 'claude-code',
    cwd: '/r', status: 'done', attempts: 0, nextRunAt: 0, createdAt: 0,
  }).run()
}

test('projects UNION 两表：discard 独有项目必须出现，同值合并计数', async () => {
  await seedMem('[category:trap] A', { sourceCwd: 'C:/p/a' })
  await seedMem('[category:trap] B', { sourceCwd: null }) // NULL 不进选项
  seedDiscardJob()
  await logDiscards(db, 'job-f', [
    { title: '[category:trap] C', bodyMd: 'b', reason: 'fleeting' as const, scopeType: 'project' as const, scopeId: 'C:/p/only-discard', sourceCwd: 'C:/p/only-discard', runtime: null, sourceKind: 'conversation' as const },
    { title: '[category:trap] D', bodyMd: 'b', reason: 'fleeting' as const, scopeType: 'project' as const, scopeId: 'C:/p/a', sourceCwd: 'C:/p/a', runtime: null, sourceKind: 'conversation' as const },
  ])
  const f = await listFacets(db)
  expect(f.projects).toEqual([
    { value: 'C:/p/a', count: 2 },            // 1 memory + 1 discard 合并
    { value: 'C:/p/only-discard', count: 1 }, // 只在 discards 里（决策 D1）
  ])
})

test('categories 两表 title 解析计数（幻觉分类也收录，数据驱动）', async () => {
  await seedMem('[category:invariant] X')
  await seedMem('[category:invariant] Y')
  await seedMem('[category:test-pattern] Z') // 幻觉值也必须出现
  seedDiscardJob()
  await logDiscards(db, 'job-f', [
    { title: '[category:invariant] W', bodyMd: 'b', reason: 'fleeting' as const, scopeType: 'global' as const, scopeId: null, sourceCwd: null, runtime: null, sourceKind: 'conversation' as const },
  ])
  const f = await listFacets(db)
  expect(f.categories).toEqual([
    { value: 'invariant', count: 3 },   // 2 memories + 1 discard
    { value: 'test-pattern', count: 1 },
  ])
})

test('slugs 排除 NULL；valueClasses 含未评估桶；count 降序 + 同 count 字母序', async () => {
  await seedMem('[category:trap] 1', { slug: 'refund-policy', valueClass: 'decision' })
  await seedMem('[category:trap] 2', { slug: 'refund-policy', valueClass: 'decision' })
  await seedMem('[category:trap] 3', { slug: 'a-b', valueClass: null })
  await seedMem('[category:trap] 4', { slug: null, valueClass: 'trap' })
  const f = await listFacets(db)
  expect(f.slugs).toEqual([
    { value: 'refund-policy', count: 2 },
    { value: 'a-b', count: 1 },
  ])
  expect(f.valueClasses).toEqual([
    { value: 'decision', count: 2 },
    { value: 'trap', count: 1 },                    // 同 count 字母序：t < u
    { value: VALUE_CLASS_UNEVALUATED, count: 1 },
  ])
})

test('空表 -> 四个空数组', async () => {
  expect(await listFacets(db)).toEqual({ projects: [], categories: [], slugs: [], valueClasses: [] })
})
```

- [ ] **Step 2: 运行确认红**

Run: `bun test tests/store-facets.test.ts`
Expected: FAIL — `listFacets` 未导出。

- [ ] **Step 3: 实现**（`src/memory/store.ts`）

3a. pure import 行补 `categoryFromTitle`：

```ts
import {
  canTransition,
  categoryFromTitle,
  normalizeSubjectSlug,
  ...
} from './pure'
```

3b. 分页段（`listDistillRunsPage` 之后）插入：

```ts
// ---------------------------------------------------------------------------
// 四维筛选下拉选项（spec 2026-08-11-web-memory-filters §4.1）
// ---------------------------------------------------------------------------

export interface FacetValue { value: string; count: number }
export interface Facets {
  projects: FacetValue[]
  categories: FacetValue[]
  slugs: FacetValue[]
  valueClasses: FacetValue[]
}
export const FACET_LIST_CAP = 200

function sortFacets(m: Map<string, number>): FacetValue[] {
  return [...m.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
    .slice(0, FACET_LIST_CAP)
}

/**
 * 四维筛选的下拉选项：全局口径（不按 tab/status 切分，决策 D2）；项目与分类
 * UNION memories+discards 两表（决策 D1：discard 行不在 memories 表）；
 * value_class NULL 聚成 VALUE_CLASS_UNEVALUATED 桶。各组 count 降序、
 * 同 count 按 value 字母序，截 FACET_LIST_CAP。
 */
export async function listFacets(db: DbClient): Promise<Facets> {
  const bump = (m: Map<string, number>, v: string, n: number) => m.set(v, (m.get(v) ?? 0) + n)

  const projects = new Map<string, number>()
  const memProj = await db.select({ v: memories.sourceCwd, n: sql<number>`COUNT(*)` })
    .from(memories).where(isNotNull(memories.sourceCwd)).groupBy(memories.sourceCwd).all()
  const disProj = await db.select({ v: memoryDiscards.sourceCwd, n: sql<number>`COUNT(*)` })
    .from(memoryDiscards).where(isNotNull(memoryDiscards.sourceCwd)).groupBy(memoryDiscards.sourceCwd).all()
  for (const r of [...memProj, ...disProj]) if (r.v) bump(projects, r.v, Number(r.n))

  const cats = new Map<string, number>()
  const memTitles = await db.select({ t: memories.title }).from(memories).all()
  const disTitles = await db.select({ t: memoryDiscards.title }).from(memoryDiscards).all()
  for (const r of [...memTitles, ...disTitles]) {
    const c = categoryFromTitle(r.t)
    if (c) bump(cats, c, 1)
  }

  const slugs = new Map<string, number>()
  const slugRows = await db.select({ v: memories.subjectSlug, n: sql<number>`COUNT(*)` })
    .from(memories).where(isNotNull(memories.subjectSlug)).groupBy(memories.subjectSlug).all()
  for (const r of slugRows) if (r.v) bump(slugs, r.v, Number(r.n))

  const vcs = new Map<string, number>()
  const vcRows = await db.select({ v: memories.valueClass, n: sql<number>`COUNT(*)` })
    .from(memories).groupBy(memories.valueClass).all()
  for (const r of vcRows) bump(vcs, r.v ?? VALUE_CLASS_UNEVALUATED, Number(r.n))

  return {
    projects: sortFacets(projects),
    categories: sortFacets(cats),
    slugs: sortFacets(slugs),
    valueClasses: sortFacets(vcs),
  }
}
```

- [ ] **Step 4: 运行确认绿**

Run: `bun test tests/store-facets.test.ts`
Expected: PASS（4 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/memory/store.ts tests/store-facets.test.ts
git commit -m "feat(store): listFacets 四维筛选选项（项目/分类 UNION 两表）"
```

---

### Task 5: server 路由（筛选参数 + /api/facets + total 透传）

**Files:**
- Modify: `src/server.ts`（store import 补 `listFacets` / `type MemoryListFilter`；`GET /api/memories` 分页路径解析四参数；`GET /api/discards` 分页路径解析两参数；新增 `GET /api/facets`）
- Test: `tests/server.test.ts`（追加分节）

**Interfaces:**
- Consumes: Task 3 `MemoryListFilter` / filter opts；Task 4 `listFacets`。
- Produces（Task 6 web client 对齐的 HTTP 契约）：
  - `GET /api/memories?limit=…&project=…&slug=…&category=…&valueClass=…` → `{ items, hasMore, nextCursor, total }`；filter 参数仅分页路径识别（无 limit 的旧全量路径忽略，决策 D4）。
  - `GET /api/discards?limit=…&project=…&category=…` → 同形状。
  - `GET /api/facets` → `{ projects, categories, slugs, valueClasses }`。

- [ ] **Step 1: 写失败测试**（追加到 `tests/server.test.ts` 末尾）

```ts
// --- 2026-08-11 web-memory-filters: 四维服务端筛选 + facets + total ---------

async function seedMemFull(opts: {
  ts: number; status?: MemoryStatus; valueClass?: ValueClass | null
  sourceCwd?: string | null; slug?: string | null; title?: string
}) {
  const m = await createCandidate(db, {
    scopeType: 'global', scopeId: null,
    title: opts.title ?? `[category:convention] t-${opts.ts}`, bodyMd: 'b',
    tags: [], sourceKind: 'manual', runtime: null,
    valueClass: opts.valueClass ?? null, sourceCwd: opts.sourceCwd ?? null,
    subjectSlug: opts.slug ?? null,
  })
  await db.update(memories).set({ createdAt: opts.ts, status: opts.status ?? 'candidate' })
    .where(eq(memories.id, m.id)).run()
  return m.id
}

test('GET /api/memories?limit 四维筛选参数各自生效 + total + 组合 AND', async () => {
  await seedMemFull({ ts: 1000, sourceCwd: 'C:/p/a', slug: 'refund-policy', valueClass: 'decision' })
  await seedMemFull({ ts: 2000, sourceCwd: 'C:/p/b', slug: 'other', valueClass: null })
  const byProject = await req(`/api/memories?limit=50&project=${encodeURIComponent('C:/p/a')}`)
  expect(byProject.status).toBe(200)
  expect(byProject.body.items.length).toBe(1)
  expect(byProject.body.total).toBe(1)
  const bySlug = await req('/api/memories?limit=50&slug=refund-policy')
  expect(bySlug.body.items.length).toBe(1)
  const byCat = await req('/api/memories?limit=50&category=convention')
  expect(byCat.body.items.length).toBe(2)
  const byVc = await req('/api/memories?limit=50&valueClass=unevaluated')
  expect(byVc.body.items.length).toBe(1)
  const combined = await req(`/api/memories?limit=50&project=${encodeURIComponent('C:/p/a')}&valueClass=decision`)
  expect(combined.body.items.length).toBe(1)
  expect(combined.body.total).toBe(1)
})

test('GET /api/memories 非法 valueClass 宽松忽略不 400', async () => {
  await seedMemFull({ ts: 1000, valueClass: 'decision' })
  const r = await req('/api/memories?limit=50&valueClass=bogus')
  expect(r.status).toBe(200)
  expect(r.body.items.length).toBe(1)
})

test('GET /api/memories 旧全量路径忽略 filter 参数（决策 D4 锁）', async () => {
  await seedMemFull({ ts: 1000, sourceCwd: 'C:/p/a' })
  await seedMemFull({ ts: 2000, sourceCwd: 'C:/p/b' })
  const r = await req(`/api/memories?project=${encodeURIComponent('C:/p/a')}`)
  expect(r.status).toBe(200)
  expect(r.body.items.length).toBe(2) // 无 limit -> 旧形状，不筛选
  expect('hasMore' in r.body).toBe(false)
})

test('GET /api/discards?limit project/category 筛选 + total', async () => {
  db.insert(memoryDistillJobs).values({
    id: 'job-f', debounceKey: 'k', sourceEventId: 's', runtime: 'claude-code',
    cwd: '/r', status: 'done', attempts: 0, nextRunAt: 0, createdAt: 0,
  }).run()
  await logDiscards(db, 'job-f', [
    { title: '[category:trap] 坑A', bodyMd: 'b', reason: 'fleeting' as const, scopeType: 'project' as const, scopeId: 'C:/p/a', sourceCwd: 'C:/p/a', runtime: null, sourceKind: 'conversation' as const },
    { title: '[category:convention] 约定B', bodyMd: 'b', reason: 'derivable' as const, scopeType: 'project' as const, scopeId: 'C:/p/a', sourceCwd: 'C:/p/a', runtime: null, sourceKind: 'conversation' as const },
  ])
  const byProject = await req(`/api/discards?limit=50&project=${encodeURIComponent('C:/p/a')}`)
  expect(byProject.body.items.length).toBe(2)
  expect(byProject.body.total).toBe(2)
  const byCat = await req('/api/discards?limit=50&category=trap')
  expect(byCat.body.items.length).toBe(1)
  const none = await req(`/api/discards?limit=50&project=${encodeURIComponent('C:/nope')}`)
  expect(none.body.items.length).toBe(0)
  expect(none.body.total).toBe(0)
})

test('GET /api/facets 形状 + 数据驱动', async () => {
  await seedMemFull({ ts: 1000, sourceCwd: 'C:/p/a', slug: 's1', valueClass: 'decision' })
  const r = await req('/api/facets')
  expect(r.status).toBe(200)
  expect(r.body.projects).toEqual([{ value: 'C:/p/a', count: 1 }])
  expect(r.body.slugs).toEqual([{ value: 's1', count: 1 }])
  expect(r.body.categories).toEqual([{ value: 'convention', count: 1 }])
  expect(r.body.valueClasses).toEqual([{ value: 'decision', count: 1 }])
})
```

（`createCandidate` / `logDiscards` / `memoryDistillJobs` / `memories` / `eq` / `MemoryStatus` / `ValueClass` 均已在 server.test.ts 头部导入，无需新增 import。）

- [ ] **Step 2: 运行确认红**

Run: `bun test tests/server.test.ts -t "筛选"` 及 `-t "facets"`（或跑整个文件）
Expected: FAIL — 参数不识别（返回全量）/ `/api/facets` 404。

- [ ] **Step 3: 实现**（`src/server.ts`）

3a. store import 行补 `listFacets` 与 `type MemoryListFilter`：

```ts
import { ..., listMemoriesPage, listDiscardsPage, listDistillRunsPage, listFacets, bulkRejectUnevaluated, PROTECTED_VALUE_CLASSES, MemoryNotFoundError, type PageCursor, type MemoryListFilter } from '@/memory/store'
```

3b. `GET /api/memories` 分页分支（`if (c.req.query('limit') !== undefined)` 内）改为：

```ts
    if (c.req.query('limit') !== undefined) {
      const filter: MemoryListFilter = {}
      const project = c.req.query('project'); if (project) filter.sourceCwd = project
      const slug = c.req.query('slug'); if (slug) filter.subjectSlug = slug
      const category = c.req.query('category'); if (category) filter.category = category
      const valueClass = c.req.query('valueClass'); if (valueClass) filter.valueClass = valueClass
      const page = await listMemoriesPage(deps.db, {
        statuses: wanted,
        limit: Number(c.req.query('limit')),
        before: parseBefore(c),
        filter,
      })
      return c.json(page)
    }
```

（无 limit 的旧全量分支不动——决策 D4。）

3c. `GET /api/discards` 分页分支改为：

```ts
    if (c.req.query('limit') !== undefined) {
      const filter: MemoryListFilter = {}
      const project = c.req.query('project'); if (project) filter.sourceCwd = project
      const category = c.req.query('category'); if (category) filter.category = category
      return c.json(await listDiscardsPage(deps.db, {
        limit: Number(c.req.query('limit')), before: parseBefore(c), filter,
      }))
    }
```

3d. `GET /api/discards` 路由之后新增 facets 路由：

```ts
  // 四维筛选下拉选项（spec 2026-08-11-web-memory-filters §4.2）：全局口径，
  // Web 筛选条随 3s 轮询刷新（新 distill 产出新 slug/项目无静默窗口）。
  app.get('/api/facets', async (c) => c.json(await listFacets(deps.db)))
```

- [ ] **Step 4: 运行确认绿**

Run: `bun test tests/server.test.ts`
Expected: PASS（含新增 5 个测试与既有全部测试）

- [ ] **Step 5: 提交**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat(server): 记忆/丢弃列表筛选参数 + GET /api/facets + total"
```

---

### Task 6: web api client（筛选参数 URL + getFacets + PageDto.total）

**Files:**
- Modify: `src/web/api.ts`（`PageDto` 加 total；`listMemoriesPage` / `listDiscardsPage` opts 加筛选字段；新增 `UNEVALUATED` / `FacetValue` / `Facets` / `getFacets`）
- Test: `tests/web-api.test.ts`（追加分节）

**Interfaces:**
- Consumes: Task 5 HTTP 契约（参数名 project/slug/category/valueClass；facets 形状）。
- Produces（Task 7 App.tsx 使用）：
  - `export const UNEVALUATED = 'unevaluated'`
  - `export interface FacetValue { value: string; count: number }` / `export interface Facets { projects: FacetValue[]; categories: FacetValue[]; slugs: FacetValue[]; valueClasses: FacetValue[] }`
  - `export async function getFacets(fetchFn?: FetchLike): Promise<Facets>`
  - `listMemoriesPage(fetchFn, opts: { status: string; project?: string; slug?: string; category?: string; valueClass?: string } & PageOpts): Promise<PageDto<MemoryItem>>`
  - `listDiscardsPage(fetchFn, opts: { project?: string; category?: string } & PageOpts): Promise<PageDto<DiscardItem>>`
  - `PageDto<T>` 加字段 `total: number | null`

- [ ] **Step 1: 写失败测试**（追加到 `tests/web-api.test.ts` 末尾，import 补 `getFacets, UNEVALUATED`）

```ts
// --- 2026-08-11 web-memory-filters: 筛选参数 URL + facets + total ---------

test('listMemoriesPage: 筛选参数只在非空时拼入 URL（空串忽略）', async () => {
  const urls: string[] = []
  const fetchFn = (async (url: string) => {
    urls.push(url)
    return new Response(JSON.stringify({ items: [], hasMore: false, nextCursor: null, total: 0 }), { status: 200 })
  }) as any
  await listMemoriesPage(fetchFn, {
    status: 'candidate', limit: 20, project: 'C:/p/a', slug: '', category: 'trap', valueClass: UNEVALUATED,
  })
  expect(urls[0]).toBe(`/api/memories?status=candidate&limit=20&project=${encodeURIComponent('C:/p/a')}&category=trap&valueClass=unevaluated`)
  await listMemoriesPage(fetchFn, { status: 'rejected', limit: 20 })
  expect(urls[1]).toBe('/api/memories?status=rejected&limit=20')
})

test('listDiscardsPage: project/category 筛选参数拼在游标参数之后', async () => {
  let called = ''
  const fetchFn = (async (url: string) => {
    called = url
    return new Response(JSON.stringify({ items: [], hasMore: false, nextCursor: null, total: 0 }), { status: 200 })
  }) as any
  await listDiscardsPage(fetchFn, { limit: 20, project: 'C:/p/a', category: 'trap' })
  expect(called).toBe(`/api/discards?limit=20&project=${encodeURIComponent('C:/p/a')}&category=trap`)
})

test('getFacets: GET /api/facets 解析形状', async () => {
  let called = ''
  const fetchFn = (async (url: string) => {
    called = url
    return new Response(JSON.stringify({
      projects: [{ value: 'C:/x', count: 2 }], categories: [], slugs: [], valueClasses: [],
    }), { status: 200 })
  }) as any
  const f = await getFacets(fetchFn)
  expect(called).toBe('/api/facets')
  expect(f.projects[0]).toEqual({ value: 'C:/x', count: 2 })
})

test('PageDto.total: 旧 daemon 无 total -> null（降级不崩）', async () => {
  const fetchFn = (async () =>
    new Response(JSON.stringify({ items: [], hasMore: false, nextCursor: null }), { status: 200 })) as any
  const page = await listMemoriesPage(fetchFn, { status: 'candidate' })
  expect(page.total).toBeNull()
})
```

- [ ] **Step 2: 运行确认红**

Run: `bun test tests/web-api.test.ts`
Expected: FAIL — `getFacets` / `UNEVALUATED` 未导出，URL 不含筛选参数。

- [ ] **Step 3: 实现**（`src/web/api.ts`）

3a. `PageDto` 与 `parsePage`：

```ts
export interface PageDto<T> { items: T[]; hasMore: boolean; nextCursor: { ts: number; id: string } | null; total: number | null }
```

```ts
async function parsePage<T>(res: Response): Promise<PageDto<T>> {
  const data = await res.json()
  return {
    items: (data.items ?? []) as T[],
    hasMore: data.hasMore ?? false,
    nextCursor: data.nextCursor ?? null,
    total: data.total ?? null, // 旧 daemon 无 total -> null，UI 降级回已加载条数
  }
}
```

3b. 分页段前新增筛选常量与 facets 类型/函数：

```ts
/** valueClass 筛「未评估」的 URL 哨兵值（= value_class IS NULL），与 store 常量同值。 */
export const UNEVALUATED = 'unevaluated'

export interface FacetValue { value: string; count: number }
export interface Facets {
  projects: FacetValue[]
  categories: FacetValue[]
  slugs: FacetValue[]
  valueClasses: FacetValue[]
}

/** GET /api/facets — 四维筛选下拉选项（全局口径，随 3s 轮询刷新）。 */
export async function getFacets(fetchFn: FetchLike = fetch): Promise<Facets> {
  const res = await fetchFn('/api/facets')
  return (await res.json()) as Facets
}
```

3c. `listMemoriesPage` 改为：

```ts
export async function listMemoriesPage(
  fetchFn: FetchLike = fetch,
  opts: { status: string; project?: string; slug?: string; category?: string; valueClass?: string } & PageOpts = { status: '' },
): Promise<PageDto<MemoryItem>> {
  const p = pageParams(opts)
  p.set('status', opts.status)
  // status 放最前，与测试锁定的 URL 顺序一致
  const qs = new URLSearchParams()
  qs.set('status', opts.status)
  for (const [k, v] of p) qs.set(k, v)
  // 筛选参数在分页参数之后，非空才拼入（空串 = 不筛该维度）
  if (opts.project) qs.set('project', opts.project)
  if (opts.slug) qs.set('slug', opts.slug)
  if (opts.category) qs.set('category', opts.category)
  if (opts.valueClass) qs.set('valueClass', opts.valueClass)
  return parsePage<MemoryItem>(await fetchFn(`/api/memories?${qs}`))
}
```

3d. `listDiscardsPage` 改为：

```ts
export async function listDiscardsPage(
  fetchFn: FetchLike = fetch,
  opts: { project?: string; category?: string } & PageOpts = {},
): Promise<PageDto<DiscardItem>> {
  const qs = pageParams(opts)
  if (opts.project) qs.set('project', opts.project)
  if (opts.category) qs.set('category', opts.category)
  return parsePage<DiscardItem>(await fetchFn(`/api/discards?${qs}`))
}
```

- [ ] **Step 4: 运行确认绿**

Run: `bun test tests/web-api.test.ts`
Expected: PASS（原有测试 + 新增 4 个；原有 URL 断言顺序不变）

- [ ] **Step 5: 提交**

```bash
git add src/web/api.ts tests/web-api.test.ts
git commit -m "feat(web-api): 筛选参数 URL 拼接 + getFacets + PageDto.total"
```

---

### Task 7: App.tsx 筛选条 + 数据流接线

**Files:**
- Modify: `src/web/App.tsx`（imports；`TabPage` 加 total；filter/facets state + filterRef；`refresh` / `loadMore` 传筛选；`changeFilter`；筛选条 JSX；四处列表头计数；四处空态；新组件 `FilterSelect`）
- Test: `tests/web-ui.test.ts`（追加源码层文本断言）

**Interfaces:**
- Consumes: Task 2 `MemoryFilter` / `EMPTY_MEMORY_FILTER` / `hasActiveFilter` / `projectDisplayName`；Task 6 `getFacets` / `UNEVALUATED` / `Facets` / 分页函数筛选 opts / `PageDto.total`；既有 `VALUE_LABEL`（App.tsx 模块顶层）。
- Produces: 用户可见的筛选条（四记忆 tab）；无下游代码依赖。

- [ ] **Step 1: 写失败测试**（追加到 `tests/web-ui.test.ts` 末尾）

```ts
// 2026-08-11 四维筛选（spec web-memory-filters §4.3）：筛选条 + 缓存作废 +
// filterRef 防轮换闭包 + 筛选态空态/计数。React 组件不单测，源码文本断言锁
// 接线锚点，refactor 删除即变红。
test('App.tsx wires memory list filters (source text)', () => {
  expect(src).toContain('清除筛选')
  expect(src).toContain('没有符合当前筛选的记录')
  expect(src).toContain('符合当前筛选')
  expect(src).toContain('筛选选项加载失败')
  expect(src).toContain('filterRef')
  expect(src).toContain('hasActiveFilter')
  expect(src).toContain('getFacets')
  expect(src).toContain('projectDisplayName')
  expect(src).toContain('FilterSelect')
})
```

- [ ] **Step 2: 运行确认红**

Run: `bun test tests/web-ui.test.ts -t "filters"`
Expected: FAIL — App.tsx 无这些锚点。

- [ ] **Step 3: 实现**（`src/web/App.tsx`，按下列子步骤顺序改）

**7a. imports**（替换头部三行 import）：

```ts
import {
  listMemoriesPage, listDiscardsPage, listDistillRunsPage, WEB_PAGE_SIZE,
  promoteMemory, patchMemory, getStatus, getSourceInput,
  restoreMemory, archiveMemory, unarchiveMemory, promoteDiscard,
  getDistillRun, getDistillRunSourceInput, getRunDegradations, ackDegradations,
  getLlmSettings, saveLlmSettings, testLlmConnection, testEffectiveLlmConnection,
  fetchJudgeConfig, saveJudgeConfig, startRescan, cancelRescan,
  getFacets, UNEVALUATED,
  bulkRejectUnevaluated as bulkRejectUnevaluatedApi,
  type MemoryItem, type MemsideStatus, type SourceInput, type SourceTurn, type DiscardItem,
  type DistillRunListItem, type LlmSettingsState, type JudgeConfigDto, type Facets,
} from './api'
import { formatMemoryTime, sortCandidatesByTime, formatSourceTurn, formatOutcome, formatRunCounts, llmSourceLabel, originBadge, discardReasonLabel, rescanPercent, degradationKindLabel, formatToolCall, projectDisplayName } from './ui-utils'
import { memoryTabFilter, shouldShowLoading, mergeAppend, mergeRefreshPage, nextCursorAfter, tabTotalCount, isListTab, hasActiveFilter, EMPTY_MEMORY_FILTER, type MemoryTabKey, type MemoryFilter } from './tab-cache'
```

**7b. `TabPage` 加 total**（空页 total=null）：

```ts
interface TabPage<T> { items: T[]; nextCursor: { ts: number; id: string } | null; hasMore: boolean; total: number | null }
function emptyPage<T>(): TabPage<T> { return { items: [], nextCursor: null, hasMore: true, total: null } }
```

**7c. 新 state + filterRef**（`pending` state 之后插入）：

```ts
// 四维筛选（spec 2026-08-11-web-memory-filters §4.3）：跨 tab 共享单一 state；
// 空串 = 不筛该维度。facets = /api/facets 下拉选项（null = 尚未加载成功）。
const [filter, setFilter] = useState<MemoryFilter>(EMPTY_MEMORY_FILTER)
const [facets, setFacets] = useState<Facets | null>(null)
const filterRef = useRef<MemoryFilter>(filter)
```

并在 `loadMoreRef` 同步 effect（`useEffect(() => { loadMoreRef.current = loadMore })`）旁加：

```ts
// filterRef 每渲染同步（loadMoreRef 同模式）：轮询 interval 捕获建 effect 那帧
// 的 refresh 闭包，闭包读 filter state 会拿陈旧值；一律读 ref（spec 失败模式 F5）。
useEffect(() => { filterRef.current = filter })
```

**7d. `refresh` 重写**（加 `filterOverride` 参数 + facets 便车 + total 入缓存）：

```ts
async function refresh(target: TabKey, filterOverride?: MemoryFilter) {
  if (!isListTab(target)) return // settings tab 无列表数据流（spec settings-tab §3.2）
  const f = filterOverride ?? filterRef.current
  setPending((p) => ({ ...p, [target]: true }))
  try {
    if (target === 'discards') {
      const [pg, st, fc] = await Promise.all([
        listDiscardsPage(fetch, { limit: WEB_PAGE_SIZE, project: f.project, category: f.category }),
        getStatus(),
        getFacets().catch(() => null), // facets 失败不拖垮列表刷新（spec 失败模式 F6）
      ])
      setDiscards((d) => ({ ...mergeRefreshPage(d, pg, (x) => x.id), total: pg.total ?? null }))
      setStatus(st)
      if (fc) setFacets(fc)
    } else if (target === 'runs') {
      const [pg, st] = await Promise.all([listDistillRunsPage(fetch, { limit: WEB_PAGE_SIZE }), getStatus(fetch)])
      setRuns((r) => mergeRefreshPage(r, pg, (x) => x.distillJobId))
      setStatus(st)
    } else {
      const [pg, st, fc] = await Promise.all([
        listMemoriesPage(fetch, {
          status: memoryTabFilter(target as MemoryTabKey), limit: WEB_PAGE_SIZE,
          project: f.project, slug: f.slug, category: f.category, valueClass: f.valueClass,
        }),
        getStatus(),
        getFacets().catch(() => null),
      ])
      setMemCache((c) => ({
        ...c,
        [target as MemoryTabKey]: { ...mergeRefreshPage(c[target as MemoryTabKey], pg, (x) => x.id), total: pg.total ?? null },
      }))
      setStatus(st)
      if (fc) setFacets(fc)
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

**7e. `loadMore` 传筛选**：函数体开头加 `const f = filterRef.current`，两处列表请求改为：

```ts
      if (target === 'discards') {
        const pg = await listDiscardsPage(fetch, { limit: WEB_PAGE_SIZE, before, project: f.project, category: f.category })
        setDiscards((d) => ({ items: mergeAppend(d.items, pg.items, (x) => x.id), nextCursor: pg.nextCursor, hasMore: pg.hasMore, total: d.total }))
      } else if (target === 'runs') {
        const pg = await listDistillRunsPage(fetch, { limit: WEB_PAGE_SIZE, before })
        setRuns((r) => ({ items: mergeAppend(r.items, pg.items, (x) => x.distillJobId), nextCursor: pg.nextCursor, hasMore: pg.hasMore, total: r.total }))
      } else {
        const pg = await listMemoriesPage(fetch, {
          status: memoryTabFilter(target as MemoryTabKey), limit: WEB_PAGE_SIZE, before,
          project: f.project, slug: f.slug, category: f.category, valueClass: f.valueClass,
        })
        setMemCache((c) => ({
          ...c,
          [target as MemoryTabKey]: { items: mergeAppend(c[target as MemoryTabKey].items, pg.items, (x) => x.id), nextCursor: pg.nextCursor, hasMore: pg.hasMore, total: c[target as MemoryTabKey].total },
        }))
      }
```

（loadMore 不改 total——计数由轮询 refresh 的页 1 刷新，翻页只前进游标。）

**7f. `changeFilter`**（`bulkRejectUnevaluated` 函数之后插入）：

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

**7g. 筛选条 JSX**（插入位置：全局错误横幅 `</div> ) : null}` 之后、`{/* 列表 - 按 tab 渲染… */}` 注释之前）：

```tsx
{/* 筛选条（spec 2026-08-11-web-memory-filters §4.3）：四个记忆 tab（含 discards）
    可用；runs/settings 不渲染。选项来自 /api/facets（随 3s 轮询刷新，新 slug/
    项目无静默窗口）；facets 未就绪 -> 下拉禁用 + 灰字，不静默。discards tab
    只渲染有对应列的两维（项目/分类）。 */}
{tab === 'candidate' || tab === 'approved' || tab === 'rejected' || tab === 'discards' ? (
  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16, padding: 10, border: '1px solid #e0e0e0', borderRadius: 8, background: '#fafafa' }}>
    <FilterSelect label="项目" disabled={facets === null} value={filter.project}
      onChange={(v) => changeFilter({ ...filter, project: v })}
      options={(facets?.projects ?? []).map((p) => ({
        value: p.value,
        label: `${projectDisplayName(p.value, (facets?.projects ?? []).map((x) => x.value))} (${p.count})`,
        title: p.value,
      }))} />
    <FilterSelect label="分类" disabled={facets === null} value={filter.category}
      onChange={(v) => changeFilter({ ...filter, category: v })}
      options={(facets?.categories ?? []).map((p) => ({ value: p.value, label: `${p.value} (${p.count})` }))} />
    {tab !== 'discards' ? (
      <>
        <FilterSelect label="slug" disabled={facets === null} value={filter.slug}
          onChange={(v) => changeFilter({ ...filter, slug: v })}
          options={(facets?.slugs ?? []).map((p) => ({ value: p.value, label: `${p.value} (${p.count})` }))} />
        <FilterSelect label="价值筐" disabled={facets === null} value={filter.valueClass}
          onChange={(v) => changeFilter({ ...filter, valueClass: v })}
          options={(facets?.valueClasses ?? []).map((p) => ({
            value: p.value,
            label: `${p.value === UNEVALUATED ? '未评估' : VALUE_LABEL[p.value] ?? p.value} (${p.count})`,
          }))} />
      </>
    ) : null}
    {facets === null ? (
      <span style={{ fontSize: 12, color: '#888' }}>筛选选项加载失败，稍后自动重试</span>
    ) : null}
    {hasActiveFilter(filter) ? (
      <button onClick={() => changeFilter(EMPTY_MEMORY_FILTER)}>清除筛选</button>
    ) : null}
  </div>
) : null}
```

**7h. 四处列表头计数**（筛选激活 -> 服务端 total；无筛选 -> 维持 status 全局计数）：

候选 tab：

```tsx
<p>{hasActiveFilter(filter)
  ? `共 ${memCache.candidate.total ?? memItems.length} 条符合当前筛选`
  : `${tabTotalCount(status, 'candidate') ?? memItems.length} 条候选记忆待审`}</p>
```

已审批 tab（`条已审批记忆`）、已拒绝 tab（`条已拒绝记忆`）同型，分别读
`memCache.approved.total` / `memCache.rejected.total`。AI自动拒绝 tab：

```tsx
<p>{hasActiveFilter(filter)
  ? `共 ${discards.total ?? discards.items.length} 条符合当前筛选`
  : `${tabTotalCount(status, 'discards') ?? discards.items.length} 条 AI 自动拒绝记录`}</p>
```

蒸馏记录 tab 的 `<p>` 不动。tab 顶部计数徽标（`tabs` 数组）不动——导航用途，全局口径。

**7i. 四处空态**（筛选激活 -> 「无匹配 + 清除」；否则原文案）。候选 tab 示例：

```tsx
{memItems.length === 0 && !showLoading && (
  hasActiveFilter(filter) ? (
    <p style={{ color: '#666' }}>
      没有符合当前筛选的记录 <button onClick={() => changeFilter(EMPTY_MEMORY_FILTER)}>清除筛选</button>
    </p>
  ) : (
    <p style={{ color: '#666' }}>
      暂无候选记忆。结束一个 claude code 会话后,后台会异步提炼(distill 约 15-30s),候选记忆会自动出现在这里。上方状态栏可看后台进度。
    </p>
  )
)}
```

已审批（原文案「暂无已审批记忆」）、已拒绝（「暂无已拒绝记忆」）同型（用
`memItems.length`）；AI自动拒绝 tab 用 `discards.items.length === 0` +
原文案「暂无 AI 自动拒绝记录」。

**7j. `FilterSelect` 组件**（追加到文件末尾，`DistillRunModal` 之后）：

```tsx
/**
 * 筛选条下拉（spec 2026-08-11-web-memory-filters §4.3）：首项「全部」= 不筛
 * 该维度；选项来自 /api/facets 动态生成带计数。
 */
function FilterSelect({ label, value, onChange, options, disabled }: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string; title?: string }[]
  disabled?: boolean
}) {
  return (
    <label style={{ fontSize: 13, color: '#444' }}>
      {label}{' '}
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} style={{ fontSize: 13 }}>
        <option value="">全部</option>
        {options.map((o) => (
          <option key={o.value} value={o.value} title={o.title}>{o.label}</option>
        ))}
      </select>
    </label>
  )
}
```

- [ ] **Step 4: 运行确认绿 + 类型检查**

Run: `bun test tests/web-ui.test.ts && bun run typecheck`
Expected: PASS；tsc 无报错。

- [ ] **Step 5: 提交**

```bash
git add src/web/App.tsx tests/web-ui.test.ts
git commit -m "feat(web): 四 tab 记忆列表筛选条（项目/slug/分类/价值筐）+ 缓存作废 + filterRef"
```

---

### Task 8: 全量验证 + STATE.md + push + PR

**Files:**
- Modify: `STATE.md`（追加本节记录）

**Interfaces:**
- Consumes: Task 1-7 全部产出。
- Produces: 可合并的 PR。

- [ ] **Step 1: 全量门槛**

Run: `bun run typecheck && bun test`
Expected: 全绿（原 718+ 测试 + 本计划新增全部通过；任何红 case 必须修复，不允许「重跑就过」）。

- [ ] **Step 2: STATE.md 追加章节**（文件末尾，风格对齐既有章节：背景一段 + 编号要点 + 执行方式 + 测试结果 + deferred minor）

内容要点：需求背景（分页架构下无法定位记忆，live DB 3135 条候选/已拒跨多项目）；
四维服务端筛选（项目=source_cwd 精确匹配 / slug / title category 前缀 instr /
价值六筐含 unevaluated 哨兵筛 NULL）；discards tab 两维；`GET /api/facets`
全局口径、项目/分类 UNION 两表、随 3s 轮询刷新；分页响应加 total（筛选态列表头
诚实计数）；改筛选 = 四记忆 tab 缓存作废 + filterRef 防轮换闭包；
无 schema 迁移、注入链路零改动。执行方式与测试计数按实际填写。

- [ ] **Step 3: 提交并推送**

```bash
git add STATE.md
git commit -m "docs(state): Web 记忆列表多维筛选收尾"
git push -c http.sslBackend=openssl -u origin feat/web-memory-filters
```

- [ ] **Step 4: 开 PR**

```bash
gh pr create --base master --head feat/web-memory-filters \
  --title "feat(web): 记忆列表多维筛选（项目/slug/分类/价值筐）" \
  --body "spec: docs/superpowers/specs/2026-08-11-web-memory-filters-design.md
plan: docs/superpowers/plans/2026-08-11-web-memory-filters.md

四个记忆 tab（候选/已审批/已拒绝/AI自动拒绝）支持服务端多维筛选：
- 项目（source_cwd 精确匹配，live DB 最多维度）
- slug（subject_slug）
- 分类（title 的 [category:xxx] 前缀，数据驱动含幻觉值）
- 价值六筐（value_class，含「未评估」哨兵筛 NULL）
每维单选下拉 AND 组合；选项来自新 GET /api/facets（UNION memories+discards，
随 3s 轮询刷新）；筛选激活时列表头显示服务端 COUNT（total 字段）。
分页架构下客户端筛选必错，故全部下沉服务端。无 schema 迁移。

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## Self-Review 记录（计划作者自查）

1. **Spec 覆盖**：§4.1（Task 1/3/4）✓；§4.2（Task 5）✓；§4.3（Task 2/6/7）✓；
   §4.4 数据流（Task 7 refresh/loadMore/changeFilter）✓；§5 失败模式 F1-F9
   逐项落位（F1→Task 7d 轮询便车；F2→Task 7f；F3→spec 文档化无代码；
   F4→Task 3 instr 闭括号 + Task 4 数据驱动 facets 测试；F5→Task 7c/7d；
   F6→Task 7d catch→null + 灰字；F7→无索引决策；F8→Task 3 游标+筛选测试；
   F9→Task 6 total??null + getFacets catch 测试）✓；§6 测试策略八条全部对应
   Task 1-7 的测试步骤 ✓。
2. **占位符扫描**：无 TBD/TODO；每个代码步骤含完整代码块。
3. **类型一致性**：`MemoryListFilter`（Task 3 定义，Task 5 import type）；
   `PageWithTotal`（Task 3）；`Facets/FacetValue/FACET_LIST_CAP`（Task 4 定义，
   Task 5 消费）；`UNEVALUATED`/`VALUE_CLASS_UNEVALUATED` 同值 'unevaluated'
   （Task 3/6）；`MemoryFilter`/`EMPTY_MEMORY_FILTER`/`hasActiveFilter`
   （Task 2 定义，Task 7 消费）；`projectDisplayName`（Task 2 定义，Task 7 消费）；
   `TabPage.total`（Task 7b）与 `PageDto.total`（Task 6）名字一致。
