import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

// 锁 Spec B 接缝 5：package.json files allowlist 只发运行时所需，
// 不把 tests/docs/scripts/源码 web/.superpowers 入包；dist 随包发布。
test('package.json 非私有 + files allowlist 正确', () => {
  const pkg = JSON.parse(readFileSync(import.meta.dir + '/../package.json', 'utf-8'))
  expect(pkg.private).toBe(false)
  const files: string[] = pkg.files
  // 必含运行时所需
  expect(files).toContain('src')
  expect(files).toContain('opencode-plugin')
  expect(files).toContain('tsconfig.json')
  // 必不含（allowlist 模式，未列即不发）
  expect(files).not.toContain('tests')
  expect(files).not.toContain('docs')
  expect(files).not.toContain('scripts')
  expect(files).not.toContain('vite.config.ts')
})

test('package.json 含构建脚本', () => {
  const pkg = JSON.parse(readFileSync(import.meta.dir + '/../package.json', 'utf-8'))
  expect(pkg.scripts['build:exe']).toBeDefined()
  expect(pkg.scripts['build:installer']).toBeDefined()
  expect(pkg.scripts['prepublishOnly']).toContain('build')
})

test('bin 仍指向 src/cli.ts（npm 路径）', () => {
  const pkg = JSON.parse(readFileSync(import.meta.dir + '/../package.json', 'utf-8'))
  expect(pkg.bin?.memside).toBe('src/cli.ts')
})
