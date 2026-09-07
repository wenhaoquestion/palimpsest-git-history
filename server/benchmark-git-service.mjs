// node server/benchmark-git-service.mjs [--stats] [--repo /path/to/repo]
// Supply --module /path/to/older/git-service.mjs to compare implementations.
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}
const suppliedRepo = option('--repo')
const modulePath = option('--module') || fileURLToPath(new URL('./git-service.mjs', import.meta.url))
const { createGitService } = await import(pathToFileURL(path.resolve(modulePath)))
const repoPath = suppliedRepo ? path.resolve(suppliedRepo) : await mkdtemp(path.join(tmpdir(), 'palimpsest-benchmark-'))
const includeStats = args.includes('--stats')
const measurements = []
let service

function git(args, input) {
  return execFileSync('git', ['-C', repoPath, ...args], { input, encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim()
}

async function measure(operation, work) {
  const started = performance.now()
  const result = await work()
  measurements.push({ operation, milliseconds: Number((performance.now() - started).toFixed(1)) })
  return result
}

try {
  if (!suppliedRepo) {
    git(['init', '-q', '-b', 'main'])
    let stream = ''
    for (let index = 0; index < 1200; index += 1) {
      const body = Array.from({ length: 500 }, (_, line) => `line ${line} value ${index % 17}\n`).join('')
      const message = String(index)
      stream += `blob\nmark :${index + 1}\ndata ${Buffer.byteLength(body)}\n${body}\n`
      stream += `commit refs/heads/main\ncommitter Bench <bench@example.test> ${1700000000 + index} +0000\ndata ${message.length}\n${message}\n`
      for (let file = 0; file < (index === 0 ? 20000 : 128); file += 1) {
        const id = index === 0 ? file : (index * 128 + file) % 20000
        stream += `M 100644 :${index + 1} dir${Math.floor(id / 400)}/sub${Math.floor(id / 20) % 20}/file${id}.txt\n`
      }
      stream += '\n'
    }
    git(['fast-import', '--quiet'], stream)
  }

  service = createGitService({ repoPath })
  const repository = await measure('repository', () => service.getRepository({ includeStats }))
  if (repository.status !== 'ready') throw new Error(JSON.stringify(repository))
  const total = repository.repo.counts.commits
  const pageOffsets = [...new Set([0.25, 0.5, 0.75].map((fraction) => Math.floor(total * fraction / 128) * 128))]
  const pages = []
  for (const offset of pageOffsets) {
    pages.push(await measure(`page-${offset}`, () => service.getCommits({ offset, limit: 128, includeStats })))
  }
  for (let index = 0; index < 6; index += 1) {
    const page = pages[index % pages.length]
    const commit = page.items[Math.min(index * 10, page.items.length - 1)]
    await measure(`landscape-${index}`, () => service.getCommitLandscape(commit.oid))
  }
  await measure('exact-root', () => service.getCommit(repository.commits[0].oid))
  console.log(JSON.stringify({
    node: process.version,
    git: git(['--version']),
    includeStats,
    repository: suppliedRepo || 'temporary synthetic: 1,200 commits, 20,000 files, 128 edits per commit, 500 lines per file',
    commits: total,
    measurements,
  }, null, 2))
} finally {
  await service?.dispose?.()
  if (!suppliedRepo) await rm(repoPath, { recursive: true, force: true })
}
