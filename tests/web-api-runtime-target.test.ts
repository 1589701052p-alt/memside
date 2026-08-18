// 锁 installRuntimeHooks/uninstallRuntimeHooks 携 target query + 扩展返回类型（spec §3.5）。
// wrapper 是薄 fetch 封装，用源码层文本断言（与既有 web-api 测试同模式）。
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const apiSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web', 'api.ts'), 'utf-8')

test('installRuntimeHooks 默认 target=claude，带 target 选项', () => {
  expect(apiSrc).toMatch(/installRuntimeHooks\(\s*target[:\s]*'claude'\s*\|\s*'opencode'\s*=\s*'claude'/)
  expect(apiSrc).toContain('install?target=${target}')
  expect(apiSrc).toContain('pluginPath')
})

test('uninstallRuntimeHooks 默认 target=claude，返回含 dirRemoved', () => {
  expect(apiSrc).toMatch(/uninstallRuntimeHooks\(\s*target[:\s]*'claude'\s*\|\s*'opencode'\s*=\s*'claude'/)
  expect(apiSrc).toContain('uninstall?target=${target}')
  expect(apiSrc).toContain('dirRemoved')
})
