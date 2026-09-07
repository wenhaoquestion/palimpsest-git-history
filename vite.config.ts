import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { gitHistoryApi } from './server/api-middleware.mjs'

export default defineConfig({
  base: './',
  plugins: [
    react(),
    gitHistoryApi({ repoPath: process.env.PALIMPSEST_REPO || process.cwd() }),
  ],
  build: {
    target: 'es2022',
    sourcemap: true,
    reportCompressedSize: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    watch: {
      // The selected repository can live under this workspace and may contain
      // hundreds of thousands of files. Git is the data source; Vite should
      // not watch that checkout for frontend hot reloads.
      ignored: ['**/.palimpsest-target/**', '**/linux-history-website/data/**', '**/linux-history-website/deploy/**'],
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
})
