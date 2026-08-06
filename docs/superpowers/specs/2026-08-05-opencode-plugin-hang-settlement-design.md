# opencode 插件挂死根治设计（裸 socket 传输 + 钩子结算不变量）

日期：2026-08-05
分支：`fix/opencode-plugin-hang-settlement`（基线 `origin/master` 28b25fd）
状态：设计已确认（延迟预算 2s 由用户拍板）

## 1. 背景

### 1.1 现象

用户实测：opencode 装上 memside plugin 就「卡住不动」，卸载即恢复。稳定复现。
opencode 版本 1.18.13（当日 16:22 自动从 1.18.11 升级，npm 包 mtime 实证）。

### 1.2 证据链

**a. opencode 如何调用插件钩子**（取证自本机 1.18.13 二进制捆绑 JS，
`opencode.exe` 内嵌 bundle，`grep -abo` 定位 offset=102127763 附近提取）：

- `Plugin.trigger`（钩子派发器）对 transform 类钩子**串行 await**：
  `for(let H of B.hooks){ let M=H[W]; if(!M) continue; yield* v.promise(async()=>M(K,w)) }`
  ——钩子 Promise 不结算，消息管线永久停在原地。
- `event` 钩子是 fire-and-forget：`v.sync(()=>{ for(let V of K) V.event?.({...}) })`，
  Promise 被丢弃——事件钩子挂死不阻塞 opencode（只泄漏孤儿）。
- 插件加载器（1.18.11 起遍历全部 export）与 `await J(Z,$.options)` 主函数调用
  均在 bootstrap 完成，非挂死点。

**b. 挂死现场**（`~/.local/share/opencode/log/opencode.log`）：

- run=195e530a（10:03 UTC，daemon 在运行）：title stream 启动后**彻底静默**——
  无 transform 错误日志、无 small=false 主 stream，直到 90s 被 timeout 杀掉。
  transform 钩子只在 catch 里记日志；无日志 = Promise 从未结算。
- run=4fa3a2f9（10:06 UTC）：transform 快速失败
  `inject endpoint returned HTTP 502` → 记错误日志 → 主 stream 照常 → 正常完成。
- 对照：transform 的日志时点（10:06:27.776）恰在 title stream（:26.349）与
  主 stream（:28.078）之间——195e530a 正是停在 transform 时点。

**c. bun node:http 的 destroy 吞没 bug**（对照实验，2026-08-05）：

黑洞 TCP 服务器（接受连接、永不回应）+ 与本插件逐字节相同的 httpRequest
（`timeout: 2000` + `req.on('timeout', ()=>req.destroy(new Error(...)))`，
Node 官方推荐的 timeout 处置模式）：

| 运行时 | timeout 事件 | destroy 之后 | 结果 |
|--------|-------------|-------------|------|
| Node（对照） | 2013ms 触发 | 'error' 触发 → Promise 2025ms REJECTED | 守卫有效 |
| Bun（opencode 内嵌） | 2019ms 触发 | **无任何后续事件，Promise 永不结算** | 守卫失效，挂死（watchdog 15s 强杀） |

**d. bun node:http 其余两宗罪**（实验确认）：

- `createConnection` 选项被静默忽略（回调从未被调用）→ 无法精确绕过 bun 代理层。
- bun 读取 `HTTP_PROXY` 把 loopback 请求也塞给系统代理；进程早期固化解析，
  plugin 模块级 NO_PROXY 追加为时已晚（今日 opencode 进程内 transform 拿 502
  实证；独立进程里 NO_PROXY 先生效则直连 200 实证——行为取决于固化时序，不可靠）。

**e. 传输层免疫性实验**（2026-08-05）：

- bun `node:net` `connect(7777,'127.0.0.1')` 带 `HTTP_PROXY=:7897` env：
  `remote=127.0.0.1:7777` 直连成功，daemon 回 200——**node:net 结构上不读代理 env**。
- daemon 健康性：直连 curl 200/26ms；经代理 curl 502/1.3s。daemon 无责。

### 1.3 因果链（完整）

1. opencode 进程继承系统代理 env（:7897）；bun 在进程早期固化代理解析，
   plugin 的 NO_PROXY 追加（PR #39）来不及生效。
2. transform 钩子的 node:http loopback 请求被代理论劫持。
3. 代理对 loopback 请求行为不定：有时秒回 502（钩子快速失败，10:06 run），
   有时吞掉不回应（10:03 run）。
4. 被吞时：2s timeout 事件触发 → `destroy(err)` 被 bun compat 层吞没 →
   请求 Promise 永不结算。
5. 1.18.13 `Plugin.trigger` 在消息管线关键路径串行 await transform 钩子 →
   永久等待 → **opencode 整体冻住**。

次生问题（同族，一并治）：event 钩子里 `client.session.messages`（bun fetch，
同样走代理）与 capture POST 也可能挂死；虽 fire-and-forget 不冻 opencode，
但孤儿堆积、capture 丢失。

### 1.4 为什么之前的防线全失效

- PR #36（res.ok 检查）：防「假成功」，不防「不结算」。
- PR #38（node:http 替换 bun fetch）：假设 node:http 不走代理——在 bun 里不成立
  （bun node:http 读 HTTP_PROXY）。
- PR #39（NO_PROXY 追加恢复）：假设 env 追加可左右 bun 代理解析——进程固化时序
  使其不稳定。
- 既有 timeout 守卫（`timeout` 选项 + destroy）：假设 destroy 会结算 Promise——
  bun 里不成立。

四条防线全部建立在「运行时行为符合 Node 语义」的假设上，而 opencode 内嵌 bun
逐一违反。本设计的核心转向：**不依赖任何可能被运行时破坏的行为，只用纯 JS 语义
（Promise.race + 定时器）保证结算；传输只用结构上免疫代理的 node:net**。

## 2. 目标 / 非目标

### 目标

1. **结算不变量**：plugin 注册的两个钩子（transform / event）无论底层传输与
   SDK 调用发生什么，都在硬预算内结算。opencode 永不被 memside 冻住。
2. **确定性直连**：loopback 传输（inject GET / capture POST）不走代理，
   不受代理 env 影响。注入/捕获功能在代理环境下恢复可用。
3. **契约零回归**：best-effort（永不向 opencode throw）、default-only 导出、
   SDK 双签名探测、INJECT_MARK 幂等、非 2xx 抛带状态码的错、catch 必记日志——
   既有守卫与测试全部保留。

### 非目标

- 不修 opencode/bun 自身的代理行为；SDK 调用（client.session.messages /
  client.app.log）仍经 bun fetch，功能成败受环境影响——只保证它们被结算预算覆盖。
- 不改 daemon、install.ts、claude hooks。
- 不做重试/排队：预算内失败即跳过（best-effort 语义不变）。
- 不新增插件依赖（零依赖原则延续）。

## 3. 设计原则

1. **结算优先**：钩子入口级 `Promise.race` 硬预算是唯一安全依赖；
   destroy/timeout 事件等运行时行为只作尽早回收的优化，不作正确性依赖。
2. **结构性免疫**：传输选 node:net 裸 socket——免疫代理来自「不读 env」的构造事实，
   不是行为运气。
3. **接口不变**：传输层对外形状（入参/返回/错误语义）与现 httpRequest 一致，
   调用点零改动。
4. **冗余保留**：NO_PROXY 追加、SDK 双签名探测等既有防御不删（偶发生效，无害）。

## 4. 传输替换：rawHttp（node:net 裸 socket）

### 4.1 改动

删除 `import { request } from 'node:http'`，`httpRequest` 重写为裸 socket 实现：

- `net.connect(port, '127.0.0.1')`（port 从 url 解析；目标恒为 loopback daemon）。
- 手写 HTTP/1.1 请求行 + `Host` + `Content-Length`（有 body 时）+
  `Connection: close`，GET/POST 两形态够用（daemon 仅这两类调用）。
- 读到连接关闭为止；解析状态行（`HTTP/1.1 NNN ...`）与 headers；
  body = 首个 `\r\n\r\n` 之后全部字节（utf-8）。
  - `Content-Length` 存在：校验实收字节数，不足抛解析错。
  - `Transfer-Encoding: chunked`：解码（防御性；daemon 实测恒 Content-Length）。
- 连接错误（ECONNREFUSED 等）→ reject；socket `setTimeout(timeoutMs)` 到期
  `destroy`——**仅尽早回收**，结算由上层 race 兜底。
- 非 2xx 照常 resolve `{status, body}`，由调用方按现有契约抛带状态码的错。

### 4.2 为什么不用其他方案

| 候选 | 拒绝理由 |
|------|---------|
| node:http + NO_PROXY | bun 进程早期固化代理解析，env 追加时序不可靠（§1.2d，双实证） |
| node:http + createConnection | bun 静默忽略该选项（实证：回调从未触发） |
| bun fetch | 首个 fetch 固化代理解析、NO_PROXY 实证无效（STATE.md 2026-08-04 事故） |
| 引入 HTTP 库依赖 | 违反插件零依赖原则；裸 socket 需求面极小 |

### 4.3 失败模式

- daemon 未启动：ECONNREFUSED 立即 reject → 钩子毫秒级跳过。
- daemon 接受连接不回应：socket setTimeout destroy + 入口 race 双兜底。
- 响应被提前关闭（Content-Length 不足）：抛解析错 → catch 记日志 → 跳过。
- 超大响应：daemon inject 块有预算裁剪（clipByBudget），capture ack 极小；
  不做流式/限长（YAGNI）。

## 5. 结算不变量：settleWithin

### 5.1 机制

`settleWithin(promise, ms, label)`：`Promise.race` + `setTimeout` 定时器，
到点以 `Error(\`${label} did not settle within ${ms}ms\`)` 结算。
纯 JS 语义，无运行时行为依赖。

钩子入口包裹：

| 钩子 | 预算 | 超时行为 |
|------|------|---------|
| `experimental.chat.messages.transform` | **2000ms**（用户拍板；沿现有 timeoutMs 设计意图） | 放弃本次注入，消息照常发送 |
| `event`（session.idle 处理体） | **30000ms**（卫生预算；fire-and-forget 不卡 opencode，覆盖大会话拉 1000 条消息的合法慢） | 记 capture failed error 日志 |

**包裹结构**：`settleWithin` 位于钩子顶层 try/catch **之内**——超时按错误走
既有 catch 通道，钩子永不向 opencode reject（best-effort 契约延续）。

**配套改动（自审补强）**：catch 通道里的 `log()` 一律改为 fire-and-forget
（`void log(...)`，不再 await）。理由：`client.app.log` 走 bun fetch，本身可能
不结算；若 catch 里 await 它，等于前门堵住挂死、后门再开一个。日志本来就是
advisory，去掉 await 不损失任何正确性。

### 5.2 覆盖范围

钩子体内的**全部** await（rawHttp 调用、client.session.messages 双签名探测、
client.app.log）都在入口 race 覆盖之下——不需要逐个包裹内部调用。
超时后未完成的内部 Promise 成为孤儿：传输层 socket 已 destroy；
SDK 孤儿无副作用（不阻塞 opencode，无共享状态）。

### 5.3 失败模式

- 定时器永不失效（纯 JS）；race 语义由语言保证。
- race 不取消 in-flight 工作——接受（孤儿无害，见 5.2）。
- 预算取值写死模块常量，测试可断言。

## 6. 与现有模块的耦合点

- `src/install.ts` `installOpencodePlugin`：`__MEMSIDE_PORT__` 烘焙机制不变，
  本设计不触碰。
- `tests/plugin-opencode.test.ts`：既有功能测试（假 client 驱动真实钩子）与
  3+ 条源码文本守卫（default-only 导出 / catch 必记日志 / 双签名）保持全绿；
  新增守卫见 §7。
- daemon 端点契约（`POST /hooks/opencode/capture` / `GET /hooks/opencode/inject`）
  不变。

## 7. 测试策略

### 静态层（bun test，必须全绿才可 push）

- **T1 挂死回归红测试**（本 bug 的核心锁）：测试内起黑洞 TCP 服务器
  （接受连接、永不回应，模拟代理吞请求），`MEMSIDE_PORT` 指过去，驱动**真实**
  transform 钩子，断言其在预算+余量内结算（测试自身设 bun test timeout 防红测
  挂死测试进程）。文件头注释注明测试意图（锁 2026-08-05 挂死事故，防兜底被拆回）。
  现代码在 bun 下此测试超时失败（红）；修复后绿。
- **T2 事件钩子同款**：capture 传输挂死时，session.idle 处理体在 30s 预算内结算。
- **T3 rawHttp 功能**：假 HTTP 服务器分别回 Content-Length / chunked 响应，
  断言 GET/POST 状态与正文解析；非 2xx → 调用方抛带状态码的错（契约延续）。
- **T4 代理免疫不变量**：测试内临时设 `HTTP_PROXY/HTTPS_PROXY` 指向黑洞端口，
  rawHttp 对正常假服务器仍成功；测试后恢复 env（防跨文件污染）。
- **T5 源码文本守卫**：源码不得出现 `node:http` import；default-only 导出守卫
  延续；两个钩子入口均被 `settleWithin` 包裹（文本断言锁意图）。
- **T6 存量全绿**：双签名探测顺序/回退/记忆、INJECT_MARK 幂等、catch 必记日志
  等既有用例不许变红。

### 真机冒烟（硬门槛，合并后执行）

1. daemon 在运行：装修复版插件 → `opencode run` → 日志见注入成功（无 transform
   错误），响应正常。
2. 杀掉 daemon：`opencode run` → 毫秒级跳过注入（ECONNREFUSED 错误日志），无挂死。
3. **TUI 用户验收**：正常使用一轮——不卡 + opencode 日志出 capture ok +
   daemon DB 新增 runtime='opencode' job。
4. 大会话抽查：长会话 idle 捕获不被 30s 预算误杀。

## 8. 数据流（总览）

```
发送消息 → Plugin.trigger(串行 await)
        → transform 钩子 ── settleWithin(2000ms)
          → rawHttp GET 127.0.0.1:7777/hooks/opencode/inject（node:net 直连）
          → daemon 返回 block → unshift 进首条 user message

session.idle → event 钩子 ── settleWithin(30000ms)
             → client.session.messages（SDK，best-effort）
             → rawHttp POST .../hooks/opencode/capture → daemon enqueue
```

## 9. 执行计划

分支 `fix/opencode-plugin-hang-settlement`（已从 origin/master 28b25fd 切出）。
任务分解见对应 plan 文档；红测试先行（T1-T4），实现后 `bun run typecheck &&
bun test` 全绿，live 冒烟过 §7 硬门槛，PR 合 master。
