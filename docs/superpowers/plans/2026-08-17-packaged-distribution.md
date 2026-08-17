# 成品发布（npm + Windows exe + NSIS 安装器 + GHA 发版）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 memside 从"clone 仓库才能用"变成 npm 包 + Windows 单文件 exe + NSIS 安装器一键安装，GitHub Actions 自动发版。

**Architecture:** 三分发路径（dev/npm/exe）共享同一 `startDaemon`/`createApp`/`install*` 代码。新增两个旁路接缝不改既有磁盘路径：`createApp` 加 `staticAssets`（内存静态资产，exe 用）+ `installOpencodePlugin` 加 `files`（内容模式，exe 用）。exe launcher 用 `bun build --compile` 内嵌 dist+plugin。NSIS per-user 安装器 + GitHub Actions tag 发版。

**Tech Stack:** Bun（运行时 + `bun build --compile` + 资产导入 `with {type}`）、Hono（既有）、NSIS（构建期安装器）、GitHub Actions（发版 CI）、npm（包分发）。

**Spec:** `docs/superpowers/specs/2026-08-17-packaged-distribution-design.md`（计划从 spec 论证；执行者两份都读）。

## Global Constraints

- **不引新运行时依赖**：NSIS 是构建期工具（CI 装），GitHub Actions 是外部 CI，Bun 资产导入是 Bun 内建。npm 发版用 `npm` CLI。
- **`bun:sqlite` 是 Bun 专有**：npm 包不声明 Node `engines`；README 标注"需 bun 运行时"。npm 路径推荐 `bunx memside`。
- **接缝旁路，不重写**：`staticAssets`/`files` 是新增可选字段，既有 `staticDir`/`pluginSrcDir` 磁盘分支行为不变。dev（`scripts/start.ts`）零改动。
- **launcher 只供 `bun build --compile` 消费**：用 `with {type}` 资产导入语法，dev 走 `scripts/start.ts`。launcher 不做 vite dist 存在性检查（用内嵌资产）。
- **测试门禁**：`bun run typecheck && bun test` 全绿才 push。纯函数/集成层写足测试；exe/NSIS/CI 本身进不了 `bun test`，CI build 步骤即其集成断言。
- **数据保留**：NSIS uninstaller 只删程序目录，不碰 `~/.memside`/`~/.claude`/`~/.config/opencode`。
- **不自启**：安装器不写开机自启注册项（用户已选手动启动）。
- **per-user 安装**：NSIS `RequestExecutionLevel user`，装到 `%LOCALAPPDATA%\memside`，免 UAC。
- **端口固定 7777**：`MEMSIDE_PORT` env 可覆盖，默认 7777（与既有约定一致）。

---

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `src/server.ts` | `CreateAppDeps` 加 `staticAssets?` + 内存静态分支 + `mimeFor` | 改 |
| `src/daemon.ts` | `DaemonOpts` 加 `serveStaticAssets?` 透传 `createApp` | 改 |
| `src/install.ts` | `InstallOpencodePluginOpts` 加 `files?` 内容模式 | 改 |
| `src/exe/assets.ts` | `loadEmbeddedAssets()`：directory import dist → `{indexHtml, assets}` 纯函数 | 新 |
| `src/exe/launcher.ts` | exe 编译入口：port-check + 启动 + install（用内嵌资产） | 新 |
| `package.json` | `private:false` + `files` allowlist + `prepublishOnly` + `build:exe`/`build:installer` | 改 |
| `installer/installer.nsi` | NSIS per-user 安装器脚本 | 新 |
| `.github/workflows/release.yml` | tag 发版 CI | 新 |
| `tests/daemon-static-assets.test.ts` | 内存静态分支测试 | 新 |
| `tests/install-opencode.test.ts` | 加 `files` 内容模式 case | 改 |
| `tests/package-files.test.ts` | `files` allowlist 断言 | 新 |
| `tests/launcher-source-assertions.test.ts` | launcher 源码层文本断言兜底 | 新 |
| `src/exe/.gitkeep` | 保 `src/exe/` 目录存在于早期 task | 新（临时，task 4 后可删） |

---

## Task 1: `createApp` 内存静态资产接缝

**Files:**
- Modify: `src/server.ts`（`CreateAppDeps` 接口 ~line 33-45 + 静态托管块 ~line 1002-1008）
- Test: `tests/daemon-static-assets.test.ts`（新）

**Interfaces:**
- Consumes: `createApp` 既有 `staticDir?` 磁盘分支（`server.ts:1005-1008`），`serveStatic` from `hono/bun`。
- Produces: `CreateAppDeps.staticAssets?: { indexHtml: string; assets: Record<string, Uint8Array> }`；内存静态分支；`mimeFor(path: string): string` 内联函数。`staticAssets` 优先于 `staticDir`（互斥，文档注释写明）。

- [ ] **Step 1: 写失败测试 `tests/daemon-static-assets.test.ts`**

```ts
import { test, expect } from 'bun:test'
import { createApp } from '@/server'
import { openDb } from '@/db/client'
import { ClaudeCodeAdapter } from '@/adapter/claudeCode'
import { OpencodeAdapter } from '@/adapter/opencode'
import { enqueueDistillJob } from '@/scheduler'
import { resolveCallLLM } from '@/llm'
import { createActivityTracker } from '@/activity'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

// 锁 Spec B 接缝 1：createApp 接 staticAssets（内存静态资产，exe 用）时，
// GET / 返回 indexHtml、/assets/* 从内存 assets map 返回，不读盘。
// dev/npm 路径继续用 staticDir 磁盘分支（既有测试覆盖）。
const enc = (s: string) => new TextEncoder().encode(s)

test('staticAssets: GET / 返回 indexHtml', async () => {
  const dir = join(import.meta.dir, '.tmp-static-assets-1')
  rmSync(dir, { recursive: true, force: true })
  const db = openDb(join(dir, 't.db'))
  const app = createApp({
    db, adapter: new ClaudeCodeAdapter(db), opencodeAdapter: new OpencodeAdapter(db),
    enqueueDistillJob, broadcast: () => {}, tracker: createActivityTracker(),
    callLLM: resolveCallLLM({}, db),
    staticAssets: { indexHtml: '<h1>hi</h1>', assets: {} },
  })
  const res = await app.fetch(new Request('http://x/'))
  expect(res.status).toBe(200)
  expect(await res.text()).toBe('<h1>hi</h1>')
  expect(res.headers.get('content-type')).toContain('text/html')
})

test('staticAssets: GET /assets/x.js 返回内容 + 正确 MIME', async () => {
  const dir = join(import.meta.dir, '.tmp-static-assets-2')
  rmSync(dir, { recursive: true, force: true })
  const db = openDb(join(dir, 't.db'))
  const app = createApp({
    db, adapter: new ClaudeCodeAdapter(db), opencodeAdapter: new OpencodeAdapter(db),
    enqueueDistillJob, broadcast: () => {}, tracker: createActivityTracker(),
    callLLM: resolveCallLLM({}, db),
    staticAssets: { indexHtml: '<h1>hi</h1>', assets: { 'assets/x.js': enc('alert(1)') } },
  })
  const res = await app.fetch(new Request('http://x/assets/x.js'))
  expect(res.status).toBe(200)
  expect(await res.text()).toBe('alert(1)')
  expect(res.headers.get('content-type')).toContain('text/javascript')
})

test('staticAssets: 缺失资产 404', async () => {
  const dir = join(import.meta.dir, '.tmp-static-assets-3')
  rmSync(dir, { recursive: true, force: true })
  const db = openDb(join(dir, 't.db'))
  const app = createApp({
    db, adapter: new ClaudeCodeAdapter(db), opencodeAdapter: new OpencodeAdapter(db),
    enqueueDistillJob, broadcast: () => {}, tracker: createActivityTracker(),
    callLLM: resolveCallLLM({}, db),
    staticAssets: { indexHtml: '<h1>hi</h1>', assets: {} },
  })
  const res = await app.fetch(new Request('http://x/assets/missing.js'))
  expect(res.status).toBe(404)
})
```

> 注：`createApp` 真实 deps 形状以 `server.ts` 既有签名 + 既有测试为准；若 adapter/tracker 初始化方式与上面不符，执行者照既有 `tests/server*.test.ts` 的真实组装方式对齐，测试意图不变。

- [ ] **Step 2: 跑测试验证失败**

Run: `bun test tests/daemon-static-assets.test.ts`
Expected: FAIL（`staticAssets` 字段不存在 / 类型报错）

- [ ] **Step 3: 实现 `mimeFor` + `staticAssets` 分支**

在 `src/server.ts`，`CreateAppDeps` 接口加字段（紧邻 `staticDir`）：

```ts
  /** 内存静态资产（exe 编译模式）：命中时 GET / 与 /assets/* 从内存返回，不读盘。
   * 与 staticDir 互斥；同时传时 staticAssets 优先。dev/npm 用 staticDir 走磁盘。 */
  staticAssets?: {
    indexHtml: string
    /** key 是相对 staticDir 的路径（如 'assets/index-abc.js'）。 */
    assets: Record<string, Uint8Array>
  }
```

在静态托管块（`if (deps.staticDir)` 之前）加内存分支：

```ts
  // --- Static hosting (one-click launch, production mode) ------------------
  if (deps.staticAssets) {
    const a = deps.staticAssets
    app.get('/', (c) => c.html(a.indexHtml))
    app.get('/assets/*', (c) => {
      const rel = c.req.path.replace(/^\//, '')          // 'assets/x.js'
      const body = a.assets[rel]
      if (!body) return c.notFound()
      return new Response(body, { headers: { 'content-type': mimeFor(rel) } })
    })
  } else if (deps.staticDir) {
    app.get('/', serveStatic({ path: join(deps.staticDir, 'index.html') }))
    app.use('/assets/*', serveStatic({ root: deps.staticDir }))
  }
```

在 `createApp` 上方（模块作用域）加 `mimeFor`：

```ts
/** 扩展名→MIME 映射（内存静态资产用）。不引 mime 依赖，覆盖 vite dist 产物类型。 */
function mimeFor(path: string): string {
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (path.endsWith('.css')) return 'text/css; charset=utf-8'
  if (path.endsWith('.html')) return 'text/html; charset=utf-8'
  if (path.endsWith('.svg')) return 'image/svg+xml'
  if (path.endsWith('.json')) return 'application/json; charset=utf-8'
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.ico')) return 'image/x-icon'
  return 'application/octet-stream'
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `bun test tests/daemon-static-assets.test.ts`
Expected: PASS（3 case）

- [ ] **Step 5: typecheck + 全量测试**

Run: `bun run typecheck && bun test`
Expected: typecheck clean，全量绿（既有不回归）

- [ ] **Step 6: Commit**

```bash
git add src/server.ts tests/daemon-static-assets.test.ts
git commit -m "feat(server): createApp 接 staticAssets 内存静态资产接缝（Spec B 接缝 1）"
```

---

## Task 2: `startDaemon` 透传 `serveStaticAssets`

**Files:**
- Modify: `src/daemon.ts`（`DaemonOpts` ~line 21-28 + `createApp` 调用 ~line 176）
- Test: 无新测试（透传，由 Task 1 的 `createApp` 测试 + Task 4 launcher 集成覆盖；加一条源码层断言兜底）

**Interfaces:**
- Consumes: Task 1 的 `CreateAppDeps.staticAssets`。
- Produces: `DaemonOpts.serveStaticAssets?: { indexHtml: string; assets: Record<string, Uint8Array> }`，透传到 `createApp({..., staticAssets: opts.serveStaticAssets})`。

- [ ] **Step 1: 改 `DaemonOpts` + `createApp` 调用**

`src/daemon.ts` `DaemonOpts` 加字段（紧邻 `serveStaticDir`）：

```ts
  /** 内存静态资产（exe 模式）：透传 createApp.staticAssets，与 serveStaticDir 互斥。
   * dev/npm 用 serveStaticDir 走磁盘。 */
  serveStaticAssets?: { indexHtml: string; assets: Record<string, Uint8Array> }
```

`createApp` 调用（line 176）加 `staticAssets: opts.serveStaticAssets`：

```ts
  const app = createApp({ db, adapter, opencodeAdapter, enqueueDistillJob, broadcast, staticDir: opts.serveStaticDir, staticAssets: opts.serveStaticAssets, tracker, callLLM: resolveCallLLM({}, db) })
```

- [ ] **Step 2: 写源码层断言兜底测试 `tests/daemon-static-assets.test.ts`（追加）**

```ts
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Task 2 源码层断言兜底：startDaemon 透传 serveStaticAssets 到 createApp。
// 无法直接对 startDaemon 做内存资产集成测（要起真端口+DB），靠源码层文本锁接线。
test('daemon.ts 透传 serveStaticAssets 到 createApp', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'daemon.ts'), 'utf-8')
  expect(src).toContain('serveStaticAssets')
  expect(src).toMatch(/createApp\(\{[^}]*staticAssets:\s*opts\.serveStaticAssets/s)
})
```

- [ ] **Step 3: typecheck + 测试**

Run: `bun run typecheck && bun test tests/daemon-static-assets.test.ts`
Expected: typecheck clean，PASS

- [ ] **Step 4: Commit**

```bash
git add src/daemon.ts tests/daemon-static-assets.test.ts
git commit -m "feat(daemon): startDaemon 透传 serveStaticAssets（Spec B 接缝 1 续）"
```

---

## Task 3: `installOpencodePlugin` 内容模式（`files`）

**Files:**
- Modify: `src/install.ts`（`InstallOpencodePluginOpts` ~line 153-162 + 实现 ~line 183-215）
- Test: `tests/install-opencode.test.ts`（加 case）

**Interfaces:**
- Consumes: 既有 `installOpencodePlugin` 磁盘分支（`pluginSrcDir` + `cpSync`）。
- Produces: `InstallOpencodePluginOpts.files?: { 'memside.js': string; 'package.json': string }`；命中时从字符串写盘（跳过 `cpSync`），端口烘焙照旧。与 `pluginSrcDir` 互斥；都不传抛错。

- [ ] **Step 1: 写失败测试（加到 `tests/install-opencode.test.ts` 末尾）**

```ts
test('files 内容模式：从字符串写盘 + 端口烘焙', () => {
  const baseDir = join(tmpRoot, 'case-files')
  installOpencodePlugin({
    port: 9999, baseDir,
    files: { 'memside.js': 'port=__MEMSIDE_PORT__;', 'package.json': '{"name":"memside"}' },
  })
  const js = readFileSync(join(baseDir, 'memside-opencode', 'memside.js'), 'utf-8')
  expect(js).toBe('port=9999;')
  expect(js).not.toContain('__MEMSIDE_PORT__')
  const pkg = readFileSync(join(baseDir, 'memside-opencode', 'package.json'), 'utf-8')
  expect(pkg).toBe('{"name":"memside"}')
})

test('files 内容模式：opencode.json 幂等合并', () => {
  const baseDir = join(tmpRoot, 'case-files-idem')
  installOpencodePlugin({
    port: 9999, baseDir,
    files: { 'memside.js': 'x', 'package.json': '{}' },
  })
  installOpencodePlugin({
    port: 9999, baseDir,
    files: { 'memside.js': 'x', 'package.json': '{}' },
  })
  const cfg = JSON.parse(readFileSync(join(baseDir, 'opencode.json'), 'utf-8'))
  expect((cfg.plugin as string[]).filter((p) => p.includes('memside-opencode'))).toHaveLength(1)
})

test('files 与 pluginSrcDir 都缺抛错', () => {
  expect(() => installOpencodePlugin({ port: 9999, baseDir: join(tmpRoot, 'case-err') })).toThrow()
})
```

- [ ] **Step 2: 跑测试验证失败**

Run: `bun test tests/install-opencode.test.ts`
Expected: FAIL（`files` 字段不存在）

- [ ] **Step 3: 实现 `files` 分支**

`src/install.ts` `InstallOpencodePluginOpts` 加字段：

```ts
export interface InstallOpencodePluginOpts {
  port: number
  baseDir?: string
  /** 磁盘源目录模式（dev/npm：从仓库 opencode-plugin/ 读盘复制）。 */
  pluginSrcDir?: string
  /** 内容模式（exe：从内嵌资产字符串写盘）。与 pluginSrcDir 互斥。 */
  files?: { 'memside.js': string; 'package.json': string }
}
```

实现 `installOpencodePlugin` 顶部加模式分流（替换原 `cpSync` 单行）：

```ts
export function installOpencodePlugin(opts: InstallOpencodePluginOpts): void {
  const ocdDir = opts.baseDir ?? join(resolveHome(), '.config', 'opencode')
  mkdirSync(ocdDir, { recursive: true })
  const destDir = join(ocdDir, 'memside-opencode')
  if (opts.files) {
    // 内容模式（exe）：从内嵌字符串写盘，不 cpSync
    writeFileSync(join(destDir, 'memside.js'), opts.files['memside.js'])
    writeFileSync(join(destDir, 'package.json'), opts.files['package.json'])
  } else if (opts.pluginSrcDir) {
    // 磁盘模式（dev/npm）：复制仓库 opencode-plugin/
    cpSync(opts.pluginSrcDir, destDir, { recursive: true })
  } else {
    throw new Error('installOpencodePlugin: must provide pluginSrcDir or files')
  }
  // 端口烘焙：读 memside.js 替换 __MEMSIDE_PORT__（两模式共用，照旧）
  const jsPath = join(destDir, 'memside.js')
  let js = readFileSync(jsPath, 'utf-8')
  js = js.replace(/__MEMSIDE_PORT__/g, String(opts.port))
  writeFileSync(jsPath, js)
  // 幂等合并 opencode.json（照旧，下面代码不动）
  ...
}
```

> `mkdirSync`/`writeFileSync` 已在 `install.ts` 顶部 import；`cpSync` 仍 import（磁盘分支用）。

- [ ] **Step 4: 跑测试验证通过**

Run: `bun test tests/install-opencode.test.ts`
Expected: PASS（既有 4 case + 新 3 case）

- [ ] **Step 5: typecheck + 全量测试**

Run: `bun run typecheck && bun test`
Expected: typecheck clean，全量绿

- [ ] **Step 6: Commit**

```bash
git add src/install.ts tests/install-opencode.test.ts
git commit -m "feat(install): installOpencodePlugin 加 files 内容模式（Spec B 接缝 2）"
```

---

## Task 4: exe 资产装配 `src/exe/assets.ts`

**Files:**
- Create: `src/exe/assets.ts`
- Test: `tests/launcher-source-assertions.test.ts`（新，Task 4+5 共用，先建占位）

**Interfaces:**
- Consumes: `src/web/dist/`（vite 构建产物，`index.html` + `assets/*`）。
- Produces: `loadEmbeddedAssets(): { indexHtml: string; assets: Record<string, Uint8Array> }`——用 Bun directory import 把 dist 内嵌，遍历成 map。launcher 与测试可调。

- [ ] **Step 1: 建目录占位 + 写 `src/exe/assets.ts`**

`src/exe/assets.ts`：

```ts
/**
 * Spec B 接缝 4：exe 资产装配。
 *
 * 把 src/web/dist/ 内嵌进单文件 exe（bun build --compile），暴露为
 * createApp.staticAssets 所需的 { indexHtml, assets } 形状。
 *
 * 用 Bun directory import（`with { type: 'directory' }`）在编译期把整个 dist
 * 目录打进 exe；运行时遍历目录条目读成 Uint8Array map。index.html 单独取。
 *
 * 只供 bun build --compile 消费（launcher.ts）。dev 走 scripts/start.ts 用磁盘 dist。
 * 资产导入语法（with {type}）是 Bun 专有——`bun run` 直接跑 assets.ts 不保证
 * 解析，故本模块只被编译产物消费，不被 dev 直接 import。
 */
// @ts-expect-error — Bun 资产导入语法，tsc 不识别 but Bun build 解析
import distDir from '../web/dist' with { type: 'directory' }

export interface EmbeddedAssets {
  indexHtml: string
  assets: Record<string, Uint8Array>
}

/**
 * 遍历内嵌 dist 目录，返回 createApp.staticAssets 所需形状。
 * 纯函数（相对 Bun 运行时）：相同 dist 产出相同 map；不读外部磁盘。
 */
export async function loadEmbeddedAssets(): Promise<EmbeddedAssets> {
  const indexHtml = await Bun.file(new URL('./index.html', distDir)).text()
  const assets: Record<string, Uint8Array> = {}
  for await (const entry of new Response(distDir).body ? [] : []) { /* placeholder */ }
  // 上面 directory 遍历 API 视 Bun 版本而定；实际用 readdir 枚举 assets/ 子文件
  const { readdir } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const assetsDir = new URL('./assets/', distDir)
  try {
    const files = await readdir(assetsDir)
    for (const f of files) {
      const key = `assets/${f}`
      assets[key] = await Bun.file(new URL(`./assets/${f}`, distDir)).bytes()
    }
  } catch {
    // dist 无 assets/ 子目录（空构建）→ 空 map，不崩
  }
  return { indexHtml, assets }
}
```

> **执行者注意**：上面 directory import + 遍历的具体 API 形态以目标 Bun 版本实测为准。核心契约是 `loadEmbeddedAssets()` 返回 `{indexHtml, assets}`，实现细节（`with {type:'directory'}` vs 构建期 manifest.ts 回退）由执行者在编译验证（Task 6/CI）时确认。若 directory import 在 `bun build --compile` 下不稳，回退到 spec 失败模式 #2 的构建期 `manifest.ts`：在 `build:exe` 前跑一个脚本枚举 dist 写 `src/exe/manifest.ts`（`export const FILES: [string, Uint8Array][] = [...]`），launcher import 它。回退优先级低。

- [ ] **Step 2: 写源码层断言兜底（建 `tests/launcher-source-assertions.test.ts`）**

```ts
import { test, expect } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const exeDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'exe')

test('src/exe/assets.ts 存在并暴露 loadEmbeddedAssets', () => {
  const p = join(exeDir, 'assets.ts')
  expect(existsSync(p)).toBe(true)
  const src = readFileSync(p, 'utf-8')
  expect(src).toContain('export async function loadEmbeddedAssets')
  expect(src).toContain('indexHtml')
  expect(src).toContain('assets')
})
```

- [ ] **Step 3: typecheck**

Run: `bun run typecheck`
Expected: 可能因 `with` 语法 tsc 报错——用 `@ts-expect-error` 抑制；若仍报，执行者确认 `@ts-expect-error` 覆盖该行（tsc 对未使用的 `@ts-expect-error` 也报错，需权衡；若 assets.ts 在纯 typecheck 下无法绿，标注为 Task 6 编译验证兜底，本 task 不强求 typecheck 绿——但全量 `bun test` 必须绿，故 `@ts-expect-error` 要精确）。

> **裁决**：assets.ts 的 `with` 资产导入行用 `// @ts-expect-error` 抑制 tsc。若 tsc 因"未使用的 @ts-expect-error"反报错，改用 `// @ts-ignore`（更宽松，不验证抑制是否命中）。优先 `@ts-expect-error`，实测不行降级 `@ts-ignore`。本 task 结束时 typecheck 必须绿（`@ts-ignore` 兜底）。

- [ ] **Step 4: Commit**

```bash
git add src/exe/assets.ts tests/launcher-source-assertions.test.ts
git commit -m "feat(exe): 资产装配 loadEmbeddedAssets（Spec B 接缝 4）"
```

---

## Task 5: exe launcher 入口 `src/exe/launcher.ts`

**Files:**
- Create: `src/exe/launcher.ts`
- Test: `tests/launcher-source-assertions.test.ts`（追加）

**Interfaces:**
- Consumes: Task 2 `startDaemon({serveStaticAssets, installClaudeHooks})`、Task 3 `installOpencodePlugin({files})`、Task 4 `loadEmbeddedAssets()`、`@/launch/portCheck`（`findPortHolders`/`promptReclaim`/`reclaim` + `PortCheckCtx`/`ReclaimCtx`）。
- Produces: exe 编译入口（`bun build --compile src/exe/launcher.ts`），双击即启动。

- [ ] **Step 1: 写 `src/exe/launcher.ts`**

```ts
#!/usr/bin/env bun
/**
 * Spec B 接缝 3：exe 编译入口（只供 `bun build --compile` 消费）。
 *
 * 双击 exe = 生产启动（等价 start-and-install）：port-check → 启动 daemon
 * （内嵌 web dist 内存静态 + 装 claude hooks）→ 装 opencode 插件（内嵌）。
 *
 * 与 scripts/start.ts 区别：用内嵌资产（loadEmbeddedAssets）而非磁盘 dist，
 * 不做 vite dist 存在性检查（exe 自带）。port-check 逻辑复用 @/launch/portCheck。
 *
 * 不打印 usage（无参即启动；未知参数忽略，exe 场景无 CLI 交互）。
 * 控制台常驻显示，Ctrl+C 退出。
 */
import { startDaemon } from '@/daemon'
import { installHooks, installOpencodePlugin } from '@/install'
import { findPortHolders, promptReclaim, reclaim, type PortCheckCtx, type ReclaimCtx } from '@/launch/portCheck'
import { loadEmbeddedAssets } from './assets'
import { createInterface } from 'node:readline'

const PORT = Number(process.env.MEMSIDE_PORT ?? 7777)

async function main() {
  const { indexHtml, assets } = await loadEmbeddedAssets()

  // port-check 生产 ctx（同 scripts/start.ts）
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
  if (holders.length) {
    if (!(await promptReclaim(holders, ctx))) process.exit(1)
    await reclaim(holders, ctx)
  }

  await startDaemon({ port: PORT, installClaudeHooks: true, serveStaticAssets: { indexHtml, assets } })
  // opencode 插件内嵌资产（与 dist 同期编译内嵌）
  // @ts-expect-error — Bun 资产导入，tsc 不识别，bun build 解析
  const pluginJs = (await import('../../opencode-plugin/memside.js' /* @bundle */ )).default
    ?? (await Bun.file(new URL('../../opencode-plugin/memside.js', import.meta.url)).text())
  // @ts-expect-error — 同上
  const pluginPkg = (await import('../../opencode-plugin/package.json' /* @bundle */ )).default
  installOpencodePlugin({ port: PORT, files: { 'memside.js': pluginJs as string, 'package.json': JSON.stringify(pluginPkg) } })

  console.log(`memside on http://127.0.0.1:${PORT} (UI + API, hooks + opencode plugin installed)`)
  console.log('Ctrl+C to exit')
}

main().catch((e) => { console.error('memside failed:', e); process.exit(1) })
```

> **执行者注意**：opencode 插件资产内嵌方式（上面的 `import ... default` + Bun.file 兜底）以实测 Bun `bun build --compile` 行为为准。spec 失败模式 #2 的核心：插件 `memside.js`/`package.json` 必须内嵌进 exe。若 `import` JSON/JS 资产不稳，回退方案：`assets.ts` 的 `loadEmbeddedAssets` 一并加载插件文件（扩返回 `{indexHtml, assets, pluginJs, pluginPkg}`），launcher 从统一资产对象取。**优先用 Task 4 的 assets.ts 统一加载**——执行者应在 Task 4 就把插件资产并入 `loadEmbeddedAssets` 返回，launcher 不重复 import。本 task 代码片段给出一种实现，执行者按"统一资产对象"原则收敛。

- [ ] **Step 2: 追加源码层断言到 `tests/launcher-source-assertions.test.ts`**

```ts
test('src/exe/launcher.ts 存在并接线启动', () => {
  const p = join(exeDir, 'launcher.ts')
  expect(existsSync(p)).toBe(true)
  const src = readFileSync(p, 'utf-8')
  expect(src).toContain('startDaemon')
  expect(src).toContain('serveStaticAssets')
  expect(src).toContain('installOpencodePlugin')
  expect(src).toContain('files')
  expect(src).toContain('loadEmbeddedAssets')
  expect(src).toContain('findPortHolders')
})
```

- [ ] **Step 3: typecheck + 测试**

Run: `bun run typecheck && bun test tests/launcher-source-assertions.test.ts`
Expected: typecheck 绿（`@ts-expect-error` 抑制资产导入行），PASS

- [ ] **Step 4: Commit**

```bash
git add src/exe/launcher.ts tests/launcher-source-assertions.test.ts
git commit -m "feat(exe): launcher 编译入口（Spec B 接缝 3）"
```

---

## Task 6: `package.json` 改造（npm 包 + 构建脚本）

**Files:**
- Modify: `package.json`
- Test: `tests/package-files.test.ts`（新）

**Interfaces:**
- Consumes: 既有 `build` script（vite build 产 `src/web/dist/`）。
- Produces: `private:false` + `files` allowlist + `prepublishOnly` + `build:exe` + `build:installer` 脚本。

- [ ] **Step 1: 写失败测试 `tests/package-files.test.ts`**

```ts
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

// 锁 Spec B 接缝 5：package.json files allowlist 只发运行时所需，
// 不把 tests/docs/scripts/源码 web/.superpowers 入包；dist 随包发布。
test('package.json 非私有 + files allowlist 正确', () => {
  const pkg = JSON.parse(readFileSync(import.meta.dir + '/../package.json', 'utf-8'))
  expect(pkg.private).toBe(false)
  const files: string[] = pkg.files
  // 必含运行时所需
  expect(files).toContain('src')
  expect(files).toContain('opencode-plugin')
  expect(files).toContain('tsconfig.json')
  // 必不含（allowlist 模式，未列即不发）
  expect(files).not.toContain('tests')
  expect(files).not.toContain('docs')
  expect(files).not.toContain('scripts')
  expect(files).not.toContain('vite.config.ts')
})

test('package.json 含构建脚本', () => {
  const pkg = JSON.parse(readFileSync(import.meta.dir + '/../package.json', 'utf-8'))
  expect(pkg.scripts['build:exe']).toBeDefined()
  expect(pkg.scripts['build:installer']).toBeDefined()
  expect(pkg.scripts['prepublishOnly']).toContain('build')
})

test('bin 仍指向 src/cli.ts（npm 路径）', () => {
  const pkg = JSON.parse(readFileSync(import.meta.dir + '/../package.json', 'utf-8'))
  expect(pkg.bin?.memside).toBe('src/cli.ts')
})
```

- [ ] **Step 2: 跑测试验证失败**

Run: `bun test tests/package-files.test.ts`
Expected: FAIL（`private:true`、无 `files`/`build:exe`）

- [ ] **Step 3: 改 `package.json`**

在 `package.json`：
- 顶层加 `"files": ["src", "opencode-plugin", "tsconfig.json"]`（在 `"private"` 之后）。
- 改 `"private": true` → `"private": false`。
- `scripts` 块加：
  ```json
  "build:exe": "bun build --compile --target=bun-windows-x64 --outfile=dist/memside.exe src/exe/launcher.ts",
  "build:installer": "makensis installer/installer.nsi",
  "prepublishOnly": "bun run build"
  ```
  （`build:installer` 在无 NSIS 的开发机跑会失败，仅 CI/有 NSIS 环境用；测试只断言脚本存在不断言可跑。）

- [ ] **Step 4: 跑测试验证通过**

Run: `bun test tests/package-files.test.ts`
Expected: PASS

- [ ] **Step 5: typecheck + 全量测试**

Run: `bun run typecheck && bun test`
Expected: typecheck clean，全量绿

- [ ] **Step 6: 验证 npm 包 allowlist 真实生效（可选，非门禁）**

Run: `bun pm pack --dry-run 2>&1 | head -40`（或 `npm pack --dry-run`）
Expected: 文件清单含 `src/web/dist/index.html`、`opencode-plugin/memside.js`、`tsconfig.json`；不含 `tests/`。若 `bun pm pack` 不可用，跳过——Task 测试已断言 `files` 字段正确性。

- [ ] **Step 7: Commit**

```bash
git add package.json tests/package-files.test.ts
git commit -m "feat(package): npm 包 files allowlist + 构建脚本（Spec B 接缝 5）"
```

---

## Task 7: NSIS 安装器脚本

**Files:**
- Create: `installer/installer.nsi`
- Test: 源码层断言（加到 `tests/package-files.test.ts` 或新建 `tests/installer-source.test.ts`）

**Interfaces:**
- Consumes: Task 6 产出的 `dist/memside.exe`（`build:exe` 产物）。
- Produces: `installer/memside-setup.exe`（NSIS 编译产物，CI `build:installer` 产出）。

- [ ] **Step 1: 写 `installer/installer.nsi`**

```nsi
; memside Windows installer (Spec B 接缝 6)
; per-user 安装（免 UAC），不自启，uninstall 保数据。
!include "MUI2.nsh"
!include "EnVar.nsh"

Name "memside"
OutFile "memside-setup.exe"
Unicode True
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\memside"

!define APP_NAME "memside"
!define APP_EXE "memside.exe"
!define APP_PUBLISHER "memside"

; ------ MUI ------
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "memside" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"
  ; 主程序（从构建产物拷入；CI build:installer 前先 build:exe）
  File "..\dist\memside.exe"
  ; 开始菜单 + 桌面快捷方式
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\memside.lnk" "$INSTDIR\${APP_EXE}"
  CreateShortcut "$DESKTOP\memside.lnk" "$INSTDIR\${APP_EXE}"
  ; PATH 追加（user scope，幂等）
  EnVar::SetHKCU
  EnVar::AddValue "PATH" "$INSTDIR"
  ; uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"
  ; 注册 Add/Remove（per-user：HKCU）
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "Publisher" "${APP_PUBLISHER}"
SectionEnd

Section "Uninstall"
  ; 删程序文件 + 快捷方式 + PATH
  Delete "$INSTDIR\${APP_EXE}"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\${APP_NAME}\memside.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"
  Delete "$DESKTOP\memside.lnk"
  EnVar::SetHKCU
  EnVar::DeleteValue "PATH" "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"
  ; 不删：~/.memside（记忆库）/ ~/.claude/settings.json（hooks）/ ~/.config/opencode（插件）
  ; —— 用户数据保留；如需彻底清理请手动删上述目录与 settings.json 中 memside-managed 条目。
SectionEnd
```

- [ ] **Step 2: 写源码层断言 `tests/installer-source.test.ts`**

```ts
import { test, expect } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

test('installer/installer.nsi 存在并含关键指令', () => {
  const p = join(repoRoot, 'installer', 'installer.nsi')
  expect(existsSync(p)).toBe(true)
  const src = readFileSync(p, 'utf-8')
  // per-user 免 UAC
  expect(src).toContain('RequestExecutionLevel user')
  // 装 memside.exe
  expect(src).toContain('memside.exe')
  // PATH 追加
  expect(src).toContain('PATH')
  // uninstall 保数据（注释提示）
  expect(src).toMatch(/不删|保留|~\/.memside/)
  // 不自启（无 Run 键 / 无开机注册）
  expect(src).not.toMatch(/HKCU.*Run|Startup|开机自启/)
})
```

- [ ] **Step 3: typecheck + 测试**

Run: `bun run typecheck && bun test tests/installer-source.test.ts`
Expected: typecheck clean，PASS

- [ ] **Step 4: Commit**

```bash
git add installer/installer.nsi tests/installer-source.test.ts
git commit -m "feat(installer): NSIS per-user 安装器脚本（Spec B 接缝 6）"
```

---

## Task 8: GitHub Actions 发版流水线

**Files:**
- Create: `.github/workflows/release.yml`
- Test: 源码层断言（加到 `tests/installer-source.test.ts` 或 `tests/package-files.test.ts`）

**Interfaces:**
- Consumes: Task 6 `build:exe`/`build:installer`/`prepublishOnly` + Task 7 `installer/installer.nsi`。
- Produces: `v*` tag 触发，产 `memside.exe` + `memside-setup.exe` 挂 GitHub Release + `npm publish`。

- [ ] **Step 1: 写 `.github/workflows/release.yml`**

```yaml
# Spec B 接缝 7：tag 发版。打 v* tag 触发：windows job 产 exe+安装器挂 Release，
# ubuntu job npm publish。两 job 独立（npm 包无依赖 exe，串行简化编排）。
name: release
on:
  push:
    tags: ['v*']
  workflow_dispatch: {}  # 手动触发便于调试

permissions:
  contents: write  # 发 GitHub Release

jobs:
  windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install
      - run: bun run build          # vite dist
      - run: bun run build:exe      # dist/memside.exe
      - uses: crazy-max/ghaction-chocolatey@v3
        with:
          args: install nsis -y
      - run: bun run build:installer  # installer/memside-setup.exe（makensis 读 installer/installer.nsi）
        working-directory: ${{ github.workspace }}
      - name: Upload to GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          files: |
            dist/memside.exe
            installer/memside-setup.exe
          generate_release_notes: true

  publish-npm:
    runs-on: ubuntu-latest
    needs: windows
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install
      - uses: actions/setup-node@v4
        with:
          registry-url: 'https://registry.npmjs.org'
      - name: Publish
        run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
      # prepublishOnly（package.json）已在 publish 前跑 bun run build，dist 新鲜。
```

- [ ] **Step 2: 写源码层断言（加到 `tests/installer-source.test.ts`）**

```ts
test('.github/workflows/release.yml 存在并含两 job', () => {
  const p = join(repoRoot, '.github', 'workflows', 'release.yml')
  expect(existsSync(p)).toBe(true)
  const src = readFileSync(p, 'utf-8')
  expect(src).toContain('on:')
  expect(src).toMatch(/tags:\s*\[.*v\*/)
  expect(src).toContain('windows:')
  expect(src).toContain('publish-npm:')
  expect(src).toContain('build:exe')
  expect(src).toContain('build:installer')
  expect(src).toContain('npm publish')
  expect(src).toContain('NPM_TOKEN')
})
```

- [ ] **Step 3: typecheck + 测试**

Run: `bun run typecheck && bun test`
Expected: typecheck clean，全量绿

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml tests/installer-source.test.ts
git commit -m "feat(ci): tag 发版流水线 exe+安装器+npm publish（Spec B 接缝 7）"
```

---

## Task 9: 文档更新（README + STATE）

**Files:**
- Modify: `README.md`（分发/安装章节）
- Modify: `STATE.md`（顶部加 Spec B 落档段）
- Test: 无（纯文档，CLAUDE.md 测试豁免）

**Interfaces:** 无。

- [ ] **Step 1: README 加分发说明**

在 `README.md` 安装/快速开始区，加"成品安装"章节（npm + exe 两条路径），明确：
- npm：`bunx memside start-and-install`（推荐，需 bun）或 `npm i -g memside && memside start-and-install`。
- Windows exe：下载 `memside-setup.exe`（GitHub Release）双击安装 → 开始菜单/桌面快捷方式 → 双击启动 → 访问 `http://127.0.0.1:7777`。未签名 SmartScreen 警告引导（"更多信息→仍运行"）。
- 数据位置：`~/.memside/memside.db`（卸载保留）。
- 卸载：控制面板/开始菜单卸载（保数据）；彻底清理需手动删 `~/.memside` 与 settings.json 中 memside-managed 条目。

- [ ] **Step 2: STATE.md 顶部加 Spec B 段**

参考 STATE.md 既有 Spec 段格式，加"成品发布（npm + Windows exe + NSIS 安装器 + GHA 发版）（2026-08-17，Spec B）"段，列 7 接缝实现点 + 执行方法 + 测试数 + 上线后观测清单（exe 编译体积、npm 下载量、安装器成功率、SmartScreen 拦截反馈）+ deferred（macOS/Linux exe、代码签名、托盘、autostart、自动更新）。

- [ ] **Step 3: Commit**

```bash
git add README.md STATE.md
git commit -m "docs: 成品分发安装说明 + STATE 落档（Spec B）"
```

---

## Self-Review

**1. Spec 覆盖**：spec 7 接缝 → task 映射：接缝1=Task1+2，接缝2=Task3，接缝3=Task5，接缝4=Task4，接缝5=Task6，接缝6=Task7，接缝7=Task8。文档=Task9。全覆盖，无遗漏。

**2. 占位符扫描**：assets.ts/launcher.ts 有"执行者注意"说明资产导入 API 以实测为准（spec 失败模式 #2 已授权回退），非占位符——给出了具体实现 + 明确回退路径。无 TBD/TODO/无测试代码。

**3. 类型一致**：`EmbeddedAssets`（Task4）→ `loadEmbeddedAssets(): Promise<{indexHtml, assets}>`（Task4 返回、Task5 消费）；`DaemonOpts.serveStaticAssets`（Task2）形状与 `CreateAppDeps.staticAssets`（Task1）一致 `{indexHtml: string; assets: Record<string, Uint8Array>}`；`InstallOpencodePluginOpts.files`（Task3）形状 `{memside.js, package.json}`（Task5 消费）。跨 task 名称一致。

**4. 依赖顺序**：Task1→Task2（createApp 先于 daemon 透传）→Task3（独立）→Task4（assets，独立）→Task5（launcher 依赖 2/3/4）→Task6（package.json，独立但 launcher 要 build:exe 引用）→Task7（installer 引用 dist/memside.exe）→Task8（CI 引用 6/7 脚本）→Task9（文档）。无环。

**5. 测试门禁**：每代码 task 带 typecheck + bun test；exe/NSIS/CI 用源码层断言 + CI build 本身验证。CLAUDE.md 门禁满足。

## 执行选择

计划已存 `docs/superpowers/plans/2026-08-17-packaged-distribution.md`。用户已授权 subagent-driven 执行（"直接 subagent driven 方式执行，这几个动作不再询问用户"）。进入 superpowers:subagent-driven-development。
