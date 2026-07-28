import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { ClaudeCodeAdapter } from '@/adapter/claudeCode'
import { createApp } from '@/server'

// 一键启动（2026-07-28-one-click-launch）：锁 createApp 的 staticDir 托管行为。
// EBUSY-safe 模式同 server.test.ts：root 只 wipe 一次、每测试新鲜子目录、
// afterEach 关 db handle。
const root = join(import.meta.dir, '.tmp-server-static')
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

function makeApp(staticDir?: string) {
  return createApp({
    db,
    adapter: new ClaudeCodeAdapter(db),
    enqueueDistillJob: async () => ({ jobId: 'j', nextRunAt: 0 }),
    broadcast: () => {},
    staticDir,
  })
}

/** 在每测试 tmp dir 里伪造一份 vite build 产物。 */
function makeDist(): string {
  const dist = join(dir, 'dist')
  mkdirSync(join(dist, 'assets'), { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>memside-ui</title>')
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log("memside-asset")')
  return dist
}

test('GET / serves index.html when staticDir is provided', async () => {
  const app = makeApp(makeDist())
  const res = await app.fetch(new Request('http://x/'))
  expect(res.status).toBe(200)
  expect(await res.text()).toContain('memside-ui')
})

test('GET /assets/* serves static files when staticDir is provided', async () => {
  const app = makeApp(makeDist())
  const res = await app.fetch(new Request('http://x/assets/app.js'))
  expect(res.status).toBe(200)
  expect(await res.text()).toContain('memside-asset')
})

test('named API routes are not shadowed by static handling', async () => {
  const app = makeApp(makeDist())
  const res = await app.fetch(new Request('http://x/api/memories'))
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body).toEqual({ items: [] })
})

test('GET / does NOT serve static content without staticDir (unchanged behavior)', async () => {
  const app = makeApp()
  const res = await app.fetch(new Request('http://x/'))
  expect(res.status).toBe(404)
})
