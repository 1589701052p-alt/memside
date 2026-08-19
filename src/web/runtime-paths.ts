// 运行环境路径解析纯函数（spec 2026-08-19-runtime-settings-four-slots §3.8）。
// 独立成模块便于 bun:test 直接断言，不引 React（CLAUDE.md「首选可断言面」）。

export interface RuntimePathDefaults {
  claude: { dir: string; settingsFilename: string }
  codeagent: { dir: string; settingsFilename: string }
  opencode: { dir: string }
  nga: { dir: string }
}

/** 解析 claude/codeagent 目标配置文件路径（per-slot defaults）。空串回落；反斜杠归一。 */
export function resolveClaudePath(
  dir: string,
  filename: string,
  slotDefaults: { dir: string; settingsFilename: string },
): string {
  const d = dir.trim() || slotDefaults.dir
  const f = filename.trim() || slotDefaults.settingsFilename
  return `${d}/${f}`.replace(/\\/g, '/')
}

/** 解析 opencode/nga 目标插件目录路径（per-slot defaults）。空串回落；拼 memside-opencode。 */
export function resolveOpencodePath(
  dir: string,
  slotDefaults: { dir: string },
): string {
  const d = dir.trim() || slotDefaults.dir
  return `${d}/memside-opencode`.replace(/\\/g, '/')
}
