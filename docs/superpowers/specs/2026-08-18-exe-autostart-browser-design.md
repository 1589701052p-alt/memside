# exe 双击自动开浏览器 + 安装后引导 — 设计 spec

日期：2026-08-18
分支：`feat/exe-autostart-browser`
状态：设计批准，链式执行（spec → plan → subagent-driven）

## 1. 背景

v0.2.0 发布后真实用户反馈：双击 `memside.exe` 安装器装完**无任何提示**，装完 finish 页只有「完成」按钮、不启动程序；双击桌面快捷方式只弹一个黑控制台窗口，用户不知道那就是 daemon、不知道 Web UI 在哪、不知道端口。对照源码：

- `src/exe/launcher.ts:69`：daemon 启动后仅打一行日志 `memside on http://127.0.0.1:7777`，**不开浏览器**。
- `installer/installer.nsi:18-21`：MUI finish 页（WELCOME/DIRECTORY/INSTFILES/FINISH）未设 `MUI_FINISHPAGE_RUN`，装完不启动。
- 四个启动入口（exe / `bun run start` / `memside start` / `start-and-install`）无一开浏览器。

STATE.md 发版观测第 2 条已挂「未签名 exe SmartScreen + UX 反馈——决定 v1.1 是否上代码签名」。本 spec 聚焦后者中的「安装后引导 + 启动后开浏览器」UX 缺陷。

## 2. 目标 / 非目标

### 目标

1. **exe 双击 → 自动开浏览器**：daemon 就绪后自动打开 `http://127.0.0.1:7777`，用户无需手输 URL。
2. **端口已是 memside 占用 → 直开 UI**：不杀不重启，复用现有实例。
3. **安装器 finish 页引导**：装完可勾选「立即启动」，消除「装完没反应」。
4. **控制台引导横幅**：让黑窗用户一眼看出「daemon 在跑 / Web UI 地址 / 窗口别关」。

### 非目标

- **CLI 入口不开浏览器**（`bun run start` / `memside start` / `start-and-install` 维持只打日志）。CLI 用户在终端工作，弹浏览器会打断工作流。
- 不做系统托盘 / 后台常驻 / 开机自启（STATE deferred v1.1+）。
- 不做代码签名（独立 follow-up，见 STATE 发版观测第 2 条）。
- 不做浏览器开窗失败的 retry。

## 3. 接口契约

### 3.1 `openBrowser(url, ctx)`（新 `src/exe/open-browser.ts`）

```ts
interface OpenBrowserCtx {
  platform: NodeJS.Platform
  spawn: (cmd: string[]) => Promise<{ stdout: string; exitCode: number | null }>
}

async function openBrowser(url: string, ctx: OpenBrowserCtx): Promise<boolean>
```

- 按 `ctx.platform` 选命令并 spawn：
  - `win32` → `['cmd', '/c', 'start', '', url]`
  - `darwin` → `['open', url]`
  - `linux` → `['xdg-open', url]`
- **best-effort 不抛**：spawn 失败 / 非零退出 → 返回 `false`（不抛，不杀 daemon）。成功 → `true`。
- `ctx` 形状与 `portCheck.ts` 的 `PortCheckCtx` 一致（平台 + spawn 注入），纯函数层可测三平台命令正确 + 失败降级。

### 3.2 `isMemsideHolder(holder, ownPid)`（同文件，纯函数）

```ts
function isMemsideHolder(cmdline: string, ownPid: number, holderPid: number): boolean
```

- `holderPid === ownPid` → `false`（不能是自己）。
- `/memside/i.test(cmdline)` → `true`（exe 路径 `%LOCALAPPDATA%\memside\memside.exe`、仓库 `...\memside\...` 都命中）。
- 否则 `false`。
- 误判风险分析：非 memside 进程命令行里恰好含 `memside` 字样的概率极低（如用户仓库目录名恰为 memside，但其 PID 不会 LISTENING 7777）；即便误判为「是 memside」走「直开 UI」，最坏后果是不回收而 daemon 因端口仍被占抛 EADDRINUSE 兜底退出，不会静默坏。可接受。

### 3.3 `launcher.ts` 启动三分支

端口检测（`findPortHolders`）后：

```
holders = findPortHolders([PORT])
  ├─ 空 → startDaemon → openBrowser → 横幅 → 常驻
  ├─ 全是 memside（isMemsideHolder 全 true）→ 不杀不重启 → openBrowser → 「已在运行」横幅 → exit(0)
  └─ 有非 memside → promptReclaim（现有）→ 杀后走「空」分支
```

### 3.4 `MEMSIDE_NO_OPEN=1` 逃生口

env 设了 → 不调 openBrowser，仅印横幅 URL（headless / RDP 场景）。零成本防「弹窗打断」抱怨。

### 3.5 控制台横幅

`memside on http://...` 单行日志升级为引导横幅（纯文本边框 + Web UI 地址 + 浏览器状态 + 「窗口别关 / Ctrl+C 退出」）。

### 3.6 安装器 finish 页（`installer/installer.nsi`）

```nsis
!define MUI_FINISHPAGE_RUN "$INSTDIR\memside.exe"
!define MUI_FINISHPAGE_RUN_TEXT "立即启动 memside"
```
默认勾选 → 装完 → 启动 exe → 开浏览器。

## 4. 数据流

```
双击 memside.exe（或桌面快捷方式）
  → launcher.main()
  → findPortHolders([7777])
  ├─ 无占用
  │   → startDaemon(内嵌资产 + 装 hooks + opencode 插件)
  │   → MEMSIDE_NO_OPEN? 否 → openBrowser(127.0.0.1:7777)
  │   → printBanner(...)
  │   → 常驻（Ctrl+C 退出）
  ├─ 全 memside 占用
  │   → openBrowser(127.0.0.1:7777)
  │   → printBanner(已在运行)
  │   → exit(0)
  └─ 含非 memside
      → promptReclaim → reclaim → 回到「无占用」分支
```

## 5. 与现有模块耦合点

- `src/exe/launcher.ts`：主改。引入 openBrowser + 三分支 + 横幅。
- `src/launch/portCheck.ts`：复用 `findPortHolders` / `promptReclaim` / `reclaim` / `PortCheckCtx`。**只读不改**。
- `installer/installer.nsi`：加两个 `MUI_FINISHPAGE_RUN*` define。
- `src/exe/assets.ts` / `manifest.ts` / `src/daemon.ts`：**零改动**。
- CLI 入口（`src/cli.ts` / `scripts/start.ts`）：**零改动**（仅 exe）。

## 6. 失败模式

| 失败 | 处理 |
|------|------|
| openBrowser spawn 失败（无 xdg-open / headless） | 返回 false，横幅仍印 URL，用户手抄。不杀 daemon。 |
| 非 memside 占端口且用户拒绝回收 | 现有行为：`process.exit(1)`。 |
| isMemsideHolder 误判（非 memside 命令行含 memside） | 走「直开 UI」，daemon 因 EADDRINUSE 兜底退出，无静默坏。 |
| 安装器 finish 勾选但 exe 启动失败 | MUI finish 页仅 spawn 不阻塞；失败无显式提示（NSIS 限制），用户可手动双击快捷方式。 |

## 7. 测试策略

### 7.1 纯函数（`tests/open-browser.test.ts`，新建）

- `openBrowser`：三平台命令正确性（注入 fake spawn 断言传入命令）+ spawn 抛错返回 false 不抛 + 非零退出返回 false。
- `isMemsideHolder`：自身 PID（false）/ 命令行含 memside（true）/ 不含（false）/ 空 cmdline（false）。
- `MEMSIDE_NO_OPEN` 判定纯函数（若有；否则 launcher 源码层断言）。

### 7.2 launcher 源码层文本断言（CLAUDE.md 运行时组件兜底面）

- 断言 `launcher.ts` 含 openBrowser 调用、三分支控制流 token、`MEMSIDE_NO_OPEN` 读取、横幅打印。
- 反向断言：不在 startDaemon 前调 openBrowser（先就绪再开窗）。

### 7.3 安装器文本断言（`tests/installer-nsi.test.ts`，新建）

- 断言 `installer/installer.nsi` 含 `MUI_FINISHPAGE_RUN` + `$INSTDIR\memside.exe` 指向。

### 7.4 门禁

`bun run typecheck && bun test` 全绿方可 push。

## 8. 上线后观测（硬要求，结论回填 STATE）

1. 双击 exe → 浏览器自动开 `127.0.0.1:7777`，黑窗横幅清晰。
2. daemon 已在跑时再双击 → 直开现有实例 UI，不弹回收询问、不杀进程。
3. 安装器装完勾选「立即启动」→ exe 启动 + 浏览器开。
4. `MEMSIDE_NO_OPEN=1` 双击 → 不弹浏览器，横幅印 URL。
