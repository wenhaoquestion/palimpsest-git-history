interface HostApi {
  postMessage(message: unknown): void
  getState(): SavedView | undefined
  setState(state: SavedView): void
}

export interface SavedView {
  repoPath: string
  scope: string
  index: number
  surface?: 'history' | 'workspace'
  workbench?: { repoPath: string; message: string }
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => HostApi
  }
}

const host = window.acquireVsCodeApi?.()
export const isVSCode = Boolean(host)
export function readSavedView(): SavedView | undefined {
  const saved = host?.getState()
  return saved && typeof saved.repoPath === 'string' && typeof saved.scope === 'string'
    && Number.isSafeInteger(saved.index) && saved.index >= 0 ? saved : undefined
}
export const saveView = (view: SavedView) => host?.setState({ ...host.getState(), ...view })
export const pickRepository = () => host?.postMessage({ type: 'palimpsest:pickRepository' })
export const openInNewWindow = () => host?.postMessage({ type: 'palimpsest:openInNewWindow' })
export const signalHostReady = () => host?.postMessage({ type: 'palimpsest:ready' })
export const readSavedSurface = () => host?.getState()?.surface === 'workspace' ? 'workspace' : 'history'
export const readSavedWorkbench = () => host?.getState()?.workbench
export const saveSurface = (surface: 'history' | 'workspace') => host?.setState({
  repoPath: '', scope: 'HEAD', index: 0, ...host.getState(), surface,
})
export const saveWorkbench = (workbench: { repoPath: string; message: string }) => host?.setState({
  repoPath: '', scope: 'HEAD', index: 0, ...host.getState(), workbench,
})

interface PendingRequest {
  mutation: boolean
  resolve: (response: { status: number; body: unknown }) => void
  reject: (error: Error) => void
  cleanup: () => void
}

const pending = new Map<string, PendingRequest>()
const session = crypto.randomUUID()
let sequence = 0

if (host) {
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    const message = event.data as { type?: string; id?: string; status?: number; body?: unknown; visible?: boolean }
    if (message?.type === 'palimpsest:visibility' && !message.visible) {
      for (const [id, request] of pending) {
        if (request.mutation) continue
        pending.delete(id)
        request.cleanup()
        host.postMessage({ type: 'palimpsest:cancel', id })
        request.reject(new DOMException('The history view is hidden.', 'AbortError'))
      }
      return
    }
    if (message?.type !== 'palimpsest:response' || typeof message.id !== 'string') return
    const request = pending.get(message.id)
    if (!request || typeof message.status !== 'number') return
    pending.delete(message.id)
    request.cleanup()
    request.resolve({ status: message.status, body: message.body })
  })
}

export function hostRequest(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  if (!host) return Promise.reject(new Error('The VS Code host is unavailable.'))
  if (init?.signal?.aborted) return Promise.reject(new DOMException('Request cancelled.', 'AbortError'))
  if (pending.size >= 32) return Promise.reject(new Error('Too many pending requests. Please retry.'))
  const id = `${session}:${++sequence}`
  return new Promise((resolve, reject) => {
    const cancel = () => {
      pending.delete(id)
      cleanup()
      host.postMessage({ type: 'palimpsest:cancel', id })
      reject(new DOMException('Request cancelled.', 'AbortError'))
    }
    // Large first-time graph scans are allowed to finish; abandoned requests
    // are still bounded and cancelled immediately by their UI subscriber.
    const timer = window.setTimeout(() => {
      pending.delete(id)
      cleanup()
      host.postMessage({ type: 'palimpsest:cancel', id })
      reject(new Error('The Git request timed out. Reopen the repository to retry.'))
    }, 120_000)
    const cleanup = () => {
      window.clearTimeout(timer)
      init?.signal?.removeEventListener('abort', cancel)
    }
    pending.set(id, { resolve, reject, cleanup,
      mutation: init?.method === 'POST' && /^\/api\/workspace\/(stage|unstage|commit|branch|checkout|fetch|pull|push)(?:\?|$)/.test(url),
    })
    init?.signal?.addEventListener('abort', cancel, { once: true })
    host.postMessage({ type: 'palimpsest:request', id, url, method: init?.method ?? 'GET', body: init?.body })
  })
}
