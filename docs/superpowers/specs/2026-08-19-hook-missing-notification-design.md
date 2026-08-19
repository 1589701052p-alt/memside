# 未安装 hook 提醒 spec

日期：2026-08-19
状态：待批准
关联：`docs/superpowers/specs/2026-08-19-runtime-settings-four-slots-design.md`（前作，落地四槽独立配置 + 实时安装状态探针 `isHooksInstalled`/`isOpencodePluginInstalled`）。本 spec 复用前作的探针 + 现有消息中心（`notifications` 表）做「未安装 hook」提醒，不新增表、不重构探针。

## 1. 背景

前作让设置页能实时显示四槽（claude / codeagent / opencode / nga）的安装状态徽标，但**仅当用户主动打开设置页时**才探测——daemon 启动后若用户从未进设置页，四槽全未安装也无人知晓，记忆捕获（capture → distill → inject）全程静默失效。前作 §5 明确「不碰启动时自动装」，但**未覆盖「未装时的提醒」**：用户装好 daemon、却忘了/没装 hook，daemon 跑得很健康但一个会话都捕获不到，且无任何信号提示。

### 1.1 用户需求

用户明确要求：**如果未安装 hook 要有通知提醒**。

经澄清两个决策：

1. **提醒范围**：四个槽**全部都没有装**时才提醒，**只要有一个装了就不提醒**（停止打扰）。理由：memside 只需任一 agent 的 hook 在跑就能捕获；四槽全空 = 用户肯定漏装，属真问题；任一已装 = 捕获链路在跑，不打扰。
2. **触发时机**：daemon 启动探一次 + 之后周期轮询复探。理由：仅启动一次无法捕捉「用户卸载/手动删 hook 后的漂移」；周期复探能发现卸载后的失效，但需防频繁打扰（折叠去重 + 已装即清旧提醒）。

### 1.2 为什么 architectural

不是 relabel：复用现有探针但新增**组合判定函数**（四槽归一为 allMissing 布尔）+ 修复 `insertNotification` 折叠分支对非 degradation kind 的硬编码 bug + 新增 `markNotificationsReadByKind` store API + daemon 注入周期检查定时器 + 前端消息 chip 映射。跨 `store.ts` / `install.ts` / `daemon.ts` / `server.ts` / `web/App.tsx` + 测试，属产品行为变更（新增一类用户提醒），按 CLAUDE.md 走 brainstorming spec+plan。

## 2. 目标 / 非目标

### 目标

1. **全空提醒**：四槽（claude/codeagent hooks + opencode/nga plugin）全部未安装时，daemon 写一条 `hook_missing` 消息进 `notifications` 表，前端消息 tab + 顶部状态栏 🔔 自动反映（复用现有轮询 3s 拉一次 `/api/status`）。
2. **任一已装即停打扰**：任一槽已装 → 不写新提醒；若存在未读的旧 `hook_missing` 消息，自动标记已读（用户不再被 🔔 打扰，但历史消息仍可在消息 tab 搜索查看）。
3. **启动 + 周期复探**：daemon 启动后立即探一次；之后每 5 分钟周期复探。两次走同一组合判定函数，外层 try/catch 永不抛（探针本身已永不抛，再兜一层防定时器中断）。
4. **零回归**：现有三种 kind（degradation/llm_error/parse_error）行为逐字节不变；status 端点形状不变（`unreadNotifications` 已天然包含新 kind）；启动自动装 claude 逻辑不动；探针 `isHooksInstalled`/`isOpencodePluginInstalled` 签名不动。

### 非目标

- **不主动安装**——只提醒，不自动装（沿用前作 §5「不碰启动时自动装」；自动装是另一条产品决策，本 spec 不触及）。
- **不区分槽位提醒**——不分别提醒「claude 没装」「opencode 没装」，只有「四槽全空」一条聚合提醒（YAGNI；任一已装即静默，细分无意义）。
- **不改 status 端点形状**——`unreadNotifications` 聚合计数已含新 kind，不新增字段（前作 status 形状稳定，不破坏）。
- **不改探针**——`isHooksInstalled`/`isOpencodePluginInstalled` 签名/行为不动，本 spec 只组合调用。
- **不做设置页内的提醒**——提醒走消息中心，不进设置页徽标（设置页已有自己的实时徽标，前作覆盖）。

## 3. 接口契约

### 3.1 新增 kind（`src/memory/store.ts`）

`NOTIFICATION_KINDS` 从 `['degradation','llm_error','parse_error']` 扩为 `['degradation','llm_error','parse_error','hook_missing']`。`NotificationKind` 类型随之。`NotificationRow.kind` 跟随。

### 3.2 修复 `insertNotification` 折叠分支（`src/memory/store.ts`，回归 bug 修复）

现状（`store.ts:1247-1257`）的 `foldConds`：

```ts
const foldConds = (input.kind === 'llm_error' || input.kind === 'parse_error')
  ? and(eq(notifications.kind, input.kind), isNull(notifications.readAt), body===null?isNull:eq(body))
  : and(eq(notifications.kind, 'degradation'), isNull(notifications.readAt), eq(notifications.title, input.title))
```

else 分支硬编码 `eq(notifications.kind, 'degradation')`——新增 `hook_missing` kind 走 else 时折叠查询会去找 `kind='degradation'` 的未读同 title，永远查不到 → 折叠失效 → 每次复探都新插一条，违背 §2「防频繁打扰」。

**修复**：else 分支改用 `eq(notifications.kind, input.kind)`（按调用 kind 折叠，而非硬编码 degradation）。degradation 行为逐字节不变（仍是「按 title 折叠未读同 kind」），只是 kind 从字面量改成入参——对 degradation 调用语义等价。

修复后 foldConds：

```ts
const foldConds = (input.kind === 'llm_error' || input.kind === 'parse_error')
  ? and(eq(notifications.kind, input.kind), isNull(notifications.readAt), body===null?isNull(notifications.body):eq(notifications.body, body))
  : and(eq(notifications.kind, input.kind), isNull(notifications.readAt), eq(notifications.title, input.title))
```

> 注：llm_error/parse_error 分支保持原样（按 body 折叠）；degradation/hook_missing 走 else（按 title 折叠）。`hook_missing` 的 title 固定（见 §3.4），折叠语义 = 未读同 title 只刷新 ts 浮顶，不新插——满足「周期复探不刷屏」。

### 3.3 新增 `markNotificationsReadByKind`（`src/memory/store.ts`）

```ts
/** 把指定 kind 的所有未读消息标记已读。返回本次标记条数。永不因「无未读」抛错。 */
export async function markNotificationsReadByKind(db: DbClient, kind: NotificationKind): Promise<number>
```

镜像 `markAllNotificationsRead`（`store.ts:1350`）的实现，加 `eq(notifications.kind, kind)` 过滤。任一槽已装时调 `markNotificationsReadByKind(db, 'hook_missing')` 清旧提醒。

### 3.4 组合判定函数（`src/install.ts`，新增纯组合，不改探针）

```ts
export interface HookInstallSummary {
  /** 四槽全部未安装 → true（应提醒）；任一已装 → false。 */
  allMissing: boolean
  /** 各槽 installed 明细，用于调试/未来扩展（本 spec 不消费，但写入便于观测）。 */
  details: {
    claude: boolean
    codeagent: boolean
    opencode: boolean
    nga: boolean
  }
}

/**
 * 探测四槽安装状态，归一为 allMissing 布尔。永不抛（探针本身永不抛，外层再兜 try/catch
 * 降级 allMissing:false——降级即「不提醒」，宁可漏提醒也不误报打扰）。
 * 复用 isHooksInstalled(claude/codeagent) + isOpencodePluginInstalled(opencode/nga)，
 * 路径来自 loadRuntimePaths(db) 的四槽 dir/settingsFilename，~ 已在探针内展开。
 */
export function checkAllHooksInstalled(db: DbClient): HookInstallSummary
```

- claude：`isHooksInstalled({baseDir: rp.claude.dir, settingsFilename: rp.claude.settingsFilename}).installed`。
- codeagent：`isHooksInstalled({baseDir: rp.codeagent.dir, settingsFilename: rp.codeagent.settingsFilename}).installed`。
- opencode：`isOpencodePluginInstalled({baseDir: rp.opencode.dir}).installed`。
- nga：`isOpencodePluginInstalled({baseDir: rp.nga.dir}).installed`。
- `allMissing = !details.claude && !details.codeagent && !details.opencode && !details.nga`。
- 探针路径含 `~`：探针内部已 `resolveHome` 展开（前作 §3.3），无需本函数再展。
- 函数同步（探针是同步的 `existsSync`/`readFileSync`），但 daemon 调用处包在 try/catch。**测试注入**：为可测，`checkAllHooksInstalled` 接受可选第二参 `opts?: { hooksProbe?, opencodeProbe? }`——注入 fake 探针不碰真实磁盘；生产路径（daemon）不传，用真实 `isHooksInstalled`/`isOpencodePluginInstalled`。

> 注：`db: DbClient` 入参是为了读 `loadRuntimePaths`。函数不写盘，纯读。

### 3.5 daemon 挂载（`src/daemon.ts`）

`startDaemon` 在 `Bun.serve` 之后、返回之前挂一个周期检查：

```ts
const HOOK_CHECK_INTERVAL_MS = 5 * 60 * 1000  // 5 分钟

async function checkHooksAndNotify(db: DbClient): Promise<void> {
  try {
    const summary = checkAllHooksInstalled(db)
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

// Bun.serve 之后：
void checkHooksAndNotify(db)  // 启动立即一次（不 await，不阻塞启动）
const hookCheckTimer = setInterval(() => { void checkHooksAndNotify(db) }, HOOK_CHECK_INTERVAL_MS)
hookCheckTimer.unref?.()  // 不阻止进程退出
```

- 启动立即一次：复探周期内的首次发现。
- `unref()`：定时器不阻止 daemon 退出（Bun `setInterval` 返回的 handle 有 `unref`，Node 也有；做可选链 `?.()` 防环境差异）。
- `checkHooksAndNotify` 永不抛（外层 try/catch）→ 定时器永不中断。
- **不碰启动自动装 claude**（`installClaudeHooks` 那段，`daemon.ts:228-236`）——零回归，§5。
- `installNotification` 折叠（§3.2 修复后）保证周期复探四槽仍全空时只刷新同一条未读消息的 ts，不刷屏。

### 3.6 server 端点（`src/server.ts`）

- `GET /api/notifications?kind=hook_missing` 已天然可用（`listNotificationsPage` 的 kind 校验读 `NOTIFICATION_KINDS`，§3.1 扩后即生效）——**无需改 server**。
- `/api/status` 的 `unreadNotifications` 聚合（`server.ts:567`）天然包含 `hook_missing` 未读计数——**无需改 status**。
- 唯一可能需改：若 server 端 kind 校验有独立硬编码列表（非读 `NOTIFICATION_KINDS`），需同步。经查 `listNotificationsPage:1305` 读 `NOTIFICATION_KINDS`，无需改。

### 3.7 前端（`src/web/App.tsx`）

消息 tab 的 kind 下拉（`App.tsx:791-795`）+ chip 映射（`App.tsx:833`）各加一行 `hook_missing`：

- 下拉选项：`{ value: 'hook_missing', label: '未安装 hook' }`。
- chip 映射：`hook_missing` → 琥珀色（warning 级，与 degradation 同色族，非 error 红），label「未安装 hook」。
- 顶部状态栏 🔔 + 未读计数已天然反映（读 `/api/status` 的 `unreadNotifications`），无需额外改状态栏。

## 4. 数据流

### 4.1 全新用户首次启动 daemon

1. daemon 启动 → `checkHooksAndNotify` 立即跑 → 四槽全空 → `insertNotification` 写一条 `hook_missing`（首次无未读同 title，新插）。
2. 前端 3s 内轮询 `/api/status` → `unreadNotifications` +1 → 顶部 🔔 红/琥珀 + 状态栏提示。
3. 用户点开消息 tab → 看到提醒 + body 引导去设置页装 hook。
4. 用户进设置页装任一槽 → re-probe 徽标变 ✓。
5. 下次周期复探（≤5min）→ `allMissing:false` → `markNotificationsReadByKind('hook_missing')` → 旧提醒标已读 → 🔔 清零。

### 4.2 周期复探发现漂移（卸载后失效）

1. 用户曾装 claude hook（`allMissing:false`，无提醒）。
2. 用户在设置页卸载或手动删 settings.json hook。
3. 下次周期复探 → 四槽又全空 → `insertNotification` 新写一条 `hook_missing`（旧那条已读，折叠查未读同 title 查不到 → 新插，是新事件，合理）。
4. 用户被再次提醒。

### 4.3 周期复探仍全空（折叠防刷屏）

1. daemon 启动写一条 `hook_missing`。
2. 5min 后复探仍全空 → `insertNotification` 走折叠分支（§3.2 修复后按 `kind='hook_missing'`+title 查到未读同 title）→ 不新插，只刷新该行 ts 浮顶。
3. 消息 tab 始终只有一条未读 `hook_missing`，不刷屏。

## 5. 与现有模块的耦合点

| 模块 | 改动 | 兼容性 |
|---|---|---|
| `src/memory/store.ts` | `NOTIFICATION_KINDS` 加 `hook_missing`；`insertNotification` else 折叠分支硬编码 `'degradation'`→`input.kind`；新增 `markNotificationsReadByKind` | degradation 折叠语义等价（kind 字面量→入参）；新 kind 折叠生效；纯增量 API |
| `src/install.ts` | 新增 `checkAllHooksInstalled`（组合判定，不改探针）+ `HookInstallSummary` | 纯增量，探针签名不动 |
| `src/daemon.ts` | `checkHooksAndNotify` + setInterval(5min) + 启动立即一次 | 挂在 Bun.serve 后，不碰 installClaudeHooks，零回归；unref 不阻退出 |
| `src/server.ts` | **不动**（kind 校验读 NOTIFICATION_KINDS，status 聚合天然含新 kind） | 零改动 |
| `src/web/App.tsx` | 消息 tab 下拉 + chip 各加 `hook_missing` 行 | 纯增量选项 |
| `src/settings.ts` | **不动**（`loadRuntimePaths` 已在前作提供四槽路径） | 零改动 |

## 6. 失败模式

1. **探针抛错**（理论不会，探针已永不抛）→ `checkAllHooksInstalled` 外层 try/catch 降级 `allMissing:false` → 不提醒。宁可漏提醒也不误报打扰。
2. **`loadRuntimePaths` 抛错**（理论不会，前作已永不抛）→ 同上降级不提醒。
3. **`insertNotification`/`markNotificationsReadByKind` DB 失败** → `checkHooksAndNotify` 外层 try/catch warn，不炸 daemon、不中断定时器。
4. **周期定时器未 unref** → 用 `?.()` 可选链兜底环境差异；即使没 unref，daemon 是长驻进程，无实际影响。
5. **用户装了但探针因路径 `~` 没展开误判未装** → 探针内部已 `resolveHome`（前作 §3.3），不会误判。
6. **折叠 bug 未修导致刷屏** → §3.2 必修，否则周期复探每 5min 一条。测试 §7.1 锁。
7. **daemon 重启后旧提醒还在** → notifications 表持久化，重启不丢；重启后立即复探，若已装则标已读清零，若仍全空则折叠刷新同一条。
8. **多槽共享路径**（opencode.dir === nga.dir）→ 探针各自独立调用，共享文件有标记则两槽都 `installed:true` → `allMissing:false` → 不提醒。磁盘真实，非 bug。

## 7. 测试策略

CLAUDE.md 强制：代码改动带测试，纯函数层优先，运行时组件最低限度源码层文本断言兜底。

### 7.1 store 纯函数层（`tests/store-notifications.test.ts` 或既有 notifications 测试扩展）

- `insertNotification` 折叠修复回归：
  - degradation 折叠仍生效（未读同 title 不新插只刷新 ts）——锁住 §3.2 修复不破坏既有。
  - **新增**：`hook_missing` 折叠生效——连插两次同 title 未读 `hook_missing`，表里只有一条（第二条刷新 ts），不刷屏。
  - 已读的 `hook_missing` 不折叠（新事件新插）。
- `markNotificationsReadByKind`：
  - 多条未读 `hook_missing` + 一条未读 `degradation` → 调 `markNotificationsReadByKind('hook_missing')` → 只 `hook_missing` 标已读，`degradation` 仍未读；返回标记条数正确。
  - 无未读该 kind → 返回 0，不抛。
  - 不影响其他 kind 已读状态。
- kind 白名单：`listNotificationsPage({kind:'hook_missing'})` 不抛 `InvalidNotificationFilterError`（白名单含新 kind）。

### 7.2 install 组合判定层（`tests/install-status.test.ts` 扩展或新文件）

`checkAllHooksInstalled`（注入 fake 探针，不碰真实磁盘）：
- 四槽全 false → `allMissing:true`。
- 任一槽 true → `allMissing:false`（claude true 其余 false / opencode true 其余 false / nga true 其余 false 各一 case）。
- fake 探针抛错 → 降级 `allMissing:false` 不抛。
- 路径来自 `loadRuntimePaths`（用 tmp db + 设四槽 dir 为 tmp 路径，验证传给探针的 baseDir/settingsFilename 正确）。
- 生产路径（不传探针）→ 用 tmp 目录真实装/不装，验证 `allMissing` 真实反映（至少一条：四槽全 tmp 空目录 → `allMissing:true`）。

### 7.3 daemon 层（`tests/daemon-*.test.ts` 扩展）

- `checkHooksAndNotify`（注入 fake `checkAllHooksInstalled` 或 fake 探针）：
  - `allMissing:true` → 写一条 `hook_missing` notification（查表验证 kind/title）。
  - `allMissing:false` 且存在未读 `hook_missing` → 该消息标已读（查表 readAt 非 null）。
  - `allMissing:false` 且无未读 `hook_missing` → 表无变化。
  - 连调两次 `allMissing:true` → 表里只有一条未读 `hook_missing`（折叠，§7.1 锁的端到端验证）。
  - 探针抛错 → 不写 notification、不抛、不中断（warn）。
- 启动挂载：`startDaemon` 后定时器存在（可 spy setInterval 或检查副作用——启动后立即一次的 notification 已写入）。最低限度源码层文本断言：daemon.ts 源含 `HOOK_CHECK_INTERVAL_MS` + `checkHooksAndNotify` + `setInterval`。

### 7.4 前端兜底（`tests/app-source-assertions.test.ts` 扩展）

- `App.tsx` 源含 `hook_missing` token + chip 映射（琥珀色）+ 下拉选项 label「未安装 hook」。
- `store.ts` 源含 `'hook_missing'` in `NOTIFICATION_KINDS`。

## 8. 上线后观测（结论回填 STATE.md）

1. 全新机器首次 `bun run src/cli.ts start` → 3s 内状态栏 🔔 提醒「运行环境未安装 hook」。
2. 进设置页装任一槽 → ≤5min 内 🔔 清零（周期复探标已读）。
3. 卸载后 → ≤5min 内再次提醒。
4. 周期复探仍全空 → 消息 tab 始终一条未读 `hook_missing`，不刷屏（折叠生效）。
5. degradation/llm_error/parse_error 三种既有消息行为不变（折叠回归锁绿）。

## 9. deferred（follow-up，非本 spec）

1. 「启动时自动装」产品决策（前作 §5 + 本 spec §2 非目标均未触及）——是否 daemon 启动自动装 claude 槽，需独立 spec。
2. 分槽提醒（claude 没装 vs opencode 没装分别提醒）——YAGNI，任一已装即静默。
3. 周期间隔常量化（5min 写死 → 配置项）——YAGNI，5min 是探针成本可忽略的合理默认。
