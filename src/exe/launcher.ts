#!/usr/bin/env bun
/**
 * Spec B 接缝 3：exe 编译入口（只供 `bun build --compile` 消费）。
 *
 * 双击 exe = 生产启动（等价 start-and-install）：port-check → 启动 daemon
 * （内嵌 web dist 内存静态 + 装 claude hooks）→ 装 opencode 插件（内嵌）。
 *
 * 与 scripts/start.ts 区别：用内嵌资产（loadEmbeddedAssets）而非磁盘 dist，
 * 不做 vite dist 存在性检查（exe 自带资产内嵌进单文件）。port-check 逻辑复用
 * @/launch/portCheck（与 scripts/start.ts 同一生产 ctx 组装）。
 *
 * Ruling-A/B：opencode 插件资产从 Task 4 的统一资产对象取（pluginJs/pluginPkg），
 * 不在此重复动态 import 插件源文件——故本模块是普通 TS 模块，可被 typecheck，
 * 无需 @ts-expect-error。
 *
 * 不打印 usage（无参即启动；未知参数忽略，exe 场景无 CLI 交互）。
 * 控制台常驻显示，Ctrl+C 退出。
 */
import { createInterface } from 'node:readline'
import { startDaemon } from '@/daemon'
import { installOpencodePlugin } from '@/install'
import { findPortHolders, promptReclaim, reclaim, type PortCheckCtx, type ReclaimCtx } from '@/launch/portCheck'
import { loadEmbeddedAssets } from './assets'

const PORT = Number(process.env.MEMSIDE_PORT ?? 7777)

async function main(): Promise<void> {
  const ea = await loadEmbeddedAssets()

  // port-check 生产 ctx（同 scripts/start.ts）：平台/spawn/TTY 全部绑定真实运行时。
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

  // Ruling-A/B：统一资产对象喂 startDaemon.serveStaticAssets（内存静态）
  // + installOpencodePlugin.files（内嵌插件写盘）。不重复 import 插件源。
  await startDaemon({
    port: PORT,
    installClaudeHooks: true,
    serveStaticAssets: { indexHtml: ea.indexHtml, assets: ea.assets },
  })
  installOpencodePlugin({
    port: PORT,
    files: { 'memside.js': ea.pluginJs, 'package.json': ea.pluginPkg },
  })

  console.log(`memside on http://127.0.0.1:${PORT} (UI + API, hooks + opencode plugin installed)`)
  console.log('Ctrl+C to exit')
}

main().catch((e) => {
  console.error('memside failed:', e)
  process.exit(1)
})
