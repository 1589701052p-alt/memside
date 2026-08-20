import { test, expect, describe } from 'bun:test'
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

/**
 * 发版产物名带版本号（2026-08-20 用户约定）：Release 资产必须是
 * memside-<version>.exe / memside-setup-<version>.exe，不是裸 memside.exe。
 * 版本号单一来源 package.json：build:exe 经 bun run 注入 $npm_package_version；
 * build:installer 经 makensis -DAPP_VERSION 注入。安装到用户机器后的文件名
 * 仍是 memside.exe（/oname= 保持，快捷方式/PATH 不受影响）。任一 token 缺失
 * 即红——防止后续重构把版本号从产物名里丢掉。
 */
describe('发版产物名带版本号', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'))

  test('package.json 两个构建脚本注入版本号', () => {
    expect(pkg.scripts['build:exe']).toContain('dist/memside-$npm_package_version.exe')
    expect(pkg.scripts['build:installer']).toContain('-DAPP_VERSION=$npm_package_version')
  })

  test('installer.nsi 产物名按 APP_VERSION 命名且安装后文件名不变', () => {
    const nsi = readFileSync(join(repoRoot, 'installer', 'installer.nsi'), 'utf-8')
    // setup 输出带版本号
    expect(nsi).toContain('OutFile "memside-setup-${APP_VERSION}.exe"')
    // 打包版本化的构建产物，但装出来仍叫 memside.exe（快捷方式/PATH/MUI_FINISHPAGE_RUN 都指它）
    expect(nsi).toContain('File /oname=memside.exe "..\\dist\\memside-${APP_VERSION}.exe"')
    // 手跑 makensis（无 -D）的 fallback 定义存在，避免编译期 !undefined 错
    expect(nsi).toMatch(/!ifndef APP_VERSION/)
  })

  test('release.yml 上传版本化产物', () => {
    const yml = readFileSync(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf-8')
    expect(yml).toContain('dist/memside-*.exe')
    expect(yml).toContain('installer/memside-setup-*.exe')
    // 反向锁：不得再出现裸产物名上传路径
    expect(yml).not.toMatch(/dist\/memside\.exe/)
    expect(yml).not.toMatch(/installer\/memside-setup\.exe/)
  })
})
