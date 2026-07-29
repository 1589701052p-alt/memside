import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// loopback 请求绕过系统 HTTP_PROXY：vite dev server 的 proxy upstream 打到
// 127.0.0.1:7777（daemon），在装了系统代理（如 Clash 7897）的机器上，Bun 的
// Node http 会把 loopback 请求也走代理 -> 502/连接失败 -> 前端「连不上 daemon」
// （CLAUDE.md loopback 排除代理陷阱）。在 config 顶层设置 NO_PROXY，覆盖
// `bun run dev` / `bun run dev:web` 所有 vite 入口。幂等：已含 127.0.0.1 时不重加。
const NO_PROXY_LOOPBACK = '127.0.0.1,localhost'
if (!(process.env.NO_PROXY ?? '').includes('127.0.0.1')) {
  process.env.NO_PROXY = process.env.NO_PROXY ? `${process.env.NO_PROXY},${NO_PROXY_LOOPBACK}` : NO_PROXY_LOOPBACK
}

/**
 * Vite config for the approval-queue web UI (Task 15).
 *
 * `root` is `src/web` so index.html is served at `/`. The dev server proxies
 * the three route groups defined in `src/server.ts` (the memside HTTP layer on
 * :7777) so the browser can hit `/api/memories`, `/inject`, and
 * `/hooks/claude/:event` without CORS configuration.
 */
export default defineConfig({
  plugins: [react()],
  root: 'src/web',
  server: {
    proxy: {
      // NOTE: use `/api/` (trailing slash), not `/api` — the latter would also
      // intercept the `/api.ts` module request (App.tsx does `import './api'`)
      // and proxy it to the daemon, which 404s and breaks the whole module
      // graph -> blank page.
      '/api/': 'http://127.0.0.1:7777',
      '/inject': 'http://127.0.0.1:7777',
      '/hooks': 'http://127.0.0.1:7777',
    },
  },
})
