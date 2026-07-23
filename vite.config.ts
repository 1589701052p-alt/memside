import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

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
