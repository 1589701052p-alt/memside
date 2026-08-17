// spec: docs/superpowers/specs/2026-08-17-runtime-path-config-design.md §3.6
// 锁 4 个 /api/settings/runtime* 端点形状 + install/uninstall 经注入点（不碰真实 ~/.claude）。
import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
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

test('GET /api/settings/runtime returns defaults when unconfigured', async () => {
  const app = makeApp()
  const { status, body } = await req(app, '/api/settings/runtime')
  expect(status).toBe(200)
  expect(body.claudeDir).toBe(body.defaults.claudeDir)
  expect(body.settingsFilename).toBe('settings.json')
  expect(body.defaults.settingsFilename).toBe('settings.json')
})

test('PUT /api/settings/runtime saves + returns updated state', async () => {
  const app = makeApp()
  const { status, body } = await req(app, '/api/settings/runtime', putJson({ claudeDir: '/home/u/.cac', settingsFilename: 'setting.json' }))
  expect(status).toBe(200)
  expect(body.claudeDir).toBe('/home/u/.cac')
  expect(body.settingsFilename).toBe('setting.json')
  // opencodeDir 未传 -> 默认
  expect(body.opencodeDir).toBe(body.defaults.opencodeDir)
  // 持久化：再 GET 仍是新值
  const g = await req(app, '/api/settings/runtime')
  expect(g.body.claudeDir).toBe('/home/u/.cac')
})

test('PUT rejects non-string values with 400', async () => {
  const app = makeApp()
  const { status, body } = await req(app, '/api/settings/runtime', putJson({ claudeDir: 123 }))
  expect(status).toBe(400)
  expect(body.error).toBeTruthy()
})

test('POST /api/settings/runtime/install calls installHooksFn with saved paths + port', async () => {
  let called: { port: number; baseDir?: string; settingsFilename?: string } | null = null
  const app = makeApp({
    installHooksFn: (opts) => { called = opts },
  })
  // 先存自定义路径
  await req(app, '/api/settings/runtime', putJson({ claudeDir: '/home/u/.cac', settingsFilename: 'setting.json' }))
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
  const app = makeApp({
    installHooksFn: () => { throw new Error('disk full') },
  })
  const { status, body } = await req(app, '/api/settings/runtime/install', post('/api/settings/runtime/install'))
  expect(status).toBe(200) // 业务结果，不是请求错误
  expect(body.ok).toBe(false)
  expect(body.error).toContain('disk full')
})

test('POST /api/settings/runtime/uninstall calls uninstallHooksFn + returns removed', async () => {
  let called: { baseDir?: string; settingsFilename?: string } | null = null
  const app = makeApp({
    uninstallHooksFn: (opts) => { called = opts; return { removed: 5, settingsPath: '/x/setting.json' } },
  })
  await req(app, '/api/settings/runtime', putJson({ claudeDir: '/x', settingsFilename: 'setting.json' }))
  const { status, body } = await req(app, '/api/settings/runtime/uninstall', post('/api/settings/runtime/uninstall'))
  expect(status).toBe(200)
  expect(body.ok).toBe(true)
  expect(body.removed).toBe(5)
  expect(body.settingsPath).toBe('/x/setting.json')
  expect(called!.baseDir).toBe('/x')
  expect(called!.settingsFilename).toBe('setting.json')
})

test('POST /api/settings/runtime/uninstall surfaces error', async () => {
  const app = makeApp({
    uninstallHooksFn: () => { throw new Error('locked') },
  })
  const { status, body } = await req(app, '/api/settings/runtime/uninstall', post('/api/settings/runtime/uninstall'))
  expect(status).toBe(200)
  expect(body.ok).toBe(false)
  expect(body.error).toContain('locked')
})

test('install endpoint expands ~ in claudeDir before calling installHooksFn', async () => {
  let called: { baseDir?: string } | null = null
  const app = makeApp({ installHooksFn: (opts) => { called = opts } })
  await req(app, '/api/settings/runtime', putJson({ claudeDir: '~/.cac' }))
  await req(app, '/api/settings/runtime/install', post('/api/settings/runtime/install'))
  expect(called!.baseDir).not.toContain('~') // ~ 已展开为真实 home
  expect(called!.baseDir!.endsWith('.cac')).toBe(true)
})

test('POST install?target=opencode 调 installOpencodePluginFn 传已存 opencodeDir + port', async () => {
  let called: { baseDir?: string } | null = null
  const app = makeApp({ installOpencodePluginFn: (opts) => { called = opts } })
  await req(app, '/api/settings/runtime', putJson({ opencodeDir: '/home/u/.config/opencode' }))
  const { status, body } = await req(app, '/api/settings/runtime/install?target=opencode', post('/api/settings/runtime/install?target=opencode'))
  expect(status).toBe(200)
  expect(body.ok).toBe(true)
  expect(body.pluginPath).toBeTruthy()
  expect(called!.baseDir).toBe('/home/u/.config/opencode')
})

test('POST install?target=opencode 缺 installOpencodePluginFn → ok:false 含不可用提示', async () => {
  const app = makeApp() // 不注入 installOpencodePluginFn
  await req(app, '/api/settings/runtime', putJson({ opencodeDir: '/x/opencode' }))
  const { body } = await req(app, '/api/settings/runtime/install?target=opencode', post('/api/settings/runtime/install?target=opencode'))
  expect(body.ok).toBe(false)
  expect(body.error).toContain('不可用')
})

test('POST install?target=opencode 抛错 → ok:false error', async () => {
  const app = makeApp({ installOpencodePluginFn: () => { throw new Error('ro locked') } })
  await req(app, '/api/settings/runtime', putJson({ opencodeDir: '/x' }))
  const { body } = await req(app, '/api/settings/runtime/install?target=opencode', post('/api/settings/runtime/install?target=opencode'))
  expect(body.ok).toBe(false)
  expect(body.error).toContain('ro locked')
})

test('POST uninstall?target=opencode 调 uninstallOpencodePluginFn 返回 removed/dirRemoved', async () => {
  let called: { baseDir?: string } | null = null
  const app = makeApp({ uninstallOpencodePluginFn: (opts) => { called = opts; return { removed: 1, pluginPath: '/x/opencode.json', dirRemoved: true } } })
  await req(app, '/api/settings/runtime', putJson({ opencodeDir: '/x/opencode' }))
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
  await req(app, '/api/settings/runtime', putJson({ opencodeDir: '/x' }))
  const { body } = await req(app, '/api/settings/runtime/uninstall?target=opencode', post('/api/settings/runtime/uninstall?target=opencode'))
  expect(body.ok).toBe(false)
  expect(body.error).toContain('perm')
})

test('install?target=opencode 展开 ~ in opencodeDir', async () => {
  let called: { baseDir?: string } | null = null
  const app = makeApp({ installOpencodePluginFn: (opts) => { called = opts } })
  await req(app, '/api/settings/runtime', putJson({ opencodeDir: '~/.config/opencode' }))
  await req(app, '/api/settings/runtime/install?target=opencode', post('/api/settings/runtime/install?target=opencode'))
  expect(called!.baseDir).not.toContain('~')
  // 平台归一化：Windows path.join 产出反斜杠；brief 原断言 endsWith('.config/opencode') 假设 POSIX。
  expect(called!.baseDir!.replace(/\\/g, '/').endsWith('.config/opencode')).toBe(true)
})

test('install?target=claude（默认）与既有行为逐字节一致（回归锁）', async () => {
  let called: { port: number; baseDir?: string; settingsFilename?: string } | null = null
  const app = makeApp({ installHooksFn: (opts) => { called = opts } })
  await req(app, '/api/settings/runtime', putJson({ claudeDir: '/home/u/.cac', settingsFilename: 'setting.json' }))
  // 不带 target query
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
