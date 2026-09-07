import { isLinuxHistorySite } from '../lib/site'
import { isVSCode, openInNewWindow } from '../lib/host'
import type { RepositoryInfo } from '../types/git'
import {
  BranchIcon,
  FilterIcon,
  FolderIcon,
  HelpIcon,
  InspectIcon,
  OverviewIcon,
  SearchIcon,
} from './icons'

interface AppHeaderProps {
  repo: RepositoryInfo | null
  fallbackName: string
  mode: 'overview' | 'inspect'
  filtersActive: boolean
  disabled?: boolean
  onOpenFilters: () => void
  onSetMode: (mode: 'overview' | 'inspect') => void
  onOpenHelp: () => void
  onOpenRepository: () => void
  onOpenWorkspace?: () => void
}

export function AppHeader({
  repo,
  fallbackName,
  mode,
  filtersActive,
  disabled = false,
  onOpenFilters,
  onSetMode,
  onOpenHelp,
  onOpenRepository,
  onOpenWorkspace,
}: AppHeaderProps) {
  return (
    <header className="app-header">
      <div className="brand-group">
        <span className="wordmark" aria-label={isLinuxHistorySite ? 'Linux History' : 'Palimpsest'}>
          {isLinuxHistorySite ? 'LINUX HISTORY' : 'PALIMPSEST'}
        </span>
        <span className="header-rule" aria-hidden="true" />
        <button type="button" className="repo-identity" title={repo?.displayPath ?? fallbackName} onClick={isLinuxHistorySite ? undefined : onOpenRepository} disabled={isLinuxHistorySite} aria-label={isLinuxHistorySite ? 'torvalds/linux · read-only history' : 'Open or switch repository'}>
          <FolderIcon />
          <span className="repo-name">{repo?.name ?? fallbackName}</span>
          {repo?.branch ? (
            <span className="repo-branch">
              <BranchIcon />
              {repo.branch}
            </span>
          ) : null}
        </button>
      </div>

      <nav className="header-actions" aria-label="Workspace controls">
        {!isLinuxHistorySite && onOpenWorkspace ? <button className="header-button workbench-button" type="button" onClick={onOpenWorkspace} aria-label="Working changes" title="Working changes, commits, and branches">
          <BranchIcon /><span>Changes</span>
        </button> : null}
        {!isLinuxHistorySite && isVSCode ? <button className="header-button detach-button" type="button" onClick={openInNewWindow} aria-label="Open in new window" title="Open in new window"><span aria-hidden="true">↗</span></button> : null}
        {!isLinuxHistorySite ? <button className="header-button open-repository-button" type="button" onClick={onOpenRepository} aria-label="Open repository">
          <FolderIcon /><span>Open</span>
        </button> : null}
        <button
          className="header-button search-button"
          type="button"
          aria-label="Search history"
          disabled={disabled}
          onClick={onOpenFilters}
        >
          <SearchIcon />
          <span>Search</span>
          <kbd>⌘ K</kbd>
        </button>
        <button
          className={`header-button${filtersActive ? ' is-active' : ''}`}
          type="button"
          aria-label={filtersActive ? 'Filters active' : 'Filters'}
          disabled={disabled}
          onClick={onOpenFilters}
        >
          <FilterIcon />
          <span>Filters</span>
          {filtersActive ? <i className="filter-dot" aria-hidden="true" /> : null}
        </button>
        <span className="header-action-rule" aria-hidden="true" />
        <div className="mode-switch" aria-label="View mode">
          <button
            type="button"
            className={mode === 'overview' ? 'is-active' : ''}
            disabled={disabled}
            aria-label="Overview"
            aria-pressed={mode === 'overview'}
            onClick={() => onSetMode('overview')}
          >
            <OverviewIcon />
            <span>Overview</span>
          </button>
          <button
            type="button"
            className={mode === 'inspect' ? 'is-active' : ''}
            disabled={disabled}
            aria-label="Inspect"
            aria-pressed={mode === 'inspect'}
            onClick={() => onSetMode('inspect')}
          >
            <InspectIcon />
            <span>Inspect</span>
          </button>
        </div>
        <span className="header-action-rule" aria-hidden="true" />
        <button className="header-button help-button" type="button" aria-label="Help" onClick={onOpenHelp}>
          <HelpIcon />
          <span>Help</span>
          <kbd>?</kbd>
        </button>
      </nav>
    </header>
  )
}
