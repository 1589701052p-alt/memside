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
