import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { API_JSON_RESPONSE, createApiMiddleware } from './api-middleware.mjs'

const MAX_RUNNING = 2
const MAX_QUEUED = 12
const MAX_BODY_BYTES = 16 * 1024

const failure = (code, message) => ({ message, error: { code, message } })

function invokeApi(api, message) {
  return new Promise((resolve) => {
    const request = Readable.from(message.body ? [Buffer.from(message.body)] : [])
    request.url = message.url
    request.method = message.method || 'GET'
    request.headers = { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json' }
    request.socket = { encrypted: false }
    const response = {
      writableEnded: false,
      [API_JSON_RESPONSE](status, body) {
        if (this.writableEnded) return
        this.writableEnded = true
        resolve({ status, body })
      },
    }
    api(request, response, () => response[API_JSON_RESPONSE](404, failure('NOT_FOUND', 'API endpoint not found.')))
  })
}

/** A bounded scheduler shared by the forked worker and transport tests. */
export function createRpcWorker({
  repoPath,
  api = createApiMiddleware({ repoPath }),
  send,
  timeoutMs = 120_000,
  onFatal = () => {},
} = {}) {
  const queue = []
  const jobs = new Map()
  const running = new Set()
  let runningBackground = 0
  let stopped = false
  let disposal

  async function reply(job, status, body) {
    if (job.replied) return
    job.replied = true
    try { await send({ type: 'palimpsest:response', id: job.id, status, body }) } catch { /* IPC disconnected. */ }
  }

  function pump() {
    while (!stopped && running.size < MAX_RUNNING) {
      let index = queue.findIndex((job) => !job.background)
      if (index < 0 && runningBackground < 1 && queue.length) index = 0
      if (index < 0) return
      const [job] = queue.splice(index, 1)
      running.add(job)
      if (job.background) runningBackground += 1
      job.timer = setTimeout(() => {
        void reply(job, 504, failure('RPC_TIMEOUT', 'The repository request timed out. The backend will restart.'))
        onFatal()
      }, timeoutMs)
      job.timer.unref?.()
      job.promise = (async () => {
        try {
          const result = await invokeApi(api, job)
          if (!job.cancelled && !stopped) await reply(job, result.status, result.body)
        } catch {
          if (!job.cancelled && !stopped) await reply(job, 500, failure('RPC_ERROR', 'The repository request failed.'))
        } finally {
          clearTimeout(job.timer)
          jobs.delete(job.id)
          running.delete(job)
          if (job.background) runningBackground -= 1
          pump()
        }
      })()
    }
  }

  function onMessage(message) {
    if (!message || typeof message.id !== 'string' || !message.id || message.id.length > 128) return
    if (message.type === 'palimpsest:cancel') {
      const job = jobs.get(message.id)
      if (!job) return
      job.cancelled = true
      void reply(job, 499, failure('RPC_CANCELLED', 'The repository request was cancelled.'))
      const index = queue.indexOf(job)
      if (index >= 0) {
        queue.splice(index, 1)
        jobs.delete(job.id)
      }
      return
    }
    if (message.type !== 'palimpsest:request') return
    const rejected = (status, code, text) => { void reply({ id: message.id }, status, failure(code, text)) }
    if (stopped) return rejected(503, 'WORKER_CLOSED', 'The repository backend is closed.')
    if (jobs.has(message.id)) return rejected(400, 'DUPLICATE_REQUEST', 'Request identifiers must be unique.')
    if (typeof message.url !== 'string' || !message.url.startsWith('/api/') || message.url.length > 8192
      || /[\0\r\n]/.test(message.url) || !['GET', 'POST'].includes(message.method || 'GET')
      || (message.body !== undefined && typeof message.body !== 'string')) {
      return rejected(400, 'INVALID_REQUEST', 'Provide a local API URL, GET or POST method, and an optional string body.')
    }
    if (message.body && Buffer.byteLength(message.body) > MAX_BODY_BYTES) {
      return rejected(413, 'BODY_TOO_LARGE', 'The repository request body is too large.')
    }
    const background = new URL(message.url, 'http://localhost').searchParams.get('priority') === 'background'
    if (queue.length >= MAX_QUEUED) {
      const index = background ? -1 : queue.findIndex((job) => job.background)
      if (index < 0) return rejected(503, 'RPC_BUSY', 'The repository backend is busy. Retry after the current request completes.')
      const [evicted] = queue.splice(index, 1)
      jobs.delete(evicted.id)
      void reply(evicted, 503, failure('RPC_PREEMPTED', 'A foreground request replaced this background request.'))
    }
    const job = { id: message.id, url: message.url, method: message.method, body: message.body, background }
    jobs.set(job.id, job)
    queue.push(job)
    pump()
  }

  function dispose() {
    if (disposal) return disposal
    stopped = true
    for (const job of queue.splice(0)) {
      jobs.delete(job.id)
      void reply(job, 503, failure('WORKER_CLOSED', 'The repository backend is closed.'))
    }
    for (const job of running) {
      job.cancelled = true
      clearTimeout(job.timer)
    }
    disposal = Promise.resolve(api.dispose({ force: true }))
      .then(() => Promise.allSettled([...running].map((job) => job.promise)))
    return disposal
  }

  return { onMessage, dispose }
}

const isEntryPoint = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (isEntryPoint && process.send) {
  let shuttingDown = false
  const send = (message) => new Promise((resolve) => {
    if (!process.connected) return resolve()
    process.send(message, () => resolve())
  })
  const worker = createRpcWorker({
    repoPath: process.argv[2],
    timeoutMs: Number(process.argv[3]) || 120_000,
    send,
    onFatal: () => { void shutdown(1) },
  })
  async function shutdown(code) {
    if (shuttingDown) return
    shuttingDown = true
    const forcedExit = setTimeout(() => process.exit(code || 1), 1000)
    forcedExit.unref()
    try { await worker.dispose() } finally {
      clearTimeout(forcedExit)
      process.exit(code)
    }
  }
  process.on('message', (message) => {
    if (message?.type === 'palimpsest:dispose') void shutdown(0)
    else worker.onMessage(message)
  })
  process.once('disconnect', () => { void shutdown(0) })
  process.once('SIGTERM', () => { void shutdown(0) })
  process.once('SIGINT', () => { void shutdown(0) })
}
