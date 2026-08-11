# 记忆列表筛选按 tab 圈定（per-tab facets + 独立筛选态）设计 spec

日期：2026-08-11
前序：`docs/superpowers/specs/2026-08-11-web-memory-filters-design.md`（PR #56 已合并）
状态：用户反馈驱动的设计修订——**推翻前序 spec 决策 D2（facets 全局口径）与 §4.3 的跨 tab 共享筛选 state**。

## 1. 背景

PR #56 给四个记忆 tab 落了服务端四维筛选，其中两个决策在真实数据下体验错误：

1. **facets 全局口径（前序决策 D2）**：`GET /api/facets` 把 memories 全状态 + memory_discards
   混合统计，四个 tab 的下拉选项与计数完全一样。
2. **筛选 state 跨 tab 共享（前序 §4.3）**：一个 tab 选的筛选条件切 tab 后继续生效。

用户实测反馈：「所有 tab 的筛选全是候选审批这一个 tab 的」。live DB 取证（2026-08-11，
`~/.memside/memside.db`）：

| 维度 | 全局 facets 显示 | 各 tab 实际 |
|---|---|---|
| 状态行数 | — | candidate 574 / approved 7 / rejected 2554 / discards 691 |
| 项目 memside | count 3268 | candidate 574、approved 7、discards 370 |
| 项目 agent-workflow | count 124 | 全部在 rejected，其余 tab 选了即空 |
| 价值筐 未评估 | count 2277 | 其中 2274 在 rejected；approved 仅 2 |
| 分类 architecture | count 1383 | 其中 953 在 rejected；candidate 190 |
| slug 选项 151 个 | — | 有 slug 的行：candidate 214 / approved 4 / rejected 83 |

后果：小 tab（尤其 approved 仅 7 条）的下拉里绝大多数选项在本 tab 不存在，选了就是
「没有符合当前筛选的记录」；每个选项的计数没有一个是本 tab 的数；共享筛选态把候选 tab
的选择带进别的 tab 直接显示空。候选是默认落地 tab 且活跃数据最多，整套共享筛选看起来
就是「候选 tab 的筛选贴在了所有 tab 上」。

## 2. 目标 / 非目标

**目标**

- G1：每个 tab 的筛选下拉只列**本 tab 数据里真实存在**的值，计数按本 tab 统计。
- G2：筛选条件各 tab 独立，切 tab 互不携带。
- G3：保持既有能力：四维（discards 两维）、`unevaluated` 哨兵、FACET_LIST_CAP、
  3s 轮询顺带刷新 facets、total 诚实计数。

**非目标**

- 多选、文本搜索、runs/settings tab 筛选（同前序 spec）。
- facets 分页（维持 cap 200 截断）。

## 3. 已核实事实（live DB + 代码 grep）

1. memories 表 `status ∈ {candidate, approved, archived, superseded, rejected}`；
   discards 行只在 memory_discards 表，永不进 memories 表（前序决策 D1 事实仍成立）。
2. 列表查询的 tab→status 映射在 `src/web/tab-cache.ts` `memoryTabFilter`：
   candidate→`candidate`；approved→`approved,archived,superseded`；rejected→`rejected`。
   facets 的 tab 映射**必须与此一致**，才能保证「下拉选到的值在本 tab 一定查得出」。
3. memory_discards 表无 subject_slug / value_class 列——discards tab 只有项目/分类两维
   （与前序一致，UI 已只渲染这两维）。
4. `listFacets`（store.ts:930）、`GET /api/facets`（server.ts:672）、`getFacets`
   （api.ts:292）为现有全局实现，全部改造点。
5. App.tsx 现有单一 `filter` state（75 行）+ `facets` state（76 行）+ filterRef（77 行）
   + changeFilter 作废四缓存（292-297 行）——全部改造点。
6. tests/web-ui.test.ts:375-379 锁了「四缓存全作废」锚点，本次**有意反转**为只作废当前
   tab（per-tab 独立态下其余 tab 缓存与本 tab 筛选无涉），测试注释须写明反转理由。

## 4. 设计

### 4.1 数据层（store.ts）

```ts
/**
 * facets 统计范围：kind='memories' 只统计给定 statuses 的 memories 行；
 * kind='discards' 只查 memory_discards 表（该表无 slug/value_class 列，两组返回空）。
 */
export type FacetScope =
  | { kind: 'memories'; statuses: MemoryStatus[] }
  | { kind: 'discards' }

export async function listFacets(db: DbClient, scope: FacetScope): Promise<Facets>
```

行为表：

| scope | projects | categories | slugs | valueClasses |
|---|---|---|---|---|
| `{kind:'memories', statuses}` | memories.source_cwd WHERE status IN statuses，非 NULL | memories.title WHERE status IN statuses 解析 `[category:x]` | memories.subject_slug WHERE status IN statuses，非 NULL | memories.value_class WHERE status IN statuses，NULL→unevaluated 桶 |
| `{kind:'discards'}` | memory_discards.source_cwd 非 NULL | memory_discards.title 解析 | `[]` | `[]` |

排序 / 截断不变：count 降序、同 count 值字母序、`FACET_LIST_CAP=200`。
**不再 UNION 两表**——哪个 tab 看哪份数据由 scope 决定。
调用方保证 memories scope 的 statuses 非空（server 层校验）；store 不做空数组兜底。

### 4.2 API 层（server.ts）

```
GET /api/facets?tab=candidate|approved|rejected|discards
```

- tab→scope 映射（常量表）：
  - `candidate` → `{kind:'memories', statuses:['candidate']}`
  - `approved` → `{kind:'memories', statuses:['approved','archived','superseded']}`
  - `rejected` → `{kind:'memories', statuses:['rejected']}`
  - `discards` → `{kind:'discards'}`
- tab 缺失或非法 → `400 {"error":"invalid tab"}`。
- 响应形状不变（`Facets`）。旧 client（不带 tab）得 400 → 既有 catch → null → 灰字降级，
  不崩（前后端同仓同发，实际无此路径）。

### 4.3 Web API client（api.ts）

```ts
export type FacetTab = 'candidate' | 'approved' | 'rejected' | 'discards'
export async function getFacets(fetchFn: FetchLike = fetch, tab: FacetTab): Promise<Facets>
// GET /api/facets?tab=<tab>
```

### 4.4 Web UI 层（App.tsx）

1. **per-tab 筛选态**：
   ```ts
   const [filters, setFilters] = useState<Record<FilterTabKey, MemoryFilter>>({
     candidate: EMPTY_MEMORY_FILTER, approved: EMPTY_MEMORY_FILTER,
     rejected: EMPTY_MEMORY_FILTER, discards: EMPTY_MEMORY_FILTER,
   })
   type FilterTabKey = 'candidate' | 'approved' | 'rejected' | 'discards'
   function isFilterTab(t: TabKey): t is FilterTabKey { …四值判断… }
   ```
2. **per-tab facets 缓存**（stale-while-revalidate，与 tab 列表缓存同哲学）：
   ```ts
   const [facetsByTab, setFacetsByTab] = useState<Partial<Record<FilterTabKey, Facets>>>({})
   ```
   `refresh(tab)` 里 `getFacets(fetch, target as FacetTab).catch(() => null)`，
   成功后 `setFacetsByTab((m) => ({ ...m, [target]: fc }))`。切回 tab 立即用自己的缓存，
   首访未加载到 → undefined → 下拉禁用 + 灰字（可见，不静默）。
3. **派生当前 tab 视图**（JSX 的 `filter` / `facets` 标识符不变，改动收口）：
   ```ts
   const filter = isFilterTab(tab) ? filters[tab] : EMPTY_MEMORY_FILTER
   const facets = isFilterTab(tab) ? facetsByTab[tab] ?? null : null
   ```
   filterRef 同步 effect 不变（读上面派生的 `filter`）。
4. **changeFilter 收窄**：只作废当前 tab 缓存——
   discards → `setDiscards(emptyPage())`；记忆 tab → `setMemCache((c) => ({ ...c, [tab]: emptyPage() }))`；
   随后 `void refresh(tab, next)`。per-tab 独立态下其余 tab 缓存与当前筛选无涉，
   前序「四缓存全作废」是共享态的配套措施，随共享态一起废除。
5. 筛选条 JSX 渲染门控 `tab === 'candidate' || …` 换成 `isFilterTab(tab)`；
   下拉 / 计数 / 空态文案不变。

### 4.5 数据流

```
选下拉 → changeFilter(next) → filters[tab]=next + 作废本 tab 缓存 + refresh(tab, next)
refresh(tab) → listMemoriesPage(status=memoryTabFilter(tab), filter=filters[tab])
             + getFacets(tab) → facetsByTab[tab]
3s 轮询 → refresh(tab)（filterRef 读最新 filters[tab]，facets 顺带刷新）
切 tab → tab effect → refresh(newTab) → 本 tab 缓存 SWR + 本 tab facets
```

## 5. 失败模式

- **F1 陈旧闭包**：轮询 interval 捕获旧帧——filterRef 模式保留（现在镜像派生 `filter`）。
- **F2 缓存污染**：per-tab 态下只有当前 tab 缓存可能带旧筛选条目，changeFilter 作废当前
  tab 即闭环；跨 tab 不存在共享筛选，无污染路径。
- **F3 切 tab 闪现错选项**：facetsByTab 按 tab 隔离，切 tab 不会显示别的 tab 的选项；
  本 tab 首访未加载 → 禁用 + 灰字（可见状态）。
- **F4 非法/缺失 tab 参数**：server 400 → client fetch 返回非 JSON 错误体 → getFacets
  抛错 → refresh 里 `.catch(() => null)` → 灰字降级；列表本身不受影响。
- **F5 旧 daemon**：不识别 tab 参数但路由存在（PR #56 版）→ 返回全局 facets——
  退化回旧行为，不崩。全新 daemon + 旧前端：getFacets 无 tab → 400 → catch → 灰字。
  前后端同仓同发，两向都是优雅降级。
- **F6 性能**：每 3s 轮询附带一次 facets（4 条分组查询 + COUNT 同量级，前序决策 F7
  不加索引不变）；scope 加 WHERE status IN 只会更快。
- **F7 unevaluated 哨兵**：语义不变（严格 IS NULL），仅统计范围收窄到 scope statuses。
- **F8 discards scope 空组**：slugs/valueClasses 恒 `[]`；UI 在 discards tab 本就不渲染
  这两维，双保险。

## 6. 测试策略

纯函数 / store / server / client 层为主，UI 层源码文本断言兜底（CLAUDE.md 约定）：

1. store：memories scope 按 statuses 过滤四组 facet（混播 candidate/rejected 行断言只数
   scope 内的）；discards scope 只出 discards 表行且 slugs/valueClasses 为空；
   排序 / unevaluated 桶 / FACET_LIST_CAP 在 scope 下仍成立；空表四空数组。
2. server：`?tab=` 四个合法值各返回对应 scope 数据（混播状态断言隔离）；缺失/非法 tab → 400。
3. web-api：`getFacets(fetchFn, tab)` 拼 `/api/facets?tab=<tab>`。
4. web-ui 源码文本：per-tab `filters` state、`facetsByTab`、`isFilterTab`、
   changeFilter 只作废当前 tab 的新锚点；**删除**旧「四缓存全作废」锚点并在注释写明
   反转理由（防未来 refactor 误以为是回归）。
5. 既有全局 facets 测试（store-facets / server / web-api / web-ui）全部随改造更新，
   不允许留红。

## 7. 耦合点

- 注入链路 / distiller / scheduler / 状态机：**零改动**。
- schema：无迁移（纯查询条件变化）。
- `memoryTabFilter`（tab-cache.ts）：facets 映射与其保持一致（事实 2），不改它本身。
- 前序 spec 决策记录：D2（全局口径）由本 spec §4.1 取代；§4.3 共享筛选态由 §4.4 取代。
