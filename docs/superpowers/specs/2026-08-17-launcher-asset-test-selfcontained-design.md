# launcher 资产测试自给自足（根治 manifest/dist 脱节）

## 背景

`tests/launcher-source-assertions.test.ts:89` 的 `loadEmbeddedAssets()` 字节比对测试长期脆弱：

- 它比较 `manifest.ts`（git tracked，gen-manifest 烘焙的 dist 内容）与磁盘 `src/web/dist/index.html`（`.gitignore` 忽略，本地 `bun run build` 产物）。
- 脱节条件：本地 `bun run build`（vite 重生 dist，hash 变）但没跟 `bun run gen-manifest`（manifest 还是旧 hash）→ 字节比对失败 → 测试红。
- 根因：测试拿"进 git 的 manifest"和"不进 git 的 dist"做比对，**依赖"两者是同一次 build"这个巧合**，但 `dist/` 不进 git、`build` 与 `gen-manifest` 是两个独立命令，本地任何一次不带 gen-manifest 的 build 都会打破这个前提。

实测：在 origin/master（PR #80 基线，零相关改动）上该测试同样红；跑一次 `gen-manifest` 同步后转绿，但下一次本地 build 又红。STATE.md「2026-08-17 打包发布」已知债务 Task 6 F1 记过"manifest.ts stale payload"。

PR #80 合并后该测试在 master 上又红（dist 被某次 build 改、manifest 没跟），证实 gen-manifest 一次性同步是治标不治本。

## 目标 / 非目标

### 目标
1. 让 `loadEmbeddedAssets` 字节比对测试**永远绿、自给自足**——不依赖磁盘 dist 与 git manifest 同步。
2. 抽出 `assembleAssets(manifest)` 纯函数，把"manifest → EmbeddedAssets"装配逻辑与"manifest 来源"解耦：生产 `loadEmbeddedAssets()` 从 import 拿 manifest（行为不变），测试给纯函数喂自造 manifest（不读磁盘 dist）。
3. 测试改用自造 tmp dist + tmp manifest 对象，断言 `assembleAssets` 输出与 tmp dist 字节一致——dist 怎么变都不影响测试。

### 非目标
- 不改 `gen-manifest.ts`（烘焙逻辑不动）。
- 不改 `launcher.ts`（仍调 `loadEmbeddedAssets()`，行为不变）。
- 不改 `manifest.ts`（git tracked，照旧；gen-manifest 在 build:exe 时更新）。
- 不动 `.gitignore` / `package.json` / 不加 pretest 钩子（不污染所有人的 `bun test` 流程、不让 gen-manifest 写盘污染工作区）。
- 不把 dist 纳入 git（污染仓库）。
- 不删 manifest.ts 进 git 的事实（exe 编译需要它，build:exe 会刷新）。

## 接口契约

### `src/exe/assets.ts` 新增 `Manifest` 类型 + `assembleAssets` 纯函数

```ts
/** gen-manifest 烘焙的 manifest.ts 四常量形状。抽出供测试注入，生产从 import 来。 */
export interface Manifest {
  INDEX_HTML: string
  ASSET_FILES: [string, string][]   // [key, base64]
  PLUGIN_JS: string
  PLUGIN_PKG: string
}

/**
 * 把 manifest 装配成 createApp.staticAssets + installOpencodePlugin.files 所需统一对象。
 * 纯函数：相同 manifest 产出相同 map；不读外部磁盘、不依赖 import。
 * assets 用 base64 解码（二进制安全）。indexHtml/pluginJs/pluginPkg 透传字符串。
 */
export function assembleAssets(m: Manifest): EmbeddedAssets {
  const assets: Record<string, Uint8Array> = {}
  for (const [key, b64] of m.ASSET_FILES) {
    assets[key] = Buffer.from(b64, 'base64')
  }
  return {
    indexHtml: m.INDEX_HTML,
    assets,
    pluginJs: m.PLUGIN_JS,
    pluginPkg: m.PLUGIN_PKG,
  }
}
```

### `loadEmbeddedAssets()` 改为委托（行为逐字节不变）

```ts
import { INDEX_HTML, ASSET_FILES, PLUGIN_JS, PLUGIN_PKG } from './manifest'

export async function loadEmbeddedAssets(): Promise<EmbeddedAssets> {
  return assembleAssets({ INDEX_HTML, ASSET_FILES, PLUGIN_JS, PLUGIN_PKG })
}
```

保持 `async`（launcher `await` 它，签名不变）；返回值与旧实现逐字节一致（同一装配逻辑搬进纯函数）。`EmbeddedAssets` 接口不动。

## 数据流

```
生产: launcher.ts ─► loadEmbeddedAssets() ─► assembleAssets(import 的 manifest) ─► EmbeddedAssets
                                                              ↑ manifest.ts (git, gen-manifest 烘)
测试: test ─► assembleAssets(自造 Manifest 对象) ─► 断言 vs tmp dist 字节一致
                      ↑ 不读磁盘 dist、不读 git manifest、不跑 gen-manifest
```

## 测试策略

### 改造 `tests/launcher-source-assertions.test.ts:89` 那条测试

原测试（依赖磁盘 dist）：
```ts
const ea = await loadEmbeddedAssets()
const idxOrig = readFileSync(join(srcDir, 'web', 'dist', 'index.html'), 'utf-8')
expect(ea.indexHtml).toBe(idxOrig)   // ← 依赖磁盘 dist == git manifest，脆弱
```

新测试（自造 fixture，自给自足）：
- 用 `mkdtempSync` 造 tmp 目录，写假 `index.html`、假 `assets/x.js`（含已知字节，含非 ASCII 验二进制安全）、假 plugin js（含 `__MEMSIDE_PORT__`）、假 plugin pkg（合法 JSON）。
- 不跑 gen-manifest（避免写盘污染）；直接构 `Manifest` 对象：`INDEX_HTML` = tmp index.html 内容；`ASSET_FILES` = `[ ['assets/x.js', Buffer.from(tmpJsContent).toString('base64') ] ]`；`PLUGIN_JS` / `PLUGIN_PKG` = tmp 文件内容。
- 调 `assembleAssets(manifest)`，断言：
  - `ea.indexHtml === tmpIndexHtml`；
  - `ea.assets['assets/x.js']` 字节级等于 tmp `assets/x.js`（逐字节比对，含非 ASCII）；
  - `ea.pluginJs === tmpPluginJs` 且含 `__MEMSIDE_PORT__`；
  - `ea.pluginPkg === tmpPluginPkg` 且 `JSON.parse(ea.pluginPkg).name` 正确。
- **不 import loadEmbeddedAssets 比对磁盘 dist**——彻底切断对磁盘/git manifest 的依赖。

### 新增纯函数性回归锁
- 相同 manifest 输入 → `assembleAssets` 输出相同（两次调用的 assets map 字节一致、indexHtml/pluginJs/pluginPkg 逐字一致）。

### 保留既有源码层文本守卫（不动）
- `assets.ts 存在并暴露 loadEmbeddedAssets`（line 17）、`走 manifest 回退路径不含 directory import`（line 46 区域）等文本断言保留——它们锁的是源码形状，不依赖磁盘 dist。

### `loadEmbeddedAssets` 委托回归锁
- 新增一条：`loadEmbeddedAssets()` 调用 `assembleAssets`（源码层文本守卫，防未来 refactor 把装配逻辑搬回 loadEmbeddedAssets 内联、断了纯函数接缝）。

## 失败模式

1. **磁盘 dist 不存在/过时**：新测试不读磁盘 dist，不受影响（这是根治点）。
2. **git manifest.ts 过时**：新测试不用 git manifest，不受影响。生产 `loadEmbeddedAssets` 仍用 git manifest（exe 编译时 build:exe 会刷新，runtime 时 manifest 已烘进 exe，无脱节问题——脱节只在"测试拿磁盘 dist 比 git manifest"时出现）。
3. **base64 解码非 ASCII 字节**：用 `Buffer.from(b64,'base64')`（旧逻辑逐字搬进 assembleAssets），二进制安全，回归锁覆盖非 ASCII。

## 与现有模块的耦合点

- `src/exe/assets.ts`：抽 `Manifest` 类型 + `assembleAssets` 纯函数；`loadEmbeddedAssets` 委托（主改，纯重构）。
- `tests/launcher-source-assertions.test.ts:89`：那条测试改用自造 fixture（主改）。
- `scripts/gen-manifest.ts`：不动。
- `src/exe/launcher.ts`：不动（仍 `await loadEmbeddedAssets()`）。
- `src/exe/manifest.ts`：不动。
- `package.json` / `.gitignore`：不动。

## 验证门槛

`bun run typecheck && bun test` 必须全绿才能 push。**重点验证**：故意不跑 gen-manifest、甚至删掉磁盘 dist，该测试仍绿（证明自给自足）。

## 预期效果

- 该测试从此**永远绿**，不再因本地 build 脱节而红。
- master 工作区不再因 gen-manifest 残留未提交的 manifest.ts 改动（A stash 的那个问题根源消除——测试不再依赖磁盘 dist，无需 gen-manifest 同步）。
- A stash 的 manifest.ts 改动可丢弃（master git manifest 仍是 git HEAD 状态，测试不依赖它新鲜）。
