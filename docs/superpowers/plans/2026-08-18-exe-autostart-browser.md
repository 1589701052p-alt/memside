# exe 双击自动开浏览器 + 安装后引导 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** exe 双击后自动开浏览器到 Web UI，端口已被 memside 占用时直开现有实例，安装器装完引导启动，黑窗印清晰横幅。

**Architecture:** 新增 `src/exe/open-browser.ts` 纯函数（平台 open 命令 + memside-holder 判定），launcher 三分支重构（无占用启动+开浏览器 / 全 memside 直开 UI / 非 memside 询问回收），安装器 finish 页加「立即启动」勾选，控制台横幅升级。

**Tech Stack:** Bun + TypeScript；NSIS 安装器；bun:test。

**Spec:** `docs/superpowers/specs/2026-08-18-exe-autostart-browser-design.md`

## Global Constraints

- 仅改 exe 启动路径 + 安装器；CLI 入口（`src/cli.ts` / `scripts/start.ts`）零改动。
- 不加新依赖（浏览器开窗走平台原生命令 spawn，复用 `portCheck.ts` 的 spawn ctx 形状）。
- `openBrowser` best-effort 不抛：失败返回 false，不杀 daemon，横幅仍印 URL。
- `MEMSIDE_NO_OPEN=1` 逃生口：设了不开浏览器仅印横幅。
- 运行门槛：`bun run typecheck && bun test` 全绿方可 push；PowerShell 5.1 不支持 `&&`，命令链在 Bash 工具跑。
- 测试一律 `bun test`，严禁 npm test。
- 运行时巨型组件（launcher）最低限度保留源码层文本断言兜底（CLAUDE.md）。

---

## File Structure

| 文件 | 责任 | 动作 |
|------|------|------|
| `src/exe/open-browser.ts` | `openBrowser(url, ctx)` 平台 open 命令 + `isMemsideHolder(cmdline, ownPid, holderPid)` 判定 + `shouldAutoOpen()` env 门禁 | 新建 |
| `tests/open-browser.test.ts` | openBrowser / isMemsideHolder / shouldAutoOpen 纯函数测试 | 新建 |
| `src/exe/launcher.ts` | 三分支启动控制流 + 横幅打印 + openBrowser 调用 | 改 |
| `tests/exe-launcher.test.ts` | launcher 源码层文本断言兜底 | 新建 |
| `installer/installer.nsi` | finish 页「立即启动」勾选 | 改 |
| `tests/installer-nsi.test.ts` | nsi 文本断言 | 新建 |

---

## Task 1: open-browser 纯函数 + 测试

**Files:**
- Create: `src/exe/open-browser.ts`
- Create: `tests/open-browser.test.ts`

**Interfaces:**
- Produces（后续 Task 2 launcher 消费）：
  ```ts
  export interface OpenBrowserCtx {
    platform: NodeJS.Platform
    spawn: (cmd: string[]) => Promise<{ stdout: string; exitCode: number | null }>
  }
  export async function openBrowser(url: string, ctx: OpenBrowserCtx): Promise<boolean>
  export function isMemsideHolder(cmdline: string, ownPid: number, holderPid: number): boolean
  export function shouldAutoOpen(): boolean  // 读 process.env.MEMSIDE_NO_OPEN
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/open-browser.test.ts`:

```ts
import { describe, test, expect } from 'bun:test'
import { openBrowser, isMemsideHolder, shouldAutoOpen, type OpenBrowserCtx } from '@/exe/open-browser'

function fakeCtx(platform: NodeJS.Platform, capture: { cmd: string[] | null }, result: { stdout: string; exitCode: number | null } | (() => Promise<{ stdout: string; exitCode: number | null }>)): OpenBrowserCtx {
  return {
    platform,
    spawn: async (cmd: string[]) => {
      capture.cmd = cmd
      return typeof result === 'function' ? await result() : result
    },
  }
}

describe('openBrowser', () => {
  test('win32 用 cmd /c start 打开', async () => {
    const cap: { cmd: string[] | null } = { cmd: null }
    const ok = await openBrowser('http://127.0.0.1:7777', fakeCtx('win32', cap, { stdout: '', exitCode: 0 }))
    expect(ok).toBe(true)
    expect(cap.cmd).toEqual(['cmd', '/c', 'start', '', 'http://127.0.0.1:7777'])
  })

  test('darwin 用 open 打开', async () => {
    const cap: { cmd: string[] | null } = { cmd: null }
    const ok = await openBrowser('http://127.0.0.1:7777', fakeCtx('darwin', cap, { stdout: '', exitCode: 0 }))
    expect(ok).toBe(true)
    expect(cap.cmd).toEqual(['open', 'http://127.0.0.1:7777'])
  })

  test('linux 用 xdg-open 打开', async () => {
    const cap: { cmd: string[] | null } = { cmd: null }
    const ok = await openBrowser('http://127.0.0.1:7777', fakeCtx('linux', cap, { stdout: '', exitCode: 0 }))
    expect(ok).toBe(true)
    expect(cap.cmd).toEqual(['xdg-open', 'http://127.0.0.1:7777'])
  })

  test('spawn 非零退出返回 false 不抛', async () => {
    const ok = await openBrowser('http://127.0.0.1:7777', fakeCtx('linux', { cmd: null }, { stdout: '', exitCode: 1 }))
    expect(ok).toBe(false)
  })

  test('spawn 抛错返回 false 不抛', async () => {
    const cap: { cmd: string[] | null } = { cmd: null }
    const ok = await openBrowser('http://127.0.0.1:7777', fakeCtx('linux', cap, async () => { throw new Error('no xdg-open') }))
    expect(ok).toBe(false)
  })
})

describe('isMemsideHolder', () => {
  test('自身 PID 判 false', () => {
    expect(isMemsideHolder('C:\\LOCALAPPDATA\\memside\\memside.exe', 1000, 1000)).toBe(false)
  })

  test('命令行含 memside 判 true', () => {
    expect(isMemsideHolder('C:\\Users\\me\\AppData\\Local\\memside\\memside.exe', 1000, 2000)).toBe(true)
    expect(isMemsideHolder('/home/me/projects/memside/src/exe/launcher.ts', 1000, 2000)).toBe(true)
  })

  test('命令行不含 memside 判 false', () => {
    expect(isMemsideHolder('C:\\Program Files\\other-app\\server.exe', 1000, 2000)).toBe(false)
  })

  test('空 cmdline 判 false', () => {
    expect(isMemsideHolder('', 1000, 2000)).toBe(false)
  })
})

describe('shouldAutoOpen', () => {
  test('MEMSIDE_NO_OPEN 未设返回 true', () => {
    const prev = process.env.MEMSIDE_NO_OPEN
    delete process.env.MEMSIDE_NO_OPEN
    expect(shouldAutoOpen()).toBe(true)
    if (prev !== undefined) process.env.MEMSIDE_NO_OPEN = prev
  })

  test('MEMSIDE_NO_OPEN=1 返回 false', () => {
    const prev = process.env.MEMSIDE_NO_OPEN
    process.env.MEMSIDE_NO_OPEN = '1'
    expect(shouldAutoOpen()).toBe(false)
    if (prev !== undefined) process.env.MEMSIDE_NO_OPEN = prev
    else delete process.env.MEMSIDE_NO_OPEN
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/open-browser.test.ts`
Expected: FAIL — module `@/exe/open-browser` not found / exported names absent.

- [ ] **Step 3: Write minimal implementation**

Create `src/exe/open-browser.ts`:

```ts
/**
 * exe 双击自动开浏览器（2026-08-18-exe-autostart-browser spec）。
 * 平台原生 open 命令 spawn；best-effort 不抛，失败返回 false（不杀 daemon）。
 * ctx 形状与 src/launch/portCheck.ts 的 PortCheckCtx 一致，便于复用 + 纯函数测。
 */

export interface OpenBrowserCtx {
  platform: NodeJS.Platform
  spawn: (cmd: string[]) => Promise<{ stdout: string; exitCode: number | null }>
}

/**
 * 打开浏览器到 url。成功 true，失败/非零退出/spawn 抛错均 false（不抛）。
 * 失败时调用方仍印 URL 横幅让用户手抄。
 */
export async function openBrowser(url: string, ctx: OpenBrowserCtx): Promise<boolean> {
  const cmd = openCommand(url, ctx.platform)
  try {
    const r = await ctx.spawn(cmd)
    return r.exitCode === 0
  } catch {
    return false
  }
}

function openCommand(url: string, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') return ['cmd', '/c', 'start', '', url]
  if (platform === 'darwin') return ['open', url]
  return ['xdg-open', url] // linux / 其他 posix
}

/**
 * 判断端口占用者是不是 memside 自身（用于「直开现有 UI 不杀」分支）。
 * 自身 PID 排除；命令行含 memside 字样判是（exe 路径 / 仓库路径均命中）。
 * 误判风险：非 memside 命令行恰好含 memside 字样极罕见，且即便误判走「直开 UI」，
 * 最坏 daemon 因端口仍被占 EADDRINUSE 兜底退出，不静默坏。
 */
export function isMemsideHolder(cmdline: string, ownPid: number, holderPid: number): boolean {
  if (holderPid === ownPid) return false
  return /memside/i.test(cmdline)
}

/**
 * env 门禁：MEMSIDE_NO_OPEN=1 时不开浏览器（headless / RDP 逃生口）。
 */
export function shouldAutoOpen(): boolean {
  return process.env.MEMSIDE_NO_OPEN !== '1'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/open-browser.test.ts`
Expected: PASS — all cases green.

- [ ] **Step 5: Commit**

```bash
git add src/exe/open-browser.ts tests/open-browser.test.ts
git commit -m "feat(exe): open-browser 纯函数（平台 open + memside-holder 判定 + env 门禁）"
```

---

## Task 2: launcher 三分支重构 + 横幅 + 源码层断言

**Files:**
- Modify: `src/exe/launcher.ts`
- Create: `tests/exe-launcher.test.ts`

**Interfaces:**
- Consumes: `openBrowser`, `isMemsideHolder`, `shouldAutoOpen` from Task 1（签名见 Task 1 Produces）。
- Consumes: `findPortHolders`, `promptReclaim`, `reclaim` from `src/launch/portCheck.ts`（既有，不改）。
- Consumes: `startDaemon` from `src/daemon.ts`（既有，不改）。

- [ ] **Step 1: Write the failing test**

Create `tests/exe-launcher.test.ts`:

```ts
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// CLAUDE.md 运行时巨型组件兜底面：源码层文本断言锁定关键接线。
// launcher.ts 编译进 exe，难直接覆盖；断言源码含正确控制流 token。

const src = readFileSync(join(import.meta.dir, '..', 'src', 'exe', 'launcher.ts'), 'utf8')

describe('launcher.ts 源码层断言', () => {
  test('导入 openBrowser / isMemsideHolder / shouldAutoOpen', () => {
    expect(src).toContain('openBrowser')
    expect(src).toContain('isMemsideHolder')
    expect(src).toContain('shouldAutoOpen')
  })

  test('三分支控制流存在', () => {
    // 无占用分支：startDaemon
    expect(src).toContain('startDaemon')
    // 全 memside 分支：直开 UI 不杀
    expect(src).toContain('isMemsideHolder')
    // 非 memside 分支：现有 promptReclaim / reclaim
    expect(src).toContain('promptReclaim')
    expect(src).toContain('reclaim')
  })

  test('先就绪再开窗：openBrowser 不在 startDaemon 调用之前', () => {
    const startIdx = src.indexOf('startDaemon({')
    const openIdx = src.indexOf('openBrowser(')
    expect(startIdx).toBeGreaterThan(-1)
    expect(openIdx).toBeGreaterThan(-1)
    expect(openIdx).toBeGreaterThan(startIdx)
  })

  test('shouldAutoOpen 门禁读取', () => {
    expect(src).toContain('shouldAutoOpen()')
  })

  test('横幅打印含 Web UI 地址 + 端口 + 引导', () => {
    expect(src).toContain('127.0.0.1')
    expect(src).toMatch(/Ctrl\+C/)
    // 横幅不是单行日志（升级后应有多行 / 边框 token）
    expect(src).not.toMatch(/^console\.log\(`memside on http:\/\/127\.0\.0\.1:\$\{PORT\}`\)\s*$/m)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/exe-launcher.test.ts`
Expected: FAIL — launcher.ts 未导入 openBrowser/isMemsideHolder/shouldAutoOpen，横幅仍是单行。

- [ ] **Step 3: Write minimal implementation**

Rewrite `src/exe/launcher.ts` (保留顶部 import + port-check ctx 组装，重构 main 三分支 + 横幅):

```ts
#!/usr/bin/env bun
/**
 * Spec B 接缝 3：exe 编译入口（只供 `bun build --compile` 消费）。
 *
 * 双击 exe = 生产启动（等价 start-and-install）：port-check → 启动 daemon
 * （内嵌 web dist 内存静态 + 装 claude hooks）→ 装 opencode 插件（内嵌）。
 *
 * 三分支（2026-08-18-exe-autostart-browser）：
 *   - 无占用 → startDaemon → openBrowser → 横幅 → 常驻
 *   - 全 memside 占用 → 直开现有 UI，不杀不重启 → exit(0)
 *   - 含非 memside → promptReclaim → 杀后走「无占用」分支
 * MEMSIDE_NO_OPEN=1 逃生口：不开浏览器仅印横幅 URL（headless / RDP）。
 *
 * 与 scripts/start.ts 区别：用内嵌资产（loadEmbeddedAssets）而非磁盘 dist，
 * 不做 vite dist 存在性检查（exe 自带资产内嵌进单文件）。port-check 逻辑复用
 * @/launch/portCheck（与 scripts/start.ts 同一生产 ctx 组装）。
 *
 * 控制台常驻显示，Ctrl+C 退出。仅 exe 走自动开浏览器；CLI 入口不动。
 */
import { createInterface } from 'node:readline'
import { startDaemon } from '@/daemon'
import { installOpencodePlugin } from '@/install'
import { findPortHolders, promptReclaim, reclaim, type PortCheckCtx, type ReclaimCtx } from '@/launch/portCheck'
import { openBrowser, isMemsideHolder, shouldAutoOpen } from './open-browser'
import { loadEmbeddedAssets } from './assets'

const PORT = Number(process.env.MEMSIDE_PORT ?? 7777)

function printBanner(alreadyRunning: boolean): void {
  const url = `http://127.0.0.1:${PORT}`
  const willOpen = shouldAutoOpen()
  const statusLine = alreadyRunning
    ? 'memside 已在运行，已打开浏览器到现有实例'
    : willOpen
      ? '正在打开浏览器…'
      : `Web UI:  ${url} （未自动开浏览器，MEMSIDE_NO_OPEN=1）`
  console.log('╔════════════════════════════════════════════╗')
  console.log('║  memside 已启动                              ║')
  console.log(`║  Web UI:  ${url.padEnd(33)}║`)
  console.log(`║  ${statusLine.padEnd(42)}║`)
  console.log('║  保持本窗口打开；Ctrl+C 退出                 ║')
  console.log('╚════════════════════════════════════════════╝')
}

async function main(): Promise<void> {
  const ea = await loadEmbeddedAssets()

  const spawnReal: PortCheckCtx['spawn'] = async (cmd: string[]) => {
    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    return { stdout, exitCode: proc.exitCode }
  }
  function readLineStdin(): Promise<string> {
    return new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin })
      rl.question('', (ans) => { rl.close(); resolve(ans) })
    })
  }
  const ctx: PortCheckCtx & ReclaimCtx = {
    platform: process.platform,
    spawn: spawnReal,
    isTTY: process.stdin.isTTY ?? false,
    readline: readLineStdin,
  }

  const holders = await findPortHolders([PORT], ctx)
  const ownPid = process.pid
  const allMemside = holders.length > 0 && holders.every((h) => isMemsideHolder(h.cmdline, ownPid, h.pid))

  if (holders.length > 0 && allMemside) {
    // 全 memside 占用 → 直开现有 UI，不杀不重启
    if (shouldAutoOpen()) {
      await openBrowser(`http://127.0.0.1:${PORT}`, ctx)
    }
    printBanner(true)
    process.exit(0)
  }

  if (holders.length > 0) {
    // 含非 memside → 询问回收（现有行为）
    if (!(await promptReclaim(holders, ctx))) process.exit(1)
    await reclaim(holders, ctx)
  }

  // 无占用分支：启动 daemon + 装 opencode 插件
  await startDaemon({
    port: PORT,
    installClaudeHooks: true,
    serveStaticAssets: { indexHtml: ea.indexHtml, assets: ea.assets },
    opencodePluginSource: { files: { 'memside.js': ea.pluginJs, 'package.json': ea.pluginPkg } },
  })
  installOpencodePlugin({
    port: PORT,
    files: { 'memside.js': ea.pluginJs, 'package.json': ea.pluginPkg },
  })

  // 先就绪再开窗
  if (shouldAutoOpen()) {
    await openBrowser(`http://127.0.0.1:${PORT}`, ctx)
  }
  printBanner(false)
}

main().catch((e) => {
  console.error('memside failed:', e)
  process.exit(1)
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/exe-launcher.test.ts`
Expected: PASS — all source-level assertions green.

- [ ] **Step 5: Run typecheck + full suite**

Run: `bun run typecheck && bun test`
Expected: typecheck clean, all tests pass (baseline + new).

- [ ] **Step 6: Commit**

```bash
git add src/exe/launcher.ts tests/exe-launcher.test.ts
git commit -m "feat(exe): launcher 三分支（开浏览器 / 直开现有 / 询问回收）+ 引导横幅"
```

---

## Task 3: 安装器 finish 页「立即启动」+ nsi 文本断言

**Files:**
- Modify: `installer/installer.nsi`
- Create: `tests/installer-nsi.test.ts`

**Interfaces:**
- None（nsi 文本改动 + 断言，无跨 task 契约）。

- [ ] **Step 1: Write the failing test**

Create `tests/installer-nsi.test.ts`:

```ts
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// 安装器 finish 页引导：装完可勾选「立即启动 memside」启动 exe → 开浏览器。
const nsi = readFileSync(join(import.meta.dir, '..', 'installer', 'installer.nsi'), 'utf8')

describe('installer.nsi finish 页引导', () => {
  test('设 MUI_FINISHPAGE_RUN 指向 exe', () => {
    expect(nsi).toContain('MUI_FINISHPAGE_RUN')
    expect(nsi).toContain('$INSTDIR\\memside.exe')
  })

  test('finish 页文案中文化', () => {
    expect(nsi).toContain('MUI_FINISHPAGE_RUN_TEXT')
    expect(nsi).toMatch(/立即启动/)
  })

  test('MUI_PAGE_FINISH 仍存在', () => {
    expect(nsi).toContain('MUI_PAGE_FINISH')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/installer-nsi.test.ts`
Expected: FAIL — `MUI_FINISHPAGE_RUN` 不存在于 nsi。

- [ ] **Step 3: Write minimal implementation**

Modify `installer/installer.nsi` — 在 `!define APP_PUBLISHER` 块之后、`!insertmacro MUI_PAGE_WELCOME` 之前，加 finish 页 define：

```nsis
; ------ finish 页引导（2026-08-18-exe-autostart-browser）：装完勾选立即启动 exe → 开浏览器 ------
!define MUI_FINISHPAGE_RUN "$INSTDIR\memside.exe"
!define MUI_FINISHPAGE_RUN_TEXT "立即启动 memside"
```

具体位置：在现有第 15 行 `!define APP_PUBLISHER "memside"` 之后插入这两行（`!define MUI_FINISHPAGE_RUN*` 必须在 `MUI_PAGE_FINISH` 之前定义才生效，故插在 `; ------ MUI ------` 注释行之前的 define 区）。

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/installer-nsi.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add installer/installer.nsi tests/installer-nsi.test.ts
git commit -m "feat(installer): finish 页加「立即启动 memside」勾选"
```

---

## Task 4: 全量门禁 + final review 准备

**Files:**
- None（验证 + 收尾）。

- [ ] **Step 1: Run full gate**

Run: `bun run typecheck && bun test`
Expected: typecheck clean, all tests pass. 记录 pass/skip/fail 数。

- [ ] **Step 2: 确认无 .superpowers/sdd 残留**

```bash
ls .superpowers/sdd/ 2>/dev/null && echo "WARN: sdd 未清理" || echo "clean"
```
若存在文件，清理（CLAUDE.md 闸门）。

- [ ] **Step 3: push + 开 PR**

```bash
git push -u origin feat/exe-autostart-browser
gh pr create --base master --title "feat: exe 双击自动开浏览器 + 安装后引导" --body "..."
```

- [ ] **Step 4: final whole-branch review（subagent-driven-development 收尾）**

对整个分支跑 code-review，verdict 通过后 squash merge。

---

## Self-Review

**Spec coverage:**
- §3.1 openBrowser/isMemsideHolder → Task 1 ✓
- §3.2 isMemsideHolder → Task 1 ✓
- §3.3 launcher 三分支 → Task 2 ✓
- §3.4 MEMSIDE_NO_OPEN → Task 1 shouldAutoOpen + Task 2 接线 ✓
- §3.5 控制台横幅 → Task 2 printBanner ✓
- §3.6 安装器 finish 页 → Task 3 ✓
- §7 测试策略 → Task 1/2/3 各对应 + Task 4 门禁 ✓
- §8 上线后观测 → 人工真机（非自动化），不进 task

**Placeholder scan:** 无 TBD/TODO，每步有实际代码。

**Type consistency:** `OpenBrowserCtx` / `openBrowser` / `isMemsideHolder` / `shouldAutoOpen` 签名 Task 1 定义，Task 2 消费一致。`PortCheckCtx & ReclaimCtx` 既有，Task 2 复用。
