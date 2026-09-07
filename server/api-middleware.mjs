import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { createGitService, GitServiceError } from './git-service.mjs'

const MAX_REPOSITORY_BODY_BYTES = 16 * 1024
// The IPC transport consumes structured payloads directly, avoiding a second
// stringify/parse copy of large trees inside the backend process.
export const API_JSON_RESPONSE = Symbol('palimpsest.api-json-response')

const JSON_HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, max-age=0',
  'X-Content-Type-Options': 'nosniff',
})

function writeJson(response, statusCode, payload, method = 'GET', { immutable = false } = {}) {
  if (response.writableEnded) return
  if (response[API_JSON_RESPONSE]) {
    response[API_JSON_RESPONSE](statusCode, method === 'HEAD' ? null : payload)
    return
  }
  const body = JSON.stringify(payload)
  response.statusCode = statusCode
  for (const [name, value] of Object.entries(JSON_HEADERS)) response.setHeader(name, value)
  if (immutable && statusCode === 200) {
    response.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
  }
  response.setHeader('Content-Length', Buffer.byteLength(body))
  if (method === 'HEAD') response.end()
  else response.end(body)
}

function errorPayload(error) {
  if (error instanceof GitServiceError) {
    return {
      statusCode: error.status,
      body: {
        message: error.message,
        error: {
          code: error.code,
          message: error.message,
          ...(error.detail ? { detail: error.detail } : {}),
        },
      },
    }
  }
  return {
    statusCode: 500,
    body: {
      message: 'The repository request could not be completed.',
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The repository request could not be completed.',
      },
    },
  }
}

function decodeOid(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new GitServiceError('The commit identifier is not valid URL text.', {
      code: 'INVALID_OID',
      status: 400,
    })
  }
}

function parseParentIndex(url) {
  const raw = url.searchParams.get('parentIndex') ?? url.searchParams.get('parent') ?? '0'
  if (!/^\d+$/.test(raw)) {
    throw new GitServiceError('The parent index must be a non-negative integer.', {
      code: 'INVALID_PARENT',
      status: 400,
    })
  }
  return Number(raw)
}

function parseNonNegativeInteger(url, name, fallback) {
  const raw = url.searchParams.get(name)
  if (raw == null || raw === '') return fallback
  if (!/^\d+$/.test(raw)) {
    throw new GitServiceError(`The ${name} parameter must be a non-negative integer.`, {
      code: name === 'offset' ? 'INVALID_OFFSET' : 'INVALID_LIMIT',
      status: 400,
    })
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) {
    throw new GitServiceError(`The ${name} parameter is too large.`, {
      code: name === 'offset' ? 'INVALID_OFFSET' : 'INVALID_LIMIT',
      status: 400,
    })
  }
  return value
}

function historyQuery(url, { defaultLimit = 128 } = {}) {
  return {
    offset: parseNonNegativeInteger(url, 'offset', 0),
    limit: parseNonNegativeInteger(url, 'limit', defaultLimit),
    ref: url.searchParams.get('ref') || 'HEAD',
    ...(url.searchParams.get('stats') === 'false' ? { includeStats: false } : {}),
  }
}

function assertSameOrigin(request) {
  const origin = request.headers.origin
  const fetchSite = request.headers['sec-fetch-site']
  const protocol = request.socket.encrypted ? 'https:' : 'http:'
  let hostOrigin
  try {
    const host = new URL(`${protocol}//${request.headers.host}`)
    if (!request.headers.host || host.username || host.password || host.pathname !== '/' || host.search || host.hash) {
      throw new Error('Invalid host')
    }
    hostOrigin = host.origin
  } catch {
    throw new GitServiceError('The request host is invalid.', { code: 'INVALID_ORIGIN', status: 403 })
  }
  if ((origin && origin !== hostOrigin) || (fetchSite && !['same-origin', 'none'].includes(fetchSite))) {
    throw new GitServiceError('Repository changes must originate from this application.', {
      code: 'INVALID_ORIGIN', status: 403,
    })
  }
}

async function readRepositoryPath(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    request.resume()
    throw new GitServiceError('The repository request must use application/json.', {
      code: 'INVALID_CONTENT_TYPE', status: 415,
    })
  }
  const tooLarge = () => new GitServiceError('The repository request body is too large.', {
    code: 'BODY_TOO_LARGE', status: 413,
  })
  if (Number(request.headers['content-length']) > MAX_REPOSITORY_BODY_BYTES) {
    request.resume()
    throw tooLarge()
  }
  const body = await new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    const finish = (error) => {
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('error', onError)
      request.off('aborted', onAborted)
      if (error) {
        request.resume()
        reject(error)
      } else resolve(Buffer.concat(chunks).toString('utf8'))
    }
    const onData = (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_REPOSITORY_BODY_BYTES) finish(tooLarge())
      else chunks.push(chunk)
    }
    const onEnd = () => finish()
    const onError = () => finish(new GitServiceError('The repository request body could not be read.', {
      code: 'INVALID_BODY', status: 400,
    }))
    const onAborted = onError
    request.on('data', onData)
    request.once('end', onEnd)
    request.once('error', onError)
    request.once('aborted', onAborted)
  })
  let payload
  try {
    payload = JSON.parse(body)
  } catch {
    throw new GitServiceError('The repository request must contain valid JSON.', { code: 'INVALID_JSON', status: 400 })
  }
  if (!payload || Array.isArray(payload) || typeof payload.path !== 'string'
    || !payload.path.trim() || payload.path.includes('\0')) {
    throw new GitServiceError('Provide a local Git repository directory in the path field.', {
      code: 'INVALID_REPOSITORY_PATH', status: 400,
    })
  }
  const requestedPath = payload.path.trim()
  const repoPath = path.resolve(requestedPath === '~' ? homedir()
    : /^~[/\\]/.test(requestedPath) ? path.join(homedir(), requestedPath.slice(2)) : requestedPath)
  const info = await stat(repoPath).catch(() => null)
  if (!info?.isDirectory()) {
    throw new GitServiceError('The repository path must be an existing local directory.', {
      code: 'INVALID_REPOSITORY_PATH', status: 400,
    })
  }
  return repoPath
}

function repositoryChanged(code = 'REPOSITORY_CHANGED') {
  return new GitServiceError('The active repository has changed. Reload the repository and retry.', {
    code, status: 409,
  })
}

/**
 * Connect-compatible API middleware. It also works directly with Node's
 * IncomingMessage/ServerResponse pair and deliberately leaves non-API URLs to
 * the next handler.
 */
export function createApiMiddleware({
  service,
  serviceFactory = createGitService,
  repoPath,
  gitBinary,
  diffLimit,
  landscapeFileLimit,
  landscapeChangeLimit,
  readOnly = false,
  publicRepository,
  allowedRefs,
} = {}) {
  const serviceOptions = {
    gitBinary,
    diffLimit,
    landscapeFileLimit,
    landscapeChangeLimit,
  }
  const makeSession = (gitService) => ({ service: gitService, id: randomUUID(), requests: 0, retired: false })
  let active = makeSession(service || serviceFactory({ ...serviceOptions, repoPath }))
  let switchVersion = 0
  let closed = false
  const pendingSessions = new Set()
  const retiredSessions = new Set()

  function disposeIfIdle(session) {
    if (!session.retired || session.requests || session.disposing) return
    session.disposing = true
    const disposal = session.forcedDispose || Promise.resolve().then(() => session.service.dispose?.())
    disposal.catch(() => undefined).finally(() => {
      retiredSessions.delete(session)
      session.resolveDisposed()
    })
  }

  function retire(session) {
    if (session.retired) {
      disposeIfIdle(session)
      return session.disposed
    }
    session.retired = true
    session.disposed = new Promise((resolve) => { session.resolveDisposed = resolve })
    retiredSessions.add(session)
    disposeIfIdle(session)
    return session.disposed
  }

  const middleware = function gitApiMiddleware(request, response, next = () => {}) {
    let url
    try {
      url = new URL(request.url || '/', 'http://localhost')
    } catch {
      writeJson(response, 400, {
        error: { code: 'INVALID_URL', message: 'The request URL is invalid.' },
      }, request.method)
      return
    }

    if (!url.pathname.startsWith('/api/')) {
      next()
      return
    }

    return (async () => {
      const method = (request.method || 'GET').toUpperCase()
      const readMethod = method === 'GET' || method === 'HEAD'
      if (readOnly && (!readMethod || url.pathname === '/api/refresh')) {
        request.resume?.()
        response.setHeader('Allow', 'GET, HEAD')
        throw new GitServiceError('This public history viewer is read-only.', { code: 'READ_ONLY', status: 405 })
      }
      const requestedRef = url.searchParams.get('ref') || 'HEAD'
      if (allowedRefs && !allowedRefs.includes(requestedRef)) {
        throw new GitServiceError('That history scope is unavailable on this public archive.', { code: 'INVALID_REF', status: 400 })
      }
      const requestedRepository = url.searchParams.get('repository')
      if (closed) throw new GitServiceError('The repository service is closed.', { code: 'SERVICE_CLOSED', status: 503 })
      if (requestedRepository !== null && requestedRepository !== active.id) throw repositoryChanged()

      if (url.pathname === '/api/repository' && method === 'POST') {
        assertSameOrigin(request)
        const candidatePath = await readRepositoryPath(request)
        if (closed) throw new GitServiceError('The repository service is closed.', { code: 'SERVICE_CLOSED', status: 503 })
        if (requestedRepository !== null && requestedRepository !== active.id) throw repositoryChanged()
        const version = ++switchVersion
        const candidate = makeSession(serviceFactory({ ...serviceOptions, repoPath: candidatePath }))
        candidate.requests += 1
        pendingSessions.add(candidate)
        try {
          const payload = await candidate.service.getRepository({ includeStats: false })
          if (payload.status !== 'ready' && payload.status !== 'empty') {
            throw new GitServiceError(payload.message || 'The selected directory is not a readable Git repository.', {
              code: 'INVALID_REPOSITORY', status: 400, detail: payload.detail,
            })
          }
          if (closed || version !== switchVersion) throw repositoryChanged('REPOSITORY_SWITCH_SUPERSEDED')
          const previous = active
          active = candidate
          void retire(previous)
          writeJson(response, 200, { ...payload, repositoryId: candidate.id }, method)
        } finally {
          pendingSessions.delete(candidate)
          candidate.requests -= 1
          if (active !== candidate) await retire(candidate)
          else disposeIfIdle(candidate)
        }
        return
      }

      // Capture one service for the whole request. Switching repositories can
      // retire it, but its indexes remain alive until this request finishes.
      const session = active
      const gitService = session.service
      const immutable = requestedRepository === session.id
      const statsOptions = readOnly || url.searchParams.get('stats') === 'false' ? { includeStats: false } : undefined
      session.requests += 1
      try {
        if (url.pathname === '/api/repository' && readMethod) {
          const payload = await gitService.getRepository(statsOptions)
          const visiblePayload = !publicRepository ? payload : payload.status === 'ready'
            ? { ...payload, repo: { ...payload.repo, ...publicRepository } }
            : {
              status: payload.status,
              repoName: publicRepository.name,
              displayPath: publicRepository.displayPath,
              message: 'Linux history is temporarily unavailable. Data preparation may still be running.',
            }
          writeJson(response, 200, { ...visiblePayload, repositoryId: session.id }, method)
          return
        }

        if (url.pathname === '/api/refresh' && method === 'POST') {
          assertSameOrigin(request)
          const payload = await gitService.refresh(statsOptions)
          if (session !== active) throw repositoryChanged()
          session.id = randomUUID()
          writeJson(response, 200, { ...payload, repositoryId: session.id }, method)
          return
        }

        if (url.pathname === '/api/commits' && readMethod) {
          writeJson(response, 200, await gitService.getCommits({ ...historyQuery(url), ...(readOnly ? { includeStats: false } : {}) }), method)
          return
        }

        if (url.pathname === '/api/commit-index' && readMethod) {
          const oid = url.searchParams.get('oid')
          writeJson(response, 200, await gitService.getCommitIndex(oid, {
            ref: url.searchParams.get('ref') || 'HEAD',
          }), method)
          return
        }

        const commitMatch = /^\/api\/commits\/([^/]+)$/.exec(url.pathname)
        if (commitMatch && readMethod) {
          if (readOnly && url.searchParams.get('view') === 'exact') {
            throw new GitServiceError('Use the paged tree and changes endpoints for exact inspection.', { code: 'USE_PAGED_INSPECTION', status: 400 })
          }
          writeJson(response, 200, await gitService.getCommit(decodeOid(commitMatch[1]), {
            view: url.searchParams.get('view') || (readOnly ? 'landscape' : 'exact'),
          }), method, { immutable })
          return
        }

        const treeMatch = /^\/api\/tree\/([^/]+)$/.exec(url.pathname)
        if (treeMatch && readMethod) {
          writeJson(response, 200, await gitService.getTree(
            decodeOid(treeMatch[1]),
            url.searchParams.get('path') ?? '.',
            historyQuery(url, { defaultLimit: 256 }),
          ), method, { immutable })
          return
        }

        const changesMatch = /^\/api\/changes\/([^/]+)$/.exec(url.pathname)
        if (changesMatch && readMethod) {
          writeJson(response, 200, await gitService.getChanges(
            decodeOid(changesMatch[1]),
            historyQuery(url, { defaultLimit: 256 }),
          ), method, { immutable })
          return
        }

        const diffMatch = /^\/api\/diff\/([^/]+)$/.exec(url.pathname)
        if (diffMatch && readMethod) {
          const filePath = url.searchParams.get('path')
          writeJson(response, 200, await gitService.getDiff(
            decodeOid(diffMatch[1]),
            filePath,
            { parentIndex: parseParentIndex(url) },
          ), method, { immutable })
          return
        }

        const historyMatch = /^\/api\/file-history\/([^/]+)$/.exec(url.pathname)
        if (historyMatch && readMethod) {
          const filePath = url.searchParams.get('path')
          writeJson(response, 200, await gitService.getFileHistory(
            decodeOid(historyMatch[1]),
            filePath,
            historyQuery(url, { defaultLimit: 200 }),
          ), method, { immutable })
          return
        }

        const knownPath = url.pathname === '/api/repository'
          || url.pathname === '/api/refresh'
          || url.pathname === '/api/commits'
          || url.pathname === '/api/commit-index'
          || commitMatch
          || treeMatch
          || changesMatch
          || diffMatch
          || historyMatch
        writeJson(response, knownPath ? 405 : 404, {
          error: {
            code: knownPath ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND',
            message: knownPath ? 'That method is not supported for this endpoint.' : 'API endpoint not found.',
          },
        }, method)
      } finally {
        session.requests -= 1
        disposeIfIdle(session)
      }
    })().catch((error) => {
      const { statusCode, body } = errorPayload(error)
      if (publicRepository && body.error) delete body.error.detail
      writeJson(response, statusCode, body, request.method)
    })
  }

  Object.defineProperty(middleware, 'service', { get: () => active.service })
  middleware.dispose = async ({ force = false } = {}) => {
    closed = true
    switchVersion += 1
    const sessions = new Set([active, ...pendingSessions, ...retiredSessions])
    if (force) {
      for (const session of sessions) {
        if (!session.disposing) {
          session.forcedDispose ||= Promise.resolve().then(() => session.service.dispose?.()).catch(() => undefined)
        }
      }
    }
    await Promise.all([...sessions].map(retire))
  }
  return middleware
}

/** A small Vite plugin wrapper used by both the dev and preview servers. */
export function gitHistoryApi(options = {}) {
  const middleware = createApiMiddleware(options)
  return {
    name: 'palimpsest-git-history-api',
    configureServer(server) {
      server.middlewares.use(middleware)
      server.httpServer?.once('close', () => { void middleware.dispose() })
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
      server.httpServer?.once('close', () => { void middleware.dispose() })
    },
  }
}

export default createApiMiddleware
