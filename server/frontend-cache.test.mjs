import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// Compile the same browser module with the project's compiler. Tests also run
// on supported Node versions that cannot execute TypeScript directly.
const root = fileURLToPath(new URL('..', import.meta.url))
const output = await mkdtemp(path.join(tmpdir(), 'palimpsest-cache-test-'))
let RequestCache
let MemoryCache
try {
  execFileSync(process.execPath, [
    path.join(root, 'node_modules/typescript/bin/tsc'),
    '--target', 'ES2022', '--module', 'ESNext', '--skipLibCheck',
    '--outDir', output, path.join(root, 'src/lib/request-cache.ts'),
  ], { cwd: output, stdio: 'pipe' })
  const source = await readFile(path.join(output, 'request-cache.js'), 'utf8')
  ;({ RequestCache, MemoryCache } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`))
} finally {
  await rm(output, { recursive: true, force: true })
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

function controlledLoader() {
  const started = []
  const requests = new Map()
  return {
    started,
    requests,
    load: (key) => (signal) => new Promise((resolve, reject) => {
      started.push(key)
      requests.set(key, { signal, resolve, reject })
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }),
  }
}

test('shared requests abort transport only after the last consumer leaves', async () => {
  const cache = new RequestCache(4)
  const io = controlledLoader()
  const first = new AbortController()
  const second = new AbortController()
  const a = cache.request('same', io.load('same'), first.signal)
  const b = cache.request('same', io.load('same'), second.signal)
  const aRejected = assert.rejects(a, { name: 'AbortError' })
  const bRejected = assert.rejects(b, { name: 'AbortError' })
  await tick()
  assert.deepEqual(io.started, ['same'])
  first.abort()
  await aRejected
  assert.equal(io.requests.get('same').signal.aborted, false)
  second.abort()
  await bRejected
  assert.equal(io.requests.get('same').signal.aborted, true)
})

test('background reads leave a foreground slot and cancelled queued reads never start', async () => {
  const cache = new RequestCache(4, 3, 2)
  const io = controlledLoader()
  const cancelled = new AbortController()
  const a = cache.request('a', io.load('a'), undefined, true)
  const b = cache.request('b', io.load('b'), undefined, true)
  const c = cache.request('c', io.load('c'), cancelled.signal, true)
  const rejected = assert.rejects(c, { name: 'AbortError' })
  const foreground = cache.request('foreground', io.load('foreground'))
  await tick()
  assert.deepEqual(io.started, ['a', 'b', 'foreground'])
  cancelled.abort()
  await rejected
  for (const key of ['a', 'b', 'foreground']) io.requests.get(key).resolve(key)
  assert.deepEqual(await Promise.all([a, b, foreground]), ['a', 'b', 'foreground'])
  await tick()
  assert.deepEqual(io.started, ['a', 'b', 'foreground'])
})

test('a queued prefetch is promoted ahead of other background work when selected', async () => {
  const cache = new RequestCache(4, 2, 1)
  const io = controlledLoader()
  const busy = cache.request('busy', io.load('busy'), undefined, true)
  const background = cache.request('background', io.load('background'), undefined, true)
  const prefetched = cache.request('target', io.load('target'), undefined, true)
  const selected = cache.request('target', io.load('target'))
  await tick()
  assert.deepEqual(io.started, ['busy', 'target'])
  io.requests.get('target').resolve('target')
  assert.deepEqual(await Promise.all([prefetched, selected]), ['target', 'target'])
  io.requests.get('busy').resolve('busy')
  await busy
  await tick()
  io.requests.get('background').resolve('background')
  await background
})

test('clearing a repository prevents old responses from repopulating its cache', async () => {
  const cache = new RequestCache(2)
  let resolveOld
  const old = cache.request('same', () => new Promise((resolve) => { resolveOld = resolve }))
  const rejected = assert.rejects(old, { name: 'AbortError' })
  await tick()
  cache.clear()
  await rejected
  assert.equal(await cache.request('same', async () => 'new repository'), 'new repository')
  resolveOld('old repository')
  await tick()
  assert.equal(cache.read('same'), 'new repository')
  cache.write('other', 2)
  cache.read('same')
  cache.write('last', 3)
  assert.equal(cache.read('other'), undefined)
  assert.equal(cache.read('same'), 'new repository')
})

test('byte budgets evict least-recent values and do not retain oversized responses', () => {
  const cache = new MemoryCache(100, 1000)
  cache.set('a', 'a'.repeat(180))
  cache.set('b', 'b'.repeat(180))
  assert.ok(cache.bytes <= 1000)
  cache.get('a')
  cache.set('c', 'c'.repeat(180))
  assert.equal(cache.has('a'), true)
  assert.equal(cache.has('b'), false)
  assert.equal(cache.has('c'), true)
  cache.set('huge', 'x'.repeat(10000))
  assert.equal(cache.has('huge'), false)
  cache.delete('a')
  assert.ok(cache.bytes > 0 && cache.bytes < 1000)
  cache.clear()
  assert.equal(cache.bytes, 0)
  assert.equal(cache.size, 0)
})
