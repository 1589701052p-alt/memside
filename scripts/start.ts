#!/usr/bin/env bun
/**
 * 一键启动（生产模式）：daemon 单端口同时服务 API + 构建产物 UI，并幂等
 * 安装 claude code hooks（start-and-install 语义 + 静态托管）。
 *
 * 正常入口是 `bun run start`（package.json 里 `bun run build && bun run
 * scripts/start.ts`），dist 总是新鲜；下面的存在性检查只防御直接调用本
 * 脚本的情况。
 *
 * 端口防呆：启动前检测 7777 是否被占，被占则列出占用进程并询问是否杀掉。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { startDaemon } from '@/daemon'
import { findPortHolders, promptReclaim, reclaim, type PortCheckCtx, type ReclaimCtx } from '@/launch/portCheck'

const PORT = Number(process.env.MEMSIDE_PORT ?? 7777)
const distDir = join(import.meta.dir, '..', 'src', 'web', 'dist')

if (!existsSync(join(distDir, 'index.html'))) {
  console.error('memside: src/web/dist/index.html not found - run `bun run build` first')
  process.exit(1)
}

// 生产 ctx：平台/spawn/TTY 全部绑定真实运行时。
const spawnReal: PortCheckCtx['spawn'] = async (cmd: string[]) => {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
  const stdout = await new Response(proc.stdout).text()
  await proc.exited
  return { stdout, exitCode: proc.exitCode }
}
function readLineStdin(): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin })
    rl.question('', (ans) => { rl.close(); resolve(ans) })
  })
}
const ctx: PortCheckCtx & ReclaimCtx = {
  platform: process.platform,
  spawn: spawnReal,
  isTTY: process.stdin.isTTY ?? false,
  readline: readLineStdin,
}

const holders = await findPortHolders([PORT], ctx)
if (holders.length) {
  if (!(await promptReclaim(holders, ctx))) process.exit(1)
  await reclaim(holders, ctx)
}

await startDaemon({ port: PORT, installClaudeHooks: true, serveStaticDir: distDir })
console.log(`memside on http://127.0.0.1:${PORT} (UI + API, hooks installed)`)
