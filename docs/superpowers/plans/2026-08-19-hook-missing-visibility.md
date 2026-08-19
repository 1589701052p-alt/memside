# hook_missing 提醒显眼化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 hook_missing 提醒从"藏消息 tab、5min 才查"改成"状态栏顶部琥珀警示条（跳设置 tab）+ 🔔 角标变色 + 30s 检测"。

**Architecture:** 纯增强，不改前作折叠/复探/永不抛逻辑。3 处改动：daemon 间隔常量 5min→30s；server status 加 `unreadHookMissing`+`latestUnreadHookMissing` 两 optional 字段（复刻现有 unreadDegradations/latestUnreadLlmError 模式）；App.tsx 加 🔔 角标 hook_missing 琥珀分支 + 降级条后加 hook_missing 顶部警示条（跳 settings tab）。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite；前端 React 19 inline style。测试 bun:test。

**Spec:** `docs/superpowers/specs/2026-08-19-hook-missing-visibility-design.md`（本 plan 从该 spec 论证，executor 须读 spec + plan）。

## Global Constraints

- **零回归**：既有 llm_error/parse_error/degradation 警示条 + 角标行为逐字节不变；前作折叠/复探/永不抛契约不动（spec §2）。
- **30s + 折叠防刷屏**：间隔改 30s 后，前作 foldConds（按 kind+title 折叠未读）必须仍生效——30s 频率下折叠更重要。不重测折叠（前作 §7.1 已锁）但执行时确认既有折叠测试绿。
- **optional 兼容**：status 新字段 optional + `?? 0`/`?? null` 兜底（老 daemon 不返回不崩前端）。
- **警示条跳 settings tab**（非 messages）——用户需去设置页装 hook。
- **文案字面量**（spec §3.5）：警示条 `⚠️ 运行环境未安装 hook——记忆捕获将生效，去「设置」装一个 agent 的 hook`（注意 spec §3.5 写的是"将不生效"，以 spec 为准 = "将不生效"）。
- **颜色字面量**：角标琥珀 `#b26a00`；警示条背景 `#fff3e0` / 字 `#b26a00` / 边框 `1px solid #ffb300`。
- **常量字面量**：`HOOK_CHECK_INTERVAL_MS = 30 * 1000`。
- **测试命令**：`bun run typecheck` + `bun test`（Bash 工具，非 PowerShell `&&`；非 npm test）。
- **不碰真实磁盘**：测试用 tmp db + fake 探针注入。

## File Structure

| 文件 | 责任 | 改动 |
|---|---|---|
| `src/daemon.ts` | hook 检测间隔 | `HOOK_CHECK_INTERVAL_MS` 5min→30s（:160，纯常量） |
| `src/server.ts` | status 端点 | 加 `unreadHookMissing` + `latestUnreadHookMissing` 两 optional 字段（复刻 :536-570 模式） |
| `src/web/api.ts` | status client 类型 | `MemsideStatus` 加两 optional 字段（:116-122） |
| `src/web/App.tsx` | 状态栏 UI | 🔔 角标加 hook_missing 琥珀分支（:627-631）；降级条后加 hook_missing 警示条跳 settings（:702 后） |

---

### Task 1: daemon 间隔 5min→30s

**Files:**
- Modify: `src/daemon.ts`（`HOOK_CHECK_INTERVAL_MS` :160）
- Test: `tests/daemon-hook-check.test.ts` 或 `tests/app-source-assertions.test.ts`（源码断言常量值）

**Interfaces:**
- Produces: `HOOK_CHECK_INTERVAL_MS === 30 * 1000`。Task 2/3 不依赖本任务（server/App 独立）。

- [ ] **Step 1: 写失败测试——常量值 30s**

在 `tests/app-source-assertions.test.ts` 追加（或 daemon-hook-check.test.ts 若有导出常量断言）：

```ts
import { readFileSync } from 'node:fs'

describe('hook 检测间隔 30s（spec 2026-08-19 显眼化 §3.1）', () => {
  it('daemon.ts HOOK_CHECK_INTERVAL_MS === 30 * 1000', () => {
    const src = readFileSync(new URL('../../src/daemon.ts', import.meta.url), 'utf-8')
    // 锁常量值 30s（防回退到 5min）
    expect(src).toMatch(/HOOK_CHECK_INTERVAL_MS\s*=\s*30\s*\*\s*1000/)
  })
})
```

- [ ] **Step 2: 跑测试验证失败**

Run（Bash 工具）：`bun test tests/app-source-assertions.test.ts -t 30s`
Expected: FAIL——当前是 `5 * 60 * 1000`，不匹配 `30 * 1000`。

- [ ] **Step 3: 实现——改常量**

`src/daemon.ts:160`：

```ts
const HOOK_CHECK_INTERVAL_MS = 30 * 1000
```

（注释更新：从"每 5min"改"每 30s"，spec §3.1——探针毫秒级，30s 无负担，卸载后 ≤30s 提醒）

- [ ] **Step 4: 跑测试验证通过 + 既有 daemon 测试不回归**

Run（Bash 工具）：`bun test tests/app-source-assertions.test.ts tests/daemon-hook-check.test.ts`
Expected: PASS（新断言绿 + 既有 checkHooksAndNotify/折叠/永不抛测试仍绿）。

- [ ] **Step 5: typecheck**

Run（Bash 工具）：`bun run typecheck`
Expected: exit 0。

- [ ] **Step 6: Commit**

```bash
git add src/daemon.ts tests/app-source-assertions.test.ts
git commit -m "feat(daemon): hook 检测间隔 5min→30s（探针毫秒级，卸载后≤30s提醒）"
```

---

### Task 2: server status 加 unreadHookMissing + latestUnreadHookMissing

**Files:**
- Modify: `src/server.ts`（status 端点 :497-577，复刻 :536-570 模式）
- Test: `tests/server-notifications.test.ts`（既有扩展）

**Interfaces:**
- Consumes: `unreadByKind`（server.ts:532-535 已聚合）、`notifications` 表 Drizzle schema。
- Produces: status 返回 `unreadHookMissing?: number` + `latestUnreadHookMissing?: { body: string|null; ts: number } | null`。Task 3 的 App.tsx + api.ts 依赖本字段。

- [ ] **Step 1: 写失败测试——status 含两新字段**

在 `tests/server-notifications.test.ts` 追加（复用既有 tmp db + createApp + insertNotification helper）：

```ts
describe('status hook_missing 字段（spec 2026-08-19 显眼化 §3.2）', () => {
  it('有未读 hook_missing → unreadHookMissing>0 + latestUnreadHookMissing 含 body/ts', async () => {
    await insertNotification(db, { kind: 'hook_missing', title: '运行环境未安装 hook', body: 'b1' })
    const res = await app.fetch(new Request('http://x/api/status'))
    const status = await res.json()
    expect(status.unreadHookMissing).toBe(1)
    expect(status.latestUnreadHookMissing).toBeTruthy()
    expect(typeof status.latestUnreadHookMissing.ts).toBe('number')
  })

  it('无未读 hook_missing → unreadHookMissing=0 + latestUnreadHookMissing=null', async () => {
    const res = await app.fetch(new Request('http://x/api/status'))
    const status = await res.json()
    expect(status.unreadHookMissing).toBe(0)
    expect(status.latestUnreadHookMissing).toBeNull()
  })

  it('既有字段不变（回归锁）：unreadLlmErrors/unreadDegradations 仍正确', async () => {
    await insertNotification(db, { kind: 'degradation', title: '降级了' })
    const res = await app.fetch(new Request('http://x/api/status'))
    const status = await res.json()
    expect(status.unreadDegradations).toBe(1)
    expect(status.unreadLlmErrors).toBe(0)
    expect(status.unreadNotifications).toBe(1)
  })
})
```

- [ ] **Step 2: 跑测试验证失败**

Run（Bash 工具）：`bun test tests/server-notifications.test.ts -t hook_missing`
Expected: FAIL——`unreadHookMissing` undefined。

- [ ] **Step 3: 实现——status 加两字段**

`src/server.ts` status 端点。先读 :532-539 确认 `unreadByKind` + `latestErrRows` 模式，照搬：

- 在 `latestErrRows` 查询（:536-539，`kind IN ('llm_error','parse_error')`）之后，加一个 latest hook_missing 查询：

```ts
const latestHookMissingRows = await deps.db
  .select({ body: notifications.body, ts: notifications.ts })
  .from(notifications)
  .where(and(eq(notifications.kind, 'hook_missing'), isNull(notifications.readAt)))
  .orderBy(desc(notifications.ts), desc(notifications.id)).limit(1).all()
```

- 在返回字段拼装（:567-573）加：

```ts
unreadHookMissing: unreadByKind['hook_missing'] ?? 0,
latestUnreadHookMissing: latestHookMissingRows[0] ?? null,
```

（`and`/`eq`/`isNull`/`desc` 已在 server.ts 顶部 import，沿用既有。）

- [ ] **Step 4: 跑测试验证通过**

Run（Bash 工具）：`bun test tests/server-notifications.test.ts`
Expected: PASS。

- [ ] **Step 5: typecheck**

Run（Bash 工具）：`bun run typecheck`
Expected: exit 0。

- [ ] **Step 6: Commit**

```bash
git add src/server.ts tests/server-notifications.test.ts
git commit -m "feat(server): status 加 unreadHookMissing + latestUnreadHookMissing"
```

---

### Task 3: 前端 🔔 角标 + 顶部警示条 + client 类型

**Depends on:** Task 2（`unreadHookMissing` 字段）。

**Files:**
- Modify: `src/web/api.ts`（`MemsideStatus` :116-122 加两 optional 字段）
- Modify: `src/web/App.tsx`（🔔 角标 :627-631 加 hook_missing 琥珀分支；降级条 :702 后加 hook_missing 警示条）
- Test: `tests/app-source-assertions.test.ts`（源码断言）

**Interfaces:**
- Consumes: Task 2 的 `unreadHookMissing` 字段。
- Produces: 状态栏 hook_missing 警示条 + 🔔 角标变色。

- [ ] **Step 1: 写失败测试——源码含新字段 + 警示条 + 角标**

在 `tests/app-source-assertions.test.ts` 追加：

```ts
import { readFileSync } from 'node:fs'

describe('hook_missing 状态栏显眼化（spec 2026-08-19 显眼化 §3.4-3.5）', () => {
  const appSrc = readFileSync(new URL('../../src/web/App.tsx', import.meta.url), 'utf-8')
  const apiSrc = readFileSync(new URL('../../src/web/api.ts', import.meta.url), 'utf-8')

  it('api.ts MemsideStatus 含 unreadHookMissing + latestUnreadHookMissing', () => {
    expect(apiSrc).toContain('unreadHookMissing')
    expect(apiSrc).toContain('latestUnreadHookMissing')
  })

  it('App.tsx 🔔 角标含 hook_missing 琥珀分支', () => {
    expect(appSrc).toMatch(/unreadHookMissing/)
    expect(appSrc).toContain('#b26a00')  // 琥珀
  })

  it('App.tsx 顶部 hook_missing 警示条跳 settings tab', () => {
    expect(appSrc).toMatch(/unreadHookMissing/)
    // 警示条文案 + 跳 settings
    expect(appSrc).toContain('运行环境未安装 hook')
    expect(appSrc).toMatch(/setTab\(['"]settings['"]\)/)
    // 警示条琥珀样式
    expect(appSrc).toContain('#fff3e0')
  })
})
```

- [ ] **Step 2: 跑测试验证失败**

Run（Bash 工具）：`bun test tests/app-source-assertions.test.ts -t hook_missing 状态栏`
Expected: FAIL——api.ts 无 unreadHookMissing；App.tsx 无警示条。

- [ ] **Step 3: 实现——api.ts MemsideStatus 加字段**

`src/web/api.ts` `MemsideStatus` 接口（:116-122）加（spec §3.3）：

```ts
unreadHookMissing?: number
latestUnreadHookMissing?: { body: string | null; ts: number } | null
```

- [ ] **Step 4: 实现——App.tsx 🔔 角标加分支**

`src/web/App.tsx:627-631` 现有 bellColor 逻辑加 hook_missing 分支（spec §3.4）。先 Read 确认 :627-631 实际代码，Edit 加分支：

```ts
const bellColor =
  (status.unreadLlmErrors ?? 0) > 0 ? '#c00' :
  (status.unreadDegradations ?? 0) > 0 ? '#b26a00' :
  (status.unreadHookMissing ?? 0) > 0 ? '#b26a00' : '#666'
```

（沿用既有变量名 `bellColor`——先 Read 确认实际名，可能是内联三元。）

- [ ] **Step 5: 实现——App.tsx 降级条后加 hook_missing 警示条**

`src/web/App.tsx` 在降级条（:683-702）的 `) : null}` 之后、下一个区块之前，加 hook_missing 警示条（spec §3.5）：

```tsx
{(status.unreadHookMissing ?? 0) > 0 ? (
  <button
    onClick={() => setTab('settings')}
    style={{ display:'block', width:'100%', marginTop:4, padding:'6px 12px',
      background:'#fff3e0', color:'#b26a00', border:'1px solid #ffb300',
      borderRadius:4, cursor:'pointer', fontSize:13, textAlign:'left' }}
  >
    ⚠️ 运行环境未安装 hook——记忆捕获将不生效，去「设置」装一个 agent 的 hook
  </button>
) : null}
```

- [ ] **Step 6: 跑测试验证通过**

Run（Bash 工具）：`bun test tests/app-source-assertions.test.ts`
Expected: PASS。

- [ ] **Step 7: typecheck + 全量测试**

Run（Bash 工具）：`bun run typecheck && bun test`
Expected: 全绿（含 Task 1/2 新增 + 既有不回归）。

- [ ] **Step 8: Commit**

```bash
git add src/web/api.ts src/web/App.tsx tests/app-source-assertions.test.ts
git commit -m "feat(web): hook_missing 顶部琥珀警示条（跳设置）+ 🔔角标变色"
```

---

## Self-Review（plan 自审）

**1. Spec 覆盖**：
- §3.1 间隔 30s → Task 1。✅
- §3.2 status 两字段 → Task 2。✅
- §3.3 api.ts client 类型 → Task 3 Step 3。✅
- §3.4 🔔 角标 → Task 3 Step 4。✅
- §3.5 顶部警示条 → Task 3 Step 5。✅
- §7.1-7.3 测试 → 各 Task Step 1。✅

**2. Placeholder 扫描**：无 TBD/TODO；代码块给全字面量。✅

**3. 类型一致**：`unreadHookMissing?: number`（Task 2 server 产 + Task 3 api.ts 类型 + App.tsx 消费）一致；`latestUnreadHookMissing?: {body,ts}|null` 一致；`HOOK_CHECK_INTERVAL_MS = 30 * 1000`（Task 1 定义 + 断言）一致。✅

**4. 依赖**：Task 3 blockedBy 2（消费 status 字段）；Task 1/2 独立。顺序 1→2→3。✅
