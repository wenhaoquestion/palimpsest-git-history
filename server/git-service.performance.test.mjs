import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createGitService } from './git-service.mjs'

function git(repoPath, args, options = {}) {
  return execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', ...options }).trim()
}

async function fixture(t, { commits = 160, files = 16, filePathForIndex = (file) => `src/file${file}.txt` } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'palimpsest-performance-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  git(directory, ['init', '-q', '-b', 'main'])
  let stream = ''
  for (let index = 0; index < commits; index += 1) {
    const content = `revision ${index}\n`
    const message = `Commit ${index}`
    stream += `blob\nmark :${index + 1}\ndata ${Buffer.byteLength(content)}\n${content}\n`
    stream += `commit refs/heads/main\ncommitter Example <example@test.invalid> ${1700000000 + index} +0000\ndata ${message.length}\n${message}\n`
    for (let file = 0; file < (index === 0 ? files : 1); file += 1) {
      stream += `M 100644 :${index + 1} ${filePathForIndex(file)}\n`
    }
    stream += '\n'
  }
  git(directory, ['fast-import', '--quiet'], { input: stream })
  git(directory, ['branch', 'alias'])
  const logPath = path.join(directory, 'git-invocations.jsonl')
  // Git's built-in trace works on Windows too and proves which expensive
  // commands ran without adding timing-sensitive assertions or a fake Git.
  const previousTrace = process.env.GIT_TRACE2_EVENT
  let service
  try {
    process.env.GIT_TRACE2_EVENT = logPath
    service = createGitService({ repoPath: directory })
  } finally {
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT
    else process.env.GIT_TRACE2_EVENT = previousTrace
  }
  t.after(() => service.dispose())
  return {
    directory,
    service,
    invocations: async () => (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse).filter((event) => event.event === 'start').map((event) => event.argv),
  }
}

test('lightweight timeline skips text diffs and exact stats remain available on demand', async (t) => {
  const { service, invocations } = await fixture(t)
  const repository = await service.getRepository({ includeStats: false })
  assert.equal(repository.status, 'ready')
  assert.equal(repository.repo.counts.commits, 160)
  assert.ok(repository.commits.every((commit) => commit.stats === null))
  const light = await service.getCommits({ offset: 128, limit: 32, includeStats: false })
  assert.equal(light.items.length, 32)
  assert.ok(light.items.every((commit) => commit.stats === null))
  assert.ok(!(await invocations()).some((args) => args.includes('show')))

  const exact = await service.getCommits({ offset: 128, limit: 32 })
  assert.deepEqual(exact.items.map((commit) => commit.oid), light.items.map((commit) => commit.oid))
  assert.ok(exact.items.every((commit) => commit.stats.files === 1 && commit.stats.additions === 1 && commit.stats.deletions === 1))
  assert.equal((await invocations()).filter((args) => args.includes('show')).length, 1)
  // The exact page must not mutate lightweight cache entries.
  assert.ok(light.items.every((commit) => commit.stats === null))
  assert.deepEqual((await service.getRepository()).commits[0].stats, { files: 16, additions: 16, deletions: 0, binaries: 0 })
})

test('refs sharing a tip keep their own branch membership and lookup ref', async (t) => {
  const { service } = await fixture(t, { commits: 3 })
  const main = await service.getCommits({ ref: 'main', includeStats: false })
  const alias = await service.getCommits({ ref: 'alias', includeStats: false })
  assert.deepEqual(main.items[0].branches, ['main'])
  assert.deepEqual(alias.items[0].branches, ['alias'])
  assert.equal((await service.getCommitIndex(main.items[0].oid, { ref: 'main' })).ref, 'main')
  assert.equal((await service.getCommitIndex(main.items[0].oid, { ref: 'alias' })).ref, 'alias')
})

test('large root changes preserve exact totals and bounded landscape sampling', async (t) => {
  const { service } = await fixture(t, { commits: 1, files: 12000 })
  const repository = await service.getRepository({ includeStats: false })
  const oid = repository.repo.headOid
  const exact = await service.getChanges(oid, { offset: 11990, limit: 20 })
  assert.equal(exact.total, 12000)
  assert.equal(exact.items.length, 10)
  assert.deepEqual(exact.stats, { files: 12000, additions: 12000, deletions: 0, binaries: 0 })
  const landscape = await service.getCommitLandscape(oid)
  assert.equal(landscape.landscape.totalFiles, 12000)
  assert.equal(landscape.landscape.totalDirectories, 1)
  assert.equal(landscape.tree.length, 720)
  assert.equal(landscape.changes.length, 384)
  assert.equal(landscape.landscape.extensions[0].count, 12000)
  assert.equal(landscape.changeSummary.statuses.A, 12000)
})

test('opens bare repositories, linked worktrees, and nested working directories', async (t) => {
  const { directory } = await fixture(t, { commits: 3 })
  const parent = await mkdtemp(path.join(tmpdir(), 'palimpsest-repository-types-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const bare = path.join(parent, 'mirror.git')
  const worktree = path.join(parent, 'linked')
  git(directory, ['clone', '--quiet', '--bare', directory, bare])
  git(directory, ['worktree', 'add', '--quiet', '--detach', worktree, 'HEAD'])
  for (const repoPath of [bare, worktree, path.join(worktree, 'src')]) {
    const service = createGitService({ repoPath })
    t.after(() => service.dispose())
    const repository = await service.getRepository({ includeStats: false })
    assert.equal(repository.status, 'ready', JSON.stringify(repository))
    assert.equal(repository.repo.counts.commits, 3)
    const tree = await service.getTree(repository.repo.headOid, 'src')
    assert.equal(tree.total, 16)
  }
})

test('refresh rebuilds caches and terminal disposal performs no further Git work', async (t) => {
  const { directory, service, invocations } = await fixture(t, { commits: 3 })
  await service.getRepository({ includeStats: false })
  git(directory, ['update-ref', 'refs/heads/main', 'HEAD~1'])
  const reloaded = await service.refresh({ includeStats: false })
  assert.equal(reloaded.repo.counts.commits, 2)
  const before = (await invocations()).length
  await service.dispose()
  await service.dispose()
  assert.equal((await invocations()).length, before)
  await assert.rejects(service.getRepository(), (error) => error.code === 'SERVICE_DISPOSED')
  await assert.rejects(service.refresh(), (error) => error.code === 'SERVICE_DISPOSED')
})


test('wide repositories bound directory and representative samples with exact retained summaries', async (t) => {
  const { service } = await fixture(t, {
    commits: 1, files: 4000,
    filePathForIndex: (index) => `group${index % 400}/nested${Math.floor(index / 400)}/file.txt`,
  })
  const repository = await service.getRepository({ includeStats: false })
  const landscape = await service.getCommitLandscape(repository.repo.headOid)
  assert.equal(landscape.landscape.totalFiles, 4000)
  assert.equal(landscape.landscape.totalDirectories, 4400)
  assert.equal(landscape.landscape.directories.length, 256)
  assert.deepEqual(landscape.landscape.directorySummary, { included: 256, total: 4401, maxDepth: 2, complete: false })
  assert.ok(landscape.landscape.directories.slice(1).every((directory) => directory.fileCount === 10 && directory.directoryCount === 10))
  assert.deepEqual(landscape.landscape.extensions, [{ extension: 'txt', count: 4000, totalBytes: null }])
  assert.equal(landscape.tree.length, 720)
  const rootPage = await service.getTree(repository.repo.headOid, '.', { offset: 397, limit: 3 })
  assert.equal(rootPage.total, 400)
  assert.equal(rootPage.items.length, 3)
})

test('cache byte budgets evict large snapshots without changing exact returned data', async (t) => {
  const { directory } = await fixture(t, { commits: 4, files: 2000 })
  const service = createGitService({ repoPath: directory, cacheBudgetBytes: 256 * 1024 })
  t.after(() => service.dispose())
  const repository = await service.getRepository({ includeStats: false })
  for (const commit of repository.commits) {
    const exact = await service.getCommit(commit.oid)
    assert.equal(exact.tree.filter((entry) => entry.type === 'blob').length, 2000)
    assert.equal(exact.stats.files, commit.index === 0 ? 2000 : 1)
    const usage = service.getResourceUsage()
    assert.ok(usage.cacheBytes <= 256 * 1024)
    assert.equal(usage.activeGitProcesses, 0)
    assert.equal(usage.queuedGitProcesses, 0)
  }
  await service.dispose()
  assert.equal(service.getResourceUsage().cacheBytes, 0)
})

test('process concurrency and queue bounds survive disposal during active requests', async (t) => {
  const { directory } = await fixture(t, { commits: 1, files: 2000 })
  const service = createGitService({
    repoPath: directory,
    maxConcurrentProcesses: 1,
    maxQueuedProcesses: 4,
    maxOutputBytes: 8 * 1024 * 1024,
    maxBufferedBytes: 16 * 1024 * 1024,
  })
  t.after(() => service.dispose())
  const repository = await service.getRepository({ includeStats: false })
  assert.equal(repository.status, 'ready')
  const requests = Array.from({ length: 20 }, (_, offset) => service.getTree(repository.repo.headOid, 'src', { offset, limit: 1 }))
  const settled = Promise.allSettled(requests)
  const deadline = Date.now() + 2000
  while (service.getResourceUsage().queuedGitProcesses < 4 && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  const busy = service.getResourceUsage()
  assert.equal(busy.activeGitProcesses, 1)
  assert.equal(busy.queuedGitProcesses, 4)
  assert.ok(busy.reservedOutputBytes <= busy.maxBufferedBytes)
  await service.dispose()
  const results = await settled
  assert.ok(results.some((result) => result.status === 'rejected' && result.reason.code === 'GIT_BUSY'))
  assert.ok(results.some((result) => result.status === 'rejected' && result.reason.code === 'SERVICE_DISPOSED'))
  assert.equal(service.getResourceUsage().activeGitProcesses, 0)
  assert.equal(service.getResourceUsage().queuedGitProcesses, 0)
  assert.equal(service.getResourceUsage().reservedOutputBytes, 0)
})

test('oversized exact output fails explicitly and releases its process slot', async (t) => {
  const { directory } = await fixture(t, { commits: 1, files: 2000 })
  const service = createGitService({ repoPath: directory, maxOutputBytes: 1024 })
  t.after(() => service.dispose())
  const repository = await service.getRepository({ includeStats: false })
  assert.equal(repository.status, 'ready')
  await assert.rejects(
    service.getTree(repository.repo.headOid, 'src'),
    (error) => error.code === 'OUTPUT_TOO_LARGE' && error.status === 413,
  )
  assert.equal(service.getResourceUsage().activeGitProcesses, 0)
  assert.equal(service.getResourceUsage().reservedOutputBytes, 0)
  const root = await service.getTree(repository.repo.headOid, '.')
  assert.equal(root.total, 1)
})


test('terminal disposal wins a race with refresh and cannot restart Git processes', async (t) => {
  const { service } = await fixture(t, { commits: 1 })
  await service.getRepository({ includeStats: false })
  const refreshing = service.refresh({ includeStats: false })
  const rejected = assert.rejects(refreshing, (error) => error.code === 'SERVICE_DISPOSED')
  await service.dispose()
  await rejected
  assert.equal(service.getResourceUsage().disposed, true)
  assert.equal(service.getResourceUsage().activeGitProcesses, 0)
})
