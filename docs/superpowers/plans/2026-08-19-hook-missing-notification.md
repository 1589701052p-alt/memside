# 未安装 hook 提醒 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 四槽（claude/codeagent hooks + opencode/nga plugin）全部未安装时，daemon 写一条 `hook_missing` 消息提醒用户去设置页装 hook；任一已装即停止打扰并清旧提醒。

**Architecture:** 复用前作的 `isHooksInstalled`/`isOpencodePluginInstalled` 只读探针 + 现有 `notifications` 表/`insertNotification` 折叠链路。新增组合判定函数 `checkAllHooksInstalled`（四槽归一为 allMissing 布尔，可注入探针便于测试）+ daemon 启动立即一次 + 每 5min 周期复探 + 修复 `insertNotification` else 折叠分支对非 degradation kind 的硬编码 bug + 新增 `markNotificationsReadByKind`。server 端点零改动（kind 白名单读 `NOTIFICATION_KINDS`，status 聚合天然含新 kind）。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite + zod；前端 React 19 inline style。测试 bun:test。

**Spec:** `docs/superpowers/specs/2026-08-19-hook-missing-notification-design.md`（本 plan 从该 spec 论证，executor 须读 spec + plan）。

## Global Constraints

- **永不抛**：`checkAllHooksInstalled` + `checkHooksAndNotify` 外层 try/catch，探针抛错降级 `allMissing:false`（不提醒），DB 失败 warn 不炸 daemon、不中断定时器（spec §6 #1/#3）。
- **折叠防刷屏**：周期复探仍全空时只刷新同一条未读 `hook_missing` 的 ts，不新插（spec §4.3）。依赖 Task 1 修复 foldConds else 分支。
- **零回归**：degradation/llm_error/parse_error 三种既有 kind 行为逐字节不变；status 端点形状不变；启动自动装 claude（`installClaudeHooks`）不碰（spec §2、§5）。
- **不碰真实磁盘**：测试用 tmp 目录 + 注入 fake 探针，绝不读写真实 `~/.claude`/`~/.config/opencode`。
- **kind 值字面量**：`'hook_missing'`（spec §3.1）。通知 title 字面量：`'运行环境未安装 hook'`（spec §3.4/§3.5）。body 字面量：`'检测到 claude code / codeagent / opencode / nga 四个槽均未安装，记忆捕获将不会生效。请打开「设置」页安装至少一个 agent 的 hook。'`。
- **周期字面量**：`HOOK_CHECK_INTERVAL_MS = 5 * 60 * 1000`（spec §3.5）。定时器 `unref?.()` 防阻退出。
- **测试命令**：`bun run typecheck` + `bun test`（用 Bash 工具跑，非 PowerShell `&&`；非 npm test）。

## File Structure

| 文件 | 责任 | 改动 |
|---|---|---|
| `src/memory/store.ts` | notifications 表 API | 加 `hook_missing` kind；修复 `insertNotification` foldConds else 分支硬编码 `'degradation'`→`input.kind`；新增 `markNotificationsReadByKind` |
| `src/install.ts` | hook/plugin 探针 + 组合判定 | 新增 `HookInstallSummary` 接口 + `checkAllHooksInstalled(db, opts?)` 组合函数（不改 `isHooksInstalled`/`isOpencodePluginInstalled`） |
| `src/daemon.ts` | daemon 启动 + 周期检查 | 新增 `checkHooksAndNotify(db, opts?)`；`Bun.serve` 后挂 `setInterval(5min)` + 启动立即一次 |
| `src/web/App.tsx` | 消息 tab UI | kind 下拉加 `hook_missing` 选项；chipColor + chip label 处理 `hook_missing`（琥珀色 `#e65100`） |
| `src/server.ts` | — | **不动**（spec §3.6 经查无需改） |
| `src/settings.ts` | — | **不动**（`loadRuntimePaths` 四槽路径前作已提供） |

---

### Task 1: store 层——新增 kind + 修复折叠 + markNotificationsReadByKind

**Files:**
- Modify: `src/memory/store.ts`（`NOTIFICATION_KINDS` :1219；`insertNotification` foldConds :1247-1257；`markAllNotificationsRead` :1350 附近新增同级函数）
- Test: `tests/store-notifications.test.ts`（既有文件扩展；若无则新建）

**Interfaces:**
- Produces: `NOTIFICATION_KINDS` 含 `'hook_missing'`；`markNotificationsReadByKind(db, kind): Promise<number>`。Task 3 的 `checkHooksAndNotify` 依赖 `insertNotification`（已存在，本任务修其折叠）+ `markNotificationsReadByKind`（本任务新增）。Task 4 依赖 `hook_missing` 进 `NOTIFICATION_KINDS`（kind 下拉/校验）。

- [ ] **Step 1: 写失败测试——`hook_missing` kind 进白名单 + 折叠生效**

在 `tests/store-notifications.test.ts`（既有则追加 describe；无则新建并复用既有 tmp db 建表 helper，参考既有 notifications 测试的建表模式）追加：

```ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import {
  NOTIFICATION_KINDS, insertNotification, markNotificationsReadByKind,
  markAllNotificationsRead, listNotificationsPage,
} from '../../src/memory/store'
// 复用既有测试的建表 helper（initNotificationsDb 之类）；若无则用 db.run 建 notifications 表
// schema 字段：id TEXT PK, ts INTEGER, kind TEXT, title TEXT, body TEXT NULL,
//             refType TEXT NULL, refId TEXT NULL, readAt INTEGER NULL

describe('hook_missing kind + 折叠 + markNotificationsReadByKind', () => {
  beforeEach(() => { /* 建空 notifications 表 / 重置 */ })

  it('NOTIFICATION_KINDS 含 hook_missing', () => {
    expect((NOTIFICATION_KINDS as readonly string[]).includes('hook_missing')).toBe(true)
  })

  it('hook_missing 折叠：连插两次同 title 未读只留一条', async () => {
    const id1 = await insertNotification(db, { kind: 'hook_missing', title: '运行环境未安装 hook', body: 'b1' })
    const id2 = await insertNotification(db, { kind: 'hook_missing', title: '运行环境未安装 hook', body: 'b2' })
    expect(id1).toBe(id2)  // 折叠：返回原 id，不新插
    const page = await listNotificationsPage(db, { kind: 'hook_missing' })
    expect(page.items.length).toBe(1)
  })

  it('已读的 hook_missing 不折叠（新事件新插）', async () => {
    const id1 = await insertNotification(db, { kind: 'hook_missing', title: '运行环境未安装 hook' })
    await markAllNotificationsRead(db)
    const id2 = await insertNotification(db, { kind: 'hook_missing', title: '运行环境未安装 hook' })
    expect(id1).not.toBe(id2)  // 旧已读，折叠查不到未读 → 新插
    const page = await listNotificationsPage(db, { kind: 'hook_missing' })
    expect(page.items.length).toBe(2)
  })

  it('degradation 折叠仍生效（回归锁：修复 foldConds 不破坏既有）', async () => {
    const id1 = await insertNotification(db, { kind: 'degradation', title: '降级了' })
    const id2 = await insertNotification(db, { kind: 'degradation', title: '降级了' })
    expect(id1).toBe(id2)
    const page = await listNotificationsPage(db, { kind: 'degradation' })
    expect(page.items.length).toBe(1)
  })

  it('markNotificationsReadByKind 只标指定 kind 未读', async () => {
    await insertNotification(db, { kind: 'hook_missing', title: '运行环境未安装 hook' })
    await insertNotification(db, { kind: 'hook_missing', title: '运行环境未安装 hook' }) // 折叠→仍 1 条
    await insertNotification(db, { kind: 'degradation', title: '降级了' })
    const n = await markNotificationsReadByKind(db, 'hook_missing')
    expect(n).toBe(1)  // 1 条未读 hook_missing 被标
    const hm = await listNotificationsPage(db, { kind: 'hook_missing', unreadOnly: true })
    const dg = await listNotificationsPage(db, { kind: 'degradation', unreadOnly: true })
    expect(hm.items.length).toBe(0)
    expect(dg.items.length).toBe(1)  // degradation 仍未读，不受影响
  })

  it('markNotificationsReadByKind 无未读该 kind 返回 0 不抛', async () => {
    await insertNotification(db, { kind: 'degradation', title: '降级了' })
    const n = await markNotificationsReadByKind(db, 'hook_missing')
    expect(n).toBe(0)
  })

  it('listNotificationsPage kind=hook_missing 不抛 InvalidNotificationFilterError', async () => {
    await expect(listNotificationsPage(db, { kind: 'hook_missing' })).resolves.toBeDefined()
  })
})
```

- [ ] **Step 2: 跑测试验证失败**

Run（Bash 工具）：`bun test tests/store-notifications.test.ts`
Expected: FAIL——`hook_missing` 不在 NOTIFICATION_KINDS（白名单不含 → listNotificationsPage 抛 InvalidNotificationFilterError / 折叠走 degradation 查不到）；`markNotificationsReadByKind` 未定义。

- [ ] **Step 3: 实现——加 kind**

`src/memory/store.ts:1219`：

```ts
export const NOTIFICATION_KINDS = ['degradation', 'llm_error', 'parse_error', 'hook_missing'] as const
```

- [ ] **Step 4: 实现——修复 foldConds else 分支硬编码**

`src/memory/store.ts` 把 `insertNotification` 内 foldConds 的 else 分支 `eq(notifications.kind, 'degradation')` 改为 `eq(notifications.kind, input.kind)`（spec §3.2）：

```ts
  const foldConds = (input.kind === 'llm_error' || input.kind === 'parse_error')
    ? and(
        eq(notifications.kind, input.kind),
        isNull(notifications.readAt),
        body === null ? isNull(notifications.body) : eq(notifications.body, body),
      )
    : and(
        eq(notifications.kind, input.kind),
        isNull(notifications.readAt),
        eq(notifications.title, input.title),
      )
```

- [ ] **Step 5: 实现——新增 `markNotificationsReadByKind`**

`src/memory/store.ts` 在 `markAllNotificationsRead`（:1350）之后新增：

```ts
/** 把指定 kind 的所有未读消息标记已读（spec 2026-08-19 §3.3）。返回本次标记条数。 */
export async function markNotificationsReadByKind(db: DbClient, kind: NotificationKind): Promise<number> {
  const rows = await db.update(notifications).set({ readAt: Date.now() })
    .where(and(eq(notifications.kind, kind), isNull(notifications.readAt)))
    .returning({ id: notifications.id })
  return rows.length
}
```

- [ ] **Step 6: 跑测试验证通过**

Run（Bash 工具）：`bun test tests/store-notifications.test.ts`
Expected: PASS——7 个新 case + 回归 case 全绿。

- [ ] **Step 7: typecheck**

Run（Bash 工具）：`bun run typecheck`
Expected: exit 0。

- [ ] **Step 8: Commit**

```bash
git add src/memory/store.ts tests/store-notifications.test.ts
git commit -m "feat(store): hook_missing kind + 修复 insertNotification 折叠硬编码 + markNotificationsReadByKind"
```

---

### Task 2: install 层——组合判定函数 checkAllHooksInstalled

**Files:**
- Modify: `src/install.ts`（在 `isOpencodePluginInstalled` :389 之后新增）
- Test: `tests/install-status.test.ts`（既有文件扩展）

**Interfaces:**
- Consumes: `isHooksInstalled`（`install.ts:343`）、`isOpencodePluginInstalled`（`install.ts:373`）、`loadRuntimePaths`（`src/settings.ts:198`，同步返回 `RuntimePaths`，四槽 `claude.{dir,settingsFilename}`/`codeagent.{dir,settingsFilename}`/`opencode.dir`/`nga.dir`）、`DbClient`。
- Produces: `HookInstallSummary` 接口 + `checkAllHooksInstalled(db, opts?): HookInstallSummary`（同步）。Task 3 的 `checkHooksAndNotify` 依赖本函数。

- [ ] **Step 1: 写失败测试——checkAllHooksInstalled 四槽归一 + 注入探针**

在 `tests/install-status.test.ts` 追加（复用既有文件的 tmp 目录 + fake 探针模式；既有探针测试已示范用 tmp baseDir 不碰真实磁盘）：

```ts
import { checkAllHooksInstalled } from '../../src/install'
// 需要 tmp db + loadRuntimePaths 返回 tmp 路径的四槽：
// 用真实 in-memory sqlite db，app_settings 表写入四槽 dir = tmp 路径，
// 使 loadRuntimePaths(db) 返回 tmp 路径；或直接断言注入探针被调用的 baseDir。

describe('checkAllHooksInstalled 组合判定', () => {
  it('四槽全 false → allMissing:true', () => {
    const s = checkAllHooksInstalled(db, {
      hooksProbe: () => ({ installed: false, settingsPath: '' }),
      opencodeProbe: () => ({ installed: false, pluginPath: '', dirExists: false }),
    })
    expect(s.allMissing).toBe(true)
    expect(s.details).toEqual({ claude: false, codeagent: false, opencode: false, nga: false })
  })

  it('claude 已装其余未装 → allMissing:false', () => {
    const s = checkAllHooksInstalled(db, {
      hooksProbe: (o) => ({ installed: o.settingsFilename === 'settings.json', settingsPath: '' }),
      opencodeProbe: () => ({ installed: false, pluginPath: '', dirExists: false }),
    })
    expect(s.allMissing).toBe(false)
    expect(s.details.claude).toBe(true)
  })

  it('opencode 已装其余未装 → allMissing:false', () => {
    const s = checkAllHooksInstalled(db, {
      hooksProbe: () => ({ installed: false, settingsPath: '' }),
      opencodeProbe: (o) => ({ installed: o.baseDir?.endsWith('opencode') ?? false, pluginPath: '', dirExists: true }),
    })
    expect(s.allMissing).toBe(false)
    expect(s.details.opencode).toBe(true)
  })

  it('探针抛错 → 降级 allMissing:false 不抛', () => {
    const s = checkAllHooksInstalled(db, {
      hooksProbe: () => { throw new Error('boom') },
      opencodeProbe: () => { throw new Error('boom') },
    })
    expect(s.allMissing).toBe(false)  // 降级不提醒
  })

  it('传给探针的 baseDir/settingsFilename 来自 loadRuntimePaths 四槽', () => {
    // 设 db 四槽路径为 tmp 目录（如 codeagent.dir=tmp + settingsFilename=setting.json）
    // 断言 hooksProbe 收到对应 baseDir + settingsFilename
    let seenClaude: any = null, seenCodeagent: any = null
    checkAllHooksInstalled(db, {
      hooksProbe: (o) => { if (o.settingsFilename === 'settings.json') seenClaude = o; else seenCodeagent = o; return { installed: false, settingsPath: '' } },
      opencodeProbe: () => ({ installed: false, pluginPath: '', dirExists: false }),
    })
    expect(seenClaude.baseDir).toBe(tmpClaudeDir)
    expect(seenClaude.settingsFilename).toBe('settings.json')
    expect(seenCodeagent.settingsFilename).toBe('setting.json')
  })
})
```

> 测试文件顶端注释：说明本测试锁「四槽全空提醒」的组合判定（spec §3.4、§7.2），防 refactor 误改 allMissing 归一逻辑。

- [ ] **Step 2: 跑测试验证失败**

Run（Bash 工具）：`bun test tests/install-status.test.ts`
Expected: FAIL——`checkAllHooksInstalled` 未导出。

- [ ] **Step 3: 实现——HookInstallSummary + checkAllHooksInstalled**

`src/install.ts` 在 `isOpencodePluginInstalled` 之后新增（spec §3.4）。`loadRuntimePaths` 与 `DbClient` 从既有 import 拿（`loadRuntimePaths` 来自 `./settings`，`DbClient` 类型来自既有 install.ts 的 import 或 `./db/client`，沿用文件已有 import 风格）：

```ts
import { loadRuntimePaths } from './settings'

export interface HookInstallSummary {
  /** 四槽全部未安装 → true（应提醒）；任一已装 → false。 */
  allMissing: boolean
  details: { claude: boolean; codeagent: boolean; opencode: boolean; nga: boolean }
}

/**
 * 探测四槽安装状态归一为 allMissing（spec 2026-08-19 §3.4）。永不抛：探针本身永不抛，
 * 外层 try/catch 降级 allMissing:false（宁可漏提醒也不误报打扰）。路径来自
 * loadRuntimePaths(db) 四槽；探针内部已 resolveHome 展开 ~。opts 可注入 fake 探针便于测试。
 */
export function checkAllHooksInstalled(
  db: DbClient,
  opts?: {
    hooksProbe?: (o: { baseDir?: string; settingsFilename?: string }) => { installed: boolean }
    opencodeProbe?: (o: { baseDir?: string }) => { installed: boolean }
  },
): HookInstallSummary {
  const hooksProbe = opts?.hooksProbe ?? isHooksInstalled
  const ocProbe = opts?.opencodeProbe ?? isOpencodePluginInstalled
  try {
    const rp = loadRuntimePaths(db)
    const claude = hooksProbe({ baseDir: rp.claude.dir, settingsFilename: rp.claude.settingsFilename }).installed
    const codeagent = hooksProbe({ baseDir: rp.codeagent.dir, settingsFilename: rp.codeagent.settingsFilename }).installed
    const opencode = ocProbe({ baseDir: rp.opencode.dir }).installed
    const nga = ocProbe({ baseDir: rp.nga.dir }).installed
    return { allMissing: !claude && !codeagent && !opencode && !nga, details: { claude, codeagent, opencode, nga } }
  } catch {
    return { allMissing: false, details: { claude: false, codeagent: false, opencode: false, nga: false } }
  }
}
```

> 若 `DbClient` 在 install.ts 未 import，沿用文件内既有探针的 db 引用方式——但既有探针**不接 db**（只用 opts.baseDir）。`checkAllHooksInstalled` 是首个需读 db 路径的 install 函数，故需 import `loadRuntimePaths` from `./settings` + `DbClient` 类型。检查 install.ts 顶部 import，按既有风格补。

- [ ] **Step 4: 跑测试验证通过**

Run（Bash 工具）：`bun test tests/install-status.test.ts`
Expected: PASS。

- [ ] **Step 5: typecheck**

Run（Bash 工具）：`bun run typecheck`
Expected: exit 0。

- [ ] **Step 6: Commit**

```bash
git add src/install.ts tests/install-status.test.ts
git commit -m "feat(install): checkAllHooksInstalled 四槽归一组合判定（可注入探针）"
```

---

### Task 3: daemon 层——checkHooksAndNotify + 周期挂载

**Depends on:** Task 1（`insertNotification` 折叠修复 + `markNotificationsReadByKind`）、Task 2（`checkAllHooksInstalled`）。

**Files:**
- Modify: `src/daemon.ts`（`Bun.serve` 之后、返回之前挂载；`startDaemon` 内 :228 installClaudeHooks 之前/之后均可，放 Bun.serve 后）
- Test: `tests/daemon-install-paths.test.ts`（既有文件扩展；若无合适的 db 注入位则新建 `tests/daemon-hook-check.test.ts`）

**Interfaces:**
- Consumes: `checkAllHooksInstalled`（Task 2）、`insertNotification`（既有，Task 1 修折叠）、`markNotificationsReadByKind`（Task 1 新增）、`DbClient`、`HookInstallSummary`。
- Produces: `checkHooksAndNotify(db, opts?)` 导出（可测）+ `startDaemon` 挂 `setInterval(5min)` + 启动立即一次。

- [ ] **Step 1: 写失败测试——checkHooksAndNotify 三路径 + 折叠 + 不抛**

在 `tests/daemon-install-paths.test.ts` 追加（或新建 `tests/daemon-hook-check.test.ts`；复用既有 tmp db + notifications 表建表 helper）：

```ts
import { checkHooksAndNotify } from '../../src/daemon'
import { insertNotification, listNotificationsPage } from '../../src/memory/store'
// 复用既有 tmp db 建表（notifications + app_settings）

describe('checkHooksAndNotify', () => {
  it('allMissing:true → 写一条 hook_missing notification', async () => {
    await checkHooksAndNotify(db, { checkAllHooksInstalledFn: () => ({ allMissing: true, details: { claude: false, codeagent: false, opencode: false, nga: false } }) })
    const page = await listNotificationsPage(db, { kind: 'hook_missing' })
    expect(page.items.length).toBe(1)
    expect(page.items[0].title).toBe('运行环境未安装 hook')
  })

  it('allMissing:false 且有未读 hook_missing → 标已读', async () => {
    await insertNotification(db, { kind: 'hook_missing', title: '运行环境未安装 hook' })
    await checkHooksAndNotify(db, { checkAllHooksInstalledFn: () => ({ allMissing: false, details: { claude: true, codeagent: false, opencode: false, nga: false } }) })
    const page = await listNotificationsPage(db, { kind: 'hook_missing', unreadOnly: true })
    expect(page.items.length).toBe(0)  // 已标已读
  })

  it('allMissing:false 且无未读 hook_missing → 表无变化', async () => {
    await checkHooksAndNotify(db, { checkAllHooksInstalledFn: () => ({ allMissing: false, details: { claude: true, codeagent: false, opencode: false, nga: false } }) })
    const page = await listNotificationsPage(db, { kind: 'hook_missing' })
    expect(page.items.length).toBe(0)
  })

  it('折叠：连调两次 allMissing:true → 只一条未读 hook_missing', async () => {
    const fn = () => ({ allMissing: true, details: { claude: false, codeagent: false, opencode: false, nga: false } })
    await checkHooksAndNotify(db, { checkAllHooksInstalledFn: fn })
    await checkHooksAndNotify(db, { checkAllHooksInstalledFn: fn })
    const page = await listNotificationsPage(db, { kind: 'hook_missing' })
    expect(page.items.length).toBe(1)  // 折叠，不刷屏
  })

  it('checkAllHooksInstalledFn 抛错 → 不写 notification、不抛', async () => {
    await expect(checkHooksAndNotify(db, { checkAllHooksInstalledFn: () => { throw new Error('boom') } })).resolves.toBeUndefined()
    const page = await listNotificationsPage(db, { kind: 'hook_missing' })
    expect(page.items.length).toBe(0)
  })
})
```

> 测试文件顶端注释：锁「四槽全空提醒」的 daemon 触发 + 折叠 + 降级（spec §3.5、§7.3）。

- [ ] **Step 2: 跑测试验证失败**

Run（Bash 工具）：`bun test tests/daemon-install-paths.test.ts -t checkHooksAndNotify`（或新文件名）
Expected: FAIL——`checkHooksAndNotify` 未导出。

- [ ] **Step 3: 实现——checkHooksAndNotify 导出函数**

`src/daemon.ts` import `checkAllHooksInstalled`、`HookInstallSummary` from `./install`；`insertNotification`、`markNotificationsReadByKind` from `./memory/store`。新增：

```ts
const HOOK_CHECK_INTERVAL_MS = 5 * 60 * 1000

/**
 * 探测四槽 hook 安装状态并据此写/清 hook_missing 提醒（spec 2026-08-19 §3.5）。
 * allMissing → 写一条（折叠防刷屏）；任一已装 → 清未读 hook_missing。永不抛。
 * opts 可注入 checkAllHooksInstalledFn 便于测试。
 */
export async function checkHooksAndNotify(
  db: DbClient,
  opts?: { checkAllHooksInstalledFn?: (db: DbClient) => HookInstallSummary },
): Promise<void> {
  const check = opts?.checkAllHooksInstalledFn ?? ((d) => checkAllHooksInstalled(d))
  try {
    const summary = check(db)
    if (summary.allMissing) {
      await insertNotification(db, {
        kind: 'hook_missing',
        title: '运行环境未安装 hook',
        body: '检测到 claude code / codeagent / opencode / nga 四个槽均未安装，记忆捕获将不会生效。请打开「设置」页安装至少一个 agent 的 hook。',
      })
    } else {
      await markNotificationsReadByKind(db, 'hook_missing')
    }
  } catch (e) {
    console.warn('memside: hook install check failed', e)
  }
}
```

- [ ] **Step 4: 实现——startDaemon 挂载周期 + 启动立即一次**

`src/daemon.ts` `startDaemon` 在 `Bun.serve` 之后（返回 server/handle 之前）加：

```ts
  // 四槽全空提醒（spec 2026-08-19 §3.5）：启动立即一次 + 每 5min 周期复探。
  void checkHooksAndNotify(db)
  const hookCheckTimer = setInterval(() => { void checkHooksAndNotify(db) }, HOOK_CHECK_INTERVAL_MS)
  hookCheckTimer.unref?.()
```

> 放在 `Bun.serve` 之后、`installClaudeHooks`（若 opts 传了）之前或之后均可——两者无依赖，零回归（spec §5）。注意 `db` 变量名沿用 startDaemon 内已有的 db 句柄；若 startDaemon 内 db 名不同（如 `database`/`client`），用实际名。

- [ ] **Step 5: 跑测试验证通过**

Run（Bash 工具）：`bun test tests/daemon-install-paths.test.ts`（或新文件）
Expected: PASS。

- [ ] **Step 6: 源码层文本断言——挂载存在**

在 `tests/app-source-assertions.test.ts` 或新建 daemon 源码断言测试追加（兜底，spec §7.3）：

```ts
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'bun:test'

describe('daemon hook-check 挂载源码断言', () => {
  it('daemon.ts 含 HOOK_CHECK_INTERVAL_MS + setInterval + checkHooksAndNotify 启动立即一次', () => {
    const src = readFileSync(new URL('../../src/daemon.ts', import.meta.url), 'utf-8')
    expect(src).toContain('HOOK_CHECK_INTERVAL_MS')
    expect(src).toContain('setInterval')
    expect(src).toContain('checkHooksAndNotify')
    expect(src).toMatch(/unref\?\.\(\)/)
  })
})
```

- [ ] **Step 7: typecheck + 全量测试**

Run（Bash 工具）：`bun run typecheck && bun test`
Expected: typecheck exit 0；全量测试 PASS（含 Task 1/2 新增 + 既有不回归）。

- [ ] **Step 8: Commit**

```bash
git add src/daemon.ts tests/daemon-install-paths.test.ts tests/app-source-assertions.test.ts
git commit -m "feat(daemon): 四槽全空 hook 提醒——启动+5min 周期复探，任一已装即清旧提醒"
```

---

### Task 4: 前端——消息 tab 下拉 + chip 加 hook_missing

**Depends on:** Task 1（`hook_missing` 进 `NOTIFICATION_KINDS`，否则下拉/筛选无意义）。

**Files:**
- Modify: `src/web/App.tsx`（kind 下拉 :791-795；chipColor :818；chip label :833）
- Test: `tests/app-source-assertions.test.ts`（既有扩展）

**Interfaces:**
- Consumes: `hook_missing` kind（Task 1）。
- Produces: 消息 tab 可筛选 + 渲染 `hook_missing` 消息（琥珀 chip）。

- [ ] **Step 1: 写失败测试——源码含 hook_missing 选项 + chip 琥珀**

在 `tests/app-source-assertions.test.ts` 追加：

```ts
import { readFileSync } from 'node:fs'

describe('App.tsx hook_missing 消息渲染', () => {
  const src = readFileSync(new URL('../../src/web/App.tsx', import.meta.url), 'utf-8')

  it('kind 下拉含 hook_missing 选项', () => {
    expect(src).toMatch(/value="hook_missing"/)
    expect(src).toContain('未安装hook')
  })

  it('chipColor 处理 hook_missing 用琥珀 #e65100', () => {
    // chipColor 表达式应含 hook_missing 分支或与 degradation 同琥珀色
    expect(src).toMatch(/hook_missing/)
    expect(src).toContain('#e65100')
  })
})
```

- [ ] **Step 2: 跑测试验证失败**

Run（Bash 工具）：`bun test tests/app-source-assertions.test.ts -t hook_missing`
Expected: FAIL——`hook_missing` 不在 App.tsx 下拉/chip。

- [ ] **Step 3: 实现——下拉加选项**

`src/web/App.tsx:794`（`<option value="parse_error">解析失败</option>` 之后）加：

```tsx
              <option value="parse_error">解析失败</option>
              <option value="hook_missing">未安装hook</option>
```

- [ ] **Step 4: 实现——chipColor + chip label 处理 hook_missing**

`src/web/App.tsx:818` chipColor 当前：

```tsx
const chipColor = n.kind === 'degradation' ? '#e65100' : '#c00'
```

改为（hook_missing 与 degradation 同琥珀，warning 级，非 error 红；spec §3.7）：

```tsx
const chipColor = n.kind === 'degradation' || n.kind === 'hook_missing' ? '#e65100' : '#c00'
```

`src/web/App.tsx:833` chip label 当前：

```tsx
{n.kind === 'llm_error' ? 'LLM错误' : n.kind === 'parse_error' ? '解析失败' : '降级'}
```

改为（spec §3.7，加 hook_missing 分支）：

```tsx
{n.kind === 'llm_error' ? 'LLM错误' : n.kind === 'parse_error' ? '解析失败' : n.kind === 'hook_missing' ? '未安装hook' : '降级'}
```

- [ ] **Step 5: 跑测试验证通过**

Run（Bash 工具）：`bun test tests/app-source-assertions.test.ts`
Expected: PASS。

- [ ] **Step 6: typecheck + 全量测试**

Run（Bash 工具）：`bun run typecheck && bun test`
Expected: 全绿。

- [ ] **Step 7: Commit**

```bash
git add src/web/App.tsx tests/app-source-assertions.test.ts
git commit -m "feat(web): 消息 tab 支持 hook_missing 类型筛选+琥珀 chip"
```

---

## Self-Review（plan 自审）

**1. Spec 覆盖**：
- §3.1 kind → Task 1 Step 3。✅
- §3.2 foldConds 修复 → Task 1 Step 4。✅
- §3.3 markNotificationsReadByKind → Task 1 Step 5。✅
- §3.4 checkAllHooksInstalled → Task 2。✅
- §3.5 daemon 挂载 → Task 3 Step 3-4。✅
- §3.6 server 零改 → File Structure 标注不动，无需任务。✅
- §3.7 前端 chip/下拉 → Task 4。✅
- §4 数据流（全空提醒/漂移/折叠）→ Task 1 折叠 + Task 3 三路径测试覆盖。✅
- §7.1-7.4 测试 → 各 Task Step 1 对应。✅

**2. Placeholder 扫描**：无 TBD/TODO；所有代码块给全字面量。✅

**3. 类型一致**：`HookInstallSummary`（Task 2 定义）→ Task 3 import 用；`checkAllHooksInstalled(db, opts?)` 签名 Task 2 定义 → Task 3 调 `checkAllHooksInstalled(d)` 一致；`checkHooksAndNotify(db, opts?)` Task 3 定义 → 测试注入 `checkAllHooksInstalledFn` 一致；`markNotificationsReadByKind(db, kind)` Task 1 定义 → Task 3 调用一致。✅

**4. 依赖**：Task 3 blockedBy 1+2；Task 4 blockedBy 1；Task 1/2 独立可并行（但 subagent-driven 不并行实现，顺序跑）。✅
