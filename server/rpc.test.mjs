import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { access, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { API_JSON_RESPONSE } from './api-middleware.mjs'
import { createRpcClient } from './rpc-client.mjs'
import { createRpcWorker } from './rpc-worker.mjs'

async function fixtureDirectory(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'palimpsest-rpc-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function makeWorker(t) {
  const directory = await fixtureDirectory(t)
  const workerPath = path.join(directory, 'fixture-worker.mjs')
  await writeFile(workerPath, `
import { writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import v8 from 'node:v8'
writeFileSync(path.join(process.argv[2], 'started'), String(process.pid))
process.on('message', (message) => {
  if (message.type === 'palimpsest:cancel') {
    process.send({ type: 'palimpsest:response', id: message.id, status: 499, body: {} })
    return
  }
  if (message.type !== 'palimpsest:request') return
  if (message.url === '/api/crash') process.exit(7)
  if (message.url.startsWith('/api/hang')) return
  let descendant
  if (message.url === '/api/descendant') {
    descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  }
  process.send({ type: 'palimpsest:response', id: message.id, status: 200, body: {
    pid: process.pid, descendant: descendant?.pid, args: process.execArgv,
    heapLimit: v8.getHeapStatistics().heap_size_limit,
    electronNode: process.env.ELECTRON_RUN_AS_NODE,
  } })
})
`)
  return { directory, workerPath }
}

function schedulerFixture(t) {
  const started = []
  const active = new Map()
  const replies = []
  let maxActive = 0
  const api = (request, response) => {
    const id = new URL(request.url, 'http://localhost').pathname.split('/').at(-1)
    started.push(id)
    active.set(id, response)
    maxActive = Math.max(maxActive, active.size)
  }
  const finish = (id) => {
    const response = active.get(id)
    active.delete(id)
    response[API_JSON_RESPONSE](200, { id })
  }
  api.dispose = async () => { for (const id of active.keys()) finish(id) }
  const worker = createRpcWorker({ api, send: (message) => { replies.push(message) } })
  t.after(() => worker.dispose())
  const send = (id, background = false) => worker.onMessage({
    type: 'palimpsest:request', id,
    url: `/api/commits/${id}${background ? '?priority=background' : ''}`,
  })
  return { worker, started, active, replies, finish, send, get maxActive() { return maxActive } }
}

async function requestAfterRestart(client) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await client.request({ url: '/api/id' })
    if (response.body?.error?.code !== 'WORKER_RESTARTING') return response
    await delay(10)
  }
  assert.fail('Worker did not restart within one second')
}

async function assertProcessExited(pid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { process.kill(pid, 0) } catch (error) {
      if (error.code === 'ESRCH') return
      throw error
    }
    await delay(10)
  }
  assert.fail(`Process ${pid} survived backend disposal`)
}

test('RPC reuses repository routes, lightweight payloads, switches, and session isolation without HTTP', async (t) => {
  const repoPath = await fixtureDirectory(t)
  const git = (args) => execFileSync('git', args, { cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'] })
  git(['init', '-b', 'main'])
  await writeFile(path.join(repoPath, 'README.md'), '# RPC repository\n')
  git(['add', 'README.md'])
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'RPC commit'])
  const emptyPath = path.join(repoPath, 'empty')
  await mkdir(emptyPath)
  execFileSync('git', ['init', '-b', 'main'], { cwd: emptyPath, stdio: 'ignore' })
  const client = createRpcClient({ repoPath })
  t.after(() => client.dispose())
  const first = await client.request({ url: '/api/repository?stats=false' })
  assert.equal(first.status, 200)
  assert.equal(first.body.commits[0].subject, 'RPC commit')
  assert.equal(first.body.commits[0].stats, null)
  const oid = first.body.repo.headOid
  const landscape = await client.request({ url: `/api/commits/${oid}?view=landscape&repository=${first.body.repositoryId}` })
  assert.equal(landscape.status, 200)
  assert.equal(landscape.body.landscape.totalFiles, 1)
  const switched = await client.request({ url: '/api/repository', method: 'POST', body: JSON.stringify({ path: emptyPath }) })
  assert.equal(switched.status, 200)
  assert.equal(switched.body.status, 'empty')
  assert.notEqual(switched.body.repositoryId, first.body.repositoryId)
  assert.equal((await client.request({ url: `/api/commits?repository=${first.body.repositoryId}` })).status, 409)
})

test('client forks lazily with a bounded heap and releases its backend on disposal', async (t) => {
  const fixture = await makeWorker(t)
  const unused = createRpcClient({ repoPath: fixture.directory, workerPath: fixture.workerPath })
  await unused.dispose()
  await assert.rejects(access(path.join(fixture.directory, 'started')), { code: 'ENOENT' })
  const client = createRpcClient({ repoPath: fixture.directory, workerPath: fixture.workerPath, maxHeapMb: 1 })
  t.after(() => client.dispose())
  const result = await client.request({ url: '/api/id' })
  assert.equal(result.status, 200)
  assert.notEqual(result.body.pid, process.pid)
  assert.ok(result.body.args.includes('--max-old-space-size=128'))
  assert.ok(result.body.heapLimit < 256 * 1024 * 1024)
  assert.equal(result.body.electronNode, '1')
  await client.dispose()
  await assertProcessExited(result.body.pid)
  assert.equal((await client.request({ url: '/api/id' })).body.error.code, 'WORKER_CLOSED')
})

test('worker reserves foreground capacity, cancels queued work, and retains cancelled running slots', async (t) => {
  const fixture = schedulerFixture(t)
  fixture.send('background-one', true)
  fixture.send('background-two', true)
  fixture.send('foreground-one')
  fixture.send('foreground-two')
  assert.deepEqual(fixture.started, ['background-one', 'foreground-one'])
  fixture.worker.onMessage({ type: 'palimpsest:cancel', id: 'background-two' })
  fixture.worker.onMessage({ type: 'palimpsest:cancel', id: 'background-one' })
  assert.equal(fixture.replies.filter((message) => message.status === 499).length, 2)
  assert.equal(fixture.active.size, 2)
  fixture.finish('background-one')
  await nextTurn()
  assert.deepEqual(fixture.started, ['background-one', 'foreground-one', 'foreground-two'])
  fixture.finish('foreground-one')
  fixture.finish('foreground-two')
  await nextTurn()
  assert.equal(fixture.replies.filter((message) => message.id === 'background-one').length, 1)
  assert.equal(fixture.maxActive, 2)
})

test('worker bounds its queue and replaces queued background work with foreground requests', async (t) => {
  const fixture = schedulerFixture(t)
  fixture.send('running-one')
  fixture.send('running-two')
  for (let index = 0; index < 12; index += 1) fixture.send(`background-${index}`, true)
  fixture.send('excess-background', true)
  assert.equal(fixture.replies.find((message) => message.id === 'excess-background').status, 503)
  fixture.send('foreground-next')
  assert.equal(fixture.replies.find((message) => message.id === 'background-0').body.error.code, 'RPC_PREEMPTED')
  fixture.finish('running-one')
  await nextTurn()
  assert.equal(fixture.started.at(-1), 'foreground-next')
  assert.equal(fixture.maxActive, 2)
})

test('client bounds pending messages and lets foreground work replace background requests', async (t) => {
  const fixture = await makeWorker(t)
  const client = createRpcClient({ repoPath: fixture.directory, workerPath: fixture.workerPath })
  t.after(() => client.dispose())
  await client.request({ url: '/api/id' })
  const controllers = Array.from({ length: 14 }, () => new AbortController())
  const pending = controllers.map((controller, index) => client.request({ url: `/api/hang?priority=background&i=${index}` }, controller.signal))
  const results = Promise.allSettled(pending)
  const excess = await client.request({ url: '/api/hang?priority=background' })
  assert.equal(excess.status, 503)
  assert.equal(excess.body.error.code, 'RPC_BUSY')
  const foreground = await client.request({ url: '/api/id' })
  assert.equal(foreground.status, 200)
  controllers.forEach((controller) => controller.abort())
  const settled = await results
  assert.equal(settled.filter((entry) => entry.status === 'rejected' && entry.reason.name === 'AbortError').length, 13)
  assert.equal(settled.filter((entry) => entry.status === 'fulfilled' && entry.value.body.error.code === 'RPC_PREEMPTED').length, 1)
})

test('client restarts after a crash and terminates a timed-out backend', async (t) => {
  const fixture = await makeWorker(t)
  const client = createRpcClient({ repoPath: fixture.directory, workerPath: fixture.workerPath, requestTimeoutMs: 250 })
  t.after(() => client.dispose())
  const first = await client.request({ url: '/api/id' })
  assert.equal((await client.request({ url: '/api/crash' })).status, 503)
  const restarted = await requestAfterRestart(client)
  assert.equal(restarted.status, 200)
  assert.notEqual(restarted.body.pid, first.body.pid)
  const timedOut = await client.request({ url: '/api/hang' })
  assert.equal(timedOut.status, 504)
  assert.equal(timedOut.body.error.code, 'RPC_TIMEOUT')
  const recovered = await requestAfterRestart(client)
  assert.equal(recovered.status, 200)
  assert.notEqual(recovered.body.pid, restarted.body.pid)
  await assertProcessExited(restarted.body.pid)
})

test('disposal releases backend descendants even when the worker ignores graceful shutdown', async (t) => {
  const fixture = await makeWorker(t)
  const client = createRpcClient({ repoPath: fixture.directory, workerPath: fixture.workerPath })
  t.after(() => client.dispose())
  const result = await client.request({ url: '/api/descendant' })
  assert.equal(result.status, 200)
  assert.ok(result.body.descendant > 0)
  await client.dispose()
  await assertProcessExited(result.body.pid)
  await assertProcessExited(result.body.descendant)
})
