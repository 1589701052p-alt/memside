# 运行环境设置四槽独立配置 spec

日期：2026-08-19
状态：待批准
关联：`docs/superpowers/specs/2026-08-17-runtime-settings-redesign-design.md`（前作，落地双分组 UI + opencode 安装/卸载生效）。本 spec 在其基础上把「共享槽」拆成「四独立槽」并新增安装状态实时探测——前作用两个共享配置（claude+codeagent 共享一套 dir/filename、opencode+nga 共享一套 dir）驱动两路 install，本 spec 拆成四个互不干扰的独立槽 + 每槽实时显示「已安装 / 未安装」。

## 1. 背景

前作把运行环境设置重设计成双分组 UI（`Claude Code / codeagent` + `opencode / nga`），每组共享一条配置：

- claude/codeagent 共享 `claudeDir` + `settingsFilename`（同一组两个 agent 读的是**同一个**文件，无法分别装到 `~/.claude/settings.json` 与 `~/.cac/setting.json`）。
- opencode/nga 共享 `opencodeDir`（同一组两个 agent 读**同一个** `opencode.json`）。
- 安装状态**不可见**——前作 §2 非目标明确决策「不做持久已安装徽标」，UI 只在刚点完 install/uninstall 后显一条短暂结果消息，刷新页面即丢失；用户无法一眼看出「这四个 agent 各自到底装没装」。

### 1.1 用户需求

用户明确要求：

1. **四个 agent 各自独立配置**——claude code、codeagent、opencode、nga 四个应同时支持，**分开 4 个配置**，互不覆盖。当前共享槽导致同时使用 claude code + codeagent 的用户只能配其中一个的路径，装另一个会覆盖前一个的 hooks。
2. **安装状态可见**——每个配置要有反馈，**是否已安装的状态要有显示**。
3. **opencode 与 nga 路径可能相同可能不同**——两者默认都是 `~/.config/opencode`，但用户可能把 nga 装到别处；必须作为**两个独立字段**，而非共享一个。

### 1.2 为什么升级到 architectural

不是 relabel：数据模型从 3 共享字段重构成 4 独立槽（含一次性迁移启发式）；install target 维度从 2 扩到 4；新增安装状态探针能力（`install.ts` 两个只读函数 + server status 端点 + AppDeps 注入）；UI 从双分组 2 卡重构成 4 卡 + 状态徽标。跨 `settings.ts` / `install.ts` / `server.ts` / `daemon.ts` / `web/api.ts` / `web/runtime-paths.ts` / `web/App.tsx` + 全部对应测试，属产品行为变更，按 CLAUDE.md 走 brainstorming spec+plan。

## 2. 目标 / 非目标

### 目标

1. **四独立配置槽**：claude code / codeagent / opencode / nga 各自独立的路径字段，互不覆盖。claude 与 codeagent 各自带「目录 + 文件名」（hooks 型 agent 的核心差异就是文件名 `settings.json` vs `setting.json`）；opencode 与 nga 各自带「目录」（plugin 型 agent 安装结构固定）。
2. **实时安装状态徽标**：每个槽实时显示「✓ 已安装 / ○ 未安装」。状态由 server 读磁盘真实文件（settings.json / opencode.json）探针得出，能发现 daemon 重启 / 手动改文件后的漂移，符合 CLAUDE.md 状态可见性。
3. **opencode 与 nga 独立**：两者各自独立字段，默认值相同但不共享——路径相等时属磁盘真实共享（同一文件里都有标记→两者都显示已装），非 bug。
4. **零回归**：迁移把旧 3 共享字段启发式归位到新 4 槽，零数据丢失；既有 install/uninstall 端点行为对 claude target 逐字节不变（仅扩 target 取值域）。

### 非目标

- **不验证 agent 是否真在读该文件**——探针只验证「memside 标记是否在配置文件里」，不验证 agent 进程是否加载（沿用前作 §2；agent 是否加载需 agent 侧配合，YAGNI）。
- **不做多 profile 切换**——四槽各一份配置 + 默认兜底。
- **不改 installHooks/installOpencodePlugin 的磁盘写入契约**（已稳定）。
- **不改 LLM 凭证 / distiller / adapter / scheduler**。
- **opencode/nga 不加文件名字段**——plugin 型安装结构固定（`memside-opencode/` 目录 + `opencode.json`），无需。

## 3. 接口契约

### 3.1 数据模型（`src/settings.ts`，4 槽重构）

废弃旧 3 共享 key（`runtime.claude_dir` / `runtime.settings_filename` / `runtime.opencode_dir`），改用 4 槽独立 key（沿用 `app_settings` 平铺风格，无 schema 迁移）：

| 槽 | 平铺 key | 默认值 |
|---|---|---|
| claude code | `runtime.claude.dir` + `runtime.claude.settings_filename` | `~/.claude` / `settings.json` |
| codeagent | `runtime.codeagent.dir` + `runtime.codeagent.settings_filename` | `~/.cac` / `setting.json` |
| opencode | `runtime.opencode.dir` | `~/.config/opencode` |
| nga | `runtime.nga.dir` | `~/.config/opencode`（与 opencode 默认相同） |

```ts
export interface RuntimePaths {
  claude: { dir: string; settingsFilename: string }
  codeagent: { dir: string; settingsFilename: string }
  opencode: { dir: string }
  nga: { dir: string }
}
```

- `defaultRuntimePaths()`：返回上述四槽默认值（claudeDir=`join(resolveHome(),'.claude')`、codeagentDir=`join(resolveHome(),'.cac')`、settingsFilename 分别 `settings.json`/`setting.json`、opencode/nga dir 均 `join(resolveHome(),'.config','opencode')`）。codeagent 默认目录从 `.claude` 改为 `.cac`——前作把 codeagent 默认沿用 `~/.claude` 是因为共享槽，拆独立后 codeagent 用其真实默认 `~/.cac`。
- `loadRuntimePaths(db)`：四槽各自「缺失/空串逐字段回默认」；`expandTilde` 对 dir 字段保留（IF-1 修复点沿用前作）。**迁移**（load 时一次性启发式归位，见 §3.2）。
- `saveRuntimePaths(db, patch)`：字段级合并写，提供才写，空串 = 删该 key 回默认（沿用前作语义）。patch 形状与 `RuntimePaths` 对齐（per-slot 子对象可选）。

### 3.2 迁移启发式（`loadRuntimePaths` 内，一次性，不写盘）

旧 3 共享 key 仍可能存在于老库。`loadRuntimePaths` 读新 key 时，若某槽新 key 缺失但旧 key 存在，按启发式归位（**只读不写**——新 key 一旦由 PUT 写入即优先生效，旧 key 自然作废）：

- 旧 `runtime.claude_dir` + `runtime.settings_filename`（共享）：
  - 若旧 `settingsFilename === 'setting.json'` **或** 旧 `claudeDir` 以 `.cac` 结尾 → 归 **codeagent** 槽（dir + settingsFilename 都给 codeagent）。
  - 否则 → 归 **claude** 槽。
  - 另一槽取默认。
- 旧 `runtime.opencode_dir`（共享）→ 归 **opencode** 槽；nga 槽取默认。

归位逻辑只在「新 key 不存在」时触发；新 key 已写则忽略旧 key。不删旧 key（避免破坏性），零数据丢失。

### 3.3 安装状态探针（`src/install.ts`，新增只读、永不抛）

复刻 `uninstallHooks`/`uninstallOpencodePlugin` 已有的读逻辑，抽两个纯探针（只读不写）：

```ts
/** 探测 claude 系 settings.json 是否含 memside hook 标记。永不抛。 */
export function isHooksInstalled(opts: {
  baseDir?: string
  settingsFilename?: string
}): { installed: boolean; settingsPath: string }

/** 探测 opencode 系 opencode.json 是否注册了 memside-opencode 插件。永不抛。 */
export function isOpencodePluginInstalled(opts: {
  baseDir?: string
}): { installed: boolean; pluginPath: string; dirExists: boolean }
```

- `isHooksInstalled`：`settingsPath = join(claudeDir, settingsFilename ?? 'settings.json')`。缺文件/malformed → `{installed:false, settingsPath}`。解析合法 → 取 `hooks` 对象，五事件任一 hook 组命令含 `MEMSIDE_TAG` → `installed:true`。复用 `uninstallHooks` 的解析路径（缺文件/畸形降级，永不抛）。
- `isOpencodePluginInstalled`：`destDir = join(ocdDir,'memside-opencode')`；`dirExists = existsSync(destDir)`。读 `opencode.json`：malformed/缺文件 → plugin 数组视为 `[]`。`installed = dirExists && plugin 数组含 'memside-opencode' 条目`。`pluginPath = opencode.json 绝对路径`。

### 3.4 AppDeps 注入接缝（`src/server.ts`）

镜像既有 `installHooksFn`/`uninstallHooksFn`，新增两个只读注入点：

```ts
isHooksInstalledFn?: (opts: { baseDir?: string; settingsFilename?: string }) => { installed: boolean; settingsPath: string }
isOpencodePluginInstalledFn?: (opts: { baseDir?: string }) => { installed: boolean; pluginPath: string; dirExists: boolean }
```

缺省（生产）由 `daemon.ts` 注入真实实现；测试注入假实现，不碰真实 `~/.claude`/`~/.config/opencode`。

### 3.5 daemon 透传（`src/daemon.ts`）

`startDaemon` 在组装 `createApp` 的 `AppDeps` 时注入两个探针（无条件注入，不依赖插件源——探针只读磁盘）：

```ts
isHooksInstalledFn: (o) => isHooksInstalled(o),
isOpencodePluginInstalledFn: (o) => isOpencodePluginInstalled(o),
```

### 3.6 server 端点（`src/server.ts`）

#### GET /api/settings/runtime（形状换代）

返回 4 槽 + defaults：

```json
{
  "claude": { "dir": "...", "settingsFilename": "settings.json" },
  "codeagent": { "dir": "...", "settingsFilename": "setting.json" },
  "opencode": { "dir": "..." },
  "nga": { "dir": "..." },
  "defaults": { ...同形... }
}
```

#### PUT /api/settings/runtime

接受 per-slot patch（`z.object` schema 校验，非字符串 400）。字段级保存。返回新形状（含 defaults）。

#### GET /api/settings/runtime/status（新增）

对 4 个 target 各自 `~` 展开 + 探针，返回每槽安装状态：

```json
{
  "claude": { "installed": true, "path": "C:/Users/.../.claude/settings.json" },
  "codeagent": { "installed": false, "path": "C:/Users/.../.cac/setting.json" },
  "opencode": { "installed": true, "path": "C:/Users/.../.config/opencode/opencode.json" },
  "nga": { "installed": false, "path": "..." }
}
```

- claude/codeagent：`loadRuntimePaths` → ~ 展开各自 dir → `isHooksInstalledFn({baseDir, settingsFilename})` → `{installed, path: settingsPath}`。
- opencode/nga：~ 展开各自 dir → `isOpencodePluginInstalledFn({baseDir})` → `{installed, path: pluginPath}`。
- 探针缺省（注入点未注入，测试外罕见）→ 返回 `{installed:false, path:'<resolved>'}` 不抛。

#### POST /api/settings/runtime/{install,uninstall}?target=

target 从 `claude|opencode` 扩成 **`claude|codeagent|opencode|nga`**；invalid → 400。

- `claude`/`codeagent`：读各自槽的 dir + settingsFilename → ~ 展开 → `doInstall`/`doUninstall`（installHooks/uninstallHooks，按各槽字段）。
- `opencode`/`nga`：读各自槽的 dir → ~ 展开 → `doInstallOpencode`/`doUninstallOpencode`（按各槽 baseDir）。opencode install 缺 source → `{ok:false, error:'…请用命令行安装'}`（沿用前作降级）。
- target 默认仍 `claude`（向后兼容）。

### 3.7 web-api client（`src/web/api.ts`）

- `RuntimeSettingsState` 改 4 槽 + defaults 形状。
- `getRuntimeSettings`/`saveRuntimeSettings` 跟随新形状；`saveRuntimeSettings` 接受 per-slot patch。
- 新增 `getRuntimeStatus(): Promise<RuntimeStatus>`（调 `GET /api/settings/runtime/status`）。
- `installRuntimeHooks`/`uninstallRuntimeHooks` 的 `target` 类型从 `'claude'|'opencode'` 扩到 `'claude'|'codeagent'|'opencode'|'nga'`。

### 3.8 runtime-paths 纯函数（`src/web/runtime-paths.ts`）

`RuntimePathDefaults` 扩成 4 槽形状：

```ts
export interface RuntimePathDefaults {
  claude: { dir: string; settingsFilename: string }
  codeagent: { dir: string; settingsFilename: string }
  opencode: { dir: string }
  nga: { dir: string }
}
```

- `resolveClaudePath(dir, filename, slotDefaults)`：空串回落对应槽默认；组合 dir + filename；反斜杠归一正斜杠（展示）。
- `resolveOpencodePath(dir, slotDefaults)`：空串回落对应槽默认；拼 `memside-opencode`；反斜杠归一。
- 仍为纯函数，便于 bun:test 直接断言，不引 React。

### 3.9 Web UI（`src/web/App.tsx`）

`RuntimeSettings` 重构成 **4 张卡片**（复用既有 `<section>` 约定 + `MemoryCard` 视觉风格，inline style）。每卡：

```
<div 卡片 claude>
  <h4> Claude Code <span>官方</span>
  <状态徽标> ✓ 已安装 / ○ 未安装   // 进入设置页 + 每次 install/uninstall 后 re-probe
  <label> 配置目录 <input dir></label>
  <label> 文件名 <input settingsFilename></label>
  <div> → 将写入：<resolvedPath></div>   // 实时纯函数预览
  <button 保存并安装> <button 卸载>
  <msg>
</div>
```

四卡：claude code（官方）、codeagent（claude-code fork）、opencode（官方）、nga（opencode fork）。

**状态与处理**：
- 进入设置页拉一次 `getRuntimeSettings`（4 槽 + defaults）+ `getRuntimeStatus`（4 槽 installed/path）。8 字段各自 `useState`。
- **状态徽标**：读 `status[<slot>].installed`，✓绿色 / ○灰色。每次 install/uninstall 后 re-probe status（调 `getRuntimeStatus` 更新徽标）——状态反映磁盘真实情况，非缓存。
- **「保存并安装」handler**（每槽）：`setBusy` → `saveRuntimeSettings({<slot>: {dir,...}})`（只存本槽字段）→ `installRuntimeHooks(target)` 读刚存的路径装 → 据 `{ok, path}` 设 msg → **re-probe status 更新徽标**。save 失败则不 install。
- **「卸载」handler**：`uninstallRuntimeHooks(target)` → msg → re-probe status。
- **resolved-path 预览**：`resolveClaudePath`/`resolveOpencodePath` 纯函数实时算。
- 每槽独立 `busy`/`msg`，互不阻塞。
- **共享路径提示**：当 opencode.dir === nga.dir（解析后）→ 两卡各显一行小字「与 nga 共享同一配置文件，安装/卸载会同时影响两者」（claude.dir+filename === codeagent.dir+filename 同理）。这是磁盘真实状态，非 bug。

## 4. 数据流

### 4.1 codeagent 用户首次配置

1. 打开设置 tab → 拉 settings（codeagent 默认 `~/.cac`/`setting.json`）+ status（codeagent `installed:false`）→ 卡片显 ○ 未安装。
2. 填/确认 `~/.cac` + `setting.json` → 预览实时显「→ 将写入：~/.cac/setting.json」。
3. 点「保存并安装」→ save 存 codeagent 槽 → `install?target=codeagent` → server 读 codeagent 槽路径装 hooks → msg「✓ 已安装」→ re-probe → 徽标变 ✓ 已安装。

### 4.2 同时用 claude code + codeagent（前作做不到，本 spec 核心价值）

前作共享槽：配 codeagent 的 `~/.cac` 会覆盖 claude 的 `~/.claude`，装 codeagent 就装不到 claude。本 spec：claude 槽装到 `~/.claude/settings.json`、codeagent 槽装到 `~/.cac/setting.json`，互不干扰，两卡各自 ✓ 已安装。

### 4.3 opencode 与 nga 路径相同

两者默认均 `~/.config/opencode`。装 opencode → 共享 `opencode.json` 里有标记 → 两卡 status 均 `installed:true`（磁盘真实）。卸载任一 → 标记移除 → 两卡均变 ○。UI 小字提示共享关系。用户若把 nga 改到别处（如 `~/.config/nga`）→ 两槽独立，各自状态独立。

### 4.4 状态探针发现漂移

daemon 重启装到了别的路径 / 用户手动删了 settings.json 里的 hook → 进入设置页 status 探针如实读磁盘 → 徽标显示真实状态（可能 ○ 未安装），不会谎称已装（修前作 §2 非目标留下的「不可见」缺陷）。

## 5. 与现有模块的耦合点

| 模块 | 改动 | 兼容性 |
|---|---|---|
| `src/settings.ts` | `RuntimePaths` 4 槽重构；`defaultRuntimePaths`/`loadRuntimePaths`/`saveRuntimePaths` 跟改；迁移启发式 | 旧 3 key 启发式归位，零丢失；新 key 优先 |
| `src/install.ts` | 新增 `isHooksInstalled`/`isOpencodePluginInstalled` 探针 | 纯增量，不动 install/uninstall |
| `src/server.ts` | AppDeps 加两探针注入点；GET 形状换代；PUT per-slot；新增 GET status；install/uninstall target 扩四值 | target 默认 claude，既有调用兼容；GET 形状 breaking 但仅 web 消费 |
| `src/daemon.ts` | 注入两探针 | 无条件注入，不依赖源，零回归 |
| `src/web/api.ts` | `RuntimeSettingsState` 4 槽；新增 `getRuntimeStatus`；target 扩四值 | web 内部 breaking，跟随 server |
| `src/web/runtime-paths.ts` | `RuntimePathDefaults` 4 槽；resolve 函数签名跟改 | 纯函数，测试跟随 |
| `src/web/App.tsx` | `RuntimeSettings` 4 卡 + 状态徽标 + re-probe | 替换双分组 UI |
| `src/cli.ts`/`src/exe/launcher.ts` | **不动**（opencodePluginSource 已在前作透传，本 spec 不碰启动时自动装） | 零改动 |

## 6. 失败模式

1. **daemon 未注入探针**（测试外罕见）→ status 端点返回 `{installed:false, path:<resolved>}` 不抛。
2. **opencode install 缺 source** → `{ok:false, error:'…请用命令行安装'}`（沿用前作降级）。
3. **用户填不存在的 dir** → installHooks `mkdirSync({recursive:true})` 自建；installOpencodePlugin 同。探针返回 `installed:false`（dir 不存在）。
4. **用户填 agent 不读的路径** → 装了但不触发。徽标显 ✓（标记确在文件里），但提示文案「请确认是 agent 实际读取的配置」提醒用户验证加载（沿用前作 §6.2，不谎称 agent 已加载）。
5. **路径含 `~`** → server 端点 `resolveHome` 展开（install/status 都展）；UI 预览原样显 `~`。沿用前作 §6.3。
6. **malformed settings.json/opencode.json** → 探针降级 `installed:false`，不抛（复刻 uninstall 的解析路径）。
7. **共享路径同时装两个** → 共享文件写一次标记，两槽 status 都 `installed:true`（磁盘真实，非 bug）。
8. **迁移启发式误判** → 旧 key 旧值（如 `~/.claude`/`settings.json` 配给 codeagent）会被归到 claude 槽（settingsFilename 非 setting.json）。若用户原本把 codeagent 配在 `~/.claude`（异常用法），归位到 claude 槽后需用户在 codeagent 卡重填——属可接受一次性纠正，非数据丢失（旧 key 不删，可恢复）。

## 7. 测试策略

CLAUDE.md 强制：代码改动带测试，纯函数层优先，运行时组件最低限度源码层文本断言兜底。

### 7.1 settings 纯函数层（`tests/settings.test.ts` 扩展）

- `defaultRuntimePaths`：四槽默认值正确（codeagent dir=`~/.cac`、settingsFilename=`setting.json`；claude settingsFilename=`settings.json`；opencode/nga dir 同）。
- `loadRuntimePaths`：四槽各自缺失回默认；脏数据原样用；`~` 展开（IF-1 回归）。
- **迁移启发式**：
  - 旧 key `claude_dir=~/.cac` + `settings_filename=setting.json` + 新 key 缺 → codeagent 槽得 `~/.cac`/`setting.json`，claude 槽取默认。
  - 旧 key `claude_dir=~/.claude` + `settings_filename=settings.json` → 归 claude 槽，codeagent 取默认。
  - 旧 key `opencode_dir=~/.config/opencode` → 归 opencode 槽，nga 取默认。
  - 新 key 已写 → 忽略旧 key（新优先）。
- `saveRuntimePaths`：per-slot 字段级合并；空串删 key 回默认。

### 7.2 install 探针层（`tests/install-status.test.ts` 新增）

`isHooksInstalled`：
- 先 installHooks 再探 → `installed:true`。
- 未装/缺文件 → `installed:false`。
- malformed settings.json → `installed:false` 不抛。
- hooks 字段存在但无 MEMSIDE_TAG（纯用户 hook）→ `installed:false`。
- `baseDir`/`settingsFilename` 显式传 tmp dir，不碰真实 `~/.claude`。

`isOpencodePluginInstalled`：
- 先 installOpencodePlugin 再探 → `installed:true`、`dirExists:true`。
- 删 destDir 但 opencode.json 仍有条目 → `installed:false`（dir 缺）、`dirExists:false`。
- opencode.json 有条目但 dir 缺 → `installed:false`。
- 缺文件/malformed → `installed:false` 不抛。
- `baseDir` 传 tmp dir。

### 7.3 server 层（`tests/settings-runtime-api.test.ts` 扩展）

- `GET /api/settings/runtime` 返回 4 槽 + defaults 形状。
- `PUT` per-slot patch（只传 claude.dir）→ 只改 claude 槽，其余不变。
- `GET /api/settings/runtime/status`：
  - 注入 fake 探针 → 返回 4 槽 `{installed, path}`；fake 收到 ~ 展开后的 baseDir。
  - 探针缺省 → `{installed:false, path:<resolved>}` 不抛。
- `install?target=codeagent` → 调 `installHooksFn` fake，传 codeagent 槽的 dir+filename；返回 `{ok, settingsPath}`。
- `uninstall?target=codeagent` → 同理。
- `install?target=nga` → 调 `installOpencodePluginFn` fake，传 nga 槽 dir。
- `install?target=claude`（默认）→ 与既有行为一致（回归锁）。
- `target=invalid` → 400。
- opencode/nga 路径含 `~` → fake 收到展开后 baseDir。

### 7.4 daemon 层（`tests/daemon-install-paths.test.ts` 扩展）

- `startDaemon({})` → `createApp` 收到 `isHooksInstalledFn`/`isOpencodePluginInstalledFn`（非 undefined）。

### 7.5 runtime-paths 纯函数（`tests/runtime-paths.test.ts` 扩展）

- `resolveClaudePath`/`resolveOpencodePath`：4 槽 defaults 形状；空串回落对应槽默认；组合路径；反斜杠归一。

### 7.6 web-api + App.tsx 兜底（源码层文本断言）

- `api.ts`：`getRuntimeStatus` 函数存在；`installRuntimeHooks`/`uninstallRuntimeHooks` target 类型含四值；`RuntimeSettingsState` 4 槽。
- `App.tsx`：`RuntimeSettings` 含 4 卡标题（Claude Code / codeagent / opencode / nga）+ 状态徽标 token（`已安装`/`未安装`）+ `getRuntimeStatus` 调用 + `resolveClaudePath`/`resolveOpencodePath` 引用。

## 8. 上线后观测（结论回填 STATE.md）

1. UI 四卡在 dev（`bun run dev:web`）+ exe 两种模式都正确渲染、字段标签清晰、预览实时、状态徽标正确反映磁盘。
2. 同时用 claude code + codeagent 的用户：两槽分别「保存并安装」后，`~/.claude/settings.json` 与 `~/.cac/setting.json` 各自含 hooks，两 agent 都触发 capture（daemon SessionStart/Stop 日志）。
3. opencode + nga 路径相同时：装一个两卡都显 ✓；路径不同时各自独立。
4. daemon 重启 / 手动改文件后，进入设置页徽标如实反映真实状态（不谎称已装）。
5. 迁移：老库（旧 3 共享 key）升级后，旧 codeagent 配置（`~/.cac`/`setting.json`）正确归位到 codeagent 槽，非丢失。

## 9. deferred（follow-up，非本 spec）

1. 验证 agent 进程是否真加载该配置（需 agent 侧配合，YAGNI；探针只验标记在文件里）。
2. 多 profile（同一 agent 多套配置）——四槽 + 默认兜底，YAGNI。
3. opencode/nga 自定义文件名——plugin 型安装结构固定，无需。
