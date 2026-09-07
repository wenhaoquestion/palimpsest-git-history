import { useCallback, useEffect, useRef, useState } from 'react'
import { gitApi } from '../lib/api'
import { RequestCache } from '../lib/request-cache'
import type { CommitHistoryPage, CommitSummary, RepositoryPayload } from '../types/git'

type ReadyRepository = Extract<RepositoryPayload, { status: 'ready' }>

interface TimelineState {
  scope: string
  index: number
  total: number
  commits: CommitSummary[]
  pageOffset: number
  activeCommit: CommitSummary | null
  loading: boolean
  error: string | null
}

const DEFAULT_PAGE_SIZE = 128
const PAGE_CACHE_LIMIT = 5
const PAGE_PREFETCH_DISTANCE = 20

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum)
}

function readableError(error: unknown) {
  return error instanceof Error ? error.message : 'Could not load this part of repository history.'
}

function isAbortError(error: unknown) {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
}

function cacheKey(scope: string, offset: number) {
  return `${scope}\u0000${offset}`
}

function pageContains(page: CommitHistoryPage, index: number) {
  return index >= page.offset && index < page.offset + page.items.length
}

/**
 * Keeps only a few summary pages in memory while presenting one continuous,
 * absolute commit index from the initial commit through the selected ref.
 */
export function useCommitTimeline(ready: ReadyRepository | null, requestedScope: string) {
  const pageSize = Math.max(1, ready?.history.limit ?? ready?.commits.length ?? DEFAULT_PAGE_SIZE)
  const cacheRef = useRef(new RequestCache<CommitHistoryPage>(PAGE_CACHE_LIMIT, 3, 2, 4 * 1024 * 1024))
  const foregroundControllerRef = useRef<AbortController | null>(null)
  const locateControllerRef = useRef<AbortController | null>(null)
  const generationRef = useRef(0)
  const scopeRef = useRef(requestedScope)
  const totalRef = useRef(ready?.history.total ?? ready?.repo.counts.commits ?? 0)
  const pageSizeRef = useRef(pageSize)
  const [state, setState] = useState<TimelineState>({
    scope: requestedScope,
    index: 0,
    total: totalRef.current,
    commits: [],
    pageOffset: 0,
    activeCommit: null,
    loading: Boolean(ready),
    error: null,
  })

  pageSizeRef.current = pageSize

  const readPage = useCallback((scope: string, offset: number) =>
    cacheRef.current.read(cacheKey(scope, offset)) ?? null, [])

  const writePage = useCallback((page: CommitHistoryPage, scope = page.ref) => {
    cacheRef.current.write(cacheKey(scope, page.offset), page)
  }, [])

  const abortPendingPages = useCallback(() => {
    foregroundControllerRef.current?.abort()
    foregroundControllerRef.current = null
    locateControllerRef.current?.abort()
    locateControllerRef.current = null
    cacheRef.current.clear()
  }, [])

  const requestPage = useCallback((
    scope: string,
    offset: number,
    signal?: AbortSignal,
    background = false,
  ) => cacheRef.current.request(
    cacheKey(scope, offset),
    (requestSignal) => gitApi.commits(offset, pageSizeRef.current, scope, requestSignal, background),
    signal,
    background,
  ), [])

  const getCommitAtIndex = useCallback(async (requestedIndex: number, signal?: AbortSignal) => {
    const scope = scopeRef.current
    const generation = generationRef.current
    const knownTotal = totalRef.current
    if (knownTotal <= 0) return null
    const safeIndex = clamp(Math.round(requestedIndex), 0, knownTotal - 1)
    const offset = Math.floor(safeIndex / pageSizeRef.current) * pageSizeRef.current
    const cached = readPage(scope, offset)
    if (cached) return cached.items[safeIndex - cached.offset] ?? null

    try {
      const page = await requestPage(scope, offset, signal, true)
      if (generation !== generationRef.current || scope !== scopeRef.current || signal?.aborted) return null
      totalRef.current = page.total
      return page.items[safeIndex - page.offset] ?? null
    } catch (error) {
      if (isAbortError(error)) return null
      return null
    }
  }, [readPage, requestPage])

  const showIndex = useCallback(async (requestedIndex: number) => {
    const scope = scopeRef.current
    const generation = generationRef.current
    const knownTotal = totalRef.current
    const safeIndex = knownTotal > 0
      ? clamp(Math.round(requestedIndex), 0, knownTotal - 1)
      : Math.max(0, Math.round(requestedIndex))
    const offset = Math.floor(safeIndex / pageSizeRef.current) * pageSizeRef.current
    const cached = readPage(scope, offset)

    // Subscribe first so a seek within the same pending page keeps its I/O.
    const controller = cached ? null : new AbortController()
    const pageRequest = controller ? requestPage(scope, offset, controller.signal) : null
    foregroundControllerRef.current?.abort()
    foregroundControllerRef.current = controller
    locateControllerRef.current?.abort()
    locateControllerRef.current = null

    setState((current) => ({
      ...current,
      scope,
      index: safeIndex,
      commits: cached?.items ?? current.commits,
      pageOffset: cached?.offset ?? current.pageOffset,
      activeCommit: cached?.items[safeIndex - (cached?.offset ?? offset)] ?? null,
      loading: !cached,
      error: null,
    }))
    if (cached) return cached.items[safeIndex - cached.offset] ?? null

    if (!controller || !pageRequest) return null
    try {
      const page = await pageRequest
      if (
        controller.signal.aborted
        || generation !== generationRef.current
        || scope !== scopeRef.current
      ) return null
      totalRef.current = page.total
      setState((current) => {
        if (current.scope !== scope || !pageContains(page, current.index)) {
          return { ...current, total: page.total }
        }
        return {
          ...current,
          total: page.total,
          commits: page.items,
          pageOffset: page.offset,
          activeCommit: page.items[current.index - page.offset] ?? null,
          loading: false,
          error: null,
        }
      })
      return page.items[safeIndex - page.offset] ?? null
    } catch (error) {
      if (
        controller.signal.aborted
        || isAbortError(error)
        || generation !== generationRef.current
        || scope !== scopeRef.current
      ) return null
      setState((current) => ({ ...current, loading: false, error: readableError(error) }))
      return null
    } finally {
      if (foregroundControllerRef.current === controller) foregroundControllerRef.current = null
    }
  }, [readPage, requestPage])

  useEffect(() => {
    generationRef.current += 1
    const generation = generationRef.current
    scopeRef.current = requestedScope
    abortPendingPages()
    const initialMatches = ready?.history.ref === requestedScope
    const initialPage: CommitHistoryPage | null = ready && initialMatches
      ? { ...ready.history, items: ready.commits }
      : null
    if (initialPage) writePage(initialPage, requestedScope)

    const estimatedTotal = initialPage?.total
      ?? (requestedScope === 'all' ? ready?.repo.counts.allCommits : undefined)
      ?? (requestedScope === 'HEAD' ? ready?.repo.counts.commits : undefined)
      ?? 0
    totalRef.current = estimatedTotal
    setState({
      scope: requestedScope,
      index: 0,
      total: estimatedTotal,
      commits: initialPage?.items ?? [],
      pageOffset: 0,
      activeCommit: initialPage?.items[0] ?? null,
      loading: Boolean(ready && !initialPage),
      error: null,
    })

    if (ready && !initialPage) void showIndex(0)
    return () => {
      if (generation === generationRef.current) abortPendingPages()
    }
  }, [abortPendingPages, ready, requestedScope, showIndex, writePage])

  useEffect(() => {
    if (!state.activeCommit || state.loading || state.total <= pageSizeRef.current) return
    const controller = new AbortController()
    const pageEnd = state.pageOffset + state.commits.length - 1
    const nextPageIndex = state.pageOffset + state.commits.length
    if (pageEnd - state.index <= PAGE_PREFETCH_DISTANCE && nextPageIndex < state.total) {
      void getCommitAtIndex(nextPageIndex, controller.signal)
    }
    if (state.index - state.pageOffset <= PAGE_PREFETCH_DISTANCE && state.pageOffset > 0) {
      void getCommitAtIndex(Math.max(0, state.pageOffset - pageSizeRef.current), controller.signal)
    }
    return () => controller.abort()
  }, [getCommitAtIndex, state.activeCommit, state.commits.length, state.index, state.loading, state.pageOffset, state.total])

  const locateOid = useCallback(async (oid: string) => {
    const scope = scopeRef.current
    const generation = generationRef.current

    locateControllerRef.current?.abort()
    locateControllerRef.current = null

    for (const page of cacheRef.current.values()) {
      const localIndex = page.items.findIndex((commit) => commit.oid === oid)
      if (localIndex >= 0) {
        await showIndex(page.offset + localIndex)
        return true
      }
    }

    const controller = new AbortController()
    locateControllerRef.current = controller
    try {
      const result = await gitApi.commitIndex(oid, scope, controller.signal)
      if (
        controller.signal.aborted
        || generation !== generationRef.current
        || scope !== scopeRef.current
      ) return false
      totalRef.current = result.total
      if (locateControllerRef.current === controller) locateControllerRef.current = null
      await showIndex(result.index)
      return true
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return false
      if (generation === generationRef.current) {
        setState((current) => ({ ...current, error: readableError(error) }))
      }
      return false
    } finally {
      if (locateControllerRef.current === controller) locateControllerRef.current = null
    }
  }, [showIndex])

  const retry = useCallback(() => {
    void showIndex(state.index)
  }, [showIndex, state.index])

  return {
    ...state,
    selectIndex: showIndex,
    getCommitAtIndex,
    locateOid,
    retry,
    cacheLimit: PAGE_CACHE_LIMIT * pageSize,
  }
}
