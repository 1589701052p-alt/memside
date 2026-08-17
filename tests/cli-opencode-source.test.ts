// 锁 cli.ts 在 start / start-and-install 给 startDaemon 传 opencodePluginSource（spec §3.5）。
// CLI 顶层 if/else 难单测，用源码层文本断言兜底（CLAUDE.md 运行时组件最低面）。
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const cliSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts'), 'utf-8')
const launcherSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'exe', 'launcher.ts'), 'utf-8')

test('cli.ts start + start-and-install 传 opencodePluginSource.srcDir', () => {
  expect(cliSrc).toContain('opencodePluginSource')
  expect(cliSrc).toContain('srcDir: pluginSrcDir')
})

test('launcher.ts 传 opencodePluginSource.files', () => {
  expect(launcherSrc).toContain('opencodePluginSource')
  expect(launcherSrc).toContain("files: { 'memside.js': ea.pluginJs, 'package.json': ea.pluginPkg }")
})
