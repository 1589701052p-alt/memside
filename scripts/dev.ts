#!/usr/bin/env bun
/**
 * 一键启动（开发模式）：同时拉起 daemon（7777）+ vite dev（5173，热更新），
 * 输出逐行加 [daemon] / [web] 前缀。
 *
 * 回收语义（不留残留进程）：
 * - 任一子进程先退出 -> 杀另一个 -> 以先退者的退出码退出；
 * - 主进程收 SIGINT/SIGTERM -> 杀两个子进程后退出。
 */
import { buildSpawnPlan } from '@/launch/spawnPlan'
import { findPortHolders, promptReclaim, reclaim, type PortCheckCtx, type ReclaimCtx } from '@/launch/portCheck'
import { createInterface } from 'node:readline'

// process.execPath = 真 bun.exe，绕开 npm .cmd shim（见 spawnPlan.ts 头注释）。
const plan = buildSpawnPlan({ MEMSIDE_PORT: process.env.MEMSIDE_PORT }, process.execPath)

// 端口防呆：spawn 前检测 daemon 端口 + 5173，被占则列出占用进程并询问是否杀掉。
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

const holders = await findPortHolders([plan.port, 5173], ctx)
if (holders.length) {
  if (!(await promptReclaim(holders, ctx))) process.exit(1)
  await reclaim(holders, ctx)
}

function spawnLogged(name: string, cmd: string[]) {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', env: process.env })
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder()
    let buf = ''
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const l of lines) console.log(`[${name}] ${l}`)
    }
    if (buf) console.log(`[${name}] ${buf}`)
  }
  void pump(proc.stdout)
  void pump(proc.stderr)
  return proc
}

const daemon = spawnLogged('daemon', plan.daemon.cmd)
// web spawn 若同步抛错（如 vite bin 缺失），此时信号处理尚未挂上、race 尚未
// 到达，必须先杀已起的 daemon 再让错误传播，否则 daemon 孤儿化占端口
// （spec §4.7 无残留契约）。
let web: ReturnType<typeof spawnLogged>
try {
  web = spawnLogged('web', plan.web.cmd)
} catch (e) {
  daemon.kill()
  await daemon.exited
  throw e
}

let shuttingDown = false
function killAll() {
  if (shuttingDown) return
  shuttingDown = true
  daemon.kill()
  web.kill()
}

// 信号路径：kill() 在 Windows 上不是同步终止语义，立即 process.exit 会截断
// 终止投递（实测：dev.ts 143 退出后 daemon 子进程仍占端口）。必须先等两个
// 子进程真的退出，再退主进程。
async function shutdown(exitCode: number) {
  killAll()
  await Promise.allSettled([daemon.exited, web.exited])
  process.exit(exitCode)
}

process.on('SIGINT', () => { void shutdown(130) })
process.on('SIGTERM', () => { void shutdown(143) })

// 先退者决定退出码；killAll 幂等，信号路径与先退路径不冲突。
const code = await Promise.race([daemon.exited, web.exited])
killAll()
await Promise.allSettled([daemon.exited, web.exited])
process.exit(code ?? 1)
