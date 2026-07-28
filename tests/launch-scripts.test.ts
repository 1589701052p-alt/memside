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
  expect(src).toContain('daemon.kill()')
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
