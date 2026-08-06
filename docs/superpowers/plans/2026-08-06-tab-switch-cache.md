# Web UI tab 切换缓存实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Web UI 的 tab 切换回访 <100ms——数据按 tab 缓存，切 tab 不清空、不强制 loading，直接渲染缓存 + 后台刷新（stale-while-revalidate）。

**Architecture:** 新增 `src/web/tab-cache.ts` 纯函数（`memoryTabFilter`/`hasCachedData`/`shouldShowLoading`）；`App.tsx` 把 `items/discards/runs/loading` 四份单值 state 重构为 `memCache`（按记忆 tab 键控）+ `discards` + `runs` + `loaded` + `pending`，`refresh(target)` 按 tab 写缓存槽，`useEffect([tab])` 不再清空改后台刷新，只轮询激活 tab。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite + zod；前端 Vite + React 19。测试用 `bun test`。

## Global Constraints

- 测试一律 `bun test`，严禁 `npm test`（CLAUDE.md）。
- 分支 + PR，严禁直推 master；基线从 `origin/master` 切；命名 `perf/tab-switch-cache`。
- `bun run typecheck && bun test` 必须全绿才能 push。
- 免 brainstorming 的例外不适用本改动（触及生产代码，必须带测试）。
- 服务端不动；只改 `src/web/` 与新增纯函数模块。
- 保持 Web UI 自绘样式（CLAUDE.md），不复用新框架。

---

### Task 1: 新增 `src/web/tab-cache.ts` 纯函数 + 测试

**Files:**
- Create: `src/web/tab-cache.ts`
- Create: `tests/tab-cache.test.ts`

**Interfaces:**
- Produces: `MemoryTabKey` 类型；`memoryTabFilter(tab)`；`hasCachedData(loaded, tab)`；`shouldShowLoading(loaded, pending, tab)`。
- Consumes: 无（纯函数，零依赖）。

- [ ] **Step 1: 写新测试**（`tests/tab-cache.test.ts`）

```ts
import { test, expect } from 'bun:test'
import { memoryTabFilter, hasCachedData, shouldShowLoading, type MemoryTabKey } from '../src/web/tab-cache'

// tab 缓存（2026-08-06）：记忆 tab -> listMemories filter 映射。
// 一旦 refactor 改错 approved 的 filter（漏 archived/superseded）即变红。
test('memoryTabFilter 映射三个记忆 tab 的 status filter', () => {
  expect(memoryTabFilter('candidate')).toBe('candidate')
  expect(memoryTabFilter('approved')).toBe('approved,archived,superseded')
  expect(memoryTabFilter('rejected')).toBe('rejected')
})

// shouldShowLoading：仅「无缓存 + 在拉取」才显 loading；有缓存不闪。
test('shouldShowLoading 仅无缓存且在拉取时 true', () => {
  const loaded = { candidate: false, approved: true, rejected: true, discards: true, runs: true }
  const pending = { candidate: true, approved: true, rejected: false, discards: false, runs: false }
  expect(shouldShowLoading(loaded, pending, 'candidate')).toBe(true)  // 无缓存+在拉
  expect(shouldShowLoading(loaded, pending, 'approved')).toBe(false)  // 有缓存（后台刷新不闪）
  expect(shouldShowLoading(loaded, pending, 'rejected')).toBe(false)  // 缓存已就绪
})

test('hasCachedData 返回 loaded[tab]', () => {
  const loaded = { candidate: true, approved: false, rejected: false, discards: false, runs: false }
  expect(hasCachedData(loaded, 'candidate')).toBe(true)
  expect(hasCachedData(loaded, 'approved')).toBe(false)
})

// 类型守卫：记忆 tab 是 TabKey 子集（编译期验证，运行时无执行）
const _t: MemoryTabKey = 'candidate'
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/tab-cache.test.ts`
Expected: FAIL（模块不存在 / 导入失败）。

- [ ] **Step 3: 实现**（`src/web/tab-cache.ts`）

```ts
/**
 * Web UI tab 缓存纯函数（2026-08-06）。
 * App.tsx 切 tab 用 stale-while-revalidate：数据按 tab 缓存，回访直接渲染缓存 +
 * 后台刷新。本模块收拢「tab -> filter 映射」与「loading 语义」两个可测纯逻辑。
 */

export type MemoryTabKey = 'candidate' | 'approved' | 'rejected'

export function memoryTabFilter(tab: MemoryTabKey): string {
  if (tab === 'candidate') return 'candidate'
  if (tab === 'approved') return 'approved,archived,superseded'
  return 'rejected'
}

export function hasCachedData(loaded: Record<string, boolean>, tab: string): boolean {
  return loaded[tab] === true
}

export function shouldShowLoading(
  loaded: Record<string, boolean>,
  pending: Record<string, boolean>,
  tab: string,
): boolean {
  return !hasCachedData(loaded, tab) && pending[tab] === true
}
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test tests/tab-cache.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/web/tab-cache.ts tests/tab-cache.test.ts
git commit -m "feat(web): tab 切换缓存纯函数（memoryTabFilter/shouldShowLoading）"
```

---

### Task 2: `App.tsx` — state 重构 + `refresh(target)` + 渲染读取

**Files:**
- Modify: `src/web/App.tsx`
- Test: `tests/web-ui.test.ts`（追加文本断言）

**Interfaces:**
- Consumes: `src/web/tab-cache.ts` 的 `memoryTabFilter` / `shouldShowLoading`（Task 1）。
- Produces: `memCache/discards/runs/loaded/pending` state；`refresh(target: TabKey)`；渲染从缓存读取。

- [ ] **Step 1: 先追加文本断言（红）**（`tests/web-ui.test.ts` 末尾）

```ts
// tab 切换缓存（2026-08-06）：App.tsx 必须走 shouldShowLoading 语义 + 用 memCache，
// 且不得再在切 tab 时 setItems([])/setLoading(true)（那是 2s 卡顿根因）。
// 源码文本断言锁锚点，回归即变红。
test('App.tsx stale-while-revalidate：用 memCache + shouldShowLoading，不再清空切 tab', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')
  expect(src).toContain('shouldShowLoading')
  expect(src).toContain('memCache')
  expect(src).toContain('memoryTabFilter')
  expect(src).not.toContain('setItems([])')
  expect(src).not.toContain('setLoading(true)')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/web-ui.test.ts`
Expected: 新用例 FAIL（App.tsx 尚无 shouldShowLoading / memCache，仍有 setItems([])）。

- [ ] **Step 3: 实现**（`src/web/App.tsx`）

（a）import 加：

```ts
import { memoryTabFilter, shouldShowLoading, type MemoryTabKey } from './tab-cache'
```

（b）state 重构（替换 `App.tsx:51-55,57` 的 `items/discards/runs/loading`）：

```ts
const [tab, setTab] = useState<TabKey>('candidate')
const [memCache, setMemCache] = useState<Record<MemoryTabKey, MemoryItem[]>>({
  candidate: [], approved: [], rejected: [],
})
const [discards, setDiscards] = useState<DiscardItem[]>([])
const [runs, setRuns] = useState<DistillRunListItem[]>([])
const [loaded, setLoaded] = useState<Record<TabKey, boolean>>({ candidate: false, approved: false, rejected: false, discards: false, runs: false })
const [pending, setPending] = useState<Record<TabKey, boolean>>({ candidate: false, approved: false, rejected: false, discards: false, runs: false })
const [status, setStatus] = useState<MemsideStatus | null>(null)
const [error, setError] = useState<string | null>(null)
const [sourceInputFor, setSourceInputFor] = useState<string | null>(null)
const [runDetailFor, setRunDetailFor] = useState<string | null>(null)
// 删除 tabRef（stale-write 已由 per-tab 缓存键隔离解决）
```

（c）`refresh` 改为按 target 写缓存槽（替换 `App.tsx:65-97`）：

```ts
async function refresh(target: TabKey) {
  setPending((p) => ({ ...p, [target]: true }))
  try {
    if (target === 'discards') {
      const [ds, st] = await Promise.all([listDiscards(), getStatus()])
      setDiscards(ds); setStatus(st)
    } else if (target === 'runs') {
      const [runItems, st] = await Promise.all([listDistillRuns(fetch), getStatus(fetch)])
      setRuns(runItems); setStatus(st)
    } else {
      const [mems, st] = await Promise.all([listMemories(fetch, memoryTabFilter(target)), getStatus()])
      setMemCache((c) => ({ ...c, [target]: mems }))
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

（d）`useEffect([tab])` 重构（替换 `App.tsx:101-110`）：

```ts
useEffect(() => {
  setError(null)
  void refresh(tab)
  const t = setInterval(() => void refresh(tab), 3000)
  return () => clearInterval(t)
}, [tab])
```

（e）渲染读取（替换 `App.tsx:152-155`）：

```ts
const memItems = sortCandidatesByTime(memCache[tab as MemoryTabKey] ?? [])
const jobs = status?.jobs ?? {}
const running = (jobs.running ?? 0) + (jobs.pending ?? 0)
const listEmpty = tab === 'discards' ? discards.length === 0
  : tab === 'runs' ? runs.length === 0
  : (memCache[tab as MemoryTabKey] ?? []).length === 0
const showLoading = shouldShowLoading(loaded, pending, tab)
```

（f）「加载中…」条件（`App.tsx:263`）由 `loading && listEmpty` 改为 `showLoading && listEmpty`。

（g）操作函数（`App.tsx:112-148`）内 `void refresh()` 改为 `void refresh(tab)`。

- [ ] **Step 4: 运行确认通过（含 typecheck + 全量回归）**

Run: `bun run typecheck && bun test`
Expected: 全绿（新用例 + 既有 tab/列表/操作锚点用例）。

- [ ] **Step 5: Commit**

```bash
git add src/web/App.tsx src/web/tab-cache.ts tests/web-ui.test.ts
git commit -m "perf(web): tab 切换 stale-while-revalidate（缓存 + 不闪 loading）"
```

---

## Self-Review

**Spec coverage：**
- 纯函数 `memoryTabFilter`/`hasCachedData`/`shouldShowLoading`（`src/web/tab-cache.ts`）→ Task 1。
- `App.tsx` state 重构（memCache/discards/runs/loaded/pending）+ `refresh(target)` + `useEffect([tab])` 不清空 + 渲染读缓存 + 操作函数 `refresh(tab)` → Task 2。
- loading 语义（仅 `!loaded && pending`）→ Task 1 `shouldShowLoading` + Task 2 渲染接线。
- 测试策略 1-4 映射到 Task 1（纯函数）+ Task 2（文本断言）。

**Placeholder scan：** 无 TBD/TODO；每步含具体代码。

**Type consistency：** `MemoryTabKey` 在 Task 1 定义、Task 2 import 使用；`refresh(target: TabKey)` 签名在 step (c)/(d)/(g) 一致；`memCache` 键控 `Record<MemoryTabKey, MemoryItem[]>`，渲染侧 `memCache[tab as MemoryTabKey]` 一致。

**Note on `.superpowers/sdd`：** 本设计经对话内 brainstorming 完成，未在 `.superpowers/sdd/` 产生中间产物（该目录仅预置 `.gitignore`），无需清理。