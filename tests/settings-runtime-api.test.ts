// spec: docs/superpowers/specs/2026-08-19-runtime-settings-four-slots-*.md §3.6
// 锁 5 个 /api/settings/runtime* 端点形状 + install/uninstall 经注入点（不碰真实 ~/.claude）。
// 四槽形状：claude/codeagent（hooks 型，dir+settingsFilename）/ opencode/nga（plugin 型，dir）。
import { test, expect, beforeAll, beforeEach, afterEach, describe } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { ClaudeCodeAdapter } from '@/adapter/claudeCode'
import { OpencodeAdapter } from '@/adapter/opencode'
import { createApp } from '@/server'

const root = join(import.meta.dir, '.tmp-settings-runtime-api')
let dir = ''
let db: ReturnType<typeof openDb>

beforeAll(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
})

beforeEach(() => {
  dir = join(root, Math.random().toString(36).slice(2))
  mkdirSync(dir, { recursive: true })
  db = openDb(join(dir, 't.db'))
})

afterEach(() => {
  db.$client.close()
})

function makeApp(overrides: {
  installHooksFn?: (opts: { port: number; baseDir?: string; settingsFilename?: string }) => void
  uninstallHooksFn?: (opts: { baseDir?: string; settingsFilename?: string }) => { removed: number; settingsPath: string }
  installOpencodePluginFn?: (opts: { baseDir?: string }) => void
  uninstallOpencodePluginFn?: (opts: { baseDir?: string }) => { removed: number; pluginPath: string; dirRemoved: boolean }
  isHooksInstalledFn?: (opts: { baseDir?: string; settingsFilename?: string }) => { installed: boolean; settingsPath: string }
  isOpencodePluginInstalledFn?: (opts: { baseDir?: string }) => { installed: boolean; pluginPath: string; dirExists: boolean }
} = {}) {
  return createApp({
    db,
    adapter: new ClaudeCodeAdapter(db),
    opencodeAdapter: new OpencodeAdapter(db),
    enqueueDistillJob: async () => ({ jobId: 'j', nextRunAt: 0 }),
    broadcast: () => {},
    ...overrides,
  })
}

async function req(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  const res = await app.fetch(new Request(`http://x${path}`, init))
  return { status: res.status, body: await res.json().catch(() => null) }
}

const putJson = (body: unknown): RequestInit => ({ method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const post = (path: string): RequestInit => ({ method: 'POST' })

// === 四槽 + status（spec 2026-08-19-runtime-settings-four-slots）===
describe('runtime 四槽 + status', () => {
  test('GET 返回四槽 + defaults 形状', async () => {
    const app = makeApp()
    const { status, body } = await req(app, '/api/settings/runtime')
    expect(status).toBe(200)
    expect(body.claude).toEqual(expect.objectContaining({ dir: expect.any(String), settingsFilename: 'settings.json' }))
    expect(body.codeagent).toEqual(expect.objectContaining({ dir: expect.any(String), settingsFilename: 'setting.json' }))
    expect(body.opencode).toEqual(expect.objectContaining({ dir: expect.any(String) }))
    expect(body.nga).toEqual(expect.objectContaining({ dir: expect.any(String) }))
    expect(body.defaults).toBeDefined()
    expect(body.defaults.codeagent.settingsFilename).toBe('setting.json')
  })

  test('PUT per-slot 只改本槽', async () => {
    const app = makeApp()
    await req(app, '/api/settings/runtime', putJson({ claude: { dir: '/x/.claude' } }))
    const { body } = await req(app, '/api/settings/runtime')
    expect(body.claude.dir).toBe('/x/.claude')
    // codeagent 未传 -> 与默认一致（不动）
    expect(body.codeagent).toEqual(body.defaults.codeagent)
  })

  test('GET status 注入 fake 探针', async () => {
    const calls: any[] = []
    const app = makeApp({
      isHooksInstalledFn: (o) => {
        calls.push(['hooks', o])
        return { installed: o.settingsFilename === 'setting.json', settingsPath: join(o.baseDir ?? '', o.settingsFilename ?? 'settings.json') }
      },
      isOpencodePluginInstalledFn: (o) => { calls.push(['oc', o]); return { installed: true, pluginPath: 'p', dirExists: true } },
    })
    const { status, body } = await req(app, '/api/settings/runtime/status')
    expect(status).toBe(200)
    expect(body.claude.installed).toBe(false) // claude settingsFilename !== 'setting.json'
    expect(body.codeagent.installed).toBe(true) // codeagent settingsFilename === 'setting.json'
    expect(body.opencode.installed).toBe(true)
    expect(body.nga.installed).toBe(true)
    // fake 收到的 baseDir 已展开（无 ~）
    expect(calls.some((c) => c[0] === 'hooks' && !c[1].baseDir.includes('~'))).toBe(true)
  })

  test('GET status 探针缺省 -> installed:false 不抛', async () => {
    const app = makeApp() // 不注入探针
    const { status, body } = await req(app, '/api/settings/runtime/status')
    expect(status).toBe(200)
    expect(body.claude.installed).toBe(false)
    expect(body.codeagent.installed).toBe(false)
    expect(body.opencode.installed).toBe(false)
    expect(body.nga.installed).toBe(false)
    // 仍给出推断路径
    expect(typeof body.claude.path).toBe('string')
  })

  test('install?target=codeagent 调 installHooksFn 传 codeagent 槽字段', async () => {
    const calls: any[] = []
    const app = makeApp({ installHooksFn: (o) => { calls.push(o) } })
    await req(app, '/api/settings/runtime', putJson({ codeagent: { dir: '~/.cac', settingsFilename: 'setting.json' } }))
    const { status, body } = await req(app, '/api/settings/runtime/install?target=codeagent', post('/api/settings/runtime/install?target=codeagent'))
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(calls[0].settingsFilename).toBe('setting.json')
    expect(calls[0].baseDir.replace(/\\/g, '/').endsWith('.cac')).toBe(true)
  })

  test('uninstall?target=codeagent', async () => {
    const app = makeApp({ uninstallHooksFn: () => ({ removed: 2, settingsPath: 'p' }) })
    await req(app, '/api/settings/runtime', putJson({ codeagent: { dir: '~/.cac' } }))
    const { status, body } = await req(app, '/api/settings/runtime/uninstall?target=codeagent', post('/api/settings/runtime/uninstall?target=codeagent'))
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.removed).toBe(2)
  })

  test('install?target=nga 调 installOpencodePluginFn 传 nga 槽 dir', async () => {
    const calls: any[] = []
    const app = makeApp({ installOpencodePluginFn: (o) => { calls.push(o) } })
    await req(app, '/api/settings/runtime', putJson({ nga: { dir: '~/.config/nga' } }))
    const { status, body } = await req(app, '/api/settings/runtime/install?target=nga', post('/api/settings/runtime/install?target=nga'))
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(calls[0].baseDir.replace(/\\/g, '/').endsWith('nga')).toBe(true)
  })

  test('install?target=claude 默认行为不变（回归锁）', async () => {
    const calls: any[] = []
    const app = makeApp({ installHooksFn: (o) => { calls.push(o) } })
    await req(app, '/api/settings/runtime', putJson({ claude: { dir: '~/.claude' } }))
    await req(app, '/api/settings/runtime/install', post('/api/settings/runtime/install')) // 无 target -> claude
    expect(calls[0].baseDir.replace(/\\/g, '/').endsWith('.claude')).toBe(true)
  })

  test('target=invalid -> 400', async () => {
    const app = makeApp()
    const { status, body } = await req(app, '/api/settings/runtime/install?target=foo', post('/api/settings/runtime/install?target=foo'))
    expect(status).toBe(400)
    expect(body.error).toBeTruthy()
  })

  test('install?target=nga 缺 installOpencodePluginFn -> ok:false', async () => {
    const app = makeApp() // 不注入 installOpencodePluginFn
    const { status, body } = await req(app, '/api/settings/runtime/install?target=nga', post('/api/settings/runtime/install?target=nga'))
    expect(status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.error).toContain('不可用')
  })
})

// === 旧回归锁：claude/opencode 槽既有行为逐字节一致（形状换代）===
describe('runtime 回归锁（四槽形状）', () => {
  test('GET /api/settings/runtime returns defaults when unconfigured', async () => {
    const app = makeApp()
    const { status, body } = await req(app, '/api/settings/runtime')
    expect(status).toBe(200)
    expect(body.claude).toEqual(body.defaults.claude)
    expect(body.claude.settingsFilename).toBe('settings.json')
    expect(body.codeagent.settingsFilename).toBe('setting.json')
  })

  test('PUT /api/settings/runtime saves + returns updated state', async () => {
    const app = makeApp()
    const { status, body } = await req(app, '/api/settings/runtime', putJson({ claude: { dir: '/home/u/.cac', settingsFilename: 'setting.json' } }))
    expect(status).toBe(200)
    expect(body.claude.dir).toBe('/home/u/.cac')
    expect(body.claude.settingsFilename).toBe('setting.json')
    // opencode 槽未传 -> 默认
    expect(body.opencode).toEqual(body.defaults.opencode)
    // 持久化：再 GET 仍是新值
    const g = await req(app, '/api/settings/runtime')
    expect(g.body.claude.dir).toBe('/home/u/.cac')
  })

  test('PUT rejects non-string values with 400', async () => {
    const app = makeApp()
    const { status, body } = await req(app, '/api/settings/runtime', putJson({ claude: { dir: 123 } }))
    expect(status).toBe(400)
    expect(body.error).toBeTruthy()
  })

  test('POST /api/settings/runtime/install calls installHooksFn with saved paths + port', async () => {
    let called: { port: number; baseDir?: string; settingsFilename?: string } | null = null
    const app = makeApp({ installHooksFn: (opts) => { called = opts } })
    await req(app, '/api/settings/runtime', putJson({ claude: { dir: '/home/u/.cac', settingsFilename: 'setting.json' } }))
    const { status, body } = await req(app, '/api/settings/runtime/install', post('/api/settings/runtime/install'))
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.settingsPath).toBe(join('/home/u/.cac', 'setting.json'))
    expect(called).not.toBeNull()
    expect(called!.baseDir).toBe('/home/u/.cac')
    expect(called!.settingsFilename).toBe('setting.json')
    expect(typeof called!.port).toBe('number')
  })

  test('POST /api/settings/runtime/install surfaces install error', async () => {
    const app = makeApp({ installHooksFn: () => { throw new Error('disk full') } })
    const { status, body } = await req(app, '/api/settings/runtime/install', post('/api/settings/runtime/install'))
    expect(status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.error).toContain('disk full')
  })

  test('POST /api/settings/runtime/uninstall calls uninstallHooksFn + returns removed', async () => {
    let called: { baseDir?: string; settingsFilename?: string } | null = null
    const app = makeApp({ uninstallHooksFn: (opts) => { called = opts; return { removed: 5, settingsPath: '/x/setting.json' } } })
    await req(app, '/api/settings/runtime', putJson({ claude: { dir: '/x', settingsFilename: 'setting.json' } }))
    const { status, body } = await req(app, '/api/settings/runtime/uninstall', post('/api/settings/runtime/uninstall'))
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.removed).toBe(5)
    expect(body.settingsPath).toBe('/x/setting.json')
    expect(called!.baseDir).toBe('/x')
    expect(called!.settingsFilename).toBe('setting.json')
  })

  test('POST /api/settings/runtime/uninstall surfaces error', async () => {
    const app = makeApp({ uninstallHooksFn: () => { throw new Error('locked') } })
    const { status, body } = await req(app, '/api/settings/runtime/uninstall', post('/api/settings/runtime/uninstall'))
    expect(status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.error).toContain('locked')
  })

  test('install endpoint expands ~ in claude dir before calling installHooksFn', async () => {
    let called: { baseDir?: string } | null = null
    const app = makeApp({ installHooksFn: (opts) => { called = opts } })
    await req(app, '/api/settings/runtime', putJson({ claude: { dir: '~/.cac' } }))
    await req(app, '/api/settings/runtime/install', post('/api/settings/runtime/install'))
    expect(called!.baseDir).not.toContain('~')
    expect(called!.baseDir!.replace(/\\/g, '/').endsWith('.cac')).toBe(true)
  })

  test('POST install?target=opencode 调 installOpencodePluginFn 传已存 opencode dir', async () => {
    let called: { baseDir?: string } | null = null
    const app = makeApp({ installOpencodePluginFn: (opts) => { called = opts } })
    await req(app, '/api/settings/runtime', putJson({ opencode: { dir: '/home/u/.config/opencode' } }))
    const { status, body } = await req(app, '/api/settings/runtime/install?target=opencode', post('/api/settings/runtime/install?target=opencode'))
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.pluginPath).toBeTruthy()
    expect(called!.baseDir).toBe('/home/u/.config/opencode')
  })

  test('POST install?target=opencode 缺 installOpencodePluginFn → ok:false 含不可用提示', async () => {
    const app = makeApp()
    await req(app, '/api/settings/runtime', putJson({ opencode: { dir: '/x/opencode' } }))
    const { body } = await req(app, '/api/settings/runtime/install?target=opencode', post('/api/settings/runtime/install?target=opencode'))
    expect(body.ok).toBe(false)
    expect(body.error).toContain('不可用')
  })

  test('POST install?target=opencode 抛错 → ok:false error', async () => {
    const app = makeApp({ installOpencodePluginFn: () => { throw new Error('ro locked') } })
    await req(app, '/api/settings/runtime', putJson({ opencode: { dir: '/x' } }))
    const { body } = await req(app, '/api/settings/runtime/install?target=opencode', post('/api/settings/runtime/install?target=opencode'))
    expect(body.ok).toBe(false)
    expect(body.error).toContain('ro locked')
  })

  test('POST uninstall?target=opencode 调 uninstallOpencodePluginFn 返回 removed/dirRemoved', async () => {
    let called: { baseDir?: string } | null = null
    const app = makeApp({ uninstallOpencodePluginFn: (opts) => { called = opts; return { removed: 1, pluginPath: '/x/opencode.json', dirRemoved: true } } })
    await req(app, '/api/settings/runtime', putJson({ opencode: { dir: '/x/opencode' } }))
    const { status, body } = await req(app, '/api/settings/runtime/uninstall?target=opencode', post('/api/settings/runtime/uninstall?target=opencode'))
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.removed).toBe(1)
    expect(body.dirRemoved).toBe(true)
    expect(body.pluginPath).toBe('/x/opencode.json')
    expect(called!.baseDir).toBe('/x/opencode')
  })

  test('POST uninstall?target=opencode 抛错 → ok:false error', async () => {
    const app = makeApp({ uninstallOpencodePluginFn: () => { throw new Error('perm') } })
    await req(app, '/api/settings/runtime', putJson({ opencode: { dir: '/x' } }))
    const { body } = await req(app, '/api/settings/runtime/uninstall?target=opencode', post('/api/settings/runtime/uninstall?target=opencode'))
    expect(body.ok).toBe(false)
    expect(body.error).toContain('perm')
  })

  test('install?target=opencode 展开 ~ in opencode dir', async () => {
    let called: { baseDir?: string } | null = null
    const app = makeApp({ installOpencodePluginFn: (opts) => { called = opts } })
    await req(app, '/api/settings/runtime', putJson({ opencode: { dir: '~/.config/opencode' } }))
    await req(app, '/api/settings/runtime/install?target=opencode', post('/api/settings/runtime/install?target=opencode'))
    expect(called!.baseDir).not.toContain('~')
    expect(called!.baseDir!.replace(/\\/g, '/').endsWith('.config/opencode')).toBe(true)
  })

  test('install?target=claude（默认）与既有行为逐字节一致（回归锁）', async () => {
    let called: { port: number; baseDir?: string; settingsFilename?: string } | null = null
    const app = makeApp({ installHooksFn: (opts) => { called = opts } })
    await req(app, '/api/settings/runtime', putJson({ claude: { dir: '/home/u/.cac', settingsFilename: 'setting.json' } }))
    const { body } = await req(app, '/api/settings/runtime/install', post('/api/settings/runtime/install'))
    expect(body.ok).toBe(true)
    expect(body.settingsPath).toBe(join('/home/u/.cac', 'setting.json'))
    expect(called!.baseDir).toBe('/home/u/.cac')
    expect(called!.settingsFilename).toBe('setting.json')
  })

  test('install?target=invalid → 400', async () => {
    const app = makeApp()
    const { status, body } = await req(app, '/api/settings/runtime/install?target=bogus', post('/api/settings/runtime/install?target=bogus'))
    expect(status).toBe(400)
    expect(body.error).toBeTruthy()
  })
})
