/**
 * exe 双击自动开浏览器（2026-08-18-exe-autostart-browser spec）。
 * 平台原生 open 命令 spawn；best-effort 不抛，失败返回 false（不杀 daemon）。
 * ctx 形状与 src/launch/portCheck.ts 的 PortCheckCtx 一致，便于复用 + 纯函数测。
 */

export interface OpenBrowserCtx {
  platform: NodeJS.Platform
  spawn: (cmd: string[]) => Promise<{ stdout: string; exitCode: number | null }>
}

/**
 * 打开浏览器到 url。成功 true，失败/非零退出/spawn 抛错均 false（不抛）。
 * 失败时调用方仍印 URL 横幅让用户手抄。
 */
export async function openBrowser(url: string, ctx: OpenBrowserCtx): Promise<boolean> {
  const cmd = openCommand(url, ctx.platform)
  try {
    const r = await ctx.spawn(cmd)
    return r.exitCode === 0
  } catch {
    return false
  }
}

function openCommand(url: string, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') return ['cmd', '/c', 'start', '', url]
  if (platform === 'darwin') return ['open', url]
  return ['xdg-open', url] // linux / 其他 posix
}

/**
 * 判断端口占用者是不是 memside 自身（用于「直开现有 UI 不杀」分支）。
 * 自身 PID 排除；命令行含 memside 字样判是（exe 路径 / 仓库路径均命中）。
 * 误判风险：非 memside 命令行恰好含 memside 字样极罕见，且即便误判走「直开 UI」，
 * 最坏 daemon 因端口仍被占 EADDRINUSE 兜底退出，不静默坏。
 */
export function isMemsideHolder(cmdline: string, ownPid: number, holderPid: number): boolean {
  if (holderPid === ownPid) return false
  return /memside/i.test(cmdline)
}

/**
 * env 门禁：MEMSIDE_NO_OPEN=1 时不开浏览器（headless / RDP 逃生口）。
 */
export function shouldAutoOpen(): boolean {
  return process.env.MEMSIDE_NO_OPEN !== '1'
}
