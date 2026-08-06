# Web UI tab 切换缓存（stale-while-revalidate）设计 spec

- 日期：2026-08-06
- 状态：已批准（brainstorming 逐节确认）
- 关联 plan：`docs/superpowers/plans/2026-08-06-tab-switch-cache.md`

## 背景与问题

Web UI（`src/web/App.tsx`）的 5 个 tab（候选审批 / 已审批 / 已拒绝 / AI自动拒绝 / 蒸馏记录）切换很卡：**每个 tab 切换约 2s**。

根因在 `App.tsx` 的 tab 模型（`App.tsx:50-110`）：

1. **切 tab 必清空**：`useEffect([tab])`（`App.tsx:101-110`）里切 tab 时 `setItems([])`、`setDiscards([])`、`setRuns([])` 把**所有**列表清空。
2. **切 tab 必 loading**：`setLoading(true)` -> 渲染「加载中…」。
3. **切 tab 必全量重拉**：`refresh()` 对激活 tab 走一次完整网络往返。
4. **数据不缓存**：`items/discards/runs` 三个 state 只保存当前激活 tab 的数据，切走即丢。回访某 tab 仍要重新拉。

服务端端点（`src/server.ts:357-487`）都是轻量 SQLite 查询（毫秒级），瓶颈不在服务端查询本身；约 2s 主要来自「必清空 + 必 loading + 必全量重拉」造成的每次切换都付一次完整往返 + loading 闪烁，且 daemon 单线程事件循环被 LLM distill 调用阻塞时会进一步放大。

**目标**：回访 tab 切换渲染 <100ms（直接渲染已缓存数据，无网络等待、无 loading 闪烁）；首次进入某 tab 仍拉取。

**非目标**：
- 不做 5 tab 后台常驻轮询（方案 A）——请求量 ×5 会戳在 daemon 单线程事件循环软肋上。
- 不优化服务端查询（端点已毫秒级）。
- 不消除「首次进入某 tab」的 ~2s（无缓存可显，仅此一次可接受）。

## 决策记录

1. **方案 B（stale-while-revalidate）**：数据按 tab 缓存，切 tab 不清空、不强制 loading；回访直接渲染缓存，同时后台刷新一次。只轮询激活 tab（请求量不变）。
2. **loading 语义**：仅当 `!loaded[tab] && pending[tab]`（该 tab 无缓存且在拉取）时显示「加载中…」；有缓存时即便后台刷新也不闪 loading。
3. **缓存结构**：分开三个 typed state（`memCache` 按记忆 tab 键控 + `discards` + `runs`），不用 `Record<TabKey, unknown>` 强转，类型清晰。
4. **stale-write 防护**：写回按 tab 键隔离，天然不再互相覆盖；共享的 `status` 保留轻量处理（last-wins 可接受，仅 transient）。

## 接口契约

### 纯函数（新文件 `src/web/tab-cache.ts`）

```ts
export type MemoryTabKey = 'candidate' | 'approved' | 'rejected'

/** 记忆 tab -> listMemories 的 status filter（原 App.tsx refresh 内联逻辑抽出） */
export function memoryTabFilter(tab: MemoryTabKey): string
// candidate -> 'candidate'
// approved  -> 'approved,archived,superseded'
// rejected  -> 'rejected'

/** 该 tab 是否已有缓存（决定是否渲染 stale 数据） */
export function hasCachedData(loaded: Record<TabKey, boolean>, tab: TabKey): boolean
// loaded[tab] 为 true

/** 是否显示「加载中…」：仅无缓存且在拉取时 */
export function shouldShowLoading(
  loaded: Record<TabKey, boolean>,
  pending: Record<TabKey, boolean>,
  tab: TabKey,
): boolean
// !loaded[tab] && pending[tab]
```

> `TabKey = 'candidate' | 'approved' | 'rejected' | 'discards' | 'runs'`（App.tsx 现有类型，纯函数以 `import type` 引用或同位定义）。

### `App.tsx` state 重构

替换 `items/discards/runs/loading` 四份单值 state：

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
```

### `refresh(target)` 重构

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

### `useEffect([tab])` 重构

```ts
useEffect(() => {
  setError(null)
  void refresh(tab)                       // 切 tab：立即后台刷新（不清缓存、不设 loading）
  const t = setInterval(() => void refresh(tab), 3000)  // 只轮询激活 tab
  return () => clearInterval(t)
}, [tab])
```

- 删除 `setItems([])/setDiscards([])/setRuns([])/setLoading(true)`（不再清空）。
- 首次进入某 tab 时 `loaded[tab]` 为 false 且 `pending[tab]` 为 true -> 显「加载中…」；回访时 `loaded[tab]` 为 true -> 直接渲染缓存。

### 渲染读取

当前列表按 tab 从缓存取：

```ts
const memItems = sortCandidatesByTime(memCache[tab as MemoryTabKey] ?? [])  // 记忆 tab
const listEmpty = tab === 'discards' ? discards.length === 0
  : tab === 'runs' ? runs.length === 0
  : (memCache[tab as MemoryTabKey] ?? []).length === 0
const showLoading = shouldShowLoading(loaded, pending, tab)
```

- 「加载中…」条件由 `loading && listEmpty` 改为 `showLoading && listEmpty`。
- 其余（MemoryCard / DiscardCard / DistillRunRow / 状态栏 / 操作函数）不变；操作后的 `refresh()` 改为 `refresh(tab)`。

## 数据流

```
切 tab（setTab） -> useEffect([tab]) -> refresh(tab)
  ├─ pending[tab]=true
  ├─ 拉 list + status
  ├─ 写 memCache[tab]/discards/runs + status，loaded[tab]=true
  └─ pending[tab]=false
渲染：tab 有缓存 -> 立即渲染 stale；无缓存 -> 显「加载中…」
3s 轮询只作用于激活 tab（每 3s refresh(tab)）
```

## 与现有模块的耦合点

| 模块 | 改动 |
|------|------|
| `src/web/tab-cache.ts` | **新增**：`memoryTabFilter` / `hasCachedData` / `shouldShowLoading` 纯函数 |
| `src/web/App.tsx` | state 重构（memCache/discards/runs/loaded/pending）；`refresh(target)`；`useEffect([tab])`；渲染读取改从缓存 |
| `src/web/api.ts` | 不变（listMemories 已支持 filter） |
| `tests/tab-cache.test.ts` | **新增**：纯函数测试 |
| `tests/web-ui.test.ts` | 追加源码文本断言（loading 语义锚点） |
| 服务端全部 | 不变 |

## 失败模式与降级

- **首 tab 首次加载**：仍 ~2s（无缓存可显），仅一次，接受。
- **fetch 失败**：`loaded[tab]` 不变 -> 保留旧缓存/空态；`error` 横幅照常显示（不静默 stall）。
- **两次 fetch 竞态**：各自写自己 tab 的缓存槽，键隔离不互相覆盖；共享 `status` last-wins（transient，可接受）。
- **切 tab 后旧 tab fetch 返回**：写旧 tab 自己的槽，不影响新 tab 视图（无 stale-write 覆盖问题）。

## 测试策略

1. **`memoryTabFilter` 纯函数**：candidate/approved/rejected 三映射（`tests/tab-cache.test.ts`）。
2. **`shouldShowLoading` 纯函数**：无缓存+在拉 = true；有缓存 = false（含有缓存还在拉）；无缓存不在拉 = false（`tests/tab-cache.test.ts`）。
3. **`hasCachedData` 纯函数**：loaded 真值判断（`tests/tab-cache.test.ts`）。
4. **UI 层最低限度文本断言**：App.tsx 有 `shouldShowLoading` / `memCache` / 不再 `setItems([])`（`tests/web-ui.test.ts`）。
5. **回归**：既有 `tests/web-ui.test.ts` 全绿（tab 标签、DiscardCard、蒸馏记录等锚点不动）。

门槛：`bun run typecheck && bun test` 全绿。

## 验收清单

- [ ] 回访某 tab：切走再切回直接渲染缓存，<100ms，无「加载中…」闪烁。
- [ ] 首次进入某 tab：显「加载中…」，加载完成后正常展示。
- [ ] 切 tab 不再清空其他 tab 已加载的数据（切换不丢缓存）。
- [ ] 3s 轮询只作用于激活 tab（请求量不变）。
- [ ] 操作（approve/reject/archive/restore/promote）后对应 tab 缓存即时刷新。
- [ ] fetch 失败保留旧缓存且显错误横幅（不静默白页）。
- [ ] `bun run typecheck && bun test` 全绿。