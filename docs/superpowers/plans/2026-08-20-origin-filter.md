# 任务计划：origin 出处筛选（2026-08-20）

spec：`docs/superpowers/specs/2026-08-20-origin-filter-design.md`

分支：`feat/origin-filter`（从最新 `origin/master` 切）。全部任务完成后 push + 开 PR 回 `master`。

依赖关系：Task 1 → Task 2 → Task 3 → Task 4（store 是 server/web 的地基；Task 4 收尾全量验证）。
Task 1/2 之间只有类型依赖，实现可串行交接。

---

## Task 1 — store 层：origin 筛选条件 + facets

- [ ] `src/memory/store.ts`：
  - `export const ORIGIN_UNLABELED = 'unlabeled'`（哨兵，注释与 VALUE_CLASS_UNEVALUATED 同款）
  - `export const PROTECTED_ORIGINS: readonly string[] = ['user-stated', 'user-confirmed', 'agent-observed']`
  - `MemoryListFilter` 加 `origin?: string`（注释写明哨兵与白名单宽松语义）
  - `memoryFilterConds` 加 origin 分支（合法值 eq / 哨兵 isNull / 其余忽略）
  - `Facets` 加 `origins: FacetValue[]`；`listFacets` memories scope 加 groupBy origin（NULL →
    哨兵桶）；discards scope 返回 `origins: []`
- [ ] 测试（放现有 store 筛选/facets 测试文件，或新建 `tests/store-origin-filter.test.ts`，
      顶部注释链接本 spec）：
  - 合法值命中 / 哨兵筛 NULL / 非法值忽略 / facets origins 计数（含 NULL 桶、排序）/ discards
    scope `origins: []`
- 验收：`bun run typecheck` 绿；新增测试全绿；四维筛选既有测试不回归。

## Task 2 — server 层：query / body 参数透传

- [ ] `src/server.ts`：
  - `GET /api/memories` 分页分支解析 `origin` query 参数 → `filter.origin`（与 valueClass 同款）
  - `POST /api/memories/export` 的 `body.filter` 接 `origin` 透传
- [ ] 测试（扩展现有 server API 测试，或新建 `tests/server-origin-filter.test.ts`）：
  - `?origin=user-stated` 命中行集正确；`?origin=unlabeled` 筛出 NULL origin 行
  - export `body.filter.origin` 圈定导出行集（不混入其它 origin）
- 验收：typecheck 绿；新旧测试全绿。

## Task 3 — web 层：第五个 FilterSelect + 导出映射

- [ ] `src/web/api.ts`：`ORIGIN_UNLABELED` 常量（与 store 同值、注释互指）；`Facets` 加
  `origins`；`listMemories` opts 加 `origin`；`exportMemories` filter 类型加 `origin`
- [ ] `src/web/tab-cache.ts`：`MemoryFilter.origin: string`；`EMPTY_MEMORY_FILTER` 补
  `origin: ''`；`hasActiveFilter` 加 origin 判断
- [ ] `src/web/ui-utils.ts`：`originName(v: string): string` 纯函数（哨兵→未标注；合法值委托
  `originBadge`；未知值原样），JSDoc 注明单一事实来源地位
- [ ] `src/web/App.tsx`：筛选条「价值」之后加 `FilterSelect label="出处"`，放
  `tab !== 'discards'` 条件块内，options 用 `facets?.origins ?? []` + `originName` + count；
  `ExportTrigger` 的 filter 映射补 `origin: filter.origin`；筛选条注释从「四维」改「五维」
- [ ] 测试：
  - `hasActiveFilter` origin 分支；`originName` 三类输入（新文件
    `tests/web-origin-filter.test.ts` 或就近 ui-utils 测试）
  - App.tsx 源代码文本断言兜底（含「出处」label 与 ExportTrigger origin 映射）
- 验收：typecheck 绿；`bun test` 全绿。

## Task 4 — 全量验证 + 收尾

- [ ] Bash 工具跑 `bun run typecheck && bun test`（PowerShell 5.1 不支持 `&&`）——全绿才算过
- [ ] 手动冒烟（可选，若环境可用）：`bun run src/cli.ts start` + `bun run dev:web`，确认
  候选 tab 筛选条出现「出处」下拉、选项带计数、discards tab 不出现
- [ ] `STATE.md` 顶部加一小节（一屏内）：五维筛选上线，指回本 spec/plan
- [ ] commit + push `feat/origin-filter` + 开 PR 回 `master`（标题
      `feat: 记忆列表第五维筛选——origin 出处`）

---

## 验收清单（整体）

- [ ] 候选 / 已批准 / 已拒绝 tab：「出处」下拉可用，四选项措辞 = 用户陈述 / 用户采纳 /
      agent 观察 / 未标注，各带 count
- [ ] 选「未标注」筛出 origin 为 NULL 的老行；选「agent 观察」只出 agent-observed 行
- [ ] discards tab 无「出处」下拉
- [ ] 「按当前筛选导出」包含 origin 条件（导出行集 = UI 所见）
- [ ] 五维可叠加（出处 × 价值 × 分类 等 AND 组合）
- [ ] `bun run typecheck && bun test` 全绿
