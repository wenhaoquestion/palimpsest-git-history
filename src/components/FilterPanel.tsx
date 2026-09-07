import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { CloseIcon, FilterIcon, SearchIcon } from './icons'

export interface GitFilterState {
  query: string
  author: string
  branch: string
  fromDate: string
  toDate: string
  fileType: string
  directory: string
}

export const EMPTY_GIT_FILTERS: Readonly<GitFilterState> = {
  query: '',
  author: '',
  branch: '',
  fromDate: '',
  toDate: '',
  fileType: '',
  directory: '',
}

export interface FilterPanelProps {
  open: boolean
  value: GitFilterState
  authors: readonly string[]
  branches: readonly string[]
  fileTypes?: readonly string[]
  directories?: readonly string[]
  dateRange?: { start: string; end: string }
  resultCount?: number
  resultLabel?: string
  description?: string
  busy?: boolean
  modal?: boolean
  onApply: (filters: GitFilterState) => void
  onReset: (filters: GitFilterState) => void
  onClose: () => void
  onDraftChange?: (filters: GitFilterState) => void
  className?: string
}

function dayValue(value: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.slice(0, 10)
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function uniqueSorted(values: readonly string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }),
  )
}

function typeLabel(type: string) {
  const normalized = type.replace(/^\./, '')
  const known: Record<string, string> = {
    ts: 'TypeScript',
    tsx: 'TypeScript JSX',
    js: 'JavaScript',
    jsx: 'JavaScript JSX',
    css: 'CSS',
    scss: 'SCSS',
    html: 'HTML',
    json: 'JSON',
    md: 'Markdown',
    mjs: 'JavaScript module',
    cjs: 'CommonJS module',
    py: 'Python',
    rs: 'Rust',
    go: 'Go',
    java: 'Java',
    rb: 'Ruby',
    php: 'PHP',
    sh: 'Shell',
    yml: 'YAML',
    yaml: 'YAML',
    svg: 'SVG',
  }
  return known[normalized.toLowerCase()] ?? normalized.toUpperCase()
}

export function countActiveFilters(filters: GitFilterState) {
  return Object.values(filters).filter((value) => value.trim().length > 0).length
}

export function FilterPanel({
  open,
  value,
  authors,
  branches,
  fileTypes = [],
  directories = [],
  dateRange,
  resultCount,
  resultLabel,
  description = 'Narrow commits and the repository view together.',
  busy = false,
  modal = false,
  onApply,
  onReset,
  onClose,
  onDraftChange,
  className = '',
}: FilterPanelProps) {
  const [draft, setDraft] = useState<GitFilterState>({ ...value })
  const searchRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const authorOptions = useMemo(() => uniqueSorted(authors), [authors])
  const branchOptions = useMemo(() => uniqueSorted(branches), [branches])
  const typeOptions = useMemo(() => uniqueSorted(fileTypes), [fileTypes])
  const directoryOptions = useMemo(() => uniqueSorted(directories), [directories])
  const minimumDate = dayValue(dateRange?.start ?? '')
  const maximumDate = dayValue(dateRange?.end ?? '')
  const invalidDateRange = Boolean(draft.fromDate && draft.toDate && draft.fromDate > draft.toDate)

  useEffect(() => {
    if (!open) return
    setDraft({ ...value })
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [
    open,
    value.author,
    value.branch,
    value.directory,
    value.fileType,
    value.fromDate,
    value.query,
    value.toDate,
  ])

  useEffect(() => {
    if (!open) return undefined
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, open])

  const update = <Key extends keyof GitFilterState>(key: Key, nextValue: GitFilterState[Key]) => {
    const next = { ...draft, [key]: nextValue }
    setDraft(next)
    onDraftChange?.(next)
  }

  const reset = () => {
    const empty = { ...EMPTY_GIT_FILTERS }
    setDraft(empty)
    onDraftChange?.(empty)
    onReset(empty)
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!invalidDateRange && !busy) onApply({ ...draft, query: draft.query.trim() })
  }

  if (!open) return null

  const activeCount = countActiveFilters(draft)

  return (
    <aside
      className={`filter-panel ${className}`.trim()}
      role="dialog"
      aria-modal={modal || undefined}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-busy={busy || undefined}
    >
      <form className="filter-panel__form" onSubmit={submit}>
        <header className="filter-panel__header">
          <div className="filter-panel__heading">
            <FilterIcon size={17} />
            <h2 id={titleId}>Filter history</h2>
            {activeCount ? <span className="filter-panel__count">{activeCount}</span> : null}
          </div>
          <button type="button" className="filter-panel__close" onClick={onClose} aria-label="Close filters">
            <CloseIcon size={18} />
          </button>
        </header>
        <p className="filter-panel__description" id={descriptionId}>
          {description}
        </p>

        <div className="filter-panel__field filter-panel__field--search">
          <label htmlFor={`${titleId}-query`}>Search commit metadata</label>
          <div className="filter-panel__input-shell">
            <SearchIcon size={16} />
            <input
              ref={searchRef}
              id={`${titleId}-query`}
              type="search"
              value={draft.query}
              onChange={(event) => update('query', event.currentTarget.value)}
              placeholder="Message, author, or SHA"
              autoComplete="off"
            />
            {draft.query ? (
              <button
                type="button"
                className="filter-panel__clear"
                onClick={() => update('query', '')}
                aria-label="Clear search"
              >
                <CloseIcon size={13} />
              </button>
            ) : null}
          </div>
        </div>

        <div className="filter-panel__field-grid">
          <div className="filter-panel__field">
            <label htmlFor={`${titleId}-author`}>Author</label>
            <select
              id={`${titleId}-author`}
              value={draft.author}
              onChange={(event) => update('author', event.currentTarget.value)}
            >
              <option value="">All authors</option>
              {authorOptions.map((author) => (
                <option value={author} key={author}>
                  {author}
                </option>
              ))}
            </select>
          </div>

          <div className="filter-panel__field">
            <label htmlFor={`${titleId}-branch`}>Branch</label>
            <select
              id={`${titleId}-branch`}
              value={draft.branch}
              onChange={(event) => update('branch', event.currentTarget.value)}
            >
              <option value="">Current HEAD history</option>
              <option value="__all__">All reachable refs</option>
              {branchOptions.map((branch) => (
                <option value={branch} key={branch}>
                  {branch}
                </option>
              ))}
            </select>
          </div>
        </div>

        <fieldset className="filter-panel__date-fieldset">
          <legend>Date range</legend>
          <div className="filter-panel__field-grid">
            <div className="filter-panel__field">
              <label htmlFor={`${titleId}-from`}>From</label>
              <input
                id={`${titleId}-from`}
                type="date"
                min={minimumDate || undefined}
                max={draft.toDate || maximumDate || undefined}
                value={draft.fromDate}
                onChange={(event) => update('fromDate', event.currentTarget.value)}
                aria-invalid={invalidDateRange || undefined}
              />
            </div>
            <div className="filter-panel__field">
              <label htmlFor={`${titleId}-to`}>To</label>
              <input
                id={`${titleId}-to`}
                type="date"
                min={draft.fromDate || minimumDate || undefined}
                max={maximumDate || undefined}
                value={draft.toDate}
                onChange={(event) => update('toDate', event.currentTarget.value)}
                aria-invalid={invalidDateRange || undefined}
              />
            </div>
          </div>
          {invalidDateRange ? (
            <p className="filter-panel__error" role="alert">
              The start date must be before the end date.
            </p>
          ) : null}
        </fieldset>

        <div className="filter-panel__field-grid">
          <div className="filter-panel__field">
            <label htmlFor={`${titleId}-type`}>File type</label>
            <select
              id={`${titleId}-type`}
              value={draft.fileType}
              onChange={(event) => update('fileType', event.currentTarget.value)}
            >
              <option value="">All file types</option>
              {typeOptions.map((type) => (
                <option value={type} key={type}>
                  {typeLabel(type)} · .{type.replace(/^\./, '')}
                </option>
              ))}
            </select>
          </div>

          <div className="filter-panel__field">
            <label htmlFor={`${titleId}-directory`}>Directory</label>
            <select
              id={`${titleId}-directory`}
              value={draft.directory}
              onChange={(event) => update('directory', event.currentTarget.value)}
            >
              <option value="">Entire repository</option>
              {directoryOptions.map((directory) => (
                <option value={directory} key={directory}>
                  {directory}/
                </option>
              ))}
            </select>
          </div>
        </div>

        <footer className="filter-panel__footer">
          <button
            type="button"
            className="filter-panel__reset"
            onClick={reset}
            disabled={busy || activeCount === 0}
          >
            Reset
          </button>
          <div className="filter-panel__apply-wrap">
            {typeof resultCount === 'number' ? (
              <span className="filter-panel__result-count" aria-live="polite">
                {resultCount.toLocaleString()} {resultLabel ?? (resultCount === 1 ? 'commit' : 'commits')}
              </span>
            ) : null}
            <button
              type="submit"
              className="filter-panel__apply"
              disabled={busy || invalidDateRange}
            >
              {busy ? 'Applying…' : 'Apply filters'}
            </button>
          </div>
        </footer>
      </form>
    </aside>
  )
}
