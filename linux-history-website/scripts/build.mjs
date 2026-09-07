import { build } from 'vite'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import config from '../vite.config.mjs'
import { websiteRoot, workspaceRoot } from './paths.mjs'

await build(config)
const deploy = path.join(websiteRoot, 'deploy')
await rm(deploy, { recursive: true, force: true })
await mkdir(path.join(deploy, 'server'), { recursive: true })
await mkdir(path.join(deploy, 'scripts'), { recursive: true })
await cp(path.join(websiteRoot, 'dist'), path.join(deploy, 'dist'), { recursive: true })
for (const file of ['app.mjs', 'api-middleware.mjs', 'git-service.mjs']) {
  await cp(path.join(workspaceRoot, 'server', file), path.join(deploy, 'server', file))
}
const entry = await readFile(path.join(websiteRoot, 'server.mjs'), 'utf8')
await writeFile(path.join(deploy, 'server.mjs'), entry.replaceAll("from '../server/", "from './server/"))
for (const file of ['paths.mjs', 'prepare-data.mjs', 'start.mjs', 'verify-linux.mjs']) {
  await cp(path.join(websiteRoot, 'scripts', file), path.join(deploy, 'scripts', file))
}
await cp(path.join(websiteRoot, 'README.md'), path.join(deploy, 'README.md'))
await cp(path.join(websiteRoot, 'VALIDATION.md'), path.join(deploy, 'VALIDATION.md'))
await writeFile(path.join(deploy, 'package.json'), `${JSON.stringify({
  name: 'linux-history-website', version: '0.1.0', private: true, type: 'module',
  engines: { node: '>=20.19.0' },
  scripts: {
    start: 'node --max-old-space-size=512 scripts/start.mjs',
    'prepare:data': 'node scripts/prepare-data.mjs',
    verify: 'node --expose-gc scripts/verify-linux.mjs',
  },
}, null, 2)}\n`)
console.log(`Standalone deployment created at ${deploy}`)
console.log('Runtime requires Node.js and Git only; repository data is intentionally kept outside the build.')
