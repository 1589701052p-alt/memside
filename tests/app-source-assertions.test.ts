// spec: docs/superpowers/specs/2026-08-17-runtime-path-config-design.md §7.5
// 运行时组件兜底面（CLAUDE.md 最低要求）：RuntimeSettings section 挂载点 + 安装/卸载按钮。
// App.tsx 无法在 bun test 直接渲染（需 vite/浏览器），靠源码层文本断言锁接线存在。
import { test, expect, describe, it } from 'bun:test'
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
})

// === 四槽设置卡 + 状态徽标（spec 2026-08-19-runtime-settings-four-slots）===
// 旧双分组（claude/codeagent + opencode/nga 合并卡）拆为四独立卡；每卡实时
// 安装状态徽标（读磁盘探针 getRuntimeStatus）；安装/卸载后 re-probe。
test('RuntimeSettings 四卡标题 + 状态徽标 + getRuntimeStatus', () => {
  const src = readFileSync(appPath, 'utf-8')
  const fnStart = src.indexOf('function RuntimeSettings()')
  expect(fnStart).toBeGreaterThan(-1)
  // RuntimeSettings 是文件末尾的最后一个函数，无后续 function 边界 -> 切到文末。
  const nextFn = src.indexOf('function ', fnStart + 20)
  const fnSlice = nextFn > -1 ? src.slice(fnStart, nextFn) : src.slice(fnStart)
  // 四卡标题独立存在
  expect(fnSlice).toContain('Claude Code')
  expect(fnSlice).toContain('codeagent')
  expect(fnSlice).toContain('opencode')
  expect(fnSlice).toContain('nga')
  // 状态徽标 token（已安装 / 未安装）
  expect(fnSlice).toContain('已安装')
  expect(fnSlice).toContain('未安装')
  // 实时安装状态探针
  expect(fnSlice).toContain('getRuntimeStatus')
  // 路径解析纯函数引用
  expect(fnSlice).toContain('resolveClaudePath')
  expect(fnSlice).toContain('resolveOpencodePath')
  // 反向锁：旧双分组合并标题已拆，不应再独占
  expect(fnSlice).not.toContain('Claude Code / codeagent')
  expect(fnSlice).not.toContain('opencode / nga')
  // 反向锁：旧扁平字段名已移除（per-slot 形状取代）
  expect(fnSlice).not.toContain('claudeDir')
  expect(fnSlice).not.toContain('opencodeDir')
})

test('RuntimeSettings section uses standard section convention', () => {
  const src = readFileSync(appPath, 'utf-8')
  // 与 LlmSettings/JudgeSettings 同款 section + h3 结构
  const fnStart = src.indexOf('function RuntimeSettings()')
  expect(fnStart).toBeGreaterThan(-1)
  // 四卡 + 状态徽标后函数体变大，窗口需覆盖到 return 的 <section>。
  const fnSlice = src.slice(fnStart, fnStart + 8000)
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

// spec 2026-08-19-hook-missing-notification §7.3
// daemon 层「四槽全空提醒」兜底面（CLAUDE.md 最低要求）：startDaemon 挂载周期检查
// （启动立即一次 + 每 5min 复探）。daemon.ts 难在 bun test 直接覆盖 startDaemon
// 全路径，靠源码层文本断言锁 checkHooksAndNotify 导出 + setInterval + unref 接线存在。
test('daemon.ts 挂载 HOOK_CHECK_INTERVAL_MS + setInterval + checkHooksAndNotify + unref?.()', () => {
  const daemonPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'daemon.ts')
  const src = readFileSync(daemonPath, 'utf-8')
  expect(src).toContain('HOOK_CHECK_INTERVAL_MS')
  expect(src).toContain('setInterval')
  expect(src).toContain('checkHooksAndNotify')
  expect(src).toMatch(/unref\?\.\(\)/)
})

// I1 回归锁（final review 2026-08-19）：startDaemon 中「启动探测」必须在
// installClaudeHooks（installHooks）块之后执行——否则 exe 首启 opts.installClaudeHooks:true
// 时探针先于装 hook 跑，四槽必然全空 → 写一条假阳性「未安装 hook」提醒（实际马上装好）。
// 锁定源码顺序：installHooks 调用的行号 < void checkHooksAndNotify 调用的行号。
test('daemon.ts: checkHooksAndNotify 调用在 installHooks 之后（I1：探测顺序）', () => {
  const daemonPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'daemon.ts')
  const src = readFileSync(daemonPath, 'utf-8')
  const installHooksIdx = src.indexOf('installHooks({')
  const checkIdx = src.indexOf('void checkHooksAndNotify(db)')
  expect(installHooksIdx).toBeGreaterThan(-1)
  expect(checkIdx).toBeGreaterThan(-1)
  // installHooks 在前，checkHooksAndNotify 在后（顺序锁）
  expect(checkIdx).toBeGreaterThan(installHooksIdx)
})

// spec 2026-08-19-hook-missing-notification §7.4 / §3.7
// 前端兜底面（CLAUDE.md 最低要求）：消息 tab 的 kind 下拉 + chip 需支持 hook_missing
// 类型（琥珀 #e65100，warning 级非 error 红）。App.tsx 无法在 bun test 渲染，
// 靠源码层文本断言锁「下拉选项 + 琥珀 chip」接线存在。
describe('App.tsx hook_missing 消息渲染', () => {
  const src = readFileSync(appPath, 'utf-8')

  it('kind 下拉含 hook_missing 选项', () => {
    expect(src).toMatch(/value="hook_missing"/)
    expect(src).toContain('未安装hook')
  })

  it('chipColor 处理 hook_missing 用琥珀 #e65100', () => {
    // chipColor 表达式应含 hook_missing 分支或与 degradation 同琥珀色
    expect(src).toMatch(/hook_missing/)
    expect(src).toContain('#e65100')
  })
})
