/**
 * dev 一键启动的 spawn 计划（纯函数）：给定 env + bun 可执行文件路径，决定
 * 两条子进程命令和 daemon 端口。端口决策收敛在这一层是为了可单测；
 * scripts/dev.ts 只做进程编排，不含决策。
 *
 * `bunPath` 必须由调用方传 `process.execPath`（真 bun.exe），不能图省事用
 * `'bun'`：npm 全局安装的 bun 在 Windows 上是 .cmd shim，spawn 会被 cmd.exe
 * 包一层，dev.ts 的 kill() 只杀壳、留下孤儿进程占端口（2026-07-28 实测：
 * SIGTERM 后 daemon/vite 仍占 7779/5174）。两条命令都直跑目标文件
 * （cli.ts / vite 的 JS 入口），保证杀直接子进程即杀干活的进程。
 */

export interface SpawnCmd {
  cmd: string[]
}

export interface SpawnPlan {
  daemon: SpawnCmd
  web: SpawnCmd
  port: number
}

const DEFAULT_PORT = 7777

export function buildSpawnPlan(env: { MEMSIDE_PORT?: string }, bunPath: string): SpawnPlan {
  const port = Number(env.MEMSIDE_PORT ?? DEFAULT_PORT)
  return {
    daemon: { cmd: [bunPath, 'src/cli.ts', 'start'] },
    web: { cmd: [bunPath, 'node_modules/vite/bin/vite.js'] },
    port,
  }
}
