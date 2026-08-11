# Web UI 记忆列表多维筛选 - 设计 spec

日期：2026-08-11
分支：`feat/web-memory-filters`（基线 `origin/master` abac2b9）
状态：设计已获用户认可（brainstorming 四节逐节确认 + 方案 A 拍板）

## 1. 背景与诊断

memside Web UI 现在有六个 tab：候选审批 / 已审批 / 已拒绝 / AI自动拒绝 /
蒸馏记录 / 设置。前四个是「记忆类」列表 tab，全部走服务端游标分页
（每页 20 条，spec 2026-08-07 tab-list-pagination）+ 3s 轮询。

live DB 实测（2026-08-10 取证，`~/.memside/memside.db` 只读查询）：

- memories 共 3135 行：candidate 574 / approved 7 / rejected 2554。
- `source_cwd` 6 个取值：memside 主目录 2898、agent-workflow 124、
  memside 的 worktree 子目录 104、tmp2 4、两个 `memside-tmpl-*` 临时目录共 5。
- `subject_slug` 约 50 个取值，2834 行为 NULL。
- title 的 `[category:` 前缀：3135 行全部在**行首**；除 distiller prompt 的
  10 个正常分类外，还有 5 个幻觉值（test-pattern / trap / topology / testing /
  test 各 1-2 条）。discards 691 行同样全部带行首前缀。
- `tags` 列实质未使用（全表仅 1 行非空）——蒸馏器不产出 tag，审批界面没有
  打 tag 入口。**用户口中的「标签」经澄清 = 价值六筐徽标（value_class）**。
- value_class 分布：NULL（未评估）2277、decision 289、convention 249、
  trap 223、user-rule 76、topology 19、preference 2。

候选队列已涨到 574 条且跨多个来源项目，用户无法按项目 / 主题 / 分类 /
价值筐定位想审的记忆——「批量拒绝未评估」之外缺少任何导航手段。本需求
给四个记忆类 tab 加多维筛选。

### 关键架构事实（决定筛选必须在哪层做）

列表是服务端游标分页的：前端任何时刻只加载了全表的一小部分（20 条起）。
**客户端过滤已加载行会给出系统性错误的结果**（「筛 memside」只在已加载的
20 条里筛）。因此筛选必须是服务端行为，下拉选项也必须由服务端从全表
DISTINCT 出来（facets 端点）——前端同样无法从一页数据枚举所有项目/slug。

## 2. 目标 / 非目标

### 目标

1. 候选审批 / 已审批 / 已拒绝三个记忆 tab 支持四维筛选：
   **项目（source_cwd，最重要）、slug（subject_slug）、分类（title 的
   `[category:xxx]` 前缀）、价值筐（value_class，含「未评估」=NULL）**。
2. AI自动拒绝（discards）tab 支持其数据允许的两维：项目 + 分类
   （该表无 subject_slug / value_class 列）。
3. 每维单选下拉，选项从真实数据动态生成（带计数）；维度间 AND。
   有「全部」项与「清除筛选」按钮。
4. 筛选结果计数诚实：筛选激活时列表头显示服务端 `COUNT(*)`（同 WHERE），
   不拿全局计数冒充。
5. 筛选与既有游标分页、3s 轮询、stale-while-revalidate 缓存、无限滚动
   正确共存：改筛选 = 相关缓存作废 + 立即重拉。

### 非目标

- 不做文本搜索（title/bodyMd 关键字）。
- 不做每维多选 / 维度间 OR。
- 不做按 tab 独立的筛选状态（筛选状态跨 tab 共享，见 §4.3）。
- 不给蒸馏记录（runs）tab 加筛选（那是 distill job 记录，不是记忆）。
- 不给 tags 列补编辑入口（数据实质为空，价值筐已覆盖用户的「标签」诉求）。
- 不做 facets 按当前 tab/status 细分子计数（全局口径，见 §4.1 决策 D2）。
- 不动注入链路（formatMemoryBlock）、distiller、scheduler、状态机。

## 3. 已验证的事实（实现前取证，不靠记忆）

1. 全部 3135 条 memories 与 691 条 discards 的 title 均含 `[category:`
   前缀且都在行首（`instr(title,'[category:')=1` 全真）——但**提取/匹配
   不限定行首**：用户可在审批卡片编辑 title（patchMemory 允许），前缀可能
   被挪动，`instr > 0` 更稳。
2. `memory_discards` 有 `source_cwd` / `title` 列（schema.ts:101/94），
   无 `subject_slug` / `value_class` 列。
3. discards 行是未入库的被杀候选——**项目清单若只查 memories 表会漏掉
   只出现在 discards 的来源项目**，facets 必须 UNION 两表（决策 D1）。
4. 分页契约：`GET /api/memories` 带 `limit` 走游标分页（server.ts:549），
   不带 `limit` 走旧全量形状（兼容锚点，server.ts:557-560）；status 参数
   白名单过滤、非法值宽松忽略（server.ts:546-547）；游标参数非法宽松忽略
   （parseBefore，server.ts:535）。
5. `listMemoriesPage` / `listDiscardsPage` 的 filter 条件与游标条件在
   同一个 `and(...conds)` 里组合（store.ts:770-777 / 797-802）。
6. value_class 六个合法值定义于 `PROTECTED_VALUE_CLASSES`（store.ts:843）。
7. 轮询闭包陷阱：App.tsx 的 3s interval 捕获建 effect 那帧的 `refresh`
   闭包（App.tsx:158-168）；现有代码用 `loadMoreRef` 每渲染同步最新闭包
   （App.tsx:141-142）规避同类问题——新增筛选状态必须走同款 ref 模式
   （失败模式 F5）。
8. `mergeRefreshPage` 会把「不在第一页的旧条目」追加回列表
   （tab-cache.ts:54-64）——筛选变化后若不清缓存，旧筛选的条目会滞留
   （失败模式 F2）。
9. git push 本机需 `http.sslBackend=openssl`（代理 7897 + schannel 握手
   失败，用户 auto-memory 记录）。

## 4. 设计

### 4.1 数据层（pure + store）

**新纯函数 `categoryFromTitle(title: unknown): string | null`**
（`src/memory/pure.ts`，与 `normalizeSubjectSlug` 并列；纯函数、永不抛）：

- 非字符串 → null。
- 正则 `/\[category:([^\]]*)\]/i` 取第一个匹配的内部值，trim、转小写。
- 内部值为空串 → null。
- 语义与 `exactDedup.ts:14` 的剥离正则对齐（那里是全局替换，这里是提取）。

**分页查询加可选 filter**——`listMemoriesPage` / `listDiscardsPage` 的
opts 增加 `filter?` 字段，**不传 = 行为逐字节不变**（回归锚点）：

```ts
// src/memory/store.ts
export interface MemoryListFilter {
  sourceCwd?: string   // memories.source_cwd / discards.source_cwd 精确 eq
  subjectSlug?: string // memories.subject_slug 精确 eq（仅 memories）
  category?: string    // instr(title, '[category:' || ? || ']') > 0（两表）
  valueClass?: string  // 'unevaluated' 哨兵 → IS NULL；合法六值 → eq（仅 memories）
}
```

SQL 组合（与既有 status / 游标条件一律 AND）：

| 维度 | memories | discards |
|---|---|---|
| project | `source_cwd = ?` | `source_cwd = ?` |
| slug | `subject_slug = ?` | —（无此列，参数忽略） |
| category | `instr(title, '[category:X]') > 0`（drizzle `sql` 模板参数绑定，无注入面） | 同 |
| valueClass | 哨兵 `unevaluated` → `value_class IS NULL`；`PROTECTED_VALUE_CLASSES` 内值 → `value_class = ?`；**其余值 → 忽略该条件**（白名单宽松策略，与非法 status 同风格） | —（无此列，参数忽略） |

新哨兵常量 `VALUE_CLASS_UNEVALUATED = 'unevaluated'`（store.ts 导出；
六个合法 value_class 里没有这个词，无歧义）。

**新查询函数 `listFacets(db)`**（store.ts）：

```ts
export interface FacetValue { value: string; count: number }
export interface Facets {
  projects: FacetValue[]     // memories ∪ discards 的 source_cwd（排除 NULL）
  categories: FacetValue[]   // 两表 title 经 categoryFromTitle 解析计数
  slugs: FacetValue[]        // memories.subject_slug（排除 NULL）
  valueClasses: FacetValue[] // memories.value_class；NULL 聚成 'unevaluated' 桶
}
export const FACET_LIST_CAP = 200 // 每组上限，超出截断（防异常数据撑爆下拉）
```

实现要点：

- projects：两表各自 `SELECT source_cwd, COUNT(*) … WHERE source_cwd IS
  NOT NULL GROUP BY source_cwd`，JS Map 合并同值计数（决策 D1）。
- categories：两表只投影 title（轻投影，3826 行 × 短串，内存无压力），
  `categoryFromTitle` 解析后 JS 计数——SQL 侧做前缀解析不干净，纯函数
  才是可测面（CLAUDE.md 首选可断言面）。解析为 null 的 title 不计。
- slugs：`SELECT subject_slug, COUNT(*) … WHERE subject_slug IS NOT NULL
  GROUP BY subject_slug`。
- valueClasses：`SELECT value_class, COUNT(*) … GROUP BY value_class`，
  NULL 行的桶名用哨兵 `unevaluated`。
- 四组统一 count 降序；同 count 按 value 字母序（排序确定性，测试可断言）；
  各组截 FACET_LIST_CAP。

**决策记录**：

- **D1（项目清单 UNION 两表）**：discards 行不在 memories 表；只查
  memories 会让「只产出过被杀候选的项目」从下拉里消失。UNION 是用户可见
  行为的正确性要求，不是优化。
- **D2（facets 全局口径）**：计数不按 tab/status 切分。四 tab 共用一套
  选项；某选项在当前 tab 命中 0 条时列表显示「无匹配」空态而不是藏选项。
  换取单一端点、无 facets×status 组合查询、实现与测试面最小。
- **D3（`unevaluated` 哨兵）**：value_class 筛「未评估」= 筛 NULL，
  URL/接口层用字符串哨兵表达，store 层翻译成 `IS NULL`。
- **D4（filter 只作用于分页路径）**：`GET /api/memories` 旧全量路径
  （无 limit）不识别 filter 参数。Web UI 永远走分页路径；旧路径是兼容
  锚点，不改行为。

### 4.2 API 层（server.ts）

- `GET /api/memories`（分页路径，带 `limit`）：新识别查询参数
  `project` / `slug` / `category` / `valueClass`，空串/缺失忽略；
  组装 `MemoryListFilter` 传入 `listMemoriesPage`。
- `GET /api/discards`（分页路径）：新识别 `project` / `category`。
- `GET /api/facets`（新）：返回 `listFacets` 结果，无参数，
  形状 `{ projects, categories, slugs, valueClasses }`。
- **分页响应加 `total`**：`/api/memories` 与 `/api/discards` 分页路径在
  页查询的同一 WHERE 条件下跑 `COUNT(*)`，响应加 `total: number`
  （`{ items, hasMore, nextCursor, total }`）。SQLite 对 3000 行同条件
  count 亚毫秒，3s 轮询无压力。
- 错误处理沿用既有风格：filter 参数非法/未知值宽松忽略（不 400），
  与 status 白名单、parseBefore 一致。

### 4.3 Web UI 层（api.ts + tab-cache.ts + ui-utils.ts + App.tsx）

**api.ts**：

- 新类型 `FacetValue` / `Facets`；新函数 `getFacets(fetchFn)`。
- 哨兵常量 `UNEVALUATED = 'unevaluated'`（与 store 哨兵值相同；URL 值）。
- `listMemoriesPage` opts 加 `project? / slug? / category? / valueClass?`；
  `listDiscardsPage` opts 加 `project? / category?`；非空才拼入 query。
- `PageDto<T>` 加 `total?: number | null`；`parsePage` 映射
  `data.total ?? null`（旧 daemon 无此字段时降级，不崩）。

**tab-cache.ts**：新纯函数 `hasActiveFilter(f: MemoryFilter): boolean`
（任一维非空 → true）。`MemoryFilter` 类型定义也放这里
（`{ project, slug, category, valueClass }` 全 string，空串 = 不筛）。

**ui-utils.ts**：新纯函数 `projectDisplayName(value: string,
allValues: string[]): string`——取路径末段（同时切 `\` 与 `/`，去尾
分隔符与空段）；末段在同批 values 里撞名时升级为 `父段/末段`；仍撞或
取不到 → 原值兜底。永不抛。

**App.tsx**：

- 新 state：`filter: MemoryFilter`（初始全空）与 `facets: Facets | null`
  （初始 null）。
- **筛选条**：渲染在状态栏与列表之间，仅 `tab ∈ {candidate, approved,
  rejected, discards}` 时出现。记忆三 tab 渲染四个下拉，discards tab 只
  渲染 project + category 两个（无对应列的维度不渲染，不是禁用——切回
  记忆 tab 原选择仍在）。每下拉首项「全部」（value=''）；选项文案带计数：
  项目 `目录名 (N)`（title 属性挂完整路径）、分类原值 `(N)`、价值筐复用
  现有 `VALUE_LABEL` 中文文案 +「未评估」、slug 原值 `(N)`。
  `facets === null` 时下拉禁用 + 灰字「筛选选项加载失败」。
  「清除筛选」按钮仅 `hasActiveFilter(filter)` 时渲染。
- **改筛选的副作用**（`onFilterChange`）：
  1. `setFilter(next)`；
  2. **candidate / approved / rejected / discards 四个缓存全部重置
     `emptyPage()`**（runs 不受影响）——筛选跨 tab 共享，只清当前 tab
     会让 `mergeRefreshPage` 把旧筛选条目当「掉出第一页的老数据」追加
     回来（失败模式 F2）；
  3. 立即 `void refresh(tab)`（不等下个 3s 周期）。
- **轮换闭包修正**：`filterRef` 每渲染同步（与 `loadMoreRef` 同模式）；
  `refresh` / `loadMore` 构造分页请求时读 `filterRef.current`，不从闭包
  读 `filter`（interval 捕获的是建 effect 那帧的闭包，失败模式 F5）。
  记忆 tab 请求传四维（discards 请求只传 project/category）。
- **facets 刷新**：搭现有轮询便车——`refresh` 的 `Promise.all` 里加
  `getFacets().catch(() => null)`；结果非 null 才 `setFacets`。首次失败
  筛选条显「筛选选项加载失败」，下个周期拿到自动恢复（不静默 stall）。
  facets 失败**不**拖垮列表刷新（独立 catch 降级）。
- **计数**：筛选激活时列表头显示 `page.total ?? 已加载条数`，文案
  「共 N 条符合当前筛选」；无筛选时维持现有 status 全局计数文案。
  tab 顶部计数徽标**不动**（导航用途，全局口径，来自 /api/status）。
- **空态**：列表空 && 筛选激活 && 非加载中 → 「没有符合当前筛选的记录」
  + 内联「清除筛选」按钮；无筛选时维持现有各 tab 空态文案。
- MemoryCard / DiscardCard / 操作回调零改动。

### 4.4 数据流总览

```
用户选下拉 → onFilterChange
  → setFilter + 四记忆 tab 缓存 emptyPage + 立即 refresh(tab)
refresh(tab)
  → Promise.all([
      listMemoriesPage(status=tabFilter, filter=filterRef.current, limit=20),
      getStatus(),
      getFacets().catch(→null),
    ])
  → setMemCache(mergeRefreshPage) / setStatus / setFacets(非 null 时)
  → 列表头显 total（筛选激活时）；下拉选项来自 facets
3s interval → refreshRef/filterRef 读最新状态重复上述
loadMore → listMemoriesPage(before=游标, filter=filterRef.current)
```

## 5. 失败模式与降级

| # | 失败模式 | 对策 |
|---|---|---|
| F1 | facets 过时（新 distill 产出新 slug/项目，下拉里没有） | facets 搭 3s 轮询刷新，无静默窗口 |
| F2 | 改筛选后旧筛选条目滞留列表 | 改筛选 = 四个记忆 tab 缓存全部 `emptyPage()`（§4.3） |
| F3 | `source_cwd` NULL 的老行/手动记忆筛项目时不命中任何选项 | 接受并文档化；live DB 实测当前 0 条 NULL 行。不加「未知来源」伪选项（YAGNI） |
| F4 | 幻觉分类值（test-pattern 等）混入 | facets 数据驱动自动收录（不硬编码分类表）；筛选匹配是**带闭括号**的精确子串（`[category:arch]` 不会误中 `[category:architecture]`） |
| F5 | 轮询 interval 闭包读到陈旧 filter | `filterRef` 每渲染同步（`loadMoreRef` 既有模式） |
| F6 | facets 端点失败 | 列表照常刷新（独立 catch）；筛选条禁用 + 「筛选选项加载失败」灰字；下周期自愈 |
| F7 | 性能 | `instr()` 全表扫 3000+ 行亚毫秒；不加索引（YAGNI）；facets 聚合同量级 |
| F8 | 筛选激活时翻页/轮询竞态 | filter 进 WHERE 后进游标语义不变（游标仍是 createdAt+id 尾位置）；改筛选即清缓存，不存在「旧游标 + 新 filter」组合 |
| F9 | 旧 daemon（无新参数/无 total/无 facets 端点）配新前端 | 未知 query 参数被旧 server 忽略 → 退化为无筛选；`total ?? null` 降级回已加载条数；getFacets 404 → catch → 筛选条禁用。不崩不静默 |

## 6. 测试策略（纯函数层为主，CLAUDE.md 可断言面）

1. **`categoryFromTitle`**（pure 测试，新文件或 pure-subject-slug.test.ts
   同档扩展）：行首前缀 / 中间前缀 / 无前缀→null / 空内部→null /
   大写 `CATEGORY:` 大小写不敏感 / 输出转小写 / 非字符串输入永不抛。
2. **`hasActiveFilter`**（tab-cache.test.ts 扩展）：全空 false；
   任一维非空 true。
3. **`projectDisplayName`**（ui-utils 测试扩展）：末段提取（正反斜杠、
   尾分隔符）/ 撞名升级 `父/子` / 取不到回退原值 / 永不抛。
4. **store 筛选**（新 `tests/store-filter.test.ts`）：
   - 四维各自单独命中与排除（seed 匹配行 + 非匹配行，断言只回匹配行）；
   - 多维 AND；无匹配 → `items=[]`、`hasMore=false`、`total=0`；
   - `unevaluated` 哨兵命中 value_class NULL 行、排除非 NULL 行；
   - 非法 valueClass 值 → 条件忽略（返回无筛选结果集）；
   - 筛选与游标共存：筛选下翻第 2 页仍只含匹配行；
   - **无 filter 调用与现行为逐字节一致**（回归锚）；
   - `total` = 同条件 COUNT（翻页不变、随筛选变化）。
5. **`listFacets`**：项目 UNION 两表（seed 一条 discard 独有的
   source_cwd 必须出现）；categories 从两表 title 解析计数；slugs 排除
   NULL；valueClasses 含 `unevaluated` 桶且计数 = NULL 行数；count 降序；
   空表 → 四个空数组；FACET_LIST_CAP 截断。
6. **server**（server.test.ts 扩展）：四参数各自生效；非法 valueClass
   宽松忽略不 400；旧全量路径（无 limit）忽略 filter 参数（决策 D4 锁）；
   discards 的 project/category；`GET /api/facets` 形状；分页响应带 total。
7. **web-api**（web-api.test.ts 扩展）：URL 拼接——参数只在非空时出现、
   顺序与既有 status/limit/before 共存、`unevaluated` 哨兵、discards URL。
8. **App 接线**（源码层文本断言，web-ui.test.ts 既有模式兜底）：
   筛选条四 select 渲染、改筛选重置四个记忆 tab 缓存、`filterRef`
   模式存在、筛选态空态文案、`共 N 条符合当前筛选` 计数接线、
   refresh 内 getFacets 调用。

**运行门槛**：`bun run typecheck && bun test` 全绿才 push（仅 bun test，
严禁 npm test）。

## 7. 与既有模块的耦合点

- `src/memory/pure.ts`：新增 `categoryFromTitle`（纯增量）。
- `src/memory/store.ts`：`listMemoriesPage` / `listDiscardsPage` opts
  扩展（向后兼容）+ 新 `listFacets` + 哨兵常量。
- `src/server.ts`：两个 GET 路由加参数解析 + 新 `/api/facets` 路由 +
  分页响应加 total。
- `src/web/api.ts` / `tab-cache.ts` / `ui-utils.ts` / `App.tsx`：§4.3。
- **零改动**：注入链路（formatMemoryBlock/clipByBudget）、distiller、
  scheduler、状态机、schema（无迁移）、MemoryCard/DiscardCard、
  opencode plugin。
