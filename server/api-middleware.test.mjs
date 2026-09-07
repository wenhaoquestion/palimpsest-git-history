import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import test from 'node:test'
import { createApiMiddleware } from './api-middleware.mjs'

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function requestApi(middleware, url, { method = 'GET', body, headers = {}, chunks } = {}) {
  const request = Readable.from(chunks || (body === undefined ? [] : [Buffer.from(body)]))
  request.url = url
  request.method = method
  request.headers = { host: 'localhost:3000', ...headers }
  request.socket = { encrypted: false }
  const output = []
  const responseHeaders = new Map()
  const response = new Writable({ write(chunk, encoding, callback) { output.push(chunk); callback() } })
  response.statusCode = 200
  response.setHeader = (name, value) => responseHeaders.set(name.toLowerCase(), String(value))
  return new Promise((resolve, reject) => {
    response.once('error', reject)
    response.once('finish', () => {
      const text = Buffer.concat(output).toString('utf8')
      resolve({ status: response.statusCode, headers: responseHeaders, body: text ? JSON.parse(text) : null })
    })
    middleware(request, response, () => {
      response.statusCode = 404
      response.end('{}')
    })
  })
}

function openRepository(middleware, repoPath, options = {}) {
  return requestApi(middleware, '/api/repository', {
    method: 'POST',
    body: JSON.stringify({ path: repoPath }),
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
    ...options,
  })
}

async function makeFixtures(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'palimpsest-api-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const git = (repoPath, args) => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const repos = {}
  for (const name of ['first', 'second', 'empty', 'invalid']) {
    const repoPath = path.join(directory, name)
    repos[name] = repoPath
    await mkdir(repoPath)
    if (name === 'invalid') continue
    git(repoPath, ['init', '-b', 'main'])
    if (name === 'empty') continue
    await writeFile(path.join(repoPath, 'README.md'), `# ${name}\n`)
    git(repoPath, ['add', 'README.md'])
    git(repoPath, ['-c', 'user.name=Test Author', '-c', 'user.email=author@example.test', 'commit', '-m', `${name} repository`])
  }
  return repos
}

test('switches local Git repositories, scopes caches, and preserves the active repository on errors', async (t) => {
  const repos = await makeFixtures(t)
  const middleware = createApiMiddleware({ repoPath: repos.first })
  t.after(() => middleware.dispose())
  const first = await requestApi(middleware, '/api/repository?stats=false')
  assert.equal(first.status, 200)
  assert.equal(first.body.status, 'ready')
  assert.equal(typeof first.body.repositoryId, 'string')
  assert.equal(first.body.commits[0].stats, null)
  const oid = first.body.repo.headOid
  const scoped = await requestApi(middleware, `/api/commits/${oid}?repository=${first.body.repositoryId}&view=landscape`)
  assert.equal(scoped.status, 200)
  assert.match(scoped.headers.get('cache-control'), /immutable/)
  const unscoped = await requestApi(middleware, `/api/commits/${oid}?view=landscape`)
  assert.match(unscoped.headers.get('cache-control'), /no-store/)

  const second = await openRepository(middleware, repos.second)
  assert.equal(second.status, 200)
  assert.equal(second.body.repo.displayPath, repos.second)
  assert.equal(second.body.commits[0].subject, 'second repository')
  assert.equal(second.body.commits[0].stats, null)
  assert.notEqual(second.body.repositoryId, first.body.repositoryId)
  assert.equal(middleware.service.repoPath, repos.second)
  const stale = await requestApi(middleware, `/api/commits?repository=${first.body.repositoryId}`)
  assert.equal(stale.status, 409)
  assert.equal(stale.body.error.code, 'REPOSITORY_CHANGED')
  assert.match(stale.headers.get('cache-control'), /no-store/)

  for (const repoPath of [repos.invalid, path.join(repos.invalid, 'missing'), path.join(repos.second, 'README.md')]) {
    const failed = await openRepository(middleware, repoPath)
    assert.equal(failed.status, 400)
    const current = await requestApi(middleware, '/api/repository?stats=false')
    assert.equal(current.body.repositoryId, second.body.repositoryId)
    assert.equal(current.body.repo.displayPath, repos.second)
  }

  const empty = await openRepository(middleware, repos.empty)
  assert.equal(empty.status, 200)
  assert.equal(empty.body.status, 'empty')
  assert.equal(empty.body.displayPath, repos.empty)
  assert.notEqual(empty.body.repositoryId, second.body.repositoryId)
})

test('rejects cross-site writes, invalid bodies, and oversized repository requests', async (t) => {
  const repos = await makeFixtures(t)
  const middleware = createApiMiddleware({ repoPath: repos.first })
  t.after(() => middleware.dispose())
  const initial = await requestApi(middleware, '/api/repository?stats=false')
  const validBody = JSON.stringify({ path: repos.second })
  const cases = [
    { body: '{', status: 400, code: 'INVALID_JSON' },
    { body: '{}', status: 400, code: 'INVALID_REPOSITORY_PATH' },
    { body: '[]', status: 400, code: 'INVALID_REPOSITORY_PATH' },
    { body: '{"path":42}', status: 400, code: 'INVALID_REPOSITORY_PATH' },
    { body: '{"path":"   "}', status: 400, code: 'INVALID_REPOSITORY_PATH' },
    { body: JSON.stringify({ path: '\0' }), status: 400, code: 'INVALID_REPOSITORY_PATH' },
    { body: validBody, headers: { 'content-type': 'text/plain' }, status: 415, code: 'INVALID_CONTENT_TYPE' },
    { body: validBody, headers: { origin: 'https://unrelated.example' }, status: 403, code: 'INVALID_ORIGIN' },
    { body: validBody, headers: { origin: 'null' }, status: 403, code: 'INVALID_ORIGIN' },
    { body: validBody, headers: { 'sec-fetch-site': 'cross-site' }, status: 403, code: 'INVALID_ORIGIN' },
    { body: validBody, headers: { 'content-length': '20000' }, status: 413, code: 'BODY_TOO_LARGE' },
    { chunks: [Buffer.alloc(9000, 'x'), Buffer.alloc(9000, 'x')], status: 413, code: 'BODY_TOO_LARGE' },
  ]
  for (const { status, code, ...options } of cases) {
    const result = await requestApi(middleware, '/api/repository', {
      method: 'POST',
      ...options,
      headers: { 'content-type': 'application/json', ...options.headers },
    })
    assert.equal(result.status, status, code)
    assert.equal(result.body.error.code, code)
  }
  const refresh = await requestApi(middleware, '/api/refresh', {
    method: 'POST', headers: { origin: 'https://unrelated.example' },
  })
  assert.equal(refresh.status, 403)
  const current = await requestApi(middleware, '/api/repository?stats=false')
  assert.equal(current.body.repositoryId, initial.body.repositoryId)
})

test('forwards lightweight reads and rotates the repository identity after refresh', async (t) => {
  const calls = []
  const middleware = createApiMiddleware({ service: {
    getRepository: async (options) => { calls.push(['repository', options]); return { status: 'empty' } },
    getCommits: async (options) => { calls.push(['commits', options]); return { items: [] } },
    refresh: async (options) => { calls.push(['refresh', options]); return { status: 'empty' } },
  } })
  t.after(() => middleware.dispose())
  const initial = await requestApi(middleware, '/api/repository?stats=false')
  await requestApi(middleware, `/api/commits?stats=false&repository=${initial.body.repositoryId}`)
  const refreshed = await requestApi(middleware, `/api/refresh?stats=false&repository=${initial.body.repositoryId}`, { method: 'POST' })
  assert.equal(refreshed.status, 200)
  assert.notEqual(refreshed.body.repositoryId, initial.body.repositoryId)
  assert.deepEqual(calls, [
    ['repository', { includeStats: false }],
    ['commits', { offset: 0, limit: 128, ref: 'HEAD', includeStats: false }],
    ['refresh', { includeStats: false }],
  ])
  const stale = await requestApi(middleware, `/api/repository?repository=${initial.body.repositoryId}`)
  assert.equal(stale.status, 409)
})

test('keeps old service indexes alive until its in-flight request finishes', async (t) => {
  const repos = await makeFixtures(t)
  const started = deferred()
  const finish = deferred()
  const disposed = deferred()
  let disposeCount = 0
  const middleware = createApiMiddleware({ service: {
    getRepository: async () => ({ status: 'ready' }),
    getCommit: async () => { started.resolve(); return finish.promise },
    dispose: async () => { disposeCount += 1; disposed.resolve() },
  } })
  t.after(() => middleware.dispose())
  const initial = await requestApi(middleware, '/api/repository')
  const pending = requestApi(middleware, `/api/commits/abc?repository=${initial.body.repositoryId}`)
  await started.promise
  const switched = await openRepository(middleware, repos.empty)
  assert.equal(switched.status, 200)
  assert.equal(disposeCount, 0)
  finish.resolve({ oid: 'abc', source: 'previous repository' })
  const result = await pending
  assert.equal(result.status, 200)
  assert.equal(result.body.source, 'previous repository')
  await disposed.promise
  assert.equal(disposeCount, 1)
})

test('a slower superseded switch cannot overwrite the latest repository', async (t) => {
  const repos = await makeFixtures(t)
  const firstStarted = deferred()
  const firstLoaded = deferred()
  const secondStarted = deferred()
  const secondLoaded = deferred()
  const disposed = []
  const middleware = createApiMiddleware({
    service: { getRepository: async () => ({ status: 'empty' }), dispose: async () => { disposed.push('initial') } },
    serviceFactory: ({ repoPath }) => ({
      repoPath,
      getRepository: async () => {
        const first = repoPath === repos.first
        const started = first ? firstStarted : secondStarted
        const loaded = first ? firstLoaded : secondLoaded
        started.resolve()
        await loaded.promise
        return { status: 'empty', displayPath: repoPath }
      },
      dispose: async () => { disposed.push(repoPath) },
    }),
  })
  t.after(() => middleware.dispose())
  const first = openRepository(middleware, repos.first)
  await firstStarted.promise
  const second = openRepository(middleware, repos.second)
  await secondStarted.promise
  secondLoaded.resolve()
  const winner = await second
  assert.equal(winner.status, 200)
  firstLoaded.resolve()
  const superseded = await first
  assert.equal(superseded.status, 409)
  assert.equal(superseded.body.error.code, 'REPOSITORY_SWITCH_SUPERSEDED')
  assert.equal(middleware.service.repoPath, repos.second)
  assert.ok(disposed.includes('initial'))
  assert.ok(disposed.includes(repos.first))
  assert.ok(!disposed.includes(repos.second))
})

test('shutdown waits for a pending switch before disposing its service', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'palimpsest-api-close-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const started = deferred()
  const loaded = deferred()
  let candidateDisposed = false
  const middleware = createApiMiddleware({
    service: { getRepository: async () => ({ status: 'empty' }) },
    serviceFactory: () => ({
      getRepository: async () => { started.resolve(); await loaded.promise; return { status: 'empty' } },
      dispose: async () => { candidateDisposed = true },
    }),
  })
  const switching = openRepository(middleware, directory)
  await started.promise
  const closing = middleware.dispose()
  assert.equal(candidateDisposed, false)
  loaded.resolve()
  const result = await switching
  assert.equal(result.status, 409)
  await closing
  assert.equal(candidateDisposed, true)
  assert.equal((await requestApi(middleware, '/api/repository')).status, 503)
})

test('forced shutdown stops service work before waiting for request leases', async () => {
  const started = deferred()
  const stopped = deferred()
  let disposeCount = 0
  const middleware = createApiMiddleware({ service: {
    getRepository: async () => { started.resolve(); await stopped.promise; return { status: 'empty' } },
    dispose: async () => { disposeCount += 1; stopped.resolve() },
  } })
  const pending = requestApi(middleware, '/api/repository')
  await started.promise
  await middleware.dispose({ force: true })
  await pending
  assert.equal(disposeCount, 1)
})
