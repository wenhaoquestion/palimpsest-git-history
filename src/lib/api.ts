import type {
  CommitHistoryPage,
  CommitIndexPayload,
  CommitDetails,
  ChangesPagePayload,
  DiffPayload,
  FileHistoryEntry,
  RepositoryPayload,
  TreePagePayload,
} from '../types/git'
import { hostRequest, isVSCode } from './host'

class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

let repositoryId: string | undefined

export function setRepositoryId(value: string | undefined) {
  repositoryId = value
}

async function request<T>(path: string, init?: RequestInit, scoped = true): Promise<T> {
  const url = new URL(path, 'http://palimpsest.local')
  if (scoped && repositoryId) url.searchParams.set('repository', repositoryId)
  const route = `${url.pathname}${url.search}`
  const response = isVSCode ? null : await fetch(route, {
    ...init,
    headers: { Accept: 'application/json', ...init?.headers },
  })

  const hostResponse = isVSCode ? await hostRequest(route, init) : null
  const status = hostResponse?.status ?? response!.status
  const payload = (hostResponse ? hostResponse.body : await response!.json().catch(() => null)) as
    | (T & { message?: string; error?: { message?: string } })
    | null

  if (status < 200 || status >= 300) {
    throw new ApiError(
      payload?.message ?? payload?.error?.message ?? `Request failed (${status})`,
      status,
    )
  }

  if (payload === null) {
    throw new ApiError('The local Git service returned an empty response.', status)
  }

  return payload
}

export const gitApi = {
  repository: (signal?: AbortSignal) =>
    request<RepositoryPayload>('/api/repository?stats=false', { signal }, false),

  openRepository: (path: string, signal?: AbortSignal) =>
    request<RepositoryPayload>('/api/repository?stats=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
      signal,
    }, false),

  commits: (offset: number, limit: number, ref = 'HEAD', signal?: AbortSignal, background = false) => {
    const params = new URLSearchParams({
      offset: String(offset),
      limit: String(limit),
      ref,
      stats: 'false',
      ...(background ? { priority: 'background' } : {}),
    })
    return request<CommitHistoryPage>(`/api/commits?${params.toString()}`, { signal })
  },

  commitIndex: (oid: string, ref = 'HEAD', signal?: AbortSignal) => {
    const params = new URLSearchParams({ oid, ref })
    return request<CommitIndexPayload>(`/api/commit-index?${params.toString()}`, { signal })
  },

  commit: (oid: string, signal?: AbortSignal, background = false) =>
    request<CommitDetails>(`/api/commits/${encodeURIComponent(oid)}?view=landscape${background ? '&priority=background' : ''}`, { signal }),

  tree: (
    oid: string,
    path = '.',
    offset = 0,
    limit = 200,
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams({
      path,
      offset: String(offset),
      limit: String(limit),
    })
    return request<TreePagePayload>(
      `/api/tree/${encodeURIComponent(oid)}?${params.toString()}`,
      { signal },
    )
  },

  changes: (oid: string, offset = 0, limit = 200, signal?: AbortSignal) => {
    const params = new URLSearchParams({
      offset: String(offset),
      limit: String(limit),
    })
    return request<ChangesPagePayload>(
      `/api/changes/${encodeURIComponent(oid)}?${params.toString()}`,
      { signal },
    )
  },

  diff: (oid: string, path: string, parentIndex = 0, signal?: AbortSignal) => {
    const params = new URLSearchParams({ path, parent: String(parentIndex) })
    return request<DiffPayload>(
      `/api/diff/${encodeURIComponent(oid)}?${params.toString()}`,
      { signal },
    )
  },

  fileHistory: (oid: string, path: string, signal?: AbortSignal) => {
    const params = new URLSearchParams({ path })
    return request<{ entries: FileHistoryEntry[] }>(
      `/api/file-history/${encodeURIComponent(oid)}?${params.toString()}`,
      { signal },
    ).then((result) => result.entries)
  },

  refresh: (signal?: AbortSignal) =>
    request<RepositoryPayload>('/api/refresh?stats=false', { method: 'POST', signal }),
}

export { ApiError }
