import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { get } from 'node:http'
import test from 'node:test'
import { createLinuxWebsite, publicGitEnvironment } from './server.mjs'
import { GitServiceError } from '../server/git-service.mjs'

async function fixture(t, { waitForPage } = {}) {
  const distPath = await mkdtemp(path.join(tmpdir(), 'linux-history-site-'))
  await writeFile(path.join(distPath, 'index.html'), '<!doctype html><title>Linux test site</title>')
  const calls = { repository: [], pages: [], snapshots: [], refresh: 0, disposed: 0 }
  const service = {
    async getRepository(options) {
      calls.repository.push(options)
      return {
        status: 'ready', repo: { name: 'secret-local-name', displayPath: '/private/secret/linux.git', branch: 'master', headOid: 'a'.repeat(40), shallow: false, counts: { commits: 3 } },
        commits: [], refs: [], authors: [], dateRange: {}, history: {},
      }
    },
    async getCommits(options) {
      calls.pages.push(options)
      await waitForPage?.()
      return { items: [], total: 3, offset: options.offset, limit: options.limit, ref: options.ref }
    },
    async getCommit(oid, options) { calls.snapshots.push(options); return { oid, tree: [], changes: [], stats: null } },
    async getChanges() { throw new GitServiceError('Inspection failed.', { code: 'GIT_COMMAND_FAILED', detail: '/private/secret/linux.git/objects' }) },
    async refresh() { calls.refresh += 1; throw new Error('Refresh must never be called') },
    async dispose() { calls.disposed += 1 },
  }
  const server = await createLinuxWebsite({ service, distPath, validate: false })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await server.dispose()
    await rm(distPath, { recursive: true, force: true })
  })
  return { calls, server, base: `http://127.0.0.1:${server.address().port}` }
}

test('public archive rejects project changes and refreshes without touching the service', async (t) => {
  const { base, calls } = await fixture(t)
  for (const [route, method] of [['/api/repository', 'POST'], ['/api/refresh', 'POST'], ['/api/refresh', 'GET'], ['/api/commits', 'DELETE']]) {
    const response = await fetch(`${base}${route}`, { method, ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/private/other-repository' }) } : {}) })
    assert.equal(response.status, 405)
    assert.equal((await response.json()).error.code, 'READ_ONLY')
    assert.equal(response.headers.get('allow'), 'GET, HEAD')
  }
  assert.equal(calls.refresh, 0)
  assert.equal(calls.repository.length, 0)
})

test('public reads share one lightweight repository and hide deployment paths', async (t) => {
  const { base, calls } = await fixture(t)
  const first = await (await fetch(`${base}/api/repository`)).json()
  const second = await (await fetch(`${base}/api/repository?stats=true`)).json()
  assert.equal(first.repositoryId, second.repositoryId)
  assert.equal(first.repo.name, 'torvalds/linux')
  assert.equal(first.repo.displayPath, 'https://github.com/torvalds/linux')
  assert.ok(calls.repository.every((options) => options.includeStats === false))
  await fetch(`${base}/api/commits?ref=master&offset=1&limit=2`)
  assert.equal(calls.pages[0].includeStats, false)
  assert.equal(calls.pages[0].ref, 'master')
  const error = await (await fetch(`${base}/api/changes/${'a'.repeat(40)}`)).json()
  assert.equal(error.error.detail, undefined)
  assert.ok(!JSON.stringify(error).includes('/private/'))
})

test('public scope and snapshot bounds reject revision expressions and recursive exact responses', async (t) => {
  const { base, calls } = await fixture(t)
  const refResponse = await fetch(`${base}/api/commits?ref=HEAD~1000`)
  assert.equal(refResponse.status, 400)
  assert.equal((await refResponse.json()).error.code, 'INVALID_REF')
  assert.equal(calls.pages.length, 0)
  const oid = 'a'.repeat(40)
  const exactResponse = await fetch(`${base}/api/commits/${oid}?view=exact`)
  assert.equal(exactResponse.status, 400)
  assert.equal((await exactResponse.json()).error.code, 'USE_PAGED_INSPECTION')
  await fetch(`${base}/api/commits/${oid}`)
  assert.deepEqual(calls.snapshots, [{ view: 'landscape' }])
})

test('public HTTP work is bounded until responses finish while static files stay available', async (t) => {
  let release
  const waiting = new Promise((resolve) => { release = resolve })
  const { base, calls } = await fixture(t, { waitForPage: () => waiting })
  t.after(() => release())
  const requests = Array.from({ length: 4 }, (_, index) => fetch(`${base}/api/commits?offset=${index}`))
  const deadline = Date.now() + 2000
  while (calls.pages.length < 4 && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.pages.length, 4)
  const busy = await fetch(`${base}/api/commits?offset=5`)
  assert.equal(busy.status, 503)
  assert.equal(busy.headers.get('retry-after'), '1')
  assert.equal((await busy.json()).error.code, 'SERVER_BUSY')
  for (const requestPath of [`${base}/api/repository`, '//localhost/api/repository']) {
    const status = await new Promise((resolve, reject) => {
      get(base, { path: requestPath }, (response) => { response.resume(); resolve(response.statusCode) }).on('error', reject)
    })
    assert.equal(status, 503, 'Absolute-form URLs must use the same request budget')
  }
  assert.match(await (await fetch(`${base}/`)).text(), /Linux test site/)
  release()
  const responses = await Promise.all(requests)
  assert.ok(responses.every((response) => response.status === 200))
  assert.equal((await fetch(`${base}/api/repository`)).status, 200)
})

test('public Git execution isolates system, global, and injected command-line config', () => {
  const previous = process.env.GIT_CONFIG_COUNT
  try {
    process.env.GIT_CONFIG_COUNT = '1'
    const environment = publicGitEnvironment()
    assert.equal(environment.GIT_CONFIG_NOSYSTEM, '1')
    assert.ok(environment.GIT_CONFIG_GLOBAL)
    assert.ok(environment.GIT_CONFIG_SYSTEM)
    assert.equal(environment.GIT_CONFIG_COUNT, undefined)
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_COUNT
    else process.env.GIT_CONFIG_COUNT = previous
  }
})

test('disconnecting a client does not release its slot while Git work is still running', async (t) => {
  let release
  const waiting = new Promise((resolve) => { release = resolve })
  const { base, calls } = await fixture(t, { waitForPage: () => waiting })
  t.after(() => release())
  const clients = Array.from({ length: 4 }, (_, offset) => get(`${base}/api/commits?offset=${offset}`).on('error', () => {}))
  const deadline = Date.now() + 2000
  while (calls.pages.length < 4 && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.pages.length, 4)
  await Promise.all(clients.map((client) => new Promise((resolve) => { client.once('close', resolve); client.destroy() })))
  const busy = await fetch(`${base}/api/repository`)
  assert.equal(busy.status, 503)
  assert.equal(calls.repository.length, 0)
  release()
  let available
  do {
    available = await fetch(`${base}/api/repository`)
  } while (available.status === 503 && Date.now() < deadline)
  assert.equal(available.status, 200)
})
