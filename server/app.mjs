import { createReadStream } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createApiMiddleware } from './api-middleware.mjs'

const CONTENT_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
})

function isInside(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function sendText(response, statusCode, message, method) {
  response.statusCode = statusCode
  response.setHeader('Content-Type', 'text/plain; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Content-Length', Buffer.byteLength(message))
  if (method === 'HEAD') response.end()
  else response.end(message)
}

async function findStaticFile(distPath, request) {
  const url = new URL(request.url || '/', 'http://localhost')
  let pathname
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return { error: 400 }
  }
  if (pathname.includes('\0')) return { error: 400 }

  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^[/\\]+/, '')
  const candidate = path.resolve(distPath, relative)
  if (!isInside(distPath, candidate)) return { error: 403 }

  try {
    const info = await stat(candidate)
    if (info.isFile()) return { filePath: candidate, info }
  } catch {
    // The SPA fallback below handles extensionless application routes.
  }

  const acceptsHtml = String(request.headers.accept || '').includes('text/html')
  if ((acceptsHtml || path.extname(relative) === '') && request.method !== 'POST') {
    const indexPath = path.join(distPath, 'index.html')
    try {
      const info = await stat(indexPath)
      if (info.isFile()) return { filePath: indexPath, info }
    } catch {
      return { error: 503 }
    }
  }
  return { error: 404 }
}

async function serveStatic(distPath, request, response) {
  const method = (request.method || 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    sendText(response, 405, 'Method not allowed.', method)
    return
  }

  const result = await findStaticFile(distPath, request)
  if (!result.filePath) {
    const messages = {
      400: 'Invalid request path.',
      403: 'Request path is outside the application.',
      404: 'Not found.',
      503: 'The production build is missing. Run npm run build first.',
    }
    sendText(response, result.error, messages[result.error] || 'Request failed.', method)
    return
  }

  const extension = path.extname(result.filePath).toLowerCase()
  response.statusCode = 200
  response.setHeader('Content-Type', CONTENT_TYPES[extension] || 'application/octet-stream')
  response.setHeader('Content-Length', result.info.size)
  response.setHeader('X-Content-Type-Options', 'nosniff')
  const isIndex = path.basename(result.filePath) === 'index.html'
  response.setHeader('Cache-Control', isIndex
    ? 'no-cache, max-age=0'
    : /[.-][0-9a-f]{8,}[.-]/i.test(path.basename(result.filePath))
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=3600')
  if (method === 'HEAD') {
    response.end()
    return
  }

  const stream = createReadStream(result.filePath)
  stream.on('error', () => {
    if (!response.headersSent) sendText(response, 500, 'Unable to read the application asset.', method)
    else response.destroy()
  })
  stream.pipe(response)
}

export function createAppServer({
  repoPath = process.env.PALIMPSEST_REPO || process.cwd(),
  distPath = path.resolve(process.cwd(), 'dist'),
  service,
  readOnly = false,
  publicRepository,
  allowedRefs,
  maxApiRequests = Infinity,
} = {}) {
  const resolvedDist = path.resolve(distPath)
  const api = createApiMiddleware({ repoPath, service, readOnly, publicRepository, allowedRefs })
  let activeRequests = 0
  const server = createServer((request, response) => {
    let completeRequest = () => {}
    let apiRequest = false
    try { apiRequest = new URL(request.url || '/', 'http://localhost').pathname.startsWith('/api/') } catch {}
    if (apiRequest) {
      if (activeRequests >= maxApiRequests) {
        response.setHeader('Retry-After', '1')
        response.setHeader('Content-Type', 'application/json; charset=utf-8')
        response.writeHead(503)
        response.end(JSON.stringify({ error: { code: 'SERVER_BUSY', message: 'History is busy. Retry shortly.' } }))
        return
      }
      activeRequests += 1
      let released = false
      let workComplete = false
      let responseComplete = false
      const release = () => {
        if (!released && workComplete && responseComplete) { released = true; activeRequests -= 1 }
      }
      completeRequest = () => { workComplete = true; release() }
      const completeResponse = () => { responseComplete = true; release() }
      response.once('finish', completeResponse)
      response.once('close', completeResponse)
    }
    void Promise.resolve(api(request, response, () => {
      void serveStatic(resolvedDist, request, response).catch(() => {
        if (!response.writableEnded) sendText(response, 500, 'The request could not be completed.', request.method)
      })
    })).finally(completeRequest)
  })
  server.dispose = () => api.dispose({ force: true })
  server.once('close', () => { void api.dispose() })
  return server
}

async function start() {
  const host = process.env.HOST || '127.0.0.1'
  const port = Number(process.env.PORT || 4173)
  const distPath = path.resolve(process.cwd(), 'dist')
  await access(distPath).catch(() => undefined)
  const server = createAppServer({ repoPath: process.env.PALIMPSEST_REPO || process.cwd(), distPath })
  server.listen(port, host, () => {
    console.log(`Palimpsest is available at http://${host}:${port}`)
  })
}

const isEntryPoint = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url

if (isEntryPoint) {
  start().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
