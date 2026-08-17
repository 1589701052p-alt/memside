// spec: docs/superpowers/specs/2026-08-17-runtime-path-config-design.md §7.5
// 运行时组件兜底面（CLAUDE.md 最低要求）：RuntimeSettings section 挂载点 + 安装/卸载按钮。
// App.tsx 无法在 bun test 直接渲染（需 vite/浏览器），靠源码层文本断言锁接线存在。
import { test, expect } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const appPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web', 'App.tsx')

test('App.tsx mounts RuntimeSettings section in settings tab', () => {
  const src = readFileSync(appPath, 'utf-8')
  // 挂载点存在（与 LlmSettings/JudgeSettings 同级）
  expect(src).toContain('<RuntimeSettings />')
  // 组件定义存在
  expect(src).toContain('function RuntimeSettings()')
  // 安装 + 卸载按钮接线
  expect(src).toContain('installRuntimeHooks')
  expect(src).toContain('uninstallRuntimeHooks')
  // 三个路径输入字段接线（claudeDir / settingsFilename / opencodeDir）
  expect(src).toContain('claudeDir')
  expect(src).toContain('settingsFilename')
  expect(src).toContain('opencodeDir')
})

test('RuntimeSettings section uses standard section convention', () => {
  const src = readFileSync(appPath, 'utf-8')
  // 与 LlmSettings/JudgeSettings 同款 section + h3 结构
  const fnStart = src.indexOf('function RuntimeSettings()')
  expect(fnStart).toBeGreaterThan(-1)
  const fnSlice = src.slice(fnStart, fnStart + 3000)
  expect(fnSlice).toContain('<section')
  expect(fnSlice).toContain('<h3')
})
