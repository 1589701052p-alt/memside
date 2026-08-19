// 锁 RuntimeSettings 双分组 UI + resolveClaudePath/resolveOpencodePath 纯函数
// （spec 2026-08-17-runtime-settings-redesign §3.6 / §7.5）。
//
// 为什么存在：spec §3.6 要求「纯函数层优先」——路径解析逻辑抽到独立纯模块，
// 便于在 bun:test 直接断言；UI 运行时组件用源码层文本断言兜底（CLAUDE.md）。
// 控制器裁定：纯函数放 src/web/runtime-paths.ts（非 App.tsx），避免在测试里
// import App.tsx 时拽入 React + web-only 模块图导致加载期抛错。
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveClaudePath, resolveOpencodePath } from '@/web/runtime-paths'

const appSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web', 'App.tsx'),
  'utf-8',
)

// === 四槽 resolve（spec 2026-08-19-runtime-settings-four-slots §3.8）===
// 旧三字段扁平 defaults 已改为 per-slot 形状：resolveClaudePath 第三参传
// { dir, settingsFilename }，resolveOpencodePath 第二参传 { dir }。

test('resolveClaudePath: 空串回落 slot 默认，组合目录+文件名', () => {
  const d = { dir: '/home/u/.claude', settingsFilename: 'settings.json' }
  expect(resolveClaudePath('', '', d)).toBe('/home/u/.claude/settings.json')
  expect(resolveClaudePath('/home/u/.cac', 'setting.json', d)).toBe('/home/u/.cac/setting.json')
  // 单边：只给目录，文件名回落 slot 默认
  expect(resolveClaudePath('/x/.cac', '', d)).toBe('/x/.cac/settings.json')
})

test('resolveClaudePath: 反斜杠归一为正斜杠（Windows 路径展示）', () => {
  const d = { dir: '/d', settingsFilename: 'settings.json' }
  expect(resolveClaudePath('C:\\Users\\u\\.cac', 'setting.json', d)).toBe('C:/Users/u/.cac/setting.json')
  // 仅目录含反斜杠
  expect(resolveClaudePath('C:\\x', '', d)).toBe('C:/x/settings.json')
})

test('resolveOpencodePath: 空串回落 slot 默认，拼 memside-opencode', () => {
  const d = { dir: '/h/.config/opencode' }
  expect(resolveOpencodePath('', d)).toBe('/h/.config/opencode/memside-opencode')
  expect(resolveOpencodePath('/x/opencode', d)).toBe('/x/opencode/memside-opencode')
})

test('resolveOpencodePath: 反斜杠归一为正斜杠', () => {
  const d = { dir: '/h/.config/opencode' }
  expect(resolveOpencodePath('C:\\x\\oc', d)).toBe('C:/x/oc/memside-opencode')
})

test('RuntimeSettings 含双分组标题 + 每组两个按钮', () => {
  expect(appSrc).toContain('Claude Code / codeagent')
  expect(appSrc).toContain('opencode / nga')
  expect(appSrc).toContain('保存并安装')
  expect(appSrc).toContain('卸载')
  expect(appSrc).toContain('将写入')
})

test('RuntimeSettings 用 installRuntimeHooks(target) / uninstallRuntimeHooks(target)', () => {
  // 确认 UI 调用带 target，而非旧的无参调用
  expect(appSrc).toMatch(/installRuntimeHooks\(\s*['"](?:claude|opencode)['"]/)
  expect(appSrc).toMatch(/uninstallRuntimeHooks\(\s*['"](?:claude|opencode)['"]/)
})
