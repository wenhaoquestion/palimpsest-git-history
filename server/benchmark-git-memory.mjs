// node --expose-gc server/benchmark-git-memory.mjs [--keep]
// Reuse --repo /fixture and --module /older/git-service.mjs for fair comparisons.
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
function option(name) {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} requires a value`)
  return args[index + 1]
}
const suppliedRepo = option('--repo')
const modulePath = option('--module') || fileURLToPath(new URL('./git-service.mjs', import.meta.url))
const repoPath = suppliedRepo ? path.resolve(suppliedRepo) : await mkdtemp(path.join(tmpdir(), 'palimpsest-memory-'))
const { createGitService } = await import(pathToFileURL(path.resolve(modulePath)))
const samples = []
let service

async function buildFixture() {
  execFileSync('git', ['init', '-q', '-b', 'main', repoPath])
  const child = spawn('git', ['-C', repoPath, 'fast-import', '--quiet'], { stdio: ['pipe', 'inherit', 'inherit'] })
  const closed = once(child, 'close')
  for (let revision = 0; revision < 12; revision += 1) {
    let stream = `blob\nmark :${revision + 1}\ndata 2\n${String.fromCharCode(65 + revision)}\n\n`
    stream += `commit refs/heads/main\ncommitter Bench <bench@example.test> ${1700000000 + revision} +0000\ndata 2\nv${revision % 10}\n`
    for (let file = 0; file < 50000; file += 1) {
      stream += `M 100644 :${revision + 1} dir${Math.floor(file / 1000)}/very-long-directory-for-memory-stress/sub${Math.floor(file / 100) % 10}/file-name-with-enough-characters-${file}.txt\n`
    }
    if (!child.stdin.write(`${stream}\n`)) await once(child.stdin, 'drain')
  }
  child.stdin.end()
  if ((await closed)[0] !== 0) throw new Error('Git could not create the memory fixture')
}

const mib = (bytes) => Number((bytes / 1024 ** 2).toFixed(1))
let started
async function sample(operation) {
  await new Promise((resolve) => setImmediate(resolve))
  global.gc?.()
  const memory = process.memoryUsage()
  samples.push({
    operation,
    elapsedMs: Math.round(performance.now() - started),
    heapMiB: mib(memory.heapUsed),
    rssMiB: mib(memory.rss),
    externalMiB: mib(memory.external),
    ...(service?.getResourceUsage ? { resources: service.getResourceUsage() } : {}),
  })
}

try {
  if (!suppliedRepo) await buildFixture()
  service = createGitService({ repoPath })
  started = performance.now()
  await sample('start')
  const repository = await service.getRepository({ includeStats: false })
  if (repository.status !== 'ready') throw new Error(JSON.stringify(repository))
  await sample('repository')
  const commits = repository.commits.slice(0, 12)
  for (let index = 0; index < commits.length; index += 1) {
    const page = await service.getChanges(commits[index].oid, { limit: 1 })
    if (page.stats.files !== page.total) throw new Error('Inconsistent exact change totals')
    await sample(`changes-${index}`)
  }
  for (let index = 0; index < Math.min(6, commits.length); index += 1) {
    await service.getCommit(commits[index].oid)
    await sample(`exact-${index}`)
  }
  for (let index = 0; index < 60; index += 1) {
    // A fixed stride visits every commit in the 12-commit fixture, then repeats
    // the same random-looking seeks to expose cache growth or retained buffers.
    await service.getCommitLandscape(commits[(index * 7) % commits.length].oid)
    if (index % 10 === 9) await sample(`seek-${index + 1}`)
  }
  await service.dispose?.()
  await sample('disposed')
  console.log(JSON.stringify({
    node: process.version,
    forcedGc: typeof global.gc === 'function',
    repoPath,
    repositoryRetained: Boolean(suppliedRepo || args.includes('--keep')),
    fixture: suppliedRepo ? 'existing repository' : '12 commits; 50,000 files all modified every commit',
    cacheAccounting: 'Conservative retained-cache estimates; not a hard limit for total process memory.',
    peakRssMiB: Number((process.resourceUsage().maxRSS / 1024).toFixed(1)),
    samples,
  }, null, 2))
} finally {
  await service?.dispose?.()
  if (!suppliedRepo && !args.includes('--keep')) await rm(repoPath, { recursive: true, force: true })
}
