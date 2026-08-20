# 设计 spec：记忆列表第五维筛选——origin 出处（2026-08-20）

## 背景

Web UI 筛选条现有四维：源项目 / 分类 / 主题（slug）/ 价值（valueClass），管线为
`MemoryListFilter`（store 层 SQL 条件）→ `/api/memories?...` query 参数 → `/api/facets` 下拉选项 →
前端 `MemoryFilter` 状态 + `FilterSelect`（spec 2026-08-11-web-memory-filters、
2026-08-11-per-tab-memory-filters）。

`memories` 表已有 `origin` 列（`user-stated` / `user-confirmed` / `agent-observed`；老行 NULL =
未标注，spec 2026-07-30-origin-driven-value-judgment）。审批时 origin 是可信度信号（用户陈述 >
用户采纳 > agent 观察），且 2026-08-20 刚发生 origin 误标事故（loop 重放被当真人陈述）——用户
需要按出处筛出某类记忆集中审阅（尤其筛「未标注」老行与「agent 观察」待复核项），但 UI 没有这个
入口。

**注意**：`memoryDiscards` 表**没有 origin 列**，discards tab 天然不适用本维度。

## 目标

1. 筛选条加第五维「出处」：候选 / 已批准 / 已拒绝三个 tab 可用，选项 = 用户陈述 / 用户采纳 /
   agent 观察 / 未标注（NULL 老行），各带 count。
2. 「未标注」作为可选项（哨兵值映射 `IS NULL`）——不给这个选项，origin 为 NULL 的老行永远筛不到。
3. 「按当前筛选导出」同步带 origin 条件，导出集与 UI 所见一致。

## 非目标

- discards tab 的 origin 筛选（无列；未来若 discards 加 origin 列再扩展）。
- origin 的编辑 / 回填 / 重判（属审批编辑域，另行设计）。
- 筛选条件的 URL 持久化 / 分享（现有四维也没有，保持一致）。

## 接口契约

完全照抄 valueClass 的既有模式（`VALUE_CLASS_UNEVALUATED` 哨兵 + 白名单宽松策略）：

### store 层（`src/memory/store.ts`）

- 新常量 `export const ORIGIN_UNLABELED = 'unlabeled'` —— origin 筛「未标注」的哨兵值（=
  `origin IS NULL`）。六个合法 origin 值里没有这个词，URL/接口层无歧义。
- `MemoryListFilter` 加 `origin?: string`。
- `memoryFilterConds`：`origin` 三合法值 → `eq(memories.origin, v)`；`=== ORIGIN_UNLABELED` →
  `isNull(memories.origin)`；其余值忽略该条件（白名单宽松，与 valueClass/非法 status 同风格，
  spec 2026-08-11 §4.2）。合法值清单 = `['user-stated', 'user-confirmed', 'agent-observed']`，
  导出常量 `PROTECTED_ORIGINS`（命名对齐 `PROTECTED_VALUE_CLASSES`）。
- `Facets` 加 `origins: FacetValue[]`；`listFacets`：
  - memories scope：`groupBy(memories.origin)`，NULL 归入 `ORIGIN_UNLABELED` 桶（同 vcs 的
    `r.v ?? VALUE_CLASS_UNEVALUATED` 写法）。
  - discards scope：`origins: []`（无列，前端据此不渲染下拉）。

### server 层（`src/server.ts`）

- `GET /api/memories`（带 limit 分页分支）解析 `origin` query 参数 → `filter.origin`（与
  project/slug/category/valueClass 四参数同款 `if (v) filter.x = v` 写法）。
- `POST /api/memories/export` 的 `body.filter` 接 `origin`（`if (body.filter?.origin)
  filter.origin = body.filter.origin`），`listMemoriesForExport` 走同一 `MemoryListFilter`，
  无需另改。

### web 层

- `src/web/api.ts`：
  - `export const ORIGIN_UNLABELED = 'unlabeled'`（与 store 常量同值，注释互指；对齐现有
    `UNEVALUATED` 的做法）。
  - `Facets` 接口加 `origins: FacetValue[]`。
  - `listMemories` opts 加 `origin?: string` → query 参数。
  - `exportMemories` 的 `filter` 参数类型加 `origin?: string` → body。
- `src/web/tab-cache.ts`：`MemoryFilter` 加 `origin: string`（空串 = 不筛）；
  `EMPTY_MEMORY_FILTER` 补 `origin: ''`；`hasActiveFilter` 加 `|| f.origin !== ''`。
- `src/web/ui-utils.ts`：新纯函数 `originName(v: string): string` —— 哨兵 → `'未标注'`；合法值
  委托 `originBadge(v)?.label`；未知值原样返回。下拉措辞单一事实来源（对齐
  `valueClassInfo`/`categoryInfo` 的地位）。
- `src/web/App.tsx`：筛选条加第五个 `FilterSelect`，**放在「价值」之后**；渲染条件
  `tab !== 'discards'`（与 slug/价值同一个条件块内）；options =
  `facets.origins.map(p => ({ value: p.value, label: `${originName(p.value)} (${p.count})`, title: p.value }))`。
  `ExportTrigger` 的 `scope === 'filter'` 分支补 `origin: filter.origin`。

## 数据流

与现有四维完全同构：`FilterSelect` onChange → `changeFilter({...filter, origin: v})` → 作废当前
tab 缓存 + 立即按新筛选重拉（`/api/memories?status=...&origin=...`）→ 3s 轮询沿用同一 filter；
下拉选项随轮询从 `/api/facets?tab=...` 刷新（`listFacets` 的 origins 分组）。

## 与现有模块的耦合点

| 模块 | 耦合 |
|---|---|
| `store.ts` memoryFilterConds / listFacets | 加一维条件 + 一组 facet；不影响四维既有行为 |
| `server.ts` /api/memories、export | 各加一个参数透传 |
| `api.ts` Facets 类型 | 加字段——**老 daemon + 新前端**组合下 `facets.origins` 为 undefined，
  `?? []` 兜底（App.tsx 里所有 facets 用法已带 `facets?.` 前缀，同模式） |
| `tab-cache.ts` per-tab 独立筛选态 | origin 随 per-tab state 走，切 tab 不携带（spec
  per-tab-memory-filters §4.4），无例外 |
| `ExportTrigger` | filter 映射加 origin 一项 |

## 失败模式

1. **老 daemon + 新前端**：`/api/facets` 响应无 `origins` 字段 → 下拉空选项。可接受（facets
   加载失败本就灰字降级），`facets?.origins ?? []` 已兜。
2. **非法 origin 值**（手拼 URL / 新旧版本值集变化）：store 白名单忽略该条件 → 行为退化为
   「不筛出处」，不报错不空列表（与 valueClass 非法值同策略）。
3. **哨兵值撞上未来新增的合法 origin 枚举**：`unlabeled` 若某天成为合法 origin 值会产生歧义——
   现三个合法值不含它，且新增枚举属 schema 变更，届时须换哨兵（与 VALUE_CLASS_UNEVALUATED 同
   风险同处理）。
4. **discards tab 误传 origin**：`discardFilterConds` 不读 origin，静默忽略——不会崩、不会错筛。

## 测试策略

- **store 层**（`tests/` 现有 store 筛选测试同款风格，文件内新增 describe 或就近扩展）：
  - 合法值精确命中（user-stated 只筛出 user-stated 行）；
  - 哨兵 `unlabeled` 筛出 NULL 行、不含任何已标注行；
  - 非法值（如 `foo`）忽略条件（等价不筛）；
  - `listFacets` memories scope：origins 计数含 NULL→哨兵桶、count 降序；
  - `listFacets` discards scope：`origins: []`。
- **server 层**：`/api/memories?limit=...&origin=...` 透传进 filter（命中行集正确）；
  export `body.filter.origin` 圈定导出集。
- **web 纯函数**：`hasActiveFilter`（origin 非空 → true）；`originName`（三合法值中文名 /
  哨兵「未标注」/ 未知值原样）。
- **App.tsx**：保留源代码层文本断言兜底（筛选条含「出处」label；ExportTrigger filter 含
  origin 映射）——巨型组件不直接 UI 测，沿用仓库惯例。
