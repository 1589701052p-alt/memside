#!/usr/bin/env bun
/**
 * 一键启动（生产模式）：daemon 单端口同时服务 API + 构建产物 UI，并幂等
 * 安装 claude code hooks（start-and-install 语义 + 静态托管）。
 *
 * 正常入口是 `bun run start`（package.json 里 `bun run build && bun run
 * scripts/start.ts`），dist 总是新鲜；下面的存在性检查只防御直接调用本
 * 脚本的情况。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { startDaemon } from '@/daemon'

const PORT = Number(process.env.MEMSIDE_PORT ?? 7777)
const distDir = join(import.meta.dir, '..', 'src', 'web', 'dist')

if (!existsSync(join(distDir, 'index.html'))) {
  console.error('memside: src/web/dist/index.html not found - run `bun run build` first')
  process.exit(1)
}

await startDaemon({ port: PORT, installClaudeHooks: true, serveStaticDir: distDir })
console.log(`memside on http://127.0.0.1:${PORT} (UI + API, hooks installed)`)
