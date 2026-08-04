import { test, expect, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'

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

test('fetch 响应必查 res.ok（代理劫持时 502 不 throw，防假成功——2026-08-04 TUI 事故）', () => {
  // bun fetch 对 HTTP 错误码照常 resolve 不 throw：被代理拦截时 capture POST 收到
  // 502，旧代码照样记 capture ok，daemon 从未收到请求且零日志可查（TUI capture
  // 因此从第一天起静默全灭）。capture（capRes）+ inject（res）两处 fetch 都必查。
  expect(js).toContain('!capRes.ok')
  expect(js).toContain('!res.ok')
  expect(js.match(/HTTP \$\{/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
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

test('default-only 导出（opencode 1.18.11 加载器拒绝非函数 export）', () => {
  // 2026-08-03 二轮事故：opencode 1.18.11 plugin 加载器遍历模块全部 export——
  // 非函数 export 直接 throw TypeError("Plugin export is not a function") 中断插件加载，
  // 每个函数 export 还会被当作 plugin 调用；1.15.5/1.18.10 只取 default。
  // default-only 是唯一跨版本安全形态——任何新增 named export 都是回归。
  const exportLines = js.split('\n').filter((l) => l.startsWith('export '))
  expect(exportLines.length).toBe(1)
  expect(exportLines[0]).toMatch(/^export default /)
})

// --- SDK 签名探测回归守卫（2026-08-03 事故：opencode 1.15.5 -> 1.18.10 自动升级后
// client.session.messages 签名从 { path: { id } } 翻转回扁平 { sessionID }，plugin
// 旧签名调用失败被 catch 吞掉，capture 静默清零。spec §1a：双签名探测 + 成功记忆。）
// default-only 导出回归后（1.18.11 加载器事故）compat / fetchSessionMessages 不再可
// import，探测逻辑全部改为 hook 驱动验证：idle 事件进、断言 probe 顺序 / POST / 日志。---

type PluginHooks = {
  event: (args: { event: { type: string; properties?: Record<string, unknown> } }) => Promise<void>
  'experimental.chat.messages.transform': (
    input: unknown,
    output: { messages: Array<{ info?: { role?: string }; parts: Array<Record<string, unknown>> }> },
  ) => Promise<void>
}

// compat.rememberedShape 现为模块私有且外部无法重置；Bun query-string cache busting
// 给每个测试一个全新模块实例，隔离探测记忆态（等价于旧 resetCompatState afterEach）。
let bust = 0
async function freshPlugin(): Promise<{ plugin: (input: { client: unknown; directory: string }) => Promise<PluginHooks> }> {
  const mod = (await import(`../opencode-plugin/memside.js?fresh=${++bust}`)) as {
    default: (input: { client: unknown; directory: string }) => Promise<PluginHooks>
  }
  return { plugin: mod.default }
}

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

test('capture: flat 成功（1.18+ 形态）-> POST + info 日志 + 记忆 flat', async () => {
  const posts = captureFetch()
  const { client, order, logs } = makeFakeClient({
    flat: () => ({ data: [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hi' }] }] }),
  })
  const { plugin } = await freshPlugin()
  const hooks = await plugin({ client, directory: '/tmp/proj' })
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
  expect(order).toEqual(['flat', 'flat']) // 记忆命中，不再试探其它形态
})

test('capture: flat 抛错 -> 回退 path（1.15.x 形态）+ warn 日志 + 记忆 path', async () => {
  const posts = captureFetch()
  const { client, order, logs } = makeFakeClient({
    flat: () => { throw new Error('Expected a string starting with ses') },
    path: () => ({ data: [{ info: { role: 'user' }, parts: [] }] }),
  })
  const { plugin } = await freshPlugin()
  const hooks = await plugin({ client, directory: '/tmp/proj' })
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_t3' } } })
  expect(posts.length).toBe(1)
  expect(order).toEqual(['flat', 'path'])
  expect(logs.some((l) => l.level === 'warn' && l.message.includes('fell back to path'))).toBe(true)
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_t3' } } })
  expect(order).toEqual(['flat', 'path', 'path']) // 记忆后直走 path（此前仅 probe 级覆盖的断言）
})

test('capture: flat 返回无 data 错误对象 -> 回退 path 仍成功（成功判据是 res.data，1.18+ 可能不 throw）', async () => {
  const posts = captureFetch()
  const { client, order } = makeFakeClient({
    flat: () => ({ error: { message: 'Invalid request' } }),
    path: () => ({ data: [{ info: { role: 'user' }, parts: [] }] }),
  })
  const { plugin } = await freshPlugin()
  const hooks = await plugin({ client, directory: '/tmp/proj' })
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
  const { plugin } = await freshPlugin()
  const hooks = await plugin({ client, directory: '/tmp/proj' })
  // hook 必须不 reject（await 解决）——best-effort 契约
  await expect(hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_t4' } } })).resolves.toBeUndefined()
  expect(posts.length).toBe(0)
  expect(logs.some((l) => l.level === 'error' && l.message.includes('capture failed session=ses_t4'))).toBe(true)
})

test('capture: sessionID 缺失 -> 不 POST、error 日志、不抛', async () => {
  const posts = captureFetch()
  const { client, logs } = makeFakeClient({})
  const { plugin } = await freshPlugin()
  const hooks = await plugin({ client, directory: '/tmp/proj' })
  await hooks.event({ event: { type: 'session.idle', properties: {} } })
  expect(posts.length).toBe(0)
  expect(logs.some((l) => l.level === 'error' && l.message.includes('without sessionID'))).toBe(true)
})

test('capture: 非 idle 事件直接跳过', async () => {
  const posts = captureFetch()
  const { client, order } = makeFakeClient({ flat: () => ({ data: [] }) })
  const { plugin } = await freshPlugin()
  const hooks = await plugin({ client, directory: '/tmp/proj' })
  await hooks.event({ event: { type: 'session.updated', properties: { sessionID: 'ses_x' } } })
  expect(posts.length).toBe(0)
  expect(order).toEqual([])
})

test('inject: GET 失败 -> error 日志、不抛回 opencode', async () => {
  globalThis.fetch = (async () => { throw new Error('ECONNREFUSED 127.0.0.1:7777') }) as unknown as typeof fetch
  const { client, logs } = makeFakeClient({})
  const { plugin } = await freshPlugin()
  const hooks = await plugin({ client, directory: '/tmp/proj' })
  await hooks['experimental.chat.messages.transform']({}, {
    messages: [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' }] }],
  })
  expect(logs.some((l) => l.level === 'error' && l.message.includes('inject transform failed'))).toBe(true)
})

test('capture: 端点非 2xx（代理 502 假 resolve）-> error 日志含状态码，绝不记 capture ok', async () => {
  // 2026-08-04 TUI 事故复现：POST 经系统代理被 502，fetch 照常 resolve——
  // 若 plugin 不查 res.ok 会记 capture ok 假成功。修复后必须 error 且带状态码。
  globalThis.fetch = (async () => new Response('Bad Gateway', { status: 502 })) as unknown as typeof fetch
  const { client, logs } = makeFakeClient({ flat: () => ({ data: [{ info: { role: 'user' }, parts: [] }] }) })
  const { plugin } = await freshPlugin()
  const hooks = await plugin({ client, directory: '/tmp/proj' })
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_proxy502' } } })
  expect(logs.some((l) => l.level === 'error' && l.message.includes('capture failed session=ses_proxy502') && l.message.includes('502'))).toBe(true)
  expect(logs.some((l) => l.level === 'info' && l.message.includes('capture ok'))).toBe(false)
})

test('inject: 端点非 2xx（代理 502 假 resolve）-> error 日志含状态码', async () => {
  globalThis.fetch = (async () => new Response('Bad Gateway', { status: 502 })) as unknown as typeof fetch
  const { client, logs } = makeFakeClient({})
  const { plugin } = await freshPlugin()
  const hooks = await plugin({ client, directory: '/tmp/proj' })
  await hooks['experimental.chat.messages.transform']({}, {
    messages: [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' }] }],
  })
  expect(logs.some((l) => l.level === 'error' && l.message.includes('inject transform failed') && l.message.includes('502'))).toBe(true)
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
    const { plugin } = await freshPlugin()
    const hooks = await plugin({ client, directory: '/tmp/proj' })
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
