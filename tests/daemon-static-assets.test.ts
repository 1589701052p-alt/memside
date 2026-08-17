import { test, expect } from 'bun:test'
import { rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from '@/db/client'
import { ClaudeCodeAdapter } from '@/adapter/claudeCode'
import { OpencodeAdapter } from '@/adapter/opencode'
import { createApp } from '@/server'

// 锁 Spec B 接缝 1：createApp 接 staticAssets（内存静态资产，exe 编译产物用）时，
// GET / 从内存返回 indexHtml、/assets/* 从内存 assets map 返回（不读盘）、缺失 404。
// dev/npm 路径继续用 staticDir 磁盘分支（server-static.test.ts 既有测试覆盖）。
// deps 组装对齐既有 server-static.test.ts 的真实模式（enqueueDistillJob 打桩，
// tracker/callLLM 可选不传）。同时传 staticAssets 与 staticDir 时 staticAssets 优先。
const enc = (s: string) => new TextEncoder().encode(s)

function makeApp(staticAssets?: { indexHtml: string; assets: Record<string, Uint8Array> }) {
  return createApp({
    db,
    adapter: new ClaudeCodeAdapter(db),
    opencodeAdapter: new OpencodeAdapter(db),
    enqueueDistillJob: async () => ({ jobId: 'j', nextRunAt: 0 }),
    broadcast: () => {},
    staticAssets,
  })
}

// EBUSY-safe 模式同 server-static.test.ts / server.test.ts：root 只 wipe 一次、
// 每测试新鲜子目录、afterEach 关 db handle。
const root = join(import.meta.dir, '.tmp-daemon-static-assets')
let dir = ''
let db: ReturnType<typeof openDb>

test('staticAssets: GET / 返回 indexHtml', async () => {
  dir = join(root, Math.random().toString(36).slice(2))
  rmSync(dir, { recursive: true, force: true })
  db = openDb(join(dir, 't.db'))
  const app = makeApp({ indexHtml: '<h1>hi</h1>', assets: {} })
  const res = await app.fetch(new Request('http://x/'))
  expect(res.status).toBe(200)
  expect(await res.text()).toBe('<h1>hi</h1>')
  expect(res.headers.get('content-type')).toContain('text/html')
  db.$client.close()
})

test('staticAssets: GET /assets/x.js 返回内容 + 正确 MIME', async () => {
  dir = join(root, Math.random().toString(36).slice(2))
  rmSync(dir, { recursive: true, force: true })
  db = openDb(join(dir, 't.db'))
  const app = makeApp({ indexHtml: '<h1>hi</h1>', assets: { 'assets/x.js': enc('alert(1)') } })
  const res = await app.fetch(new Request('http://x/assets/x.js'))
  expect(res.status).toBe(200)
  expect(await res.text()).toBe('alert(1)')
  expect(res.headers.get('content-type')).toContain('text/javascript')
  db.$client.close()
})

test('staticAssets: 缺失资产 404', async () => {
  dir = join(root, Math.random().toString(36).slice(2))
  rmSync(dir, { recursive: true, force: true })
  db = openDb(join(dir, 't.db'))
  const app = makeApp({ indexHtml: '<h1>hi</h1>', assets: {} })
  const res = await app.fetch(new Request('http://x/assets/missing.js'))
  expect(res.status).toBe(404)
  db.$client.close()
})

// Task 2 源码层断言兜底：startDaemon 透传 serveStaticAssets 到 createApp。
// 无法直接对 startDaemon 做内存资产集成测（要起真端口+DB），靠源码层文本锁接线。
test('daemon.ts 透传 serveStaticAssets 到 createApp', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'daemon.ts'), 'utf-8')
  expect(src).toContain('serveStaticAssets')
  expect(src).toMatch(/createApp\(\{[^}]*staticAssets:\s*opts\.serveStaticAssets/s)
})
