import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createApiMiddleware } from './api-middleware.mjs'
import { createGitService, GitServiceError, validateGitPath } from './git-service.mjs'

function runGit(repoPath, args, { date } = {}) {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
    },
  }).trim()
}

async function put(repoPath, relativePath, contents) {
  const target = path.join(repoPath, ...relativePath.split('/'))
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, contents)
}

function commit(repoPath, message, date) {
  runGit(repoPath, ['add', '-A'])
  runGit(repoPath, ['commit', '-m', message], { date })
  return runGit(repoPath, ['rev-parse', 'HEAD'])
}

async function makeRepository(t) {
  const repoPath = await mkdtemp(path.join(tmpdir(), 'palimpsest-git-'))
  t.after(() => rm(repoPath, { recursive: true, force: true }))
  runGit(repoPath, ['init', '-b', 'main'])
  runGit(repoPath, ['config', 'user.name', 'Ada Lovelace'])
  runGit(repoPath, ['config', 'user.email', 'ada@example.test'])

  await put(repoPath, 'README.md', '# Test repository\n')
  await put(repoPath, 'src/alpha.js', 'export const value = 1\n')
  await put(repoPath, '资料/说明.txt', '第一版\n')
  const root = commit(repoPath, 'Initial structure', '2024-01-01T10:00:00+00:00')

  await put(repoPath, 'src/alpha.js', 'export const value = 2\nexport const label = "changed"\n')
  await put(repoPath, 'docs/guide.md', 'A short guide.\n')
  await put(repoPath, 'assets/pixel.bin', Buffer.from([0, 1, 2, 3, 0, 255]))
  const modified = commit(repoPath, 'Expand the project\n\nAdds docs and a binary fixture.', '2024-01-02T10:00:00+00:00')

  runGit(repoPath, ['branch', 'feature'])
  await unlink(path.join(repoPath, 'docs', 'guide.md'))
  await put(repoPath, 'main-note.txt', 'Main line\n')
  const mainOnly = commit(repoPath, 'Advance main', '2024-01-03T10:00:00+00:00')

  runGit(repoPath, ['checkout', 'feature'])
  runGit(repoPath, ['mv', 'src/alpha.js', 'src/core.js'])
  const renamed = commit(repoPath, 'Rename alpha to core', '2024-01-04T10:00:00+00:00')
  await put(repoPath, 'src/feature.js', 'export const feature = true\n')
  const feature = commit(repoPath, 'Add feature module', '2024-01-05T10:00:00+00:00')

  runGit(repoPath, ['checkout', 'main'])
  runGit(repoPath, ['merge', '--no-ff', 'feature', '-m', 'Merge feature'], {
    date: '2024-01-06T10:00:00+00:00',
  })
  const merge = runGit(repoPath, ['rev-parse', 'HEAD'])
  runGit(repoPath, ['tag', '-a', 'v1.0.0', '-m', 'Version 1'])

  await unlink(path.join(repoPath, 'src', 'feature.js'))
  const deleted = commit(repoPath, 'Remove feature module', '2024-01-07T10:00:00+00:00')

  return { repoPath, root, modified, mainOnly, renamed, feature, merge, deleted }
}

test('loads a bounded, dependency-safe HEAD window with refs, lanes, and stats', async (t) => {
  const fixture = await makeRepository(t)
  const service = createGitService({ repoPath: fixture.repoPath })
  const payload = await service.getRepository()

  assert.equal(payload.status, 'ready')
  assert.equal(payload.repo.branch, 'main')
  assert.equal(payload.repo.headOid, fixture.deleted)
  assert.equal(payload.repo.counts.commits, 7)
  assert.equal(payload.repo.counts.allCommits, 7)
  assert.equal(payload.repo.counts.branches, 2)
  assert.equal(payload.repo.counts.tags, 1)
  assert.deepEqual(payload.authors, ['Ada Lovelace'])
  assert.equal(payload.dateRange.start, '2024-01-01T10:00:00+00:00')
  assert.equal(payload.dateRange.end, '2024-01-07T10:00:00+00:00')

  const positions = new Map(payload.commits.map((entry, index) => [entry.oid, index]))
  for (const entry of payload.commits) {
    for (const parent of entry.parents) {
      assert.ok(positions.get(parent) < positions.get(entry.oid), `${parent} must precede ${entry.oid}`)
    }
    assert.ok(entry.stats)
  }

  const root = payload.commits.find((entry) => entry.oid === fixture.root)
  const feature = payload.commits.find((entry) => entry.oid === fixture.feature)
  const merge = payload.commits.find((entry) => entry.oid === fixture.merge)
  assert.equal(root.stats.files, 3)
  assert.ok(root.branches.includes('main'))
  assert.equal(merge.parents.length, 2)
  assert.ok(merge.directRefs.includes('v1.0.0'))
  assert.notEqual(feature.lane, payload.commits.find((entry) => entry.oid === fixture.mainOnly).lane)

  const tag = payload.refs.find((ref) => ref.kind === 'tag')
  assert.equal(tag.shortName, 'v1.0.0')
  assert.equal(tag.oid, fixture.merge)
})

test('pages chronological history, switches refs, locates commits, and validates bounds', async (t) => {
  const fixture = await makeRepository(t)
  const service = createGitService({ repoPath: fixture.repoPath })
  const repository = await service.getRepository()

  assert.deepEqual(repository.history, {
    ref: 'HEAD',
    offset: 0,
    limit: 128,
    total: 7,
    hasMore: false,
    order: 'chronological-topological',
  })

  const first = await service.getCommits({ offset: 0, limit: 3 })
  const second = await service.getCommits({ offset: 3, limit: 3 })
  const last = await service.getCommits({ offset: 6, limit: 3 })
  assert.equal(first.total, 7)
  assert.equal(first.items[0].oid, fixture.root)
  assert.deepEqual(first.items.map((entry) => entry.index), [0, 1, 2])
  assert.equal(second.offset, 3)
  assert.equal(last.items[0].oid, fixture.deleted)
  assert.equal(last.hasMore, false)

  const combined = [...first.items, ...second.items, ...last.items]
  const positions = new Map(combined.map((entry, index) => [entry.oid, index]))
  for (const entry of combined) {
    for (const parent of entry.parents) {
      assert.ok(positions.get(parent) < positions.get(entry.oid), `${parent} must precede ${entry.oid}`)
    }
  }

  const feature = await service.getCommits({ ref: 'feature', offset: 0, limit: 10 })
  assert.equal(feature.ref, 'feature')
  assert.equal(feature.total, 4)
  assert.equal(feature.items.at(-1).oid, fixture.feature)

  const location = await service.getCommitIndex(fixture.merge)
  assert.equal(location.oid, fixture.merge)
  assert.equal(location.index, positions.get(fixture.merge))
  assert.equal(location.total, 7)

  await assert.rejects(
    service.getCommitIndex(fixture.deleted, { ref: 'feature' }),
    (error) => error instanceof GitServiceError && error.code === 'COMMIT_NOT_IN_REF',
  )
  await assert.rejects(
    service.getCommits({ offset: -1, limit: 10 }),
    (error) => error instanceof GitServiceError && error.code === 'INVALID_OFFSET',
  )
  await assert.rejects(
    service.getCommits({ offset: 0, limit: 513 }),
    (error) => error instanceof GitServiceError && error.code === 'INVALID_LIMIT',
  )
  await assert.rejects(
    service.getCommits({ ref: '--all', offset: 0, limit: 10 }),
    (error) => error instanceof GitServiceError && error.code === 'INVALID_REF',
  )
})

test('returns exact trees and A/M/D/R changes with text and binary statistics', async (t) => {
  const fixture = await makeRepository(t)
  const service = createGitService({ repoPath: fixture.repoPath })

  const root = await service.getCommit(fixture.root)
  assert.ok(root.changes.every((change) => change.status === 'A'))
  assert.ok(root.tree.some((entry) => entry.type === 'tree' && entry.path === '资料'))
  assert.ok(root.tree.some((entry) => entry.path === '资料/说明.txt'))

  const modified = await service.getCommit(fixture.modified)
  assert.ok(modified.changes.some((change) => change.status === 'M' && change.path === 'src/alpha.js'))
  assert.ok(modified.changes.some((change) => change.status === 'A' && change.path === 'docs/guide.md'))
  const binary = modified.changes.find((change) => change.path === 'assets/pixel.bin')
  assert.equal(binary.binary, true)
  assert.equal(binary.additions, null)
  assert.equal(modified.stats.binaries, 1)

  const renamed = await service.getCommit(fixture.renamed)
  const rename = renamed.changes.find((change) => change.status === 'R')
  assert.equal(rename.previousPath, 'src/alpha.js')
  assert.equal(rename.path, 'src/core.js')
  assert.equal(rename.similarity, 100)

  const deleted = await service.getCommit(fixture.deleted)
  assert.ok(deleted.changes.some((change) => change.status === 'D' && change.path === 'src/feature.js'))
  assert.ok(!deleted.tree.some((entry) => entry.path === 'src/feature.js'))
})

test('serves a bounded landscape plus exact paged tree and change inspection', async (t) => {
  const fixture = await makeRepository(t)
  const service = createGitService({
    repoPath: fixture.repoPath,
    landscapeFileLimit: 2,
    landscapeChangeLimit: 2,
  })

  const landscape = await service.getCommit(fixture.modified, { view: 'landscape' })
  assert.equal(landscape.oid, fixture.modified)
  assert.equal(landscape.tree.length, 2)
  assert.equal(landscape.changes.length, 2)
  assert.equal(landscape.stats, null)
  assert.equal(landscape.landscape.totalFiles, 5)
  assert.equal(landscape.landscape.totalDirectories, 4)
  assert.equal(landscape.landscape.complete, false)
  assert.equal(landscape.landscape.totalBytes, null)
  assert.ok(landscape.tree.every((entry) => entry.type !== 'blob' || Number.isSafeInteger(entry.size)))
  assert.deepEqual(landscape.changesPage, { total: 3, included: 2, hasMore: true })
  assert.equal(landscape.changeSummary.statuses.A, 2)
  assert.equal(landscape.changeSummary.statuses.M, 1)

  const rootPage = await service.getTree(fixture.modified, '.', { offset: 0, limit: 2 })
  assert.equal(rootPage.path, '.')
  assert.equal(rootPage.total, 5)
  assert.equal(rootPage.items.length, 2)
  assert.equal(rootPage.hasMore, true)
  assert.ok(rootPage.items.some((entry) => entry.type === 'tree'))

  const srcPage = await service.getTree(fixture.modified, 'src', { offset: 0, limit: 10 })
  assert.equal(srcPage.total, 1)
  assert.equal(srcPage.items[0].path, 'src/alpha.js')
  assert.equal(srcPage.items[0].size, Buffer.byteLength('export const value = 2\nexport const label = "changed"\n'))

  const changesPage = await service.getChanges(fixture.modified, { offset: 1, limit: 2 })
  assert.equal(changesPage.total, 3)
  assert.equal(changesPage.items.length, 2)
  assert.equal(changesPage.hasMore, false)
  assert.ok(changesPage.stats.additions > 0)
  assert.ok(changesPage.items.every((change) => change.binary || change.additions !== null))

  await assert.rejects(
    service.getTree(fixture.modified, 'not-here', { offset: 0, limit: 10 }),
    (error) => error instanceof GitServiceError && error.code === 'TREE_PATH_NOT_FOUND',
  )
  await assert.rejects(
    service.getCommit(fixture.modified, { view: 'unknown' }),
    (error) => error instanceof GitServiceError && error.code === 'INVALID_VIEW',
  )
})

test('provides lazy diffs, merge-parent selection, truncation, and follow history', async (t) => {
  const fixture = await makeRepository(t)
  const service = createGitService({ repoPath: fixture.repoPath, diffLimit: 180 })

  const patch = await service.getDiff(fixture.modified, 'src/alpha.js')
  assert.match(patch.patch, /export const value = 2/)
  assert.equal(patch.binary, false)

  const binaryPatch = await service.getDiff(fixture.modified, 'assets/pixel.bin')
  assert.equal(binaryPatch.binary, true)

  const mergePatch = await service.getDiff(fixture.merge, 'main-note.txt', { parentIndex: 1 })
  assert.equal(mergePatch.parentIndex, 1)
  assert.match(mergePatch.patch, /Main line/)

  const historyPayload = await service.getFileHistory(fixture.deleted, 'src/core.js')
  assert.equal(historyPayload.path, 'src/core.js')
  assert.ok(historyPayload.entries.some((entry) => entry.oid === fixture.renamed))
  assert.ok(historyPayload.entries.some((entry) => entry.oid === fixture.root))

  const directoryPatch = await service.getDiff(fixture.modified, 'src')
  assert.match(directoryPatch.patch, /export const value = 2/)
  const directoryHistory = await service.getFileHistory(fixture.deleted, 'src')
  assert.ok(directoryHistory.entries.some((entry) => entry.oid === fixture.renamed))

  const rootHistory = await service.getFileHistory(fixture.deleted, '.')
  assert.ok(rootHistory.entries.some((entry) => entry.oid === fixture.root))

  const tinyService = createGitService({ repoPath: fixture.repoPath, diffLimit: 32 })
  const truncated = await tinyService.getDiff(fixture.modified, 'src/alpha.js')
  assert.equal(truncated.truncated, true)
  assert.ok(Buffer.byteLength(truncated.patch) <= 32)

  await assert.rejects(
    service.getDiff(fixture.modified, '../outside.txt'),
    (error) => error instanceof GitServiceError && error.code === 'INVALID_PATH',
  )
  await assert.rejects(
    service.getDiff(fixture.merge, 'main-note.txt', { parentIndex: 3 }),
    (error) => error instanceof GitServiceError && error.code === 'INVALID_PARENT',
  )
})

test('refresh invalidates cached repository data', async (t) => {
  const fixture = await makeRepository(t)
  const service = createGitService({ repoPath: fixture.repoPath })
  const before = await service.getRepository()
  await put(fixture.repoPath, 'after-refresh.txt', 'New history\n')
  const newHead = commit(fixture.repoPath, 'Commit after cache', '2024-01-08T10:00:00+00:00')

  const cached = await service.getRepository()
  assert.equal(cached.repo.headOid, before.repo.headOid)
  const refreshed = await service.refresh()
  assert.equal(refreshed.repo.headOid, newHead)
  assert.equal(refreshed.repo.counts.commits, before.repo.counts.commits + 1)
})

test('reports missing and empty repositories without crashing', async (t) => {
  const folder = await mkdtemp(path.join(tmpdir(), 'palimpsest-empty-'))
  t.after(() => rm(folder, { recursive: true, force: true }))

  const missing = await createGitService({ repoPath: folder }).getRepository()
  assert.equal(missing.status, 'error')
  assert.match(missing.message, /No Git repository/)

  runGit(folder, ['init', '-b', 'main'])
  const empty = await createGitService({ repoPath: folder }).getRepository()
  assert.equal(empty.status, 'empty')
})

test('Connect middleware serves API payloads and errors', async (t) => {
  const fixture = await makeRepository(t)
  const middleware = createApiMiddleware({ repoPath: fixture.repoPath })
  const server = createServer((request, response) => middleware(request, response, () => {
    response.statusCode = 404
    response.end('fallback')
  }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}`

  const repositoryResponse = await fetch(`${base}/api/repository`)
  assert.equal(repositoryResponse.status, 200)
  assert.match(repositoryResponse.headers.get('cache-control'), /no-store/)
  const repositoryPayload = await repositoryResponse.json()
  assert.equal(repositoryPayload.status, 'ready')

  const pageResponse = await fetch(`${base}/api/commits?offset=2&limit=2&ref=HEAD`)
  assert.equal(pageResponse.status, 200)
  const pagePayload = await pageResponse.json()
  assert.equal(pagePayload.offset, 2)
  assert.equal(pagePayload.items.length, 2)
  assert.equal(pagePayload.total, 7)

  const locationResponse = await fetch(`${base}/api/commit-index?oid=${fixture.merge}&ref=HEAD`)
  assert.equal(locationResponse.status, 200)
  assert.equal((await locationResponse.json()).oid, fixture.merge)

  const invalidPageResponse = await fetch(`${base}/api/commits?offset=-1&limit=20`)
  assert.equal(invalidPageResponse.status, 400)
  assert.equal((await invalidPageResponse.json()).error.code, 'INVALID_OFFSET')

  const commitResponse = await fetch(`${base}/api/commits/${fixture.renamed}`)
  assert.equal(commitResponse.status, 200)
  assert.equal((await commitResponse.json()).oid, fixture.renamed)

  const landscapeResponse = await fetch(`${base}/api/commits/${fixture.modified}?view=landscape&repository=${repositoryPayload.repositoryId}`)
  assert.equal(landscapeResponse.status, 200)
  assert.match(landscapeResponse.headers.get('cache-control'), /immutable/)
  const landscapePayload = await landscapeResponse.json()
  assert.equal(landscapePayload.stats, null)
  assert.equal(landscapePayload.landscape.totalFiles, 5)

  const treeResponse = await fetch(`${base}/api/tree/${fixture.modified}?path=src&offset=0&limit=10`)
  assert.equal(treeResponse.status, 200)
  assert.equal((await treeResponse.json()).items[0].path, 'src/alpha.js')

  const changesResponse = await fetch(`${base}/api/changes/${fixture.modified}?offset=0&limit=2`)
  assert.equal(changesResponse.status, 200)
  const changesPayload = await changesResponse.json()
  assert.equal(changesPayload.items.length, 2)
  assert.equal(changesPayload.total, 3)

  const historyResponse = await fetch(`${base}/api/file-history/${fixture.deleted}?path=${encodeURIComponent('src/core.js')}`)
  assert.equal(historyResponse.status, 200)
  assert.ok((await historyResponse.json()).entries.length >= 2)

  const invalidResponse = await fetch(`${base}/api/diff/${fixture.modified}?path=${encodeURIComponent('../secret')}`)
  assert.equal(invalidResponse.status, 400)
  assert.equal((await invalidResponse.json()).error.code, 'INVALID_PATH')

  const fallbackResponse = await fetch(`${base}/not-api`)
  assert.equal(await fallbackResponse.text(), 'fallback')
})

test('validates repository-relative paths', () => {
  assert.equal(validateGitPath('src/资料.ts'), 'src/资料.ts')
  assert.equal(validateGitPath('.'), '.')
  assert.throws(() => validateGitPath('/etc/passwd'))
  assert.throws(() => validateGitPath('src/../secret'))
  assert.throws(() => validateGitPath('C:\\secret.txt'))
})
