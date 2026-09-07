import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = await mkdtemp(path.join(tmpdir(), 'palimpsest-host-test-'))
let source
try {
  execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'),
    '--target', 'ES2022', '--module', 'ESNext', '--skipLibCheck', '--outDir', output,
    path.join(root, 'src/lib/host.ts'),
  ], { cwd: output, stdio: 'pipe' })
  source = await readFile(path.join(output, 'host.js'), 'utf8')
} finally {
  await rm(output, { recursive: true, force: true })
}

async function fixture(t, savedState) {
  const original = globalThis.window
  const listeners = []
  const messages = []
  const timers = new Map()
  let timerSequence = 0
  let state = savedState
  const window = {
    acquireVsCodeApi: () => ({ postMessage: (message) => messages.push(message), getState: () => state, setState: (value) => { state = value } }),
    addEventListener: (type, listener) => { if (type === 'message') listeners.push(listener) },
    setTimeout: (callback, delay) => { const id = ++timerSequence; timers.set(id, { callback, delay }); return id },
    clearTimeout: (id) => timers.delete(id),
  }
  globalThis.window = window
  t.after(() => { if (original === undefined) delete globalThis.window; else globalThis.window = original })
  // Each simulated webview has an independent request table and session ID.
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(`${source}\n// ${randomUUID()}`).toString('base64')}`)
  return {
    runtime, messages, timers,
    state: () => state,
    emit: (message) => { for (const listener of listeners) listener({ data: message }) },
    requests: () => messages.filter((message) => message.type === 'palimpsest:request'),
    cancellations: () => messages.filter((message) => message.type === 'palimpsest:cancel'),
  }
}

test('hiding a webview cancels reads while preserving an in-flight Git write and its success response', async (t) => {
  const app = await fixture(t)
  const reading = app.runtime.hostRequest('/api/workspace')
  const readRejected = assert.rejects(reading, { name: 'AbortError' })
  let writeSettled = false
  const writing = app.runtime.hostRequest('/api/workspace/commit?repository=before', { method: 'POST', body: '{"message":"Save changes"}' })
    .then((result) => { writeSettled = true; return result })
  const [read, write] = app.requests()
  app.emit({ type: 'palimpsest:visibility', visible: false })
  await readRejected
  assert.equal(writeSettled, false)
  assert.deepEqual(app.cancellations().map((message) => message.id), [read.id])
  assert.equal(app.timers.size, 1, 'The write retains its timeout while the read releases its timer')
  app.emit({ type: 'palimpsest:visibility', visible: false })
  app.emit({ type: 'palimpsest:response', id: read.id, status: 200, body: { stale: true } })
  const body = { repositoryId: 'after', repositoryChanged: true, message: 'Commit created.' }
  app.emit({ type: 'palimpsest:response', id: write.id, status: 200, body })
  assert.deepEqual(await writing, { status: 200, body })
  assert.equal(app.timers.size, 0)
  assert.equal(app.requests().length, 2, 'Hiding and late read responses must not retry a write')
})

test('all workbench mutations survive visibility changes, including query-scoped remote operations', async (t) => {
  const app = await fixture(t)
  for (const action of ['stage', 'unstage', 'commit', 'branch', 'checkout', 'fetch', 'pull', 'push']) {
    const result = app.runtime.hostRequest(`/api/workspace/${action}?repository=session`, { method: 'POST', body: '{}' })
    const request = app.requests().at(-1)
    app.emit({ type: 'palimpsest:visibility', visible: false })
    app.emit({ type: 'palimpsest:visibility', visible: true })
    app.emit({ type: 'palimpsest:response', id: request.id, status: 200, body: { action } })
    assert.deepEqual((await result).body, { action })
  }
  assert.equal(app.cancellations().length, 0)
  assert.equal(app.requests().length, 8)
  assert.equal(app.timers.size, 0)
})

test('a timed-out mutation settles once, ignores late success, and never retries automatically', async (t) => {
  const app = await fixture(t)
  const result = app.runtime.hostRequest('/api/workspace/push', { method: 'POST', body: '{"remote":"origin"}' })
  const rejected = assert.rejects(result, /timed out/i)
  const request = app.requests()[0]
  const timer = [...app.timers.values()][0]
  assert.equal(timer.delay, 120_000)
  timer.callback()
  await rejected
  assert.equal(app.timers.size, 0)
  assert.deepEqual(app.cancellations().map((message) => message.id), [request.id])
  app.emit({ type: 'palimpsest:response', id: request.id, status: 200, body: { message: 'Changes pushed.' } })
  app.emit({ type: 'palimpsest:visibility', visible: true })
  await Promise.resolve()
  assert.equal(app.requests().length, 1)
})

test('read aborts release listeners and timers and cannot cancel a later request', async (t) => {
  const app = await fixture(t)
  const controller = new AbortController()
  const first = app.runtime.hostRequest('/api/workspace/diff?path=first', { signal: controller.signal })
  const rejected = assert.rejects(first, { name: 'AbortError' })
  controller.abort()
  await rejected
  assert.equal(app.timers.size, 0)
  const second = app.runtime.hostRequest('/api/workspace/diff?path=second')
  const request = app.requests()[1]
  app.emit({ type: 'palimpsest:response', id: request.id, status: 200, body: { patch: 'second' } })
  assert.deepEqual((await second).body, { patch: 'second' })
  assert.equal(app.cancellations().length, 1)
})

test('surface and commit draft persistence preserve history position across webview reload state', async (t) => {
  const app = await fixture(t, { repoPath: '/repository', scope: 'main', index: 1024 })
  app.runtime.saveSurface('workspace')
  app.runtime.saveWorkbench({ repoPath: '/repository', message: 'A draft that is not yet committed' })
  app.runtime.saveView({ repoPath: '/repository', scope: 'main', index: 2048 })
  assert.equal(app.runtime.readSavedSurface(), 'workspace')
  assert.equal(app.runtime.readSavedView().index, 2048)
  assert.equal(app.runtime.readSavedWorkbench().message, 'A draft that is not yet committed')
  assert.equal(app.state().workbench.repoPath, '/repository')
  app.runtime.signalHostReady()
  assert.deepEqual(app.messages.at(-1), { type: 'palimpsest:ready' })
})
