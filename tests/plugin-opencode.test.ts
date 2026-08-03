import { test, expect, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import memsidePlugin, { fetchSessionMessages, compat, resetCompatState } from '../opencode-plugin/memside.js'

process.env.MEMSIDE_PORT = '7777'

const js = readFileSync(new URL('../opencode-plugin/memside.js', import.meta.url), 'utf-8')

test('plugin 注册两钩子', () => {
  expect(js).toContain("'experimental.chat.messages.transform'")
  expect(js).toContain('session.idle')
})

test('plugin 端口 env 优先烘焙回退', () => {
  expect(js).toContain('process.env.MEMSIDE_PORT')
  expect(js).toContain('__MEMSIDE_PORT__')
})

test('inject 幂等守卫标记', () => {
  expect(js).toContain('--- BEGIN INJECTED MEMORY ---')
})

test('best-effort catch 不抛回 opencode', () => {
  expect(js).toMatch(/catch/)
})

// --- live-smoke 回归守卫（2026-07-31 真实 opencode 1.15.5 验证产出的修复）---
// 这三条是 live smoke 在真实 opencode + Bun 1.3.14 + 系统代理 :7897 环境下暴露的
// 必修缺陷；plugin 是 opencode 进程内加载的独立 JS（无 TS import），运行时行为只能
// live 验证，故用源码层文本断言兜底（CLAUDE.md「最低限度保留一条源代码层文本断言」）。
// 任一修复被回退 -> 测试红 -> 立刻看出意图。

test('NO_PROXY 旁路 loopback（bun fetch 会代理 127.0.0.1 导致 502）', () => {
  // bun fetch 原生尊重 HTTP_PROXY 且不豁免 loopback；不追加 NO_PROXY 则 capture+inject
  // 双双被系统代理拦截静默 502。必须追加（非覆盖）127.0.0.1,localhost。
  expect(js).toContain('NO_PROXY')
  expect(js).toMatch(/127\.0\.0\.1.*localhost|localhost.*127\.0\.0\.1/)
  // 追加而非覆盖：保留用户既有 NO_PROXY
  expect(js).toMatch(/process\.env\.NO_PROXY.*\+/)
})

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

test('messages 响应归一化兜底 Array.isArray(res.data)', () => {
  // SDK 返回形态可能是数组或 {messages:[]}；用 Array.isArray 判别取真值，避免
  // 形态变更导致 capture 存空 transcript -> distill skipped_no_new_turns。
  expect(js).toContain('Array.isArray(res.data)')
})

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
