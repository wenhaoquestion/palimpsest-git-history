import { startTransition, useCallback, useEffect, useRef, useState } from 'react'
import { gitApi } from '../lib/api'
import { MemoryCache, RequestCache } from '../lib/request-cache'
import type {
  ChangesPagePayload,
  CommitDetails,
  DiffPayload,
  FileHistoryEntry,
  TreePagePayload,
} from '../types/git'

type ResourceState<T> = {
  data: T | null
  loading: boolean
  error: string | null
}

type CommitResourceState = ResourceState<CommitDetails> & {
  targetOid: string | null
}

const detailCache = new RequestCache<CommitDetails>(16)
const diffCache = new MemoryCache<string, DiffPayload>(48, 8 * 1024 * 1024)
const historyCache = new MemoryCache<string, FileHistoryEntry[]>(48, 4 * 1024 * 1024)
const treeCache = new MemoryCache<string, TreePagePayload>(24, 8 * 1024 * 1024)
const changesCache = new MemoryCache<string, ChangesPagePayload>(12, 8 * 1024 * 1024)

// Landscape responses are deliberately bounded by the server. A small LRU is
// enough for instant previous/next navigation without allowing playback to
// grow browser memory indefinitely.
const TREE_PAGE_SIZE = 200
const CHANGES_PAGE_SIZE = 200
let prefetchController: AbortController | null = null
let resourceGeneration = 0

function readableError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function isAbortError(error: unknown) {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
}

function normalizedDirectory(path: string | null) {
  const normalized = (path ?? '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')
  return normalized || '.'
}

function mergeByPath<T extends { path: string }>(current: T[], incoming: T[]) {
  const merged = new Map(current.map((entry) => [entry.path, entry]))
  for (const entry of incoming) merged.set(entry.path, entry)
  return [...merged.values()]
}

export function loadCommit(oid: string, signal?: AbortSignal) {
  return detailCache.request(oid, (requestSignal) => gitApi.commit(oid, requestSignal), signal)
}

/** Keep only the newest prefetch window; a foreground seek always has a free slot. */
export async function prefetchCommits(oids: string[], signal?: AbortSignal) {
  if (signal?.aborted) return
  const previous = prefetchController
  const controller = new AbortController()
  prefetchController = controller
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  // Subscribe before dropping the previous window so overlapping requests survive.
  const requests = [...new Set(oids.filter(Boolean))].map((oid) =>
    detailCache.request(oid, (requestSignal) => gitApi.commit(oid, requestSignal, true), controller.signal, true),
  )
  previous?.abort()
  await Promise.allSettled(requests)
  signal?.removeEventListener('abort', abort)
  if (prefetchController === controller) prefetchController = null
}

export function clearCommitCaches() {
  resourceGeneration += 1
  prefetchController?.abort()
  prefetchController = null
  detailCache.clear()
  diffCache.clear()
  historyCache.clear()
  treeCache.clear()
  changesCache.clear()
}

export function useCommitDetails(oid: string | null, retainWhileUnresolved = false) {
  const [state, setState] = useState<CommitResourceState>({
    targetOid: oid,
    data: null,
    loading: Boolean(oid),
    error: null,
  })
  const [retryEpoch, setRetryEpoch] = useState(0)

  const retry = useCallback(() => {
    if (oid) {
      detailCache.delete(oid)
    }
    setRetryEpoch((current) => current + 1)
  }, [oid])

  useEffect(() => {
    if (!oid) {
      setState((current) => retainWhileUnresolved
        ? { ...current, targetOid: null, loading: true, error: null }
        : { targetOid: null, data: null, loading: false, error: null })
      return
    }

    let live = true
    const controller = new AbortController()
    const generation = resourceGeneration
    const cached = detailCache.read(oid)
    if (cached) {
      setState({ targetOid: oid, data: cached, loading: false, error: null })
      return
    }

    // Retain the previous landscape while the new bounded snapshot arrives.
    // Commit metadata lives in the timeline and therefore updates immediately.
    setState((current) => ({ ...current, targetOid: oid, loading: true, error: null }))
    loadCommit(oid, controller.signal).then(
      (data) => {
        if (!live || generation !== resourceGeneration) return
        startTransition(() => {
          setState({ targetOid: oid, data, loading: false, error: null })
        })
      },
      (error: unknown) => {
        if (!live || isAbortError(error)) return
        setState((current) => ({
          ...current,
          targetOid: oid,
          loading: false,
          error: readableError(error, 'Could not load this commit.'),
        }))
      },
    )
    return () => {
      live = false
      controller.abort()
    }
  }, [oid, retainWhileUnresolved, retryEpoch])

  const targetChanged = state.targetOid !== oid
  return {
    ...state,
    loading: oid ? targetChanged || state.loading : retainWhileUnresolved,
    error: targetChanged ? null : state.error,
    stale: Boolean(state.data && state.data.oid !== oid),
    retry,
  }
}

export function useDirectoryTree(
  oid: string | null,
  path: string | null,
  enabled = true,
) {
  const directory = normalizedDirectory(path)
  const key = oid ? `${oid}\u0000${directory}` : ''
  const [state, setState] = useState<ResourceState<TreePagePayload>>({
    data: null,
    loading: Boolean(oid && enabled),
    error: null,
  })
  const [loadingMore, setLoadingMore] = useState(false)
  const [retryEpoch, setRetryEpoch] = useState(0)
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => () => controllerRef.current?.abort(), [])

  useEffect(() => {
    controllerRef.current?.abort()
    if (!oid || !enabled) {
      setState({ data: null, loading: false, error: null })
      setLoadingMore(false)
      return
    }

    const cached = treeCache.get(key)
    if (cached) {
      setState({ data: cached, loading: false, error: null })
      setLoadingMore(false)
      return
    }

    let live = true
    const controller = new AbortController()
    const generation = resourceGeneration
    controllerRef.current = controller
    setState({ data: null, loading: true, error: null })
    setLoadingMore(false)
    gitApi.tree(oid, directory, 0, TREE_PAGE_SIZE, controller.signal).then(
      (data) => {
        if (!live || controller.signal.aborted || generation !== resourceGeneration) return
        treeCache.set(key, data)
        setState({ data, loading: false, error: null })
      },
      (error: unknown) => {
        if (!live || isAbortError(error)) return
        setState({ data: null, loading: false, error: readableError(error, 'Directory unavailable.') })
      },
    )
    return () => {
      live = false
      controllerRef.current?.abort()
    }
  }, [directory, enabled, key, oid, retryEpoch])

  const loadMore = useCallback(() => {
    if (!oid || !enabled || state.loading || loadingMore || !state.data?.hasMore) return
    const current = state.data
    const controller = new AbortController()
    const generation = resourceGeneration
    controllerRef.current?.abort()
    controllerRef.current = controller
    setLoadingMore(true)
    gitApi.tree(oid, directory, current.items.length, TREE_PAGE_SIZE, controller.signal).then(
      (page) => {
        if (controller.signal.aborted || generation !== resourceGeneration) return
        const data: TreePagePayload = {
          ...page,
          offset: 0,
          limit: current.items.length + page.items.length,
          items: mergeByPath(current.items, page.items),
        }
        treeCache.set(key, data)
        setState({ data, loading: false, error: null })
        setLoadingMore(false)
      },
      (error: unknown) => {
        if (controller.signal.aborted || generation !== resourceGeneration || isAbortError(error)) return
        setState((value) => ({ ...value, error: readableError(error, 'Could not load more paths.') }))
        setLoadingMore(false)
      },
    )
  }, [directory, enabled, key, loadingMore, oid, state.data, state.loading])

  const retry = useCallback(() => {
    if (key) treeCache.delete(key)
    setRetryEpoch((current) => current + 1)
  }, [key])

  return { ...state, loadingMore, loadMore, retry }
}

/** Exact changed-file pages are opt-in. The fast landscape already contains a
 * representative changed-path set; opening more is an explicit inspection. */
export function useCommitChanges(oid: string | null, enabled = true) {
  const [state, setState] = useState<ResourceState<ChangesPagePayload>>({
    data: null,
    loading: false,
    error: null,
  })
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    controllerRef.current?.abort()
    const cached = oid ? changesCache.get(oid) : undefined
    setState({ data: cached ?? null, loading: false, error: null })
    return () => controllerRef.current?.abort()
  }, [oid])

  useEffect(() => {
    if (!enabled) {
      controllerRef.current?.abort()
      setState((current) => ({ ...current, loading: false }))
    }
  }, [enabled])

  const loadMore = useCallback(() => {
    if (!oid || !enabled || state.loading || (state.data && !state.data.hasMore)) return
    const current = state.data
    const offset = current?.items.length ?? 0
    const controller = new AbortController()
    const generation = resourceGeneration
    controllerRef.current?.abort()
    controllerRef.current = controller
    setState((value) => ({ ...value, loading: true, error: null }))
    gitApi.changes(oid, offset, CHANGES_PAGE_SIZE, controller.signal).then(
      (page) => {
        if (controller.signal.aborted || generation !== resourceGeneration) return
        const data: ChangesPagePayload = current
          ? {
              ...page,
              offset: 0,
              limit: current.items.length + page.items.length,
              items: mergeByPath(current.items, page.items),
            }
          : page
        changesCache.set(oid, data)
        setState({ data, loading: false, error: null })
      },
      (error: unknown) => {
        if (controller.signal.aborted || generation !== resourceGeneration || isAbortError(error)) return
        setState((value) => ({ ...value, loading: false, error: readableError(error, 'Could not load changed paths.') }))
      },
    )
  }, [enabled, oid, state])

  const retry = useCallback(() => {
    if (oid) changesCache.delete(oid)
    setState({ data: null, loading: false, error: null })
  }, [oid])

  return { ...state, loadMore, retry }
}

export function useFileInspection(
  oid: string | null,
  path: string | null,
  parentIndex = 0,
  options: { diff?: boolean; history?: boolean } = {},
) {
  const loadDiff = options.diff ?? true
  const loadHistory = options.history ?? true
  const [diff, setDiff] = useState<ResourceState<DiffPayload>>({
    data: null,
    loading: false,
    error: null,
  })
  const [history, setHistory] = useState<ResourceState<FileHistoryEntry[]>>({
    data: null,
    loading: false,
    error: null,
  })
  const [retryEpoch, setRetryEpoch] = useState(0)

  const retry = useCallback(() => {
    if (oid && path) {
      diffCache.delete(`${oid}\u0000${parentIndex}\u0000${path}`)
      historyCache.delete(`${oid}\u0000${path}`)
    }
    setRetryEpoch((current) => current + 1)
  }, [oid, parentIndex, path])

  useEffect(() => {
    if (!oid || !path) {
      setDiff({ data: null, loading: false, error: null })
      setHistory({ data: null, loading: false, error: null })
      return
    }

    let live = true
    const controller = new AbortController()
    const generation = resourceGeneration
    const key = `${oid}\u0000${parentIndex}\u0000${path}`
    const historyKey = `${oid}\u0000${path}`
    const cachedDiff = diffCache.get(key)
    const cachedHistory = historyCache.get(historyKey)

    setDiff((current) => loadDiff
      ? cachedDiff
        ? { data: cachedDiff, loading: false, error: null }
        : { data: null, loading: true, error: null }
      : { ...current, loading: false, error: null })
    setHistory((current) => loadHistory
      ? cachedHistory
        ? { data: cachedHistory, loading: false, error: null }
        : { data: null, loading: true, error: null }
      : { ...current, loading: false, error: null })

    const tasks: Promise<unknown>[] = []
    if (loadDiff && !cachedDiff) {
      tasks.push(gitApi.diff(oid, path, parentIndex, controller.signal).then(
        (data) => {
          if (!live || controller.signal.aborted || generation !== resourceGeneration) return
          diffCache.set(key, data)
          if (live) setDiff({ data, loading: false, error: null })
        },
        (error: unknown) => {
          if (live && !isAbortError(error)) {
            setDiff({ data: null, loading: false, error: readableError(error, 'Diff unavailable.') })
          }
        },
      ))
    }
    if (loadHistory && !cachedHistory) {
      tasks.push(gitApi.fileHistory(oid, path, controller.signal).then(
        (data) => {
          if (!live || controller.signal.aborted || generation !== resourceGeneration) return
          historyCache.set(historyKey, data)
          if (live) setHistory({ data, loading: false, error: null })
        },
        (error: unknown) => {
          if (live && !isAbortError(error)) {
            setHistory({ data: null, loading: false, error: readableError(error, 'File history unavailable.') })
          }
        },
      ))
    }

    void Promise.allSettled(tasks)
    return () => {
      live = false
      controller.abort()
    }
  }, [loadDiff, loadHistory, oid, parentIndex, path, retryEpoch])

  return { diff, history, retry }
}
