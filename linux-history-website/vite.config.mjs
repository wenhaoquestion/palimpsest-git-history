import path from 'node:path'
import react from '@vitejs/plugin-react'
import { websiteRoot, workspaceRoot } from './scripts/paths.mjs'

export default {
  configFile: false,
  root: workspaceRoot,
  base: '/',
  plugins: [react(), {
    name: 'linux-history-product',
    transformIndexHtml(html) {
      return html.replace(/<title>.*?<\/title>/, '<title>Linux History — the kernel through time</title>')
        .replace('Palimpsest — replay a Git repository as an evolving architectural landscape.', 'Explore the complete torvalds/linux Git history, its architecture, files, and changes through time.')
    },
  }],
  define: { 'import.meta.env.VITE_HISTORY_SITE': JSON.stringify('linux') },
  build: { target: 'es2022', outDir: path.join(websiteRoot, 'dist'), emptyOutDir: true, sourcemap: false },
  server: {
    host: '127.0.0.1', port: 4181, strictPort: true,
    fs: { allow: [workspaceRoot] },
    watch: { ignored: ['**/linux-history-website/data/**', '**/linux-history-website/deploy/**'] },
  },
}
