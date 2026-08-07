# Web UI 五 tab 统一无限滚动分页设计 spec

- 日期：2026-08-07
- 状态：已批准（brainstorming 逐节确认）
- 前置 spec：`docs/superpowers/specs/2026-08-06-tab-switch-cache-design.md`（tab 切换缓存，本 spec 在其缓存结构上演进）
- 关联 plan：`docs/superpowers/plans/2026-08-07-tab-list-pagination.md`

## 背景与问题

Web UI（`src/web/App.tsx`）5 个 tab 的列表加载是一次性全量：

- `GET /api/memories`（`src/server.ts:419-427`）**无 LIMIT**，按 status 过滤后整表返回。
  本机 live DB 实测：rejected 2554 行（~630KB 文本）、candidate 538 行（~137KB）。
- `GET /api/discards` / `GET /api/distill-runs` 服务端硬 `LIMIT 200`（`store.ts:491`、
  `store.ts:653`），更早历史在 UI 不可见。
- 3s 轮询每次都重拉激活 tab 的**完整列表**。

由此产生三层成本，且随数据量线性增长：

1. **DB/网络**：全量行 + 全量 payload 序列化传输（rejected tab ~630KB / 次，每 3s 一次）。
2. **JSON 解析**：浏览器每 3s 解析全量数组。
3. **React 渲染**：首次进入 tab 时一次性挂载全部卡片（rejected tab 2554 个 `MemoryCard`），
   这是首屏卡顿的主因。

**目标**：

- 五个 tab（候选审批 / 已审批 / 已拒绝 / AI自动拒绝 / 蒸馏记录）**统一**改为服务端游标分页 +
  前端无限滚动；首屏只加载一页（50 条），首次进入 tab 的加载与渲染成本与数据总量脱钩。
- 3s 轮询只刷第 1 页，新条目照常实时出现。
- 全量历史仍可到达（滚动翻页），不丢「已拒绝 / AI自动拒绝 / 蒸馏记录」的老数据
  （用户明确要求：不要 LIMIT 200 硬截断，所有 tab 统一无限滚动）。

**非目标**：

- 不动 `/api/status` 的全表计数扫描（SQLite 毫秒级，非瓶颈）。
- 不动 tab 切换缓存语义（stale-while-revalidate，见前置 spec），本 spec 只把每 tab
  的缓存值从「全量数组」升级为「分页结构」。
- 不做虚拟滚动（react-window 类）；分批挂载已足够，不引入新依赖。
- 不动注入链路（`formatMemoryBlock` / `clipByBudget` / adapter）。

## 决策记录

1. **交互：无限滚动**（用户拍板）。底部哨兵元素 + `IntersectionObserver` 触底自动追加；
   不做「加载更多」按钮、不做页码分页器。
2. **范围：五 tab 统一分页**（用户拍板）。`AI自动拒绝` / `蒸馏记录` 的 LIMIT 200 硬截断
   废除，改为同款游标分页；不带分页参数的旧请求保持旧形状（向后兼容锚点）。
3. **轮询：只刷第 1 页**（用户拍板）。页 1 数据按 id merge 进已加载列表；已翻到的老批次
   不重复拉取。
4. **批量拒绝未评估：服务端按条件批量**（用户拍板）。新增端点，不依赖前端加载了多少，
   按钮语义与现状一致（清空整个未评估尾队）。
5. **游标：复合键 `(sortTs, id)`**，不用 offset。回扫 / 批量插入会同毫秒扎堆，纯 offset
   在翻页间隙有新条目插入时错位；复合键保证不重不漏。
6. **页大小 50**，服务端 clamp 到 `[1, 200]`。
7. **操作后本地移除卡片**：approve/reject/restore/archive 成功后卡片即消失（当前 tab
   已不再属于它），不等轮询；代价是深处卡片操作失败会从视图消失（见失败模式 5）。
8. **批量状态变更后重置缓存**：页 1 merge 只会「留住」已加载条目，无法感知某条目
   已离开当前 tab 的 status 集合（它在页 1 消失 ≠ 被删）。因此两路批量状态变更——
   **回扫完成**（status 轮询检测到 `rs.running` true→false 跳变）与**批量拒绝返回后**——
   直接把 candidate tab 缓存重置为 `EMPTY_PAGE` 再拉页 1，防滞留。单卡操作走本地移除，
   不触发重置。

## 接口契约

### 服务端分页形状（三端点统一）

```
GET /api/memories?status=candidate&limit=50&before=<ms>&beforeId=<id>
GET /api/discards?limit=50&before=<ms>&beforeId=<id>
GET /api/distill-runs?limit=50&before=<ms>&beforeId=<id>

-> { items: [...], hasMore: boolean, nextCursor: { ts: number, id: string } | null }
```

- 排序键：`memories` 用 `createdAt`，`memory_discards` / `memory_distill_runs` 用 `ts`；
  统一记为 `sortTs`，游标字段名对外统一为 `before` / `beforeId`、返回 `nextCursor.ts`。
- **NULL sortTs**：`COALESCE(sortTs, 0)` 参与排序与游标比较（NULL 行排最后，仍可翻到）。
  `nextCursor.ts` 返回 coalesce 后的值。
- **游标条件**：`WHERE sortTs' < ? OR (sortTs' = ? AND id < ?)`（`sortTs'` 为 coalesce 后值），
  `ORDER BY sortTs' DESC, id DESC`。
- **hasMore 探测**：`LIMIT limit+1`，拿到第 limit+1 条则 hasMore=true，返回前 limit 条，
  `nextCursor` 取第 limit 条的 `(sortTs', id)`。
- **limit clamp**：`[1, 200]`，非法值（非数 / 超界）夹取到边界，不 400。
- **非法游标**（before 非数 / beforeId 缺其一）：宽松忽略游标按第一页处理，不 400
  （与 status 非法值宽松忽略同款风格）。
- **向后兼容**：不带 `limit` 参数 → 旧行为旧形状：`/api/memories` 全量 `{ items }`，
  `/api/discards`、`/api/distill-runs` 原 LIMIT 200 `{ items }`。既有测试与旧客户端不受影响。

### store 层（`src/memory/store.ts`）

```ts
export interface PageCursor { ts: number; id: string }
export interface Page<T> { items: T[]; hasMore: boolean; nextCursor: PageCursor | null }

export const MEMORY_PAGE_DEFAULT_LIMIT = 50
export const MEMORY_PAGE_MAX_LIMIT = 200

export async function listMemoriesPage(
  db: DbClient,
  opts: { statuses: MemoryStatus[]; limit?: number; before?: PageCursor },
): Promise<Page<MemoryRow>>

export async function listDiscardsPage(
  db: DbClient,
  opts: { limit?: number; before?: PageCursor } = {},
): Promise<Page<DiscardRow>>

export async function listDistillRunsPage(
  db: DbClient,
  opts: { limit?: number; before?: PageCursor } = {},
): Promise<Page<DistillRunListRow>>

/** 批量拒绝全部「未评估」候选：value_class 不在 6 个保护类内的 status='candidate' 行。
 *  逐行走既有 promoteCandidate(reject) 路径（状态机 + 审计一致），
 *  MemoryNotFound/Conflict 跳过继续（与 server bulk-promote 同款容错）。 */
export async function bulkRejectUnevaluated(db: DbClient): Promise<{ rejected: number }>
```

- 「未评估」谓词 = `value_class IS NULL OR value_class NOT IN
  ('user-rule','decision','preference','convention','trap','topology')`，
  与前端 `priorityRank(...) === 2` 语义一致（6 保护类不动、非候选不动）。
- 旧函数 `listDiscards` / `listRecentDistillRuns` 保留（旧端点路径继续用），新分页函数并列新增。

### server 层（`src/server.ts`）

- `GET /api/memories`：检测到 `limit` 参数 → 走 `listMemoriesPage`；否则旧路径不变。
  status 过滤逻辑（inArray + 非法宽松忽略）原样复用。
- `GET /api/discards`、`GET /api/distill-runs`：同上分流。
- `POST /api/memories/bulk-reject-unevaluated` → `bulkRejectUnevaluated(db)`，
  返回 `{ rejected: N }` + success broadcast WS（与现有写路由一致）。
- `GET /api/status`：新增 `unevaluatedCandidates: number`
  （`COUNT(*) WHERE status='candidate' AND <未评估谓词>`，SQL 级计数）。

### 前端 api.ts

```ts
export interface PageDto<T> { items: T[]; hasMore: boolean; nextCursor: { ts: number; id: string } | null }

export async function listMemoriesPage(
  fetchFn: FetchLike = fetch,
  opts: { status: string; limit?: number; before?: { ts: number; id: string } },
): Promise<PageDto<MemoryItem>>

export async function listDiscardsPage(fetchFn?: FetchLike, opts?: { limit?: number; before?: { ts: number; id: string } }): Promise<PageDto<DiscardItem>>
export async function listDistillRunsPage(fetchFn?: FetchLike, opts?: { limit?: number; before?: { ts: number; id: string } }): Promise<PageDto<DistillRunListItem>>

export async function bulkRejectUnevaluated(fetchFn: FetchLike = fetch): Promise<{ rejected: number }>
```

### 前端纯函数（`src/web/tab-cache.ts` 追加）

```ts
/** 通用合并：第一页（最新数据）优先；已加载列表中 id 不在第一页的条目按原顺序追加。
 *  五 tab 通用，key 选择器适配记忆(id) / discards(id) / runs(distillJobId)。 */
export function mergePage<T>(loaded: T[], firstPage: T[], key: (t: T) => string): T[]

/** 翻页游标推进：返回下一次 loadMore 要带的游标；hasMore=false 时返回 null。 */
export function nextCursorAfter<T>(page: PageDto<T>): { ts: number; id: string } | null
```

### App.tsx state 重构

三个缓存 state 从「数组」升级为「分页结构」，五 tab 形状统一：

```ts
interface TabPage<T> { items: T[]; nextCursor: { ts: number; id: string } | null; hasMore: boolean }

const [memCache, setMemCache] = useState<Record<MemoryTabKey, TabPage<MemoryItem>>>({
  candidate: EMPTY_PAGE, approved: EMPTY_PAGE, rejected: EMPTY_PAGE,
})
const [discards, setDiscards] = useState<TabPage<DiscardItem>>(EMPTY_PAGE)
const [runs, setRuns] = useState<TabPage<DistillRunListItem>>(EMPTY_PAGE)
const [loadingMore, setLoadingMore] = useState<Record<TabKey, boolean>>({...})
const [loadMoreError, setLoadMoreError] = useState<Record<TabKey, string | null>>({...})
```

- `loaded` / `pending` / `status` / `error` 语义不变（前置 spec）。
- `EMPTY_PAGE = { items: [], nextCursor: null, hasMore: true }`（未加载时乐观认为可能有更多，
  首次 refresh 后校正）。

## 数据流

### refresh（tab 切换 + 3s 轮询 + 操作后）

```
refresh(tab):
  pending[tab]=true
  拉第 1 页（limit=50，无游标）+ status
  记忆 tab:  setMemCache(c => { ...c, [tab]: { items: mergePage(c[tab].items, page.items, t=>t.id), nextCursor, hasMore } })
  discards:  setDiscards(d => { items: mergePage(d.items, page.items, t=>t.id), ... })
  runs:      setRuns(r => { items: mergePage(r.items, page.items, t=>t.distillJobId), ... })
  loaded[tab]=true; pending[tab]=false
```

- 旧「全量替换」改为「页 1 merge」；merge 后列表长度只增不减（页 1 新条目插入顶部，
  老条目状态以页 1 数据为准）。**例外（决策 8）**：回扫完成跳变 / 批量拒绝返回时，
  先重置该 tab 缓存为 `EMPTY_PAGE` 再执行本次 refresh，防已批量移出的条目滞留。

### loadMore（无限滚动）

```
loadMore(tab):
  守卫：pending[tab] || loadingMore[tab] || !hasMore -> no-op
  带 nextCursor 拉下一页 -> items 追加到尾部，更新 nextCursor/hasMore
  失败：loadMoreError[tab] = message，底部显「加载更多失败，点击重试」按钮（手动重试，不自动风暴）
```

- 哨兵：列表尾部 `<div ref>`，`useEffect` 里 `new IntersectionObserver`，
  `isIntersecting` 时 `void loadMore(tab)`；切 tab / 卸载 disconnect。
- 五 tab 渲染分支结构相同：卡片 map + 哨兵 + 「加载中…」（loadMore pending）+
  重试行（loadMoreError）+ 末尾提示（`hasMore=false` 且列表非空时显灰色小字
  「没有更多了」）。

### 操作后行为

- `approve / reject / restore / archive / unarchive / promote(discard)`：
  no-throw 契约不变；调用后**本地从对应 tab 列表移除该 id**（成功时它已不属于该 tab），
  再 `void refresh(tab)`（只刷页 1，成本有界）。
- `bulkRejectUnevaluated`：改调新端点 `POST /api/memories/bulk-reject-unevaluated`，
  不再从 `memCache.candidate` 收集 id；按钮可见性与文案由 `status.unevaluatedCandidates`
  驱动（`> 0` 时显示「批量拒绝未评估 (N)」）；返回后 `void refresh(tab)`，
  被拒条目随页 1 merge 消失，计数随 status 轮询归 0。

## 与现有模块的耦合点

| 模块 | 改动 |
|------|------|
| `src/memory/store.ts` | 新增 `listMemoriesPage` / `listDiscardsPage` / `listDistillRunsPage` / `bulkRejectUnevaluated` + `Page`/`PageCursor` 类型 + 页大小常量；旧函数保留 |
| `src/server.ts` | 三列表端点分页分流；新增 `POST /api/memories/bulk-reject-unevaluated`；`/api/status` 加 `unevaluatedCandidates` |
| `src/web/api.ts` | 三个 `list*Page` wrapper + `bulkRejectUnevaluated` wrapper + `PageDto` 类型 |
| `src/web/tab-cache.ts` | 追加 `mergePage` / `nextCursorAfter` 纯函数 |
| `src/web/App.tsx` | 缓存 state 分页化；`refresh` 页 1 merge；`loadMore` + IntersectionObserver 哨兵；操作后本地移除；批量拒绝改服务端端点 + 计数驱动 |
| `tests/store-*.test.ts` | 新增分页 / 批量拒绝用例 |
| `tests/server.test.ts` | 分页契约 + 兼容形状 + bulk-reject + status 新字段 |
| `tests/tab-cache.test.ts` | `mergePage` / `nextCursorAfter` |
| `tests/web-api.test.ts` | URL 拼接 + wrapper |
| `tests/web-ui.test.ts` | 文本断言（哨兵 / 分页缓存结构 / 不再 LIMIT-200 假设） |

## 失败模式与降级

1. **第 1 页拉取失败**：保留该 tab 旧缓存（无缓存则空态）+ 错误横幅，沿用现状契约，
   不静默白页。
2. **loadMore 失败**：`hasMore` 保持 true，底部显「加载更多失败，点击重试」手动重试；
   不自动重试风暴（Observer 只在滚动穿越时触发）。
3. **同毫秒游标撞车**：复合键 `(sortTs, id)` 保证翻页不重不漏。
4. **NULL sortTs**：`COALESCE(..., 0)` 排最后，仍可翻页到达，不丢行。
5. **深处卡片操作失败**：卡片已本地移除，而页 1 轮询覆盖不到它 → 本次会话内该卡不再
   出现（刷新页面恢复）。仅 404/409 低频场景，作为已知权衡接受。
6. **轮询间隙翻到页边界**：merge 按 id 去重，不出现重复卡片。
7. **批量拒绝与轮询并发**：批量拒绝后 `refresh` 刷页 1，被拒条目随 merge 消失；
   `unevaluatedCandidates` 计数随 status 轮询归 0。
8. **旧 UI 连新 daemon / 新 UI 连旧 daemon**：旧 UI 不带 limit → 服务端旧形状，行为不变；
   新 UI 的分页请求旧 daemon 不识别 limit 参数 → 返回全量旧形状，前端 `PageDto` 解析
   `hasMore` 缺省为 false（`?? false`），退化为「一页装全部」，不崩。
9. **页 1 merge 的滞留残余**：某条目在「页 1 之外」被外部改变 status（另一浏览器标签页
   操作、daemon 内部迁移）时，merge 无法感知，该条目滞留当前 tab 视图直至刷新页面。
   已知的两路批量变更已由决策 8 的重置覆盖；其余为低频场景，接受。

## 测试策略

门槛：`bun run typecheck && bun test` 全绿。

1. **store 层**（纯数据断言，主力覆盖）：
   - `listMemoriesPage`：分页边界（limit+1 探测 / hasMore 真假 / nextCursor 值）、
     同毫秒复合键翻页不重不漏、NULL createdAt 排尾可到达、status inArray 过滤、
     空表、limit clamp 上下界。
   - `listDiscardsPage` / `listDistillRunsPage`：同款游标用例（表驱动共享）。
   - `bulkRejectUnevaluated`：只拒未评估候选（6 保护类 valueClass 不动、
     approved/rejected 行不动）、返回计数正确、空队列返回 0。
2. **server 层**：三端点分页契约（带 limit → 分页形状；不带 limit → 旧形状兼容；
   非法游标宽松忽略不 400；limit clamp）；bulk-reject 端点（含 409 容错跳过）；
   `/api/status` 含 `unevaluatedCandidates` 且数值正确。
3. **web 纯函数**（`tests/tab-cache.test.ts` 追加）：`mergePage` 去重 / 顺序保持 /
   第一页数据优先 / 空 loaded；`nextCursorAfter` hasMore 真假两路。
4. **api.ts**（`tests/web-api.test.ts`）：`listMemoriesPage` URL 拼接
   （status/limit/游标 encode）；`bulkRejectUnevaluated` 方法与路径。
5. **web-ui 文本断言兜底**（`tests/web-ui.test.ts`）：App.tsx 含 `IntersectionObserver`、
   五 tab 统一 `nextCursor`/`hasMore` 缓存结构、决策 8 的缓存重置锚点
   （回扫完成跳变检测 + 批量拒绝后重置）；不存在 `memCache: Record<MemoryTabKey, MemoryItem[]>`
   旧全量结构残留。
6. **回归**：既有 `tests/web-ui.test.ts` / `server.test.ts` / `store-crud.test.ts` 全绿
   （无 limit 参数旧行为不变是兼容锚点）。

## 验收清单

- [ ] 首次进入任一 tab：只请求一页（50 条），首屏渲染 ≤50 张卡片。
- [ ] 滚动到底自动追加下一页；已加载全部后不再发请求（hasMore=false）。
- [ ] 3s 轮询只请求第 1 页（抓包可证：无 before 参数），新条目实时出现在顶部。
- [ ] 已拒绝 tab 2300+ 条历史可通过滚动全部到达（不重不漏）。
- [ ] AI自动拒绝 / 蒸馏记录 不再受 LIMIT 200 截断，老数据可翻到。
- [ ] 批量拒绝未评估清空整个未评估尾队（不限于已加载部分），按钮计数来自服务端。
- [ ] 回扫完成 / 批量拒绝后 candidate tab 缓存重置，已移出条目不滞留。
- [ ] 操作（批准/拒绝/恢复/归档/提升）后卡片即时消失，轮询不复活成功操作的卡片。
- [ ] fetch 失败保留旧缓存 + 错误横幅；loadMore 失败显重试按钮。
- [ ] 不带 limit 的旧请求行为逐字节不变（兼容）。
- [ ] `bun run typecheck && bun test` 全绿。
