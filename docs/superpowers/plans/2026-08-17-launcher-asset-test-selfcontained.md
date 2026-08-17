# 实现计划：launcher 资产测试自给自足（根治 manifest/dist 脱节）

设计 spec：`docs/superpowers/specs/2026-08-17-launcher-asset-test-selfcontained-design.md`。本计划按 spec 落地，3 个任务，每任务独立可测、可由 subagent 实现（implementer）+ 复核（reviewer）。

基线：origin/master HEAD `16ec886`（PR #80 已合并）。运行门槛：`bun run typecheck && bun test` 全绿才能 push。

> 注：基线状态下 `tests/launcher-source-assertions.test.ts:89` 的 `loadEmbeddedAssets` 字节比对测试是**红的**（dist/manifest 脱节），本计划的目标就是让它转绿且永远绿。Task 完成后该测试必须绿，且删磁盘 dist 也绿。

---

## Task 1：抽 `Manifest` 类型 + `assembleAssets` 纯函数；`loadEmbeddedAssets` 委托

**文件**：`src/exe/assets.ts`

**改**（spec §接口契约，纯重构，行为逐字节不变）：

1. 新增 `Manifest` 接口（在 `EmbeddedAssets` 之后）：
   ```ts
   export interface Manifest {
     INDEX_HTML: string
     ASSET_FILES: [string, string][]   // [key, base64]
     PLUGIN_JS: string
     PLUGIN_PKG: string
   }
   ```

2. 新增 `assembleAssets(m: Manifest): EmbeddedAssets` 纯函数（把现 `loadEmbeddedAssets` body 的装配逻辑搬进去）：
   ```ts
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
   （注意：旧 `loadEmbeddedAssets` 是 `async` 返回 `Promise<EmbeddedAssets>`；`assembleAssets` 是同步纯函数返回 `EmbeddedAssets`。装配逻辑里无 await，搬进同步函数语义正确。）

3. `loadEmbeddedAssets()` 改成委托（保持 async 签名，launcher `await` 它不变）：
   ```ts
   export async function loadEmbeddedAssets(): Promise<EmbeddedAssets> {
     return assembleAssets({ INDEX_HTML, ASSET_FILES, PLUGIN_JS, PLUGIN_PKG })
   }
   ```

4. 顶部 import 不变（`import { INDEX_HTML, ASSET_FILES, PLUGIN_JS, PLUGIN_PKG } from './manifest'`）。
5. 更新 `loadEmbeddedAssets` 的 JSDoc 注释：说明它委托 `assembleAssets`，装配逻辑在纯函数里（供测试注入）。

**约束**：
- 纯重构：`loadEmbeddedAssets()` 返回值与旧实现逐字节一致（同一装配逻辑搬进 `assembleAssets`，只是包了一层）。无行为变更。
- `EmbeddedAssets` 接口不动。
- 不改 `gen-manifest.ts` / `launcher.ts` / `manifest.ts`。
- 不引入新依赖。

**验收**：
- `bun run typecheck` 干净。
- 现有测试不回归（除那条已知红的字节比对测试——它本来因脱节红，Task 1 不动它，仍红；Task 2 才修它）。

**交付物**：`src/exe/assets.ts` 改动。implementer 完成后 reviewer 复核：纯重构（行为不变）、Manifest 类型正确、assembleAssets 是纯函数（不读外部状态）。

---

## Task 2：改造字节比对测试为自造 fixture（自给自足）

**文件**：`tests/launcher-source-assertions.test.ts`（line 89 那条测试）

**改**（spec §测试策略）：把依赖磁盘 dist 的 `loadEmbeddedAssets()` 比对，改成自造 fixture + `assembleAssets` 比对。

新测试要点：
- `import { assembleAssets, type Manifest } from '@/exe/assets'`（若测试文件尚未 import type，加上）。
- 用 `mkdtempSync(join(tmpdir(), 'memside-asset-'))` 造 tmp 目录。
- 写 fixture：
  - tmp `index.html`：已知文本（如 `<html>...<title>TEST</title>...`）。
  - tmp `assets/x.js`：已知字节，**含非 ASCII**（如 `Buffer.from([0xE4,0xBD,0xA0])` 或写入含中文/emoji 的字符串）——验 base64 解码二进制安全。
  - tmp plugin `memside.js`：含 `__MEMSIDE_PORT__` 占位。
  - tmp plugin `package.json`：合法 JSON，`{"name":"memside-opencode",...}`。
- 构 `Manifest` 对象（不跑 gen-manifest、不读磁盘 dist 真实文件——直接用刚写的 tmp 文件内容构）：
  ```ts
  const manifest: Manifest = {
    INDEX_HTML: readFileSync(tmpIndex, 'utf-8'),
    ASSET_FILES: [['assets/x.js', readFileSync(tmpJs).toString('base64')]],
    PLUGIN_JS: readFileSync(tmpPluginJs, 'utf-8'),
    PLUGIN_PKG: readFileSync(tmpPluginPkg, 'utf-8'),
  }
  ```
- 调 `const ea = assembleAssets(manifest)`，断言：
  - `ea.indexHtml === manifest.INDEX_HTML`；
  - `ea.assets['assets/x.js']` 是 `Uint8Array`，且 `Buffer.from(ea.assets['assets/x.js'])` 等于 tmp `assets/x.js` 原始字节（逐字节比对，含非 ASCII）；
  - `ea.pluginJs === manifest.PLUGIN_JS` 且 `ea.pluginJs.includes('__MEMSIDE_PORT__')`；
  - `ea.pluginPkg === manifest.PLUGIN_PKG` 且 `JSON.parse(ea.pluginPkg).name === 'memside-opencode'`。
- **不 import loadEmbeddedAssets 用于比对**（切断磁盘 dist 依赖）；不 `readFileSync(join(srcDir,'web','dist',...))`。

**关键验收（证明根治）**：
- 该测试转绿。
- **删磁盘 dist 后该测试仍绿**（implementer 交付前验证：临时把 `src/web/dist` 改名，跑该测试，应仍绿；改回。或用 `git stash` 掉 dist 不现实——dist 不进 git，故用改名/移动法验证，验证后还原）。

**保留**：文件里其他源码层文本守卫测试（line 17、46 区域）不动。

**验收**：
- 该测试绿，且不依赖磁盘 dist。
- `bun run typecheck` 干净。
- `bun test tests/launcher-source-assertions.test.ts` 全绿。

**交付物**：`tests/launcher-source-assertions.test.ts` 改动。reviewer 复核：测试不读磁盘 dist、fixture 自造、非 ASCII 字节断言存在、`__MEMSIDE_PORT__` 与 JSON.parse 断言存在。

---

## Task 3：纯函数性回归锁 + loadEmbeddedAssets 委托守卫

**文件**：`tests/launcher-source-assertions.test.ts`（追加）

**新增两条测试**：

1. **纯函数性锁**（spec §纯函数性回归锁）：
   - 构一个固定 `Manifest`（用已知常量，不读磁盘）。
   - 调 `assembleAssets(manifest)` 两次，断言两次输出：
     - `indexHtml`/`pluginJs`/`pluginPkg` 逐字相等；
     - `assets` map 的 key 集合相同、每个 key 对应 `Uint8Array` 逐字节相等。
   - 锁"相同输入→相同输出"的纯函数性，防未来引入外部状态。

2. **loadEmbeddedAssets 委托守卫**（spec §loadEmbeddedAssets 委托回归锁）：
   - 源码层文本断言：`assets.ts` 源码含 `assembleAssets({ INDEX_HTML, ASSET_FILES, PLUGIN_JS, PLUGIN_PKG })`（grep 级），且 `loadEmbeddedAssets` body 仅委托无内联装配。
   - 防未来 refactor 把装配逻辑搬回 `loadEmbeddedAssets` 内联、断了纯函数接缝。

**验收**：
- 两条新测试绿。
- `bun run typecheck` 干净。

**交付物**：测试追加。reviewer 复核：纯函数性锁真断言两次输出一致（非空断言）、委托守卫文本断言精准。

---

## Task 4：终审 + 验证门槛 + PR

**动作**：
1. `bun run typecheck && bun test` 全绿（**基线那条红测试必须转绿**——这是本 PR 的核心交付）。
2. **根治验证**（spec §预期效果）：临时移动/删 `src/web/dist`，再跑 `bun test tests/launcher-source-assertions.test.ts`，该文件全绿（证明自给自足）；还原 dist。
3. 全分支 code-review（`/code-review origin/master high`）：0 Critical / 0 Important。
4. 复核 spec 非目标未越界：未改 gen-manifest/launcher/manifest.ts/package.json/.gitignore、无新依赖、纯重构 + 测试改造。
5. commit（逻辑分组：Task 1 一个 commit、Task 2+3 一个 commit、spec/plan 一个 commit）+ push + 开 PR 到 master（标题 `fix(test): launcher 资产测试自给自足——根治 manifest/dist 脱节`）。
6. PR 合并后，丢弃 A stash 的 manifest.ts 改动（`git stash drop`，因测试不再依赖磁盘 dist，无需 gen-manifest 同步）。

**验收**：PR 绿、review 通过、master 上该测试从此永远绿。

---

## 任务依赖

- Task 1 → Task 2（测试用 assembleAssets）→ Task 3（回归锁用 assembleAssets）→ Task 4（终审全分支）。
- Task 1/2/3 可由 implementer 顺序做（assets.ts + 测试两文件，串行避免冲突）；Task 4 由 controller（本会话）直接核验 + 开 PR。

## subagent-driven 执行参数

- implementer：sonnet（小改动 + 测试，sonnet 足够）。
- reviewer：sonnet（约束裁决）。
- Task 1、2、3 各一个 implementer+reviewer 往返；Task 4 由 controller 直接核验 + 开 PR。
- 每个 implementer 任务 prompt 含：本计划对应 Task 全文 + spec 文件路径 + 约束（纯重构行为不变/测试不读磁盘 dist/`bun run typecheck && bun test` 门槛）。
- reviewer prompt 含：Task 全文 + 验收清单 + spec 非目标清单（防越界）。
- **每个 Task 完成即 commit**（CLAUDE.md SDD 流程，不堆积未提交改动）。
