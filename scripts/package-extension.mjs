import { mkdir, readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(await readFile(path.join(root, 'extension/package.json'), 'utf8'))
const releases = path.join(root, 'releases')
await mkdir(releases, { recursive: true })
const target = path.join(releases, `${manifest.name}-${manifest.version}.vsix`)
execFileSync(process.execPath, [path.join(root, 'node_modules/@vscode/vsce/vsce'),
  'package', '--no-dependencies',
  '--baseContentUrl', 'https://github.com/wenhaoquestion/palimpsest-git-history/blob/main/extension/',
  '--baseImagesUrl', 'https://raw.githubusercontent.com/wenhaoquestion/palimpsest-git-history/main/extension/',
  '--out', target,
], { cwd: path.join(root, 'extension'), stdio: 'inherit' })
console.log(`Install with: code --install-extension "${target}"`)
