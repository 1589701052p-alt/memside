# 运行环境设置重设计 spec

日期：2026-08-17
状态：待批准
关联：`docs/superpowers/specs/2026-08-17-runtime-path-config-design.md`（前作，落地了路径配置 + claude 侧 install/uninstall）；本 spec 在其基础上修两类问题——(1) UI 不清晰（三框三按钮无标签、按钮与框关系不明、设了不知道干嘛），(2) opencode 安装/卸载在 UI 里根本不生效（前作 §6.6 把 opencodeDir 字段存了却没接进 install/uninstall，且无 `uninstallOpencodePlugin`）。

## 1. 背景

前作（PR #78）落地了「运行环境」路径配置：`RuntimePaths`（claudeDir / settingsFilename / opencodeDir）+ claude 侧 install/uninstall 端点 + 一个扁平的 `RuntimeSettings` UI 区块。它解决了 codeagent 读 `~/.cac/setting.json` 的路径问题，但留下两个产品级缺陷：

### 1.1 UI 不清晰（用户反馈）

当前 `RuntimeSettings`（`src/web/App.tsx:2098-2172`）是「三输入框 + 三按钮 + 一条提示」平铺：

1. **三个输入框无标签**——只有 placeholder 标识（claude 目录 / 文件名 / opencode 目录），一旦聚焦/输入 placeholder 消失，用户分不清哪个框是干嘛的。
2. **两个框共同组成一个路径却平级并列**——`claudeDir` + `settingsFilename` 合成 *一个* 文件路径（`~/.cac` + `setting.json`），但它们和无关的 opencode 框并排，看不出关系。
3. **三个按钮关系不明 + 脚枪**——「保存路径」与「安装 hooks」为何分两步？更糟：`安装` 读的是 *已保存* 的路径，不是框里的值。用户改了框、没点保存就点安装，会 *静默装了旧路径*。这是正确性缺陷，不止是清晰度。
4. **opencode 框装了不生效**——前作 §6.6 明说 opencodeDir 字段存了但 install/uninstall 不读它。用户填了、点安装、opencode 毫无反应。纯陷阱。
5. **「这设置干嘛的 / 我要不要动」被埋没**——答案（官方 Claude Code 用默认路径无需改；公司 codeagent 才需改路径）藏在一段密文里。

### 1.2 opencode 安装/卸载 UI 不生效

`installOpencodePlugin`（`src/install.ts:252`）只在进程启动时被调用（`cli.ts:49`/`:54` 用 `pluginSrcDir`，`exe/launcher.ts:63` 用内嵌 `files`），**从无 API/UI 入口**。且 **`uninstallOpencodePlugin` 函数根本不存在**。所以 UI 的 opencode 框 + 安装/卸载按钮对 opencode 完全空操作。

### 1.3 为什么升级到 architectural

「让 opencode install/uninstall 经 UI 真正生效」不是 relabel——它是 *新流程*：把插件源（files/srcDir）plumb 进运行中的 daemon、给 server 加 opencode 注入接缝、新增 `uninstallOpencodePlugin` 函数、扩展端点 target 维度、重构 UI 成双分组。跨 `install.ts` / `daemon.ts` / `server.ts` / `cli.ts` / `exe/launcher.ts` / `App.tsx` / `api.ts`，且引入前作明确 defer 掉的新行为。属产品行为变更，按 CLAUDE.md 走 brainstorming spec+plan。

## 2. 目标 / 非目标

### 目标

1. **UI 一眼看懂**：运行环境区块拆成两个自包含分组——`Claude Code / codeagent`（claude-code fork）与 `opencode / nga`（opencode fork）。每组：可见标签的字段 + 实时「→ 将写入：`<解析路径>`」预览 + 自己的「保存并安装」/「卸载」+ 结果消息。
2. **按钮与框的关系可见**：「保存并安装」= 先存当前框值、再装到 *预览显示的* 路径，消除「改了没存就装旧路径」的脚枪；三按钮收敛为每组两个。
3. **opencode 真正生效**：opencodeDir 驱动 install/uninstall；新增 `uninstallOpencodePlugin`；daemon 在启动时拿到插件源（dev 走 srcDir、exe 走 files），server 端点据此在请求时安装/卸载。
4. **零回归**：claude 侧端点默认行为逐字节不变；既有 `installRuntimeHooks()`/`uninstallRuntimeHooks()` 签名向后兼容（新增可选 `target` 参数，默认 `claude`）；daemon 启动时的自动安装（`start-and-install` / launcher）行为不变，只是 *额外* 让 UI 按钮可用。

### 非目标

- **不做 hook/plugin「当前是否已装」自检**——前作 §2 已决策：daemon 侧无法可靠验证 agent 是否真在读该文件，属 YAGNI。UI 的 ✓ 只在 *刚点击成功* 后显示为短暂结果消息，不是持久状态徽标。不谎称「已生效」。
- 不做多 runtime profile 切换（单组配置 + 默认兜底，沿用前作）。
- 不做路径自动探测（沿用前作）。
- 不改 `installOpencodePlugin` 的 srcDir/files 双模式契约（已稳定，本 spec 只加其 uninstall 对偶 + 经 API 暴露）。
- 不改 LLM 凭证 / distiller / adapter / scheduler。

## 3. 接口契约

### 3.1 `uninstallOpencodePlugin`（`src/install.ts`，新增）

```ts
export function uninstallOpencodePlugin(opts: {
  baseDir?: string  // 默认 ~/.config/opencode，与 installOpencodePlugin 同
}): { removed: number; pluginPath: string; dirRemoved: boolean }
```

逻辑（`installOpencodePlugin` 的幂等对偶）：

- `ocdDir = opts.baseDir ?? join(resolveHome(), '.config', 'opencode')`。`~` 展开**不在本函数做**——由调用方（server 端点）展开放进来（与 `uninstallHooks` 同款：baseDir 期望已是绝对路径）。
- `destDir = join(ocdDir, 'memside-opencode')`。`rmSync(destDir, { recursive: true, force: true })`——目录不存在不抛。`dirRemoved` = 调用前 `existsSync(destDir)`。
- 读 `opencode.json`：不存在/malformed → 视为空文档（`removed:0`），但 *仍执行* dir 删除（dir 删除不依赖 json 解析）。
- 解析合法对象 → 取 `plugin` 数组（非数组视为 `[]`）→ `filter(p => !(typeof p==='string' && p.includes('memside-opencode')))`。`removed` = 被过滤掉的条目数。
- `removed > 0` → 写回 `opencode.json`（`JSON.stringify(cfg, null, 2) + '\n'`）；`removed === 0` → 不重写文件（镜像 `uninstallHooks` 的 N-3：避免无谓 reformat 用户文件）。
- 永不抛（malformed json / 缺文件均降级），IO 错误（rmSync/writeFileSync 极少抛）按现有 `installOpencodePlugin` 约定上浮。

返回：`{ removed, pluginPath: <opencode.json 绝对路径>, dirRemoved }`。

### 3.2 daemon 插件源 plumbing（`src/daemon.ts` / `DaemonOpts`）

`DaemonOpts` 新增可选字段：

```ts
export interface DaemonOpts {
  // ...既有...
  /** opencode 插件源（让 UI 的「保存并安装」能在请求时装/卸 opencode）。
   *  - dev/npm：cli.ts 传 { srcDir: <repo>/opencode-plugin }
   *  - exe：launcher 传 { files: { 'memside.js', 'package.json' } }
   *  缺省 → daemon 不暴露 opencode install 能力（端点返回 ok:false + 说明）。 */
  opencodePluginSource?: { srcDir: string } | { files: { 'memside.js': string; 'package.json': string } }
}
```

`startDaemon` 在组装 `createApp` 的 `AppDeps` 时，若 `opencodePluginSource` 提供，构造两个绑定函数注入：

```ts
const installOpencodePluginFn = opts.source
  ? (o: { baseDir?: string }) => {
      const src = opts.source!
      installOpencodePlugin({ port, baseDir: o.baseDir,
        ...( 'srcDir' in src ? { pluginSrcDir: src.srcDir } : { files: src.files } ) })
    }
  : undefined
const uninstallOpencodePluginFn = (o: { baseDir?: string }) => uninstallOpencodePlugin(o)
```

注：`uninstallOpencodePlugin` 不依赖 source（只删 dir + 过滤 json），故无条件提供；`installOpencodePluginFn` 依赖 source，缺 source 时为 `undefined`。

### 3.3 `AppDeps` 注入接缝（`src/server.ts`）

`AppDeps` 新增（镜像既有 `installHooksFn` / `uninstallHooksFn`）：

```ts
installOpencodePluginFn?: (opts: { baseDir?: string }) => void
uninstallOpencodePluginFn?: (opts: { baseDir?: string }) => { removed: number; pluginPath: string; dirRemoved: boolean }
```

缺省（生产）由 daemon.ts 注入真实实现（见 3.2）；测试注入假实现，不碰真实 `~/.config/opencode`（镜像 `settings-runtime-api.test.ts` 的 fake 模式）。

### 3.4 server 端点扩展（`src/server.ts`）

既有 4 个端点的 `install` / `uninstall` 增加 `target` 维度（query 参数，默认 `claude` 保后兼容）：

```
POST /api/settings/runtime/install?target=claude|opencode   (默认 claude)
POST /api/settings/runtime/uninstall?target=claude|opencode (默认 claude)
GET  /api/settings/runtime                                   (不变)
PUT  /api/settings/runtime                                   (不变)
```

**install** 分流：

- `target=claude`（默认）：现有逻辑不动——`loadRuntimePaths` → `~` 展开 claudeDir → `doInstall({ port, baseDir, settingsFilename })` → `{ ok, settingsPath }`。
- `target=opencode`：若 `installOpencodePluginFn` 缺（daemon 未带 source）→ `{ ok:false, error:'opencode 插件源在本启动模式下不可用（仅 dev/exe 启动支持），请用命令行安装' }`。否则 `loadRuntimePaths` → `~` 展开 opencodeDir → `installOpencodePluginFn({ baseDir })` → 成功 `{ ok:true, pluginPath: <destDir> }`；抛错 → `{ ok:false, error }`。

**uninstall** 分流：

- `target=claude`（默认）：现有逻辑不动 → `{ ok, removed, settingsPath }`。
- `target=opencode`：`~` 展开 opencodeDir → `uninstallOpencodePluginFn({ baseDir })` → `{ ok:true, removed, pluginPath, dirRemoved }`。

`~` 展开复用既有 `resolveHome()`（`src/server.ts:79`）逻辑，对 opencodeDir 同样处理（`startsWith('~')` → `join(resolveHome(), slice(1))`）。

校验：`target` 非 `claude`/`opencode` → 400 `{ error }`。

### 3.5 web-api client（`src/web/api.ts`）

`installRuntimeHooks` / `uninstallRuntimeHooks` 新增可选 `target` 参数（默认 `'claude'`，向后兼容），作为 query 串到 URL：

```ts
export async function installRuntimeHooks(
  target: 'claude' | 'opencode' = 'claude', fetchFn: FetchLike = fetch,
): Promise<{ ok: boolean; settingsPath?: string; pluginPath?: string; error?: string }> {
  const res = await fetchFn(`/api/settings/runtime/install?target=${target}`, { method: 'POST' })
  return (await res.json()) as ...
}
export async function uninstallRuntimeHooks(
  target: 'claude' | 'opencode' = 'claude', fetchFn: FetchLike = fetch,
): Promise<{ ok: boolean; removed?: number; settingsPath?: string; pluginPath?: string; dirRemoved?: boolean; error?: string }> { ... }
```

`getRuntimeSettings` / `saveRuntimeSettings` 形状不变。

### 3.6 Web UI（`src/web/App.tsx`）

重构 `RuntimeSettings` 成双分组。复用既有 `<section>` 约定与 `MemoryCard` 视觉风格（inline style + 约定结构，CLAUDE.md「优先复用」）。结构：

```
<section> 运行环境
  <p> 一句话目的 + 「官方 Claude Code 用默认路径无需改；公司内部 agent 见下」
  <error 横幅>（fetch 失败显，CLAUDE.md 状态可见性）

  <div 分组 claude>
    <h4> Claude Code / codeagent <span>claude-code fork</span>
    <label> 配置目录 <input claudeDir></label>
    <label> 文件名 <input settingsFilename></label>
    <div> → 将写入：<resolvedClaudePath></div>   // 实时 = (claudeDir||default)/(settingsFilename||default)
    <button 保存并安装> <button 卸载>   // busy 禁用
    <msg>（成功「✓ 已安装到 <path>」/「✓ 已移除 N 个 hook 组」；失败红字）
  </div>

  <div 分组 opencode>
    <h4> opencode / nga <span>opencode fork</span>
    <label> 配置目录 <input opencodeDir></label>
    <div> → 将写入：<resolvedOpencodePath></div>  // 实时 = (opencodeDir||default)/memside-opencode/
    <button 保存并安装> <button 卸载>
    <msg>
  </div>

  <p 提示> codeagent 用户通常填 ~/.cac + setting.json；安装仅写入上述路径，请确认是 agent 实际读取的配置；卸载只移除 memside 管理项，不影响你自写的。
</section>
```

**状态与处理**：

- 共享一次 `getRuntimeSettings` 拉取（claudeDir/settingsFilename/opencodeDir + defaults），三字段各自 `useState`。
- **「保存并安装」handler**（每组）：`setBusy` → `saveRuntimeSettings({ <本组字段> })`（只存本组字段，字段级合并）→ `installRuntimeHooks(target)` 读刚存的路径装 → 据 `{ok, settingsPath|pluginPath}` 设 msg。两步串行；save 失败则不 install、显 save 错误。这消除脚枪：永远用框里的值装。
- **「卸载」handler**：`uninstallRuntimeHooks(target)` → msg。
- **resolved-path 预览**：纯函数 `resolveClaudePath(claudeDir, settingsFilename, defaults)` / `resolveOpencodePath(opencodeDir, defaults)`，空串回落 default，`~` 原样展示（install 时 server 展开）。抽成纯函数便于测试（CLAUDE.md「首选可断言面」）。
- 每组独立 `busy`/`msg`（互不阻塞）。
- 不做持久「已安装」徽标（§2 非目标）；msg 仅反映最近一次操作结果。

## 4. 数据流

### 4.1 codeagent 用户首次配置（claude 分组）

1. 打开设置 tab → `RuntimeSettings` 拉取默认值（claudeDir=`~/.claude`、settingsFilename=`settings.json`）。
2. 在 claude 分组填 `~/.cac` + `setting.json` → 预览实时显「→ 将写入：~/.cac/setting.json」。
3. 点「保存并安装」→ save 存路径 → install 装到 `~/.cac/setting.json` → msg「✓ 已安装到 ~/.cac/setting.json」→ codeagent 读到 hooks → 闭环通。

### 4.2 opencode 用户首次配置（opencode 分组）

1. daemon 启动带 `opencodePluginSource`（dev: srcDir / exe: files）。
2. 用户在 opencode 分组填/确认 `~/.config/opencode` → 预览显「→ 将写入：~/.config/opencode/memside-opencode/」。
3. 点「保存并安装」→ save → `install?target=opencode` → server 调 `installOpencodePluginFn({ baseDir })` → 复制插件 + 烘焙端口 + 合并 opencode.json → msg「✓ 已安装到 .../memside-opencode/」。
4. 若 daemon 未带 source（罕见启动路径）→ msg 显「opencode 插件源在本启动模式下不可用…请用命令行安装」，不静默。

### 4.3 卸载

点某组「卸载」→ 对应 target uninstall → claude 移除 5 个 event 的 memside hook 组（保留用户 hook）；opencode 删 `memside-opencode/` 目录 + 过滤 `opencode.json` plugin 数组（保留用户插件）。msg 显移除计数/路径。daemon 进程不动。

## 5. 与现有模块的耦合点

| 模块 | 改动 | 兼容性 |
|---|---|---|
| `src/install.ts` | 新增 `uninstallOpencodePlugin` | 纯增量，不动 `installOpencodePlugin`/`installHooks`/`uninstallHooks` |
| `src/daemon.ts` | `DaemonOpts` 加 `opencodePluginSource`；构造两个绑定函数注入 `createApp` | 缺省 undefined → opencode install 端点降级返回说明，零回归 |
| `src/server.ts` | `AppDeps` 加 `installOpencodePluginFn`/`uninstallOpencodePluginFn`；install/uninstall 端点加 `target` 分流 + opencodeDir `~` 展开 | target 默认 claude → 既有调用逐字节不变 |
| `src/cli.ts` | `start`/`start-and-install` 给 `startDaemon` 传 `opencodePluginSource:{ srcDir: pluginSrcDir }` | `start` 原本不装 opencode，现仅 * enabling UI 按钮*，不在启动时自动装（`start` 语义不变）；`start-and-install` 仍启动时自动装 |
| `src/exe/launcher.ts` | 给 `startDaemon` 传 `opencodePluginSource:{ files:{ memside.js: ea.pluginJs, 'package.json': ea.pluginPkg } }` | 启动时仍自动装（不变），额外让 UI 可重装 |
| `src/web/api.ts` | `installRuntimeHooks`/`uninstallRuntimeHooks` 加可选 `target` 参数 | 默认 claude，既有调用兼容 |
| `src/web/App.tsx` | `RuntimeSettings` 重构成双分组 + 抽 `resolveClaudePath`/`resolveOpencodePath` 纯函数 | 替换既有扁平 UI |

## 6. 失败模式

1. **daemon 未带 opencode source**（如未来某个未传 source 的启动入口）→ opencode install 端点返回 `{ok:false, error:'…请用命令行安装'}`，UI 显该消息。不抛、不 crash。
2. **用户填不存在的 opencodeDir** → `installOpencodePlugin` 已 `mkdirSync({recursive:true})` 自建。
3. **用户填 agent 不读的路径** → 装了但不触发。UI msg 只如实说「已写入 <path>」+ 提示文案「请确认是 agent 实际读取的配置」，不谎称已生效（沿用前作 §6.2）。
4. **路径含 `~`** → server 端点对 claudeDir/opencodeDir 都 `resolveHome` 展开（install 端展开；UI 预览原样显示 `~`）。沿用前作 §6.3 决策。
5. **malformed opencode.json** → install（既有）/uninstall（新增）均「视为空文档」降级，不抛。uninstall 仍删 dir（dir 删除不依赖 json 解析）。
6. **opencode install 抛 IO 错** → 端点 catch → `{ok:false, error}`，UI 显红字。
7. **save 与 install 之间竞态** → 单用户本地工具，两步串行，忽略。

## 7. 测试策略

CLAUDE.md 强制：代码改动带测试，纯函数层优先，运行时组件最低限度源码层文本断言兜底。

### 7.1 install 纯函数层（`tests/install-opencode.test.ts` 扩展）

`uninstallOpencodePlugin`：
- 先 install 再 uninstall → `memside-opencode/` 目录消失 + `opencode.json` plugin 数组无 memside-opencode 条目；`removed>=1`、`dirRemoved=true`。
- 预置用户既有 plugin 条目（如 `superpowers@git+...`）→ uninstall 后保留。
- dir 不存在 + opencode.json 不存在 → `removed:0`、`dirRemoved:false`、不抛。
- malformed opencode.json → `removed:0` 不抛，但 dir 若存在仍删（`dirRemoved` 如实）。
- 重复 uninstall（已无 memside 痕迹）→ `removed:0`、`dirRemoved:false`、不重写文件（幂等）。
- `baseDir` 显式传入（用 tmp dir，绝不碰真实 `~/.config/opencode`）。

### 7.2 server 层（`tests/settings-runtime-api.test.ts` 扩展）

- `install?target=opencode` 调 `installOpencodePluginFn` 注入 fake，传入 *已保存* 的 opencodeDir（先 PUT 再 install）；返回 `{ok:true, pluginPath}`。
- `install?target=opencode` 当 `installOpencodePluginFn` 缺 → `{ok:false, error}` 含「不可用」。
- `install?target=opencode` 抛错 → `{ok:false, error}`。
- `uninstall?target=opencode` 调 `uninstallOpencodePluginFn` fake，传已存 opencodeDir；返回 `{ok:true, removed, pluginPath, dirRemoved}`。
- `uninstall?target=opencode` 抛错 → `{ok:false, error}`。
- opencodeDir 含 `~` → 传给 fake 的 `baseDir` 已展开（无 `~`）。
- `target=claude`（默认）→ 与既有 claude 行为逐字节一致（回归锁，既有测试不变）。
- `target=invalid` → 400。

### 7.3 daemon plumbing（`tests/daemon-install-paths.test.ts` 扩展）

- `startDaemon({ opencodePluginSource:{ srcDir } })` → `createApp` 收到 `installOpencodePluginFn`（能调且用 srcDir）+ `uninstallOpencodePluginFn`。
- `startDaemon({ opencodePluginSource:{ files } })` → 同理用 files。
- `startDaemon({})`（不传 source）→ `installOpencodePluginFn` 为 undefined；`uninstallOpencodePluginFn` 仍提供（uninstall 不依赖 source）。

### 7.4 web-api 层（`src/web/api.ts` 源码层文本断言）

- `installRuntimeHooks`/`uninstallRuntimeHooks` 携 `target` query（默认 `claude`）；返回类型含 `pluginPath`/`dirRemoved`（与既有 wrapper 形状断言同模式）。

### 7.5 App.tsx 运行时兜底（源码层文本断言）

- `RuntimeSettings` 含两个分组标题（`Claude Code / codeagent`、`opencode / nga`）+ 每组「保存并安装」「卸载」按钮 + `resolveClaudePath`/`resolveOpencodePath` 纯函数引用（CLAUDE.md 运行时组件最低面）。
- 纯函数单测（`resolveClaudePath`/`resolveOpencodePath`）：空串回落 default、组合路径正确。

## 8. 上线后观测（结论回填 STATE.md）

1. UI 双分组在 dev（`bun run dev:web`）+ exe 两种模式都正确渲染、字段标签清晰、预览实时。
2. codeagent 用户经 claude 分组「保存并安装」后 hook 真触发（daemon SessionStart/Stop 日志 + 新 distill job）。
3. opencode 用户经 opencode 分组「保存并安装」后 plugin 落地 `~/.config/opencode/memside-opencode/` + `opencode.json` 注册，新会话 inject 生效。
4. 两组「卸载」分别清掉对应痕，且互不影响 + 保留用户自写项。

## 9. deferred（follow-up，非本 spec）

1. hook/plugin「当前是否已装」自检——需 agent 侧配合，YAGNI。
2. 多 runtime profile（同时用 codeagent + 原版 claude code）——单组 + 默认兜底，YAGNI。
3. opencode 也支持自定义文件名/子路径——opencode 安装结构固定（`memside-opencode/` 目录 + `opencode.json`），无需。
