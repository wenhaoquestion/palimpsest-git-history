import { useCallback, useEffect, useRef, useState } from 'react'
import { gitApi, setRepositoryId } from '../lib/api'
import { clearCommitCaches } from './useCommitResource'
import type { RepositoryPayload } from '../types/git'

export function useRepository() {
  const [payload, setPayload] = useState<RepositoryPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const [revision, setRevision] = useState(0)

  const load = useCallback(async (kind: 'initial' | 'refresh' | 'open', path = '') => {
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setError(null)
    if (kind !== 'initial') setRefreshing(true)
    try {
      const next = await (kind === 'open'
        ? gitApi.openRepository(path, controller.signal)
        : kind === 'refresh'
          ? gitApi.refresh(controller.signal)
          : gitApi.repository(controller.signal))
      if (controller.signal.aborted) return null
      // Change identity before remounting readers. Old requests cannot populate
      // the next repository's memory or HTTP caches.
      setRepositoryId(next.repositoryId)
      clearCommitCaches()
      setPayload(next)
      setRevision((current) => current + 1)
      return next
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : 'Could not open repository history.')
      }
      return null
    } finally {
      if (requestRef.current === controller) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [])

  useEffect(() => {
    void load('initial')
    const onMessage = (event: MessageEvent<{ type?: string }>) => {
      if (event.data?.type === 'palimpsest:repositoryChanged') void load('initial')
    }
    window.addEventListener('message', onMessage)
    return () => {
      requestRef.current?.abort()
      window.removeEventListener('message', onMessage)
    }
  }, [load])

  const refresh = useCallback(() => load('refresh'), [load])
  const reload = useCallback(() => load('initial'), [load])
  const openRepository = useCallback((path: string) => load('open', path), [load])
  return { payload, loading, refreshing, error, refresh, reload, openRepository, revision }
}
