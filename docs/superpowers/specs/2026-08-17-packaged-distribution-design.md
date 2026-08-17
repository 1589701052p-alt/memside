# Spec: 成品发布（npm 包 + Windows exe + 安装器）（2026-08-17）

> 这是双 spec 分解的 **Spec B**。**Spec A（记忆可移植性与批量操作）** 已于 2026-08-16 合并（PR #64，commit a99c300）。
> 配套计划：`docs/superpowers/plans/2026-08-17-packaged-distribution.md`（writing-plans 产出）。

## 背景

memside 即将商用。当前**没有成品分发**：用户必须 `git clone` 整个仓库、`bun install`、`bun run build`、`bun run src/cli.ts start-and-install` 才能用。对开发者调试方便，对终端用户不友好。Spec A 已补齐记忆管理层商用能力（回收站/导出导入/多选）；本 spec 补齐**分发层**：发布成 npm 包 + Windows 单文件 exe + NSIS 安装器，终端用户一键安装。

当前运行时形态（已核实）：

- **入口** `src/cli.ts`（bin `memside`），三命令 `start` / `install` / `start-and-install`。shebang `#!/usr/bin/env bun`。
- **生产启动** `scripts/start.ts`：要求 `src/web/dist/index.html`（vite 预构建产物），`startDaemon({serveStaticDir: distDir})` 单端口同时托管 API + 静态 UI + 装钩子。
- **静态托管接缝**（`src/server.ts:1005-1008`）：`createApp` deps 接 `staticDir?: string`，命中时 `app.get('/', serveStatic({path: join(staticDir,'index.html')}))` + `app.use('/assets/*', serveStatic({root: staticDir}))`，走 `hono/bun` 的 `serveStatic`（**磁盘读**）。
- **opencode 插件安装**（`src/install.ts:183-215`）：`installOpencodePlugin` `cpSync(pluginSrcDir, destDir)` 复制磁盘目录（`opencode-plugin/memside.js` + `package.json`）→ 端口烘焙（`__MEMSIDE_PORT__` 替换）→ 幂等合并 `opencode.json` 的 `plugin` 数组。
- **运行时代码** 全部 `src/**/*.ts`，用 `@/` 路径别名（tsconfig paths 解析）。
- **运行时依赖资源**：`src/**/*.ts` + `src/web/dist/`（预构建 UI）+ `opencode-plugin/`（memside.js + package.json）。
- **外部写入点**（与 exe 安装位置无关，均在用户主目录）：`~/.memside/memside.db`（SQLite WAL）+ `~/.claude/settings.json`（hooks）+ `~/.config/opencode/`（插件）。
- `package.json` 现 `private:true`，`bin` 指向 `src/cli.ts`（TS 源，依赖 bun 运行时）。

## 目标 / 非目标

### 目标

1. **npm 包**：`npm i -g memside`（或 `bunx memside`）后 `memside start-and-install` 即用；`files` allowlist 只发运行时所需，`tests/`/`docs/`/`scripts/`/源码 web 不入包；预构建 dist 随包发布。
2. **Windows 单文件 exe**：`bun build --compile --target=bun-windows-x64` 自包含（Bun 运行时 + JS + 内嵌 web dist + 内嵌 opencode 插件）；双击即启动 daemon + 装钩子 + 托管 UI；零额外依赖。
3. **NSIS 安装器**：per-user 安装到 `%LOCALAPPDATA%\memside`（免 UAC）+ 开始菜单/桌面快捷方式 + PATH；uninstall 删程序保数据。
4. **GitHub Actions 发版**：打 `v*` tag 触发，CI 产 `memside.exe` + `memside-setup.exe` 挂 GitHub Release + `npm publish`。
5. **最小侵入接缝**：dev/npm/exe 三路径共享同一 daemon 与 install 代码，新增 `staticAssets`（内存资产）与 `installOpencodePlugin` 内容模式两个旁路，不改既有磁盘路径行为。

### 非目标

- macOS/Linux 单文件 exe（npm 包覆盖这些平台；`bun build --compile` cross-compile 留 v1.1）。
- 代码签名（v1 未签名；Windows SmartScreen 警告，文档引导；v1.1 评估签名）。
- 托盘图标 / 自动更新检查 / portable 模式（v1.1+）。
- **开机自启**（用户已选手动启动；不做自启注册）。
- 在线升级 / 增量更新（卸载重装即可）。
- npm 包在纯 Node（无 bun）环境运行——`bun:sqlite` 是 Bun 专有，Node 跑不了；npm 路径是 bun 用户通道。
- 多端口/多实例并发安装（单实例，端口 7777 固定）。

## 接口契约

### 接缝 1：`createApp` 内存静态资产（`src/server.ts`）

`CreateAppDeps` 新增可选字段：

```ts
/** 内存静态资产（exe 编译模式）：命中时 GET / 与 /assets/* 从内存返回，
 * 不读盘。dev/npm 路径用 staticDir 走磁盘，不传本字段。 */
staticAssets?: {
  indexHtml: string
  /** key 是相对 staticDir 的路径（如 'assets/index-abc.js'），value 是文件内容。 */
  assets: Record<string, Uint8Array>
}
```

`createApp` 末尾静态托管块扩展（伪代码）：

```ts
if (deps.staticAssets) {
  app.get('/', (c) => c.html(deps.staticAssets!.indexHtml))
  app.get('/assets/*', (c) => {
    const rel = c.req.path.replace(/^\//, '')              // 'assets/x.js'
    const body = deps.staticAssets!.assets[rel]
    if (!body) return c.notFound()
    return new Response(body, { headers: { 'content-type': mimeFor(rel) } })
  })
} else if (deps.staticDir) {
  // 既有磁盘分支不变
  app.get('/', serveStatic({ path: join(deps.staticDir, 'index.html') }))
  app.use('/assets/*', serveStatic({ root: deps.staticDir }))
}
```

- `mimeFor(path)`：简单扩展名→MIME 映射（`.js→text/javascript`、`.css→text/css`、`.html→text/html`、`.svg→image/svg+xml`、其余 `application/octet-stream`），内联小函数，不引新依赖。
- `staticAssets` 与 `staticDir` 互斥（同时传是配置错误，但实现上 `staticAssets` 优先；文档注释写明互斥）。
- `serveStatic` import 保留（磁盘分支仍用）。

`startDaemon`（`src/daemon.ts`）新增 `serveStaticAssets?` 透传到 `createApp`，与 `serveStaticDir` 互斥。

### 接缝 2：`installOpencodePlugin` 内容模式（`src/install.ts`）

`InstallOpencodePluginOpts` 新增可选 `files` 字段：

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

实现：`files` 命中时跳过 `cpSync`，改为 `writeFileSync(jsPath, files['memside.js'])` + `writeFileSync(pkgPath, files['package.json'])`，端口烘焙照旧（读 jsPath → 替换 → 写回）。`pluginSrcDir` 分支不变。两者都缺 → 抛错（配置错误）。`cli.ts` 源码模式继续传 `pluginSrcDir`。

### 接缝 3：exe launcher 入口（`src/exe/launcher.ts`，新）

```ts
// Bun 资产导入（编译期把 dist + plugin 内嵌进 exe）
import indexHtml from '../web/dist/index.html' with { type: 'text' }
import assets from './assets'        // 见 assets.ts，资产 map
import pluginJs from '../../opencode-plugin/memside.js' with { type: 'text' }
import pluginPkg from '../../opencode-plugin/package.json' with { type: 'json' }
// → 启动逻辑：port-check + startDaemon(serveStaticAssets) + installOpencodePlugin(files)
```

- 无参默认 = 生产启动（等价 `start-and-install`）：port-check → `startDaemon({port, installClaudeHooks:true, serveStaticAssets:{indexHtml, assets}})` → `installOpencodePlugin({port, files:{'memside.js':pluginJs,'package.json':pluginPkg}})` → 控制台常驻显示 `memside on http://127.0.0.1:7777 — Ctrl+C 退出`。
- 复用 `scripts/start.ts` 的 port-check（`findPortHolders`/`promptReclaim`/`reclaim`）。
- 不打印 `usage: memside ...`（那是源码 cli.ts 的未知命令分支；launcher 无参即启动）。
- 资产导入的 `with { type }` 语法是 Bun 专有，源码模式 `bun run` 不走这里（launcher 只被 `bun build --compile` 消费），故不影响 dev。

### 接缝 4：`src/exe/assets.ts`（新，资产 map 装配）

把 `src/web/dist/assets/*` 逐文件 `with { type: 'file' }` 导入成 `Record<string, Uint8Array>`。dist 文件名带 hash、数量不定，需一个能通配的装配方式——用 `Bun.file` + 目录 glob 在 launcher 启动时枚举（编译期不可枚举未知文件名，但可在运行时 `Glob`/`readdir` dist 目录……）。

**实际方案**（运行时枚举，避开编译期通配难题）：launcher 不用 `with` 导入散文件，而是 `bun build --compile` 时把整个 `src/web/dist/` 目录用 Bun 的 directory import 内嵌：

```ts
import distDir from '../web/dist' with { type: 'directory' }
// distDir 是 DirEntry，可遍历其内文件
```

`assets.ts` 在启动时遍历 `distDir`，读每个文件成 `Uint8Array`，key 用相对路径，喂给 `staticAssets`。index.html 单独取。**若 directory import API 在所用 Bun 版本不稳定，回退方案**：构建期脚本把 dist 文件清单写成一个 `manifest.ts`（`export const FILES = [['assets/x.js', await file().bytes()], ...]`），launcher 导入它。回退方案优先级低，先按 directory import 实现，CI 验证。

> **设计原则**：dist 资产加载逻辑抽到纯函数 `loadEmbeddedAssets(): {indexHtml, assets}`（`assets.ts`），launcher 与测试都能调用；测试可注入假资产 map 验 `createApp` 的 `staticAssets` 分支，不依赖真实 dist 存在。

### 接缝 5：构建脚本与 package.json

`package.json` 改动：

```jsonc
{
  "private": false,
  "files": ["src", "opencode-plugin", "tsconfig.json"],
  "scripts": {
    "build:exe": "bun build --compile --target=bun-windows-x64 --outfile=dist/memside.exe src/exe/launcher.ts",
    "build:installer": "makensis installer/installer.nsi",
    "prepublishOnly": "bun run build"
  }
}
```

- `files` allowlist：`src/`（含 `src/web/dist/` 预构建产物，由 `prepublishOnly` 保证新鲜）、`opencode-plugin/`、`tsconfig.json`（`@/` 路径别名解析需要）。`tests/`/`docs/`/`scripts/`/`.superpowers/`/`vite.config.ts`/`src/web/` 源码（非 dist）不入包。
- `prepublishOnly` 在 `npm publish` 前跑 `vite build`，保证发版 dist 新鲜（npm 包与 exe 共用同一 dist 构建逻辑）。
- `build:exe` 产 `dist/memside.exe`（注意 `dist/` 顶层与 `src/web/dist/` 不同：前者是构建产物输出目录，后者是 web 前端产物）。
- `bun:sqlite` 是 Bun 专有 → npm 包不声明 Node `engines`，README 标注"需 bun 运行时"。

### 接缝 6：NSIS 安装器（`installer/installer.nsi`，新）

```nsi
; per-user 安装（RequestExecutionLevel user，免 UAC）
; InstallDir "$LOCALAPPDATA\memside"
; Sections: 主程序 memside.exe（从构建产物拷入）
;   开始菜单快捷方式 + 桌面快捷方式
;   PATH 追加（EnVar 插件，user scope）
; Uninstall: 删程序 + 快捷方式 + PATH 移除
;   保留 ~/.memside / ~/.claude / ~/.config/opencode（用户数据）
```

- 不自启注册（用户已选手动）。
- uninstaller 写明"保留用户数据与 hooks；如需彻底清理请手动删 `~/.memside` 与 `~/.claude/settings.json` 中的 memside-managed 条目"。

### 接缝 7：GitHub Actions 发版（`.github/workflows/release.yml`，新）

触发：`on.push.tags: ['v*']`。

**Job 1: `windows`（产 exe + 安装器）**
- `runs-on: windows-latest`
- steps: checkout → `oven-sh/setup-bun` → `bun install` → `bun run build`（vite dist）→ `bun run build:exe`（memside.exe）→ `choco install nsis -y` → `bun run build:installer`（memside-setup.exe）→ `softprops/action-gh-release` 上传 `dist/memside.exe` + `installer/memside-setup.exe`。

**Job 2: `publish-npm`（产 npm 包）**
- `runs-on: ubuntu-latest`，`needs: windows`（exe 先成，npm 包无依赖但串行简化）。
- steps: checkout → setup-bun → `bun install` → `npm publish`（`prepublishOnly` 跑 build 保证 dist 新鲜）→ 用 `NPM_TOKEN` secret。
- 发版前 `npm view memside` 探测包名是否被占（见失败模式 #5）。

## 数据流

```
开发 (dev)：
  bun run dev / bun run start → scripts/start.ts
    → startDaemon({serveStaticDir: 'src/web/dist'})  [磁盘静态]
    → installOpencodePlugin({pluginSrcDir})           [磁盘复制]

npm 包用户：
  npm i -g memside (或 bunx memside)
  → prepublishOnly 已跑 vite build，src/web/dist/ 随包
  → memside start-and-install → src/cli.ts start-and-install 分支
    → startDaemon({installClaudeHooks:true, serveStaticDir: 内嵌? })  
      [npm 包 dist 在磁盘上，仍走 serveStaticDir 磁盘分支]
    → installOpencodePlugin({pluginSrcDir: 相对 cli.ts 的 opencode-plugin/})

exe 用户：
  双击 memside.exe (或 NSIS 安装后双击快捷方式)
  → src/exe/launcher.ts
    → loadEmbeddedAssets() [内存 dist]
    → port-check (复用 scripts/start.ts 逻辑)
    → startDaemon({installClaudeHooks:true, serveStaticAssets})
    → installOpencodePlugin({files: 内嵌插件字符串})
    → 控制台常驻

发版：
  git tag v0.1.0 && git push origin v0.1.0
  → release.yml windows job: build → build:exe → NSIS → GitHub Release (exe+setup)
  → release.yml npm job: npm publish (prepublishOnly build dist)
```

## 与现有模块的耦合点

- **`src/server.ts`**：`CreateAppDeps` 加 `staticAssets?`，静态托管块加内存分支。`mimeFor` 内联小函数。`serveStatic` import 保留。
- **`src/daemon.ts`**：`StartDaemonOpts` 加 `serveStaticAssets?`，透传 `createApp`。与 `serveStaticDir` 互斥。
- **`src/install.ts`**：`InstallOpencodePluginOpts` 加 `files?`（与 `pluginSrcDir` 互斥），内容模式分支。
- **`src/cli.ts`**：零改动（源码模式继续 `pluginSrcDir`）。`bin` 仍指向 `src/cli.ts`（npm 路径）。
- **`src/exe/launcher.ts` + `src/exe/assets.ts`**（新）：exe 编译入口 + 资产装配纯函数。复用 `scripts/start.ts` 的 port-check（抽出或直接 import；launcher 不依赖 scripts/start.ts 的 vite dist 存在性检查——它用内嵌资产）。
- **`package.json`**：`private:false`、`files` allowlist、`prepublishOnly`、`build:exe`/`build:installer` 脚本。
- **`installer/installer.nsi`**（新）：NSIS 脚本。
- **`.github/workflows/release.yml`**（新）：发版流水线。
- **`src/web/dist/`**：仍由 `vite build` 产出，dev/npm 走磁盘、exe 走内嵌，构建产物同一份。
- **测试**：`tests/daemon-static-assets.test.ts`（新）、`tests/install-opencode-content.test.ts`（扩既有或新）、`tests/package-files.test.ts`（新，`npm pack --dry-run` 清单断言）、`tests/launcher-source-assertions.test.ts`（新，源码层文本断言兜底）。

## 失败模式

1. **未签名 exe SmartScreen 拦截**：Windows 对未签名 exe 双击弹"已保护你的电脑"。缓解：README + Release 说明引导"更多信息→仍运行"；v1.1 评估代码签名。非 bug，已知限制。
2. **`bun build --compile` 资产嵌入失败**：directory import 或 `with {type}` 语法在所用 Bun 版本不可用。缓解：`assets.ts` 回退到构建期 `manifest.ts` 方案（构建脚本枚举 dist 写清单）；CI 验证即红。
3. **npm 包名 `memside` 被占**：发版前 `npm view memside` 探测，占则改 scoped 名（`@memside/cli` 或类似）并更新 bin/docs。CI publish job 在 `npm publish` 前探测，失败可读报错。
4. **PATH 冲突**：installer 追加 `%LOCALAPPDATA%\memside` 到 user PATH，若用户已有同名条目或旧安装残留。缓解：NSIS EnVar 插件幂等追加；uninstall 清理自身条目（不动其他）。
5. **卸载丢数据**：uninstall 误删 `~/.memside`。缓解：NSIS uninstall section 显式只删程序目录，注释写明保留用户数据；uninstaller 不碰 `~/.memside`/`~/.claude`/`~/.config/opencode`。
6. **exe 体积膨胀**：`bun build --compile` 把 Bun 运行时（~90MB）+ JS + dist 全打进单 exe。缓解：v1 接受（用户友好优先于体积）；dist 小（<1MB），主要体积是 Bun 运行时，无法压缩。
7. **dist 过期导致 exe/npm 跑旧 UI**：exe 编译期或 npm publish 时 dist 未重建。缓解：`prepublishOnly` 强制 build；CI exe job 在 `build:exe` 前显式 `bun run build`。
8. **launcher 资产加载在纯源码模式崩**：launcher 用 `with {type}` 语法，`bun run src/exe/launcher.ts`（非编译）可能不解析资产导入。缓解：launcher 只供 `bun build --compile` 消费，dev 用 `scripts/start.ts`；文档注释写明。

## 测试策略

对齐 CLAUDE.md 测试门禁（`bun run typecheck && bun test` 全绿才 push）+ "首选可断言面:纯函数层写足测试,运行时层只留少量集成断言"。

**纯函数/集成层（主力，可进 `bun test`）**

- `tests/daemon-static-assets.test.ts`（新）：起 daemon 带 `staticAssets:{indexHtml:'<h1>hi</h1>', assets:{'assets/x.js': new TextEncoder().encode('alert(1)')}}`，`GET /` 断言返回 indexHtml 内容 + `content-type: text/html`，`GET /assets/x.js` 断言返回内容 + `text/javascript`，`GET /assets/missing` 断言 404。不依赖真实 dist。锁 `mimeFor` 扩展名映射。
- `tests/install-opencode-content.test.ts`（新/扩）：`installOpencodePlugin({port, baseDir:tmp, files:{'memside.js':'__MEMSIDE_PORT__ here','package.json':'{}'}})` → 断言 destDir 下两文件存在 + js 端口烘焙替换正确 + `opencode.json` plugin 数组含 destDir 幂等。与既有 `pluginSrcDir` 磁盘分支测试并存。
- `tests/package-files.test.ts`（新）：`bun pm pack`（或 `npm pack --dry-run`）→ 解析清单 → 断言含 `src/web/dist/index.html`、`opencode-plugin/memside.js`、`tsconfig.json`；断言不含 `tests/`、`docs/`、`scripts/`、`vite.config.ts`、`.superpowers/`。若 pack 在测试环境不可用（无 npm/bun pm），降级为读 `package.json` 的 `files` 字段断言 allowlist 正确性（源码层断言兜底）。
- `tests/launcher-source-assertions.test.ts`（新）：源码层文本断言——读 `src/exe/launcher.ts` 源码，断言含 `startDaemon`、`serveStaticAssets`、`installOpencodePlugin`、`files` token（对齐既有运行时组件只留源码层文本断言兜底模式）。launcher 无法被 `bun test` 实跑（需编译）。

**不可进 `bun test` 的（CI 自身是集成验证）**

- exe 实际编译 + 双击运行 → CI `build:exe` 失败即红；人工 smoke：双击 exe 访问 127.0.0.1:7777 见 UI。
- NSIS 安装器实装 → CI `makensis` 失败即红；人工 smoke：装→开始菜单快捷方式→启动→卸载（验数据保留）。
- GitHub Actions workflow 本身 → 首次 `git tag v0.x` 真发版验证；workflow 语法用 `actionlint`（若可用）兜底。

这些不写进 `bun test`，但 CI workflow 的 build 步骤即其集成断言——build 失败 = 红。标注为已知，非测试豁免滥用。

## 与既有债务/决策的关系

- 复用 `scripts/start.ts` 的 port-check（`findPortHolders`/`promptReclaim`/`reclaim`）——launcher 共享同一启动防呆逻辑。
- 复用 `startDaemon` + `createApp` + `installOpencodePlugin`/`installHooks` 既有接缝，新增旁路而非重写。
- 复用 `vite build`（既有 `build` script）产出 dist，dev/npm/exe 三路径共用同一构建产物。
- 复用 `@/` 路径别名（tsconfig paths）——npm 包随附 `tsconfig.json` 保别名解析；exe 编译期已解析。
- 不引入新运行时依赖（NSIS 是构建期工具，CI runner 装；GitHub Actions 是外部 CI；Bun 资产导入是 Bun 内建）。npm 发版依赖 `npm` CLI（CI 装）。
- Spec A 的 `~/.memside/memside.db` 数据目录与本 spec 无耦合——exe/npm 写同一目录，数据互通。
