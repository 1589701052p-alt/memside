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
      '/api': 'http://127.0.0.1:7777',
      '/inject': 'http://127.0.0.1:7777',
      '/hooks': 'http://127.0.0.1:7777',
    },
  },
})
