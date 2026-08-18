// 运行环境路径解析纯函数（spec 2026-08-17-runtime-settings-redesign §3.6 / §7.5）。
//
// 为什么独立成模块：路径解析逻辑要在 RuntimeSettings UI 预览与单元测试中共用，
// 抽到纯模块后可在 bun:test 直接断言，不必 import App.tsx（后者会拽入
// React + web-only 模块图，在测试加载期可能抛错）。spec §3.6「纯函数层优先」。

/** claude/codeagent 目标配置文件的默认结构（与后端 RuntimeSettingsState.defaults 同形）。 */
export interface RuntimePathDefaults {
  claudeDir: string
  settingsFilename: string
  opencodeDir: string
}

/**
 * 解析 claude/codeagent 目标配置文件路径，供 UI 预览 + 测试。
 * 空串（含纯空白）回落到 defaults；组合目录 + 文件名；反斜杠归一为正斜杠（展示）。
 */
export function resolveClaudePath(
  claudeDir: string,
  settingsFilename: string,
  defaults: RuntimePathDefaults,
): string {
  const dir = claudeDir.trim() || defaults.claudeDir
  const fn = settingsFilename.trim() || defaults.settingsFilename
  return `${dir}/${fn}`.replace(/\\/g, '/')
}

/**
 * 解析 opencode/nga 目标插件目录路径，供 UI 预览 + 测试。
 * 空串（含纯空白）回落到 defaults.opencodeDir；拼 `memside-opencode`；反斜杠归一为正斜杠。
 */
export function resolveOpencodePath(
  opencodeDir: string,
  defaults: RuntimePathDefaults,
): string {
  const dir = opencodeDir.trim() || defaults.opencodeDir
  return `${dir}/memside-opencode`.replace(/\\/g, '/')
}
