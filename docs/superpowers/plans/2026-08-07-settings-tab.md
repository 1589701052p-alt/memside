# 设置 Tab 统一收拢 LLM/判定配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把常驻的 LLM 设置与判定设置区块收拢进新增的「设置」tab，列表数据流对该 tab 全部短路，为后续更多设置项留扩展位。

**Architecture:** 纯 UI 层改动。`tab-cache.ts` 加纯函数 `isListTab` 作为「该 tab 是否走列表数据流」的唯一判据；`App.tsx` 的 TabKey 加 `'settings'`，refresh / loadMore / 轮询 / observer / 列表尾部五处入口用它短路，两个设置区块从常驻位置移到 `tab === 'settings'` 分支（组件本体逐字不动）。

**Tech Stack:** React 19 + Vite（inline style，无样式框架）；测试 bun:test（纯函数单测 + 源码层文本断言）。

**Spec:** `docs/superpowers/specs/2026-08-07-settings-tab-design.md`

## Global Constraints

- 分支 `feat/settings-tab`（已从最新 origin/master 切出，spec 已提交其上），所有 commit 落在该分支；禁止直推 master。
- 测试一律 `bun test`（禁 npm test）；运行门槛 `bun run typecheck && bun test` 全绿才算完成。
- `LlmSettings` / `JudgeSettings` 组件内部（交互、文案、fetch/保存逻辑）**逐字不动**。
- 不动 daemon / server / `src/web/api.ts` 任何端点与 wrapper。
- 不动状态栏内容、h1 标题、现有 5 个列表 tab 的任何行为。
- 沿用现有 inline style 约定，不引入样式框架。
- 状态可见性硬规则：fetch 失败显错误，不静默 stall。

## File Structure

| 文件 | 动作 | 责任 |
|---|---|---|
| `src/web/tab-cache.ts` | 修改 | 加纯函数 `isListTab`（settings 无列表数据流的唯一判据） |
| `tests/tab-cache.test.ts` | 修改 | `isListTab` 单测 |
| `src/web/App.tsx` | 修改 | TabKey 扩展 + 五处数据流短路 + tabs 数组 + 徽标条件渲染 + 常驻挂载移除 + settings 分支渲染 + 列表尾部门控 |
| `tests/web-ui.test.ts` | 修改 | 源码层文本断言（tab 存在 / 区块恰一处挂载 / 守卫存在 / 无徽标） |

---

### Task 1: `isListTab` 纯函数

**Files:**
- Modify: `src/web/tab-cache.ts`（文件末尾追加）
- Test: `tests/tab-cache.test.ts`（文件末尾追加）

**Interfaces:**
- Consumes: 无
- Produces: `export function isListTab(tab: string): boolean` —— Task 2 在 App.tsx 五处入口调用；语义 = 「该 tab 走列表数据流（refresh/loadMore/轮询/无限滚动/列表尾部）」。

- [ ] **Step 1: 写失败测试**

在 `tests/tab-cache.test.ts` 末尾追加：

```ts
// --- 设置 tab（docs/superpowers/specs/2026-08-07-settings-tab-design.md §3.2）---

test('isListTab: 五个列表 tab 全 true，settings false', () => {
  expect(isListTab('candidate')).toBe(true)
  expect(isListTab('approved')).toBe(true)
  expect(isListTab('rejected')).toBe(true)
  expect(isListTab('discards')).toBe(true)
  expect(isListTab('runs')).toBe(true)
  expect(isListTab('settings')).toBe(false)
})
```

并把该文件第 2 行 import 改为（加 `isListTab`）：

```ts
import { memoryTabFilter, hasCachedData, shouldShowLoading, mergePage, mergeAppend, mergeRefreshPage, nextCursorAfter, tabTotalCount, isListTab } from '../src/web/tab-cache'
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/tab-cache.test.ts`
Expected: FAIL —— `isListTab` 未导出（import 报错 / 运行时 undefined）。

- [ ] **Step 3: 最小实现**

在 `src/web/tab-cache.ts` 末尾追加：

```ts
// --- 设置 tab（spec 2026-08-07 settings-tab §3.2）---------------------------

/**
 * 该 tab 是否走列表数据流（refresh / loadMore / 轮询 / 无限滚动 / 列表尾部）。
 * settings tab 无列表：不进这些入口——它只在激活时挂载设置区块，区块自管理
 * fetch/保存/错误行。新增非列表 tab 时此函数是唯一需要改的判据。
 */
export function isListTab(tab: string): boolean {
  return tab !== 'settings'
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/tab-cache.test.ts`
Expected: PASS（全部，含既有用例）。

- [ ] **Step 5: Commit**

```bash
git add src/web/tab-cache.ts tests/tab-cache.test.ts
git commit -m "feat(web): tab-cache 加 isListTab 纯函数（settings 无列表数据流判据）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: App.tsx 接线 + 源码层回归断言

**Files:**
- Modify: `tests/web-ui.test.ts`（末尾追加，先红）
- Modify: `src/web/App.tsx`（9 处编辑，见 Step 3）

**Interfaces:**
- Consumes: Task 1 的 `isListTab`（`src/web/tab-cache.ts` 导出）
- Produces: 「设置」tab 完整可用；后续新增设置区块 = 新 section 组件 + settings 分支追加一行挂载。

- [ ] **Step 1: 写失败的源码层文本断言**

在 `tests/web-ui.test.ts` 末尾追加：

```ts
// 设置 tab 统一收拢（spec 2026-08-07 settings-tab）：LLM/判定设置从常驻位置收进
// 独立「设置」tab。回归防护：
// 1. tab 栏有 settings 条目且不显计数徽标；
// 2. LlmSettings/JudgeSettings 恰一处 JSX 挂载（常驻位置已删，只在 settings 分支）；
// 3. 五处列表数据流入口都有 isListTab 短路守卫。
test('App.tsx 设置 tab 存在 + 区块恰一处挂载 + 数据流短路 (source text)', () => {
  const s = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')
  // tab 条目 + 无计数徽标
  expect(s).toContain("key: 'settings'")
  expect(s).toContain("label: '设置'")
  expect(s).toContain('count: null')
  // 区块只在 settings 分支挂载（常驻位置已移除 => 全文恰一处）
  expect(s).toContain("tab === 'settings'")
  expect((s.match(/<LlmSettings \/>/g) ?? []).length).toBe(1)
  expect((s.match(/<JudgeSettings \/>/g) ?? []).length).toBe(1)
  // 五处入口守卫：refresh / loadMore / observer effect / 轮询 effect / 列表尾部
  expect((s.match(/isListTab\(/g) ?? []).length).toBeGreaterThanOrEqual(5)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/web-ui.test.ts`
Expected: FAIL —— 新测试红（App.tsx 尚无 settings tab 锚点）；既有测试全绿。

- [ ] **Step 3: App.tsx 九处编辑**

按下列顺序改 `src/web/App.tsx`（行号为写计划时的参考，以实际文本为准）：

**(a) import 加 `isListTab`**（第 14 行）：

```ts
import { memoryTabFilter, shouldShowLoading, mergeAppend, mergeRefreshPage, nextCursorAfter, tabTotalCount, isListTab, type MemoryTabKey } from './tab-cache'
```

**(b) TabKey 加 settings**（第 37 行）：

```ts
type TabKey = 'candidate' | 'approved' | 'rejected' | 'discards' | 'runs' | 'settings'
```

**(c) 四个 Record 初始值补 settings 键**（第 67/70/76/77 行；`pending` 的 settings 为 **false**——settings 无加载态，不得沿用 candidate 的初始 true）：

```ts
  const [loaded, setLoaded] = useState<Record<TabKey, boolean>>({ candidate: false, approved: false, rejected: false, discards: false, runs: false, settings: false })
```

```ts
  const [pending, setPending] = useState<Record<TabKey, boolean>>({ candidate: true, approved: false, rejected: false, discards: false, runs: false, settings: false })
```

```ts
  const [loadingMore, setLoadingMore] = useState<Record<TabKey, boolean>>({ candidate: false, approved: false, rejected: false, discards: false, runs: false, settings: false })
```

```ts
  const [loadMoreError, setLoadMoreError] = useState<Record<TabKey, string | null>>({ candidate: null, approved: null, rejected: null, discards: null, runs: null, settings: null })
```

**(d) `refresh` 开头守卫**（第 81-82 行）：

```ts
  async function refresh(target: TabKey) {
    if (!isListTab(target)) return // settings tab 无列表数据流（spec settings-tab §3.2）
```

**(e) `loadMore` 开头守卫**（第 113-114 行）：

```ts
  async function loadMore(target: TabKey) {
    if (!isListTab(target)) return // settings tab 无列表数据流（spec settings-tab §3.2）
```

**(f) IntersectionObserver effect 加 settings 早退**（第 142-150 行）：

```ts
  useEffect(() => {
    if (!isListTab(tab)) return // settings tab 无无限滚动
    const el = sentinelRef.current
    if (!el) return
```

（其余不动。）

**(g) 轮询 effect：settings 时不拉列表不建 interval，但一次性拉 status**（第 154-159 行）。一次性 status 是为了 daemon 断连时全局错误 banner 在设置 tab 也可见（banner 由 error 状态驱动）+ 状态栏进 tab 时新鲜：

```ts
  useEffect(() => {
    setError(null)
    if (!isListTab(tab)) {
      // settings tab：不拉列表、不建轮询；一次性 status（断连 banner + 状态栏可见性）
      void getStatus().then(setStatus).catch((e) => setError(e instanceof Error ? e.message : String(e)))
      return
    }
    void refresh(tab)
    const t = setInterval(() => void refresh(tab), 3000)
    return () => clearInterval(t)
  }, [tab])
```

**(h) tabs 数组加 settings 条目 + 徽标条件渲染**（第 260-266 行与第 291 行）。数组类型 count 改为 `number | null`：

```ts
  const tabs: ReadonlyArray<{ key: TabKey; label: string; count: number | null }> = [
    { key: 'candidate', label: '候选审批', count: tabTotalCount(status, 'candidate') ?? 0 },
    { key: 'approved', label: '已审批', count: tabTotalCount(status, 'approved') ?? 0 },
    { key: 'rejected', label: '已拒绝', count: tabTotalCount(status, 'rejected') ?? 0 },
    { key: 'discards', label: 'AI自动拒绝', count: tabTotalCount(status, 'discards') ?? 0 },
    { key: 'runs', label: '蒸馏记录', count: tabTotalCount(status, 'runs') ?? 0 },
    { key: 'settings', label: '设置', count: null }, // 设置 tab 无计数徽标
  ]
```

tab 按钮内的徽标行（原 `{t.label}` 后紧跟的 `<span style={{ marginLeft: 6, ... }}>{t.count}</span>`）改为：

```tsx
              {t.label}
              {t.count !== null ? (
                <span style={{ marginLeft: 6, fontSize: 12, opacity: 0.85 }}>{t.count}</span>
              ) : null}
```

**(i) 常驻挂载移除 + settings 分支渲染 + 列表尾部门控**：

删除状态栏与错误 banner 之间的常驻区块（第 347-351 行整段，含两行注释）：

```tsx
      {/* LLM 设置区块 - 生效回显行 + 保存/测试连接/清除 */}
      <LlmSettings />

      {/* 判定设置区块 - 模式 + agent 预算 */}
      <JudgeSettings />
```

内容区渲染链（第 369 行起，原 `{error ? null : showLoading && listEmpty ? (`）前面插入 settings 分支——settings 内容不受 `error ? null` 前缀影响（区块自带错误行，断连由全局 banner + 区块内错误行呈现）：

```tsx
      {tab === 'settings' ? (
        <>
          {/* 设置区块挂载点（spec 2026-08-07 settings-tab §3.5）：
              新增设置 = 新 section 组件 + 此处追加一行。
              section 约定：<section> 包裹 + <h3> 标题 + 自管理 fetch/保存/错误行。 */}
          <LlmSettings />
          <JudgeSettings />
        </>
      ) : error ? null : showLoading && listEmpty ? (
        <p>加载中…</p>
      ) : tab === 'candidate' ? (
```

列表尾部整块（第 498-516 行：哨兵 div + 加载更多/重试/没有更多了）包进 `isListTab` 门控——`tabPageOf(tab).hasMore` 对 settings 会索引 `memCache['settings'] === undefined` 抛 TypeError，不门控是必现 crash：

```tsx
      {isListTab(tab) ? (
        <>
          {/* 列表尾部（五列表 tab 共用）。哨兵无条件渲染、在门控块外：observer effect 依赖
              [tab] 只在切 tab 时跑一次，哨兵若藏进门控（首访 pending=true -> 不在 DOM）
              则 observer 首访永远挂不上、无限滚动死锁（评审 Important #1）。加载中/出错时
              哨兵相交是安全 no-op——loadMore 有 pending/loadingMore/nextCursorAfter 三重守卫。
              加载更多 / 失败重试 / 到底提示仍在门控内。 */}
          <div ref={sentinelRef} style={{ height: 1 }} />
          {error ? null : showLoading ? null : (
            <>
              {loadingMore[tab] ? <p style={{ color: '#888', fontSize: 13 }}>加载更多…</p> : null}
              {loadMoreError[tab] ? (
                <button style={{ fontSize: 13 }} onClick={() => void loadMore(tab)}>
                  加载更多失败，点击重试（{loadMoreError[tab]}）
                </button>
              ) : null}
              {!tabPageOf(tab).hasMore && !listEmpty ? (
                <p style={{ color: '#aaa', fontSize: 12 }}>没有更多了</p>
              ) : null}
            </>
          )}
        </>
      ) : null}
```

注意：哨兵 `ref={sentinelRef}` 仍必须在内层 `error ? null : showLoading ? null : (` 门控**之前**（既有测试 `sentinel renders outside the error/showLoading gate` 锁此顺序，外层包裹不改变两者相对顺序）。

- [ ] **Step 4: 跑 web-ui 测试确认通过**

Run: `bun test tests/web-ui.test.ts`
Expected: PASS（全部，含新测试与既有 40+ 条文本断言）。

- [ ] **Step 5: 全量验证**

Run: `bun run typecheck && bun test`
Expected: typecheck 0 错误；全部测试绿（含 tab-cache 新用例）。

- [ ] **Step 6: Commit**

```bash
git add src/web/App.tsx tests/web-ui.test.ts
git commit -m "feat(web): 设置 tab 统一收拢 LLM/判定配置

LLM 设置与判定设置从常驻位置收进独立「设置」tab（无计数徽标）；
refresh/loadMore/轮询/observer/列表尾部五处入口经 isListTab 短路；
进入设置 tab 一次性拉 status 保证断连 banner 可见；区块本体零改动。
spec: docs/superpowers/specs/2026-08-07-settings-tab-design.md

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 验收对照（spec §6）

| 验收项 | 由哪个 task 交付 |
|---|---|
| 第 6 个「设置」tab，无计数徽标 | Task 2 (h) + 文本断言 |
| 5 个列表 tab 不再常驻设置区块 | Task 2 (i) 删除常驻挂载 + `match().length === 1` 断言 |
| 设置 tab 垂直堆叠两区块，交互零变化 | Task 2 (i)（组件本体未动） |
| 设置 tab 无轮询/列表请求 | Task 1 `isListTab` + Task 2 (d)(e)(f)(g)(i) |
| 切回设置 tab 生效回显重新拉取 | Task 2 (i) 切走卸载/切回重挂载（组件自带 mount-fetch） |
| daemon 断连时 banner + 区块内错误行 | Task 2 (g) 一次性 status + 区块既有错误行 |
| typecheck + bun test 全绿 | Task 2 Step 5 |
