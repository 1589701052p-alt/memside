# Capture 边界加固实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 spec `docs/superpowers/specs/2026-08-04-capture-frontier-hardening-design.md` 落地三件事：plugin→daemon 传输换 node:http（确定性不走代理）；capture 失败分钟级可见（错误信箱 + 静默告警）；daemon 登录自启 + 崩溃自动拉起（任务计划程序，UI 显式配置）。

**Architecture:** plugin 变哑（只发信号），daemon 变聪明（判断与呈现）。P1 换传输层；P2 在 daemon 内加健康追踪 + 错误信箱表 + status 透出 + UI 横幅；P3 新 service 模块封装 schtasks，走可注入 spawn seam，UI 面板显式操作。三阶段 = 三个分支 = 三个 PR，顺序依赖（P2 依赖 P1 传输；P3 独立但最后做）。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite + zod；plugin 为纯 JS（opencode 进程内加载，不得加 named export）；前端 React 19 inline style。

## Global Constraints

- **default-only 导出**：`opencode-plugin/memside.js` 全文件恰有一个 `export ` 行且是 `export default `（opencode 1.18.11 加载器约束，既有文本守卫锁定）。
- **catch 必记日志**：plugin 内所有 `catch (e) { ... }` 必须含 `log(` 或 `console.error`（既有守卫锁定）。
- **best-effort 契约**：plugin 钩子永不 reject 回 opencode。
- **<50ms 202 ack**：capture/error-report 路由同步 ack，重活 fire-and-forget。
- **运行门槛**：每个 commit 前 `bun run typecheck && bun test` 全绿（PowerShell 里分两条命令跑：`bun run typecheck; if ($?) { bun test }`）。
- **分支纪律**：每阶段从最新 `origin/master` 切分支（`git fetch origin; git checkout -b <name> origin/master`），PR 合 master，禁止直推。
- **注释用中文、解释 why**（与仓库现状一致）。
- **控制实验不算验收**：真机冒烟清单见每阶段末尾，未过不算交付。

---

## Phase P1 — 传输替换（分支 `fix/opencode-loopback-transport`）

### Task 1: plugin httpRequest + 活体测试

**Files:**
- Modify: `opencode-plugin/memside.js`
- Modify: `tests/plugin-opencode.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: plugin 内 `httpRequest(url, opts) -> Promise<{status:number, body:string}>`；capture/inject 的失败消息格式不变（`capture endpoint returned HTTP ${status}` / `inject endpoint returned HTTP ${status}`）；测试文件的新 harness `serveDaemon()` 被 P2 Task 5 复用。

- [ ] **Step 1: 更新测试文件（RED）**

`tests/plugin-opencode.test.ts` 改动如下（未列出的测试与守卫保持逐字不动）：

1) 顶部 import 区加 `afterEach` 已有；新增 harness（放在 `freshPlugin` 定义之后、`captureFetch` 之前）：

```ts
type Received = { method: string; path: string; body: unknown | null }

// 活体 harness：起真实本地 HTTP server（临时端口），plugin 的 node:http
// 传输直连它。serveDaemon 同时把 process.env.MEMSIDE_PORT 指向该端口
// （plugin 的 PORT() 每次调用时读 env，无需重新 import 模块）。
function serveDaemon(impl: {
  capture?: () => Response
  inject?: () => Response
} = {}): { received: Received[]; stop: () => void } {
  const received: Received[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const url = new URL(req.url)
      let body: unknown | null = null
      if (req.method === 'POST') { try { body = await req.json() } catch { body = null } }
      received.push({ method: req.method, path: url.pathname, body })
      if (url.pathname === '/hooks/opencode/capture') return impl.capture?.() ?? new Response(JSON.stringify({ ok: true }), { status: 202 })
      if (url.pathname === '/hooks/opencode/inject') return impl.inject?.() ?? new Response(JSON.stringify({ block: null }), { status: 200 })
      if (url.pathname === '/hooks/opencode/error-report') return new Response(JSON.stringify({ ok: true }), { status: 202 })
      return new Response('not found', { status: 404 })
    },
  })
  process.env.MEMSIDE_PORT = String(server.port)
  return { received, stop: () => { server.stop(true); process.env.MEMSIDE_PORT = '7777' } }
}

let active: { stop: () => void } | null = null
afterEach(() => { active?.stop(); active = null })
```

2) **删除** 旧的 `captureFetch()` 函数与 `const realFetch = globalThis.fetch` / `afterEach(() => { globalThis.fetch = realFetch })`（node:http 传输下 fetch 拦截不再适用）。

3) **删除** 测试「NO_PROXY 旁路 loopback...」整条（该机制已移除）。

4) **替换** 测试「fetch 响应必查 res.ok...」为：

```ts
test('loopback 传输走 node:http（确定性不走代理）+ 非 2xx 必抛（防假成功——2026-08-04 TUI 事故）', () => {
  // 事故链：bun fetch 在 opencode 运行时被系统代理劫持 502 且照常 resolve；
  // NO_PROXY env 在该运行时实证无效。node:http 从不读取任何代理 env，是唯一
  // 确定性直连回环的传输层。非 2xx 抛带状态码的错误进 catch 记日志。
  expect(js).toContain("from 'node:http'")
  expect(js).not.toMatch(/process\.env\.NO_PROXY/)
  expect(js).toContain('capture endpoint returned HTTP')
  expect(js).toContain('inject endpoint returned HTTP')
  expect(js.match(/HTTP \$\{/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
})
```

5) **重写** 以下功能测试（语义不变，harness 从 fetch 拦截换成 serveDaemon）。逐条完整替换体：

```ts
test('capture: flat 成功（1.18+ 形态）-> POST + info 日志 + 记忆 flat', async () => {
  active = serveDaemon()
  const { client, order, logs } = makeFakeClient({
    flat: () => ({ data: [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hi' }] }] }),
  })
  const { plugin } = await freshPlugin()
  const hooks = await plugin({ client, directory: '/tmp/proj' })
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_t2' } } })
  const posts = (active as unknown as { received: Received[] }).received
  expect(posts.length).toBe(1)
  expect(posts[0].path).toBe('/hooks/opencode/capture')
  expect((posts[0].body as Record<string, unknown>).sessionId).toBe('ses_t2')
  expect((posts[0].body as Record<string, unknown>).cwd).toBe('/tmp/proj')
  expect(((posts[0].body as Record<string, unknown>).messages as unknown[]).length).toBe(1)
  expect(order).toEqual(['flat'])
  const info = logs.find((l) => l.level === 'info')
  expect(info?.message).toContain('capture ok session=ses_t2')
  expect(info?.message).toContain('shape=flat')
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_t2' } } })
  expect(order).toEqual(['flat', 'flat']) // 记忆命中，不再试探其它形态
})

test('capture: flat 抛错 -> 回退 path（1.15.x 形态）+ warn 日志 + 记忆 path', async () => {
  active = serveDaemon()
  const { client, order, logs } = makeFakeClient({
    flat: () => { throw new Error('Expected a string starting with ses') },
    path: () => ({ data: [{ info: { role: 'user' }, parts: [] }] }),
  })
  const { plugin } = await freshPlugin()
  const hooks = await plugin({ client, directory: '/tmp/proj' })
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_t3' } } })
  expect((active as unknown as { received: Received[] }).received.length).toBe(1)
  expect(order).toEqual(['flat', 'path'])
  expect(logs.some((l) => l.level === 'warn' && l.message.includes('fell back to path'))).toBe(true)
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_t3' } } })
  expect(order).toEqual(['flat', 'path', 'path'])
})

test('capture: flat 返回无 data 错误对象 -> 回退 path 仍成功（成功判据是 res.data，1.18+ 可能不 throw）', async () => {
  active = serveDaemon()
  const { client, order } = makeFakeClient({
    flat: () => ({ error: { message: 'Invalid request' } }),
    path: () => ({ data: [{ info: { role: 'user' }, parts: [] }] }),
  })
  const { plugin } = await freshPlugin()
  const hooks = await plugin({ client, directory: '/tmp/proj' })
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_t5' } } })
  expect((active as unknown as { received: Received[] }).received.length).toBe(1)
  expect(order).toEqual(['flat', 'path'])
})

test('capture: 两形态都失败 -> 不 POST、error 日志、不抛回 opencode', async () => {
  active = serveDaemon()
  const { client, logs } = makeFakeClient({
    flat: () => { throw new Error('flat boom') },
    path: () => { throw new Error('path boom') },
  })
  const { plugin } = await freshPlugin()
  const hooks = await plugin({ client, directory: '/tmp/proj' })
  await expect(hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_t4' } } })).resolves.toBeUndefined()
  expect((active as unknown as { received: Received[] }).received.length).toBe(0)
  expect(logs.some((l) => l.level === 'error' && l.message.includes('capture failed session=ses_t4'))).toBe(true)
})

test('capture: sessionID 缺失 -> 不 POST、error 日志、不抛', async () => {
  active = serveDaemon()
  const { client, logs } = makeFakeClient({})
  const { plugin } = await freshPlugin()
  const hooks = await plugin({ client, directory: '/tmp/proj' })
  await hooks.event({ event: { type: 'session.idle', properties: {} } })
  expect((active as unknown as { received: Received[] }).received.length).toBe(0)
  expect(logs.some((l) => l.level === 'error' && l.message.includes('without sessionID'))).toBe(true)
})

test('capture: 非 idle 事件直接跳过', async () => {
  active = serveDaemon()
  const { client, order } = makeFakeClient({ flat: () => ({ data: [] }) })
  const { plugin } = await freshPlugin()
  const hooks = await plugin({ client, directory: '/tmp/proj' })
  await hooks.event({ event: { type: 'session.updated', properties: { sessionID: 'ses_x' } } })
  expect((active as unknown as { received: Received[] }).received.length).toBe(0)
  expect(order).toEqual([])
})

test('inject: daemon 不可达 -> error 日志、不抛回 opencode', async () => {
  // 指向一个已关闭的端口：node:http 连接拒绝 -> reject -> catch 记 error
  active = serveDaemon()
  active.stop(); active = null
  process.env.MEMSIDE_PORT = '59999'
  const { client, logs } = makeFakeClient({})
  const { plugin } = await freshPlugin()
  const hooks = await plugin({ client, directory: '/tmp/proj' })
  await hooks['experimental.chat.messages.transform']({}, {
    messages: [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' }] }],
  })
  expect(logs.some((l) => l.level === 'error' && l.message.includes('inject transform failed'))).toBe(true)
})

test('capture: 端点非 2xx（代理 502 假 resolve）-> error 日志含状态码，绝不记 capture ok', async () => {
  active = serveDaemon({ capture: () => new Response('Bad Gateway', { status: 502 }) })
  const { client, logs } = makeFakeClient({ flat: () => ({ data: [{ info: { role: 'user' }, parts: [] }] }) })
  const { plugin } = await freshPlugin()
  const hooks = await plugin({ client, directory: '/tmp/proj' })
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_proxy502' } } })
  expect(logs.some((l) => l.level === 'error' && l.message.includes('capture failed session=ses_proxy502') && l.message.includes('502'))).toBe(true)
  expect(logs.some((l) => l.level === 'info' && l.message.includes('capture ok'))).toBe(false)
})

test('inject: 端点非 2xx（代理 502 假 resolve）-> error 日志含状态码', async () => {
  active = serveDaemon({ inject: () => new Response('Bad Gateway', { status: 502 }) })
  const { client, logs } = makeFakeClient({})
  const { plugin } = await freshPlugin()
  const hooks = await plugin({ client, directory: '/tmp/proj' })
  await hooks['experimental.chat.messages.transform']({}, {
    messages: [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' }] }],
  })
  expect(logs.some((l) => l.level === 'error' && l.message.includes('inject transform failed') && l.message.includes('502'))).toBe(true)
})

test('inject: 成功注入 block part（幂等守卫不重复）', async () => {
  const block = '--- BEGIN INJECTED MEMORY ---\n- test\n--- END INJECTED MEMORY ---'
  active = serveDaemon({ inject: () => new Response(JSON.stringify({ block }), { status: 200 }) })
  const { client } = makeFakeClient({})
  const { plugin } = await freshPlugin()
  const hooks = await plugin({ client, directory: '/tmp/proj' })
  const output = { messages: [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' }] }] }
  await hooks['experimental.chat.messages.transform']({}, output)
  expect(output.messages[0].parts.length).toBe(2)
  expect((output.messages[0].parts[0] as { text?: string }).text).toBe(block)
  await hooks['experimental.chat.messages.transform']({}, output)
  expect(output.messages[0].parts.length).toBe(2) // 幂等：不重复注入
})

test('日志: app.log 失败降级 console.error，capture 主流程不受影响', async () => {
  active = serveDaemon()
  const client = {
    session: { messages: async () => ({ data: [{ info: { role: 'user' }, parts: [] }] }) },
    app: { log: async () => { throw new Error('app.log endpoint down') } },
  }
  const origConsoleError = console.error
  const captured: string[] = []
  console.error = (...args: unknown[]) => { captured.push(args.map(String).join(' ')) }
  try {
    const { plugin } = await freshPlugin()
    const hooks = await plugin({ client, directory: '/tmp/proj' })
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_logdown' } } })
  } finally {
    console.error = origConsoleError
  }
  expect((active as unknown as { received: Received[] }).received.length).toBe(1)
  expect(captured.some((m) => m.includes('[memside]') && m.includes('capture ok'))).toBe(true)
})
```

注意：`afterEach` 已在顶部 import（现有文件第一行已 import `afterEach`）；`serveDaemon` 内第二个 `afterEach`（harness 段的 `active?.stop()`）与现有 `afterEach(() => { globalThis.fetch = realFetch })` 合并——删掉后者，新增前者（同一文件允许多个 afterEach，分两条写即可）。第一段替换体里的 placeholder 行是笔误防护，**不要**写入文件；以五条完整测试体为准。

- [ ] **Step 2: 跑测试确认 RED**

Run: `bun test tests/plugin-opencode.test.ts`
Expected: FAIL——新文本守卫 `from 'node:http'` 不匹配、`process.env.NO_PROXY` 仍存在、活体测试连的是真 server 而 plugin 还在 fetch（拦截已删）→ 全红。

- [ ] **Step 3: 实现 plugin（GREEN）**

`opencode-plugin/memside.js` 改为以下完整内容（唯一 export 仍是 default；中文注释解释 why）：

```js
import { request as httpRequestImpl } from 'node:http'

const PORT = () => process.env.MEMSIDE_PORT || __MEMSIDE_PORT__;
const BASE = () => `http://127.0.0.1:${PORT()}`;
const INJECT_MARK = '--- BEGIN INJECTED MEMORY ---';

// loopback 传输层：node:http 从不读取任何代理 env（HTTP_PROXY/HTTPS_PROXY/
// NO_PROXY 全不看），直连 127.0.0.1 是确定性行为。2026-08-04 事故链：bun fetch
// 在 opencode 运行时里代理解析于首个 fetch 固化、NO_PROXY 实证无效，loopback
// POST 被系统代理劫持返 502，TUI capture 静默全灭。详见
// docs/superpowers/specs/2026-08-04-capture-frontier-hardening-design.md §1.3/§4。
// 契约：连接错误 reject；HTTP 非 2xx 照常 resolve（调用方查 status 抛错）。
function httpRequest(url, opts = {}) {
  const { method = 'GET', body, headers, timeoutMs = 2000 } = opts;
  return new Promise((resolve, reject) => {
    const req = httpRequestImpl(url, { method, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
    if (body) req.write(body);
    req.end();
  });
}

// --- SDK 签名兼容（2026-08-03 事故；spec 2026-08-03-opencode-sdk-compat-design.md）---
// client.session.messages 签名在 opencode 版本间翻转：
//   1.15.x: { path: { id: sessionID } }
//   1.18+:  { sessionID, limit }（扁平；二进制内部调用即此形态）
// 双形态探测，记忆首个成功形态（flat 优先）。成功判据是 res.data 真值而非「没抛错」：
// 生成的 SDK 可能返回错误响应对象而非 throw（二进制内部对 session.get 显式传
// {throwOnError:true} 是反证）。limit:1000 仅 flat 携带（防默认分页截断；distill 侧
// 自有 12000 token 预算裁剪），path 形态保持 1.15.5 已验证原样。
// 注意：compat / shapeName / fetchSessionMessages 刻意保持模块私有，不得加任何具名导出——
// opencode 1.18.11 plugin 加载器遍历模块全部顶层具名符号，非函数直接 throw TypeError
// 中断插件加载，每个函数符号还会被当作 plugin 逐个调用（loader 报错原文见
// tests/plugin-opencode.test.ts「default-only 导出」守卫）。default-only 是唯一跨
// 1.15.x/1.18.x 安全的形态。
const compat = { rememberedShape: null };

function shapeName(shape) {
  return shape.path ? 'path' : 'flat';
}

async function fetchSessionMessages(client, sessionID) {
  const flat = { sessionID, limit: 1000 };
  const path = { path: { id: sessionID } };
  const shapes = compat.rememberedShape === 'path' ? [path, flat] : [flat, path];
  let firstError = null;
  for (let i = 0; i < shapes.length; i += 1) {
    try {
      const res = await client.session.messages(shapes[i]);
      if (res && res.data) {
        compat.rememberedShape = shapeName(shapes[i]);
        return { res, shape: shapeName(shapes[i]), fellBack: i > 0, firstError };
      }
      firstError = firstError ?? new Error(`session.messages returned no data (shape ${shapeName(shapes[i])})`);
    } catch (e) {
      firstError = firstError ?? e;
      await log(client, 'warn', `session.messages ${shapeName(shapes[i])} shape probe failed: ${String(e)}`, { sessionID, shape: shapeName(shapes[i]), error: String(e) });
    }
  }
  throw firstError ?? new Error('session.messages failed on all known shapes');
}

// 日志通道：opencode 官方文档 Logging 章节推荐 client.app.log（写入 opencode 日志文件；
// TUI 模式下 stderr 不可见，纯 console.error 用户看不到）。app.log 自身失败降级
// console.error。永不 throw——plugin 契约是 best-effort（不抛回 opencode）。
async function log(client, level, message, extra) {
  try {
    await client.app.log({ body: { service: 'memside', level, message, extra } });
  } catch (e1) {
    try {
      console.error(`[memside] (${level}) ${message}`, extra ?? '');
    } catch (e2) {
      console.error('[memside] log fallback also failed');
    }
  }
}

export default async function memsidePlugin({ client, directory }) {
  const cwd = directory;
  return {
    event: async ({ event }) => {
      if (event.type !== 'session.idle') return;
      const sessionID = event.properties?.sessionID ?? event.properties?.info?.id;
      if (!sessionID) {
        await log(client, 'error', 'session.idle without sessionID; capture skipped', { properties: event.properties ?? null });
        return;
      }
      try {
        const { res, shape, fellBack, firstError } = await fetchSessionMessages(client, sessionID);
        if (fellBack) {
          await log(client, 'warn', `session.messages flat shape failed, fell back to ${shape}`, { sessionID, firstError: String(firstError) });
        }
        const messages = Array.isArray(res.data) ? res.data : (res.data?.messages ?? []);
        const cap = await httpRequest(`${BASE()}/hooks/opencode/capture`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionID, cwd, messages }),
        });
        // 非 2xx = daemon 没收到（代理劫持/服务异常）：抛带状态码的错误走下方
        // catch 记 error 日志，绝不记 capture ok（2026-08-04 TUI 事故教训）。
        if (cap.status < 200 || cap.status >= 300) throw new Error(`capture endpoint returned HTTP ${cap.status}`);
        await log(client, 'info', `capture ok session=${sessionID} messages=${messages.length} shape=${shape}`, { sessionID, messages: messages.length, shape });
      } catch (e) {
        await log(client, 'error', `capture failed session=${sessionID}: ${String(e)}`, { sessionID, error: String(e) });
      }
    },
    'experimental.chat.messages.transform': async (_input, output) => {
      try {
        if (!output.messages?.length) return;
        const firstUser = output.messages.find(m => m.info?.role === 'user');
        if (!firstUser?.parts?.length) return;
        if (firstUser.parts.some(p => p.type === 'text' && p.text?.includes(INJECT_MARK))) return; // idempotency guard
        const res = await httpRequest(`${BASE()}/hooks/opencode/inject?cwd=${encodeURIComponent(cwd)}`);
        if (res.status < 200 || res.status >= 300) throw new Error(`inject endpoint returned HTTP ${res.status}`);
        const { block } = JSON.parse(res.body);
        if (!block) return;
        // 仅注入纯 text part：不 spread 原 first part（ref），否则非 text part 的 tool/callID 等
        // 外来字段会泄漏进注入的 text part（final-review Minor #7）。
        firstUser.parts.unshift({ type: 'text', text: block });
      } catch (e) {
        await log(client, 'error', `inject transform failed: ${String(e)}`, { error: String(e) });
      }
    },
  };
}
```

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `bun test tests/plugin-opencode.test.ts`
Expected: PASS（全部测试绿）。

- [ ] **Step 5: 全量门槛 + 提交**

Run: `bun run typecheck; if ($?) { bun test }`
Expected: typecheck 干净；全量测试绿。

```powershell
git add opencode-plugin/memside.js tests/plugin-opencode.test.ts
git commit -m "fix(opencode-plugin): loopback 传输换 node:http——代理 env 免疫，终结 TUI capture 502"
```

- [ ] **Step 6: push + PR + 真机冒烟**

```powershell
git push -u origin fix/opencode-loopback-transport
gh pr create --base master --title "fix(opencode-plugin): loopback 传输换 node:http——代理 env 免疫" --body "spec: 2026-08-04-capture-frontier-hardening §4；活体测试（真本地 server）替代 fetch 拦截；NO_PROXY hack 移除。真机冒烟：合并后重装插件 + 重启 opencode，一轮交互后日志出 capture ok 且库出 runtime=opencode job。"
```

PR 合并后真机冒烟（spec §9 硬门槛）：

```powershell
bun run src/cli.ts install   # 重装插件到 ~/.config/opencode/memside-opencode/
```

确认 daemon 在跑（`Invoke-WebRequest http://127.0.0.1:7777/api/status` 返 200；不在则
`Start-Process cmd.exe -ArgumentList "/c","bun run src\cli.ts start > %TEMP%\memside-daemon.log 2>&1" -WorkingDirectory <repo> -WindowStyle Hidden`）。
用户重启 opencode、自然走一轮交互后验证两条：

```powershell
Select-String -Path "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'message="capture (ok|failed)' | Select-Object -Last 3 | ForEach-Object { $_.Line }
```

Expected: 最新一条含 `capture ok session=<当前会话>`；且 DB 出 job：

```powershell
# 临时脚本查 memory_distill_jobs 最新 runtime='opencode' 行（created_at 在冒烟时刻之后）
```

冒烟不过 = P1 不交付（回查 opencode.log 的 capture failed 原因）。

---

## Phase P2 — 健康哨兵（分支 `feat/capture-health-sentinel`，从合并 P1 后的 origin/master 切）

### Task 2: evalCaptureHealth 纯函数

**Files:**
- Create: `src/health.ts`
- Test: `tests/health.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `evalCaptureHealth(now, lastCaptureAt, lastActivityAt, thresholds?) -> 'ok'|'silent'|'idle'`；`createHealthTracker(thresholds?) -> { markCapture(ts?), markActivity(ts?), snapshot(now?) }`；`healthThresholdsFromEnv(env?)`；常量 `CAPTURE_SILENCE_MS=900000`、`ACTIVITY_WINDOW_MS=1800000`。Task 3/4 依赖这些签名。

- [ ] **Step 1: 写失败测试** `tests/health.test.ts`：

```ts
import { test, expect } from 'bun:test'
import { evalCaptureHealth, createHealthTracker, healthThresholdsFromEnv, CAPTURE_SILENCE_MS, ACTIVITY_WINDOW_MS } from '@/health'

const MIN = 60_000
const now = 10_000_000_000

test('capture 在阈值内 -> ok', () => {
  expect(evalCaptureHealth(now, now - CAPTURE_SILENCE_MS, null)).toBe('ok') // 恰好压线算 ok
  expect(evalCaptureHealth(now, now - 1, null)).toBe('ok')
})

test('超阈值无 capture 且近期有活动（活动晚于 capture）-> silent', () => {
  const cap = now - CAPTURE_SILENCE_MS - 1
  const act = now - 1 * MIN
  expect(evalCaptureHealth(now, cap, act)).toBe('silent')
})

test('从未 capture 但有活动 -> silent（null capture = 无限旧，事故形态）', () => {
  expect(evalCaptureHealth(now, null, now - 1 * MIN)).toBe('silent')
})

test('活动早于最近 capture -> 不 silent（capture 已是最新事实）', () => {
  const cap = now - CAPTURE_SILENCE_MS - 1
  const act = cap - 1 * MIN
  expect(evalCaptureHealth(now, cap, act)).toBe('idle')
})

test('无活动或活动过旧 -> idle', () => {
  expect(evalCaptureHealth(now, null, null)).toBe('idle')
  expect(evalCaptureHealth(now, now - 20 * MIN, now - ACTIVITY_WINDOW_MS - 1)).toBe('idle')
})

test('自定义阈值（env 覆盖冒烟用途）', () => {
  const t = { silenceMs: 100, activityWindowMs: 60_000 }
  expect(evalCaptureHealth(now, now - 101, now - 10, t)).toBe('silent')
  expect(evalCaptureHealth(now, now - 100, now - 10, t)).toBe('ok')
})

test('healthThresholdsFromEnv: 合法正数覆盖，非法回默认', () => {
  expect(healthThresholdsFromEnv({ MEMSIDE_HEALTH_SILENCE_MS: '5000', MEMSIDE_HEALTH_ACTIVITY_MS: '9000' }))
    .toEqual({ silenceMs: 5000, activityWindowMs: 9000 })
  expect(healthThresholdsFromEnv({ MEMSIDE_HEALTH_SILENCE_MS: 'abc', MEMSIDE_HEALTH_ACTIVITY_MS: '-1' }))
    .toEqual({ silenceMs: CAPTURE_SILENCE_MS, activityWindowMs: ACTIVITY_WINDOW_MS })
  expect(healthThresholdsFromEnv({})).toEqual({ silenceMs: CAPTURE_SILENCE_MS, activityWindowMs: ACTIVITY_WINDOW_MS })
})

test('createHealthTracker: mark + snapshot 状态机', () => {
  const tr = createHealthTracker({ silenceMs: 100, activityWindowMs: 60_000 })
  expect(tr.snapshot(now)).toEqual({ state: 'idle', lastCaptureAt: null, lastActivityAt: null })
  tr.markActivity(now)
  expect(tr.snapshot(now + 200).state).toBe('silent')
  tr.markCapture(now + 250)
  expect(tr.snapshot(now + 260)).toEqual({ state: 'ok', lastCaptureAt: now + 250, lastActivityAt: now })
})
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `bun test tests/health.test.ts`
Expected: FAIL（模块 `@/health` 不存在）。

- [ ] **Step 3: 实现** `src/health.ts`：

```ts
/**
 * Capture 边界健康判定（spec 2026-08-04-capture-frontier-hardening §5.2）。
 * 判断在 daemon、plugin 只投递事实：opencode 活跃（inject/error-report 到达）
 * 但长时间无 capture -> silent 红灯。纯函数 + 可注入阈值（真机冒烟用 env 缩短）。
 */

export type CaptureHealthState = 'ok' | 'silent' | 'idle'

export const CAPTURE_SILENCE_MS = 15 * 60 * 1000
export const ACTIVITY_WINDOW_MS = 30 * 60 * 1000

export interface HealthThresholds {
  silenceMs: number
  activityWindowMs: number
}

/** env 覆盖仅接受正有限数；其余回默认（生产值即默认值）。 */
export function healthThresholdsFromEnv(env: Record<string, string | undefined> = process.env): HealthThresholds {
  const pick = (v: string | undefined, dflt: number) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : dflt
  }
  return {
    silenceMs: pick(env.MEMSIDE_HEALTH_SILENCE_MS, CAPTURE_SILENCE_MS),
    activityWindowMs: pick(env.MEMSIDE_HEALTH_ACTIVITY_MS, ACTIVITY_WINDOW_MS),
  }
}

/**
 * null 语义（spec §5.2 显式化）：lastCaptureAt === null 视为无限旧——
 * 「一直活跃但从未 capture 成功」正是本次事故形态，判 silent 不判 idle。
 */
export function evalCaptureHealth(
  now: number,
  lastCaptureAt: number | null,
  lastActivityAt: number | null,
  t: HealthThresholds = { silenceMs: CAPTURE_SILENCE_MS, activityWindowMs: ACTIVITY_WINDOW_MS },
): CaptureHealthState {
  if (lastCaptureAt !== null && now - lastCaptureAt <= t.silenceMs) return 'ok'
  if (
    lastActivityAt !== null &&
    now - lastActivityAt <= t.activityWindowMs &&
    (lastCaptureAt === null || lastActivityAt > lastCaptureAt)
  ) return 'silent'
  return 'idle'
}

export interface HealthSnapshot {
  state: CaptureHealthState
  lastCaptureAt: number | null
  lastActivityAt: number | null
}

export interface HealthTracker {
  markCapture(ts?: number): void
  markActivity(ts?: number): void
  snapshot(now?: number): HealthSnapshot
}

/** daemon 进程内两个时间戳的持有者（内存态；重启归零重新观察，spec §5.2）。 */
export function createHealthTracker(t?: Partial<HealthThresholds>): HealthTracker {
  const thresholds: HealthThresholds = {
    silenceMs: t?.silenceMs ?? CAPTURE_SILENCE_MS,
    activityWindowMs: t?.activityWindowMs ?? ACTIVITY_WINDOW_MS,
  }
  let lastCaptureAt: number | null = null
  let lastActivityAt: number | null = null
  return {
    markCapture: (ts) => { lastCaptureAt = Math.max(lastCaptureAt ?? 0, ts ?? Date.now()) },
    markActivity: (ts) => { lastActivityAt = Math.max(lastActivityAt ?? 0, ts ?? Date.now()) },
    snapshot: (now) => ({
      state: evalCaptureHealth(now ?? Date.now(), lastCaptureAt, lastActivityAt, thresholds),
      lastCaptureAt,
      lastActivityAt,
    }),
  }
}
```

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `bun test tests/health.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/health.ts tests/health.test.ts
git commit -m "feat(health): evalCaptureHealth 纯函数 + tracker（capture 静默判定）"
```

### Task 3: plugin_error_reports 表 + 存取函数

**Files:**
- Modify: `src/db/schema.ts`（加 drizzle 表）
- Modify: `src/db/client.ts`（建表 DDL + schema 注册）
- Modify: `src/health.ts`（加存取函数）
- Test: `tests/health-store.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `src/health.ts`
- Produces: `pluginErrorReports` drizzle 表；`insertPluginError(db, row, retention?)`（环裁，默认 200）；`latestPluginError(db) -> row | null`。Task 4 错误信箱路由依赖。

- [ ] **Step 1: 写失败测试** `tests/health-store.test.ts`：

```ts
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { insertPluginError, latestPluginError } from '@/health'

const root = join(import.meta.dir, '.tmp-health-store')
let dirCount = 0
let db: ReturnType<typeof openDb>

beforeEach(() => {
  mkdirSync(root, { recursive: true })
  db = openDb(join(root, `t${++dirCount}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`))
})
afterEach(() => { db.$client.close() })

test('insertPluginError + latestPluginError 往返', async () => {
  await insertPluginError(db, { runtime: 'opencode', message: 'capture failed session=ses_x: HTTP 502', extraJson: '{"a":1}', ts: 123 })
  await insertPluginError(db, { runtime: 'opencode', message: '第二条', extraJson: null, ts: 456 })
  const latest = await latestPluginError(db)
  expect(latest?.message).toBe('第二条')
  expect(latest?.ts).toBe(456)
})

test('latestPluginError 空表 -> null', async () => {
  expect(await latestPluginError(db)).toBeNull()
})

test('环形保留：超过 retention 裁最老', async () => {
  for (let i = 0; i < 7; i += 1) {
    await insertPluginError(db, { runtime: 'opencode', message: `m${i}`, extraJson: null, ts: i }, 5)
  }
  const latest = await latestPluginError(db)
  expect(latest?.message).toBe('m6')
  const count = (db.$client.query('SELECT COUNT(*) AS n FROM plugin_error_reports').get() as { n: number }).n
  expect(count).toBe(5)
})
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `bun test tests/health-store.test.ts`
Expected: FAIL（表/函数不存在）。

- [ ] **Step 3: 实现**

`src/db/schema.ts` 末尾（`appSettings` 之后）追加：

```ts
export const pluginErrorReports = sqliteTable(
  'plugin_error_reports',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runtime: text('runtime').notNull(),
    message: text('message').notNull(),
    extraJson: text('extra_json'),
    ts: integer('ts').notNull(),
  },
  (t) => ({ tsIdx: index('idx_plugin_error_reports_ts').on(t.ts) }),
)
```

`src/db/client.ts`：import 行加 `pluginErrorReports`；`drizzle(raw, { schema: { ... } })` 的 schema 对象加 `pluginErrorReports`；bootstrap DDL 块（`CREATE TABLE IF NOT EXISTS app_settings ...` 之后、反引号结束前）追加：

```sql
    CREATE TABLE IF NOT EXISTS plugin_error_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runtime TEXT NOT NULL,
      message TEXT NOT NULL,
      extra_json TEXT,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_plugin_error_reports_ts ON plugin_error_reports(ts);
```

`src/health.ts` 顶部 import 追加 `import { desc, sql } from 'drizzle-orm'`、`import type { DbClient } from '@/db/client'`、`import { pluginErrorReports } from '@/db/schema'`（只用 desc/sql；多 import 未用符号 typecheck 会红），文件末尾追加：

```ts
export interface PluginErrorRow {
  id: number
  runtime: string
  message: string
  extraJson: string | null
  ts: number
}

const ERROR_REPORT_RETENTION = 200

/** 错误信箱写入 + 环形保留（spec §5.1：只留最近 N 条，防错误风暴刷满）。 */
export async function insertPluginError(
  db: DbClient,
  row: { runtime: string; message: string; extraJson?: string | null; ts: number },
  retention: number = ERROR_REPORT_RETENTION,
): Promise<void> {
  await db.insert(pluginErrorReports).values({
    runtime: row.runtime, message: row.message, extraJson: row.extraJson ?? null, ts: row.ts,
  })
  await db.run(sql`DELETE FROM plugin_error_reports WHERE id NOT IN (SELECT id FROM plugin_error_reports ORDER BY id DESC LIMIT ${retention})`)
}

/** 最近一条 plugin error（/api/status 透出）；空表返 null。 */
export async function latestPluginError(db: DbClient): Promise<PluginErrorRow | null> {
  const rows = await db.select().from(pluginErrorReports).orderBy(desc(pluginErrorReports.id)).limit(1).all()
  const r = rows[0]
  if (!r) return null
  return { id: r.id, runtime: r.runtime, message: r.message, extraJson: r.extraJson, ts: r.ts }
}
```

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `bun test tests/health-store.test.ts tests/schema.test.ts`
Expected: PASS（schema 回归测试也过）。

- [ ] **Step 5: 提交**

```powershell
git add src/db/schema.ts src/db/client.ts src/health.ts tests/health-store.test.ts
git commit -m "feat(health): plugin_error_reports 错误信箱表 + 环形保留存取"
```

### Task 4: server 接线（tracker + 三路由 + status 扩展）

**Files:**
- Modify: `src/server.ts`（AppDeps + capture/inject 打点 + error-report 路由 + /api/status）
- Test: `tests/server-health.test.ts`

**Interfaces:**
- Consumes: Task 2 `createHealthTracker`/`healthThresholdsFromEnv`；Task 3 `insertPluginError`/`latestPluginError`
- Produces: `AppDeps.healthTracker?: HealthTracker`（缺省 = createHealthTracker(healthThresholdsFromEnv())）；`/api/status` 新字段 `opencodeHealth: HealthSnapshot` + `lastPluginError: {message, ts} | null`。Task 6 web 端依赖这两个字段。

- [ ] **Step 1: 写失败测试** `tests/server-health.test.ts`（beforeEach 模式同 `tests/server.test.ts` 的 EBUSY-safe 写法）：

```ts
import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { createHealthTracker } from '@/health'
import { ClaudeCodeAdapter } from '@/adapter/claudeCode'
import { OpencodeAdapter } from '@/adapter/opencode'
import { createApp } from '@/server'

const root = join(import.meta.dir, '.tmp-server-health')
let dir = ''
let db: ReturnType<typeof openDb>
let app: ReturnType<typeof createApp>
let broadcastCalls: unknown[]

beforeAll(() => { rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true }) })

function makeApp(tracker = createHealthTracker({ silenceMs: 50, activityWindowMs: 60_000 })) {
  return createApp({
    db, adapter: new ClaudeCodeAdapter(db), opencodeAdapter: new OpencodeAdapter(db),
    enqueueDistillJob: async () => ({ jobId: 'j', nextRunAt: 0 }),
    broadcast: (msg: unknown) => { broadcastCalls.push(msg) },
    healthTracker: tracker,
  })
}

beforeEach(() => {
  dir = join(root, Math.random().toString(36).slice(2))
  mkdirSync(dir, { recursive: true })
  db = openDb(join(dir, 't.db'))
  broadcastCalls = []
  app = makeApp()
})
afterEach(() => { db.$client.close() })

async function req(path: string, init?: RequestInit) {
  const res = await app.fetch(new Request(`http://x${path}`, init))
  return { status: res.status, body: await res.json().catch(() => null) }
}

test('capture POST 打点：/api/status opencodeHealth.state=ok', async () => {
  await req('/hooks/opencode/capture', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'ses_h1', cwd: 'C:\\p', messages: [] }),
  })
  const st = await req('/api/status')
  expect(st.body.opencodeHealth.state).toBe('ok')
  expect(st.body.opencodeHealth.lastCaptureAt).toBeGreaterThan(0)
})

test('只有活动无 capture -> silent（短阈值 tracker）', async () => {
  const r1 = await req('/hooks/opencode/inject?cwd=C%3A%5Cp')
  expect(r1.status).toBe(200)
  await new Promise((r) => setTimeout(r, 60))
  const st = await req('/api/status')
  expect(st.body.opencodeHealth.state).toBe('silent')
})

test('从未有请求 -> idle', async () => {
  const st = await req('/api/status')
  expect(st.body.opencodeHealth.state).toBe('idle')
  expect(st.body.lastPluginError).toBeNull()
})

test('error-report 入库 + status 透出 + 打 activity 点', async () => {
  const r = await req('/hooks/opencode/error-report', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runtime: 'opencode', message: 'capture failed session=ses_x: HTTP 502', extra: { a: 1 }, ts: 1000 }),
  })
  expect(r.status).toBe(202)
  const st = await req('/api/status')
  expect(st.body.lastPluginError.message).toBe('capture failed session=ses_x: HTTP 502')
  expect(st.body.lastPluginError.ts).toBe(1000)
  expect(st.body.opencodeHealth.lastActivityAt).toBeGreaterThan(0)
})

test('error-report 畸形 JSON -> 兜底行可见（失败路径不许静默丢弃）', async () => {
  const r = await req('/hooks/opencode/error-report', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken',
  })
  expect(r.status).toBe(202)
  const st = await req('/api/status')
  expect(st.body.lastPluginError.message).toBe('invalid error report payload')
})

test('error-report message 非字符串 -> 兜底行', async () => {
  await req('/hooks/opencode/error-report', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 42 }),
  })
  const st = await req('/api/status')
  expect(st.body.lastPluginError.message).toBe('invalid error report payload')
})
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `bun test tests/server-health.test.ts`
Expected: FAIL（healthTracker dep 不存在、字段缺失）。

- [ ] **Step 3: 实现** `src/server.ts` 改动：

1) imports 追加：`import { createHealthTracker, healthThresholdsFromEnv, insertPluginError, latestPluginError, type HealthTracker } from '@/health'`。

2) `AppDeps` 接口加（放 `testConnection?` 之后）：

```ts
  /** capture 边界健康追踪（spec §5.2）。缺省按启动时 env 阈值自建 tracker
   * （MEMSIDE_HEALTH_SILENCE_MS / MEMSIDE_HEALTH_ACTIVITY_MS，真机冒烟缩短用）。 */
  healthTracker?: HealthTracker
```

3) `createApp` 函数体开头（`const app = new Hono()` 之后）加：

```ts
  const health = deps.healthTracker ?? createHealthTracker(healthThresholdsFromEnv())
```

4) `app.get('/hooks/opencode/inject', ...)` handler 第一行后加 `health.markActivity()`。

5) `app.post('/hooks/opencode/capture', ...)` handler 第一行（`const body = await c.req.json()...` 之前）加 `health.markCapture()`。

6) 在 capture 路由之后新增 error-report 路由：

```ts
  // opencode plugin 错误信箱（spec §5.1）：plugin 的 log(level='error') fire-and-forget
  // 投递到这里，Web UI 顶部直显原话。202 ack；畸形 payload 存兜底行——
  // 「失败可见」的路由自身不许静默丢弃。
  app.post('/hooks/opencode/error-report', async (c) => {
    health.markActivity()
    let parsed: { runtime?: unknown; message?: unknown; extra?: unknown; ts?: unknown } = {}
    try { parsed = await c.req.json() } catch { parsed = {} }
    const message = typeof parsed.message === 'string' && parsed.message.trim() !== ''
      ? parsed.message
      : 'invalid error report payload'
    try {
      await insertPluginError(deps.db, {
        runtime: typeof parsed.runtime === 'string' ? parsed.runtime : 'opencode',
        message,
        extraJson: parsed.extra === undefined ? null : JSON.stringify(parsed.extra),
        ts: typeof parsed.ts === 'number' ? parsed.ts : Date.now(),
      })
    } catch (e) {
      deps.broadcast({ type: 'plugin.error.persist.failed', error: String(e) })
    }
    return c.json({ ok: true }, 202)
  })
```

7) `/api/status` handler：`const now = Date.now()` 之后、return 之前加：

```ts
    let lastPluginError: { message: string; ts: number } | null = null
    try {
      const row = await latestPluginError(deps.db)
      if (row) lastPluginError = { message: row.message, ts: row.ts }
    } catch { /* 读失败降级 null，status 端点不得 500 */ }
```

return 对象追加两个字段：

```ts
      opencodeHealth: health.snapshot(now),
      lastPluginError,
```

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `bun test tests/server-health.test.ts tests/server.test.ts tests/server-opencode.test.ts`
Expected: PASS（既有 server 测试无回归）。

- [ ] **Step 5: 提交**

```powershell
git add src/server.ts tests/server-health.test.ts
git commit -m "feat(server): 健康打点 + 错误信箱路由 + /api/status 透出 opencodeHealth/lastPluginError"
```

### Task 5: plugin 错误投递

**Files:**
- Modify: `opencode-plugin/memside.js`
- Modify: `tests/plugin-opencode.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `httpRequest`；Task 4 的 `POST /hooks/opencode/error-report`
- Produces: `log()` 在 error 级时 best-effort 投递错误到信箱。

- [ ] **Step 1: 写失败测试**——`tests/plugin-opencode.test.ts` 追加：

```ts
test('error 日志同步投递信箱（capture 失败时 daemon 收到 error-report）', async () => {
  active = serveDaemon({ capture: () => new Response('Bad Gateway', { status: 502 }) })
  const { client } = makeFakeClient({ flat: () => ({ data: [{ info: { role: 'user' }, parts: [] }] }) })
  const { plugin } = await freshPlugin()
  const hooks = await plugin({ client, directory: '/tmp/proj' })
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_report' } } })
  // 信箱投递是 fire-and-forget，等一帧让它落地
  await new Promise((r) => setTimeout(r, 50))
  const reports = (active as unknown as { received: Received[] }).received
    .filter((r) => r.path === '/hooks/opencode/error-report')
  expect(reports.length).toBe(1)
  const body = reports[0].body as { runtime?: string; message?: string }
  expect(body.runtime).toBe('opencode')
  expect(body.message).toContain('capture failed session=ses_report')
  expect(body.message).toContain('502')
})

test('info/warn 日志不投递信箱（只 error 进信箱）', async () => {
  active = serveDaemon()
  const { client } = makeFakeClient({ flat: () => ({ data: [{ info: { role: 'user' }, parts: [] }] }) })
  const { plugin } = await freshPlugin()
  const hooks = await plugin({ client, directory: '/tmp/proj' })
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_ok' } } })
  await new Promise((r) => setTimeout(r, 50))
  const reports = (active as unknown as { received: Received[] }).received
    .filter((r) => r.path === '/hooks/opencode/error-report')
  expect(reports.length).toBe(0)
})

test('error 级日志投递信箱（源码守卫：仅 error 级 + fire-and-forget 不带 await 阻塞）', () => {
  expect(js).toContain('/hooks/opencode/error-report')
  expect(js).toMatch(/level === 'error'/)
})
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `bun test tests/plugin-opencode.test.ts`
Expected: 新三条 FAIL，其余绿。

- [ ] **Step 3: 实现**——`opencode-plugin/memside.js` 的 `log()` 函数改为：

```js
// 日志通道：opencode 官方文档 Logging 章节推荐 client.app.log（写入 opencode 日志文件；
// TUI 模式下 stderr 不可见，纯 console.error 用户看不到）。app.log 自身失败降级
// console.error。永不 throw——plugin 契约是 best-effort（不抛回 opencode）。
// error 级额外投递 daemon 错误信箱（spec §5.1）：fire-and-forget、不 await、
// 投递失败 console.error 一句——让 Web UI 分钟级看见插件侧错误原话。
async function log(client, level, message, extra) {
  try {
    await client.app.log({ body: { service: 'memside', level, message, extra } });
  } catch (e1) {
    try {
      console.error(`[memside] (${level}) ${message}`, extra ?? '');
    } catch (e2) {
      console.error('[memside] log fallback also failed');
    }
  }
  if (level === 'error') {
    httpRequest(`${BASE()}/hooks/opencode/error-report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runtime: 'opencode', message, extra: extra ?? null, ts: Date.now() }),
    }).catch(() => { console.error('[memside] error-report 投递失败'); });
  }
}
```

注意：投递 promise **不 await**（不阻塞钩子）；`.catch()` 带 console.error（失败有声）。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `bun test tests/plugin-opencode.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add opencode-plugin/memside.js tests/plugin-opencode.test.ts
git commit -m "feat(opencode-plugin): error 日志投递 daemon 错误信箱（fire-and-forget）"
```

### Task 6: Web API + 顶部健康横幅

**Files:**
- Modify: `src/web/api.ts`（MemsideStatus 扩字段）
- Modify: `src/web/App.tsx`（状态栏 opencode 健康段 + silent 红字插件错误）
- Test: `tests/web-api.test.ts`（加 case）
- Test: `tests/web-ui.test.ts`（加文本守卫）

**Interfaces:**
- Consumes: Task 4 的 `/api/status` 新字段
- Produces: UI 可见性闭环。

- [ ] **Step 1: 写失败测试**

`tests/web-api.test.ts` 按该文件既有 `getStatus` 测试模式追加（假 fetch 返回含新字段的 status，断言透传）：

```ts
test('getStatus 透出 opencodeHealth + lastPluginError', async () => {
  const fake: FetchLike = async () => new Response(JSON.stringify({
    events: 0, jobs: {}, memories: {}, discards: 0,
    lastError: null,
    opencodeHealth: { state: 'silent', lastCaptureAt: null, lastActivityAt: 123 },
    lastPluginError: { message: 'capture failed: HTTP 502', ts: 123 },
  }), { status: 200 })
  const st = await getStatus(fake)
  expect(st.opencodeHealth?.state).toBe('silent')
  expect(st.lastPluginError?.message).toBe('capture failed: HTTP 502')
})
```

（若该文件无现成 `FetchLike` import，按其顶部既有 import 行补。）

`tests/web-ui.test.ts` 追加：

```ts
test('App.tsx 渲染 opencode 健康状态 + 静默告警红字（source text）', () => {
  expect(src).toContain('opencodeHealth')
  expect(src).toContain('capture 正常')
  expect(src).toContain('capture 中断')
  expect(src).toContain('未连接')
  expect(src).toContain('lastPluginError')
})
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `bun test tests/web-api.test.ts tests/web-ui.test.ts`
Expected: 新 case FAIL。

- [ ] **Step 3: 实现**

`src/web/api.ts` 的 `MemsideStatus` 接口追加两个可选字段：

```ts
  /** spec §5.2：capture 边界健康。老 daemon 无此字段 -> undefined -> UI 不渲染。 */
  opencodeHealth?: { state: 'ok' | 'silent' | 'idle'; lastCaptureAt: number | null; lastActivityAt: number | null }
  /** spec §5.1：最近一条 plugin 错误（错误信箱）。 */
  lastPluginError?: { message: string; ts: number } | null
```

`src/web/App.tsx` 状态栏 `{status.lastError ? (...)}` 块**之前**插入：

```tsx
            {' · '}
            <span style={{ color: status.opencodeHealth?.state === 'silent' ? '#c00' : status.opencodeHealth?.state === 'ok' ? '#080' : '#888' }}>
              opencode: {status.opencodeHealth?.state === 'ok'
                ? 'capture 正常'
                : status.opencodeHealth?.state === 'silent'
                  ? 'capture 中断'
                  : '未连接'}
            </span>
            {status.opencodeHealth?.state === 'silent' && status.lastPluginError ? (
              <div style={{ marginTop: 6, color: '#c00' }}>
                插件错误: {status.lastPluginError.message.slice(0, 160)}
              </div>
            ) : null}
```

（位置在既有 `<span>记忆: ...` 行的 `</span>` 之后、`{status.lastError ?` 之前；保持既有 `{' · '}` 分隔风格。）

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `bun test tests/web-api.test.ts tests/web-ui.test.ts`
Expected: PASS。

- [ ] **Step 5: 全量门槛 + 提交**

Run: `bun run typecheck; if ($?) { bun test }`
Expected: 全绿。

```powershell
git add src/web/api.ts src/web/App.tsx tests/web-api.test.ts tests/web-ui.test.ts
git commit -m "feat(web): 顶部状态栏 opencode 健康灯 + silent 时直显插件错误原话"
```

- [ ] **Step 6: push + PR + 真机冒烟**

```powershell
git push -u origin feat/capture-health-sentinel
gh pr create --base master --title "feat(health): capture 错误信箱 + 静默告警（Web UI 分钟级可见）" --body "spec §5。错误信箱 + evalCaptureHealth + 状态栏健康灯。冒烟：短阈值 daemon + curl 走 silent->ok 全态；curl 投递合成错误 UI 可见。"
```

PR 合并后真机冒烟（spec §9，两步）：

1) 错误信箱：daemon 在跑时
```powershell
curl.exe -s --noproxy "*" -X POST http://127.0.0.1:7777/hooks/opencode/error-report -H "content-type: application/json" -d '{\"runtime\":\"opencode\",\"message\":\"冒烟合成错误\",\"ts\":0}'
Invoke-WebRequest -Uri http://127.0.0.1:7777/api/status -UseBasicParsing | Select-Object -ExpandProperty Content
```
Expected: status JSON 的 lastPluginError.message = 冒烟合成错误；Web UI（5173 或 daemon 托管页）出现该红字（需先触发 silent 态才显示，见下一步）。

2) 静默告警：用短阈值重启 daemon（先停旧进程，任务管理器结束 bun 或 `Stop-Process`），
```powershell
Start-Process cmd.exe -ArgumentList "/c","set MEMSIDE_HEALTH_SILENCE_MS=20000&& set MEMSIDE_HEALTH_ACTIVITY_MS=600000&& bun run src\cli.ts start > %TEMP%\memside-daemon.log 2>&1" -WorkingDirectory <repo> -WindowStyle Hidden
curl.exe -s --noproxy "*" "http://127.0.0.1:7777/hooks/opencode/inject?cwd=C%3A%5Csmoke"
Start-Sleep -Seconds 25
(Invoke-WebRequest -Uri http://127.0.0.1:7777/api/status -UseBasicParsing).Content
```
Expected: `opencodeHealth.state` = `silent`；UI 红灯 + 步骤 1 的错误原话。再
```powershell
curl.exe -s --noproxy "*" -X POST http://127.0.0.1:7777/hooks/opencode/capture -H "content-type: application/json" -d '{\"sessionId\":\"ses_smoke\",\"cwd\":\"C:\\smoke\",\"messages\":[]}'
```
Expected: state 转 `ok`、UI 转绿。冒烟完把 daemon 换回无 env 的正常启动。

- [ ] **Step 7: STATE.md**——P1/P2 两段合并结果 + 冒烟结论记入 STATE.md，单独 commit
`docs(state): capture 边界加固 P1/P2（node:http 传输 + 健康哨兵）`，并入本 PR（push 前完成则直接进分支；已开 PR 则追 commit）。

---

## Phase P3 — daemon 托管（分支 `feat/daemon-service-ui`，从合并 P2 后的 origin/master 切）

### Task 7: service 纯函数（任务 XML + schtasks 输出解析）

**Files:**
- Create: `src/service.ts`
- Test: `tests/service.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `TASK_NAME`、`TaskSpec {bunPath, repoDir, port}`、`buildTaskXml(spec) -> string`、`parseSchtasksQuery(stdout, exitCode) -> {registered, status?, lastRunTime?}`。Task 8 依赖。

- [ ] **Step 1: 写失败测试** `tests/service.test.ts`：

```ts
import { test, expect } from 'bun:test'
import { TASK_NAME, buildTaskXml, parseSchtasksQuery, buildCommandPreview } from '@/service'

const spec = { bunPath: 'C:\\Users\\admin\\.bun\\bin\\bun.exe', repoDir: 'C:\\Users\\admin\\Desktop\\memside', port: 7777 }

test('buildTaskXml: 登录触发 + 失败自动重启 + 命令/工作目录', () => {
  const xml = buildTaskXml(spec)
  expect(xml).toContain(TASK_NAME)
  expect(xml).toContain('<LogonTrigger')
  expect(xml).toContain('<Interval>PT1M</Interval>')
  expect(xml).toContain('<RestartCount>3</RestartCount>')
  expect(xml).toContain(`<Command>"${spec.bunPath}"</Command>`)
  expect(xml).toContain('run')
  expect(xml).toContain('src\\cli.ts')
  expect(xml).toContain(`start`)
  expect(xml).toContain(`<WorkingDirectory>${spec.repoDir}</WorkingDirectory>`)
  expect(xml).toContain('<LogonType>InteractiveToken</LogonType>')
})

test('parseSchtasksQuery: 已注册（LIST 输出 fixture）', () => {
  const out = [
    'Folder: \\',
    'HostName:                             DESKTOP-X',
    'TaskName:                             \\memside-daemon',
    'Next Run Time:                        2026/8/5 09:00:00',
    'Status:                               Ready',
    'Last Run Time:                        2026/8/4 09:00:01',
  ].join('\r\n')
  expect(parseSchtasksQuery(out, 0)).toEqual({ registered: true, status: 'Ready', lastRunTime: '2026/8/4 09:00:01' })
})

test('parseSchtasksQuery: 未注册（ERROR 输出）', () => {
  const out = 'ERROR: The system cannot find the file specified.'
  expect(parseSchtasksQuery(out, 1)).toEqual({ registered: false, status: null, lastRunTime: null })
})

test('parseSchtasksQuery: Running 状态透传', () => {
  const out = 'Status:                               Running\r\nLast Run Time:                        N/A'
  expect(parseSchtasksQuery(out, 0).status).toBe('Running')
})

test('buildCommandPreview: 完整命令行（UI 知情权）', () => {
  expect(buildCommandPreview(spec)).toBe(`"${spec.bunPath}" run "${spec.repoDir}\\src\\cli.ts" start`)
})
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `bun test tests/service.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现** `src/service.ts`：

```ts
/**
 * daemon 托管（spec §6）：Windows 任务计划程序封装。
 *
 * 硬约束（用户裁决）：**不静默自启**——注册任务只发生在 Web UI 显式操作
 * （POST /api/daemon-service/enable），install 命令永不触碰任务计划程序。
 * 失败必可见：schtasks 的 stderr 原样回传 UI。
 *
 * 本文件的纯函数部分（buildTaskXml / parseSchtasksQuery / buildCommandPreview）
 * 与进程调用（Task 8 的 createServiceManager）分离，单测不触碰系统配置。
 */

export const TASK_NAME = 'memside-daemon'

export interface TaskSpec {
  bunPath: string
  repoDir: string
  port: number
}

export function buildCommandPreview(spec: TaskSpec): string {
  return `"${spec.bunPath}" run "${spec.repoDir}\\src\\cli.ts" start`
}

/** 任务计划程序 2.0 XML：登录触发（当前用户交互登录，无需存密码）+
 * 失败后 1 分钟重启、至多 3 次 + StartWhenAvailable（错过触发补跑）。 */
export function buildTaskXml(spec: TaskSpec): string {
  const args = `run "${spec.repoDir}\\src\\cli.ts" start`
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>memside</Author>
    <Description>memside daemon (port ${spec.port}) - auto-start at logon, restart on failure. Managed via memside Web UI.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
    </RestartOnFailure>
    <RestartCount>3</RestartCount>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>"${spec.bunPath}"</Command>
      <Arguments>${args}</Arguments>
      <WorkingDirectory>${spec.repoDir}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`
}

export interface SchtasksQueryResult {
  registered: boolean
  status: string | null
  lastRunTime: string | null
}

/** 解析 `schtasks /Query /TN <name> /FO LIST /V` 输出。未注册时 schtasks
 * 以非零 exit code + "ERROR:" 行返回。字段名后跟若干空格再冒号值（LIST 格式）。 */
export function parseSchtasksQuery(stdout: string, exitCode: number): SchtasksQueryResult {
  if (exitCode !== 0 || /ERROR:/i.test(stdout)) {
    return { registered: false, status: null, lastRunTime: null }
  }
  const pick = (label: string): string | null => {
    const m = stdout.match(new RegExp(`${label}:\\s*(.+)`, 'i'))
    const v = m?.[1]?.trim()
    return v && v !== 'N/A' ? v : null
  }
  return { registered: true, status: pick('Status'), lastRunTime: pick('Last Run Time') }
}
```

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `bun test tests/service.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/service.ts tests/service.test.ts
git commit -m "feat(service): 任务计划程序 XML 生成 + schtasks 输出解析（纯函数）"
```

### Task 8: ServiceManager（spawn seam）

**Files:**
- Modify: `src/service.ts`
- Test: `tests/service.test.ts`（追加）

**Interfaces:**
- Consumes: Task 7 纯函数
- Produces: `ExecResult {exitCode, stdout, stderr}`、`ExecFn`、`ServiceOps {query, enable, disable, startNow}`、`createServiceManager(exec, spec) -> ServiceOps`。Task 9 路由依赖。

- [ ] **Step 1: 写失败测试**——`tests/service.test.ts` 追加：

```ts
import { createServiceManager, type ExecResult } from '@/service'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function fakeExec() {
  const calls: { cmd: string; args: string[] }[] = []
  let next: ExecResult = { exitCode: 0, stdout: '', stderr: '' }
  const fn = (cmd: string, args: string[]) => { calls.push({ cmd, args: [...args] }); return next }
  return { fn, calls, setNext: (r: ExecResult) => { next = r } }
}

test('enable: schtasks /Create /XML，XML 内容正确，成功/失败透传', () => {
  const e = fakeExec()
  const mgr = createServiceManager(e.fn, spec)
  const r = mgr.enable()
  expect(r.ok).toBe(true)
  expect(e.calls.length).toBe(1)
  expect(e.calls[0].cmd).toBe('schtasks')
  const args = e.calls[0].args
  expect(args.slice(0, 2)).toEqual(['/Create', '/F'])
  expect(args).toContain('/TN')
  expect(args[args.indexOf('/TN') + 1]).toBe('memside-daemon')
  expect(args).toContain('/XML')
  const xmlPath = args[args.indexOf('/XML') + 1]
  expect(xmlPath.startsWith(tmpdir()) || xmlPath.startsWith('C:')).toBe(true)
  const xml = readFileSync(xmlPath, 'utf-8')
  expect(xml).toContain('<LogonTrigger')
  expect(xml).toContain('memside')
  // 临时文件保留与否不约束；内容正确即可
})

test('enable 失败: exitCode 非零 -> ok:false + output 含 stderr', () => {
  const e = fakeExec()
  e.setNext({ exitCode: 1, stdout: '', stderr: 'ERROR: Access is denied.' })
  const r = createServiceManager(e.fn, spec).enable()
  expect(r.ok).toBe(false)
  expect(r.output).toContain('Access is denied')
})

test('query: 已注册 -> 透传状态 + command 预览', () => {
  const e = fakeExec()
  e.setNext({ exitCode: 0, stdout: 'Status:                               Ready\r\nLast Run Time:                        2026/8/4 09:00:01', stderr: '' })
  const q = createServiceManager(e.fn, spec).query()
  expect(q).toEqual({
    registered: true, status: 'Ready', lastRunTime: '2026/8/4 09:00:01',
    command: `"${spec.bunPath}" run "${spec.repoDir}\\src\\cli.ts" start`,
  })
  expect(e.calls[0].args.slice(0, 4)).toEqual(['/Query', '/TN', 'memside-daemon', '/FO'])
  expect(e.calls[0].args).toContain('/V')
})

test('query: 未注册 -> registered:false 仍带 command 预览', () => {
  const e = fakeExec()
  e.setNext({ exitCode: 1, stdout: 'ERROR: The system cannot find the file specified.', stderr: '' })
  const q = createServiceManager(e.fn, spec).query()
  expect(q.registered).toBe(false)
  expect(q.command).toContain('src\\cli.ts')
})

test('disable: schtasks /Delete /F', () => {
  const e = fakeExec()
  const r = createServiceManager(e.fn, spec).disable()
  expect(r.ok).toBe(true)
  expect(e.calls[0].args).toEqual(['/Delete', '/TN', 'memside-daemon', '/F'])
})

test('startNow: schtasks /Run /TN', () => {
  const e = fakeExec()
  const r = createServiceManager(e.fn, spec).startNow()
  expect(r.ok).toBe(true)
  expect(e.calls[0].args).toEqual(['/Run', '/TN', 'memside-daemon'])
})
```

（`fakeExec`/import 若与文件顶部重复，合并到顶部 import 区。）

- [ ] **Step 2: 跑测试确认 RED**

Run: `bun test tests/service.test.ts`
Expected: 新 case FAIL。

- [ ] **Step 3: 实现**——`src/service.ts` 末尾追加：

```ts
export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
}
export type ExecFn = (cmd: string, args: string[]) => ExecResult

export interface ServiceActionResult {
  ok: boolean
  output: string
}

export interface ServiceQuery {
  registered: boolean
  status: string | null
  lastRunTime: string | null
  /** 完整命令行预览（UI 知情权：用户必须看到将要执行什么）。 */
  command: string
}

export interface ServiceOps {
  query(): ServiceQuery
  enable(): ServiceActionResult
  disable(): ServiceActionResult
  startNow(): ServiceActionResult
}

/** spec §6.2：所有 schtasks 调用走注入的 exec seam——单测断言 argv，
 * 永不触碰真实系统配置。enable 把任务 XML 落临时文件再 /Create /XML /F。 */
export function createServiceManager(exec: ExecFn, taskSpec: TaskSpec): ServiceOps {
  const combined = (r: ExecResult) => `${r.stdout}\n${r.stderr}`.trim()
  return {
    query(): ServiceQuery {
      const r = exec('schtasks', ['/Query', '/TN', TASK_NAME, '/FO', 'LIST', '/V'])
      const parsed = parseSchtasksQuery(r.stdout, r.exitCode)
      return { ...parsed, command: buildCommandPreview(taskSpec) }
    },
    enable(): ServiceActionResult {
      const xmlPath = join(tmpdir(), `${TASK_NAME}-${Date.now()}.xml`)
      writeFileSync(xmlPath, buildTaskXml(taskSpec), 'utf-8')
      try {
        const r = exec('schtasks', ['/Create', '/F', '/TN', TASK_NAME, '/XML', xmlPath])
        return { ok: r.exitCode === 0, output: combined(r) }
      } finally {
        try { rmSync(xmlPath) } catch { /* 清理失败不影响注册结果 */ }
      }
    },
    disable(): ServiceActionResult {
      const r = exec('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'])
      return { ok: r.exitCode === 0, output: combined(r) }
    },
    startNow(): ServiceActionResult {
      const r = exec('schtasks', ['/Run', '/TN', TASK_NAME])
      return { ok: r.exitCode === 0, output: combined(r) }
    },
  }
}
```

文件顶部 import 追加：`import { writeFileSync, rmSync } from 'node:fs'`、`import { join } from 'node:path'`、`import { tmpdir } from 'node:os'`。

注意测试 Step 1 断言 `args.slice(0,2)` 为 `['/Create','/F']`——实现必须保持该参数顺序。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `bun test tests/service.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/service.ts tests/service.test.ts
git commit -m "feat(service): ServiceManager（spawn seam，单测不触碰真实 schtasks）"
```

### Task 9: server 路由 + daemon 接线

**Files:**
- Modify: `src/server.ts`（AppDeps.daemonService + 4 路由）
- Modify: `src/daemon.ts`（真实 ServiceOps 装配）
- Test: `tests/server-service.test.ts`

**Interfaces:**
- Consumes: Task 8 `ServiceOps`
- Produces: `GET /api/daemon-service`、`POST /api/daemon-service/{enable,disable,start-now}`；非 win32/未装配 -> 501 `{supported:false}`。Task 11 web 端依赖。

- [ ] **Step 1: 写失败测试** `tests/server-service.test.ts`（骨架同 server-health.test.ts 的 beforeEach）：

```ts
import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { ClaudeCodeAdapter } from '@/adapter/claudeCode'
import { OpencodeAdapter } from '@/adapter/opencode'
import { createApp } from '@/server'
import { createServiceManager, type ExecResult } from '@/service'

const root = join(import.meta.dir, '.tmp-server-service')
let db: ReturnType<typeof openDb>
let app: ReturnType<typeof createApp>
let calls: { cmd: string; args: string[] }[]
let next: ExecResult

function fakeExec(cmd: string, args: string[]): ExecResult {
  calls.push({ cmd, args: [...args] })
  return next
}

const taskSpec = { bunPath: 'C:\\fake\\bun.exe', repoDir: 'C:\\fake\\repo', port: 7777 }

beforeAll(() => { rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true }) })
beforeEach(() => {
  const dir = join(root, Math.random().toString(36).slice(2))
  mkdirSync(dir, { recursive: true })
  db = openDb(join(dir, 't.db'))
  calls = []
  next = { exitCode: 0, stdout: 'Status:                               Ready', stderr: '' }
  app = createApp({
    db, adapter: new ClaudeCodeAdapter(db), opencodeAdapter: new OpencodeAdapter(db),
    enqueueDistillJob: async () => ({ jobId: 'j', nextRunAt: 0 }),
    broadcast: () => {},
    daemonService: createServiceManager(fakeExec, taskSpec),
  })
})
afterEach(() => { db.$client.close() })

async function req(path: string, init?: RequestInit) {
  const res = await app.fetch(new Request(`http://x${path}`, init))
  return { status: res.status, body: await res.json().catch(() => null) }
}

test('GET /api/daemon-service: 透传 query + command 预览', async () => {
  const r = await req('/api/daemon-service')
  expect(r.status).toBe(200)
  expect(r.body.supported).toBe(true)
  expect(r.body.registered).toBe(true)
  expect(r.body.status).toBe('Ready')
  expect(r.body.command).toContain('src\\cli.ts')
})

test('未装配 daemonService -> 501 supported:false', async () => {
  app = createApp({
    db, adapter: new ClaudeCodeAdapter(db), opencodeAdapter: new OpencodeAdapter(db),
    enqueueDistillJob: async () => ({ jobId: 'j', nextRunAt: 0 }), broadcast: () => {},
  })
  const r = await req('/api/daemon-service')
  expect(r.status).toBe(501)
  expect(r.body.supported).toBe(false)
})

test('POST enable: ok + output 回显', async () => {
  next = { exitCode: 0, stdout: 'SUCCESS: The scheduled task "memside-daemon" has successfully been created.', stderr: '' }
  const r = await req('/api/daemon-service/enable', { method: 'POST' })
  expect(r.status).toBe(200)
  expect(r.body.ok).toBe(true)
  expect(r.body.output).toContain('successfully been created')
})

test('POST enable 失败: ok:false + stderr 原样回显（失败必可见）', async () => {
  next = { exitCode: 1, stdout: '', stderr: 'ERROR: Access is denied.' }
  const r = await req('/api/daemon-service/enable', { method: 'POST' })
  expect(r.status).toBe(200)
  expect(r.body.ok).toBe(false)
  expect(r.body.output).toContain('Access is denied')
})

test('POST disable / start-now 接线', async () => {
  await req('/api/daemon-service/disable', { method: 'POST' })
  expect(calls.at(-1)?.args).toEqual(['/Delete', '/TN', 'memside-daemon', '/F'])
  await req('/api/daemon-service/start-now', { method: 'POST' })
  expect(calls.at(-1)?.args).toEqual(['/Run', '/TN', 'memside-daemon'])
})
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `bun test tests/server-service.test.ts`
Expected: FAIL（dep/路由不存在）。

- [ ] **Step 3: 实现**

`src/server.ts`：import 追加 `import type { ServiceOps } from '@/service'`；`AppDeps` 加：

```ts
  /** daemon 托管（spec §6）：仅 win32 装配；null/undefined -> 端点 501。 */
  daemonService?: ServiceOps
```

在 error-report 路由之后加四路由：

```ts
  // --- daemon 托管（spec §6）---
  const svc = deps.daemonService
  app.get('/api/daemon-service', async (c) => {
    if (!svc) return c.json({ supported: false }, 501)
    return c.json({ supported: true, ...svc.query() })
  })
  app.post('/api/daemon-service/enable', async (c) => {
    if (!svc) return c.json({ supported: false }, 501)
    return c.json(svc.enable())
  })
  app.post('/api/daemon-service/disable', async (c) => {
    if (!svc) return c.json({ supported: false }, 501)
    return c.json(svc.disable())
  })
  app.post('/api/daemon-service/start-now', async (c) => {
    if (!svc) return c.json({ supported: false }, 501)
    return c.json(svc.startNow())
  })
```

`src/daemon.ts`：import 追加 `import { spawnSync } from 'node:child_process'`、`import { fileURLToPath } from 'node:url'`、`import { dirname } from 'node:path'`（join 已有）、`import { createServiceManager, type ExecFn } from '@/service'`。`startDaemon` 内 `const app = createApp({...})` 调用前加：

```ts
  // daemon 托管（spec §6）：仅 win32。repoDir 从代码位置推导（不依赖 process.cwd，
  // 任务计划程序拉起时 cwd 不受控）；bunPath 用当前运行时的 process.execPath。
  const serviceExec: ExecFn = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf-8' })
    return { exitCode: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }
  const repoDir = dirname(dirname(fileURLToPath(import.meta.url)))
  const daemonService = process.platform === 'win32'
    ? createServiceManager(serviceExec, { bunPath: process.execPath, repoDir, port })
    : undefined
```

`createApp({...})` 的参数对象追加 `daemonService`。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `bun test tests/server-service.test.ts tests/server.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/server.ts src/daemon.ts tests/server-service.test.ts
git commit -m "feat(server): /api/daemon-service 四端点 + daemon win32 装配（非 win32 501）"
```

### Task 10: Web API + 常驻配置面板

**Files:**
- Modify: `src/web/api.ts`
- Modify: `src/web/App.tsx`（新组件 `DaemonService`，插到 `<LlmSettings />` 之后）
- Test: `tests/web-api.test.ts`、`tests/web-ui.test.ts`

**Interfaces:**
- Consumes: Task 9 端点
- Produces: UI 显式配置闭环（知情权：完整命令行预览 + 启用/禁用/立即启动 + 失败原样回显）。

- [ ] **Step 1: 写失败测试**

`tests/web-api.test.ts` 追加：

```ts
test('getDaemonService / enableDaemonService 透传', async () => {
  const fake: FetchLike = async (url, init) => {
    if (String(url) === '/api/daemon-service' && (!init || init.method === undefined)) {
      return new Response(JSON.stringify({ supported: true, registered: false, status: null, lastRunTime: null, command: '"bun" run "x" start' }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true, output: 'created' }), { status: 200 })
  }
  const st = await getDaemonService(fake)
  expect(st.supported).toBe(true)
  expect(st.registered).toBe(false)
  const r = await enableDaemonService(fake)
  expect(r.ok).toBe(true)
  expect(r.output).toBe('created')
})
```

`tests/web-ui.test.ts` 追加：

```ts
test('App.tsx daemon 常驻面板：命令行预览 + 三按钮 + 失败回显（source text）', () => {
  expect(src).toContain('daemon 常驻')
  expect(src).toContain('将执行的命令')
  expect(src).toContain('启用自动常驻')
  expect(src).toContain('禁用自动常驻')
  expect(src).toContain('立即启动')
  expect(src).toContain('DaemonService')
})
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `bun test tests/web-api.test.ts tests/web-ui.test.ts`
Expected: 新 case FAIL。

- [ ] **Step 3: 实现**

`src/web/api.ts` 末尾追加：

```ts
// --- daemon 托管（spec §6）client --------------------------------------------

export interface DaemonServiceState {
  supported: boolean
  registered?: boolean
  status?: string | null
  lastRunTime?: string | null
  command?: string
}

export async function getDaemonService(fetchFn: FetchLike = fetch): Promise<DaemonServiceState> {
  const res = await fetchFn('/api/daemon-service')
  return (await res.json()) as DaemonServiceState
}

async function daemonServiceAction(path: string, fetchFn: FetchLike = fetch): Promise<{ ok: boolean; output: string }> {
  const res = await fetchFn(path, { method: 'POST' })
  return (await res.json()) as { ok: boolean; output: string }
}

export const enableDaemonService = (fetchFn?: FetchLike) => daemonServiceAction('/api/daemon-service/enable', fetchFn)
export const disableDaemonService = (fetchFn?: FetchLike) => daemonServiceAction('/api/daemon-service/disable', fetchFn)
export const startDaemonNow = (fetchFn?: FetchLike) => daemonServiceAction('/api/daemon-service/start-now', fetchFn)
```

`src/web/App.tsx`：顶部 import 从 `'./api'` 的解构中追加 `getDaemonService, enableDaemonService, disableDaemonService, startDaemonNow, type DaemonServiceState`。新增组件（放 `LlmSettings` 定义之后）：

```tsx
/**
 * daemon 常驻配置面板（spec §6，用户裁决：不静默自启，UI 显式配置）。
 * 知情权三件套：命令行预览 + 当前状态 + 操作结果原样回显（含系统拒绝的 stderr）。
 */
function DaemonService() {
  const [state, setState] = useState<DaemonServiceState | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    try { setState(await getDaemonService()); setError(null) }
    catch (e) { setError(String(e)) } // fetch 失败显错误（不静默）
  }
  useEffect(() => { void refresh() }, [])

  const run = async (label: string, action: () => Promise<{ ok: boolean; output: string }>) => {
    setBusy(true); setMsg(null)
    try {
      const r = await action()
      setMsg(`${label}: ${r.ok ? '成功' : '失败'}${r.output ? `——${r.output}` : ''}`)
      await refresh()
    } catch (e) { setMsg(`${label}失败: ${e}`) }
    finally { setBusy(false) }
  }

  if (error) return <section style={{ margin: '12px 0', padding: 12, border: '1px solid #ddd', borderRadius: 8 }}><h3 style={{ margin: '0 0 8px' }}>daemon 常驻</h3><div style={{ color: '#b00' }}>状态加载失败: {error}</div></section>
  if (!state || !state.supported) return null // 非 Windows / 老 daemon：面板隐藏

  return (
    <section style={{ margin: '12px 0', padding: 12, border: '1px solid #ddd', borderRadius: 8 }}>
      <h3 style={{ margin: '0 0 8px' }}>daemon 常驻（任务计划程序）</h3>
      <div style={{ marginBottom: 8, fontSize: 13 }}>
        状态：{state.registered ? <b>已注册</b> : <b>未注册</b>}
        {state.registered && state.status ? <>（{state.status}{state.lastRunTime ? ` · 上次运行 ${state.lastRunTime}` : ''}）</> : null}
      </div>
      <div style={{ marginBottom: 8, fontSize: 12, color: '#666' }}>
        将执行的命令：<code>{state.command}</code>（登录时自启；进程退出 1 分钟后自动重启，至多 3 次）
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button disabled={busy || state.registered} onClick={() => void run('启用自动常驻', enableDaemonService)}>启用自动常驻</button>
        <button disabled={busy || !state.registered} onClick={() => void run('禁用自动常驻', disableDaemonService)}>禁用自动常驻</button>
        <button disabled={busy || !state.registered} onClick={() => void run('立即启动', startDaemonNow)}>立即启动</button>
        {busy ? <span style={{ color: '#888' }}>处理中…</span> : null}
      </div>
      {msg ? <div style={{ marginTop: 6, fontSize: 12, color: msg.includes('失败') ? '#b00' : '#080', whiteSpace: 'pre-wrap' }}>{msg}</div> : null}
    </section>
  )
}
```

App 组件的 JSX 里 `<LlmSettings />` 行之后加一行 `<DaemonService />`。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `bun test tests/web-api.test.ts tests/web-ui.test.ts`
Expected: PASS。

- [ ] **Step 5: 全量门槛 + 提交**

Run: `bun run typecheck; if ($?) { bun test }`
Expected: 全绿。

```powershell
git add src/web/api.ts src/web/App.tsx tests/web-api.test.ts tests/web-ui.test.ts
git commit -m "feat(web): daemon 常驻配置面板（命令行预览 + 启用/禁用/立即启动 + 失败回显）"
```

- [ ] **Step 6: push + PR + 真机冒烟 + STATE.md**

```powershell
git push -u origin feat/daemon-service-ui
gh pr create --base master --title "feat(service): daemon 任务计划程序托管（UI 显式配置，不静默自启）" --body "spec §6。schtasks 封装走 spawn seam；非 win32 501。冒烟：UI 启用 -> 任务可见；taskkill daemon -> 1 分钟自动拉起；禁用 -> 删除。"
```

真机冒烟（spec §9，合并后执行）：
1. 重启 daemon（吃新代码）→ Web UI 打开面板 → 核对命令行预览 → 点「启用自动常驻」→
   `schtasks /Query /TN memside-daemon` 能查到。
2. `taskkill /PID <daemon pid> /F` → 等 1 分钟 → `netstat -ano | Select-String ":7777 .*LISTENING"` 重新有监听。
3. 点「禁用自动常驻」→ `schtasks /Query /TN memside-daemon` 报 ERROR（已删）。
4. 顺手处置当前手动分离的临时 daemon（冒烟接管前先停旧进程，避免端口冲突）。

STATE.md 追加 P3 段 + 三阶段总验收结果，commit `docs(state): capture 边界加固 P3（daemon 任务计划程序托管）`。

---

## 验收总览（spec §9 逐条对应）

| # | 验收项 | 归属 | 状态 |
|---|---|---|---|
| 1 | 真机 capture ok + 库出 opencode job | P1 Step 6 | 待 |
| 2 | 错误信箱 curl 可见 + silent→ok 全态 | P2 Step 6 | 待 |
| 3 | UI 启用任务 + 杀进程 1 分钟自拉 + 禁用删除 | P3 Step 6 | 待 |
| 4 | 每 PR typecheck + bun test 全绿 | 每 Task 门槛 | 待 |
