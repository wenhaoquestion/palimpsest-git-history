import { useCallback, useEffect, useRef, useState } from 'react'
import { gitApi, setRepositoryId } from '../lib/api'
import { isVSCode, openInNewWindow, readSavedWorkbench, saveWorkbench } from '../lib/host'
import type { RepositoryPayload, WorkspaceChange, WorkspaceDiff, WorkspaceStatus } from '../types/git'
import { BranchIcon, CheckIcon, CloseIcon, FileIcon, FolderIcon, RefreshIcon } from './icons'
import './GitWorkbench.css'

type Action = Parameters<typeof gitApi.workspaceAction>[0]
type Selection = { path: string; staged: boolean }
interface Props {
  repoPath: string
  repositoryRevision: number
  repositoryLoading: boolean
  repositoryError: string | null
  repoName: string
  onOpenRepository: () => void
  onHistory: () => void
  onRepositoryChanged: () => Promise<RepositoryPayload | null>
  drafts: Map<string, string>
}

function ChangeGroup({ title, items, total, staged, busy, selected, onSelect, onAction }: {
  title: string; items: WorkspaceChange[]; total: number; staged: boolean; busy: boolean
  selected: Selection | null; onSelect: (selection: Selection) => void
  onAction: (action: 'stage' | 'unstage', body: Record<string, unknown>) => void
}) {
  const [limit, setLimit] = useState(60)
  if (!total) return null
  return <section className="git-changes-group" aria-label={title}>
    <h2>{title}<span>{total.toLocaleString()}</span></h2>
    <ul>
      {items.slice(0, limit).map((item) => <li key={item.path}>
        <button type="button" className="git-change-path" title={item.previousPath ? `${item.previousPath} → ${item.path}` : item.path}
          aria-pressed={selected?.path === item.path && selected.staged === staged}
          onClick={() => onSelect({ path: item.path, staged })}>
          <span className="git-change-code" data-status={item.status}>{item.status}</span>
          <span>{item.path}</span>
        </button>
        <button type="button" className="git-file-action" disabled={busy}
          title={`${staged ? 'Unstage' : 'Stage'} ${item.path}`} aria-label={`${staged ? 'Unstage' : 'Stage'} ${item.path}`}
          onClick={() => onAction(staged ? 'unstage' : 'stage', { paths: [item.path] })}>{staged ? '−' : '+'}</button>
      </li>)}
    </ul>
    {limit < items.length ? <button type="button" className="git-show-more" onClick={() => setLimit((count) => count + 100)}>Show more files</button> : null}
  </section>
}

export function GitWorkbench({ repoPath, repositoryRevision, repositoryLoading, repositoryError, repoName, onOpenRepository, onHistory, onRepositoryChanged, drafts }: Props) {
  const [workspace, setWorkspace] = useState<WorkspaceStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<Action | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [remote, setRemote] = useState('')
  const [creatingBranch, setCreatingBranch] = useState(false)
  const [branchName, setBranchName] = useState('')
  const [selected, setSelected] = useState<Selection | null>(null)
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [statusVersion, setStatusVersion] = useState(0)
  const [message, setMessage] = useState(() => {
    const saved = readSavedWorkbench()
    return drafts.get(repoPath) ?? (saved?.repoPath === repoPath ? saved.message : '')
  })
  const mounted = useRef(true)
  const mutation = useRef(false)
  const statusRequest = useRef<AbortController | null>(null)
  const patchRef = useRef<HTMLPreElement>(null)

  const acceptWorkspace = useCallback((next: WorkspaceStatus) => {
    setWorkspace(next)
    setStatusVersion((current) => current + 1)
    setRemote((current) => next.remotes.some((entry) => entry.name === current) ? current
      : next.remotes.find((entry) => next.upstream?.startsWith(`${entry.name}/`))?.name
        ?? next.remotes.find((entry) => entry.name === 'origin')?.name ?? next.remotes[0]?.name ?? '')
  }, [])

  const load = useCallback(async (preserveError = false) => {
    if (!repoPath || mutation.current) return
    statusRequest.current?.abort()
    const controller = new AbortController()
    statusRequest.current = controller
    setLoading(true)
    if (!preserveError) setError(null)
    try {
      const next = await gitApi.workspace(controller.signal)
      if (!controller.signal.aborted) acceptWorkspace(next)
    } catch (cause) {
      if (!controller.signal.aborted && !preserveError) setError(cause instanceof Error ? cause.message : 'Could not read working changes.')
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [acceptWorkspace, repoPath])

  useEffect(() => {
    mounted.current = true
    void load()
    const visible = () => { if (!document.hidden) void load() }
    const onMessage = (event: MessageEvent<{ type?: string; visible?: boolean }>) => {
      if (event.data?.type === 'palimpsest:visibility' && event.data.visible) void load()
    }
    document.addEventListener('visibilitychange', visible)
    window.addEventListener('focus', visible)
    window.addEventListener('message', onMessage)
    return () => {
      mounted.current = false
      statusRequest.current?.abort()
      document.removeEventListener('visibilitychange', visible)
      window.removeEventListener('focus', visible)
      window.removeEventListener('message', onMessage)
    }
  }, [load, repositoryRevision])

  useEffect(() => {
    drafts.set(repoPath, message)
    // One draft survives a VS Code floating-window reload; this is local webview state.
    if (repoPath) saveWorkbench({ repoPath, message })
  }, [drafts, message, repoPath])

  useEffect(() => {
    setDiff(null)
    setDiffError(null)
    if (!selected) { setDiffLoading(false); return }
    const controller = new AbortController()
    setDiffLoading(true)
    void gitApi.workspaceDiff(selected.path, selected.staged, controller.signal).then((next) => {
      if (!controller.signal.aborted) {
        setDiff(next)
        patchRef.current?.scrollTo(0, 0)
      }
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setDiffError(cause instanceof Error ? cause.message : 'Could not read this diff.')
    }).finally(() => { if (!controller.signal.aborted) setDiffLoading(false) })
    return () => controller.abort()
  }, [selected, statusVersion])

  const run = async (action: Action, body: Record<string, unknown>) => {
    if (mutation.current || !workspace) return
    mutation.current = true
    statusRequest.current?.abort()
    setLoading(false)
    setPending(action)
    setError(null)
    setNotice('')
    try {
      const result = await gitApi.workspaceAction(action, body)
      // Mutations are never retried automatically. Their result may have reached Git
      // even when a window was closed or the transport stopped waiting.
      setRepositoryId(result.repositoryId)
      if (!mounted.current) return
      acceptWorkspace(result.workspace)
      setSelected(null)
      setNotice(result.message)
      if (action === 'commit') setMessage('')
      if (action === 'branch') { setCreatingBranch(false); setBranchName('') }
      if (result.repositoryChanged) {
        const refreshed = await onRepositoryChanged()
        if (!refreshed && mounted.current) setError('The operation completed, but history could not refresh. Refresh before continuing.')
      }
    } catch (cause) {
      if (mounted.current) {
        setError(`${cause instanceof Error ? cause.message : 'The operation could not finish.'} Check working changes before retrying.`)
        mutation.current = false
        await load(true)
      }
    } finally {
      mutation.current = false
      if (mounted.current) setPending(null)
    }
  }

  const busy = Boolean(pending)
  const statusLoading = repoPath ? loading : repositoryLoading
  const visibleError = error ?? repositoryError
  const retryStatus = () => { setSelected(null); if (repoPath) void load(); else void onRepositoryChanged() }
  const stagedCount = workspace?.counts.staged ?? 0
  const changedCount = (workspace?.counts.unstaged ?? 0) + (workspace?.counts.untracked ?? 0) + (workspace?.counts.conflicts ?? 0)
  const remoteReady = Boolean(remote && workspace?.branch)
  const currentBranch = workspace?.branches.find((branch) => branch.current)
  const remoteBranch = currentBranch?.remote === remote ? currentBranch.remoteBranch ?? workspace?.branch : workspace?.branch
  const operationLabel: Record<Action, string> = {
    stage: 'Staging changes…', unstage: 'Unstaging changes…', commit: 'Creating commit…',
    branch: 'Creating branch…', checkout: 'Switching branch…', fetch: 'Fetching…', pull: 'Pulling…', push: 'Pushing…',
  }

  return <main className="git-workbench">
    <header className="git-workbench-header">
      <span className="wordmark">PALIMPSEST</span>
      <button type="button" className="git-workbench-repo" title={repoPath} onClick={onOpenRepository} disabled={busy} aria-label="Open or switch repository">
        <FolderIcon /><span>{repoName}</span>
      </button>
      <nav className="git-surface-tabs" aria-label="Git workbench views">
        <button type="button" onClick={onHistory} disabled={busy}>History</button>
        <button type="button" aria-current="page">Changes</button>
      </nav>
      {isVSCode ? <button type="button" className="git-button git-detach" onClick={openInNewWindow} disabled={busy} aria-label="Open in new window" title="Open in new window">↗</button> : null}
    </header>

    <div className="git-workbench-toolbar">
      <div className="git-branch-control">
        <BranchIcon />
        <select aria-label="Current branch" value={workspace?.branch ?? ''} disabled={busy || !workspace}
          onChange={(event) => { if (event.target.value) void run('checkout', { name: event.target.value }) }}>
          {!workspace?.branch ? <option value="">{workspace ? 'Detached HEAD' : 'Loading branch…'}</option> : null}
          {workspace?.branch && !workspace.branches.some((branch) => branch.name === workspace.branch) ? <option value={workspace.branch}>{workspace.branch} · new</option> : null}
          {workspace?.branches.map((branch) => <option key={branch.name} value={branch.name}>{branch.name}</option>)}
        </select>
        <button type="button" className="git-button" disabled={busy || !workspace} onClick={() => setCreatingBranch((current) => !current)} aria-expanded={creatingBranch}>New branch</button>
      </div>
      <div className="git-remote-control">
        {workspace?.remotes.length ? <select aria-label="Remote" value={remote} disabled={busy} onChange={(event) => setRemote(event.target.value)}>
          {workspace.remotes.map((entry) => <option key={entry.name} value={entry.name}>{entry.name}</option>)}
        </select> : <span className="git-no-remote">No remote configured</span>}
        <button type="button" className="git-button" disabled={busy || !remote} onClick={() => void run('fetch', { remote })}>Fetch</button>
        <button type="button" className="git-button" disabled={busy || !remoteReady} onClick={() => void run('pull', { remote, branch: remoteBranch })} title={`Pull ${remote}/${remoteBranch ?? ''} with fast-forward only`}>Pull{workspace?.behind ? ` ↓${workspace.behind}` : ''}</button>
        <button type="button" className="git-button" disabled={busy || !remoteReady} onClick={() => void run('push', { remote, branch: remoteBranch })} title={`Push ${workspace?.branch ?? 'current branch'} to ${remote}/${remoteBranch ?? ''}`}>Push{workspace?.ahead ? ` ↑${workspace.ahead}` : ''}</button>
      </div>
    </div>

    {creatingBranch ? <form className="git-new-branch" onSubmit={(event) => { event.preventDefault(); if (branchName.trim()) void run('branch', { name: branchName.trim(), checkout: true }) }}>
      <label htmlFor="git-new-branch">New branch from current HEAD</label>
      <input id="git-new-branch" value={branchName} onChange={(event) => setBranchName(event.target.value)} placeholder="feature/my-change" autoFocus autoComplete="off" spellCheck={false} maxLength={240} disabled={busy} required />
      <button type="submit" className="git-button git-primary" disabled={busy || !branchName.trim()}>Create & switch</button>
      <button type="button" className="git-button" onClick={() => setCreatingBranch(false)} disabled={busy} aria-label="Cancel new branch"><CloseIcon /></button>
    </form> : null}

    <div className="git-workbench-body" aria-busy={busy}>
      <aside className="git-changes-sidebar" aria-label="Working changes">
        <div className="git-changes-heading"><h1>Working changes</h1>
          <button type="button" className="git-button" aria-label="Refresh working changes" title="Refresh working changes" disabled={busy || statusLoading} onClick={retryStatus}><RefreshIcon /></button>
        </div>
        <div className="git-stage-actions">
          <button type="button" className="git-button" disabled={busy || !changedCount} onClick={() => void run('stage', { all: true })}>Stage all</button>
          <button type="button" className="git-button" disabled={busy || !stagedCount} onClick={() => void run('unstage', { all: true })}>Unstage all</button>
          {statusLoading ? <span role="status">Reading…</span> : null}
        </div>
        <div className="git-file-list">
          {workspace ? <>
            <ChangeGroup title="Staged" items={workspace.staged} total={stagedCount} staged busy={busy} selected={selected} onSelect={setSelected} onAction={(action, body) => void run(action, body)} />
            <ChangeGroup title="Changes" items={workspace.unstaged} total={workspace.counts.unstaged} staged={false} busy={busy} selected={selected} onSelect={setSelected} onAction={(action, body) => void run(action, body)} />
            <ChangeGroup title="Untracked" items={workspace.untracked} total={workspace.counts.untracked} staged={false} busy={busy} selected={selected} onSelect={setSelected} onAction={(action, body) => void run(action, body)} />
            <ChangeGroup title="Conflicts" items={workspace.conflicts} total={workspace.counts.conflicts} staged={false} busy={busy} selected={selected} onSelect={setSelected} onAction={(action, body) => void run(action, body)} />
            {workspace.clean ? <div className="git-clean-state"><CheckIcon /><strong>Working tree clean</strong><span>Changes you make appear here after refresh.</span></div> : null}
            {workspace.truncated ? <p className="git-workbench-hint">Showing a bounded preview of this large change set. Counts and “Stage all” cover the complete working tree.</p> : null}
          </> : <p className="git-workbench-hint">{statusLoading ? 'Reading the working tree…' : 'Open a working repository to manage changes. Bare repositories support history browsing.'}</p>}
        </div>
        <form className="git-commit-form" onSubmit={(event) => { event.preventDefault(); if (message.trim()) void run('commit', { message }) }}>
          <label htmlFor="git-commit-message">Commit message</label>
          <textarea id="git-commit-message" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Describe your changes…" rows={3} maxLength={4000} disabled={busy} />
          <button type="submit" className="git-button git-primary" disabled={busy || !message.trim() || !stagedCount || Boolean(workspace?.counts.conflicts)}>
            <CheckIcon />{pending === 'commit' ? 'Committing…' : `Commit staged${stagedCount ? ` (${stagedCount})` : ''}`}
          </button>
          <span className="git-workbench-hint">{workspace?.counts.conflicts ? 'Resolve conflicts before committing.' : 'Commits use your existing Git identity and hooks.'}</span>
        </form>
      </aside>

      <section className="git-diff-panel" aria-label="Working file diff">
        {selected ? <>
          <header className="git-diff-heading"><FileIcon /><span title={selected.path}>{selected.path}</span><small>{selected.staged ? 'Staged' : 'Working tree'}</small>
            <button type="button" className="git-button" disabled={busy} onClick={() => void run(selected.staged ? 'unstage' : 'stage', { paths: [selected.path] })}>{selected.staged ? 'Unstage' : 'Stage'}</button>
          </header>
          {diffLoading ? <div className="git-diff-empty" role="status">Loading diff…</div>
            : diffError ? <div className="git-diff-empty" role="alert">{diffError}</div>
              : diff ? <>
                {diff.binary ? <div className="git-diff-empty">Binary file · no text preview</div>
                  : <pre ref={patchRef} className="git-diff-patch" tabIndex={0} aria-label={`Diff for ${selected.path}`}>{diff.patch || 'No text changes in this comparison.'}</pre>}
                {diff.truncated ? <p className="git-diff-truncated">Preview truncated. Staging and committing still use the complete file.</p> : null}
              </> : null}
        </> : <div className="git-diff-empty"><BranchIcon /><h2>Your repository, ready to work.</h2><p>Select a file to review its diff.<br />Stage changes, write a message, and commit.</p><button type="button" className="git-button" onClick={onHistory} disabled={busy}>Explore history →</button></div>}
      </section>
    </div>
    <footer className="git-workbench-footer">
      <span className={visibleError ? 'git-operation-error' : ''} role={visibleError ? 'alert' : 'status'}>{visibleError ?? (pending ? operationLabel[pending] : notice || (workspace?.upstream ? `Tracking ${workspace.upstream}` : 'Local changes · ready'))}</span>
      {visibleError ? <button type="button" className="git-button" disabled={busy} onClick={retryStatus}>Refresh status</button> : null}
    </footer>
  </main>
}
