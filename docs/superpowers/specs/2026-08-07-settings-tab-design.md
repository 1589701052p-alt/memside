# 设置 Tab 统一收拢 — 设计 spec

日期：2026-08-07
状态：已确认（brainstorming 两轮问答 + 方案对比后用户批准）

## 1. 背景

Web UI（`src/web/App.tsx`）目前 5 个 tab：候选审批 / 已审批 / 已拒绝 / AI自动拒绝 / 蒸馏记录。两个设置区块 `LlmSettings`（`App.tsx:534`）与 `JudgeSettings`（`App.tsx:647`）**常驻渲染在状态栏与列表之间**（`App.tsx:347-351`），无论用户看哪个 tab 都占着首屏空间。

用户要求：把 LLM 配置、判定配置统一收拢到一个独立的「设置」tab，结构上为后续增加更多设置项留好扩展位。

### 已确认的两个关键决策

1. **「当前生效」回显行全部收进设置 tab**，状态栏不加任何 LLM 摘要。
   - 权衡：2026-07-30 llm-settings-ui spec 把「常驻生效回显」列为硬需求（让用户一眼发现 env 劫持）。用户本次明确选择牺牲常驻可见性换界面整洁。
   - 缓解：设置 tab 采用「切到才挂载」（§3.4），每次进入都重新 fetch，看到的生效配置永远是最新值，劫持场景打开 tab 即可发现。
2. **设置 tab 内部垂直堆叠区块**。新增 `SettingsTab` 容器直接堆叠 section 组件；不做二级 tab / 侧边导航（现在只有两个区块，YAGNI）。

## 2. 目标 / 非目标

### 目标

- tab 栏新增第 6 个 tab「设置」（无计数徽标），置于末尾。
- `LlmSettings`、`JudgeSettings` 从常驻位置移除，只在设置 tab 内容区渲染。
- 设置 tab 不参与列表数据流：不发列表请求、不建 3s 轮询、无无限滚动。
- 状态栏、daemon 断连错误 banner 保持所有 tab 常驻，行为不变。
- 扩展位：后续新增设置 = 写一个 section 组件 + 在设置 tab 内容区加一行挂载。

### 非目标

- 不动 `LlmSettings` / `JudgeSettings` 组件内部的任何交互、文案、fetch/保存逻辑（逐字保留）。
- 不动 daemon / server / `src/web/api.ts` 的任何端点。
- 不动状态栏内容与 h1「memside · 审批队列」标题。
- 不做设置区块的子导航、折叠、搜索。

## 3. 设计

纯 UI 层改动，集中在 `App.tsx`；`tab-cache.ts` 纯函数层加一个小判定函数。

### 3.1 TabKey 扩展与 tab 栏

- `TabKey = 'candidate' | 'approved' | 'rejected' | 'discards' | 'runs' | 'settings'`。
- `tabs` 数组末尾加 `{ key: 'settings', label: '设置' }`。
- tab 按钮的计数徽标对 settings 不渲染（tab 按钮处加条件：非 settings 才渲染 count 徽标）。
- 选中样式复用现有 active 高亮，无新样式。

### 3.2 列表数据流短路

`tab-cache.ts` 新增纯函数：

```ts
/** settings tab 无列表数据流：不轮询、不刷新、不无限滚动。 */
export function isListTab(tab: string): boolean {
  return tab !== 'settings'
}
```

App.tsx 三处入口短路：

1. `refresh(target)` 开头：`if (!isListTab(target)) return`。
2. `loadMore(target)` 开头：`if (!isListTab(target)) return`。
3. 轮询 `useEffect`（依赖 `[tab]`）开头：`if (!isListTab(tab)) return`——不拉数据、不建 interval。

无限滚动哨兵的 `IntersectionObserver` effect 同理（`loadMoreRef` 本身已短路，哨兵触发也是空调用；为清晰起见 observer effect 同样在 settings 时不挂载 observer）。

**列表尾部块（`App.tsx:498-512`）也要整体按 `isListTab(tab)` 门控**：其中 `tabPageOf(tab).hasMore` 对 settings 会索引到 `memCache['settings'] === undefined` 而抛 TypeError，不门控是必现 crash。门控后 settings tab 不渲染「加载更多/没有更多了」尾部。

### 3.3 状态记录类型完整

`loaded` / `pending` / `loadingMore` / `loadMoreError` 四个 `Record<TabKey, ...>` 的初始值补 `settings: false`（`pending` 补 `settings: false`，**不得**沿用 candidate 的初始 true——settings 无加载态需求）。这些键对 settings 不会被读写（§3.2 已短路），补全仅为 `Record` 类型完整。

### 3.4 内容区渲染

- 渲染链加分支：`tab === 'settings'` 时渲染设置区块组合：
  ```tsx
  <>
    <LlmSettings />
    <JudgeSettings />
  </>
  ```
- 两个区块从原常驻位置（`App.tsx:347-351`）删除。
- 设置 tab 只在激活时挂载：切走即卸载，切回重新 mount → `LlmSettings`/`JudgeSettings` 内部的 `useEffect(() => { void refresh() }, [])` 每次重 fetch，保证生效配置回显为最新（§1 决策 1 的缓解机制）。
- 设置 tab 无列表三态（加载中/空/错误）：`showLoading`/`listEmpty` 分支对 settings 不生效，两区块内部已有各自的 fetch 失败错误行。
- 全局 daemon 断连 `error` banner（`App.tsx:353-366`）维持常驻——设置 tab 下 daemon 断了也照旧显示。

### 3.5 扩展约定（写进代码注释）

设置 tab 内容区的挂载点加注释：后续新增设置区块 = 新写 section 组件 + 在此追加一行。Section 组件沿用现有约定：`<section>` 包裹 + `<h3>` 标题 + 内部自管理 fetch/保存/错误行。

## 4. 失败模式

| 场景 | 行为 |
|---|---|
| daemon 断连时打开设置 tab | 全局错误 banner 常驻显示；两区块内部各自显示「设置加载失败」错误行（既有行为，不静默）。 |
| 用户在设置 tab 停留期间后台配置被改（如另一窗口保存） | 不轮询，不回显最新；切走再切回即重 fetch。低频手动操作，可接受。 |
| 快速来回切 tab | settings 分支每次卸载/重挂载，触发一次 getLlmSettings + fetchJudgeConfig；与既有切 tab 重拉列表同量级，无压力。 |

## 5. 测试策略

按 CLAUDE.md：纯函数层写足断言，运行时层源码文本断言兜底。

1. **纯函数**：`isListTab` 单测——5 个列表 tab 全 true、settings false（锁定「settings 不进列表数据流」的意图）。
2. **源码层文本断言**（App.tsx）：
   - tab 定义含 `{ key: 'settings', label: '设置' }`；
   - `LlmSettings` / `JudgeSettings` 只在 settings 分支挂载（断言 JSX 调用点恰一处且在 `tab === 'settings'` 分支内）；
   - `refresh` / `loadMore` / 轮询 effect 含 `isListTab` 短路守卫。
3. **回归验证**：`bun run typecheck && bun test` 全绿后 push。

## 6. 验收清单

- [ ] tab 栏出现第 6 个「设置」tab，无计数徽标。
- [ ] 5 个列表 tab 页面不再常驻显示 LLM / 判定设置区块。
- [ ] 设置 tab 内垂直堆叠 LLM 设置 + 判定两个区块，交互与文案零变化。
- [ ] 设置 tab 下无 3s 轮询请求、无列表请求（Network 面板可验）。
- [ ] 切回设置 tab 时生效回显重新拉取（不是旧缓存）。
- [ ] daemon 断连时设置 tab 仍显示全局错误 banner + 区块内错误行。
- [ ] `bun run typecheck && bun test` 全绿（含新测试）。
