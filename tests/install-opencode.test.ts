import { test, expect, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installOpencodePlugin } from '@/install'

// 这些测试锁 Task 7 的 install 扩展：installOpencodePlugin 复制 Task 6 的
// opencode-plugin/ 到 baseDir/memside-opencode/、烘焙端口占位、并幂等合并
// opencode.json 的 plugin 数组（路径子串 memside-opencode 标记识别）。
//
// 隔离：用显式 baseDir=tmp dir，绝不触碰真实 ~/.config/opencode/。
// pluginSrcDir 用仓库真实的 opencode-plugin/（与 cli.ts 同款路径解析），
// 这样能验证真实文件效果（cpSync + 端口烘焙），而非 stub。

const pluginSrcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'opencode-plugin')
const tmpRoot = join(import.meta.dir, '.tmp-install-opencode')

beforeEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
  mkdirSync(tmpRoot, { recursive: true })
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

test('复制 plugin 文件 + 端口烘焙', () => {
  const baseDir = join(tmpRoot, 'case1')
  installOpencodePlugin({ port: 8888, baseDir, pluginSrcDir })
  const js = readFileSync(join(baseDir, 'memside-opencode', 'memside.js'), 'utf-8')
  // __MEMSIDE_PORT__ 占位被替换为实际端口
  expect(js).toContain('8888')
  expect(js).not.toContain('__MEMSIDE_PORT__')
  // package.json 一并被复制
  expect(existsSync(join(baseDir, 'memside-opencode', 'package.json'))).toBe(true)
})

test('opencode.json plugin 数组幂等 + 保留用户既有条目', () => {
  const baseDir = join(tmpRoot, 'case2')
  mkdirSync(baseDir, { recursive: true })
  // 预置用户既有 plugin 条目（如 superpowers）
  writeFileSync(
    join(baseDir, 'opencode.json'),
    JSON.stringify({ plugin: ['superpowers@git+https://github.com/foo/superpowers'] }),
  )
  installOpencodePlugin({ port: 7777, baseDir, pluginSrcDir })
  installOpencodePlugin({ port: 7777, baseDir, pluginSrcDir }) // 重复 install
  const cfg = JSON.parse(readFileSync(join(baseDir, 'opencode.json'), 'utf-8'))
  // 幂等：memside-opencode 条目只出现一次（不重复 append）
  expect(cfg.plugin.filter((p: string) => p.includes('memside-opencode')).length).toBe(1)
  // 保留用户既有条目
  expect(cfg.plugin.some((p: string) => p.includes('superpowers'))).toBe(true)
  // 写入的是绝对路径且用正斜杠（避免 ~ 展开差异，design §6 failure mode 6）
  const memsideEntry = cfg.plugin.find((p: string) => p.includes('memside-opencode'))
  expect(memsideEntry).toMatch(/\/memside-opencode$/)
  expect(memsideEntry).not.toContain('\\')
})

test('malformed opencode.json 当空文档不抛', () => {
  const baseDir = join(tmpRoot, 'case3')
  mkdirSync(baseDir, { recursive: true })
  writeFileSync(join(baseDir, 'opencode.json'), '{not json')
  expect(() => installOpencodePlugin({ port: 7777, baseDir, pluginSrcDir })).not.toThrow()
  // install 后 opencode.json 被重写为合法 JSON（含 memside-opencode 条目）
  const cfg = JSON.parse(readFileSync(join(baseDir, 'opencode.json'), 'utf-8'))
  expect(Array.isArray(cfg.plugin)).toBe(true)
  expect(cfg.plugin.some((p: string) => p.includes('memside-opencode'))).toBe(true)
})
