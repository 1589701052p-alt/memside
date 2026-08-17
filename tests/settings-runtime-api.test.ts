// spec: docs/superpowers/specs/2026-08-17-runtime-path-config-design.md §3.6
// 锁 4 个 /api/settings/runtime* 端点形状 + install/uninstall 经注入点（不碰真实 ~/.claude）。
import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { ClaudeCodeAdapter } from '@/adapter/claudeCode'
import { OpencodeAdapter } from '@/adapter/opencode'
import { createApp } from '@/server'
import { MEMSIDE_TAG } from '@/install'

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
