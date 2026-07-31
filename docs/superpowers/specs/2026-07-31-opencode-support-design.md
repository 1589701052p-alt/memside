# opencode 支持（opencode runtime adapter）

## 背景

memside 现仅支持 claude code：capture 靠 `~/.claude/settings.json` 的四个 hook
（SessionStart / Stop / PostToolUse / SubagentStop）curl POST 到 daemon；inject 靠
SessionStart hook 返回 `hookSpecificOutput.additionalContext` envelope。opencode adapter
（`src/adapter/opencode.ts`）是 MVP stub——`capture()` 返回 `[]`、`inject()` 返回 `null`，
README「已知限制」明列。

本需求把 opencode 接入完整 `capture -> distill -> approve -> inject` 闭环。本机已装
opencode 1.15.5（npm 全局），配置 `~/.config/opencode/opencode.json`（已挂 superpowers
plugin + huoshan/glm-5.2 provider），是真实使用场景。

### opencode 扩展模型（已读源码验证，非记忆）

opencode 的扩展机制与 claude code 不同：**plugin 是 in-process JS 模块**，不是外部 hook
进程。验证依据：

- **plugin SDK**（`~/.config/opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts`）：
  plugin 是 `(input: PluginInput, options?) => Promise<Hooks>`。`PluginInput` 带
  `client: ReturnType<typeof createOpencodeClient>`、`project`、`directory`、`worktree`、
  `serverUrl`、`$`(BunShell)。
- **Hooks 体系**（同文件 `Hooks` 接口）关键钩子：
  - `event?: ({event: Event}) => Promise<void>` —— 通用事件订阅（含 `session.idle` 等）。
  - `"experimental.chat.messages.transform"?: (input, output: {messages: {info: Message, parts: Part[]}[]}) => Promise<void>` —— 修改发给 LLM 的消息数组。**注入用这个**。
  - `chat.message` —— 新消息收到时触发（带 message+parts）。
  - `tool.execute.after?: (input: {tool, sessionID, callID, args}, output: {title, output, metadata})` —— 工具执行后。**错误信号用这个**。
- **加载方式**：`opencode.json` 的 `plugin?: Array<string>`（`types.gen.d.ts:1067`）声明，
  支持 git URL 与**本地路径**。superpowers 实证本地路径可行
  （`docs/README.opencode.md:144`：`"plugin": ["~/.config/opencode/node_modules/superpowers"]`）。
  `~/.config/opencode/plugins/` 目录**无自动扫描**（本机不存在该目录），必须走 `plugin` 数组声明。
- **SDK client 拉 session 消息**：`OpencodeClient.session.messages({sessionID})`
  （`~/.config/opencode/node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.d.ts:170`）返回
  session 全部消息——capture 拉全量可行。
- **消息模型**（`types.gen.d.ts`）：`Message = UserMessage | AssistantMessage`（`:128`），
  每条带 `info`(含 `role`) + `parts: Part[]`。`Part = TextPart | subtask | ReasoningPart |
  FilePart | ToolPart | StepStartPart | StepFinishPart | SnapshotPart | PatchPart | AgentPart
  | RetryPart | CompactionPart`（`:345`）。`TextPart = {type:"text", text, ...}`。
- **事件模型**：`session.created/updated/idle/status/error`、`message.updated`、
  `message.part.updated` 等（`types.gen.d.ts`）。**没有 claude code 的 Stop（会话结束）事件**，
  最接近的是 `session.idle`（agent 每轮响应完）。
- **superpowers 实战踩坑记录**（`RELEASE-NOTES.md`）——注入钩子演进：`session.prompt({noReply})`
  有副作用（重置 agent）弃用 → `experimental.chat.system.transform` 有 token 膨胀 + Qwen 多
  system 兼容问题 → **最终 `experimental.chat.messages.transform`（prepend 首条 user message）**。
  该钩子在 agent loop 每步触发（opencode 每步从 DB 重载消息），需缓存 + 幂等守卫。

### 三个已确认决策（brainstorming 阶段用户拍板）

1. **完整闭环**：capture + distill + approve + inject 全做，不分阶段。
2. **project 记忆跨 runtime 共享**：同 cwd 下 claude code 与 opencode 产出的 project 记忆
   互相注入；`runtime` 字段仅作来源标记，不影响注入匹配。
3. **本地 plugin 文件**：memside 仓库自带 plugin，`memside install` 复制 + 改 opencode.json，
   对齐 claude code「一条命令装好」，避开 Windows git+https plugin 上游坑。
4. **capture 触发**：`session.idle` 事件 + SDK client 拉全量消息（对齐 claude code Stop 模型，
   plugin 无状态，daemon 复用现有 offset/debounce）。

## 目标 / 非目标

**目标**

- opencode 会话被捕获（`session.idle` 拉全量 transcript）、提炼成候选记忆、Web UI 审批后
  注入回 opencode 新会话（`messages.transform` prepend 首条 user message）。
- opencode 工具失败（`tool.execute.after`）产出 `sourceKind:'error'` 候选，对齐 claude code
  PostToolUse `is_error`。
- project 记忆跨 runtime 共享：`listApprovedByScope` 去掉 runtime 过滤，claude code 与
  opencode 在同 cwd 互相注入 project 记忆；global 记忆本就全共享。
- 一条命令装好 opencode plugin：`memside install` / `start-and-install` 额外复制 plugin
  到 `~/.config/opencode/memside-opencode/` + 幂等合并 opencode.json `plugin` 数组。
- 复用现有 distill / store / scheduler / valueFilter / dedup / Web UI 管线，不改核心。

**非目标**

- 不改 distiller / valueFilter / dedup / store 核心 / Web UI 审批 UI。
- 不做 opencode 会话的实时 WS 推送（Web UI 仍轮询）。
- 不改 claude code 现有 hook 安装逻辑（`installHooks` 不动）；仅改 inject 查询的 runtime
  过滤（跨 runtime 共享的必然结果，claude code inject 同步受益）。
- 不发布 npm 包（本地 plugin 文件分发）。
- 不接 opencode 的 subagent / task 分支捕获（claude code 的 SubagentStop 对应物留后续）。
- 不做 opencode TUI 内的审批入口（审批仍走 memside Web UI）。

## 接口契约

### 1. opencode plugin（仓库新增 `opencode-plugin/`）

目录结构（打成 npm 包格式，满足 opencode plugin 加载）：

```
opencode-plugin/
  package.json   # { "name": "memside-opencode", "version", "main": "memside.js", "type": "module" }
  memside.js     # plugin 实现，export default async ({client, project, directory}) => Hooks
```

`memside.js` 导出 plugin 函数，返回三个钩子：

| 钩子 | 行为 |
|---|---|
| `event` | 过滤 `event.type === 'session.idle'`；从 `event.properties` 取 `sessionID`；cwd 用 plugin 闭包的 `directory`（PluginInput 字段）；调 `client.session.messages({sessionID})` 拉全部消息 → `fetch POST http://127.0.0.1:<port>/hooks/opencode/capture` body `{sessionId, cwd, messages, sourceEventId}`（原始 opencode 消息，daemon 侧 `parseOpencodeMessages` 转换--plugin 独立 JS 不能 import `src/`）。best-effort：catch 一切错误静默，不抛回 opencode。 |
| `experimental.chat.messages.transform` | 取 `directory` 作 cwd → `fetch GET http://127.0.0.1:<port>/hooks/opencode/inject?cwd=<cwd>` 拿 `{block}`；`block` 非空时 prepend 到 `output.messages` 首条 `role==='user'` 消息的 `parts` 前（`{type:'text', text:block}`）。**幂等守卫**：首条 user message 已含 `--- BEGIN INJECTED MEMORY ---` 标记则跳过（对齐 superpowers + 复用 `formatMemoryBlock` 既有标记）。 |
| `tool.execute.after` | 检测 `output.output`/`metadata` 含错误信号 → `fetch POST /hooks/opencode/error` body `{sessionId, cwd, tool, output}`。错误判定见「验证缺口」。 |

网络约定：plugin 跑在 opencode 进程，fetch `127.0.0.1`。Bun `fetch` **不默认尊重
`HTTP_PROXY`/`HTTPS_PROXY`** env（与 curl 不同），故 loopback 调用不受系统代理拦截，无需
`--noproxy`（与 claude code hook 的 curl 路径不同，实现阶段验证确认）。fetch 设短超时
（2s），daemon 不在时静默失败，不阻塞 opencode 会话。

端口：plugin 需知 daemon 端口。**env 优先、烘焙值回退**：plugin 内
`const port = process.env.MEMSIDE_PORT || __MEMSIDE_PORT__`（`__MEMSIDE_PORT__` 是 install 生成
`memside.js` 时替换的占位，默认 7777）。这样 `MEMSIDE_PORT` 改 daemon 端口后 opencode 进程继承
同一 env 即可连上，未设 env 时回退 install 期烘焙值（与 claude code `hookCommand(port)` 同为
install 期烘焙，但 opencode 多一层 env 覆盖更稳健）。

### 2. daemon 新路由（`src/server.ts`）

镜像 claude code 的 `/hooks/claude/:event`，新增 opencode 专用路由（不复用 claude 路径，
因 payload 结构不同——opencode 给原始 `messages`，claude 给 `transcript_path`）：

- `POST /hooks/opencode/capture`：body `{sessionId, cwd, messages: OpencodeMessage[], sourceEventId?}`。
  `parseOpencodeMessages(messages)` 转 `TranscriptTurn[]` -> `enqueueDistillJob({runtime:'opencode',
  cwd, debounceKey:sessionId, sessionId})` + 写 `memory_distill_events` 行（payload=turns JSON，
  对齐 claude Stop 路由 `server.ts:216-230`）-> 返回 `202 {ok:true}`。fire-and-forget。
  **不调 `adapter.pushCapture`**--in-memory 队列无 consumer（`server.ts:199-203`），真实数据走
  DB events 表，scheduler `loadTranscript` 读取。
- `POST /hooks/opencode/error`：body `{sessionId, cwd, tool, output}`。错误 output 包成 error
  `TranscriptTurn`（`isError:true`）-> `enqueueDistillJob({runtime:'opencode', cwd,
  debounceKey:sessionId, sourceKind:'error'})` + 写 events 行 -> `202`（对齐 capture 路径，
  不走 adapter 队列）。
- `GET /hooks/opencode/inject?cwd=`：调 `adapter.inject({cwd})` -> 返回 `{block}`（block 可 null）。
  也接受 `POST`（与 `/inject` 一致语义），plugin 用 GET。

### 3. OpencodeAdapter（`src/adapter/opencode.ts`，替换 stub）

对齐 `ClaudeCodeAdapter` 结构：`pushCapture`/`capture`（留单测；真实 capture 走 DB 不经队列，
见 `server.ts:199-203`）+ `inject`（核心）。

```ts
export class OpencodeAdapter implements RuntimeAdapter {
  readonly kind = 'opencode' as const
  private queue: CaptureEvent[] = []
  constructor(private db?: DbClient) {}
  pushCapture(event: CaptureEvent): void { this.queue.push(event) }
  async capture(): Promise<CaptureEvent[]> { const out = this.queue; this.queue = []; return out }
  async inject(input: InjectInput): Promise<string | null> {
    if (!this.db) return null
    try {
      const set = await listApprovedByScope(this.db, { projectId: input.cwd })  // 不传 runtime
      return formatMemoryBlock(set)
    } catch { return null }  // injection 不抛给调用方
  }
}
```

`daemon.ts` 实例化 `ClaudeCodeAdapter` + `OpencodeAdapter`（各持 db），按 runtime 传给 server
（`/hooks/claude/SessionStart` 调 claude adapter.inject，`/hooks/opencode/inject` 调 opencode
adapter.inject）。**scheduler 不 drain adapter**--capture 数据走 DB events 表
（`enqueueDistillJob` + `memory_distill_events`），`adapter.capture()` 无 consumer（与 claude code
既有模式一致，`server.ts:199-203`）。server 接口从单 `adapter` 改为按 runtime 路由（两个具名
adapter 或 `adapters: {claude, opencode}` map）。

### 4. transcript 转换（新增 `src/opencode/transcript.ts`）

纯函数 `parseOpencodeMessages(messages: {info: {role}, parts: Part[]}[]): TranscriptTurn[]`：

- `role==='user'` 的 `TextPart` → `{role:'user', text}`
- `role==='assistant'` 的 `TextPart` → `{role:'assistant', text}`
- `ToolPart` → 按 `callID` 配对 `tool_use`/`tool_result`（复用 `parseTranscriptFile` 的配对
  思路，`src/claude/transcript.ts`）；tool result 的 error 标记映射到 `is_error`
- `ReasoningPart`/`subtask`/`StepStartPart`/`StepFinishPart`/`PatchPart`/`SnapshotPart`/
  `AgentPart`/`RetryPart`/`CompactionPart` → 过滤（不进 TranscriptTurn，对齐
  `filterTranscriptForDistill` 只保留 user/assistant text + tool I/O 的语义）
- 输出复用 `TranscriptTurn` 类型，随后由现有 `filterTranscriptForDistill`（`src/memory/pure.ts`）
  统一预算裁剪 / 占位 / cap——opencode 与 claude code 走同一过滤管线。

### 5. inject 跨 runtime 共享（`src/memory/store.ts`）

`listApprovedByScope` 改动：

- **去掉 `filterRuntime`**（`store.ts:134`）与 `runtime` 参数（`store.ts:126`）。project 查询
  仅 `scopeType='project' AND scopeId=projectId AND status='approved'`；global 查询仅
  `scopeType='global' AND status='approved'`。
- `runtime` 列在 `memories` 表保留（来源标记，`createCandidate` 写入时仍记），仅不再参与
  注入匹配。
- 调用方 `claudeCode.ts:38` 与 `opencode.ts` 同步去掉 `runtime:` 实参。
- **行为变更（符合决策 2）**：claude code 会话现会注入 opencode 产出的同 cwd project 记忆，
  反之亦然。老记忆（`runtime=null`）行为不变（本就全共享）。

### 6. install 扩展（`src/install.ts`）

新增 `installOpencodePlugin(opts: {port: number; baseDir?: string; pluginSrcDir?: string})`：

- `pluginSrcDir` 默认指向仓库 `opencode-plugin/`（CLI 传 `path.join(repoRoot, 'opencode-plugin')`）。
- 目标目录 `~/.config/opencode/memside-opencode/`（`baseDir` 可覆盖 → `~/.config/opencode/`），
  递归复制 `package.json` + 生成 `memside.js`（端口占位 `__MEMSIDE_PORT__` 替换为 `opts.port`）。
- 幂等合并 `~/.config/opencode/opencode.json` 的 `plugin` 数组：filter 掉含 `memside-opencode`
  标记的旧条目（路径特征识别，对齐 claude code `x-memside-tag` 思路但用路径子串——opencode
  plugin 条目是纯字符串无 header 位），再 push 新路径（绝对路径，避免 `~` 展开差异）。保留
  用户既有 plugin 条目（superpowers 等）。malformed opencode.json 当空文档处理（不抛）。
- `installHooks`（claude）保持不变。CLI `install` / `start-and-install` 串调
  `installHooks` + `installOpencodePlugin`，各自独立成功/失败报告（一个失败不阻塞另一个）。

### 7. CLI（`src/cli.ts`）

`install` / `start-and-install` 增加_opencode plugin 安装步骤 + 友好输出（claude hooks ✓ /
opencode plugin ✓）。`start`（仅 daemon）不变——daemon 自动服务两个 runtime 的路由。

## 数据流

**capture**：opencode 会话 → agent 响应完 → `session.idle` event → plugin `event` 钩子 →
`client.session.messages(sessionID)` 拉全量 → `parseOpencodeMessages` → `POST /hooks/opencode/capture`
→ `enqueueDistillJob` + 写 `memory_distill_events`（payload=turns）→ scheduler tick
`loadTranscript` 按 `debounceKey=sessionId` + 现有 session offset 只蒸馏新增 turns → distill → 候选记忆（`runtime='opencode'`）→ Web UI 审批。

**inject**：opencode 新会话发首条消息 → `messages.transform` 钩子触发 → `GET /hooks/opencode/inject?cwd=`
→ `OpencodeAdapter.inject` → `listApprovedByScope`(跨 runtime) → `formatMemoryBlock` →
`{block}` → plugin prepend 到首条 user message（幂等）→ opencode 把 block 喂给 LLM。

**error**：opencode 工具执行 → `tool.execute.after` 钩子 → 检测错误 → `POST /hooks/opencode/error`
→ `enqueueDistillJob(sourceKind:'error')` + 写 events → 蒸馏成 `[category:anti-pattern]` 候选（复用现有 error 路径）。

## 与现有模块耦合点

- `src/adapter/types.ts`：`RuntimeKind` 已含 `'opencode'`；`CaptureEvent.runtime` 复用。`InjectInput`
  不变。
- `src/daemon.ts`：实例化 claude + opencode adapter（各持 db）for inject，按 runtime 传 server。
  **scheduler 不 drain adapter**（capture 走 DB events 表）。`makeLoadTranscript`（claude transcript
  加载）opencode 不用（plugin POST 原始 messages，daemon 侧 `parseOpencodeMessages` 转）。
- `src/scheduler.ts`：**不改**。`tick` 从 `memory_distill_events` 表 loadTranscript（opencode
  capture 也写该表），session offset 机制复用（`debounceKey=sessionId`）。`sourceKind='subagent'` 不动。
- `src/memory/store.ts`：`listApprovedByScope` 去 runtime 过滤（破坏性签名变更，调用方同步）。
- `src/memory/pure.ts`：`filterTranscriptForDistill` / `formatMemoryBlock` / `TranscriptTurn`
  复用，不改。
- `src/server.ts`：新增 3 个 opencode 路由，注册在静态托管前。
- `src/install.ts`：新增 `installOpencodePlugin`，`MEMSIDE_TAG` 不复用（opencode plugin 条目
  无 header 位，用路径子串标记）。
- `src/cli.ts`：install 流程加 opencode 步骤。
- Web UI：无改动（候选记忆带 `runtime='opencode'`，现有 `sourceLabel` 需加 `'opencode'` 标签
  —— minor，对齐 STATE.md 既知 follow-up 模式）。

## 失败模式 / 验证缺口

**失败模式（已设计应对）**

1. **daemon 不在跑**：plugin fetch 超时/连接拒绝 → 静默 catch，capture 丢这次、inject 不注入，
   opencode 会话不受影响（钩子 best-effort，对齐 claude code hook 2s 超时语义）。
2. **`session.idle` 频繁触发**：daemon 现有 5s debounce + session offset 只蒸馏新增，去重。
3. **plugin 加载失败 / `--pure` 模式**：opencode 会话照常，memside 不在（inject 缺失但不崩）。
4. **opencode.json 幂等**：重复 install 用路径子串标记识别旧条目替换，不重复 append。
5. **跨 runtime 行为变更**：claude code 现注入 opencode project 记忆——预期，非回归。
6. **注入幂等**：`messages.transform` 每步触发，靠 `--- BEGIN INJECTED MEMORY ---` 标记跳过
   已注入，避免重复 prepend。
7. **messages.transform 改 output 风险**：仅 unshift 一个 text part 到首条 user parts，不改
   消息结构/顺序，对齐 superpowers 实证用法。

**验证缺口（实现阶段对照真实 opencode 运行验证，不靠记忆）**

1. **opencode 1.15.5 接受本地目录路径 plugin**（非 git URL）：superpowers README 实证
   `~/.config/opencode/node_modules/superpowers` 可行，但 memside 自带 `opencode-plugin/`
   目录需实测 `opencode run` 能加载（package.json main 指向 memside.js）。
2. **`session.idle` 事件 payload**：`event.properties` 是否带 `sessionID` + 可推 cwd 的字段；
   若不带 cwd，退回用 `directory`（PluginInput）或 `project.path`。
3. **`client.session.messages` 返回结构**：确认是 `{info, parts}[]` 且 role 在 `info.role`。
4. **`tool.execute.after` 错误判定字段**：`output.output` / `metadata.error` / tool 退出码——
   对照真实失败 tool result 确定判定启发式（精度优先，对齐 `detectTaming` 思路）。
5. **Bun fetch 与系统代理**：确认 `127.0.0.1` 调用不被 `HTTP_PROXY` 拦截（若被拦，plugin
   需显式 `undici` dispatcher 绕过，对齐 claude code `--noproxy`）。
6. **`messages.transform` 触发频率与幂等**：实测每步触发，标记守卫生效。
7. **opencode.json `~` 路径展开**：opencode 是否自动展开 `~`；若否，install 写绝对路径。

## 测试策略

**首选可断言面（纯函数 / 纯数据）**

- `parseOpencodeMessages`（`tests/opencode-transcript.test.ts`）：
  - 正向：user TextPart → user turn；assistant TextPart → assistant turn。
  - tool：ToolPart tool_use↔tool_result 按 callID 配对；tool result error → `is_error`。
  - 过滤：ReasoningPart / subtask / StepStart/Finish / Patch / Snapshot 不进 turns。
  - 边界：空 messages → `[]`；缺 parts → 空 turn；缺 role → 跳过。
  - 错误：malformed part 不崩（跳过）。
- `installOpencodePlugin`（`tests/install-opencode.test.ts`，baseDir=tmp）：
  - 幂等：重复 install 不重复加 plugin 条目。
  - 保留用户既有 plugin 条目（superpowers 等）。
  - malformed opencode.json 当空文档，install 仍成功。
  - 端口烘焙：生成 memside.js 含正确端口。
- `listApprovedByScope` 跨 runtime（`tests/store-crud.test.ts` 扩展）：
  - project 记忆 `runtime='claude-code'` 对 opencode inject（不传 runtime）可见。
  - global 记忆全共享。
  - 老记忆 `runtime=null` 行为不变。

**daemon 路由（`tests/server-opencode.test.ts`，fake adapter + enqueueDistillJob seam）**

- `POST /hooks/opencode/capture` → `enqueueDistillJob` 被调 + `memory_distill_events` 行写入 + 202。
- `GET /hooks/opencode/inject?cwd=` → 返回 `{block}`；无记忆返回 null block。
- `POST /hooks/opencode/error` → `enqueueDistillJob(sourceKind:'error')` + events 行 + 202。

**集成（`tests/adapter-opencode.test.ts`，tmp DB）**

- OpencodeAdapter inject 端到端（tmp DB）：inject 返回块（跨 runtime，含 claude-code runtime 记忆）。
- inject 不抛（db 错误降级 null）。

**plugin 钩子（源码层文本断言兜底）**

- `opencode-plugin/memside.js` 含三个钩子注册 + `--- BEGIN INJECTED MEMORY ---` 幂等守卫 +
  best-effort catch（运行时行为靠 live smoke）。

**live smoke（`smoke-live.ts` 扩展或新增 `opencode-smoke.ts`）**

- 真实 `opencode run` + tmp DB + tmp transcript：capture → distill → approve → inject
  闭环。验证缺口 1-7 在此逐一确认。受 opencode 真实 LLM（huoshan/glm-5.2）可用性约束，
  失败不阻塞单测绿（标注为 live-only）。

**回归防护**

- `tests/store-crud.test.ts` 现有 runtime 过滤断言需更新（语义变了：runtime 不再过滤 inject）。
- claude code inject 现有测试（若锁了 runtime 隔离）需同步改 + 注释说明「跨 runtime 共享决策」。
