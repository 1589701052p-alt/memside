# 运行环境自定义路径配置 设计 spec

日期：2026-08-17
状态：待批准
关联：STATE.md「codeagent 桥接遗留 (2026-07-23)」第 5 点——hooks 兼容性决定产品能否闭环；本次商用适配落地该债务点。补 `install.ts` 硬编码 `~/.claude` / `settings.json` 无法适配公司内部 fork（codeagent 读 `~/.cac/setting.json`）的缺口。

## 1. 背景

memside 即将商用，主要用户是公司内部基于 claude code / opencode 改造的两个 agent：**codeagent**（claude code fork）与 **nga**（opencode fork）。

用户反馈两个关键事实：

1. **「没有 API」** = codeagent/nga 不暴露公司鉴权端点，用户需自己在 Web UI 里配部门给的 API（token / baseURL / model / protocol）。
2. **hook/plugin 协议相同，仅路径不同**：codeagent 是 claude code fork，原样保留 SessionStart/Stop/PostToolUse/SubagentStop 钩子与 `additionalContext` envelope，但配置文件在 `~/.cac/setting.json`（注意：目录 `.cac`、文件名 `setting.json` 单数，与 `~/.claude/settings.json` **双双不同**）。nga 走标准 opencode 路径，无需适配。

### 1.1 商用阻塞链

memside 的核心闭环是 capture → distill → approve → inject。capture 与 inject **都依赖 hook 安装**：

- `installHooks`（`src/install.ts:109`）把 5 个 hook 命令写入 `~/.claude/settings.json`。
- codeagent 读 `~/.cac/setting.json`，看不到 memside 写的 hooks → SessionStart/Stop 钩子不触发 → **capture 抓不到 transcript、inject 注不进新会话 → 整个闭环断**。

这是 STATE.md 2026-07-23 标记的「决定产品能否闭环、优先级高于其他」的债务点。在商用前必须解。

### 1.2 已覆盖部分（本次不动）

- **LLM 凭证 / distill 后端**：现有「设置」tab 的 `LlmSettings` 区块已支持 UI 级整级短路（token 非空整级生效，优先级最高，见 `creds.ts:134` + `settings.ts`）。codeagent/nga 用户在 UI 配部门 API 即可，distiller 走 Anthropic/OpenAI SDK 直连。`creds.ts` 的 `~/.claude/settings.json` fallback 对 codeagent 是无害空操作（文件不存在 → 降级）。**本次不碰 creds.ts / distiller / adapter / scheduler**。
- **opencode (nga) 安装**：`installOpencodePlugin`（`src/install.ts:185`）默认 `~/.config/opencode`，nga 走标准路径，**无需改动**。本次只适配 claude 侧（codeagent）路径。
- **capture / inject 适配器**：codeagent 是 claude code fork，hook payload 与 transcript 格式同源，`ClaudeCodeAdapter` + `parseTranscriptFile` 逐字可用。

## 2. 目标 / 非目标

### 目标

1. 用户在 Web UI「设置」tab 配置 claude 配置目录与 settings 文件名，memside 据此把 hooks 装到正确路径（如 codeagent 的 `~/.cac/setting.json`）。
2. UI 一键「安装 hooks」按当前配置路径写盘；一键「卸载 hooks」移除 memside-managed hook 条目（保留用户自写 hook）。
3. `startDaemon`（含 exe launcher）与 `memside install` CLI 启动时读已存配置，装到用户配的路径；**首次启动未配置 → 走默认 `~/.claude` / `settings.json`，零回归**。
4. 路径配置即时生效：改路径 → 点安装即可，不需重启 daemon。

### 非目标

- 不动 LLM 凭证链 / distiller / adapter / scheduler（已覆盖）。
- 不动 opencode 安装（nga 标准路径）。
- 不做路径「自动探测」（codeagent 读哪个路径无法可靠探测，靠用户填）。
- 不多 runtime profile（不存「codeagent 路径 + claude 路径」并存切换；单组配置 + 默认值兜底，用户要切就改字段）。
- 不做 hook 状态自检（「hooks 是否真的装上了 / agent 是否在读」无法从 daemon 侧可靠验证，属 YAGNI；UI 安装成功消息只如实说「已写入 <path>」）。

## 3. 接口契约

### 3.1 配置数据模型（`src/settings.ts`）

新增 `RuntimePaths`：

```ts
export interface RuntimePaths {
  /** claude 配置目录，默认 ~/.claude。空串=回默认。 */
  claudeDir: string
  /** claude settings 文件名，默认 'settings.json'。空串=回默认。 */
  settingsFilename: string
  /** opencode 配置目录，默认 ~/.config/opencode（nga 标准路径）。空串=回默认。 */
  opencodeDir: string
}
```

落 `app_settings` 表三个 key：`runtime.claude_dir` / `runtime.settings_filename` / `runtime.opencode_dir`。

**读取** `loadRuntimePaths(db): RuntimePaths`：缺失/空串逐字段回默认值。默认值复用 `creds.ts` / `install.ts` 既有的 `resolveHome()` 逻辑（`~/.claude` / `~/.config/opencode`），保证与现有默认行为一致。

**保存** `saveRuntimePaths(db, patch: Partial<RuntimePaths>): void`：字段级合并写（同 `saveUiLlmConfig` 模式：提供才写，空串删 key 回默认）。

### 3.2 install 接口扩展（`src/install.ts`）

`InstallOpts` 新增可选字段：

```ts
export interface InstallOpts {
  port: number
  baseDir?: string       // 已有：~/.claude 测试旁路
  settingsFilename?: string  // 新增：settings.json / setting.json
}
```

`installHooks` 内：

```ts
const claudeDir = opts.baseDir ?? join(resolveHome(), '.claude')
const settingsPath = join(claudeDir, opts.settingsFilename ?? 'settings.json')
```

**默认值与旧调用逐字节一致**（baseDir 默认 `~/.claude`、文件名默认 `settings.json`）——既有的 `startDaemon` / CLI 调用不传 settingsFilename 时行为不变。idempotent-merge 逻辑逐字不动。

### 3.3 uninstall 接口（`src/install.ts`，新增）

```ts
export function uninstallHooks(opts: { baseDir?: string; settingsFilename?: string }): { removed: number; settingsPath: string }
```

逻辑：复用 `installHooks` 同款 settings.json 读取/解析/写回框架；遍历 5 个 EVENTS，对每个 event 的 groups 用与 install 相同的 `MEMSIDE_TAG` marker 过滤**移除** memside-managed 组（`groups.filter(g => !cmds.includes(MEMSIDE_TAG))`，install 是「先 filter 掉再 push」，uninstall 是「只 filter 掉不 push」）。用户自写 hook（无 marker）保留。统计 `removed` = 各 event 移除的组数之和。文件不存在 → `removed:0`，不抛。

### 3.4 daemon 启动安装（`src/daemon.ts`）

`startDaemon(opts)` 在 `opts.installClaudeHooks` 为 true 时：

```ts
if (opts.installClaudeHooks) {
  const rp = loadRuntimePaths(db)  // 存储异常降级默认（见失败模式）
  installHooks({ port, baseDir: rp.claudeDir, settingsFilename: rp.settingsFilename })
}
```

存储读取异常 try/catch 降级默认路径（`installHooks({ port })`），不阻塞启动——与全项目「存储异常降级」一致。

### 3.5 CLI 透传（`src/cli.ts`）

`install` / `start-and-install` 命令打开 db（默认路径 `~/.memside/memside.db`）读 `loadRuntimePaths`，透传给 `installHooks`。

**注意**：CLI 当前为纯函数同步模块（顶层 `if/else` 分支），打开 db 需 `openDb`，与现有 CLI 风格一致（CLI 已 `await startDaemon`）。db 不存在时 `openDb` 会自建，读 `app_settings` 返回空 → `loadRuntimePaths` 全默认，与「未配置」语义一致。

### 3.6 server 端点（`src/server.ts`）

```
GET  /api/settings/runtime          -> { claudeDir, settingsFilename, opencodeDir, defaults: {...} }
PUT  /api/settings/runtime          -> 字段级保存，返回更新后状态
POST /api/settings/runtime/install  -> 读已存路径 -> installHooks -> { ok, settingsPath }
POST /api/settings/runtime/uninstall -> 读已存路径 -> uninstallHooks -> { ok, removed, settingsPath }
```

- `GET` 回当前生效路径 + 默认值对照（UI 显示「当前 / 默认」）。
- `PUT` 字段级校验：字符串类型；空串=回默认（删 key）。**禁止路径越界检查 YAGNI**（用户可能就是要写 `/etc/...`，但实践中是 `~/.cac`，加校验反而挡路）；只校验类型。
- `POST install`：读 `loadRuntimePaths` → `installHooks({ port, baseDir, settingsFilename })` → 成功 `{ ok:true, settingsPath }`；install 抛错（IO）→ `{ ok:false, error: msg }`（HTTP 200，业务结果）。
- `POST uninstall`：同理，返回 `{ ok, removed, settingsPath }`。

### 3.7 Web UI（`src/web/App.tsx` + `api.ts`）

设置 tab 挂载点追加 `<RuntimeSettings />` section（第三个，在 `LlmSettings` / `JudgeSettings` 后），复用既有 section 约定（`<section>` + `<h3>` + 自管理 fetch/保存/错误行）：

- 三个路径输入框（claude 目录 / settings 文件名 / opencode 目录），各带默认值 placeholder + 说明。
- 「保存」按钮 → `PUT /api/settings/runtime`。
- 「安装 hooks」按钮 → `POST /api/settings/runtime/install`，显示结果（「已写入 <path>」或错误横幅）。
- 「卸载 hooks」按钮 → `POST /api/settings/runtime/uninstall`，显示结果（「已移除 N 个 hook 组」或错误横幅）。
- 说明文案：明确「请确认此路径是你所用 agent 实际读取的配置文件」（codeagent 用户填 `~/.cac` + `setting.json`）。
- `api.ts` 加 `getRuntimeSettings` / `saveRuntimeSettings` / `installRuntimeHooks` / `uninstallRuntimeHooks` wrapper。

## 4. 数据流

### 4.1 首次配置闭环（codeagent 用户）

1. 用户装 memside exe，双击启动（launcher 调 `startDaemon(installClaudeHooks:true)`，此时 db 无配置 → 装到默认 `~/.claude/settings.json`，对 codeagent 无效但不报错）。
2. 用户打开 Web UI 设置 tab，在 `RuntimeSettings` 填 claude 目录 `~/.cac`、文件名 `setting.json`，点「保存」。
3. 用户点「安装 hooks」→ server 读配置 → `installHooks` 写入 `~/.cac/setting.json` → codeagent 读到 hooks → **闭环通**。
4. 下次 codeagent 会话 SessionStart → inject 记忆；Stop → capture transcript。

### 4.2 daemon 重启后

launcher/CLI 启动时读 `loadRuntimePaths` → 装到 `~/.cac/setting.json`（用户已配的路径）。无需用户再次点「安装」。

### 4.3 卸载

用户点「卸载 hooks」→ server `uninstallHooks` 移除 `~/.cac/setting.json` 里的 memside-managed 组 → codeagent 不再触发 memside hooks。daemon 进程不动（继续跑，只是不再接管该 agent 的新会话）。用户后续改路径 + 点「安装」可重新接管。

## 5. 与现有模块的耦合点

| 模块 | 改动 | 兼容性 |
|---|---|---|
| `src/settings.ts` | 新增 `RuntimePaths` + load/save | 纯增量，不动既有 `UiLlmConfig` / `JudgeConfig` |
| `src/install.ts` | `InstallOpts` 加 `settingsFilename`；新增 `uninstallHooks` | 默认值逐字节兼容旧调用 |
| `src/daemon.ts` | `startDaemon` 读 `loadRuntimePaths` 透传 | 存储异常降级默认，零回归 |
| `src/cli.ts` | `install`/`start-and-install` 读 db 透传 | db 不存在自建，读空全默认 |
| `src/server.ts` | 4 个 `/api/settings/runtime*` 端点 | 纯增量路由 |
| `src/web/App.tsx` | `RuntimeSettings` section + 挂载点 | 复用既有 section 约定 |
| `src/web/api.ts` | 4 个 wrapper | 纯增量 |
| `src/exe/launcher.ts` | 无直接改动（经 `startDaemon` 透传） | 不动 |

## 6. 失败模式

1. **用户填不存在的目录** → `installHooks` 已 `mkdirSync({recursive:true})` 自建，不抛。
2. **用户填 codeagent 不读的路径** → hooks 装了但 agent 不触发。UI 安装成功消息只如实说「已写入 <path>」+ section 说明文案「请确认此路径是 agent 实际读取的配置文件」，不谎称「已生效」。
3. **路径含 `~`** → `installHooks` 用 `resolveHome()` 处理 baseDir；UI 输入若含 `~`，server 侧 `saveRuntimePaths` 原样存（`resolveHome` 在 install 时展开）。或 UI 文案提示用绝对路径。**决策**：install 端 `resolveHome` 已存在且 `loadRuntimePaths` 默认值用 `resolveHome()`，存原始字符串（可能含 `~`）在 install 时再 `resolveHome`——但 `installHooks` 的 baseDir 是绝对路径覆盖，不调 `resolveHome`。所以 **UI 输入需是绝对路径或已在 install 前 resolve**。简化：`saveRuntimePaths` 存原值；`install` 端点读出后若以 `~` 开头则 `resolveHome` 展开。最小改动 + 文案提示。
4. **db 读路径异常** → `startDaemon` / CLI try/catch 降级默认路径，不阻塞启动。
5. **malformed settings.json** → install/uninstall 都已「malformed → 视为空文档」降级，install 会写全新文档、uninstall 返回 `removed:0` 不抛。
6. **opencodeDir 配错** → 本次 UI「安装/卸载」按钮**只管 claude hooks**（opencode 安装走 CLI/launcher，因 daemon 进程内取 opencode-plugin 源资产复杂）。`opencodeDir` 字段存了但本次 install/uninstall 端点不用它，仅为未来统一预留。**文案注明**：opencode 路径本次仅记录，安装仍走 CLI。

## 7. 测试策略

CLAUDE.md 强制：代码改动带测试，纯函数层优先，运行时组件最低限度源码层文本断言兜底。

### 7.1 纯函数层

- `loadRuntimePaths` / `saveRuntimePaths`（新建 `tests/settings-runtime.test.ts`）：
  - 缺失三字段 → 全默认值（锁默认 = `~/.claude` / `settings.json` / `~/.config/opencode`）。
  - 字段级合并（部分提供）。
  - 空串 = 回默认（删 key）。
  - 脏数据（非字符串）→ 回默认，不抛。

### 7.2 install 层

- `installHooks` 加 `settingsFilename`（`tests/install.test.ts` 扩展）：
  - 传 `settingsFilename: 'setting.json'` → 写到 `join(baseDir, 'setting.json')`（断言文件存在 + 内容含 MEMSIDE_TAG）。
  - 不传 → 与旧行为逐字节一致（`settings.json`，回归锁）。
- `uninstallHooks`（新建或扩展 `tests/install.test.ts`）：
  - 先 install 再 uninstall → memside-managed 组消失，用户自写 hook（无 marker）保留。
  - 文件不存在 → `removed:0` 不抛。
  - malformed settings.json → `removed:0` 不抛。
  - 重复 uninstall（已无 marker）→ `removed:0` 幂等。

### 7.3 server 层

- `GET /api/settings/runtime` 回当前 + 默认。
- `PUT` 字段级保存 + 类型校验（非字符串 400）。
- `POST install`：tmp baseDir 断言文件落地到自定义路径 + 成功响应；install 抛错模拟 → `{ok:false,error}`。
- `POST uninstall`：install 后 uninstall 断言 `removed>0` + 文件中 marker 消失。

### 7.4 web-api 层

- 4 个 wrapper 形状断言（源码层文本兜底，与既有 web 测试同模式）。

### 7.5 App.tsx 运行时兜底

- 源码层文本断言锁 `RuntimeSettings` section 挂载点 + 安装/卸载按钮存在（CLAUDE.md 运行时组件最低面）。

## 8. 上线后观测（硬要求，结论回填 STATE.md）

1. codeagent 用户配置 `~/.cac/setting.json` 后，hook 是否真的触发（daemon 侧 SessionStart/Stop 日志 + 新 distill job 出现）。
2. codeagent 闭环是否端到端跑通（capture → distill → approve → inject），参考 2026-07-31 opencode live smoke 模式。
3. 「卸载 hooks」后 codeagent 是否停止触发 memside（无新 capture）。
4. 部门 API（UI 配 LlmSettings）在 codeagent 环境是否 distill 成功（与 claude code 环境对照）。

## 9. 非阻塞 deferred（建议 follow-up）

1. opencodeDir 字段本次存而不用；未来若 opencode 安装也搬进 UI 按钮，复用该字段 + `installOpencodePlugin` 的 `baseDir` 旁路。
2. 多 runtime profile 切换（若用户同时用 codeagent + 原版 claude code，需两组路径）——本次单组 + 默认兜底，YAGNI。
3. hook 状态自检（「agent 是否真的在读这个文件」）——无法可靠验证，YAGNI。
4. `settingsFilename` 是否需要支持相对路径或子目录（如 `~/.cac/sub/setting.json`）——本次 join(claudeDir, filename) 已天然支持子目录字符串，但未专测。
