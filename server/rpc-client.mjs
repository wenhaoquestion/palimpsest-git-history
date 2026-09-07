import { execFile, fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const MAX_PENDING = 14
const failure = (status, code, message) => ({ status, body: { message, error: { code, message } } })
const abortError = () => Object.assign(new Error('The repository request was cancelled.'), { name: 'AbortError' })
const bounded = (value, fallback, minimum, maximum) => Number.isFinite(Number(value))
  ? Math.min(maximum, Math.max(minimum, Math.trunc(Number(value)))) : fallback

function signalProcessTree(child, signal) {
  if (!child.pid) return
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal)
    else {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {
        try { child.kill('SIGKILL') } catch { /* Already exited. */ }
      })
    }
  } catch {
    try { child.kill(signal) } catch { /* Already exited. */ }
  }
}

/**
 * Lazily owns an isolated Git backend. Importing this module never loads Git
 * service caches into the VS Code extension host and never opens a TCP port.
 */
export function createRpcClient({
  repoPath = process.cwd(),
  workerPath = fileURLToPath(new URL('./rpc-worker.mjs', import.meta.url)),
  maxHeapMb = 384,
  requestTimeoutMs = 120_000,
} = {}) {
  const heapMb = bounded(maxHeapMb, 384, 128, 2048)
  const timeoutMs = bounded(requestTimeoutMs, 120_000, 100, 300_000)
  let runtime
  let disposed = false
  let disposal

  function settle(current, entry, result, error) {
    clearTimeout(entry.timer)
    entry.signal?.removeEventListener('abort', entry.onAbort)
    if (entry.settled) return
    entry.settled = true
    if (error) entry.reject(error)
    else entry.resolve(result)
  }

  function settleAll(current, result) {
    for (const entry of current.pending.values()) settle(current, entry, result)
    current.pending.clear()
  }

  function send(current, message) {
    if (!current.child.connected) return false
    try {
      current.child.send(message, (error) => {
        if (error && !current.stopping) {
          void stop(current, failure(503, 'WORKER_DISCONNECTED', 'The repository backend disconnected. Retry to restart it.'))
        }
      })
      return true
    } catch {
      return false
    }
  }

  function stop(current, result, graceful = false) {
    if (current.stopping) return current.exited
    current.stopping = true
    settleAll(current, result)
    if (graceful) send(current, { type: 'palimpsest:dispose' })
    else signalProcessTree(current.child, 'SIGTERM')
    current.termTimer = graceful ? setTimeout(() => signalProcessTree(current.child, 'SIGTERM'), 750) : undefined
    current.killTimer = setTimeout(() => signalProcessTree(current.child, 'SIGKILL'), graceful ? 1250 : 500)
    current.termTimer?.unref()
    current.killTimer.unref()
    return current.exited
  }

  function start() {
    if (runtime) return runtime
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    // An inherited debugger or loader can open ports or defeat the worker's
    // bounded runtime. Explicit fork arguments define this process instead.
    delete env.NODE_OPTIONS
    const child = fork(workerPath, [repoPath, String(timeoutMs)], {
      // Do not inherit inspector, loaders, --eval, or extension-host flags.
      execArgv: [`--max-old-space-size=${heapMb}`],
      env,
      detached: process.platform !== 'win32',
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    })
    let resolveExit
    const current = {
      child, pending: new Map(), stopping: false,
      exited: new Promise((resolve) => { resolveExit = resolve }),
    }
    runtime = current
    const onExit = () => {
      if (current.didExit) return
      current.didExit = true
      clearTimeout(current.termTimer)
      clearTimeout(current.killTimer)
      // A crash/OOM can leave Git descendants behind even after Node exits.
      signalProcessTree(child, 'SIGKILL')
      settleAll(current, failure(503, 'WORKER_EXITED', 'The repository backend exited. Retry to restart it.'))
      if (runtime === current) runtime = undefined
      resolveExit()
    }
    child.once('exit', onExit)
    child.once('error', () => {
      if (!child.pid) onExit()
      else void stop(current, failure(503, 'WORKER_ERROR', 'The repository backend could not run.'))
    })
    child.once('disconnect', () => {
      if (!current.didExit) void stop(current, failure(503, 'WORKER_DISCONNECTED', 'The repository backend disconnected. Retry to restart it.'))
    })
    child.on('message', (message) => {
      if (message?.type !== 'palimpsest:response' || typeof message.id !== 'string') return
      const entry = current.pending.get(message.id)
      if (!entry) return
      current.pending.delete(message.id)
      if (!Number.isInteger(message.status) || message.status < 100 || message.status > 599) {
        settle(current, entry, failure(502, 'INVALID_RESPONSE', 'The repository backend returned an invalid response.'))
        return
      }
      settle(current, entry, { status: message.status, body: message.body })
    })
    return current
  }

  function request({ url, method = 'GET', body } = {}, signal) {
    if (signal?.aborted) return Promise.reject(abortError())
    if (disposed) return Promise.resolve(failure(503, 'WORKER_CLOSED', 'The repository backend is closed.'))
    if (typeof url !== 'string' || !url.startsWith('/api/') || url.length > 8192 || /[\0\r\n]/.test(url)
      || !['GET', 'POST'].includes(method) || (body !== undefined && typeof body !== 'string')) {
      return Promise.resolve(failure(400, 'INVALID_REQUEST', 'Provide a local API URL, GET or POST method, and an optional string body.'))
    }
    if (body && Buffer.byteLength(body) > 16 * 1024) {
      return Promise.resolve(failure(413, 'BODY_TOO_LARGE', 'The repository request body is too large.'))
    }
    let current
    try { current = start() } catch {
      return Promise.resolve(failure(503, 'WORKER_ERROR', 'The repository backend could not start.'))
    }
    if (current.stopping) {
      return Promise.resolve(failure(503, 'WORKER_RESTARTING', 'The repository backend is restarting. Retry shortly.'))
    }
    const background = new URL(url, 'http://localhost').searchParams.get('priority') === 'background'
    if (current.pending.size >= MAX_PENDING) {
      const evicted = !background && [...current.pending.values()].find((entry) => entry.background)
      if (!evicted) return Promise.resolve(failure(503, 'RPC_BUSY', 'The repository backend is busy. Retry after the current request completes.'))
      current.pending.delete(evicted.id)
      settle(current, evicted, failure(503, 'RPC_PREEMPTED', 'A foreground request replaced this background request.'))
      send(current, { type: 'palimpsest:cancel', id: evicted.id })
    }
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const entry = { id, resolve, reject, signal, background, settled: false }
      entry.onAbort = () => {
        settle(current, entry, undefined, abortError())
        // Keep a bounded tombstone until the cancellation acknowledgement.
        // The worker retains a running job's slot until shared Git work ends.
        if (!send(current, { type: 'palimpsest:cancel', id })) current.pending.delete(id)
        else {
          entry.timer = setTimeout(() => {
            void stop(current, failure(503, 'WORKER_RESTARTING', 'The repository backend did not acknowledge cancellation.'))
          }, timeoutMs)
          entry.timer.unref()
        }
      }
      entry.timer = setTimeout(() => {
        settle(current, entry, failure(504, 'RPC_TIMEOUT', 'The repository request timed out. The backend will restart.'))
        void stop(current, failure(503, 'WORKER_RESTARTING', 'The repository backend is restarting after a timeout.'))
      }, timeoutMs)
      entry.timer.unref()
      current.pending.set(id, entry)
      signal?.addEventListener('abort', entry.onAbort, { once: true })
      if (!send(current, { type: 'palimpsest:request', id, url, method, body })) {
        void stop(current, failure(503, 'WORKER_DISCONNECTED', 'The repository backend disconnected. Retry to restart it.'))
      }
    })
  }

  function dispose() {
    if (disposal) return disposal
    disposed = true
    disposal = runtime
      ? stop(runtime, failure(503, 'WORKER_CLOSED', 'The repository backend is closed.'), true)
      : Promise.resolve()
    return disposal
  }

  return { request, dispose }
}
