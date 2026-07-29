import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// 一键启动（2026-07-28-one-click-launch）：源代码层文本断言兜底（CLAUDE.md
// 允许的运行时最低限度）。锁的是「关键防护不被人顺手删掉」：start.ts 的
// dist 缺失报错、package.json 的命令面。
const repoRoot = join(import.meta.dir, '..')

test('scripts/start.ts errors out with a build hint when dist is missing', () => {
  const src = readFileSync(join(repoRoot, 'scripts', 'start.ts'), 'utf8')
  expect(src).toContain('index.html')
  expect(src).toContain('bun run build')
  expect(src).toContain('process.exit(1)')
})

test('scripts/start.ts starts daemon with hooks + static hosting', () => {
  const src = readFileSync(join(repoRoot, 'scripts', 'start.ts'), 'utf8')
  expect(src).toContain('installClaudeHooks: true')
  expect(src).toContain('serveStaticDir')
})

test('package.json exposes build/start one-click scripts', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  expect(pkg.scripts.build).toBe('vite build')
  expect(pkg.scripts.start).toBe('bun run build && bun run scripts/start.ts')
})

test('scripts/dev.ts reaps both children on signals and first-exit', () => {
  const src = readFileSync(join(repoRoot, 'scripts', 'dev.ts'), 'utf8')
  expect(src).toContain("process.on('SIGINT'")
  expect(src).toContain("process.on('SIGTERM'")
  expect(src).toContain('daemon.kill()')
  expect(src).toContain('web.kill()')
  expect(src).toContain('process.execPath')
  expect(src).toContain('await Promise.allSettled([daemon.exited, web.exited])')
  expect(src).toMatch(/catch\s*\(e\)\s*{[^}]*daemon\.kill\(\)[^}]*await\s+daemon\.exited/s)
  expect(src).toContain('throw e')
})

test('scripts/dev.ts prefixes child output lines with [daemon] / [web]', () => {
  const src = readFileSync(join(repoRoot, 'scripts', 'dev.ts'), 'utf8')
  expect(src).toContain('[${name}]')
  expect(src).toContain("spawnLogged('daemon'")
  expect(src).toContain("spawnLogged('web'")
})

test('package.json exposes dev one-click script', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  expect(pkg.scripts.dev).toBe('bun run scripts/dev.ts')
})

test('vite.config.ts bypasses system HTTP_PROXY for loopback proxy upstream', () => {
  // 系统代理（如 Clash 7897）会拦截 vite proxy 到 daemon(127.0.0.1:7777) 的
  // loopback upstream -> 前端「连不上 daemon / Unexpected end of JSON input」。
  // vite.config 顶层设 NO_PROXY 含 127.0.0.1 让 Bun http 绕过代理（CLAUDE.md
  // loopback 排除代理陷阱）。覆盖 dev / dev:web 所有 vite 入口。
  const src = readFileSync(join(repoRoot, 'vite.config.ts'), 'utf8')
  expect(src).toContain('NO_PROXY')
  expect(src).toContain('127.0.0.1')
})

test('scripts/start.ts wires port-reclaim guard before startDaemon', () => {
  const src = readFileSync(join(repoRoot, 'scripts', 'start.ts'), 'utf8')
  expect(src).toContain('findPortHolders')
  expect(src).toContain('promptReclaim')
  expect(src).toContain('reclaim(')
})

test('scripts/dev.ts wires port-reclaim guard before spawn', () => {
  const src = readFileSync(join(repoRoot, 'scripts', 'dev.ts'), 'utf8')
  expect(src).toContain('findPortHolders')
  expect(src).toContain('promptReclaim')
  expect(src).toContain('reclaim(')
})
