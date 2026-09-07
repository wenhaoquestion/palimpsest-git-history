import { isLinuxHistorySite } from '../lib/site'
import { RefreshIcon, RepoIcon } from './icons'

interface EmptyInspectorProps {
  displayPath: string
  isRefreshing: boolean
  onRefresh: () => void
  onOpenGuide: () => void
  onOpenRepository: () => void
  message?: string
  isGitRepository?: boolean
}

export function EmptyInspector({
  displayPath,
  isRefreshing,
  onRefresh,
  onOpenGuide,
  onOpenRepository,
  message,
  isGitRepository,
}: EmptyInspectorProps) {
  return (
    <aside className="empty-inspector" aria-labelledby="empty-title">
      <RepoIcon />
      <h1 id="empty-title">{isLinuxHistorySite ? 'Linux history is getting ready' : isGitRepository ? 'No commits yet' : 'Explore any Git project'}</h1>
      <p>{message || 'Open a local repository to explore its files, branches, and changes through time.'}</p>
      <div className="empty-path" title={displayPath}>
        {displayPath}
      </div>
      {isLinuxHistorySite ? <p className="empty-guidance">This archive follows torvalds/linux. Reload the page after the history service is ready.</p> : <>
      <p className="empty-guidance">{isGitRepository ? 'Create a commit in this repository, then refresh.' : 'Choose a repository folder on this computer.'}</p>
      <button className="refresh-button" type="button" onClick={onOpenRepository}>Open repository</button>
      <button className="refresh-button" type="button" onClick={onRefresh} disabled={isRefreshing}>
        <RefreshIcon className={isRefreshing ? 'is-spinning' : ''} />
        {isRefreshing ? 'Checking…' : 'Check again'}
      </button>
      <button className="guide-button" type="button" onClick={onOpenGuide}>
        Setup guide <span aria-hidden="true">→</span>
      </button>
      </>}
    </aside>
  )
}

export function LoadingRepository() {
  return (
    <div className="loading-state" role="status" aria-live="polite">
      <span className="loading-datum" aria-hidden="true" />
      <span>{isLinuxHistorySite ? 'Indexing Linux’s complete Git history…' : 'Surveying repository history…'}</span>
    </div>
  )
}

interface ToastProps {
  message: string
  tone?: 'default' | 'error'
}

export function StatusToast({ message, tone = 'default' }: ToastProps) {
  return (
    <div className={`status-toast status-toast--${tone}`} role="status">
      {message}
    </div>
  )
}
