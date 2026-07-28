import { test, expect, beforeAll, beforeEach } from 'bun:test'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startDaemon } from '@/daemon'

// 本地 HTTP_PROXY 会拦截 127.0.0.1 请求导致 fetch 返回 502；按 CLAUDE.md 指南
// 对 loopback 排除代理。此设置只影响本测试文件。
process.env.NO_PROXY = '127.0.0.1,localhost'

// 一键启动（2026-07-28-one-click-launch）：锁 startDaemon 的 serveStaticDir
// 透传——真实 Bun.serve 起来后 GET / 能拿到构建产物。port:0 让 Bun 挑空闲
// 端口，避免与 7777 上可能在跑的 live daemon 冲突。
// 注意：startDaemon 内部自开 db 且不暴露 handle，无法 close；每测试用新鲜
// 子目录、不删目录（EBUSY-safe）。
const root = join(import.meta.dir, '.tmp-daemon-static')
let dir = ''

beforeAll(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
})

beforeEach(() => {
  dir = join(root, Math.random().toString(36).slice(2))
  mkdirSync(dir, { recursive: true })
})

test('startDaemon serves built UI at GET / when serveStaticDir is provided', async () => {
  const dist = join(dir, 'dist')
  mkdirSync(join(dist, 'assets'), { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>memside-daemon-ui</title>')
  const { server, stop } = await startDaemon({
    dbPath: join(dir, 't.db'),
    port: 0,
    serveStaticDir: dist,
  })
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('memside-daemon-ui')
    // 具名路由不受影响
    const api = await fetch(`http://127.0.0.1:${server.port}/api/memories`)
    expect(api.status).toBe(200)
    expect(await api.json()).toEqual({ items: [] })
  } finally {
    stop()
  }
})
