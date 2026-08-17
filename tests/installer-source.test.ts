import { test, expect } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Spec B 接缝 6 兜底断言。installer.nsi 无法被 `bun test` 编译实跑（需
 * makensis），故靠源码层文本断言锁全局约束：per-user 免 UAC、装
 * dist/memside.exe、PATH 追加（user scope）、uninstall 保数据（不删
 * ~/.memside 等用户数据目录）、不自启（无 HKCU Run 键 / 无 Startup /
 * 无开机自启注册）。任一 token 缺失或复活自启写法即红。
 */
test('installer/installer.nsi 存在并含关键指令', () => {
  const p = join(repoRoot, 'installer', 'installer.nsi')
  expect(existsSync(p)).toBe(true)
  const src = readFileSync(p, 'utf-8')
  // per-user 免 UAC
  expect(src).toContain('RequestExecutionLevel user')
  // 装 memside.exe
  expect(src).toContain('memside.exe')
  // PATH 追加
  expect(src).toContain('PATH')
  // uninstall 保数据（注释提示）
  expect(src).toMatch(/不删|保留|~\/.memside/)
  // 不自启（无 Run 键 / 无开机注册）
  expect(src).not.toMatch(/HKCU.*Run|Startup|开机自启/)
})

/**
 * Spec B 接缝 7 兜底断言。release.yml 只在打 v* tag 时由 GitHub Actions
 * 触发实跑（本地无法跑 windows makensis / npm publish），故靠源码层文本
 * 断言锁全局约束：v* tag 触发、windows job 产 exe+安装器挂 Release、
 * publish-npm job npm publish（NPM_TOKEN）。任一 token 缺失即红——
 * 防止后续重构把 tag 发版编排改坏而无人察觉。
 */
test('.github/workflows/release.yml 存在并含两 job', () => {
  const p = join(repoRoot, '.github', 'workflows', 'release.yml')
  expect(existsSync(p)).toBe(true)
  const src = readFileSync(p, 'utf-8')
  expect(src).toContain('on:')
  expect(src).toMatch(/tags:\s*\[.*v\*/)
  expect(src).toContain('windows:')
  expect(src).toContain('publish-npm:')
  expect(src).toContain('build:exe')
  expect(src).toContain('build:installer')
  expect(src).toContain('npm publish')
  expect(src).toContain('NPM_TOKEN')
  // F1 回归防护：windows job 必须装 EnVar 第三方插件（choco nsis 不带，installer.nsi 用 EnVar::）。
  // 缺此 step 首次 v* tag 发版时 makensis 编译期红（EnVar.dll not found）。
  expect(src).toMatch(/EnVar/i)
  expect(src).toMatch(/GsNSIS\/EnVar/)
  // makensis PATH 注入回归防护：choco 装的 nsis 不写 PATH，build:installer 会 command not found。
  // 必须把 NSIS 目录注入 GITHUB_PATH 让后续 step 找到 makensis（v0.1.0 首跑 CI 复现的 bug）。
  expect(src).toMatch(/GITHUB_PATH/)
  expect(src).toMatch(/makensis\.exe/)
  // F3 回归防护：build:exe 已含 vite build，不得再显式跑一遍 bun run build（冗余浪费）。
  expect(src).not.toMatch(/bun run build\s+# vite dist/)
})
