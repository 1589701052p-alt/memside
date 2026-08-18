# 运行环境设置重设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「运行环境」设置 UI 重构成 claude/codeagent 与 opencode/nga 双分组，每组带可见标签字段 + 实时路径预览 + 「保存并安装」/「卸载」；让 opencode 安装/卸载经 UI 真正生效（新增 `uninstallOpencodePlugin` + daemon 插件源 plumbing + server target 分流）。

**Architecture:** install.ts 新增 `uninstallOpencodePlugin`（installOpencodePlugin 的幂等对偶）；daemon 经新 `DaemonOpts.opencodePluginSource` 把插件源（srcDir/files）plumb 进 server 的两个新注入接缝 `installOpencodePluginFn`/`uninstallOpencodePluginFn`；server 把 install/uninstall 端点扩展 `target=claude|opencode` query 分流；web-api client 加可选 `target` 参数；App.tsx 的 `RuntimeSettings` 重构成双分组 + 抽两个纯函数 `resolveClaudePath`/`resolveOpencodePath` 供预览与测试。

**Tech Stack:** Bun + Hono + zod + React 19 + bun:test。测试用 bun test（禁 npm test）。

**Spec:** `docs/superpowers/specs/2026-08-17-runtime-settings-redesign-design.md`

## Global Constraints

- 测试一律 `bun test`，禁 npm test（运行时为 Bun，用 bun:sqlite / Bun API）。
- PowerShell 5.1 不支持 `&&`，全量校验链 `bun run typecheck && bun test` 必须在 Bash 工具执行，或用 `;` 串联。
- Windows 上 `~` 展开由 server 端点 `resolveHome()`（`process.env.HOME || process.env.USERPROFILE || homedir()`）做，纯函数预览原样展示 `~`。
- install/uninstall 永不抛（malformed json / 缺文件 → 降级），IO 错误上浮经端点 catch 成 `{ok:false,error}`。
- 测试用显式 tmp baseDir / 注入 fake，绝不碰真实 `~/.claude` 或 `~/.config/opencode`。
- 复用 App.tsx 既有 inline-style + `<section>` 约定，不引新样式框架。
- 不做「已安装」持久徽标（无法可靠自检），UI ✓ 仅反映最近一次操作结果。

---

## File Structure

- **`src/install.ts`**（修改）：新增 `uninstallOpencodePlugin`。既有 `installOpencodePlugin`/`installHooks`/`uninstallHooks` 不动。
- **`src/server.ts`**（修改）：`AppDeps` 加 `installOpencodePluginFn`/`uninstallOpencodePluginFn`；install/uninstall 端点加 `target` query 分流；opencodeDir `~` 展开。
- **`src/daemon.ts`**（修改）：`DaemonOpts` 加 `opencodePluginSource`；`startDaemon` 构造两个绑定函数注入 `createApp`。
- **`src/cli.ts`**（修改）：`start`/`start-and-install` 给 `startDaemon` 传 `opencodePluginSource:{ srcDir: pluginSrcDir }`。
- **`src/exe/launcher.ts`**（修改）：给 `startDaemon` 传 `opencodePluginSource:{ files: ... }`。
- **`src/web/api.ts`**（修改）：`installRuntimeHooks`/`uninstallRuntimeHooks` 加可选 `target` 参数 + 返回类型加 `pluginPath`/`dirRemoved`。
- **`src/web/App.tsx`**（修改）：`RuntimeSettings` 重构成双分组；新增纯函数 `resolveClaudePath`/`resolveOpencodePath`。
- **`tests/install-opencode.test.ts`**（修改）：加 `uninstallOpencodePlugin` 测试。
- **`tests/settings-runtime-api.test.ts`**（修改）：加 `target=opencode` install/uninstall 测试。
- **`tests/daemon-install-paths.test.ts`**（修改）：加 `opencodePluginSource` plumbing 测试。
- **`tests/web-runtime-resolve.test.ts`**（新建）：`resolveClaudePath`/`resolveOpencodePath` 纯函数测试 + App.tsx 源码层文本断言。

---

## Task 1: `uninstallOpencodePlugin` 函数

**Files:**
- Modify: `src/install.ts`（在 `installOpencodePlugin` 后追加）
- Test: `tests/install-opencode.test.ts`（扩展）

**Interfaces:**
- Consumes: 既有 `installOpencodePlugin`（`src/install.ts:252`）、`resolveHome()`（`src/install.ts:65`）、`MEMSIDE_TAG`。
- Produces: `export function uninstallOpencodePlugin(opts: { baseDir?: string }): { removed: number; pluginPath: string; dirRemoved: boolean }`，被 Task 2 的 server 注入接缝与 Task 3 的 daemon plumbing 调用。

- [ ] **Step 1: 写失败测试（先 install 再 uninstall）**

追加到 `tests/install-opencode.test.ts` 末尾：

```ts
test('uninstallOpencodePlugin: 先 install 再 uninstall → 目录消失 + plugin 条目移除', () => {
  const baseDir = join(tmpRoot, 'uninstall-1')
  installOpencodePlugin({ port: 7777, baseDir, pluginSrcDir })
  expect(existsSync(join(baseDir, 'memside-opencode', 'memside.js'))).toBe(true)
  const r = uninstallOpencodePlugin({ baseDir })
  expect(r.removed).toBeGreaterThanOrEqual(1)
  expect(r.dirRemoved).toBe(true)
  expect(existsSync(join(baseDir, 'memside-opencode'))).toBe(false)
  const cfg = JSON.parse(readFileSync(join(baseDir, 'opencode.json'), 'utf-8'))
  expect((cfg.plugin as string[]).filter((p) => p.includes('memside-opencode'))).toHaveLength(0)
  expect(r.pluginPath).toBe(join(baseDir, 'opencode.json'))
})

test('uninstallOpencodePlugin: 保留用户既有 plugin 条目', () => {
  const baseDir = join(tmpRoot, 'uninstall-2')
  mkdirSync(baseDir, { recursive: true })
  writeFileSync(join(baseDir, 'opencode.json'),
    JSON.stringify({ plugin: ['superpowers@git+https://github.com/foo/superpowers'] }))
  installOpencodePlugin({ port: 7777, baseDir, pluginSrcDir })
  uninstallOpencodePlugin({ baseDir })
  const cfg = JSON.parse(readFileSync(join(baseDir, 'opencode.json'), 'utf-8'))
  expect((cfg.plugin as string[]).some((p) => p.includes('superpowers'))).toBe(true)
})

test('uninstallOpencodePlugin: 目录与文件都不存在 → removed:0 dirRemoved:false 不抛', () => {
  const baseDir = join(tmpRoot, 'uninstall-3')
  const r = uninstallOpencodePlugin({ baseDir })
  expect(r.removed).toBe(0)
  expect(r.dirRemoved).toBe(false)
  expect(r.pluginPath).toBe(join(baseDir, 'opencode.json'))
})

test('uninstallOpencodePlugin: malformed opencode.json → removed:0 不抛，dir 若存在仍删', () => {
  const baseDir = join(tmpRoot, 'uninstall-4')
  mkdirSync(join(baseDir, 'memside-opencode'), { recursive: true })
  writeFileSync(join(baseDir, 'memside-opencode', 'memside.js'), 'x')
  writeFileSync(join(baseDir, 'opencode.json'), '{not json')
  const r = uninstallOpencodePlugin({ baseDir })
  expect(r.removed).toBe(0)
  expect(r.dirRemoved).toBe(true) // 目录存在就删，不依赖 json 解析
  expect(existsSync(join(baseDir, 'memside-opencode'))).toBe(false)
})

test('uninstallOpencodePlugin: 重复 uninstall（已无痕迹）→ removed:0 dirRemoved:false 幂等', () => {
  const baseDir = join(tmpRoot, 'uninstall-5')
  uninstallOpencodePlugin({ baseDir }) // 空目录首次
  const r = uninstallOpencodePlugin({ baseDir }) // 再来一次
  expect(r.removed).toBe(0)
  expect(r.dirRemoved).toBe(false)
})

test('uninstallOpencodePlugin: baseDir 缺省走 ~/.config/opencode', () => {
  // 用 fake HOME 避免碰真实目录
  const realHome = process.env.HOME
  ;(process.env as any).HOME = join(tmpRoot, 'fake-home-uninstall')
  delete process.env.USERPROFILE
  try {
    const r = uninstallOpencodePlugin({})
    expect(r.removed).toBe(0)
    expect(r.pluginPath).toBe(join((process.env as any).HOME, '.config', 'opencode', 'opencode.json'))
  } finally {
    ;(process.env as any).HOME = realHome
  }
})
```

顶部 import 加 `uninstallOpencodePlugin`：

```ts
import { installOpencodePlugin, uninstallOpencodePlugin } from '@/install'
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/install-opencode.test.ts`
Expected: FAIL — `uninstallOpencodePlugin is not exported`。

- [ ] **Step 3: 实现 `uninstallOpencodePlugin`**

在 `src/install.ts` 末尾追加（`installOpencodePlugin` 之后）：

```ts
/**
 * Remove the memside opencode plugin — the idempotent-merge dual of
 * `installOpencodePlugin`. Deletes the `memside-opencode/` directory and
 * filters any `memside-opencode` entries out of `opencode.json`'s `plugin`
 * array (preserving user-authored plugins).
 *
 * `baseDir` defaults to `~/.config/opencode`. `~` expansion is NOT done here
 * — callers (server endpoint) expand it before calling, mirroring
 * `uninstallHooks`'s contract that baseDir is an absolute path.
 *
 * Never throws on missing file or malformed JSON (treated as empty document).
 * IO errors from rmSync/writeFileSync surface per existing install contract.
 * Returns `{ removed, pluginPath, dirRemoved }`: `removed` = plugin-array
 * entries filtered; `dirRemoved` = whether the dest dir existed pre-delete.
 */
export function uninstallOpencodePlugin(opts: { baseDir?: string }): { removed: number; pluginPath: string; dirRemoved: boolean } {
  const ocdDir = opts.baseDir ?? join(resolveHome(), '.config', 'opencode')
  const destDir = join(ocdDir, 'memside-opencode')
  const dirExisted = existsSync(destDir)
  rmSync(destDir, { recursive: true, force: true })

  const settingsPath = join(ocdDir, 'opencode.json')
  let cfg: Record<string, unknown> = {}
  let parsed = false
  if (existsSync(settingsPath)) {
    try {
      const p = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      if (p && typeof p === 'object' && !Array.isArray(p)) { cfg = p as Record<string, unknown>; parsed = true }
    } catch { /* malformed -> empty doc */ }
  }
  if (!parsed) return { removed: 0, pluginPath: settingsPath, dirRemoved: dirExisted }

  const plugin = Array.isArray(cfg.plugin) ? (cfg.plugin as unknown[]) : []
  const before = plugin.length
  const filtered = plugin.filter((p) => !(typeof p === 'string' && p.includes('memside-opencode')))
  const removed = before - filtered.length
  if (removed > 0) {
    cfg.plugin = filtered
    writeFileSync(settingsPath, JSON.stringify(cfg, null, 2) + '\n')
  }
  return { removed, pluginPath: settingsPath, dirRemoved: dirExisted }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/install-opencode.test.ts`
Expected: PASS（含新增 6 个 + 既有不回归）。

- [ ] **Step 5: typecheck + commit**

Run: `bun run typecheck`
Expected: 无错误。

```bash
git add src/install.ts tests/install-opencode.test.ts
git commit -m "feat(install): add uninstallOpencodePlugin (idempotent dual of install)"
```

---

## Task 2: server 端点 target 分流 + opencode 注入接缝

**Files:**
- Modify: `src/server.ts`（`AppDeps` 加两个字段，端点加 `target` query，opencodeDir `~` 展开）
- Test: `tests/settings-runtime-api.test.ts`（扩展）

**Interfaces:**
- Consumes: Task 1 的 `uninstallOpencodePlugin`；既有 `installOpencodePlugin`（被 daemon 在 Task 3 注入）；既有 `loadRuntimePaths`/`resolveHome()`/zod。
- Produces: `POST /api/settings/runtime/install?target=claude|opencode` 与 `/uninstall?target=...`；`AppDeps.installOpencodePluginFn`/`AppDeps.uninstallOpencodePluginFn`。被 Task 3 daemon 注入真实实现、Task 5 web-api 调用、Task 6 UI 触发。

- [ ] **Step 1: 写失败测试**

在 `tests/settings-runtime-api.test.ts` 的 `makeApp` 签名扩展（加 opencode 注入接缝）：

```ts
function makeApp(overrides: {
  installHooksFn?: (opts: { port: number; baseDir?: string; settingsFilename?: string }) => void
  uninstallHooksFn?: (opts: { baseDir?: string; settingsFilename?: string }) => { removed: number; settingsPath: string }
  installOpencodePluginFn?: (opts: { baseDir?: string }) => void
  uninstallOpencodePluginFn?: (opts: { baseDir?: string }) => { removed: number; pluginPath: string; dirRemoved: boolean }
} = {}) {
  return createApp({
    db,
    adapter: new ClaudeCodeAdapter(db),
    opencodeAdapter: new OpencodeAdapter(db),
    enqueueDistillJob: async () => ({ jobId: 'j', nextRunAt: 0 }),
    broadcast: () => {},
    ...overrides,
  })
}
```

追加测试到文件末尾（`req`/`putJson`/`post` helper 已在文件内复用）：

```ts
test('POST install?target=opencode 调 installOpencodePluginFn 传已存 opencodeDir + port', async () => {
  let called: { baseDir?: string } | null = null
  const app = makeApp({ installOpencodePluginFn: (opts) => { called = opts } })
  await req(app, '/api/settings/runtime', putJson({ opencodeDir: '/home/u/.config/opencode' }))
  const { status, body } = await req(app, '/api/settings/runtime/install?target=opencode', post('/api/settings/runtime/install?target=opencode'))
  expect(status).toBe(200)
  expect(body.ok).toBe(true)
  expect(body.pluginPath).toBeTruthy()
  expect(called!.baseDir).toBe('/home/u/.config/opencode')
})

test('POST install?target=opencode 缺 installOpencodePluginFn → ok:false 含不可用提示', async () => {
  const app = makeApp() // 不注入 installOpencodePluginFn
  await req(app, '/api/settings/runtime', putJson({ opencodeDir: '/x/opencode' }))
  const { body } = await req(app, '/api/settings/runtime/install?target=opencode', post('/api/settings/runtime/install?target=opencode'))
  expect(body.ok).toBe(false)
  expect(body.error).toContain('不可用')
})

test('POST install?target=opencode 抛错 → ok:false error', async () => {
  const app = makeApp({ installOpencodePluginFn: () => { throw new Error('ro locked') } })
  await req(app, '/api/settings/runtime', putJson({ opencodeDir: '/x' }))
  const { body } = await req(app, '/api/settings/runtime/install?target=opencode', post('/api/settings/runtime/install?target=opencode'))
  expect(body.ok).toBe(false)
  expect(body.error).toContain('ro locked')
})

test('POST uninstall?target=opencode 调 uninstallOpencodePluginFn 返回 removed/dirRemoved', async () => {
  let called: { baseDir?: string } | null = null
  const app = makeApp({ uninstallOpencodePluginFn: (opts) => { called = opts; return { removed: 1, pluginPath: '/x/opencode.json', dirRemoved: true } } })
  await req(app, '/api/settings/runtime', putJson({ opencodeDir: '/x/opencode' }))
  const { status, body } = await req(app, '/api/settings/runtime/uninstall?target=opencode', post('/api/settings/runtime/uninstall?target=opencode'))
  expect(status).toBe(200)
  expect(body.ok).toBe(true)
  expect(body.removed).toBe(1)
  expect(body.dirRemoved).toBe(true)
  expect(body.pluginPath).toBe('/x/opencode.json')
  expect(called!.baseDir).toBe('/x/opencode')
})

test('POST uninstall?target=opencode 抛错 → ok:false error', async () => {
  const app = makeApp({ uninstallOpencodePluginFn: () => { throw new Error('perm') } })
  await req(app, '/api/settings/runtime', putJson({ opencodeDir: '/x' }))
  const { body } = await req(app, '/api/settings/runtime/uninstall?target=opencode', post('/api/settings/runtime/uninstall?target=opencode'))
  expect(body.ok).toBe(false)
  expect(body.error).toContain('perm')
})

test('install?target=opencode 展开 ~ in opencodeDir', async () => {
  let called: { baseDir?: string } | null = null
  const app = makeApp({ installOpencodePluginFn: (opts) => { called = opts } })
  await req(app, '/api/settings/runtime', putJson({ opencodeDir: '~/.config/opencode' }))
  await req(app, '/api/settings/runtime/install?target=opencode', post('/api/settings/runtime/install?target=opencode'))
  expect(called!.baseDir).not.toContain('~')
  expect(called!.baseDir!.endsWith('.config/opencode')).toBe(true)
})

test('install?target=claude（默认）与既有行为逐字节一致（回归锁）', async () => {
  let called: { port: number; baseDir?: string; settingsFilename?: string } | null = null
  const app = makeApp({ installHooksFn: (opts) => { called = opts } })
  await req(app, '/api/settings/runtime', putJson({ claudeDir: '/home/u/.cac', settingsFilename: 'setting.json' }))
  // 不带 target query
  const { body } = await req(app, '/api/settings/runtime/install', post('/api/settings/runtime/install'))
  expect(body.ok).toBe(true)
  expect(body.settingsPath).toBe(join('/home/u/.cac', 'setting.json'))
  expect(called!.baseDir).toBe('/home/u/.cac')
  expect(called!.settingsFilename).toBe('setting.json')
})

test('install?target=invalid → 400', async () => {
  const app = makeApp()
  const { status, body } = await req(app, '/api/settings/runtime/install?target=bogus', post('/api/settings/runtime/install?target=bogus'))
  expect(status).toBe(400)
  expect(body.error).toBeTruthy()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/settings-runtime-api.test.ts`
Expected: FAIL — `AppDeps` 无 `installOpencodePluginFn` 字段，端点不认 `target`。

- [ ] **Step 3: 实现 `AppDeps` 接缝**

`src/server.ts` 的 `AppDeps`，在既有 `uninstallHooksFn` 后追加：

```ts
  /** opencode plugin install/uninstall 注入点（spec runtime-settings-redesign §3.3）。
   *  install 依赖插件源（srcDir/files），由 daemon 启动时注入；缺省 = undefined
   *  → opencode install 端点返回 ok:false + 说明（exe/dev 之外罕见启动路径降级）。
   *  uninstall 不依赖源，daemon 无条件注入真实实现。测试注入 fake 不碰真实目录。 */
  installOpencodePluginFn?: (opts: { baseDir?: string }) => void
  uninstallOpencodePluginFn?: (opts: { baseDir?: string }) => { removed: number; pluginPath: string; dirRemoved: boolean }
```

- [ ] **Step 4: 实现 install/uninstall 端点 target 分流**

`src/server.ts`，在 `createApp` 内 `const port = deps.port ?? 7777`（约 :163）附近加绑定（既有 `doInstall`/`doUninstall` 旁）：

```ts
  const doInstallOpencode = deps.installOpencodePluginFn
  const doUninstallOpencode = deps.uninstallOpencodePluginFn
```

把既有 `app.post('/api/settings/runtime/install', ...)`（约 :1027）替换为带 target 分流的版本：

```ts
  app.post('/api/settings/runtime/install', (c) => {
    const target = (c.req.query('target') ?? 'claude') as 'claude' | 'opencode'
    if (target !== 'claude' && target !== 'opencode') {
      return c.json({ error: `invalid target: ${target}` }, 400)
    }
    const rp = loadRuntimePaths(deps.db)
    if (target === 'claude') {
      const baseDir = rp.claudeDir.startsWith('~') ? join(resolveHome(), rp.claudeDir.slice(1)) : rp.claudeDir
      try {
        doInstall({ port, baseDir, settingsFilename: rp.settingsFilename })
        return c.json({ ok: true, settingsPath: join(baseDir, rp.settingsFilename) })
      } catch (e) {
        return c.json({ ok: false, error: (e as Error).message })
      }
    }
    // target === 'opencode'
    if (!doInstallOpencode) {
      return c.json({ ok: false, error: 'opencode 插件源在本启动模式下不可用（仅 dev/exe 启动支持），请用命令行安装' })
    }
    const baseDir = rp.opencodeDir.startsWith('~') ? join(resolveHome(), rp.opencodeDir.slice(1)) : rp.opencodeDir
    try {
      doInstallOpencode({ baseDir })
      return c.json({ ok: true, pluginPath: join(baseDir, 'memside-opencode') })
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message })
    }
  })
```

把既有 `app.post('/api/settings/runtime/uninstall', ...)`（约 :1040）替换为：

```ts
  app.post('/api/settings/runtime/uninstall', (c) => {
    const target = (c.req.query('target') ?? 'claude') as 'claude' | 'opencode'
    if (target !== 'claude' && target !== 'opencode') {
      return c.json({ error: `invalid target: ${target}` }, 400)
    }
    const rp = loadRuntimePaths(deps.db)
    if (target === 'claude') {
      const baseDir = rp.claudeDir.startsWith('~') ? join(resolveHome(), rp.claudeDir.slice(1)) : rp.claudeDir
      try {
        const r = doUninstall({ baseDir, settingsFilename: rp.settingsFilename })
        return c.json({ ok: true, removed: r.removed, settingsPath: r.settingsPath })
      } catch (e) {
        return c.json({ ok: false, error: (e as Error).message })
      }
    }
    // target === 'opencode'
    if (!doUninstallOpencode) {
      return c.json({ ok: false, error: 'opencode 卸载在本启动模式下不可用' })
    }
    const baseDir = rp.opencodeDir.startsWith('~') ? join(resolveHome(), rp.opencodeDir.slice(1)) : rp.opencodeDir
    try {
      const r = doUninstallOpencode({ baseDir })
      return c.json({ ok: true, removed: r.removed, pluginPath: r.pluginPath, dirRemoved: r.dirRemoved })
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message })
    }
  })
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun test tests/settings-runtime-api.test.ts`
Expected: PASS（新增 8 个 + 既有不回归）。

- [ ] **Step 6: typecheck + commit**

Run: `bun run typecheck`
Expected: 无错误。

```bash
git add src/server.ts tests/settings-runtime-api.test.ts
git commit -m "feat(server): runtime install/uninstall target=claude|opencode + opencode inject seam"
```

---

## Task 3: daemon 插件源 plumbing

**Files:**
- Modify: `src/daemon.ts`（`DaemonOpts` + `startDaemon` 注入）
- Test: `tests/daemon-install-paths.test.ts`（扩展）

**Interfaces:**
- Consumes: Task 1 `uninstallOpencodePlugin`；既有 `installOpencodePlugin`；Task 2 `AppDeps.installOpencodePluginFn`/`uninstallOpencodePluginFn`。
- Produces: `DaemonOpts.opencodePluginSource?: { srcDir: string } | { files: { 'memside.js': string; 'package.json': string } }`；`startDaemon` 经 `createApp` 注入两个接缝。被 Task 4（cli）与 Task 实现组（launcher）传入 source。

- [ ] **Step 1: 写失败测试**

追加到 `tests/daemon-install-paths.test.ts` 末尾。需 import `installOpencodePlugin`、`existsSync`、`readFileSync`（`existsSync`/`readFileSync` 已在文件顶部 import；补 `installOpencodePlugin` 和 `MEMSIDE_TAG` 之外无新需；`pluginSrcDir` 在 cli 用仓库 `opencode-plugin/`，测试同款）。

在文件顶部 import 区追加：

```ts
import { MEMSIDE_TAG, installOpencodePlugin } from '@/install'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginSrcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'opencode-plugin')
```

（`MEMSIDE_TAG` 已 import，改为合并行；`join` 已 import。最终顶部相关行为 `import { MEMSIDE_TAG, installOpencodePlugin } from '@/install'`。）

追加测试：

```ts
test('startDaemon with opencodePluginSource.srcDir → createApp 收到能装的 installOpencodePluginFn', async () => {
  const db = openDb(dbPath)
  saveRuntimePaths(db, { opencodeDir: join(fakeHome, 'opencode') })
  db.$client.close()

  const { server } = await startDaemon({
    dbPath, port: 17810,
    opencodePluginSource: { srcDir: pluginSrcDir },
  })
  try {
    // 直接打 install 端点（经 UI 按钮的同款路径）
    const res = await fetch(`http://127.0.0.1:17810/api/settings/runtime/install?target=opencode`, { method: 'POST' })
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.pluginPath).toContain('memside-opencode')
    expect(existsSync(join(fakeHome, 'opencode', 'memside-opencode', 'memside.js'))).toBe(true)
  } finally { server.stop() }
})

test('startDaemon with opencodePluginSource.files → install 用 files 模式', async () => {
  const db = openDb(dbPath)
  saveRuntimePaths(db, { opencodeDir: join(fakeHome, 'opencode2') })
  db.$client.close()

  const { server } = await startDaemon({
    dbPath, port: 17811,
    opencodePluginSource: { files: { 'memside.js': 'port=__MEMSIDE_PORT__;', 'package.json': '{"name":"memside"}' } },
  })
  try {
    const res = await fetch(`http://127.0.0.1:17811/api/settings/runtime/install?target=opencode`, { method: 'POST' })
    const body = await res.json()
    expect(body.ok).toBe(true)
    const js = readFileSync(join(fakeHome, 'opencode2', 'memside-opencode', 'memside.js'), 'utf-8')
    expect(js).toBe('port=17811;') // 端口烘焙
  } finally { server.stop() }
})

test('startDaemon without opencodePluginSource → install?target=opencode 返回 ok:false 不可用', async () => {
  const db = openDb(dbPath)
  saveRuntimePaths(db, { opencodeDir: join(fakeHome, 'opencode3') })
  db.$client.close()

  const { server } = await startDaemon({ dbPath, port: 17812 })
  try {
    const res = await fetch(`http://127.0.0.1:17812/api/settings/runtime/install?target=opencode`, { method: 'POST' })
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toContain('不可用')
  } finally { server.stop() }
})

test('startDaemon always provides uninstallOpencodePluginFn (even without source)', async () => {
  const db = openDb(dbPath)
  saveRuntimePaths(db, { opencodeDir: join(fakeHome, 'opencode4') })
  db.$client.close()

  const { server } = await startDaemon({ dbPath, port: 17813 }) // 不传 source
  try {
    const res = await fetch(`http://127.0.0.1:17813/api/settings/runtime/uninstall?target=opencode`, { method: 'POST' })
    const body = await res.json()
    expect(body.ok).toBe(true) // uninstall 不依赖 source，恒可用
    expect(body.removed).toBe(0)
  } finally { server.stop() }
})
```

注意：这些测试用真实 HTTP（daemon 起在 127.0.0.1 上），端口 178xx 须互不冲突（与既有 17801-17804 不撞，且彼此 17810-17813 不撞）。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/daemon-install-paths.test.ts`
Expected: FAIL — `DaemonOpts` 无 `opencodePluginSource`，fetch 到的 install 端点返回 ok:false（因 daemon 未注入 opencode 接缝）。

- [ ] **Step 3: 实现 `DaemonOpts.opencodePluginSource` + 注入**

`src/daemon.ts`，`DaemonOpts` 接口（约 :21）末尾追加：

```ts
  /** opencode 插件源（让 UI 的「保存并安装」能在请求时装/卸 opencode，spec runtime-settings-redesign §3.2）。
   *  - dev/npm：cli.ts 传 { srcDir: <repo>/opencode-plugin }
   *  - exe：launcher 传 { files: { memside.js, 'package.json' } }
   *  缺省 → daemon 不暴露 opencode install 能力（端点 ok:false + 说明）；uninstall 仍可用。 */
  opencodePluginSource?: { srcDir: string } | { files: { 'memside.js': string; 'package.json': string } }
```

`src/daemon.ts` 顶部 import 加 `installOpencodePlugin` 与 `uninstallOpencodePlugin`：

```ts
import { installHooks, installOpencodePlugin, uninstallOpencodePlugin } from './install'
```

（既有 import 行是 `import { installHooks } from './install'`，改为合并。）

在 `startDaemon`（约 :179）构造 `createApp` 的对象里，追加 opencode 两个注入接缝。把现有 `createApp({...})` 调用改造为在调用前先算出两个函数：

```ts
  // opencode 插件 install/uninstall 接缝（spec runtime-settings-redesign §3.2）。
  // install 依赖 source（srcDir/files）；uninstall 不依赖 source，恒注入真实实现。
  const installOpencodePluginFn = opts.opencodePluginSource
    ? (o: { baseDir?: string }) => {
        const src = opts.opencodePluginSource as { srcDir?: string; files?: { 'memside.js': string; 'package.json': string } }
        if (src.srcDir) installOpencodePlugin({ port, baseDir: o.baseDir, pluginSrcDir: src.srcDir })
        else if (src.files) installOpencodePlugin({ port, baseDir: o.baseDir, files: src.files })
      }
    : undefined
  const uninstallOpencodePluginFn = (o: { baseDir?: string }) => uninstallOpencodePlugin(o)
  const app = createApp({ db, adapter, opencodeAdapter, enqueueDistillJob, broadcast, staticDir: opts.serveStaticDir, staticAssets: opts.serveStaticAssets, tracker, callLLM: resolveCallLLM({}, db), port, installOpencodePluginFn, uninstallOpencodePluginFn })
```

（即：在原有 `createApp({...})` 入参里加 `installOpencodePluginFn, uninstallOpencodePluginFn` 两个键。）

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/daemon-install-paths.test.ts`
Expected: PASS（新增 4 个 + 既有 4 个不回归）。

- [ ] **Step 5: typecheck + commit**

Run: `bun run typecheck`
Expected: 无错误。

```bash
git add src/daemon.ts tests/daemon-install-paths.test.ts
git commit -m "feat(daemon): plumb opencodePluginSource into createApp inject seams"
```

---

## Task 4: CLI + launcher 传 opencodePluginSource

**Files:**
- Modify: `src/cli.ts`（`start`/`start-and-install` 传 source）
- Modify: `src/exe/launcher.ts`（传 files source）

**Interfaces:**
- Consumes: Task 3 `DaemonOpts.opencodePluginSource`；既有 `pluginSrcDir`（cli.ts:32）、`loadEmbeddedAssets`/`ea.pluginJs`/`ea.pluginPkg`（launcher）。
- Produces: dev（cli）与 exe（launcher）两种启动模式都让 UI opencode 按钮可用。

**注意**：`start` 原本 *不* 装 opencode（语义：只起 daemon）。本次只在 `startDaemon` 传 `opencodePluginSource`（*启用 UI 能力*），不改变「start 不在启动时自动装 opencode」的语义。`start-and-install` 仍启动时自动装（既有行 `installOpencodePlugin({ port, pluginSrcDir })` 不删），额外传 source 让 UI 也能装。

- [ ] **Step 1: 写失败测试**

`start` 与 `start-and-install` 是 CLI 顶层 `if/else`，难单测。改用源码层文本断言（CLAUDE.md 运行时组件最低面）。新建 `tests/cli-opencode-source.test.ts`：

```ts
// 锁 cli.ts 在 start / start-and-install 给 startDaemon 传 opencodePluginSource（spec §3.5）。
// CLI 顶层 if/else 难单测，用源码层文本断言兜底（CLAUDE.md 运行时组件最低面）。
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

const cliSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts'), 'utf-8')
const launcherSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'exe', 'launcher.ts'), 'utf-8')

test('cli.ts start + start-and-install 传 opencodePluginSource.srcDir', () => {
  expect(cliSrc).toContain('opencodePluginSource')
  expect(cliSrc).toContain('srcDir: pluginSrcDir')
})

test('launcher.ts 传 opencodePluginSource.files', () => {
  expect(launcherSrc).toContain('opencodePluginSource')
  expect(launcherSrc).toContain("files: { 'memside.js': ea.pluginJs, 'package.json': ea.pluginPkg }")
})
```

补 import：

```ts
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/cli-opencode-source.test.ts`
Expected: FAIL — 源码尚无 `opencodePluginSource`。

- [ ] **Step 3: 修改 `src/cli.ts`**

`src/cli.ts`，`start` 分支（约 :35）：

```ts
if (cmd === 'start') {
  await startDaemon({ port: PORT, installClaudeHooks: false, opencodePluginSource: { srcDir: pluginSrcDir } })
  console.log(`memside daemon on http://127.0.0.1:${PORT}`)
} else if (cmd === 'install') {
```

`start-and-install` 分支（约 :53）：

```ts
} else if (cmd === 'start-and-install') {
  await startDaemon({ port: PORT, installClaudeHooks: true, opencodePluginSource: { srcDir: pluginSrcDir } })
  installOpencodePlugin({ port: PORT, pluginSrcDir })
  console.log(`memside daemon on http://127.0.0.1:${PORT} (hooks installed; opencode plugin installed)`)
}
```

（`install` 分支不调 `startDaemon`，不变——它本就不起 daemon，UI 不在线。）

- [ ] **Step 4: 修改 `src/exe/launcher.ts`**

`src/exe/launcher.ts` 的 `startDaemon` 调用（约 :58）加 `opencodePluginSource`：

```ts
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
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun test tests/cli-opencode-source.test.ts`
Expected: PASS。

- [ ] **Step 6: typecheck + commit**

Run: `bun run typecheck`
Expected: 无错误。

```bash
git add src/cli.ts src/exe/launcher.ts tests/cli-opencode-source.test.ts
git commit -m "feat(cli,launcher): pass opencodePluginSource to startDaemon for UI install"
```

---

## Task 5: web-api client 加 target 参数

**Files:**
- Modify: `src/web/api.ts`（`installRuntimeHooks`/`uninstallRuntimeHooks` 加 `target`）

**Interfaces:**
- Consumes: Task 2 的 `?target=` query。
- Produces: `installRuntimeHooks(target?, fetchFn?)` 与 `uninstallRuntimeHooks(target?, fetchFn?)`，默认 `'claude'`，返回类型加 `pluginPath`/`dirRemoved`。被 Task 6 UI 调用。

- [ ] **Step 1: 写失败测试（源码层文本断言）**

新建 `tests/web-api-runtime-target.test.ts`：

```ts
// 锁 installRuntimeHooks/uninstallRuntimeHooks 携 target query + 扩展返回类型（spec §3.5）。
// wrapper 是薄 fetch 封装，用源码层文本断言（与既有 web-api 测试同模式）。
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const apiSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web', 'api.ts'), 'utf-8')

test('installRuntimeHooks 默认 target=claude，带 target 选项', () => {
  expect(apiSrc).toMatch(/installRuntimeHooks\(\s*target[:\s]*'claude'\s*\|\s*'opencode'\s*=\s*'claude'/)
  expect(apiSrc).toContain('install?target=${target}')
  expect(apiSrc).toContain('pluginPath')
})

test('uninstallRuntimeHooks 默认 target=claude，返回含 dirRemoved', () => {
  expect(apiSrc).toMatch(/uninstallRuntimeHooks\(\s*target[:\s]*'claude'\s*\|\s*'opencode'\s*=\s*'claude'/)
  expect(apiSrc).toContain('uninstall?target=${target}')
  expect(apiSrc).toContain('dirRemoved')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/web-api-runtime-target.test.ts`
Expected: FAIL — api.ts 尚无 target 参数。

- [ ] **Step 3: 修改 `src/web/api.ts`**

替换 `installRuntimeHooks`（约 :540）：

```ts
/** POST /api/settings/runtime/install?target=claude|opencode — 读已存路径装 hooks/plugin。
 * 默认 claude 保后兼容。失败返回 {ok:false,error}。claude 成功带 settingsPath，opencode 带 pluginPath。 */
export async function installRuntimeHooks(
  target: 'claude' | 'opencode' = 'claude', fetchFn: FetchLike = fetch,
): Promise<{ ok: boolean; settingsPath?: string; pluginPath?: string; error?: string }> {
  const res = await fetchFn(`/api/settings/runtime/install?target=${target}`, { method: 'POST' })
  return (await res.json()) as { ok: boolean; settingsPath?: string; pluginPath?: string; error?: string }
}
```

替换 `uninstallRuntimeHooks`（约 :546）：

```ts
/** POST /api/settings/runtime/uninstall?target=claude|opencode — 移除 memside-managed 项（保留用户自写）。 */
export async function uninstallRuntimeHooks(
  target: 'claude' | 'opencode' = 'claude', fetchFn: FetchLike = fetch,
): Promise<{ ok: boolean; removed?: number; settingsPath?: string; pluginPath?: string; dirRemoved?: boolean; error?: string }> {
  const res = await fetchFn(`/api/settings/runtime/uninstall?target=${target}`, { method: 'POST' })
  return (await res.json()) as { ok: boolean; removed?: number; settingsPath?: string; pluginPath?: string; dirRemoved?: boolean; error?: string }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/web-api-runtime-target.test.ts`
Expected: PASS。

- [ ] **Step 5: typecheck + commit**

Run: `bun run typecheck`
Expected: 无错误。

```bash
git add src/web/api.ts tests/web-api-runtime-target.test.ts
git commit -m "feat(web-api): installRuntimeHooks/uninstallRuntimeHooks take target param"
```

---

## Task 6: App.tsx 双分组 UI + 纯函数

**Files:**
- Modify: `src/web/App.tsx`（重构 `RuntimeSettings` + 新增纯函数）
- Test: `tests/web-runtime-resolve.test.ts`（新建，纯函数 + 源码层文本断言）

**Interfaces:**
- Consumes: Task 5 的 `installRuntimeHooks`/`uninstallRuntimeHooks(target)`、`getRuntimeSettings`/`saveRuntimeSettings`、`RuntimeSettingsState`。
- Produces: 双分组 `RuntimeSettings` 组件 + `resolveClaudePath`/`resolveOpencodePath` 纯函数（被 UI 预览与测试用）。

- [ ] **Step 1: 写失败测试**

新建 `tests/web-runtime-resolve.test.ts`：

```ts
// 锁 RuntimeSettings 双分组 UI + resolveClaudePath/resolveOpencodePath 纯函数（spec §3.6/§7.5）。
// 纯函数层断言路径解析；UI 运行时组件用源码层文本断言兜底（CLAUDE.md）。
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const appSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web', 'App.tsx'), 'utf-8')

// 导出纯函数的方式：App.tsx 末尾 export function resolveClaudePath(...) / resolveOpencodePath(...)
const mod = await import(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web', 'App.tsx'))

test('resolveClaudePath: 空串回落 default，组合目录+文件名', () => {
  const d = { claudeDir: '/home/u/.claude', settingsFilename: 'settings.json', opencodeDir: '/home/u/.config/opencode' }
  expect(mod.resolveClaudePath('', '', d)).toBe('/home/u/.claude/settings.json')
  expect(mod.resolveClaudePath('/home/u/.cac', 'setting.json', d)).toBe('/home/u/.cac/setting.json')
  // 单边：只给目录，文件名回落 default
  expect(mod.resolveClaudePath('/x/.cac', '', d)).toBe('/x/.cac/settings.json')
})

test('resolveOpencodePath: 空串回落 default，拼 memside-opencode', () => {
  const d = { claudeDir: '/h/.claude', settingsFilename: 'settings.json', opencodeDir: '/h/.config/opencode' }
  expect(mod.resolveOpencodePath('', d)).toBe('/h/.config/opencode/memside-opencode')
  expect(mod.resolveOpencodePath('/x/opencode', d)).toBe('/x/opencode/memside-opencode')
})

test('RuntimeSettings 含双分组标题 + 每组两个按钮', () => {
  expect(appSrc).toContain('Claude Code / codeagent')
  expect(appSrc).toContain('opencode / nga')
  expect(appSrc).toContain('保存并安装')
  expect(appSrc).toContain('卸载')
  expect(appSrc).toContain('将写入')
})

test('RuntimeSettings 用 installRuntimeHooks(target) / uninstallRuntimeHooks(target)', () => {
  // 确认 UI 调用带 target，而非旧的无参调用
  expect(appSrc).toMatch(/installRuntimeHooks\(\s*['"](?:claude|opencode)['"]/)
  expect(appSrc).toMatch(/uninstallRuntimeHooks\(\s*['"](?:claude|opencode)['"]/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/web-runtime-resolve.test.ts`
Expected: FAIL — `resolveClaudePath`/`resolveOpencodePath` 未导出，UI 文本尚无「保存并安装」。

- [ ] **Step 3: 实现 `resolveClaudePath`/`resolveOpencodePath` 纯函数**

`src/web/App.tsx`，在文件末尾（`RuntimeSettings` 之后）追加：

```ts
/** 解析 claude/codeagent 目标配置文件路径，供 UI 预览 + 测试。空串回落 default。 */
export function resolveClaudePath(
  claudeDir: string, settingsFilename: string,
  defaults: { claudeDir: string; settingsFilename: string; opencodeDir: string },
): string {
  const dir = claudeDir.trim() || defaults.claudeDir
  const fn = settingsFilename.trim() || defaults.settingsFilename
  return `${dir}/${fn}`.replace(/\\/g, '/')
}

/** 解析 opencode/nga 目标插件目录路径，供 UI 预览 + 测试。空串回落 default。 */
export function resolveOpencodePath(
  opencodeDir: string,
  defaults: { claudeDir: string; settingsFilename: string; opencodeDir: string },
): string {
  const dir = opencodeDir.trim() || defaults.opencodeDir
  return `${dir}/memside-opencode`.replace(/\\/g, '/')
}
```

- [ ] **Step 4: 重构 `RuntimeSettings` 成双分组**

`src/web/App.tsx`，整段替换 `function RuntimeSettings()`（约 :2098-2172）为：

```tsx
/**
 * 运行环境设置（spec runtime-settings-redesign §3.6）。
 * 双分组：claude/codeagent（claude-code fork）+ opencode/nga（opencode fork）。
 * 每组：可见标签字段 + 实时「→ 将写入」预览 + 「保存并安装」（先存再装，消除改了没存的脚枪）+「卸载」。
 * fetch/操作失败显错误不静默（CLAUDE.md 状态可见性）。不做持久「已装」徽标（无法可靠自检）。
 */
function RuntimeSettings() {
  const [state, setState] = useState<RuntimeSettingsState | null>(null)
  const [claudeDir, setClaudeDir] = useState('')
  const [settingsFilename, setSettingsFilename] = useState('')
  const [opencodeDir, setOpencodeDir] = useState('')
  const [claudeMsg, setClaudeMsg] = useState<string | null>(null)
  const [opencodeMsg, setOpencodeMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [claudeBusy, setClaudeBusy] = useState(false)
  const [opencodeBusy, setOpencodeBusy] = useState(false)

  const refresh = async () => {
    try {
      const s = await getRuntimeSettings()
      setState(s)
      setClaudeDir(s.claudeDir); setSettingsFilename(s.settingsFilename); setOpencodeDir(s.opencodeDir)
      setError(null)
    } catch (e) { setError(String(e)) }
  }
  useEffect(() => { void refresh() }, [])

  const defaults = state?.defaults ?? { claudeDir: '~/.claude', settingsFilename: 'settings.json', opencodeDir: '~/.config/opencode' }
  const claudePreview = resolveClaudePath(claudeDir, settingsFilename, defaults)
  const opencodePreview = resolveOpencodePath(opencodeDir, defaults)

  const onClaudeInstall = async () => {
    setClaudeBusy(true); setClaudeMsg(null)
    try {
      await saveRuntimeSettings({ claudeDir, settingsFilename })
      const r = await installRuntimeHooks('claude')
      setClaudeMsg(r.ok ? `✓ 已安装到 ${r.settingsPath ?? claudePreview}` : `安装失败: ${r.error ?? '未知错误'}`)
    } catch (e) { setClaudeMsg(`操作失败: ${e}`) }
    finally { setClaudeBusy(false) }
  }
  const onClaudeUninstall = async () => {
    setClaudeBusy(true); setClaudeMsg(null)
    try {
      const r = await uninstallRuntimeHooks('claude')
      setClaudeMsg(r.ok ? `✓ 已移除 ${r.removed ?? 0} 个 hook 组` : `卸载失败: ${r.error ?? '未知错误'}`)
    } catch (e) { setClaudeMsg(`卸载失败: ${e}`) }
    finally { setClaudeBusy(false) }
  }
  const onOpencodeInstall = async () => {
    setOpencodeBusy(true); setOpencodeMsg(null)
    try {
      await saveRuntimeSettings({ opencodeDir })
      const r = await installRuntimeHooks('opencode')
      setOpencodeMsg(r.ok ? `✓ 已安装到 ${r.pluginPath ?? opencodePreview}` : `安装失败: ${r.error ?? '未知错误'}`)
    } catch (e) { setOpencodeMsg(`操作失败: ${e}`) }
    finally { setOpencodeBusy(false) }
  }
  const onOpencodeUninstall = async () => {
    setOpencodeBusy(true); setOpencodeMsg(null)
    try {
      const r = await uninstallRuntimeHooks('opencode')
      setOpencodeMsg(r.ok
        ? `✓ 已移除 ${r.removed ?? 0} 个 plugin 条目${r.dirRemoved ? ' + 插件目录' : ''}`
        : `卸载失败: ${r.error ?? '未知错误'}`)
    } catch (e) { setOpencodeMsg(`卸载失败: ${e}`) }
    finally { setOpencodeBusy(false) }
  }

  const msgStyle = (m: string | null) => m === null ? undefined : (m.includes('失败') ? { color: '#b00' } : { color: '#080' })

  return (
    <section style={{ margin: '12px 0', padding: 12, border: '1px solid #ddd', borderRadius: 8 }}>
      <h3 style={{ margin: '0 0 8px' }}>运行环境</h3>
      <p style={{ margin: '0 0 10px', fontSize: 13, color: '#666' }}>
        memside 往你所用 agent 的配置里写 hooks/plugin，才能抓取会话 + 注入记忆。官方 Claude Code / opencode 用默认路径、无需改动；公司内部 agent（如 codeagent 读 <code>~/.cac/setting.json</code>）才需改路径。
      </p>
      {error ? <div style={{ color: '#b00', marginBottom: 8 }}>设置加载失败: {error}</div> : null}

      <div style={{ margin: '12px 0', padding: 10, border: '1px solid #eee', borderRadius: 6 }}>
        <h4 style={{ margin: '0 0 8px', fontSize: 14 }}>Claude Code / codeagent <span style={{ fontSize: 12, color: '#888' }}>claude-code fork</span></h4>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
          <label style={{ flex: '2 1 260px', fontSize: 12, color: '#555' }}>配置目录
            <input style={{ width: '100%', marginTop: 2 }} placeholder={defaults.claudeDir} value={claudeDir} onChange={(e) => setClaudeDir(e.target.value)} />
          </label>
          <label style={{ flex: '1 1 180px', fontSize: 12, color: '#555' }}>文件名
            <input style={{ width: '100%', marginTop: 2 }} placeholder={defaults.settingsFilename} value={settingsFilename} onChange={(e) => setSettingsFilename(e.target.value)} />
          </label>
        </div>
        <div style={{ margin: '4px 0 8px', fontSize: 12, color: '#888' }}>→ 将写入：<code>{claudePreview}</code></div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button disabled={claudeBusy} onClick={() => void onClaudeInstall()}>保存并安装</button>
          <button disabled={claudeBusy} onClick={() => void onClaudeUninstall()}>卸载</button>
          {claudeBusy ? <span style={{ color: '#888' }}>处理中…</span> : null}
          {claudeMsg ? <span style={msgStyle(claudeMsg)}>{claudeMsg}</span> : null}
        </div>
      </div>

      <div style={{ margin: '12px 0', padding: 10, border: '1px solid #eee', borderRadius: 6 }}>
        <h4 style={{ margin: '0 0 8px', fontSize: 14 }}>opencode / nga <span style={{ fontSize: 12, color: '#888' }}>opencode fork</span></h4>
        <label style={{ display: 'block', fontSize: 12, color: '#555', marginBottom: 6 }}>配置目录
          <input style={{ width: '100%', marginTop: 2 }} placeholder={defaults.opencodeDir} value={opencodeDir} onChange={(e) => setOpencodeDir(e.target.value)} />
        </label>
        <div style={{ margin: '4px 0 8px', fontSize: 12, color: '#888' }}>→ 将写入：<code>{opencodePreview}</code></div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button disabled={opencodeBusy} onClick={() => void onOpencodeInstall()}>保存并安装</button>
          <button disabled={opencodeBusy} onClick={() => void onOpencodeUninstall()}>卸载</button>
          {opencodeBusy ? <span style={{ color: '#888' }}>处理中…</span> : null}
          {opencodeMsg ? <span style={msgStyle(opencodeMsg)}>{opencodeMsg}</span> : null}
        </div>
      </div>

      <div style={{ marginTop: 6, fontSize: 12, color: '#888' }}>
        提示：codeagent 用户通常填 claude 目录 <code>~/.cac</code> + 文件名 <code>setting.json</code>。安装仅写入上述路径，请确认是 agent 实际读取的配置文件。卸载只移除 memside 管理的项，不影响你自己写的 hooks/plugins。
      </div>
    </section>
  )
}
```

确认 `RuntimeSettingsState` 类型在 App.tsx 已 import（既有代码已用，无需新 import）；`saveRuntimeSettings`/`installRuntimeHooks`/`uninstallRuntimeHooks`/`getRuntimeSettings` 已 import。

- [ ] **Step 5: 跑测试确认通过**

Run: `bun test tests/web-runtime-resolve.test.ts`
Expected: PASS。

- [ ] **Step 6: 全量校验 + commit**

Run（Bash 工具，因 PowerShell 不支持 `&&`）：`bun run typecheck && bun test`
Expected: typecheck 无错；全部测试 PASS。

```bash
git add src/web/App.tsx tests/web-runtime-resolve.test.ts
git commit -m "feat(web): redesign RuntimeSettings into claude/opencode dual groups with live path preview"
```

---

## Task 7: 整分支 review + 清理 .superpowers/sdd + 全量回归

**Files:** 无代码改动；验证 + 收尾。

- [ ] **Step 1: 全量 typecheck + test**

Run（Bash）：`bun run typecheck && bun test`
Expected: 全绿。若有红，回对应 Task 修。

- [ ] **Step 2: 源码层复核**

Grep 确认无残留旧扁平 UI 文本：`bun run` 无需；用 Grep 工具搜 `RuntimeSettings` 确认组件已重构、无遗留 `安装 hooks`/`卸载 hooks` 旧按钮文案、无遗留 `三框平铺` 结构。

- [ ] **Step 3: 清理 `.superpowers/sdd/`**

按 CLAUDE.md「落档后清理 .superpowers/sdd」：spec、plan 已写入 `docs/superpowers/`，删 `.superpowers/sdd/` 下所有文件。

```bash
rm -rf .superpowers/sdd
```

- [ ] **Step 4: PR 开启 + 推远端**

```bash
git push -u origin HEAD
gh pr create --base master --title "feat: 运行环境设置重设计（双分组 UI + opencode 安装/卸载生效）" --body "..."
```

PR body 要点：双分组重构、opencode install/uninstall 真正生效、`uninstallOpencodePlugin` 新增、daemon 插件源 plumbing、消除「改了没存就装旧路径」脚枪。

- [ ] **Step 5: STATE.md 回填**

在 STATE.md 记录本变更已落地 + §8 观测项待验（UI 双模式渲染、codeagent/opencode 闭环）。

```bash
git add STATE.md
git commit -m "docs(state): record runtime-settings redesign landed"
git push
```

---

## Self-Review

**1. Spec coverage：**
- §3.1 `uninstallOpencodePlugin` → Task 1 ✓
- §3.2 daemon plumbing → Task 3 ✓
- §3.3 `AppDeps` 接缝 → Task 2 ✓
- §3.4 server target 分流 → Task 2 ✓
- §3.5 web-api client target → Task 5 ✓
- §3.6 双分组 UI + 纯函数 → Task 6 ✓
- §3.1 中 daemon 构造两个绑定函数 → Task 3 ✓（cli/launcher 传 source → Task 4）
- §7.1 install 纯函数测试 → Task 1 ✓
- §7.2 server 测试 → Task 2 ✓
- §7.3 daemon plumbing 测试 → Task 3 ✓
- §7.4 web-api 文本断言 → Task 5 ✓
- §7.5 App.tsx 纯函数 + 文本断言 → Task 6 ✓
- §6 失败模式（缺 source 降级、malformed、~ 展开）→ Task 1/2/3 测试覆盖 ✓

**2. Placeholder scan：** 无 TBD/TODO；每个步骤含实际代码或确切命令。✓

**3. Type consistency：** `uninstallOpencodePlugin` 返回 `{removed, pluginPath, dirRemoved}` 在 Task 1 定义，Task 2 `AppDeps.uninstallOpencodePluginFn` 签名一致、Task 3 daemon 注入一致；`installOpencodePluginFn?: (opts:{baseDir?:string})=>void` 在 Task 2 定义、Task 3 注入类型一致；`installRuntimeHooks(target,...)` Task 5 定义、Task 6 调用一致。端点路径 `?target=` Task 2/5 一致。✓

## Execution Handoff

Per 用户 `chain-spec-plan-execution` 偏好，直接进入 **Subagent-Driven** 执行（superpowers:subagent-driven-development），不再询问。
