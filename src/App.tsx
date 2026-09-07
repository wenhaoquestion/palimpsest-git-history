import { isLinuxHistorySite } from './lib/site'
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { AppHeader } from './components/AppHeader'
import { CommitRail } from './components/CommitRail'
import {
  EMPTY_GIT_FILTERS,
  FilterPanel,
  countActiveFilters,
  type GitFilterState,
} from './components/FilterPanel'
import { HelpOverlay } from './components/HelpOverlay'
import { Inspector, type InspectorTab } from './components/Inspector'
import { PlaybackBar, type TimelineTick } from './components/PlaybackBar'
import { RepositoryCanvas } from './components/RepositoryCanvas'
import { RepositoryPicker } from './components/RepositoryPicker'
import {
  EmptyInspector,
  LoadingRepository,
  StatusToast,
} from './components/RepositoryState'
import {
  clearCommitCaches,
  prefetchCommits,
  useCommitChanges,
  useCommitDetails,
  useDirectoryTree,
  useFileInspection,
} from './hooks/useCommitResource'
import { useCommitTimeline } from './hooks/useCommitTimeline'
import { useReducedMotion } from './hooks/useReducedMotion'
import { useRepository } from './hooks/useRepository'
import { isVSCode, pickRepository, readSavedView, saveView } from './lib/host'
import type { CommitSummary, RepositoryPayload, TreeFile } from './types/git'

const PLAYBACK_INTERVAL = 1500

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  const tagName = target.tagName.toLowerCase()
  return target.isContentEditable || ['input', 'textarea', 'select', 'button'].includes(tagName)
}

function matchesMetadataFilters(
  commit: CommitSummary,
  filters: GitFilterState,
) {
  if (filters.query) {
    const query = filters.query.toLocaleLowerCase()
    const haystack = `${commit.subject}\n${commit.body}\n${commit.oid}\n${commit.shortOid}\n${commit.author.name}\n${commit.author.email}`.toLocaleLowerCase()
    if (!haystack.includes(query)) return false
  }
  if (filters.author && commit.author.name !== filters.author) return false
  const commitDay = commit.authoredAt.slice(0, 10)
  if (filters.fromDate && commitDay < filters.fromDate) return false
  if (filters.toDate && commitDay > filters.toDate) return false
  return true
}

function hasMetadataFilters(filters: GitFilterState) {
  return Boolean(filters.query || filters.author || filters.fromDate || filters.toDate)
}

function shortBoundaryDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.slice(0, 10)
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short' }).format(date)
}

function filterTree(files: TreeFile[], filters: GitFilterState) {
  if (!filters.fileType && !filters.directory) return files
  return files.filter((file) => {
    if (filters.fileType && file.extension !== filters.fileType) return false
    if (
      filters.directory &&
      file.directory !== filters.directory &&
      !file.directory.startsWith(`${filters.directory}/`)
    ) {
      return false
    }
    return true
  })
}

function directoryForSelection(path: string | null, kind: 'file' | 'directory') {
  const normalized = (path ?? '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')
  if (kind === 'directory') return normalized || '.'
  const separator = normalized.lastIndexOf('/')
  return separator < 0 ? '.' : normalized.slice(0, separator) || '.'
}

function EmptyCommitRail() {
  return (
    <div className="empty-commit-rail" aria-label="Empty commit history">
      <div className="rail-title"><span>Commits</span><span>—</span></div>
      <div className="empty-rail-line" aria-hidden="true" />
      <div className="empty-rail-count">0 / 0 commits</div>
    </div>
  )
}

function EmptyPlayback() {
  return (
    <div className="empty-playback" aria-label="Playback unavailable" aria-disabled="true">
      <div className="empty-transport" aria-hidden="true">
        <span>↺</span><span>◀</span><span>▶</span><span>▶|</span>
      </div>
      <span className="empty-counter">0 / 0 commits</span>
      <span className="empty-scrubber" aria-hidden="true" />
      <span className="empty-status">Awaiting history</span>
    </div>
  )
}

interface InactiveShellProps {
  payload: Exclude<RepositoryPayload, { status: 'ready' }> | null
  loading: boolean
  refreshing: boolean
  error: string | null
  mode: 'overview' | 'inspect'
  helpOpen: 'help' | 'setup' | null
  onSetMode: (mode: 'overview' | 'inspect') => void
  onRefresh: () => void
  onOpenHelp: (kind: 'help' | 'setup') => void
  onCloseHelp: () => void
  onOpenRepository: () => void
}

function InactiveShell({
  payload,
  loading,
  refreshing,
  error,
  mode,
  helpOpen,
  onSetMode,
  onRefresh,
  onOpenHelp,
  onCloseHelp,
  onOpenRepository,
}: InactiveShellProps) {
  const fallbackName = payload?.repoName ?? (isLinuxHistorySite ? 'torvalds/linux' : 'Local repository')
  const displayPath = payload?.displayPath ?? 'Current working directory'

  return (
    <main className={`app-shell${mode === 'overview' ? ' is-overview' : ''}`}>
      <AppHeader
        repo={null}
        fallbackName={fallbackName}
        mode={mode}
        filtersActive={false}
        disabled
        onOpenFilters={() => undefined}
        onSetMode={onSetMode}
        onOpenHelp={() => onOpenHelp('help')}
        onOpenRepository={onOpenRepository}
      />
      <div className="workspace">
        <div className="commit-column"><EmptyCommitRail /></div>
        <section className="visualization-stage" aria-label="Repository landscape">
          {loading ? (
            <LoadingRepository />
          ) : (
            <RepositoryCanvas
              files={[]}
              changes={[]}
              selectedPath={null}
              selectedDirectory={null}
              onSelectFile={() => undefined}
              onSelectDirectory={() => undefined}
              reducedMotion
              focusMode={mode}
            />
          )}
        </section>
        {mode === 'inspect' ? (
          <EmptyInspector
            displayPath={displayPath}
            isRefreshing={refreshing}
            onRefresh={onRefresh}
            onOpenGuide={() => onOpenHelp('setup')}
            onOpenRepository={onOpenRepository}
            message={payload?.message}
            isGitRepository={payload?.status === 'empty'}
          />
        ) : null}
      </div>
      <div className="playback-region"><EmptyPlayback /></div>
      {error ? <StatusToast message={error} tone="error" /> : null}
      <HelpOverlay open={helpOpen !== null} kind={helpOpen ?? 'help'} onClose={onCloseHelp} />
    </main>
  )
}

export function App() {
  const repository = useRepository()
  const [pickerOpen, setPickerOpen] = useState(false)
  const displayPath = repository.payload?.status === 'ready'
    ? repository.payload.repo.displayPath
    : repository.payload?.displayPath ?? ''
  return (
    <>
      <RepositoryWorkspace key={repository.revision} {...repository} onOpenRepository={() => { if (!isLinuxHistorySite) { if (isVSCode) pickRepository(); else setPickerOpen(true) } }} />
      {!isLinuxHistorySite ? <RepositoryPicker open={pickerOpen} currentPath={displayPath} busy={repository.refreshing}
        error={repository.error} onOpen={async (path) => Boolean(await repository.openRepository(path))}
        onClose={() => setPickerOpen(false)} /> : null}
    </>
  )
}

function RepositoryWorkspace({ payload, loading, refreshing, error, refresh, onOpenRepository }: ReturnType<typeof useRepository> & { onOpenRepository: () => void }) {
  const reducedMotion = useReducedMotion()
  const [mode, setMode] = useState<'overview' | 'inspect'>('inspect')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [filters, setFilters] = useState<GitFilterState>(() => {
    const saved = readSavedView()
    const scope = payload?.status === 'ready' && saved?.repoPath === payload.repo.displayPath ? saved.scope : 'HEAD'
    return { ...EMPTY_GIT_FILTERS, branch: scope === 'HEAD' ? '' : scope === 'all' ? '__all__' : scope }
  })
  const restoredRef = useRef(false)
  const deferredFilters = useDeferredValue(filters)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [selectedKind, setSelectedKind] = useState<'file' | 'directory'>('file')
  const [inspectionRequested, setInspectionRequested] = useState(false)
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('diff')
  const [parentIndex, setParentIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [helpOpen, setHelpOpen] = useState<'help' | 'setup' | null>(null)

  useEffect(() => {
    const pauseWhenHidden = () => { if (document.hidden) setPlaying(false) }
    const onMessage = (event: MessageEvent<{ type?: string; visible?: boolean }>) => {
      if (event.data?.type === 'palimpsest:visibility' && !event.data.visible) setPlaying(false)
    }
    document.addEventListener('visibilitychange', pauseWhenHidden)
    window.addEventListener('message', onMessage)
    return () => {
      document.removeEventListener('visibilitychange', pauseWhenHidden)
      window.removeEventListener('message', onMessage)
    }
  }, [])


  const ready = payload?.status === 'ready' ? payload : null
  const requestedScope = filters.branch === '__all__' ? 'all' : filters.branch || 'HEAD'
  const timeline = useCommitTimeline(ready, requestedScope)
  useEffect(() => {
    if (!ready || timeline.loading || !timeline.activeCommit) return
    if (!restoredRef.current) {
      restoredRef.current = true
      const saved = readSavedView()
      if (saved?.repoPath === ready.repo.displayPath && saved.scope === requestedScope && saved.index > 0) {
        void timeline.selectIndex(Math.min(saved.index, timeline.total - 1))
        return
      }
    }
    saveView({ repoPath: ready.repo.displayPath, scope: requestedScope, index: timeline.index })
  }, [ready, requestedScope, timeline.activeCommit, timeline.index, timeline.loading, timeline.selectIndex, timeline.total])
  const metadataFiltersActive = hasMetadataFilters(deferredFilters)
  const matchingOids = useMemo(
    () => new Set(
      timeline.commits
        .filter((commit) => matchesMetadataFilters(commit, deferredFilters))
        .map((commit) => commit.oid),
    ),
    [deferredFilters, timeline.commits],
  )
  const completeClientHistory = timeline.pageOffset === 0 && timeline.commits.length === timeline.total
  const exactClientFiltering = metadataFiltersActive && completeClientHistory
  const filteredEntries = useMemo(
    () => timeline.commits.flatMap((commit, localIndex) =>
      matchingOids.has(commit.oid)
        ? [{ commit, absoluteIndex: timeline.pageOffset + localIndex }]
        : [],
    ),
    [matchingOids, timeline.commits, timeline.pageOffset],
  )
  const filteredPosition = exactClientFiltering
    ? filteredEntries.findIndex((entry) => entry.commit.oid === timeline.activeCommit?.oid)
    : -1
  const navigationCommits = exactClientFiltering
    ? filteredEntries.map((entry) => entry.commit)
    : timeline.commits
  const currentIndex = exactClientFiltering ? Math.max(0, filteredPosition) : timeline.index
  const totalCommits = exactClientFiltering ? filteredEntries.length : timeline.total
  const windowOffset = exactClientFiltering ? 0 : timeline.pageOffset
  const activeCommit = exactClientFiltering && filteredPosition < 0 ? null : timeline.activeCommit
  const detailsState = useCommitDetails(activeCommit?.oid ?? null, timeline.loading)
  const details = detailsState.data?.oid === activeCommit?.oid ? detailsState.data : null
  const visualDetails = details ?? (detailsState.loading ? detailsState.data : null)
  const browseDirectory = directoryForSelection(selectedPath, selectedKind)
  const inspectionEnabled = mode === 'inspect' && !playing && inspectionRequested
  const inspectionOid = details && activeCommit && details.oid === activeCommit.oid
    ? details.oid
    : null
  const treeBrowser = useDirectoryTree(
    inspectionOid,
    browseDirectory,
    inspectionEnabled && selectedPath !== null,
  )
  const changesBrowser = useCommitChanges(inspectionOid, inspectionEnabled)
  const inspection = useFileInspection(inspectionOid, selectedPath, parentIndex, {
    diff: inspectionEnabled && inspectorTab === 'diff' && selectedKind === 'file',
    history: inspectionEnabled && inspectorTab === 'history',
  })

  const preciseTree = treeBrowser.data?.oid === inspectionOid && treeBrowser.data.path === browseDirectory
    ? treeBrowser.data
    : null
  const preciseChanges = changesBrowser.data?.oid === inspectionOid
    ? changesBrowser.data
    : null
  const inspectionDetails = useMemo(() => {
    if (!details) return null
    if (!preciseTree && !preciseChanges) return details
    return {
      ...details,
      tree: preciseTree?.items ?? details.tree,
      changes: preciseChanges?.items ?? details.changes,
      stats: preciseChanges?.stats ?? details.stats,
    }
  }, [details, preciseChanges, preciseTree])

  const fileTypes = useMemo(
    () => Array.from(new Set((visualDetails?.tree ?? []).map((file) => file.extension).filter(Boolean))).sort(),
    [visualDetails?.tree],
  )
  const directories = useMemo(
    () => Array.from(new Set((visualDetails?.tree ?? []).map((file) => file.directory).filter(Boolean))).sort(),
    [visualDetails?.tree],
  )
  const canvasFiles = useMemo(
    () => filterTree(visualDetails?.tree ?? [], deferredFilters),
    [deferredFilters, visualDetails?.tree],
  )

  useEffect(() => {
    if (!exactClientFiltering) return
    if (!filteredEntries.length) {
      setPlaying(false)
      return
    }
    if (filteredPosition < 0) void timeline.selectIndex(filteredEntries[0].absoluteIndex)
  }, [exactClientFiltering, filteredEntries, filteredPosition, timeline.selectIndex])

  useEffect(() => {
    setParentIndex(0)
    setSelectedPath(null)
    setSelectedKind('file')
    setInspectionRequested(false)
  }, [activeCommit?.oid])

  useEffect(() => {
    if (!details || details.oid !== activeCommit?.oid) return
    setSelectedPath((current) => {
      if (
        current &&
        (details.tree.some((file) => file.path === current) || details.changes.some((change) => change.path === current))
      ) {
        return current
      }
      return details.changes[0]?.path ?? details.tree[0]?.path ?? null
    })
  }, [activeCommit?.oid, details])

  useEffect(() => {
    if (!activeCommit || details?.oid !== activeCommit.oid || totalCommits < 2) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void (async () => {
        const directions = playing ? [1, 2] : [1, -1]
        const neighbors: string[] = []
        for (const direction of directions) {
          if (controller.signal.aborted) return
          const index = timeline.index + direction
          if (index < 0 || index >= timeline.total) continue
          const commit = await timeline.getCommitAtIndex(index, controller.signal)
          if (commit) neighbors.push(commit.oid)
        }
        await prefetchCommits(neighbors, controller.signal)
      })()
    }, playing ? 80 : 250)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [activeCommit, details?.oid, playing, timeline.getCommitAtIndex, timeline.index, timeline.total, totalCommits])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return
      if (event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setFiltersOpen(true)
      } else if (event.key.toLowerCase() === 'i') {
        event.preventDefault()
        setMode((current) => current === 'inspect' ? 'overview' : 'inspect')
      } else if (event.key === '?') {
        event.preventDefault()
        setHelpOpen('help')
      } else if (event.key === 'Escape') {
        setFiltersOpen(false)
        setHelpOpen(null)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const selectIndex = useCallback((index: number, pause = true) => {
    const absoluteIndex = exactClientFiltering
      ? filteredEntries[index]?.absoluteIndex
      : index
    if (absoluteIndex === undefined || absoluteIndex < 0 || absoluteIndex >= timeline.total) return
    if (pause) setPlaying(false)
    void timeline.selectIndex(absoluteIndex)
  }, [exactClientFiltering, filteredEntries, timeline.selectIndex, timeline.total])

  useEffect(() => {
    if (!playing || totalCommits < 2 || timeline.loading || detailsState.loading || !details) return undefined
    const timer = window.setTimeout(() => {
      if (currentIndex >= totalCommits - 1) {
        setPlaying(false)
      } else {
        selectIndex(currentIndex + 1, false)
      }
    }, PLAYBACK_INTERVAL / speed)
    return () => window.clearTimeout(timer)
  }, [currentIndex, details, detailsState.loading, playing, selectIndex, speed, timeline.loading, totalCommits])

  const handleRefresh = useCallback(async () => {
    setPlaying(false)
    clearCommitCaches()
    await refresh()
  }, [refresh])

  const timelineTicks = useMemo<TimelineTick[]>(() => {
    if (!ready || totalCommits === 0) return []
    const firstDate = exactClientFiltering
      ? filteredEntries[0]?.commit.authoredAt
      : timeline.pageOffset === 0
        ? timeline.commits[0]?.authoredAt ?? ready.dateRange.start
        : ready.dateRange.start
    const lastDate = exactClientFiltering
      ? filteredEntries[filteredEntries.length - 1]?.commit.authoredAt
      : timeline.index === timeline.total - 1
        ? timeline.activeCommit?.authoredAt
        : requestedScope === 'HEAD'
          ? ready.dateRange.end
          : undefined
    if (!firstDate) return []
    if (totalCommits === 1) {
      return [{ index: 0, label: shortBoundaryDate(firstDate), kind: 'boundary' }]
    }
    const endName = exactClientFiltering
      ? 'Latest match'
      : requestedScope === 'HEAD'
        ? 'HEAD'
        : requestedScope === 'all'
          ? 'Latest'
          : 'Tip'
    return [
      { index: 0, label: `Initial · ${shortBoundaryDate(firstDate)}`, kind: 'boundary' },
      {
        index: totalCommits - 1,
        label: lastDate ? `${endName} · ${shortBoundaryDate(lastDate)}` : endName,
        kind: 'boundary',
      },
    ]
  }, [
    exactClientFiltering,
    filteredEntries,
    ready,
    requestedScope,
    timeline.activeCommit?.authoredAt,
    timeline.commits,
    timeline.index,
    timeline.pageOffset,
    timeline.total,
    totalCommits,
  ])

  if (!ready) {
    const inactivePayload = payload && payload.status !== 'ready' ? payload : null
    return (
      <InactiveShell
        payload={inactivePayload}
        loading={loading}
        refreshing={refreshing}
        error={error}
        mode={mode}
        helpOpen={helpOpen}
        onSetMode={setMode}
        onRefresh={() => void handleRefresh()}
        onOpenHelp={setHelpOpen}
        onCloseHelp={() => setHelpOpen(null)}
        onOpenRepository={onOpenRepository}
      />
    )
  }

  const selectFile = (path: string) => {
    setSelectedPath(path)
    setSelectedKind('file')
    setInspectionRequested(true)
    setInspectorTab('diff')
    setMode('inspect')
  }
  const selectDirectory = (path: string) => {
    setSelectedPath(path || '.')
    setSelectedKind('directory')
    setInspectionRequested(true)
    setInspectorTab('history')
    setMode('inspect')
  }
  const goToHistoryCommit = (oid: string) => {
    setPlaying(false)
    if (metadataFiltersActive) {
      setFilters((current) => ({
        ...current,
        query: '',
        author: '',
        fromDate: '',
        toDate: '',
      }))
    }
    void timeline.locateOid(oid)
  }

  const activeFilterCount = countActiveFilters(filters)

  return (
    <main className={`app-shell${mode === 'overview' ? ' is-overview' : ''}`}>
      <AppHeader
        repo={ready.repo}
        fallbackName={ready.repo.name}
        mode={mode}
        filtersActive={activeFilterCount > 0}
        onOpenFilters={() => setFiltersOpen(true)}
        onSetMode={setMode}
        onOpenHelp={() => setHelpOpen('help')}
        onOpenRepository={onOpenRepository}
      />

      <div className="workspace">
        <div className="commit-column">
          <CommitRail
            commits={navigationCommits}
            windowOffset={windowOffset}
            totalCommits={totalCommits}
            currentIndex={currentIndex}
            refs={ready.refs}
            matchingOids={metadataFiltersActive && !exactClientFiltering ? matchingOids : undefined}
            windowRadius={4}
            onSelect={(index) => selectIndex(index)}
          />
        </div>

        <section className="visualization-stage" aria-label="Repository architectural history">
          <RepositoryCanvas
            files={canvasFiles}
            changes={visualDetails?.changes ?? []}
            landscape={visualDetails?.landscape ?? null}
            selectedPath={selectedKind === 'file' ? selectedPath : null}
            selectedDirectory={selectedKind === 'directory' ? (selectedPath === '.' ? '' : selectedPath) : null}
            onSelectFile={selectFile}
            onSelectDirectory={selectDirectory}
            reducedMotion={reducedMotion}
            focusMode={mode}
          />
          {!visualDetails && timeline.loading ? (
            <div className="stage-loading">Locating commit metadata</div>
          ) : !visualDetails && detailsState.loading ? (
            <div className="stage-loading">Commit ready · updating landscape</div>
          ) : null}
          {exactClientFiltering && !navigationCommits.length ? (
            <div className="no-filter-results" role="status">
              <strong>No commits match these filters.</strong>
              <button type="button" onClick={() => setFilters({ ...EMPTY_GIT_FILTERS })}>Clear filters</button>
            </div>
          ) : null}
        </section>

        {mode === 'inspect' ? (
          <div className="inspector-column">
            <Inspector
              commit={activeCommit}
              details={inspectionDetails}
              diff={inspection.diff.data}
              history={inspection.history.data ?? []}
              selectedPath={selectedPath}
              selectedKind={selectedKind}
              activeTab={inspectorTab}
              commitIndex={currentIndex}
              totalCommits={totalCommits}
              parentIndex={parentIndex}
              detailsLoading={detailsState.loading}
              diffLoading={inspection.diff.loading}
              historyLoading={inspection.history.loading}
              error={detailsState.error}
              diffError={inspection.diff.error}
              historyError={inspection.history.error}
              treePageInfo={preciseTree
                ? {
                    total: preciseTree.total,
                    loaded: preciseTree.items.length,
                    hasMore: preciseTree.hasMore,
                    loading: treeBrowser.loadingMore,
                    error: treeBrowser.error,
                  }
                : treeBrowser.loading || treeBrowser.error
                  ? {
                      total: details?.tree.length ?? 0,
                      loaded: details?.tree.length ?? 0,
                      hasMore: false,
                      loading: treeBrowser.loading,
                      error: treeBrowser.error,
                    }
                  : null}
              changesPageInfo={details
                ? {
                    total: preciseChanges?.total ?? details.changesPage?.total ?? details.changes.length,
                    loaded: preciseChanges?.items.length ?? details.changes.length,
                    hasMore: preciseChanges?.hasMore ?? details.changesPage?.hasMore ?? false,
                    loading: changesBrowser.loading,
                    error: changesBrowser.error,
                    exact: Boolean(preciseChanges),
                  }
                : null}
              onSelectPath={(path, kind) => kind === 'file' ? selectFile(path) : selectDirectory(path)}
              onTabChange={(tab) => {
                setInspectionRequested(true)
                setInspectorTab(tab)
              }}
              onParentIndexChange={setParentIndex}
              onSelectHistoryCommit={(entry) => goToHistoryCommit(entry.oid)}
              onLoadMoreTree={treeBrowser.loadMore}
              onLoadMoreChanges={changesBrowser.loadMore}
              onRetry={() => {
                detailsState.retry()
                treeBrowser.retry()
                changesBrowser.retry()
                inspection.retry()
              }}
              onClose={() => setMode('overview')}
            />
          </div>
        ) : null}
      </div>

      <div className="playback-region">
        <PlaybackBar
          commits={navigationCommits}
          windowOffset={windowOffset}
          totalCommits={totalCommits}
          currentCommit={activeCommit}
          currentIndex={currentIndex}
          isPlaying={playing}
          speed={speed}
          dateRange={ready.dateRange}
          headOid={ready.repo.headOid}
          ticks={timelineTicks}
          onTogglePlay={() => {
            if (!playing && currentIndex >= totalCommits - 1) selectIndex(0, false)
            setPlaying((current) => !current)
          }}
          onRestart={() => { setPlaying(false); selectIndex(0) }}
          onPrevious={() => selectIndex(currentIndex - 1)}
          onNext={() => selectIndex(currentIndex + 1)}
          onSeek={selectIndex}
          onScrubStart={() => setPlaying(false)}
          onSpeedChange={setSpeed}
        />
      </div>

      <FilterPanel
        open={filtersOpen}
        value={filters}
        authors={ready.authors}
        branches={ready.refs.filter((ref) => ref.kind === 'branch' || ref.kind === 'remote').map((ref) => ref.shortName)}
        fileTypes={fileTypes}
        directories={directories}
        dateRange={ready.dateRange}
        resultCount={metadataFiltersActive
          ? (exactClientFiltering ? filteredEntries.length : matchingOids.size)
          : timeline.total}
        resultLabel={!completeClientHistory && metadataFiltersActive ? 'matches in loaded window' : undefined}
        description={completeClientHistory
          ? 'Narrow commits and the repository view together.'
          : 'Branch scope covers the full history. Metadata filters highlight matches in the loaded window; file filters shape the current snapshot.'}
        busy={timeline.loading}
        onApply={(next) => { setFilters(next); setFiltersOpen(false) }}
        onReset={(next) => setFilters(next)}
        onClose={() => setFiltersOpen(false)}
      />
      {filtersOpen ? <button className="filter-scrim" type="button" aria-label="Close filters" onClick={() => setFiltersOpen(false)} /> : null}
      {error || timeline.error ? <StatusToast message={error ?? timeline.error ?? ''} tone="error" /> : null}
      <div className="sr-only" aria-live="polite">
        {activeCommit ? `Commit ${currentIndex + 1} of ${totalCommits}: ${activeCommit.subject}` : ''}
      </div>
      <HelpOverlay open={helpOpen !== null} kind={helpOpen ?? 'help'} onClose={() => setHelpOpen(null)} />
    </main>
  )
}
