import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'
import type {
  CommitDetails,
  CommitSummary,
  DiffPayload,
  FileChange,
  FileHistoryEntry,
  TreeFile,
} from '../types/git'
import {
  ArrowRightIcon,
  BranchIcon,
  CheckIcon,
  ChevronLeftIcon,
  CloseIcon,
  CodeIcon,
  CopyIcon,
  FileIcon,
  FolderIcon,
  HistoryIcon,
  MergeIcon,
  SearchIcon,
  TagIcon,
  UserIcon,
} from './icons'

export type InspectorTab = 'diff' | 'history'
export type InspectorSelectionKind = 'file' | 'directory'

export interface InspectorPageInfo {
  total: number
  loaded: number
  hasMore: boolean
  loading?: boolean
  error?: string | null
  exact?: boolean
}

export interface InspectorProps {
  commit: CommitSummary | null
  details?: CommitDetails | null
  diff?: DiffPayload | null
  history?: readonly FileHistoryEntry[]
  selectedPath?: string | null
  selectedKind?: InspectorSelectionKind
  activeTab?: InspectorTab
  commitIndex?: number
  totalCommits?: number
  parentIndex?: number
  loading?: boolean
  detailsLoading?: boolean
  diffLoading?: boolean
  historyLoading?: boolean
  error?: string | null
  diffError?: string | null
  historyError?: string | null
  treePageInfo?: InspectorPageInfo | null
  changesPageInfo?: InspectorPageInfo | null
  maxDiffLines?: number
  maxChangedFiles?: number
  className?: string
  onSelectPath?: (path: string, kind: InspectorSelectionKind) => void
  onTabChange?: (tab: InspectorTab) => void
  onParentIndexChange?: (parentIndex: number) => void
  onSelectHistoryCommit?: (entry: FileHistoryEntry) => void
  onLoadMoreTree?: () => void
  onLoadMoreChanges?: () => void
  onRetry?: () => void
  onClose?: () => void
}

type DiffLineKind = 'meta' | 'hunk' | 'addition' | 'deletion' | 'context' | 'notice'

interface ParsedDiffLine {
  kind: DiffLineKind
  text: string
  oldLine: number | null
  newLine: number | null
}

interface SnapshotEntry {
  kind: InspectorSelectionKind
  path: string
  name: string
  file?: TreeFile
}

const STATUS_LABELS: Record<FileChange['status'], string> = {
  A: 'Added',
  M: 'Modified',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  T: 'Type changed',
  U: 'Unmerged',
}

function joinClassNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ')
}

function normalizePath(path: string) {
  const normalized = path.replace(/^\/+|\/+$/g, '')
  return normalized === '.' ? '' : normalized
}

function parentDirectory(path: string) {
  const normalized = normalizePath(path)
  const separator = normalized.lastIndexOf('/')
  return separator < 0 ? '' : normalized.slice(0, separator)
}

function baseName(path: string) {
  const normalized = normalizePath(path)
  return normalized.slice(normalized.lastIndexOf('/') + 1) || 'Repository root'
}

function compactRefName(value: string) {
  return value
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\//, '')
    .replace(/^refs\/tags\//, '')
    .replace(/^tag:\s*/, '')
}

function looksLikeTag(value: string) {
  return /^refs\/tags\//.test(value) || /^tag:\s*/.test(value) || /^v?\d+\.\d+/.test(compactRefName(value))
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function formatBytes(value: number | null | undefined) {
  if (value === null || value === undefined) return 'Size unavailable'
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB']
  let size = value / 1024
  let unit = units[0]
  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024
    unit = units[index]
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${unit}`
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return `${parts[0][0] ?? ''}${parts.length > 1 ? parts[parts.length - 1][0] ?? '' : ''}`.toUpperCase()
}

export function parseUnifiedDiff(patch: string): ParsedDiffLine[] {
  let oldLine = 0
  let newLine = 0

  const sourceLines = patch.endsWith('\n') ? patch.slice(0, -1).split('\n') : patch.split('\n')
  return sourceLines.map((text) => {
    const hunk = text.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      return { kind: 'hunk', text, oldLine: null, newLine: null }
    }
    if (
      text.startsWith('diff --git ') ||
      text.startsWith('index ') ||
      text.startsWith('--- ') ||
      text.startsWith('+++ ') ||
      text.startsWith('new file mode ') ||
      text.startsWith('deleted file mode ') ||
      text.startsWith('similarity index ') ||
      text.startsWith('rename from ') ||
      text.startsWith('rename to ')
    ) {
      return { kind: 'meta', text, oldLine: null, newLine: null }
    }
    if (text.startsWith('\\ No newline at end of file')) {
      return { kind: 'notice', text, oldLine: null, newLine: null }
    }
    if (text.startsWith('+')) {
      const line = newLine
      newLine += 1
      return { kind: 'addition', text, oldLine: null, newLine: line }
    }
    if (text.startsWith('-')) {
      const line = oldLine
      oldLine += 1
      return { kind: 'deletion', text, oldLine: line, newLine: null }
    }
    const previousOldLine = oldLine
    const previousNewLine = newLine
    oldLine += 1
    newLine += 1
    return { kind: 'context', text, oldLine: previousOldLine, newLine: previousNewLine }
  })
}

function snapshotEntries(tree: readonly TreeFile[], directory: string): SnapshotEntry[] {
  const normalizedDirectory = normalizePath(directory)
  const prefix = normalizedDirectory ? `${normalizedDirectory}/` : ''
  const entries = new Map<string, SnapshotEntry>()

  tree.forEach((file) => {
    const filePath = normalizePath(file.path)
    if (prefix && !filePath.startsWith(prefix)) return
    const remainder = prefix ? filePath.slice(prefix.length) : filePath
    if (!remainder) return
    const [name, ...rest] = remainder.split('/')
    const path = prefix ? `${normalizedDirectory}/${name}` : name
    if (rest.length || file.type === 'tree') {
      entries.set(path, { kind: 'directory', name, path })
    } else if (!entries.has(path)) {
      entries.set(path, { kind: 'file', name, path, file })
    }
  })

  return [...entries.values()].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
  })
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="inspector__loading" role="status" aria-live="polite">
      <span className="inspector__loading-mark" aria-hidden="true" />
      <span>{label}</span>
    </div>
  )
}

function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="inspector__error" role="alert">
      <strong>Couldn’t load this view</strong>
      <span>{message}</span>
      {onRetry ? (
        <button type="button" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  )
}

export function Inspector({
  commit,
  details = null,
  diff = null,
  history = [],
  selectedPath,
  selectedKind,
  activeTab,
  commitIndex,
  totalCommits,
  parentIndex = 0,
  loading = false,
  detailsLoading = false,
  diffLoading = false,
  historyLoading = false,
  error,
  diffError,
  historyError,
  treePageInfo,
  changesPageInfo,
  maxDiffLines = 800,
  maxChangedFiles = 300,
  className = '',
  onSelectPath,
  onTabChange,
  onParentIndexChange,
  onSelectHistoryCommit,
  onLoadMoreTree,
  onLoadMoreChanges,
  onRetry,
  onClose,
}: InspectorProps) {
  const [internalPath, setInternalPath] = useState<string | null>(selectedPath ?? null)
  const [internalKind, setInternalKind] = useState<InspectorSelectionKind>(selectedKind ?? 'file')
  const [internalTab, setInternalTab] = useState<InspectorTab>(activeTab ?? 'diff')
  const [fileQuery, setFileQuery] = useState('')
  const [visibleChangeLimit, setVisibleChangeLimit] = useState(Math.max(1, maxChangedFiles))
  const [visibleEntryLimit, setVisibleEntryLimit] = useState(100)
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<number | null>(null)
  const changedFilesTitleId = useId()
  const diffTabId = useId()
  const historyTabId = useId()
  const diffPanelId = useId()
  const historyPanelId = useId()

  const path = selectedPath === undefined ? internalPath : selectedPath
  const kind = selectedKind ?? internalKind
  const tab = activeTab ?? internalTab
  const commitDetails = details?.oid === commit?.oid ? details : null

  useEffect(() => {
    if (selectedPath !== undefined) setInternalPath(selectedPath)
  }, [selectedPath])

  useEffect(() => {
    if (selectedKind) setInternalKind(selectedKind)
  }, [selectedKind])

  useEffect(() => {
    if (activeTab) setInternalTab(activeTab)
  }, [activeTab])

  useEffect(() => {
    setFileQuery('')
    setCopied(false)
    setVisibleChangeLimit(Math.max(1, maxChangedFiles))
    setVisibleEntryLimit(100)
    if (selectedPath === undefined) {
      setInternalPath(null)
      setInternalKind('file')
    }
  }, [commit?.oid, maxChangedFiles, selectedPath])

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current)
    },
    [],
  )

  useEffect(() => {
    if (selectedPath !== undefined || internalPath || !commitDetails?.changes.length) return
    setInternalPath(commitDetails.changes[0].path)
    setInternalKind('file')
  }, [commitDetails, internalPath, selectedPath])

  const selectPath = (nextPath: string, nextKind: InspectorSelectionKind) => {
    if (selectedPath === undefined) setInternalPath(nextPath)
    if (selectedKind === undefined) setInternalKind(nextKind)
    onSelectPath?.(nextPath, nextKind)
  }

  const selectTab = (nextTab: InspectorTab) => {
    if (activeTab === undefined) setInternalTab(nextTab)
    onTabChange?.(nextTab)
  }

  const selectedFile = useMemo(
    () => (path ? commitDetails?.tree.find((file) => normalizePath(file.path) === normalizePath(path)) : undefined),
    [commitDetails?.tree, path],
  )
  const activeDirectory = kind === 'directory' ? normalizePath(path ?? '') : selectedFile?.directory ?? parentDirectory(path ?? '')
  const entries = useMemo(
    () => snapshotEntries(commitDetails?.tree ?? [], activeDirectory),
    [activeDirectory, commitDetails?.tree],
  )
  const visibleEntries = entries.slice(0, visibleEntryLimit)
  const changes = commitDetails?.changes ?? []
  const filteredChanges = useMemo(() => {
    const query = fileQuery.trim().toLocaleLowerCase()
    if (!query) return changes
    return changes.filter(
      (change) =>
        change.path.toLocaleLowerCase().includes(query) ||
        change.previousPath?.toLocaleLowerCase().includes(query) ||
        STATUS_LABELS[change.status].toLocaleLowerCase().includes(query),
    )
  }, [changes, fileQuery])
  const visibleChanges = filteredChanges.slice(0, visibleChangeLimit)
  const stats = commitDetails?.stats ?? commit?.stats ?? null
  const totalLines = stats ? stats.additions + stats.deletions : 0
  const additionShare = totalLines ? (stats!.additions / totalLines) * 100 : 0
  const parsedDiff = useMemo(() => parseUnifiedDiff(diff?.patch ?? ''), [diff?.patch])
  const visibleDiff = parsedDiff.slice(0, Math.max(1, maxDiffLines))

  const revealMoreChanges = () => {
    const nextLimit = Math.min(
      visibleChangeLimit + Math.max(1, maxChangedFiles),
      filteredChanges.length,
    )
    if (nextLimit > visibleChangeLimit) setVisibleChangeLimit(nextLimit)
    if (nextLimit >= filteredChanges.length && changesPageInfo?.hasMore) onLoadMoreChanges?.()
  }

  const revealMoreEntries = () => {
    const nextLimit = Math.min(visibleEntryLimit + 100, entries.length)
    if (nextLimit > visibleEntryLimit) setVisibleEntryLimit(nextLimit)
    if (nextLimit >= entries.length && treePageInfo?.hasMore) onLoadMoreTree?.()
  }

  const copyOid = async () => {
    if (!commit) return
    try {
      await navigator.clipboard.writeText(commit.oid)
      setCopied(true)
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current)
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  if (loading) {
    return (
      <aside className={joinClassNames('inspector', className)} aria-label="Commit inspector">
        <LoadingState label="Loading commit…" />
      </aside>
    )
  }

  if (error) {
    return (
      <aside className={joinClassNames('inspector', className)} aria-label="Commit inspector">
        <ErrorState message={error} onRetry={onRetry} />
      </aside>
    )
  }

  if (!commit) {
    return (
      <aside className={joinClassNames('inspector', 'inspector--empty', className)} aria-label="Commit inspector">
        <div className="inspector__empty">
          <CodeIcon size={24} />
          <strong>Select a commit to inspect it</strong>
          <span>Its files, refs, history, and diff will appear here.</span>
        </div>
      </aside>
    )
  }

  const refs = Array.from(
    new Map(commit.directRefs.map((ref) => [compactRefName(ref), ref])).values(),
  )

  return (
    <aside className={joinClassNames('inspector', className)} aria-label={`Inspect commit ${commit.shortOid}`}>
      <header className="inspector__header">
        <div className="inspector__header-row">
          <span className="inspector__eyebrow">Commit</span>
          <div className="inspector__header-actions">
            {typeof commitIndex === 'number' && typeof totalCommits === 'number' ? (
              <span className="inspector__position">
                {(commitIndex + 1).toLocaleString()} of {totalCommits.toLocaleString()}
              </span>
            ) : null}
            {onClose ? (
              <button type="button" className="inspector__close" onClick={onClose} aria-label="Close inspector">
                <CloseIcon size={17} />
              </button>
            ) : null}
          </div>
        </div>

        <h2 className="inspector__subject">{commit.subject || 'Untitled commit'}</h2>
        {commit.body ? <p className="inspector__body">{commit.body}</p> : null}

        <button type="button" className="inspector__oid" onClick={copyOid} aria-label={`Copy full commit ID ${commit.oid}`}>
          <code>{commit.shortOid}</code>
          {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          <span className="inspector__copy-label" aria-live="polite">
            {copied ? 'Copied' : 'Copy SHA'}
          </span>
        </button>

        <div className="inspector__author-row">
          <span className="inspector__avatar" aria-hidden="true">
            {initials(commit.author.name)}
          </span>
          <span className="inspector__author">
            <strong>{commit.author.name}</strong>
            <span>{commit.author.email}</span>
          </span>
          <time className="inspector__timestamp" dateTime={commit.authoredAt}>
            {formatDate(commit.authoredAt)}
          </time>
        </div>

        {refs.length ? (
          <div className="inspector__refs" aria-label="Branches and tags pointing to this commit">
            {refs.map((ref) => {
              const tag = looksLikeTag(ref)
              return (
                <span className="inspector__ref" data-kind={tag ? 'tag' : 'branch'} key={ref}>
                  {tag ? <TagIcon size={13} /> : <BranchIcon size={13} />}
                  {compactRefName(ref)}
                </span>
              )
            })}
          </div>
        ) : null}

        {commit.branches.length ? (
          <div className="inspector__containment" title={commit.branches.join(', ')}>
            Contained in {commit.branches.slice(0, 3).join(', ')}
            {commit.branches.length > 3 ? ` +${commit.branches.length - 3}` : ''}
          </div>
        ) : null}

        {commit.parents.length > 1 ? (
          <div className="inspector__parents">
            <span className="inspector__parents-label">
              <MergeIcon size={14} /> Merge diff against
            </span>
            <div className="inspector__parent-options" role="group" aria-label="Merge parent for diff">
              {commit.parents.map((parent, index) => (
                <button
                  type="button"
                  data-active={index === parentIndex || undefined}
                  aria-pressed={index === parentIndex}
                  onClick={() => onParentIndexChange?.(index)}
                  key={parent}
                >
                  Parent {index + 1} · {parent.slice(0, commit.shortOid.length)}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {stats ? (
          <div className="inspector__stats" aria-label={`${stats.additions} additions and ${stats.deletions} deletions across ${stats.files} files`}>
            <span className="inspector__stat inspector__stat--add">+{stats.additions.toLocaleString()}</span>
            <span className="inspector__stat-bar" aria-hidden="true">
              <span className="inspector__stat-bar-add" style={{ width: `${additionShare}%` }} />
              <span
                className="inspector__stat-bar-delete"
                style={{ width: `${totalLines ? 100 - additionShare : 0}%` }}
              />
            </span>
            <span className="inspector__stat inspector__stat--delete">−{stats.deletions.toLocaleString()}</span>
          </div>
        ) : null}
      </header>

      <section className="inspector__changes" aria-labelledby={changedFilesTitleId}>
        <div className="inspector__section-heading">
          <h3 id={changedFilesTitleId}>Changed files</h3>
          <span>
            {detailsLoading
              ? '…'
              : `${(changesPageInfo?.total ?? changes.length).toLocaleString()} ${(changesPageInfo?.total ?? changes.length) === 1 ? 'file' : 'files'}`}
          </span>
        </div>
        {detailsLoading ? (
          <LoadingState label="Reading changed files…" />
        ) : commitDetails ? (
          <>
            {changes.length > 12 ? (
              <label className="inspector__file-search">
                <span className="sr-only">Search changed files</span>
                <SearchIcon size={14} />
                <input
                  type="search"
                  value={fileQuery}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => setFileQuery(event.currentTarget.value)}
                  placeholder="Find a changed path"
                />
                {fileQuery ? (
                  <button type="button" onClick={() => setFileQuery('')} aria-label="Clear file search">
                    <CloseIcon size={12} />
                  </button>
                ) : null}
              </label>
            ) : null}
            {filteredChanges.length ? (
              <ul className="inspector__change-list">
                {visibleChanges.map((change) => {
                  const selected = kind === 'file' && normalizePath(path ?? '') === normalizePath(change.path)
                  const statsAvailable = change.additions !== null && change.deletions !== null
                  return (
                    <li key={change.id}>
                      <button
                        type="button"
                        className="inspector__change"
                        data-status={change.status}
                        data-selected={selected || undefined}
                        aria-pressed={selected}
                        onClick={() => selectPath(change.path, 'file')}
                      >
                        <span className="inspector__change-status" title={STATUS_LABELS[change.status]}>
                          {change.status}
                        </span>
                        <span className="inspector__change-path">
                          {change.previousPath ? (
                            <>
                              <span>{change.previousPath}</span>
                              <ArrowRightIcon size={12} />
                            </>
                          ) : null}
                          <span>{change.path}</span>
                        </span>
                        <span className="inspector__change-stats" aria-label={statsAvailable ? `${change.additions} additions and ${change.deletions} deletions` : 'Binary or unavailable statistics'}>
                          {statsAvailable ? (
                            <>
                              <span className="inspector__change-add">+{change.additions}</span>
                              <span className="inspector__change-delete">−{change.deletions}</span>
                            </>
                          ) : (
                            <span>{change.binary ? 'BIN' : '—'}</span>
                          )}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <div className="inspector__section-empty">
                {fileQuery ? 'No changed paths match this search.' : 'This commit contains no file changes.'}
              </div>
            )}
            {filteredChanges.length > visibleChanges.length || changesPageInfo?.hasMore ? (
              <div className="inspector__page-note" role="status">
                <span>
                  Showing {visibleChanges.length.toLocaleString()} of{' '}
                  {(fileQuery ? filteredChanges.length : changesPageInfo?.total ?? filteredChanges.length).toLocaleString()}
                  {fileQuery && changesPageInfo?.hasMore ? ' loaded matches' : ' changed paths'}.
                </span>
                <button
                  type="button"
                  onClick={revealMoreChanges}
                  disabled={changesPageInfo?.loading}
                >
                  {changesPageInfo?.loading
                    ? 'Loading…'
                    : changesPageInfo?.hasMore
                      ? changesPageInfo.exact ? 'Load more' : 'Load exact paths'
                      : 'Show more'}
                </button>
              </div>
            ) : null}
            {changesPageInfo?.error ? (
              <p className="inspector__overflow-note" role="alert">{changesPageInfo.error}</p>
            ) : null}
          </>
        ) : (
          <div className="inspector__section-empty">Change details are not loaded.</div>
        )}
      </section>

      {commitDetails?.tree ? (
        <details className="inspector__snapshot" open={kind === 'directory' || undefined}>
          <summary>
            <span>
              <FolderIcon size={14} /> Snapshot at this commit
            </span>
            <span>{(treePageInfo?.total ?? commitDetails.tree.length).toLocaleString()} items here</span>
          </summary>
          <div className="inspector__snapshot-content">
            <nav className="inspector__breadcrumbs" aria-label="Snapshot directory">
              <button type="button" data-active={!activeDirectory || undefined} onClick={() => selectPath('', 'directory')}>
                root
              </button>
              {normalizePath(activeDirectory)
                .split('/')
                .filter(Boolean)
                .map((segment, index, parts) => {
                  const segmentPath = parts.slice(0, index + 1).join('/')
                  return (
                    <span key={segmentPath}>
                      <span aria-hidden="true">/</span>
                      <button type="button" onClick={() => selectPath(segmentPath, 'directory')}>
                        {segment}
                      </button>
                    </span>
                  )
                })}
            </nav>

            {path ? (
              <div className="inspector__selection-state" data-kind={kind}>
                {kind === 'directory' ? <FolderIcon size={17} /> : <FileIcon size={17} />}
                <span>
                  <strong>{baseName(path)}</strong>
                  <span>{path}</span>
                </span>
                {kind === 'file' ? (
                  <span className="inspector__file-meta">
                    {selectedFile ? `${formatBytes(selectedFile.size)} · ${selectedFile.mode}` : 'Not present in this snapshot'}
                  </span>
                ) : null}
              </div>
            ) : null}

            {activeDirectory ? (
              <button
                type="button"
                className="inspector__snapshot-up"
                onClick={() => selectPath(parentDirectory(activeDirectory), 'directory')}
              >
                <ChevronLeftIcon size={13} /> Up to {parentDirectory(activeDirectory) || 'root'}
              </button>
            ) : null}

            {treePageInfo?.loading && !entries.length ? (
              <LoadingState label="Reading this directory…" />
            ) : entries.length ? (
              <ul className="inspector__snapshot-list">
                {visibleEntries.map((entry) => (
                  <li key={`${entry.kind}-${entry.path}`}>
                    <button
                      type="button"
                      data-kind={entry.kind}
                      data-selected={normalizePath(path ?? '') === entry.path || undefined}
                      onClick={() => selectPath(entry.path, entry.kind)}
                    >
                      {entry.kind === 'directory' ? <FolderIcon size={14} /> : <FileIcon size={14} />}
                      <span>{entry.name}</span>
                      {entry.file ? <span>{formatBytes(entry.file.size)}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="inspector__section-empty">This directory is empty.</div>
            )}
            {entries.length > visibleEntries.length || treePageInfo?.hasMore ? (
              <div className="inspector__page-note" role="status">
                <span>
                  Showing {visibleEntries.length.toLocaleString()} of{' '}
                  {(treePageInfo?.total ?? entries.length).toLocaleString()} entries.
                </span>
                <button
                  type="button"
                  onClick={revealMoreEntries}
                  disabled={treePageInfo?.loading}
                >
                  {treePageInfo?.loading ? 'Loading…' : 'Load more'}
                </button>
              </div>
            ) : null}
            {treePageInfo?.error ? (
              <p className="inspector__overflow-note" role="alert">{treePageInfo.error}</p>
            ) : null}
          </div>
        </details>
      ) : null}

      <section className="inspector__detail" aria-label="Selected file detail">
        <div className="inspector__tabs" role="tablist" aria-label="File inspection mode">
          <button
            type="button"
            role="tab"
            id={diffTabId}
            aria-controls={diffPanelId}
            aria-selected={tab === 'diff'}
            data-active={tab === 'diff' || undefined}
            onClick={() => selectTab('diff')}
          >
            <CodeIcon size={14} /> Diff
          </button>
          <button
            type="button"
            role="tab"
            id={historyTabId}
            aria-controls={historyPanelId}
            aria-selected={tab === 'history'}
            data-active={tab === 'history' || undefined}
            onClick={() => selectTab('history')}
          >
            <HistoryIcon size={14} /> History
          </button>
        </div>

        <div className="inspector__detail-heading">
          {kind === 'directory' ? <FolderIcon size={15} /> : <FileIcon size={15} />}
          <span title={path ?? undefined}>{path === '.' ? 'Repository root' : path || 'Select a structure'}</span>
        </div>

        {tab === 'diff' ? (
          <div
            className="inspector__tab-panel"
            id={diffPanelId}
            role="tabpanel"
            aria-labelledby={diffTabId}
          >
            {!path ? (
              <div className="inspector__section-empty">Select a file or directory to inspect its diff.</div>
            ) : diffLoading ? (
              <LoadingState label={`Loading diff for ${path}…`} />
            ) : diffError ? (
              <ErrorState message={diffError} onRetry={onRetry} />
            ) : !diff ? (
              <div className="inspector__section-empty">
                Select a changed file or choose Diff to load its changes.
              </div>
            ) : diff?.binary ? (
              <div className="inspector__binary-state">
                <FileIcon size={22} />
                <strong>Binary file changed</strong>
                <span>A textual diff is not available for this file.</span>
              </div>
            ) : diff && diff.oid === commit.oid && diff.path === path && diff.patch ? (
              <>
                <div className="inspector__diff" role="table" aria-label={`Unified diff for ${path}`}>
                  {visibleDiff.map((line, index) => (
                    <div className="inspector__diff-line" data-kind={line.kind} role="row" key={`${index}-${line.text}`}>
                      <span className="inspector__line-number" role="cell" aria-label={line.oldLine === null ? undefined : `Old line ${line.oldLine}`}>
                        {line.oldLine ?? ''}
                      </span>
                      <span className="inspector__line-number" role="cell" aria-label={line.newLine === null ? undefined : `New line ${line.newLine}`}>
                        {line.newLine ?? ''}
                      </span>
                      <code role="cell">{line.text || ' '}</code>
                    </div>
                  ))}
                </div>
                {diff.truncated || parsedDiff.length > visibleDiff.length ? (
                  <p className="inspector__diff-truncated">
                    Diff truncated after {visibleDiff.length.toLocaleString()} lines for smooth rendering.
                  </p>
                ) : null}
              </>
            ) : (
              <div className="inspector__section-empty">No textual change for this path in the selected commit.</div>
            )}
          </div>
        ) : (
          <div
            className="inspector__tab-panel"
            id={historyPanelId}
            role="tabpanel"
            aria-labelledby={historyTabId}
          >
            {!path ? (
              <div className="inspector__section-empty">Select a file or directory to trace its history.</div>
            ) : historyLoading ? (
              <LoadingState label={`Tracing history for ${path}…`} />
            ) : historyError ? (
              <ErrorState message={historyError} onRetry={onRetry} />
            ) : history.length ? (
              <ol className="inspector__history-list">
                {history.map((entry, index) => (
                  <li key={`${entry.oid}-${index}`} data-current={entry.oid === commit.oid || undefined}>
                    <span className="inspector__history-node" aria-hidden="true" />
                    <button type="button" onClick={() => onSelectHistoryCommit?.(entry)}>
                      <span className="inspector__history-topline">
                        <code>{entry.shortOid}</code>
                        <time dateTime={entry.authoredAt}>{formatDate(entry.authoredAt)}</time>
                      </span>
                      <strong>{entry.subject || 'Untitled commit'}</strong>
                      <span className="inspector__history-author">
                        <UserIcon size={12} /> {entry.author}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="inspector__section-empty">No earlier history was found for this path.</div>
            )}
          </div>
        )}
      </section>
    </aside>
  )
}
