import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// CLAUDE.md 运行时巨型组件兜底面：源码层文本断言锁定关键接线。
// launcher.ts 编译进 exe，难直接覆盖；断言源码含正确控制流 token。

const src = readFileSync(join(import.meta.dir, '..', 'src', 'exe', 'launcher.ts'), 'utf8')

describe('launcher.ts 源码层断言', () => {
  test('导入 openBrowser / isMemsideHolder / shouldAutoOpen', () => {
    expect(src).toContain('openBrowser')
    expect(src).toContain('isMemsideHolder')
    expect(src).toContain('shouldAutoOpen')
  })

  test('三分支控制流存在', () => {
    // 无占用分支：startDaemon
    expect(src).toContain('startDaemon')
    // 全 memside 分支：直开 UI 不杀
    expect(src).toContain('isMemsideHolder')
    // 非 memside 分支：现有 promptReclaim / reclaim
    expect(src).toContain('promptReclaim')
    expect(src).toContain('reclaim')
  })

  test('先就绪再开窗：openBrowser 不在 startDaemon 调用之前', () => {
    const startIdx = src.indexOf('startDaemon({')
    // 从 startDaemon 之后搜 openBrowser（无占用主路径的「先就绪再开窗」）；
    // 全 memside 分支的 openBrowser 在 startDaemon 之前且不启动 daemon，不该计入。
    const openIdx = src.indexOf('openBrowser(', startIdx)
    expect(startIdx).toBeGreaterThan(-1)
    expect(openIdx).toBeGreaterThan(-1)
    expect(openIdx).toBeGreaterThan(startIdx)
  })

  test('shouldAutoOpen 门禁读取', () => {
    expect(src).toContain('shouldAutoOpen()')
  })

  test('横幅打印含 Web UI 地址 + 端口 + 引导', () => {
    expect(src).toContain('127.0.0.1')
    expect(src).toMatch(/Ctrl\+C/)
    // 横幅不是单行日志（升级后应有多行 / 边框 token）
    expect(src).not.toMatch(/^console\.log\(`memside on http:\/\/127\.0\.0\.1:\$\{PORT\}`\)\s*$/m)
  })

  test('横幅 alreadyRunning 分支亦读 shouldAutoOpen（spec §3.4 逃生口状态准确）', () => {
    // 已在运行 + MEMSIDE_NO_OPEN=1 时不得谎称「已打开浏览器」
    expect(src).toContain('memside 已在运行（未自动开浏览器，MEMSIDE_NO_OPEN=1）')
    // 已在运行 + 自动开时保留原状态
    expect(src).toContain('memside 已在运行，已打开浏览器到现有实例')
  })
})
