import { access, cp, mkdir, readdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const target = path.join(root, 'extension')
for (const name of ['git-service.mjs', 'api-middleware.mjs', 'rpc-client.mjs', 'rpc-worker.mjs']) {
  await access(path.join(root, 'server', name))
}
for (const name of ['dist', 'server']) {
  await rm(path.join(target, name), { recursive: true, force: true })
  await mkdir(path.join(target, name), { recursive: true })
}
await cp(path.join(root, 'dist'), path.join(target, 'dist'), {
  recursive: true,
  filter: (file) => !file.endsWith('.map'),
})
for (const name of await readdir(path.join(root, 'server'))) {
  if (!name.endsWith('.mjs') || name.endsWith('.test.mjs') || name.startsWith('benchmark-') || name === 'app.mjs') continue
  await cp(path.join(root, 'server', name), path.join(target, 'server', name))
}
console.log('Prepared extension runtime; source maps, tests, fixtures, and node_modules are excluded.')
