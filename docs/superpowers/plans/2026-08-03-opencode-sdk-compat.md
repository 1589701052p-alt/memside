# opencode plugin 新旧 SDK 签名兼容 + capture 可观测性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** memside 的 opencode plugin 在 1.15.x 与 1.18+ 两代 SDK 签名下都能 capture，且 capture/inject 的成败在 opencode 日志中可见。

**Architecture:** plugin 内新增「双签名探测 + 成功记忆」的 `fetchSessionMessages`（flat `{ sessionID, limit }` 优先，`{ path: { id } }` 兜底；成功判据 = `res.data` 真值），event hook 换成它并全链路打日志（`client.app.log` 写 opencode 日志文件，失败降级 console.error）。daemon / `src/**` 零改动。

**Tech Stack:** Bun + bun:test + 纯 JS plugin（opencode 进程内加载）+ 假 client 功能测试 + 源码层文本断言双层。

**Spec:** `docs/superpowers/specs/2026-08-03-opencode-sdk-compat-design.md`

## Global Constraints

- best-effort 契约：plugin 永不向 opencode 抛错（所有钩子 catch 住，吞前记日志）。
- 探测成功判据 = `res.data` 真值，不是「没抛错」（SDK 可能返回错误响应对象而非 throw）。
- 探测顺序 flat 优先（`{ sessionID, limit: 1000 }`）；`limit: 1000` 仅 flat 形态携带；`{ path: { id: sessionID } }` 保持 1.15.5 原样不带 limit。
- 日志级别：成功 capture = info；签名回退 = warn；capture/inject 失败与 sessionID 缺失 = error。
- 日志通道：`client.app.log({ body: { service: 'memside', level, message, extra } })`；其自身失败降级 `console.error`。
- `src/**` 与安装器零改动；分发靠既有 `installOpencodePlugin` 复制。
- 不得往 `opencode-plugin/` 目录新增文件（会被 `cpSync` 复制进 `~/.config/opencode/memside-opencode/`，opencode 可能把多余 `.ts/.js` 当 plugin 加载）——ambient 类型声明放 `tests/`。
- 运行门槛：落 commit 前 `bun run typecheck && bun test` 全绿。
- 分支纪律：当前在 `fix/opencode-sdk-compat`（基线 `origin/master` c940c3c）；严禁直推 master；收尾 push + 开 PR 目标 master。

---

### Task 1: SDK 签名探测 + 成功记忆（fetchSessionMessages）

**Files:**
- Modify: `opencode-plugin/memside.js`（新增 named exports：`compat` / `resetCompatState` / `fetchSessionMessages`；钩子暂不接线）
- Create: `tests/memside-plugin-shapes.d.ts`（wildcard ambient module 声明，让严格模式 TS 能 import 无类型 JS）
- Test: `tests/plugin-opencode.test.ts`（新增「SDK 签名探测」功能测试段）

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: `fetchSessionMessages(client, sessionID): Promise<{ res: { data?: unknown } & Record<string, unknown>; shape: 'flat' | 'path'; fellBack: boolean; firstError: unknown }>`、`compat: { rememberedShape: 'flat' | 'path' | null }`、`resetCompatState(): void`——Task 2 的 event hook 依赖这三个 named export 的确切名字与返回形状。

- [ ] **Step 1: 写 ambient 类型声明（测试接缝）**

创建 `tests/memside-plugin-shapes.d.ts`：

```ts
// Ambient 声明：opencode-plugin/memside.js 是 opencode 进程内加载的独立 JS，
// 不在 typecheck include 内也无类型。wildcard ambient module 让功能测试能 import
// 它（tsconfig 无 allowJs）。不得把 .d.ts 放进 opencode-plugin/——install.ts 的
// cpSync 会把整个目录复制进 opencode 加载路径。
declare module '*/opencode-plugin/memside.js' {
  export const compat: { rememberedShape: 'flat' | 'path' | null };
  export function resetCompatState(): void;
  export function fetchSessionMessages(
    client: unknown,
    sessionID: string,
  ): Promise<{
    res: { data?: unknown } & Record<string, unknown>
    shape: 'flat' | 'path'
    fellBack: boolean
    firstError: unknown
  }>
  export interface PluginHooks {
    event: (args: { event: { type: string; properties?: Record<string, unknown> } }) => Promise<void>
    'experimental.chat.messages.transform': (
      input: unknown,
      output: { messages: Array<{ info?: { role?: string }; parts: Array<Record<string, unknown>> }> },
    ) => Promise<void>
  }
  const memsidePlugin: (input: { client: unknown; directory: string }) => Promise<PluginHooks>
  export default memsidePlugin
}
```

- [ ] **Step 2: 写失败测试（4 条探测用例）**

`tests/plugin-opencode.test.ts` 顶部改为（保留既有 import 与常量，追加 env、default/named import、afterEach）：

```ts
import { test, expect, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import memsidePlugin, { fetchSessionMessages, compat, resetCompatState } from '../opencode-plugin/memside.js'

process.env.MEMSIDE_PORT = '7777'

const js = readFileSync(new URL('../opencode-plugin/memside.js', import.meta.url), 'utf-8')
```

在文件末尾追加假 client 工厂（Task 2/3 复用）与探测测试：

```ts
// --- SDK 签名探测功能测试（2026-08-03 事故：opencode 1.15.5 -> 1.18.10 自动升级后
// client.session.messages 签名从 { path: { id } } 翻转回扁平 { sessionID }，plugin
// 旧签名调用失败被 catch 吞掉，capture 静默清零。spec §1a：双签名探测 + 成功记忆。）---

type ShapeImpl = (sessionID: string) => unknown

function makeFakeClient(beh: { flat?: ShapeImpl; path?: ShapeImpl } = {}) {
  const order: string[] = []
  const logs: { service: string; level: string; message: string; extra?: unknown }[] = []
  const client = {
    session: {
      messages: async (arg: { sessionID?: string; path?: { id: string } }) => {
        if (arg && arg.path) {
          order.push('path')
          if (!beh.path) throw new Error('unexpected path shape call')
          return beh.path(arg.path.id)
        }
        order.push('flat')
        if (!beh.flat) throw new Error('unexpected flat shape call')
        return beh.flat(arg?.sessionID ?? '')
      },
    },
    app: {
      log: async (req: { body: { service: string; level: string; message: string; extra?: unknown } }) => {
        logs.push(req.body)
      },
    },
  }
  return { client, order, logs }
}

afterEach(() => { resetCompatState() })

test('probe: flat 成功（1.18+ 形态）-> 返回 res 并记忆 flat', async () => {
  const { client, order } = makeFakeClient({ flat: () => ({ data: [{ info: { role: 'user' }, parts: [] }] }) })
  const out = await fetchSessionMessages(client, 'ses_a')
  expect((out.res.data as unknown[]).length).toBe(1)
  expect(out.shape).toBe('flat')
  expect(out.fellBack).toBe(false)
  expect(compat.rememberedShape).toBe('flat')
  await fetchSessionMessages(client, 'ses_a')
  expect(order).toEqual(['flat', 'flat']) // 记忆命中，不再试探其它形态
})

test('probe: flat 抛错 -> 回退 path（1.15.x 形态）并记忆 path', async () => {
  const { client, order } = makeFakeClient({
    flat: () => { throw new Error('Expected a string starting with ses') },
    path: () => ({ data: [{ info: { role: 'user' }, parts: [] }] }),
  })
  const out = await fetchSessionMessages(client, 'ses_b')
  expect(out.shape).toBe('path')
  expect(out.fellBack).toBe(true)
  expect(String(out.firstError)).toContain('Expected a string starting with ses')
  expect(compat.rememberedShape).toBe('path')
  await fetchSessionMessages(client, 'ses_b')
  expect(order).toEqual(['flat', 'path', 'path']) // 记忆后直走 path
})

test('probe: flat 返回无 data 的错误对象 -> 仍回退（成功判据是 res.data 而非「没抛错」）', async () => {
  const { client, order } = makeFakeClient({
    flat: () => ({ error: { message: 'Invalid request' } }),
    path: () => ({ data: [] }),
  })
  const out = await fetchSessionMessages(client, 'ses_c')
  expect(order).toEqual(['flat', 'path'])
  expect(out.shape).toBe('path')
})

test('probe: 两形态都失败 -> 抛首个错误', async () => {
  const { client } = makeFakeClient({
    flat: () => { throw new Error('flat boom') },
    path: () => { throw new Error('path boom') },
  })
  await expect(fetchSessionMessages(client, 'ses_d')).rejects.toThrow('flat boom')
})
```

- [ ] **Step 3: 跑测试确认红**

Run: `bun test tests/plugin-opencode.test.ts`
Expected: FAIL——`fetchSessionMessages is not a function`（named export 尚不存在）。

- [ ] **Step 4: 实现探测**

`opencode-plugin/memside.js`：在 `process.env.NO_PROXY = _noProxy;` 之后、`export default async function memsidePlugin` 之前插入：

```js
// --- SDK 签名兼容（2026-08-03 事故；spec 2026-08-03-opencode-sdk-compat-design.md）---
// client.session.messages 签名在 opencode 版本间翻转：
//   1.15.x: { path: { id: sessionID } }
//   1.18+:  { sessionID, limit }（扁平；二进制内部调用即此形态）
// 双形态探测，记忆首个成功形态（flat 优先）。成功判据是 res.data 真值而非「没抛错」：
// 生成的 SDK 可能返回错误响应对象而非 throw（二进制内部对 session.get 显式传
// {throwOnError:true} 是反证）。limit:1000 仅 flat 携带（防默认分页截断；distill 侧
// 自有 12000 token 预算裁剪），path 形态保持 1.15.5 已验证原样。
export const compat = { rememberedShape: null };

export function resetCompatState() {
  compat.rememberedShape = null;
}

function shapeName(shape) {
  return shape.path ? 'path' : 'flat';
}

export async function fetchSessionMessages(client, sessionID) {
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
    }
  }
  throw firstError ?? new Error('session.messages failed on all known shapes');
}
```

- [ ] **Step 5: 跑测试确认绿 + 全量门槛**

Run: `bun test tests/plugin-opencode.test.ts`
Expected: PASS（既有文本断言不受影响——新代码不含被禁止的 `client.session.messages({ sessionID })` 字面量）。
Run: `bun run typecheck && bun test`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add tests/memside-plugin-shapes.d.ts tests/plugin-opencode.test.ts opencode-plugin/memside.js
git commit -m "feat(opencode-plugin): SDK messages 双签名探测 + 成功记忆"
```

---

### Task 2: 日志通道 + event hook capture 全链路打日志

**Files:**
- Modify: `opencode-plugin/memside.js`（新增 `log` helper；event hook 重写为探测 + 四类日志）
- Test: `tests/plugin-opencode.test.ts`（重写旧签名守卫断言；新增 hook 级功能测试 + fetch 拦截）

**Interfaces:**
- Consumes: Task 1 的 `fetchSessionMessages` / `compat` / `resetCompatState`（exact 签名见 Task 1 Interfaces）。
- Produces: event hook 行为契约——成功 POST `/hooks/opencode/capture`（body `{ sessionId, cwd, messages }` 不变）+ info 日志 `capture ok session=<id> messages=<n> shape=<flat|path>`；回退 warn；失败/sessionID 缺失 error；非 idle 事件直接跳过。

- [ ] **Step 1: 重写旧签名文本守卫（红）**

`tests/plugin-opencode.test.ts` 中把：

```ts
test('session.messages 用 path:{id} 签名（非旧 {sessionID}）', () => {
  // opencode SDK 期望 { path: { id: sessionID } }；旧 { sessionID } 会把字面量对象
  // 拼进 URL -> "%7Bid%7D" -> SDK 报 "Expected a string starting with ses"。
  expect(js).toContain('client.session.messages({ path: { id: sessionID } })')
  expect(js).not.toContain('client.session.messages({ sessionID })')
})
```

替换为：

```ts
test('session.messages 双签名兼容（flat 优先 + path 兜底 + 记忆）', () => {
  // 2026-08-03 事故：opencode 自动升级 1.15.5 -> 1.18.10 把签名翻转回扁平形态，
  // 单一签名静默清零 capture。成功判据是 res.data 真值（SDK 可能不 throw 而返回错误对象）。
  expect(js).toContain('sessionID, limit: 1000')
  expect(js).toContain('path: { id: sessionID }')
  expect(js).toContain('res.data')
  expect(js).toContain('rememberedShape')
})

test('capture 全终态有日志（成功 info / 回退 warn / 失败与 sessionID 缺失 error）', () => {
  expect(js).toContain('capture ok session=')
  expect(js).toContain('without sessionID')
  expect(js).toContain('capture failed session=')
  expect(js).toContain("'warn'")
  expect(js).toContain("service: 'memside'")
})
```

并在文件末尾追加 hook 级测试段：

```ts
// --- hook 级功能测试（假 client + 拦截 globalThis.fetch；锁定 spec §1b 数据流）---

const realFetch = globalThis.fetch

afterEach(() => { globalThis.fetch = realFetch })

function captureFetch(): { url: string; body: Record<string, unknown> | null }[] {
  const posts: { url: string; body: Record<string, unknown> | null }[] = []
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    posts.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null })
    return new Response(JSON.stringify({ ok: true }), { status: 202 })
  }) as unknown as typeof fetch
  return posts
}

test('capture: 1.18+ 形态 end-to-end（idle -> POST + info 日志 + 记忆）', async () => {
  const posts = captureFetch()
  const { client, order, logs } = makeFakeClient({
    flat: () => ({ data: [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hi' }] }] }),
  })
  const hooks = await memsidePlugin({ client, directory: '/tmp/proj' })
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_t2' } } })
  expect(posts.length).toBe(1)
  expect(posts[0].url).toBe('http://127.0.0.1:7777/hooks/opencode/capture')
  expect(posts[0].body?.sessionId).toBe('ses_t2')
  expect(posts[0].body?.cwd).toBe('/tmp/proj')
  expect((posts[0].body?.messages as unknown[]).length).toBe(1)
  expect(order).toEqual(['flat'])
  const info = logs.find((l) => l.level === 'info')
  expect(info?.message).toContain('capture ok session=ses_t2')
  expect(info?.message).toContain('shape=flat')
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_t2' } } })
  expect(order).toEqual(['flat', 'flat'])
})

test('capture: 1.15.x 形态 end-to-end（flat 抛错 -> path 兜底 + warn 回退日志）', async () => {
  const posts = captureFetch()
  const { client, order, logs } = makeFakeClient({
    flat: () => { throw new Error('Expected a string starting with ses') },
    path: () => ({ data: [{ info: { role: 'user' }, parts: [] }] }),
  })
  const hooks = await memsidePlugin({ client, directory: '/tmp/proj' })
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_t3' } } })
  expect(posts.length).toBe(1)
  expect(order).toEqual(['flat', 'path'])
  expect(logs.some((l) => l.level === 'warn' && l.message.includes('fell back to path'))).toBe(true)
})

test('capture: flat 返回无 data 错误对象 -> 回退 path 仍成功（成功判据是 res.data，1.18+ 可能不 throw）', async () => {
  const posts = captureFetch()
  const { client, order } = makeFakeClient({
    flat: () => ({ error: { message: 'Invalid request' } }),
    path: () => ({ data: [{ info: { role: 'user' }, parts: [] }] }),
  })
  const hooks = await memsidePlugin({ client, directory: '/tmp/proj' })
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_t5' } } })
  expect(posts.length).toBe(1)
  expect(order).toEqual(['flat', 'path'])
})

test('capture: 两形态都失败 -> 不 POST、error 日志、不抛回 opencode', async () => {
  const posts = captureFetch()
  const { client, logs } = makeFakeClient({
    flat: () => { throw new Error('flat boom') },
    path: () => { throw new Error('path boom') },
  })
  const hooks = await memsidePlugin({ client, directory: '/tmp/proj' })
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_t4' } } })
  expect(posts.length).toBe(0)
  expect(logs.some((l) => l.level === 'error' && l.message.includes('capture failed session=ses_t4'))).toBe(true)
})

test('capture: sessionID 缺失 -> 不 POST、error 日志、不抛', async () => {
  const posts = captureFetch()
  const { client, logs } = makeFakeClient({})
  const hooks = await memsidePlugin({ client, directory: '/tmp/proj' })
  await hooks.event({ event: { type: 'session.idle', properties: {} } })
  expect(posts.length).toBe(0)
  expect(logs.some((l) => l.level === 'error' && l.message.includes('without sessionID'))).toBe(true)
})

test('capture: 非 idle 事件直接跳过', async () => {
  const posts = captureFetch()
  const { client, order } = makeFakeClient({ flat: () => ({ data: [] }) })
  const hooks = await memsidePlugin({ client, directory: '/tmp/proj' })
  await hooks.event({ event: { type: 'session.updated', properties: { sessionID: 'ses_x' } } })
  expect(posts.length).toBe(0)
  expect(order).toEqual([])
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/plugin-opencode.test.ts`
Expected: FAIL——新文本断言（`capture ok session=` 等）不存在；hook 测试里 event hook 仍是旧实现（无日志、无回退 warn、sessionID 缺失不记日志）。

- [ ] **Step 3: 实现 log helper + event hook 重写**

`opencode-plugin/memside.js`：

a) 在 `fetchSessionMessages` 之后插入 log helper：

```js
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
```

b) `event` 钩子整体替换为：

```js
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
        await fetch(`${BASE()}/hooks/opencode/capture`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: sessionID, cwd, messages }),
          signal: AbortSignal.timeout(2000),
        });
        await log(client, 'info', `capture ok session=${sessionID} messages=${messages.length} shape=${shape}`, { sessionID, messages: messages.length, shape });
      } catch (e) {
        await log(client, 'error', `capture failed session=${sessionID}: ${String(e)}`, { sessionID, error: String(e) });
      }
    },
```

（原 `const res = await client.session.messages({ path: { id: sessionID } })` 行被 `fetchSessionMessages` 取代；POST body / timeout / 响应归一化均不变。）

- [ ] **Step 4: 跑测试确认绿 + 全量门槛**

Run: `bun test tests/plugin-opencode.test.ts` → PASS。
Run: `bun run typecheck && bun test` → 全绿。

- [ ] **Step 5: Commit**

```bash
git add opencode-plugin/memside.js tests/plugin-opencode.test.ts
git commit -m "feat(opencode-plugin): capture 链路接入双签名探测 + app.log 可观测性"
```

---

### Task 3: transform catch 记日志 + catch-必记日志文本守卫

**Files:**
- Modify: `opencode-plugin/memside.js`（transform 钩子 catch 从空吞改为记 error）
- Test: `tests/plugin-opencode.test.ts`（inject 失败测试、app.log 降级测试、catch 守卫断言）

**Interfaces:**
- Consumes: Task 2 的 `log` helper（module-private，不导出）。
- Produces: 全文件零空 catch；文本守卫锁定「每个 catch 块必引用 `log(` 或 `console.error`」。

- [ ] **Step 1: 写失败测试（3 条）**

`tests/plugin-opencode.test.ts` 末尾追加：

```ts
test('inject: GET 失败 -> error 日志、不抛回 opencode', async () => {
  globalThis.fetch = (async () => { throw new Error('ECONNREFUSED 127.0.0.1:7777') }) as unknown as typeof fetch
  const { client, logs } = makeFakeClient({})
  const hooks = await memsidePlugin({ client, directory: '/tmp/proj' })
  await hooks['experimental.chat.messages.transform']({}, {
    messages: [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' }] }],
  })
  expect(logs.some((l) => l.level === 'error' && l.message.includes('inject transform failed'))).toBe(true)
})

test('日志: app.log 失败降级 console.error，capture 主流程不受影响', async () => {
  const posts = captureFetch()
  const client = {
    session: { messages: async () => ({ data: [{ info: { role: 'user' }, parts: [] }] }) },
    app: { log: async () => { throw new Error('app.log endpoint down') } },
  }
  const origConsoleError = console.error
  const captured: string[] = []
  console.error = (...args: unknown[]) => { captured.push(args.map(String).join(' ')) }
  try {
    const hooks = await memsidePlugin({ client, directory: '/tmp/proj' })
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_logdown' } } })
  } finally {
    console.error = origConsoleError
  }
  expect(posts.length).toBe(1) // capture 本体不因日志通道故障而丢
  expect(captured.some((m) => m.includes('[memside]') && m.includes('capture ok'))).toBe(true)
})

test('catch 必记日志（防回退空 catch——2026-08-03 事故结构性缺口）', () => {
  const catches = js.match(/catch\s*\([^)]*\)\s*\{[\s\S]*?\}/g) ?? []
  expect(catches.length).toBeGreaterThanOrEqual(3)
  for (const c of catches) {
    expect(c).toMatch(/log\(|console\.error/)
  }
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/plugin-opencode.test.ts`
Expected: FAIL——inject 失败测试（transform catch 仍空吞，无日志）；catch 守卫断言（transform 的空 catch 不含 `log(`/`console.error`）。

- [ ] **Step 3: transform catch 记日志**

`opencode-plugin/memside.js` 的 `'experimental.chat.messages.transform'` 钩子尾部：

```js
      } catch (e) { /* best-effort */ }
```

替换为：

```js
      } catch (e) {
        await log(client, 'error', `inject transform failed: ${String(e)}`, { error: String(e) });
      }
```

- [ ] **Step 4: 跑测试确认绿 + 全量门槛**

Run: `bun test tests/plugin-opencode.test.ts` → PASS。
Run: `bun run typecheck && bun test` → 全绿。

- [ ] **Step 5: Commit**

```bash
git add opencode-plugin/memside.js tests/plugin-opencode.test.ts
git commit -m "feat(opencode-plugin): inject catch 记日志 + catch-必记日志守卫测试"
```

---

### Task 4: 重装 + live 冒烟 + STATE.md + PR

**Files:**
- Modify: `STATE.md`（追加本修复段落 + 验证结果）
- 无其它源码改动（`bun run src/cli.ts install` 是运行时重装，不改仓库文件）

**Interfaces:**
- Consumes: Task 1-3 全部产物（最终 memside.js）。
- Produces: 已重装的 `~/.config/opencode/memside-opencode/memside.js`；live 冒烟证据（新 opencode job + opencode 日志 memside 行）；分支 push + PR。

- [ ] **Step 1: 重装 plugin**

Run: `bun run src/cli.ts install`
Expected: `hooks installed into ~/.claude/settings.json; opencode plugin installed into ~/.config/opencode/`

验证新代码已装进（探测记忆字段存在、端口烘焙正确）：

```powershell
$inst = Get-Content "$env:USERPROFILE\.config\opencode\memside-opencode\memside.js" -Raw
if ($inst.Contains('rememberedShape') -and $inst.Contains('|| 7777')) { "INSTALL OK" } else { "INSTALL STALE" }
```

Expected: `INSTALL OK`

- [ ] **Step 2: 确认 daemon 在跑**

Run: `Invoke-RestMethod -Uri 'http://127.0.0.1:7777/api/status' -TimeoutSec 5`（先 `$env:NO_PROXY='127.0.0.1,localhost'`）
Expected: JSON 含 jobs/memories 计数；若拒绝连接则先 `bun run src/cli.ts start`（另开终端，后台跑）。

记录冒烟前 opencode job 计数（把下面脚本写入临时文件再执行，避免 PowerShell 引号转义）：

```powershell
$tmp = 'C:\Users\admin\AppData\Local\Temp\opencode\baseline.ts'
Set-Content -LiteralPath $tmp -Value @'
import { Database } from 'bun:sqlite';
const db = new Database(process.argv[2], { readonly: true });
console.log('opencode jobs:', db.query(`SELECT count(*) n FROM memory_distill_jobs WHERE runtime='opencode'`).get());
'@
bun run $tmp (Join-Path $env:USERPROFILE '.memside\memside.db')
```

Expected: 记录基线数 N₀（事故后应为 4）。

- [ ] **Step 3: live 冒烟（真实 opencode 1.18.10 会话）**

```powershell
$smoke = "$env:LOCALAPPDATA\Temp\opencode\memside-smoke"  # 若不存在则 New-Item -ItemType Directory
opencode run "Reply with exactly: memside compat smoke ok"
```

（workdir 用 `$smoke`；timeout 120s——真实 LLM 调用 ~10-30s。）
Expected: 命令正常结束、输出含模型回复；**不**报 plugin 错误。

- [ ] **Step 4: 断言 capture 到达 daemon**

a) 查 memside DB 新 opencode job（脚本同上模式写临时文件）：

```powershell
$tmp = 'C:\Users\admin\AppData\Local\Temp\opencode\verify.ts'
Set-Content -LiteralPath $tmp -Value @'
import { Database } from 'bun:sqlite';
const db = new Database(process.argv[2], { readonly: true });
const rows = db.query(`SELECT id, status, cwd, session_id, created_at FROM memory_distill_jobs WHERE runtime='opencode' ORDER BY created_at DESC LIMIT 3`).all();
for (const r of rows) console.log(JSON.stringify(r));
'@
bun run $tmp (Join-Path $env:USERPROFILE '.memside\memside.db')
```

Expected: 最新一行 `cwd` 含 `memside-smoke`、`created_at` 晚于冒烟开始、`status` pending/done；
计数 = N₀+1；其对应 `memory_distill_events` 行 payload 含冒烟对话消息。

b) 查 opencode 日志最新文件的 memside 行：

```powershell
$logDir = "$env:USERPROFILE\.local\share\opencode\log"
$newest = Get-ChildItem $logDir -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
"newest log: $($newest.FullName)"
Select-String -Path $newest.FullName -Pattern 'memside|capture ok|capture failed|flat shape failed'
```

Expected: 命中 `capture ok session=`（info）。若只有 `capture failed` / `flat shape failed`
而无 capture ok → 冒烟失败，停止 Task 4 后续，回 systematic-debugging Phase 1
排查（不得直接重试碰运气）。

- [ ] **Step 5: 更新 STATE.md**

在文件末尾追加新段落（对齐既有 house style：背景/改动点/执行/验证/缺口），内容要点：

```markdown
## opencode plugin 新旧 SDK 签名兼容 + capture 可观测性（2026-08-03）

诊断「opencode 会话结束了但蒸馏记录里没有」：opencode 在会话运行期间自动升级
1.15.5 -> 1.18.10，`client.session.messages` SDK 签名从 `{ path: { id } }` 翻转回
扁平 `{ sessionID, limit }`（binary 取证内部调用形态），plugin 旧签名调用失败被
`catch (e) { /* best-effort */ }` 静默吞掉——capture 从不发出，且零可观测性。
设计 spec / 计划见 `docs/superpowers/specs|plans/2026-08-03-opencode-sdk-compat*`。

1. `fetchSessionMessages`（opencode-plugin/memside.js）双签名探测 + 成功记忆：
   flat `{ sessionID, limit: 1000 }` 优先、`{ path: { id: sessionID } }` 兜底；
   成功判据 = res.data 真值（SDK 可能返回错误响应对象而非 throw）。
2. 可观测性：`log(client, level, message, extra)` 走 `client.app.log`（opencode
   日志文件；TUI 下 stderr 不可见），失败降级 console.error。四类打点：成功 info /
   回退 warn / 失败与 sessionID 缺失 error / inject 失败 error。catch-必记日志
   文本守卫防回退空 catch。
3. 测试：功能测试（假 client 驱动真实 hooks：6 条 capture 终态 + inject 失败 +
   app.log 降级）+ 文本断言双层；废弃锁死旧签名的两条过时断言。

执行：（subagent-driven / inline，按实际填）。`bun run typecheck && bun test`
全绿。live 冒烟（本机 opencode 1.18.10）：`opencode run` -> 新 opencode job 入库 +
opencode 日志 `capture ok session=` 行。

### 验证缺口
- 1.15.5 真机回归不可行（本机已升级）：旧形态行为由假 client 功能测试覆盖
  （flat 抛错 -> path 兜底用例）。
```

- [ ] **Step 6: 最终门槛 + Commit + Push + PR**

Run: `bun run typecheck && bun test` → 全绿。

```bash
git add STATE.md
git commit -m "docs(state): opencode SDK 签名兼容修复与 live 冒烟结果"
git push -u origin fix/opencode-sdk-compat
gh pr create --base master --title "fix(opencode): plugin 兼容 1.15.x/1.18+ SDK 签名 + capture 可观测性" --body "事故：opencode 自动升级 1.18.10 后 SDK 签名翻转，capture 静默清零。修复：双签名探测+记忆、app.log 可观测性。spec: docs/superpowers/specs/2026-08-03-opencode-sdk-compat-design.md"
```

Expected: PR URL 返回，目标 master。
