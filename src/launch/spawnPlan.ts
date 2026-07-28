/**
 * dev 一键启动的 spawn 计划（纯函数）：给定 env 决定两条子进程命令和
 * daemon 端口。端口决策收敛在这一层是为了可单测；scripts/dev.ts 只做
 * 进程编排，不含决策。
 *
 * 两条命令都选在单个 bun 进程内执行目标的形式（`bun run <file>` /
 * `bun x <bin>`）：dev.ts 杀直接子进程时不会留下孙进程（Windows 上
 * 杀 shell 包装会孤儿化 vite，README 故障排查已有 7777 残留前科）。
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

export function buildSpawnPlan(env: { MEMSIDE_PORT?: string }): SpawnPlan {
  const port = Number(env.MEMSIDE_PORT ?? DEFAULT_PORT)
  return {
    daemon: { cmd: ['bun', 'run', 'src/cli.ts', 'start'] },
    web: { cmd: ['bun', 'x', 'vite'] },
    port,
  }
}
