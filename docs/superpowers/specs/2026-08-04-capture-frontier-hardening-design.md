# Capture 边界加固设计（传输替换 + 健康哨兵 + daemon 托管）

日期：2026-08-04 · 分支计划：三 PR 顺序落地（见 §执行计划）

## 1. 背景

2026-08-04 用户报告「opencode 会话结束但蒸馏记录里没有」。三轮修复（PR #35 SDK
签名兼容 + 可观测性、PR #36 res.ok 检查 + 用户级 NO_PROXY、daemon 复活）后真机
验证仍失败。完整事故链（每一条都有实证，非推测）：

1. **SDK 签名翻转**（PR #35 已修）：opencode 自动升级 1.15.5→1.18.x，
   `client.session.messages` 签名翻转；生成的 SDK 返回错误响应对象而非 throw，
   plugin catch 静默吞掉。
2. **代理劫持 + 假成功**（PR #36 已修一半）：系统代理（:7897）劫持 loopback
   POST 返 502；bun `fetch` 对 502 照常 resolve；plugin 不查 `res.ok` 记假
   「capture ok」。
3. **NO_PROXY 在 opencode 运行时不生效**（本轮核心发现）：用户级
   `NO_PROXY=127.0.0.1,localhost` 已在进程 env 中（子 shell 实证继承），
   plugin 捕获仍收到 **HTTP 502**——daemon 当时已死，若 NO_PROXY 生效应得
   ECONNREFUSED（TypeError），拿到 502 即证明请求仍走了代理。结论：opencode
   自带 bun 运行时的 fetch 代理解析不认进程内/启动期设置的 NO_PROXY
   （首个 fetch 固化代理解析，早于 plugin 模块加载；且用户 env 到运行时的
   传递链本身也不可靠）。**env 层旁路在此运行时是赌注，不是方案。**
4. **daemon 前台裸奔**（本轮直接死因）：`src/cli.ts start` 是前台进程，用户
   关终端即死，无哨兵无托管。

结构性问题：plugin 运行在**不受我们控制的第三方进程**里，而原设计把智能
（SDK 探测、代理规避、成功判定）全放在这个脆弱端，且失败零信号。

## 2. 目标 / 非目标

### 目标

1. capture/inject 的 loopback 传输**确定性不走代理**，不依赖任何 env。
2. capture 链路任何失败在 Web UI **分钟级可见**（错误原话 + 静默红灯）。
3. daemon 常驻托管：登录自启 + 崩溃自动拉起，且**必须 UI 显式配置**（用户
   明确裁决：不可静默自启，保障知情权）。

### 非目标

- claude-code 侧 capture/inject（该链路经 7/31 live smoke 验证正常，不动）。
- 心跳信标（用户选定不做；错误信箱 + 静默告警已覆盖现实失败模式）。
- events 表膨胀 / DB 清理（既有债务，独立 issue）。
- 教用户配代理（NO_PROXY 用户 env 保留不撤销，只当 belt-and-suspenders）。
- opencode 若未来废除 plugin 机制的预案（记为风险，不预制方案）。

## 3. 设计原则

**plugin 变哑（只发信号），daemon 变聪明（判断与呈现），一切失败必须可见。**

## 4. P1 传输替换（分支 fix/opencode-loopback-transport）

### 4.1 改动

`opencode-plugin/memside.js`：

- 新增模块私有 `httpRequest(url, { method, body, timeoutMs })`：
  - 用 `node:http` 的 `request()` 实现（bun 完整兼容；该模块**从不读取任何
    代理 env**——这是选它的唯一理由，也是相对 fetch 的本质优势）。
  - 返回 `{ status, body }`；`timeoutMs` 用 `setTimeout` + `req.destroy()`。
  - 连接错误（ECONNREFUSED 等）reject；HTTP 非 2xx 由调用方按 status 抛错。
- capture POST 与 inject GET 均改走 `httpRequest`；保持既有语义：
  非 2xx → 抛 `capture endpoint returned HTTP ${status}` /
  `inject endpoint returned HTTP ${status}` → 既有 catch 记 error 日志。
- **删除**模块顶部 NO_PROXY env 改写块（§1.3 实证无效，留着是误导）。
- 保持 default-only 导出（1.18.11 加载器约束，既有守卫不动）。

### 4.2 为什么不用其他方案

| 方案 | 否决理由 |
|---|---|
| `fetch` + `proxy:false` | opencode 内置 bun 版本行为不可赌；事故已证明该运行时 fetch 不可信 |
| 继续 env 层（NO_PROXY/BUN_CONFIG_*） | 实证不生效（§1.3） |
| 裸 TCP（Bun.connect） | 手写 HTTP 帧，过度工程；node:http 已是最小可靠层 |

### 4.3 失败模式

- opencode 运行时 `node:http` 不可用 → plugin 加载或首调即错，error 日志
  + P2 后的错误信箱可见；回滚面仅本 PR。
- daemon 宕机 → ECONNREFUSED → `capture failed` error 日志（真失败，不再
  502 假相）。

## 5. P2 健康哨兵（分支 feat/capture-health-sentinel）

### 5.1 错误信箱

- **plugin**：`log()` 在 `level==='error'` 时额外 fire-and-forget POST
  `/hooks/opencode/error-report`（走 P1 的 httpRequest；try/catch 包裹，
  不阻塞、不抛出、不影响主流程）。payload：
  `{ runtime:'opencode', message, extra, ts }`。
- **daemon**：新路由 `POST /hooks/opencode/error-report`（202 ack，<50ms
  契约同 capture 路由）；新表 `plugin_error_reports`：
  `{ id INTEGER PK AUTOINCREMENT, runtime TEXT, message TEXT NOT NULL,
  extra_json TEXT, ts INTEGER NOT NULL }`；幂等 CREATE TABLE；环形保留最近
  200 条（插入后 DELETE 超额最老行）。畸形 payload → 存
  `message='invalid error report payload'`（失败可见路径不许静默丢弃）。
- **呈现**：`/api/status` 增加 `lastPluginError: {message, ts} | null`
  （最近一条）。Web UI 顶部状态栏红字显示原话 + 相对时间；既有 fetch 失败
  横幅逻辑不动。

### 5.2 静默告警

- **daemon 内存**记两个时间戳（不落库；daemon 重启归零重新观察，语义足够）：
  - `lastCaptureAt`：任意 capture POST 到达（不论入队成败）。
  - `lastActivityAt`：任意 inject GET 或 error-report 到达（= opencode 活着
    的证据）。
- **纯函数** `evalCaptureHealth(now, lastCaptureAt, lastActivityAt)`
  （放纯函数层，仿 canTransition 模式）：

  | 条件 | 状态 | UI |
  |---|---|---|
  | `now - lastCaptureAt <= 15min` | `ok` | 绿灯「opencode capture 正常」 |
  | 超 15min 无 capture 且 `lastActivityAt` 在 30min 内且晚于 lastCaptureAt | `silent` | 红灯「capture 中断：opencode 活跃但 N 分钟无捕获」 |
  | 其余（含从未连接） | `idle` | 灰灯「opencode 未连接/不活跃」 |

  null 语义显式化：`lastCaptureAt === null` 视为无限旧（第一行不命中、第二行
  「晚于」恒成立）——即「opencode 一直活跃但从未 capture 成功」正是本次事故
  形态，判 `silent` 不判 `idle`。`lastActivityAt === null` 时第二行必不命中。

  常量 `CAPTURE_SILENCE_MS = 15*60*1000`、`ACTIVITY_WINDOW_MS = 30*60*1000`
  单处定义，但可被 daemon 启动时的 env 覆盖（`MEMSIDE_HEALTH_SILENCE_MS` /
  `MEMSIDE_HEALTH_ACTIVITY_MS`）——仅为真机冒烟加速，默认值即生产值。
- `/api/status` 增加 `opencodeHealth: { state, lastCaptureAt, lastActivityAt }`。

### 5.3 刻意不做

心跳信标（防「opencode 升级后事件钩子整个消失」的低概率极端场景，用户
已裁决 YAGNI）；错误信箱的双写持久化（opencode.log 已有全量）。

## 6. P3 daemon 托管（分支 feat/daemon-service-ui）

### 6.1 机制

Windows 任务计划程序。任务名 `memside-daemon`：

- **Action**：`"<bun.exe>" run "<repoDir>\src\cli.ts" start`（前台 daemon
  作为任务进程常驻）。bun.exe 取注册时刻 `process.execPath`；repoDir 从
  代码位置（import.meta.url）推导，不依赖 process.cwd。
- **触发器**：当前用户登录（LogonType=InteractiveToken）。
- **设置**：失败后 1 分钟重启，至多 3 次；StartWhenAvailable；隐藏窗口。
- 注册方式：生成任务 XML → 临时文件 → `schtasks /Create /TN memside-daemon
  /XML <tmp> /F`。

### 6.2 端点（新模块 src/service.ts，spawn 走可注入 seam）

| 端点 | 行为 |
|---|---|
| `GET /api/daemon-service` | `{ supported, registered, taskInfo?, command }`——schtasks /Query 解析 + **完整命令行预览** |
| `POST /api/daemon-service/enable` | 注册任务；成功/失败均回显原样输出 |
| `POST /api/daemon-service/disable` | `schtasks /Delete /F` |
| `POST /api/daemon-service/start-now` | `schtasks /Run`，立即拉起 |

- 非 win32：四端点一律 501 `{ supported:false }`，UI 隐藏面板。
- **install 命令永不自动注册**——只有 UI 显式操作（用户裁决）。

### 6.3 Web UI 面板

新面板「daemon 常驻」：状态徽标（已注册/未注册）+ 将注册的完整命令行预览
（知情权）+「启用自动常驻 / 禁用 / 立即启动」按钮 + 注册失败红字原样回显
（如权限不足）。复用 App.tsx 既有样式结构，不引新框架。

### 6.4 失败模式

| 失败 | 处置 |
|---|---|
| schtasks 权限拒绝 | stderr 原样回显 UI；文档注明提权终端手动注册兜底 |
| bun.exe 路径漂移（bun 升级搬家） | UI 面板显示当前注册命令；禁用-重启用刷新 |
| daemon 崩溃循环 | 任务重启 3 次后停；错误信箱（P2）+ /api/status 可见根因 |
| 注册成功但登录不触发 | start-now 兜底 + 任务计划程序可查上次运行结果（UI 透出） |

## 7. 数据流（总览）

```
opencode 进程                     daemon (7777)                  Web UI
┌────────────────┐                ┌───────────────────────┐
│ memside.js     │   node:http    │ POST /hooks/opencode/ │
│  session.idle ─┼───直连回环────→│   capture ──→ 既有蒸馏入队
│  transform    ─┼──(不走任何代理)│ GET  /hooks/opencode/ │
│                │                │   inject ──→ 既有注入
│  log(error)   ─┼───────────────→│ POST /hooks/opencode/ │
│                │                │   error-report ──→ plugin_error_reports
└────────────────┘                │ GET  /api/status(+opencodeHealth
                                  │        +lastPluginError) ──→ 顶部红/绿横幅
                                  │ /api/daemon-service(P3) ──→ 常驻配置面板
                                  └───────────────────────┘
```

## 8. 与现有模块的耦合点

| 文件 | 改动 |
|---|---|
| `opencode-plugin/memside.js` | P1 httpRequest + 删 NO_PROXY 块；P2 error-report 投递 |
| `tests/plugin-opencode.test.ts` | P1 活体测试改造；文本守卫更新 |
| `src/server.ts` | P2 路由 + status 扩展；P3 service 路由接线 |
| `src/service.ts`（新） | P3 schtasks 封装 + 纯函数 |
| `src/health.ts`（新） | P2 evalCaptureHealth 纯函数 + 时间戳持有 |
| `src/db/client.ts` | P2 plugin_error_reports 幂等建表 |
| `src/web/App.tsx` + web api | P2 横幅/错误显示；P3 常驻面板 |
| `src/install.ts` | **不改**（明确不静默注册） |

## 9. 测试策略

### 静态层（每 PR 必须）

- P1：活体测试——bun test 内起真实本地 HTTP server（临时端口），假 client
  驱动真实 plugin 钩子：
  - session.idle → server 收到正确 POST body → 记 `capture ok`
  - server 回 502 → 记 `capture failed ... HTTP 502`，**无** `capture ok`
  - inject 同构两条
  - 文本守卫更新：loopback 调用不再出现 `fetch(`；default-only 导出守卫、
    catch 必记日志守卫保留。
- P2：`evalCaptureHealth` 阈值边界（±1ms、null、activity 早于 capture 不算
  silent）；error-report 路由入库 + 200 条环裁 + 畸形 payload 兜底行；
  /api/status 新字段；UI 文本守卫。
- P3：`buildTaskXml`（含触发器/重启配置/路径断言）、`parseSchtasksQuery`
  （fixture 解析）纯函数测试；路由测试走**假 spawn seam**（断言 argv，绝不
  触碰真实 schtasks）；非 win32 → 501；UI 文本守卫。

### 真机冒烟（硬门槛，控制实验一律不算数）

1. **P1**：合并 + `bun run src/cli.ts install` 重装插件 → 用户重启 opencode，
   自然走一轮交互 → opencode.log 出现 `capture ok session=...` **且** memside
   DB 新增对应 `runtime='opencode'` 的 memory_distill_jobs 行。
2. **P2**（注：daemon 宕机时错误信箱与静默状态本身都无法上报/计算——该场景由
   既有「/api/status fetch 失败错误横幅」覆盖，非本 PR 新能力）：
   - 错误信箱：daemon 在跑，curl 直接投递一条合成 plugin error → UI 顶部
     显示该原话 + 时间（路由级冒烟；真实故障走同一入口）。
   - 静默告警：daemon 带 `MEMSIDE_HEALTH_SILENCE_MS=20000` 等短阈值启动 →
     curl 一次 inject GET（制造 activity）→ 等过短阈值 → UI 红灯 silent；
     再 curl 一次 capture POST → 转绿 ok。
3. **P3**：UI 启用 → 任务计划程序可见 `memside-daemon`；`taskkill` daemon →
   1 分钟内自动拉起；禁用 → 任务删除。

## 10. 执行计划

| 顺序 | 分支 | PR | 依赖 |
|---|---|---|---|
| 1 | `fix/opencode-loopback-transport` | P1 | 无（解锁一切真机验证） |
| 2 | `feat/capture-health-sentinel` | P2 | P1（error 投递走新传输） |
| 3 | `feat/daemon-service-ui` | P3 | 独立（最后，不动前两 PR 成果） |

每 PR：`bun run typecheck && bun test` 全绿方可 push；每 PR 合并后跑对应
真机冒烟，未过不算交付。

## 11. 风险登记

1. opencode 未来废除/再变形 plugin 机制 → 本设计不免疫；P2 哨兵保证「坏了
   看得见」，MTTR 从天级降到分钟级。
2. 任务计划程序在受限企业环境可能被策略禁用 → 失败原样回显，用户可退回
   手动前台模式（README 说明）。
3. plugin_error_reports 被错误风暴刷满 → 200 条环形上限，只留最新。
