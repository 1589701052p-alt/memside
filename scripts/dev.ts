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

// process.execPath = 真 bun.exe，绕开 npm .cmd shim（见 spawnPlan.ts 头注释）。
const plan = buildSpawnPlan({ MEMSIDE_PORT: process.env.MEMSIDE_PORT }, process.execPath)

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
const web = spawnLogged('web', plan.web.cmd)

let shuttingDown = false
function killAll() {
  if (shuttingDown) return
  shuttingDown = true
  daemon.kill()
  web.kill()
}

process.on('SIGINT', () => { killAll(); process.exit(130) })
process.on('SIGTERM', () => { killAll(); process.exit(143) })

// 先退者决定退出码；killAll 幂等，信号路径与先退路径不冲突。
const code = await Promise.race([daemon.exited, web.exited])
killAll()
await Promise.allSettled([daemon.exited, web.exited])
process.exit(code ?? 1)
