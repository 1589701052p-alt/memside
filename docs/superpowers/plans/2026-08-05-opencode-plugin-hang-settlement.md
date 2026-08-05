# opencode 插件挂死根治 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 根治「opencode 安装 memside plugin 即挂死」：裸 socket 传输（结构免疫代理）+ 钩子入口硬结算预算（bun 运行时无论怎么坏都不冻 opencode）。

**Architecture:** 只改 `opencode-plugin/memside.js`（传输层 node:http → node:net 裸 socket；两钩子入口包 `settleWithin` Promise.race 硬预算；全部 `log()` 改 fire-and-forget）+ `tests/plugin-opencode.test.ts`（挂死回归红测试 + 传输契约测试 + 守卫重写）。daemon / 安装器 / claude hooks 不动。

**Tech Stack:** Bun + bun:test + node:net（运行时零新依赖；plugin 保持 default-only 导出）。

## Global Constraints

- 测试一律 `bun test`，**严禁 npm test**（项目规则；npm test 走 Node 会因 Bun 专有 API 失败）。
- 运行门槛：`bun run typecheck && bun test` 全绿才可 push。
- plugin 必须保持 **default-only 导出**（opencode 1.18.11+ 加载器拒绝非函数 named export）。
- plugin 零依赖（不得新增 import 除 node 内置模块）。
- best-effort 契约：钩子永不向 opencode reject/throw。
- 分支：`fix/opencode-plugin-hang-settlement`（基线 origin/master 28b25fd，已切出）。
- commit 信息中文、带类型前缀；禁止直推 master。
- spec：`docs/superpowers/specs/2026-08-05-opencode-plugin-hang-settlement-design.md`（以下简称 spec）。

## 背景速览（实现者必读）

opencode 1.18.13 的 `Plugin.trigger` 对 `experimental.chat.messages.transform`
钩子**串行 await**（二进制取证见 spec §1.2a）——钩子 Promise 不结算，消息管线
永久冻住。实测 bun（opencode 内嵌运行时）的 node:http：timeout 事件后
`destroy(err)` 不触发任何后续事件、Promise 永不结算（对照实验：Node 2.025s
准时 reject，bun watchdog 15s 强杀）；`createConnection` 被静默忽略；读
HTTP_PROXY 劫持 loopback。node:net 实测免疫代理 env。因果链全录见 spec §1.3。

现有测试 harness（`tests/plugin-opencode.test.ts`）：
- `freshPlugin()`：`?fresh=N` 缓存击穿重载 plugin 模块。
- `makeFakeClient({flat, path})`：假 SDK client，收集 `order`/`logs`。
- `serveDaemon(impl?)`：Bun.serve 假 daemon，自动设 `process.env.MEMSIDE_PORT`。
- 顶部 `const js = readFileSync(...memside.js...)`：源码文本断言用。

---

### Task 1: 结算不变量（settleWithin + 钩子包裹 + log fire-and-forget）红→绿

**Files:**
- Modify: `tests/plugin-opencode.test.ts`（文件末尾追加挂死回归测试 + 调整 line 311 日志降级测试）
- Modify: `opencode-plugin/memside.js:94-141`（钩子入口包裹）、`:73/:101/:107/:118/:120/:137`（log 调用点）

**Interfaces:**
- Consumes: 现有 harness（`freshPlugin` / `makeFakeClient`）。
- Produces: plugin 内部 `settleWithin(promise: Promise<unknown>, ms: number, label: string): Promise<unknown>`、常量 `TRANSFORM_BUDGET_MS = 2000` / `EVENT_BUDGET_MS = 30000`（模块私有，测试经钩子行为 + 文本守卫断言）。钩子对外形状不变：`event({event})`、`'experimental.chat.messages.transform'(input, output)`，均 resolve undefined。

- [ ] **Step 1: 写黑洞服务器 helper + 挂死回归红测试（追加到 tests/plugin-opencode.test.ts 末尾）**

```ts
// --- 挂死回归守卫（2026-08-05 事故锁）---
// 为什么存在这组测试：2026-08-05 实测 opencode 1.18.13 装上 memside plugin 即整体
// 冻住。根因链：bun node:http 的 destroy 吞没 bug（timeout 后 destroy 不结算
// Promise）× 系统代理吞掉 loopback 请求不回应 × opencode Plugin.trigger 在消息
// 管线关键路径串行 await transform 钩子 = 永久挂死。黑洞服务器模拟「代理吞请求」，
// 断言钩子在入口硬预算内结算——任何把兜底拆回去的改动都会让这里变红。
// 红测历史：现代码（node:http + 无结算兜底）下 T1 在 10s test timeout 处失败、
// T2 在 37s test timeout 处失败（Promise 永不结算）——这是预期的红。
import { createServer, type Socket, type AddressInfo } from 'node:net'

function blackhole(): Promise<{ port: number; stop: () => Promise<void> }> {
  return new Promise((resolve) => {
    const sockets = new Set<Socket>()
    const srv = createServer((s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        port: (srv.address() as AddressInfo).port,
        stop: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); srv.close(() => r()) }),
      })
    })
  })
}

test('挂死回归: transform 钩子在传输永不回应时仍必须于预算内结算（2026-08-05 事故锁）', async () => {
  const hole = await blackhole()
  const origPort = process.env.MEMSIDE_PORT
  process.env.MEMSIDE_PORT = String(hole.port)
  try {
    const { client } = makeFakeClient({})
    const { plugin } = await freshPlugin()
    const hooks = await plugin({ client, directory: '/tmp/proj' })
    const t0 = Date.now()
    await hooks['experimental.chat.messages.transform']({}, {
      messages: [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' }] }],
    })
    // 预算 2000ms + 宽裕余量；现代码挂死 -> 撞 test timeout 红
    expect(Date.now() - t0).toBeLessThan(6000)
  } finally {
    process.env.MEMSIDE_PORT = origPort
    await hole.stop()
  }
}, 10000)

test('挂死回归: event 钩子在 capture 传输永不回应时仍必须于预算内结算（2026-08-05 事故锁）', async () => {
  const hole = await blackhole()
  const origPort = process.env.MEMSIDE_PORT
  process.env.MEMSIDE_PORT = String(hole.port)
  try {
    const { client } = makeFakeClient({
      flat: () => ({ data: [{ info: { role: 'user' }, parts: [] }] }),
    })
    const { plugin } = await freshPlugin()
    const hooks = await plugin({ client, directory: '/tmp/proj' })
    const t0 = Date.now()
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_hang' } } })
    // 预算 30000ms + 余量；本条故意慢（锁的是 30s 卫生预算本身）
    expect(Date.now() - t0).toBeLessThan(33000)
  } finally {
    process.env.MEMSIDE_PORT = origPort
    await hole.stop()
  }
}, 37000)

test('钩子入口 settleWithin 硬预算（结算不变量文本守卫）', () => {
  // settleWithin 是唯一安全依赖（纯 Promise.race + 定时器，不依赖运行时行为）。
  // 两个钩子入口都必须被包裹；预算常量取值锁定（用户拍板 transform 2s）。
  expect(js).toContain('function settleWithin(')
  expect(js).toContain('TRANSFORM_BUDGET_MS = 2000')
  expect(js).toContain('EVENT_BUDGET_MS = 30000')
  expect(js.match(/settleWithin\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
})
```

注意：`import { createServer ... }` 放在文件中段虽合法（ESM import 提升），
为可读性把它挪到文件顶部 import 区（与既有 `import { readFileSync }` 相邻）。

- [ ] **Step 2: 调整既有日志降级测试（tests/plugin-opencode.test.ts line 311-329）**

本任务把 plugin 内所有 `await log(` 改为 `void log(`（fire-and-forget，见
Step 4），`app.log 失败降级 console.error` 测试（line 311-329）的断言时机需等
一个 microtask 窗口（logs.push 仍同步发生，不受影响；console.error 发生在
rejection 捕获后）：

在 `await hooks.event(...)` 之后插入以下行——**必须仍在 try 块内**（finally 会
恢复 console.error，sleep 若放在 try/finally 之后将捕获不到降级输出）：

```ts
      // log() 改 fire-and-forget（spec §5.1）：console.error 降级在 microtask 后发生
      await new Promise((r) => setTimeout(r, 20))
```

- [ ] **Step 3: 运行确认红**

Run: `bun test tests/plugin-opencode.test.ts`
Expected: 恰有 3 条失败——两条「挂死回归」（撞各自 test timeout）+ 一条
「settleWithin 文本守卫」（源码还没有 settleWithin）；其余全绿。两条挂死回归
分别耗时约 10s / 37s（Promise 永不结算，被 bun test timeout 杀掉）。
**若挂死回归以其他原因失败，停下来检查测试本身。**

- [ ] **Step 4: 实现结算不变量（opencode-plugin/memside.js）**

4a. 在 `log()` 函数定义之后（line 92 后）插入：

```js
// --- 结算不变量（2026-08-05 挂死事故根治，spec 2026-08-05-opencode-plugin-hang-settlement-design.md §5）---
// opencode 的 Plugin.trigger 对 transform 钩子串行 await（1.18.13 二进制取证）：
// 钩子 Promise 不结算 = 消息管线永久冻住。而 bun（opencode 内嵌运行时）的
// node:http 在 timeout 后 destroy 不结算 Promise（对照实验证实）——一切依赖
// 运行时行为的超时守卫都不可靠。settleWithin 只用纯 JS 语义（Promise.race +
// 定时器），是钩子唯一的安全依赖：预算内必然结算，超时按失败走 catch 通道。
const TRANSFORM_BUDGET_MS = 2000;  // 消息管线同步路径：用户拍板的最坏感知延迟
const EVENT_BUDGET_MS = 30000;     // fire-and-forget 卫生预算：覆盖大会话拉 1000 条消息的合法慢

function settleWithin(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}
```

4b. 把 `event` 钩子现有 body（line 97-122 的函数体）原样搬进新的模块私有函数
`handleSessionIdle`，`transform` 钩子 body（line 123-139）搬进 `handleTransform`
（签名各收 `client`/`cwd`/所需入参），然后钩子入口改为结算包裹：

```js
export default async function memsidePlugin({ client, directory }) {
  const cwd = directory;
  return {
    event: async ({ event }) => {
      try {
        await settleWithin(handleSessionIdle(client, event, cwd), EVENT_BUDGET_MS, 'session.idle handler');
      } catch (e) {
        // 结算超时/内部逃逸错误：fire-and-forget 记日志——此处绝不能再 await
        // （client.app.log 走 bun fetch，同样可能不结算；前门堵挂死后门不能再开）。
        void log(client, 'error', `event handler failed: ${String(e)}`, { error: String(e) });
      }
    },
    'experimental.chat.messages.transform': async (_input, output) => {
      try {
        await settleWithin(handleTransform(client, output, cwd), TRANSFORM_BUDGET_MS, 'messages.transform handler');
      } catch (e) {
        void log(client, 'error', `transform handler failed: ${String(e)}`, { error: String(e) });
      }
    },
  };
}
```

`handleSessionIdle(client, event, cwd)` = 原 event body（含 `if (event.type !==
'session.idle') return;` 开头）；`handleTransform(client, output, cwd)` = 原
transform body。内部逻辑与日志文案**逐字不变**（`capture ok session=` /
`capture failed session=` / `inject transform failed:` / `without sessionID` 等
被既有文本守卫与行为测试锁定）。

4c. plugin 内所有 `await log(` → `void log(`（4b 新增的两处已是 void；其余位于
`handleSessionIdle` / `handleTransform` / `fetchSessionMessages` 内，共 6 处：
原 line 73/101/107/118/120/137）。理由：任何 await 点都是潜在挂点；入口 race
虽然兜底，但 fire-and-forget 更彻底且日志本就是 advisory。

4d. `log()` 函数头部注释补一句：「所有调用点均 fire-and-forget（void）——调用方
不得 await 本函数（app.log 走 bun fetch 可能不结算，见 settleWithin 注释）。」

- [ ] **Step 5: 运行确认绿**

Run: `bun test tests/plugin-opencode.test.ts`
Expected: 全绿。两条挂死回归分别约 2s / 30s 通过（撞预算后结算，远小于
assert 上限）。

- [ ] **Step 6: 全量回归**

Run: `bun run typecheck && bun test`
Expected: 全绿（约 570+ 条；套件总时长因 T2 增加约 30s）。

- [ ] **Step 7: Commit**

```bash
git add tests/plugin-opencode.test.ts opencode-plugin/memside.js
git commit -m "fix(opencode-plugin): 钩子入口 settleWithin 硬预算——挂死事故结算不变量

opencode 1.18.13 Plugin.trigger 串行 await transform 钩子；bun node:http
timeout 后 destroy 不结算 Promise（对照实验证实）-> 代理吞请求时钩子永不
返回 -> opencode 整体冻住（2026-08-05 用户实测复现）。

transform/event 钩子入口包 settleWithin（纯 Promise.race，不依赖运行时
行为）：2s/30s 预算内必然结算；log() 全部 fire-and-forget 堵 catch 通道
后门。红测试：黑洞服务器驱动真实钩子，现代码撞 test timeout 失败。

Spec: docs/superpowers/specs/2026-08-05-opencode-plugin-hang-settlement-design.md §5"
```

---

### Task 2: 传输层替换（node:http → node:net 裸 socket）红→绿

**Files:**
- Modify: `tests/plugin-opencode.test.ts`（重写 line 32-43 传输守卫；追加 T3/T4 测试与 wire 级假服务器 helper）
- Modify: `opencode-plugin/memside.js:1`（import）、`:18-37`（httpRequest 重写）、`:7-16`（NO_PROXY 注释更新）

**Interfaces:**
- Consumes: Task 1 的结算包裹（钩子入口已 budgeted）。
- Produces: `httpRequest(url, { method?, body?, headers?, timeoutMs? }) -> Promise<{ status: number, body: string }>`——**签名与错误语义逐字不变**（连接错误 reject；非 2xx resolve，调用方查 status 抛错），调用点（capture POST / inject GET）零改动。

- [ ] **Step 1: 重写传输层文本守卫（tests/plugin-opencode.test.ts line 32-43）**

原守卫断言 `from 'node:http'`——本次修复正是推翻该路线（bun node:http 三宗罪，
spec §1.2d）。整块替换为：

```ts
test('loopback 传输走 node:net 裸 socket（结构免疫代理 env）+ NO_PROXY 追加保留 + 非 2xx 必抛', () => {
  // 2026-08-05 事故链：bun node:http 读 HTTP_PROXY 劫持 loopback、createConnection
  // 被忽略、timeout 后 destroy 不结算 Promise。node:net 裸 socket 结构上不读任何
  // 代理 env（live 实验：带 HTTP_PROXY=:7897 直连 127.0.0.1:7777 成功），是确定性
  // 直连通道。NO_PROXY 追加保留（对 SDK 的 bun fetch 偶发生效，无害冗余）。
  expect(js).toContain("from 'node:net'")
  expect(js).not.toContain('node:http')
  expect(js).toMatch(/process\.env\.NO_PROXY/)
  expect(js).toContain("['127.0.0.1', 'localhost']")
  expect(js).toContain('capture endpoint returned HTTP')
  expect(js).toContain('inject endpoint returned HTTP')
  expect(js.match(/HTTP \$\{/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
})
```

- [ ] **Step 2: 写 wire 级假服务器 helper + T3/T4 测试（追加到文件末尾挂死回归之后）**

```ts
// wire 级假服务器：手写 HTTP 响应字节，精确控制 framing（Content-Length / chunked /
// 状态码）——Bun.serve 不保证暴露所需传输形态。用于锁定 rawHttp 解析契约。
function wireServer(responder: () => string): Promise<{ port: number; stop: () => Promise<void> }> {
  return new Promise((resolve) => {
    const sockets = new Set<Socket>()
    const srv = createServer((s) => {
      sockets.add(s); s.on('close', () => sockets.delete(s))
      s.once('data', () => { s.write(responder()); s.end() })
    })
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        port: (srv.address() as AddressInfo).port,
        stop: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); srv.close(() => r()) }),
      })
    })
  })
}

test('传输契约: Content-Length framing 注入成功', async () => {
  const block = '--- BEGIN INJECTED MEMORY ---\n- wire\n--- END INJECTED MEMORY ---'
  const body = JSON.stringify({ block })
  const wire = await wireServer(() =>
    `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
  const origPort = process.env.MEMSIDE_PORT
  process.env.MEMSIDE_PORT = String(wire.port)
  try {
    const { client } = makeFakeClient({})
    const { plugin } = await freshPlugin()
    const hooks = await plugin({ client, directory: '/tmp/proj' })
    const output = { messages: [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' }] }] }
    await hooks['experimental.chat.messages.transform']({}, output)
    expect((output.messages[0].parts[0] as { text?: string }).text).toBe(block)
  } finally {
    process.env.MEMSIDE_PORT = origPort
    await wire.stop()
  }
})

test('传输契约: chunked framing 注入成功（防御性解析）', async () => {
  const block = '--- BEGIN INJECTED MEMORY ---\n- chunked\n--- END INJECTED MEMORY ---'
  const body = JSON.stringify({ block })
  const chunk = `${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`
  const wire = await wireServer(() =>
    `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${chunk}`)
  const origPort = process.env.MEMSIDE_PORT
  process.env.MEMSIDE_PORT = String(wire.port)
  try {
    const { client } = makeFakeClient({})
    const { plugin } = await freshPlugin()
    const hooks = await plugin({ client, directory: '/tmp/proj' })
    const output = { messages: [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' }] }] }
    await hooks['experimental.chat.messages.transform']({}, output)
    expect((output.messages[0].parts[0] as { text?: string }).text).toBe(block)
  } finally {
    process.env.MEMSIDE_PORT = origPort
    await wire.stop()
  }
})

test('传输契约: 非 2xx -> error 日志含状态码（代理 502 语义延续）', async () => {
  const wire = await wireServer(() =>
    `HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)
  const origPort = process.env.MEMSIDE_PORT
  process.env.MEMSIDE_PORT = String(wire.port)
  try {
    const { client, logs } = makeFakeClient({})
    const { plugin } = await freshPlugin()
    const hooks = await plugin({ client, directory: '/tmp/proj' })
    await hooks['experimental.chat.messages.transform']({}, {
      messages: [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' }] }],
    })
    // 非 2xx 在 handleTransform 内部 catch 处置（文案 'inject transform failed'，
    // 与既有行为测试一致）；入口 settleWithin 不触发（body 正常结算）。
    expect(logs.some((l) => l.level === 'error' && l.message.includes('inject transform failed') && l.message.includes('502'))).toBe(true)
  } finally {
    process.env.MEMSIDE_PORT = origPort
    await wire.stop()
  }
})

test('传输契约: hostile 代理 env 下注入仍成功（node:net 结构免疫）', async () => {
  // HTTP_PROXY/HTTPS_PROXY 指向黑洞、NO_PROXY 清空——最恶劣的代理环境。
  // node:net 结构上不读代理 env（spec §1.2e live 实证），注入必须照常成功。
  // 注：本测试对旧 node:http 传输无判别力（plugin 顶层 NO_PROXY 追加在纯净
  // 测试进程里恰好能救 node:http）；判别力来自上方 'node:net' 文本守卫 +
  // 挂死回归红测试 + live 事故记录。此处锁的是新传输在 hostile env 下的行为。
  const hole = await blackhole()
  const body = JSON.stringify({ block: null })
  const wire = await wireServer(() =>
    `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
  const orig = { p: process.env.MEMSIDE_PORT, hp: process.env.HTTP_PROXY, hps: process.env.HTTPS_PROXY, np: process.env.NO_PROXY }
  process.env.MEMSIDE_PORT = String(wire.port)
  process.env.HTTP_PROXY = `http://127.0.0.1:${hole.port}`
  process.env.HTTPS_PROXY = `http://127.0.0.1:${hole.port}`
  process.env.NO_PROXY = ''
  try {
    const { client, logs } = makeFakeClient({})
    const { plugin } = await freshPlugin()
    const hooks = await plugin({ client, directory: '/tmp/proj' })
    const output = { messages: [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' }] }] }
    await hooks['experimental.chat.messages.transform']({}, output)
    // block:null -> 不注入、也不应有任何 error（传输成功抵达 daemon）
    expect(output.messages[0].parts.length).toBe(1)
    expect(logs.some((l) => l.level === 'error')).toBe(false)
  } finally {
    process.env.MEMSIDE_PORT = orig.p
    if (orig.hp === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = orig.hp
    if (orig.hps === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = orig.hps
    if (orig.np === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = orig.np
    await hole.stop()
    await wire.stop()
  }
})
```

注意：`wireServer` 的 `s.once('data')` 在收到请求首字节后回响应——GET/POST 皆适用。

- [ ] **Step 3: 运行确认现状**

Run: `bun test tests/plugin-opencode.test.ts`
Expected: 恰 2 条失败——「node:net 文本守卫」（源码还是 node:http）与
「chunked framing」（node:http 客户端在 bun 下对 wire 服务器手写响应的行为
不可靠；若它碰巧绿也不阻塞——判别力主力是文本守卫，见 Step 2 注释）。
「Content-Length framing」「非 2xx」「hostile env」预期绿（契约锁，新旧皆须满足）。

- [ ] **Step 4: 实现 rawHttp（opencode-plugin/memside.js）**

4a. line 1 import 替换：`import { request as httpRequestImpl } from 'node:http'`
→ `import { connect } from 'node:net'`

4b. line 7-16 NO_PROXY 块：保留逻辑，注释改为「对 SDK 的 bun fetch 偶发生效的
无害冗余；loopback 直连的确定性由 node:net 裸 socket 保证（不读代理 env）」。

4c. line 18-37 `httpRequest` 整体替换为（签名/返回/错误语义不变）：

```js
// loopback 传输层：node:net 裸 socket 手写 HTTP/1.1。
// 为什么不用 node:http（2026-08-05 挂死事故，spec §1.2d/§4.2）：bun 的 node:http
// 读 HTTP_PROXY 劫持 loopback、createConnection 被静默忽略、timeout 后 destroy
// 不结算 Promise。node:net 结构上不读任何代理 env（live 实证 spec §1.2e），
// 直连是构造事实而非行为运气。结算安全由钩子入口 settleWithin 兜底，
// socket setTimeout 只作尽早回收。
// 契约：连接/解析错误 reject；HTTP 非 2xx 照常 resolve（调用方查 status 抛错）。
function httpRequest(url, opts = {}) {
  const { method = 'GET', body, headers, timeoutMs = 2000 } = opts;
  const u = new URL(url);
  const port = Number(u.port || 80);
  const path = u.pathname + u.search;
  return new Promise((resolve, reject) => {
    let done = false;
    const chunks = [];
    const sock = connect(port, u.hostname);
    const fail = (e) => { if (!done) { done = true; sock.destroy(); reject(e); } };
    sock.setTimeout(timeoutMs, () => fail(new Error(`socket timeout after ${timeoutMs}ms`)));
    sock.on('error', fail);
    sock.on('connect', () => {
      const head = [`${method} ${path} HTTP/1.1`, `Host: ${u.hostname}:${port}`, 'Connection: close'];
      for (const [k, v] of Object.entries(headers ?? {})) head.push(`${k}: ${v}`);
      if (body) head.push(`Content-Length: ${Buffer.byteLength(body)}`);
      sock.write(head.join('\r\n') + '\r\n\r\n' + (body ?? ''));
    });
    sock.on('data', (c) => chunks.push(c));
    sock.on('end', () => {
      if (done) return;
      done = true;
      try { resolve(parseHttpResponse(Buffer.concat(chunks))); } catch (e) { reject(e); }
    });
  });
}

function parseHttpResponse(buf) {
  const sep = buf.indexOf('\r\n\r\n');
  if (sep < 0) throw new Error('malformed HTTP response: no header terminator');
  const headLines = buf.slice(0, sep).toString('ascii').split('\r\n');
  const status = Number(headLines[0].split(' ')[1]);
  if (!status) throw new Error(`malformed HTTP status line: ${headLines[0]}`);
  const headers = {};
  for (const line of headLines.slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  let bodyBuf = buf.slice(sep + 4);
  if (headers['transfer-encoding'] === 'chunked') bodyBuf = dechunk(bodyBuf);
  else if (headers['content-length'] != null && bodyBuf.length < Number(headers['content-length'])) {
    throw new Error('truncated response body');
  }
  return { status, body: bodyBuf.toString('utf-8') };
}

function dechunk(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const lineEnd = buf.indexOf('\r\n', i);
    if (lineEnd < 0) throw new Error('malformed chunked encoding');
    const size = parseInt(buf.slice(i, lineEnd).toString('ascii').split(';')[0], 16);
    if (Number.isNaN(size)) throw new Error('malformed chunk size');
    if (size === 0) break;
    const start = lineEnd + 2;
    if (start + size > buf.length) throw new Error('truncated chunk');
    out.push(buf.slice(start, start + size));
    i = start + size + 2;
  }
  return Buffer.concat(out);
}
```

4d. 检查 plugin 全文：除新 import 外不得再出现 `node:http` 字样（注释里的
历史叙述如出现 `node:http` 字样会让文本守卫误红——注释中提及旧方案时写
「node 内置 http 模块」或保留英文但注意守卫是 `not.toContain('node:http')`，
**任何字符串含 node:http 都会红**；把注释里的 `node:http` 改写为
`node 的 http 模块`）。同步检查测试文件自身的注释：文本守卫读的是
memside.js 源码（`js` 变量），测试文件注释不受限，但避免混淆仍可改写。

- [ ] **Step 5: 运行确认绿**

Run: `bun test tests/plugin-opencode.test.ts`
Expected: 全绿（含 Step 2 全部传输契约测试与 Task 1 挂死回归）。

- [ ] **Step 6: 全量回归**

Run: `bun run typecheck && bun test`
Expected: 全绿。

- [ ] **Step 7: Commit**

```bash
git add tests/plugin-opencode.test.ts opencode-plugin/memside.js
git commit -m "fix(opencode-plugin): loopback 传输换 node:net 裸 socket——结构免疫代理 env

bun node:http 三宗罪（2026-08-05 实验取证）：读 HTTP_PROXY 劫持 loopback、
createConnection 被忽略、timeout 后 destroy 不结算 Promise。node:net 裸 socket
不读任何代理 env（live 实证带 HTTP_PROXY=:7897 直连 127.0.0.1:7777 成功），
手写 HTTP/1.1（Content-Length + chunked 解析），接口形状与错误语义不变。

NO_PROXY 追加保留为对 SDK bun fetch 的无害冗余；PR #38/#39 时代的
node:http 路线文本守卫改写为 node:net + 禁 node:http 守卫。

Spec: docs/superpowers/specs/2026-08-05-opencode-plugin-hang-settlement-design.md §4"
```

---

### Task 3: 落档收尾 + PR

**Files:**
- Modify: `STATE.md`（追加本轮小节）

- [ ] **Step 1: STATE.md 追加小节**

在 STATE.md 末尾追加（中文，风格对齐既有小节）：

```markdown
## opencode 插件挂死根治（裸 socket 传输 + 钩子结算不变量，2026-08-05）

用户实测：opencode 装 memside plugin 即整体冻住，卸载恢复。根因链（完整取证
见 spec）：bun（opencode 内嵌运行时）node:http 的 destroy 吞没 bug（timeout 后
destroy 不结算 Promise，Node/bun 对照实验证实）× 系统代理吞掉 loopback 请求
不回应 × opencode 1.18.13 Plugin.trigger 在消息管线关键路径串行 await
transform 钩子 = 永久挂死。设计 spec / 计划见
`docs/superpowers/specs|plans/2026-08-05-opencode-plugin-hang-settlement*`。

1. `settleWithin`（opencode-plugin/memside.js）：纯 Promise.race 硬预算，
   transform 钩子 2s / event 钩子 30s 内必然结算——不依赖任何可能被 bun
   破坏的运行时行为。钩子 body 搬入私有 handleTransform/handleSessionIdle，
   入口 try/catch 包 settleWithin；全部 log() 改 fire-and-forget（void），
   堵 catch 通道后门挂点。
2. 传输层 node:http -> node:net 裸 socket：手写 HTTP/1.1（Content-Length +
   chunked 解析），结构上不读代理 env（live 实证）， eradicates 代理论劫。
   接口形状与错误语义不变（调用点零改动）。NO_PROXY 追加保留为无害冗余。
3. 测试：黑洞服务器挂死回归红测试（现代码撞 test timeout 失败）+ wire 级
   framing 契约（Content-Length/chunked/非 2xx）+ hostile 代理 env 行为锁 +
   文本守卫重写（node:net + 禁 node:http + settleWithin 双包裹 + 预算常量）。

执行：<subagent-driven / inline>。`bun run typecheck && bun test` 全绿。

### 真机冒烟（post-merge，硬门槛）
1. daemon 在运行装修复版插件 -> `opencode run` 注入成功（无 transform 错误日志）。
2. 杀 daemon -> `opencode run` 毫秒级跳过（ECONNREFUSED 日志），无挂死。
3. 用户 TUI 验收：正常使用一轮不卡 + capture ok + daemon 新 opencode job。
4. 大会话抽查：长会话 idle 捕获不被 30s 预算误杀。
```

（把「执行：」一行改成实际执行方式。）

- [ ] **Step 2: 终检 + push + PR**

Run: `bun run typecheck && bun test`
Expected: 全绿。

```bash
git add STATE.md
git commit -m "docs: opencode 插件挂死根治 STATE.md 落档"
git push -u origin fix/opencode-plugin-hang-settlement
gh pr create --base master \
  --title "fix(opencode-plugin): 挂死根治——node:net 裸 socket 传输 + 钩子结算硬预算" \
  --body "**事件**：2026-08-05 用户实测 opencode 装 memside plugin 即整体冻住，卸载恢复。
**根因**：bun node:http 的 destroy 吞没 bug（timeout 后 destroy 不结算 Promise，Node/bun 对照实验证实）× 系统代理吞 loopback 请求不回应 × opencode 1.18.13 Plugin.trigger 消息管线串行 await transform 钩子 = 永久挂死。
**修复**：① 钩子入口 settleWithin 硬预算（纯 Promise.race：transform 2s / event 30s，不依赖运行时行为）+ log() 全 fire-and-forget；② 传输层 node:http → node:net 裸 socket（结构免疫代理 env，手写 HTTP/1.1 + chunked 解析，接口形状不变）。
**测试**：黑洞服务器挂死回归红测试（现代码撞 test timeout 失败）+ wire 级 framing 契约 + hostile 代理 env 锁 + 文本守卫重写。全量 typecheck + bun test 绿。
Spec: docs/superpowers/specs/2026-08-05-opencode-plugin-hang-settlement-design.md
**merge 后硬门槛冒烟**：daemon 在/停两种状态 opencode run 无挂死 + 用户 TUI 验收 + capture 闭环 + 大会话抽查。"
```

（git push 走 openssl sslBackend——本机全局已配置。）

---

### Task 4: 真机冒烟（PR 合并后执行）

**Files:** 无代码改动（live 验证）

- [ ] **Step 1: 装修复版插件**

daemon 已在运行（PID 以 netstat :7777 确认）；只装插件：

Run: `bun run src/cli.ts install`
Expected: 输出 hooks + opencode plugin installed；`~/.config/opencode/opencode.json`
plugin 数组含 `C:/Users/admin/.config/opencode/memside-opencode`。

- [ ] **Step 2: daemon 在运行冒烟**

```bash
mkdir -p /c/Users/admin/Desktop/oc-smoke && cd /c/Users/admin/Desktop/oc-smoke && \
OPENCODE_CONFIG_CONTENT='{"autoupdate":false}' timeout 90 opencode run "Reply with exactly: OK"
```

Expected: 输出 OK；`opencode.log` 最新 run **无** `transform handler failed` /
`inject endpoint returned HTTP` 错误（daemon 直连 200）。

- [ ] **Step 3: daemon 停止冒烟（挂死根除验证）**

停 daemon（taskkill 对应 bun.exe PID），同目录再跑一次 opencode run。
Expected: 输出 OK；日志见 transform 错误（ECONNREFUSED，毫秒级），**无挂死**；
恢复 daemon（`bun run src/cli.ts start`，后台）。

- [ ] **Step 4: 用户 TUI 验收 + capture 闭环**

请用户在 TUI 正常使用一轮。验收标准：不卡；`opencode.log` 出
`capture ok ... shape=`；daemon DB `memory_distill_jobs` 新增 runtime='opencode' 行。

- [ ] **Step 5: 大会话抽查**

长会话（>100 消息）idle 后确认 capture ok（30s 预算未误杀）。
若冒烟任何一步失败：记录证据，回 Phase 1（不得在冒烟未过时宣称完成）。
