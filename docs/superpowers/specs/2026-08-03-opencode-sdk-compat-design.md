# opencode plugin 新旧 SDK 签名兼容 + capture 可观测性

## 背景

2026-08-03 诊断「opencode 会话结束了但蒸馏记录里没有」。结论：plugin 的 capture 链路
在 opencode 1.18.10 上静默断裂——SDK 方法签名翻转 + plugin catch 吞错，双重叠加。

### 事故根因（live 证据链，2026-08-03 / 2026-07-31 事件）

1. **DB 对照**（`~/.memside/memside.db`）：`runtime='opencode'` 共 4 个 job，全部 done，
   时间窗 2026-07-31 14:45–15:06；此后 ~3 小时直至调查时刻 **0 个新 opencode job**。
   同时段 `claude-code` 闭环正常（24h 内 163 distill runs，2514 done jobs）。
2. **版本翻转**：opencode.db `session` 表——能 captured 的会话全部 `version=1.15.5`；
   17:46 起的会话 `version=1.18.10`。opencode 日志 `~/.local/share/opencode/log/
   2026-07-31T093933.log:52`：`service=installation method=npm target=1.18.10 ... upgraded`
   ——**会话运行期间 opencode 自动升级**。
3. **plugin 安装完好**：`~/.config/opencode/memside-opencode/memside.js` 存在且端口烘焙
   为 7777（与 daemon 一致）；opencode.json `plugin` 数组注册路径匹配；日志 `:19`
   `service=plugin path=file:///C:/Users/admin/.config/opencode/memside-opencode loading plugin`
   无报错。
4. **签名翻转（binary 取证）**：opencode 1.18.10 二进制（`opencode.exe`）内部代码两处
   调用 `client.session.messages({ sessionID, limit })`（扁平形态）；而 plugin
   `opencode-plugin/memside.js:21` 用 `{ path: { id: sessionID } }`——这是 1.15.5 live
   smoke 时定死的签名（STATE.md「opencode 支持完整闭环」live smoke 项 3：当时
   `{ sessionID }` 报 "Expected a string starting with ses" 才被改成 `path:{id}`）。
   **1.18.10 把 SDK 签名翻转回扁平形态**，plugin 旧签名调用失败。
5. **黑盒放大器**：`memside.js:27` `catch (e) { /* best-effort */ }` 把上述失败静默吞掉——
   fetch 从不发出、DB 零 job、零日志。没有它，第一次签名翻转就会以 error 形式被发现。

### 诊断中排除的假设（同样有证据，防止复审走回头路）

- `session.idle` 事件 1.18.10 **仍存在**：官方文档 Plugin Events 列表明列；二进制
  `mo.define({type:"session.idle",schema:{sessionID:Po}})`；`SessionStatus.set` 在
  `d.type==="idle"` 时 `publish(rs.Idle,{sessionID:r})`。
- idle 事件 payload 形状**未变**：`event.properties?.sessionID` 取值方式与 1.15.5 一致
  （二进制内部 plugin handler 对 `session.deleted` 用 `event.properties.info.id`，
  properties 承载事件 schema 字段的形状保持）。
- `experimental.chat.messages.transform` 1.18.10 **仍存在**（二进制 2 处
  `trigger("experimental.chat.messages.transform",...)`）→ inject 路径不受影响。
- `export default` 仍被支持（二进制 doc string："A plugin module exports `default`
  (or any named export) of type `Plugin = (input: PluginInput, options?) => Promise<Hooks>`"）。
- daemon / scheduler / 凭证正常：同时段 claude-code 闭环 live 验证通过；
  `GET /api/status` 200，jobs 全 done、lastError null。
- NO_PROXY / 端口 / 代理：plugin 端口烘焙正确（7777）；1.15.5 时代的 NO_PROXY 修复仍在。

### 三个已确认决策（brainstorming 阶段用户拍板）

1. **兼容机制用「双签名探测 + 成功记忆」**（新形态优先），不做版本检测，不弃旧版。
2. **日志粒度 = 错误 + 成功摘要**：失败记 error 级；每次成功 capture 记 info 级摘要；
   不做 debug 级全量。
3. **日志通道 = `client.app.log`**（opencode 官方文档 Logging 章节推荐，control-plane
   `app.log` 端点写入 opencode 日志文件；TUI 模式下 stderr 不可见），app.log 自身
   失败降级 console.error。

## 目标 / 非目标

**目标**

- capture 在 opencode 1.15.x（`{ path: { id } }`）与 1.18+（`{ sessionID }`）都能工作；
  未来签名再变时，单进程内最多付出一次探测失败代价。
- capture / inject 路径的**失败与成功**在 opencode 日志文件（`~/.local/share/opencode/log/`）
  可见：签名回退、fetch 失败、sessionID 缺失、注入失败记 error/warn；成功 capture 记 info。
- best-effort 契约不变：plugin 永不向 opencode 抛错。
- 测试面：探测逻辑可用假 client 功能测试（不再只有源码层文本断言）。

**非目标**

- daemon / server / scheduler / distiller / Web UI 不动（capture POST 到达 daemon 之后的
  链路已被 claude-code 闭环同时段验证正常）。
- inject 的 transform hook 逻辑不动（仅补 catch 日志）。
- 不做 per-runtime 的 Web UI 状态展示。
- events 表膨胀等既有债务不碰。
- 1.15.5 真机回归不可行（本机已升级）：旧形态行为由假 client 功能测试覆盖，
  STATE.md 如实记录该验证缺口。

## 接口契约

### 1. `opencode-plugin/memside.js` 改动

**a. 签名探测 + 记忆**

新增模块级探测状态与函数：

```js
export const compat = { rememberedShape: null };   // null | 'flat' | 'path'

export async function fetchSessionMessages(client, sessionID) { ... }
export function resetCompatState() { compat.rememberedShape = null; }
```

`fetchSessionMessages` 语义：

- 候选形态按序：记忆态优先；无记忆时 **flat 优先**
  `[ { sessionID, limit: 1000 }, { path: { id: sessionID } } ]`。
- **成功判据 = `res.data` 为真值**，不是「没抛错」：1.18.10 生成的 SDK 默认可能返回
  错误响应对象而非 throw（二进制内部对 `session.get` 显式传 `{throwOnError:!0}` 是反证）。
  抛错或响应无 `data` → 尝试下一形态。
- 首个成功即写 `compat.rememberedShape`；两种都失败抛最后一个错误（由调用方记日志）。
- `limit: 1000` 仅 flat 形态携带：v1 路由 query 带 limit（二进制路由定义
  `M.get("session.messages","/api/session/:sessionID/message",{params:{sessionID},query})`，
  内部调用均显式传 limit）；1000 为宽裕上限——distill 侧 `filterTranscriptForDistill`
  自有 12000 token 预算裁剪，此处只需防默认分页截断。`path` 形态保持 1.15.5 原样
  `{ path: { id: sessionID } }`（无 limit），不动已验证的旧路径。
- 返回 `res` 原样；现有响应归一化 `Array.isArray(res.data) ? res.data : (res.data?.messages ?? [])`
  保留不动。

**b. event hook（capture）**

```
session.idle -> 取 sessionID（properties.sessionID ?? properties.info?.id，保持现状）
  -> sessionID 缺失：记 error 日志后 return（现状是静默 return）
  -> fetchSessionMessages（探测/记忆在内部）
     -> 发生形态回退：记 warn 日志（"flat failed, path fallback" + 错误文本）
  -> POST /hooks/opencode/capture（body/timeout 不变）
  -> 成功：记 info 摘要（sessionID + messages 条数 + 命中形态）
  -> 任一环节失败：catch 记 error 日志（错误文本）后吞掉（不抛回 opencode）
```

**c. transform hook（inject）**

逻辑零改动；仅 catch 从空吞改为「记 error 日志（错误文本）后吞掉」。

**d. 日志 helper**

```js
async function log(client, level, message, extra) { ... }
```

- 走 `client.app.log({ body: { service: 'memside', level, message, extra } })`
  （二进制确认端点存在：control-plane `app.log` "Write log entry to the server logs"）。
- 自身失败降级 `console.error('[memside] ...')`。永不 throw，永不阻塞主路径语义。
- `service: 'memside'` 让 opencode 日志可按词 grep。

**e. 测试接缝**

`fetchSessionMessages` / `compat` / `resetCompatState` 以 named export 暴露，仅为
bun:test 的功能测试服务；opencode loader 加载 default export（二进制 doc string
"default (or any named export)"，default 存在时以 default 为准），不注册为钩子。

### 2. daemon / 测试 / 安装

- `src/**` 零改动。
- `tests/plugin-opencode.test.ts` 重写签名守卫两条
  （现 :39-44 锁死 `path:{id}` 且禁止 `{ sessionID }` 出现——与新设计正面冲突）：
  改为断言双形态共存、flat 优先、成功判据含 `res.data`、记忆态存在；新增功能测试段
  （假 client + 拦截 `globalThis.fetch`，直接调 default export 返回的 hooks）。
- 分发：`installOpencodePlugin` 逻辑不变，`bun run src/cli.ts install` 重装即带出新
  memside.js。**用户侧需重启 opencode 才生效**（plugin 仅在进程启动时加载）。

## 测试策略

plugin 是 opencode 进程内加载的独立 JS（无 TS import、无测试运行器），运行时行为
只能 live 验证——故双层：

**Layer 1 功能测试（新增，假 client 驱动真实 hooks）**——覆盖探测逻辑全分支：

| case | 假 client 行为 | 断言 |
|---|---|---|
| 新形态成功（1.18+ 正常路径） | flat 返回 `{data:[...]}` | POST /hooks/opencode/capture body 带全量 messages；info 日志命中 flat；第二次触发 event hook 只调 flat（假 client 计次：path 形态零调用，记忆生效） |
| flat 抛错 → path 回退（1.15.x 形态） | flat throw，path 返回 `{data:[...]}` | capture 成功；warn 日志含回退；`compat.rememberedShape==='path'`；second call 直接 path |
| flat 返回无 data 的错误对象（1.18+ 非 throw 形态） | flat 返回 `{}`，path 返回 `{data:[...]}` | 同上——成功判据看 `res.data` 不看 throw |
| 两形态都失败 | 都 throw | 不 POST；error 日志含错误文本；不抛（await hook 不 reject） |
| sessionID 缺失 | event properties 空 | 不 POST；error 日志；不抛 |
| inject catch 路径 | fetch GET 抛错 | 不抛；error 日志 |

实现要点：测试内 `process.env.MEMSIDE_PORT='7777'` + 保存/恢复 `globalThis.fetch`；
import `../opencode-plugin/memside.js`（default export 调用作 plugin，named export
`resetCompatState` 每 case 前重置记忆态）。

**Layer 2 源码层文本断言（保留，CLAUDE.md 兜底面）**：NO_PROXY 追加非覆盖；
`Array.isArray(res.data)`；INJECT_MARK；catch 块必引用日志 helper（防止回退为空 catch——
本次事故的结构性缺口）。

**运行门槛**：`bun run typecheck && bun test` 全绿。

**live 冒烟（本机，1.18.10）**：

1. `bun run src/cli.ts install` 重装 plugin；
2. `memside` daemon 在跑（端口 7777，已确认）；
3. 起 `opencode run "hi"`（scratch 目录）→ 断言：memside DB 出 `runtime='opencode'`
   新 job；opencode 日志出现 `service=memside` capture info 行；
4. 1.15.5 形态回归由 Layer 1 假 client 覆盖（本机无法 live 降级）。

## 失败模式

| 模式 | 行为 |
|---|---|
| 两种签名都失败（未来再翻转 / session 已删 / SDK 断网） | error 日志可见；capture 丢一次——与现状同损但不再黑盒 |
| `client.app.log` 失败（server 异常） | console.error 兜底；主流程不受影响 |
| opencode 进程内自动升级 | 升级伴随 worker 重启，新进程新 plugin 实例，记忆归零重新探测，一次性代价 |
| flat 成功但 `data` 为空数组 | `[]` 为真值 → 判定成功，正常流程（idle 后 session 实际不会空） |
| 旧版 opencode 首次 idle | flat 失败一次（warn 日志）→ path 成功并记忆；后续零开销 |
| 测试 import memside.js 执行顶层 NO_PROXY 副作用 | 仅追加 loopback 到进程 env，测试内无害 |
