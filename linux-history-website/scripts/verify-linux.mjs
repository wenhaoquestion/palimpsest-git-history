import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createLinuxService } from '../server.mjs'
import { linuxRepoPath } from './paths.mjs'

const service = await createLinuxService()
const measurements = []
const timed = async (operation, work) => {
  const started = performance.now()
  const result = await work()
  measurements.push({ operation, milliseconds: Number((performance.now() - started).toFixed(1)) })
  return result
}
try {
  const repository = await timed('complete-history-index', () => service.getRepository({ includeStats: false }))
  assert.equal(repository.status, 'ready', JSON.stringify(repository))
  assert.equal(repository.repo.shallow, false)
  assert.ok(repository.repo.counts.commits > 1_000_000, 'Expected the complete Linux commit graph')
  assert.equal(repository.commits[0].oid, '1da177e4c3f41524e886b7f1b8a0c1fc7321cac2')
  const total = repository.repo.counts.commits
  const offsets = [0, Math.floor(total * 0.125), Math.floor(total * 0.5), Math.floor(total * 0.875), Math.max(0, total - 128)]
  const pages = []
  for (const offset of offsets) {
    const page = await timed(`page-${offset}`, () => service.getCommits({ offset, limit: 128, includeStats: false }))
    assert.equal(page.total, total)
    assert.equal(page.items.length, 128)
    assert.ok(page.items.every((commit) => commit.stats === null))
    pages.push(page)
  }
  const snapshots = []
  if (process.argv.includes('--landscapes')) {
    for (const page of [pages[0], pages[2], pages[4]]) {
      const commit = page.items[0]
      const snapshot = await timed(`landscape-${page.offset}`, () => service.getCommitLandscape(commit.oid))
      const exactRoot = await service.getTree(commit.oid, '.', { limit: 10 })
      assert.ok(snapshot.landscape.totalFiles > 10_000)
      assert.ok(snapshot.tree.length <= 720)
      assert.ok(snapshot.landscape.directories.length <= 256)
      assert.ok(exactRoot.total > 10)
      snapshots.push({ oid: commit.oid, index: page.offset, files: snapshot.landscape.totalFiles, directories: snapshot.landscape.totalDirectories, sampledFiles: snapshot.tree.length })
    }
    const changes = await timed('exact-head-changes', () => service.getChanges(repository.repo.headOid, { limit: 1 }))
    if (changes.items.length) await timed('exact-file-diff', () => service.getDiff(repository.repo.headOid, changes.items[0].path))
  }
  global.gc?.()
  const memory = process.memoryUsage()
  const report = {
    verifiedAt: new Date().toISOString(),
    repository: 'https://github.com/torvalds/linux',
    head: repository.repo.headOid,
    shallow: repository.repo.shallow,
    commits: total,
    authors: repository.repo.counts.authors,
    tags: repository.repo.counts.tags,
    firstCommit: repository.commits[0].oid,
    measurements,
    snapshots,
    heapMiB: Number((memory.heapUsed / 1024 ** 2).toFixed(1)),
    rssMiB: Number((memory.rss / 1024 ** 2).toFixed(1)),
    resources: service.getResourceUsage(),
  }
  await writeFile(path.join(linuxRepoPath, '..', 'verification.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
} finally {
  await service.dispose()
}
