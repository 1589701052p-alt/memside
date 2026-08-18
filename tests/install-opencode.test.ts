import { test, expect, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installOpencodePlugin, uninstallOpencodePlugin } from '@/install'

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

// 以下 3 个 case 锁 Spec B 接缝 2（Task 3）：installOpencodePlugin 的 files 内容
// 模式——从内嵌字符串写盘（而非 cpSync 复制磁盘目录），端口烘焙与 opencode.json
// 幂等合并照旧。files 与 pluginSrcDir 互斥，都缺抛错（src/install.ts 三分支分流）。

test('files 内容模式：从字符串写盘 + 端口烘焙', () => {
  const baseDir = join(tmpRoot, 'case-files')
  installOpencodePlugin({
    port: 9999, baseDir,
    files: { 'memside.js': 'port=__MEMSIDE_PORT__;', 'package.json': '{"name":"memside"}' },
  })
  const js = readFileSync(join(baseDir, 'memside-opencode', 'memside.js'), 'utf-8')
  expect(js).toBe('port=9999;')
  expect(js).not.toContain('__MEMSIDE_PORT__')
  const pkg = readFileSync(join(baseDir, 'memside-opencode', 'package.json'), 'utf-8')
  expect(pkg).toBe('{"name":"memside"}')
})

test('files 内容模式：opencode.json 幂等合并', () => {
  const baseDir = join(tmpRoot, 'case-files-idem')
  installOpencodePlugin({
    port: 9999, baseDir,
    files: { 'memside.js': 'x', 'package.json': '{}' },
  })
  installOpencodePlugin({
    port: 9999, baseDir,
    files: { 'memside.js': 'x', 'package.json': '{}' },
  })
  const cfg = JSON.parse(readFileSync(join(baseDir, 'opencode.json'), 'utf-8'))
  expect((cfg.plugin as string[]).filter((p) => p.includes('memside-opencode'))).toHaveLength(1)
})

test('files 与 pluginSrcDir 都缺抛错', () => {
  expect(() => installOpencodePlugin({ port: 9999, baseDir: join(tmpRoot, 'case-err') })).toThrow()
})

test('uninstallOpencodePlugin: 先 install 再 uninstall → 目录消失 + plugin 条目移除', () => {
  const baseDir = join(tmpRoot, 'uninstall-1')
  installOpencodePlugin({ port: 7777, baseDir, pluginSrcDir })
  expect(existsSync(join(baseDir, 'memside-opencode', 'memside.js'))).toBe(true)
  const r = uninstallOpencodePlugin({ baseDir })
  expect(r.removed).toBeGreaterThanOrEqual(1)
  expect(r.dirRemoved).toBe(true)
  expect(existsSync(join(baseDir, 'memside-opencode'))).toBe(false)
  const cfg = JSON.parse(readFileSync(join(baseDir, 'opencode.json'), 'utf-8'))
  expect((cfg.plugin as string[]).filter((p) => p.includes('memside-opencode'))).toHaveLength(0)
  expect(r.pluginPath).toBe(join(baseDir, 'opencode.json'))
})

test('uninstallOpencodePlugin: 保留用户既有 plugin 条目', () => {
  const baseDir = join(tmpRoot, 'uninstall-2')
  mkdirSync(baseDir, { recursive: true })
  writeFileSync(join(baseDir, 'opencode.json'),
    JSON.stringify({ plugin: ['superpowers@git+https://github.com/foo/superpowers'] }))
  installOpencodePlugin({ port: 7777, baseDir, pluginSrcDir })
  uninstallOpencodePlugin({ baseDir })
  const cfg = JSON.parse(readFileSync(join(baseDir, 'opencode.json'), 'utf-8'))
  expect((cfg.plugin as string[]).some((p) => p.includes('superpowers'))).toBe(true)
})

test('uninstallOpencodePlugin: 目录与文件都不存在 → removed:0 dirRemoved:false 不抛', () => {
  const baseDir = join(tmpRoot, 'uninstall-3')
  const r = uninstallOpencodePlugin({ baseDir })
  expect(r.removed).toBe(0)
  expect(r.dirRemoved).toBe(false)
  expect(r.pluginPath).toBe(join(baseDir, 'opencode.json'))
})

test('uninstallOpencodePlugin: malformed opencode.json → removed:0 不抛，dir 若存在仍删', () => {
  const baseDir = join(tmpRoot, 'uninstall-4')
  mkdirSync(join(baseDir, 'memside-opencode'), { recursive: true })
  writeFileSync(join(baseDir, 'memside-opencode', 'memside.js'), 'x')
  writeFileSync(join(baseDir, 'opencode.json'), '{not json')
  const r = uninstallOpencodePlugin({ baseDir })
  expect(r.removed).toBe(0)
  expect(r.dirRemoved).toBe(true) // 目录存在就删，不依赖 json 解析
  expect(existsSync(join(baseDir, 'memside-opencode'))).toBe(false)
})

test('uninstallOpencodePlugin: 重复 uninstall（已无痕迹）→ removed:0 dirRemoved:false 幂等', () => {
  const baseDir = join(tmpRoot, 'uninstall-5')
  uninstallOpencodePlugin({ baseDir }) // 空目录首次
  const r = uninstallOpencodePlugin({ baseDir }) // 再来一次
  expect(r.removed).toBe(0)
  expect(r.dirRemoved).toBe(false)
})

test('uninstallOpencodePlugin: baseDir 缺省走 ~/.config/opencode', () => {
  // 用 fake HOME 避免碰真实目录
  const realHome = process.env.HOME
  ;(process.env as any).HOME = join(tmpRoot, 'fake-home-uninstall')
  delete process.env.USERPROFILE
  try {
    const r = uninstallOpencodePlugin({})
    expect(r.removed).toBe(0)
    expect(r.pluginPath).toBe(join((process.env as any).HOME, '.config', 'opencode', 'opencode.json'))
  } finally {
    ;(process.env as any).HOME = realHome
  }
})
