#!/usr/bin/env bun
/**
 * Spec B 接缝 3：exe 编译入口（只供 `bun build --compile` 消费）。
 *
 * 双击 exe = 生产启动（等价 start-and-install）：port-check → 启动 daemon
 * （内嵌 web dist 内存静态 + 装 claude hooks）→ 装 opencode 插件（内嵌）。
 *
 * 三分支（2026-08-18-exe-autostart-browser）：
 *   - 无占用 → startDaemon → openBrowser → 横幅 → 常驻
 *   - 全 memside 占用 → 直开现有 UI，不杀不重启 → exit(0)
 *   - 含非 memside → promptReclaim → 杀后走「无占用」分支
 * MEMSIDE_NO_OPEN=1 逃生口：不开浏览器仅印横幅 URL（headless / RDP）。
 *
 * 与 scripts/start.ts 区别：用内嵌资产（loadEmbeddedAssets）而非磁盘 dist，
 * 不做 vite dist 存在性检查（exe 自带资产内嵌进单文件）。port-check 逻辑复用
 * @/launch/portCheck（与 scripts/start.ts 同一生产 ctx 组装）。
 *
 * 控制台常驻显示，Ctrl+C 退出。仅 exe 走自动开浏览器；CLI 入口不动。
 */
import { createInterface } from 'node:readline'
import { startDaemon } from '@/daemon'
import { installOpencodePlugin } from '@/install'
import { findPortHolders, promptReclaim, reclaim, type PortCheckCtx, type ReclaimCtx } from '@/launch/portCheck'
import { openBrowser, isMemsideHolder, shouldAutoOpen } from './open-browser'
import { loadEmbeddedAssets } from './assets'

const PORT = Number(process.env.MEMSIDE_PORT ?? 7777)

function printBanner(alreadyRunning: boolean): void {
  const url = `http://127.0.0.1:${PORT}`
  const willOpen = shouldAutoOpen()
  const statusLine = alreadyRunning
    ? 'memside 已在运行，已打开浏览器到现有实例'
    : willOpen
      ? '正在打开浏览器…'
      : `Web UI:  ${url} （未自动开浏览器，MEMSIDE_NO_OPEN=1）`
  console.log('╔════════════════════════════════════════════╗')
  console.log('║  memside 已启动                              ║')
  console.log(`║  Web UI:  ${url.padEnd(33)}║`)
  console.log(`║  ${statusLine.padEnd(42)}║`)
  console.log('║  保持本窗口打开；Ctrl+C 退出                 ║')
  console.log('╚════════════════════════════════════════════╝')
}

async function main(): Promise<void> {
  const ea = await loadEmbeddedAssets()

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
  const ownPid = process.pid
  const allMemside = holders.length > 0 && holders.every((h) => isMemsideHolder(h.cmdline, ownPid, h.pid))

  if (holders.length > 0 && allMemside) {
    // 全 memside 占用 → 直开现有 UI，不杀不重启
    if (shouldAutoOpen()) {
      await openBrowser(`http://127.0.0.1:${PORT}`, ctx)
    }
    printBanner(true)
    process.exit(0)
  }

  if (holders.length > 0) {
    // 含非 memside → 询问回收（现有行为）
    if (!(await promptReclaim(holders, ctx))) process.exit(1)
    await reclaim(holders, ctx)
  }

  // 无占用分支：启动 daemon + 装 opencode 插件
  await startDaemon({
    port: PORT,
    installClaudeHooks: true,
    serveStaticAssets: { indexHtml: ea.indexHtml, assets: ea.assets },
    opencodePluginSource: { files: { 'memside.js': ea.pluginJs, 'package.json': ea.pluginPkg } },
  })
  installOpencodePlugin({
    port: PORT,
    files: { 'memside.js': ea.pluginJs, 'package.json': ea.pluginPkg },
  })

  // 先就绪再开窗
  if (shouldAutoOpen()) {
    await openBrowser(`http://127.0.0.1:${PORT}`, ctx)
  }
  printBanner(false)
}

main().catch((e) => {
  console.error('memside failed:', e)
  process.exit(1)
})
