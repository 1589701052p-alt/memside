// spec: docs/superpowers/specs/2026-08-17-runtime-path-config-design.md §7.5
// 运行时组件兜底面（CLAUDE.md 最低要求）：RuntimeSettings section 挂载点 + 安装/卸载按钮。
// App.tsx 无法在 bun test 直接渲染（需 vite/浏览器），靠源码层文本断言锁接线存在。
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
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

// 回归防护：2026-08-17 LLM 设置「清除」按钮语义 bug。
// 旧 onClear 发 saveLlmSettings({ clear: true }) 删整级 key，导致「当前生效」
// 回退到 settings.json/env 的下层凭证（用户看到的「已保存 api 被换掉」）。
// 修复后：「清除输入」只清空表单不落后端；真正删除走「删除已保存」+ 二次确认。
// App.tsx 无法在 bun test 渲染，靠源码层文本断言锁接线，防止回归到旧行为。
test('LlmSettings 「清除」不删后端，「删除已保存」承担 clear:true', () => {
  const src = readFileSync(appPath, 'utf-8')
  const fnStart = src.indexOf('function LlmSettings()')
  expect(fnStart).toBeGreaterThan(-1)
  const fnSlice = src.slice(fnStart, src.indexOf('function JudgeSettings()', fnStart))
  // onClear 不再发 clear:true（不再删后端）
  const onClearStart = fnSlice.indexOf('const onClear =')
  const onClearEnd = fnSlice.indexOf('const onDelete =', onClearStart)
  const onClearSlice = fnSlice.slice(onClearStart, onClearEnd)
  expect(onClearSlice).not.toContain('clear: true')
  expect(onClearSlice).not.toContain('saveLlmSettings')
  // onDelete 承担 clear:true + 二次确认（confirm）
  const onDeleteStart = fnSlice.indexOf('const onDelete =')
  expect(onDeleteStart).toBeGreaterThan(-1)
  const onDeleteEnd = fnSlice.indexOf('const onTest =', onDeleteStart)
  const onDeleteSlice = fnSlice.slice(onDeleteStart, onDeleteEnd)
  expect(onDeleteSlice).toContain('saveLlmSettings({ clear: true })')
  expect(onDeleteSlice).toContain('confirm(')
  // 按钮接线：「清除输入」+「删除已保存」
  expect(fnSlice).toContain('清除输入')
  expect(fnSlice).toContain('删除已保存')
})
