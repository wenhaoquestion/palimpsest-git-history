import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { CommitSummary } from '../types/git'
import { NextIcon, PauseIcon, PlayIcon, PreviousIcon, RestartIcon } from './icons'

export type TimelineTickKind = 'boundary' | 'date' | 'ref' | 'merge'

export interface TimelineTick {
  index: number
  label: string
  kind?: TimelineTickKind
}

export interface PlaybackBarProps {
  commits: readonly CommitSummary[]
  /** Exact count for paged histories; defaults to the supplied window length. */
  totalCommits?: number
  /** Absolute index represented by commits[0]. */
  windowOffset?: number
  /** Active summary when the supplied commit list is only a bounded window. */
  currentCommit?: CommitSummary | null
  currentIndex: number
  isPlaying: boolean
  speed: number
  onTogglePlay: () => void
  onRestart: () => void
  onPrevious: () => void
  onNext: () => void
  /** Loads the selected commit. Called once when a scrub gesture is committed. */
  onSeek: (index: number) => void
  /** Called frequently while dragging; keep synchronous work lightweight. */
  onScrubPreview?: (index: number) => void
  onScrubStart?: (index: number) => void
  /** `committed` is false when the gesture is cancelled or finishes at its origin. */
  onScrubEnd?: (index: number, committed: boolean) => void
  onSpeedChange: (speed: number) => void
  /** Used to estimate a date while scrubbing beyond the currently loaded summary page. */
  dateRange?: { start: string; end: string }
  headOid?: string
  speeds?: readonly number[]
  ticks?: readonly TimelineTick[]
  maxTicks?: number
  keyboardShortcuts?: boolean
  className?: string
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function validDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const LONG_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

const SHORT_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
})

function formatDate(value: string, style: 'long' | 'short' = 'long') {
  const date = validDate(value)
  if (!date) return value
  return (style === 'long' ? LONG_DATE_FORMATTER : SHORT_DATE_FORMATTER).format(date)
}

interface DateAnchor {
  index: number
  time: number
}

function resolvePreviewDate(index: number, anchors: readonly DateAnchor[]) {
  if (anchors.length === 0) return null
  let lower: DateAnchor | undefined
  let upper: DateAnchor | undefined

  for (const anchor of anchors) {
    if (anchor.index === index) return { value: new Date(anchor.time).toISOString(), estimated: false }
    if (anchor.index < index) lower = anchor
    if (anchor.index > index) {
      upper = anchor
      break
    }
  }

  if (!lower && !upper) return null
  if (!lower || !upper || upper.index === lower.index || upper.time < lower.time) {
    const nearest = !lower
      ? upper
      : !upper
        ? lower
        : index - lower.index <= upper.index - index ? lower : upper
    return nearest ? { value: new Date(nearest.time).toISOString(), estimated: true } : null
  }

  const ratio = (index - lower.index) / (upper.index - lower.index)
  return {
    value: new Date(lower.time + (upper.time - lower.time) * ratio).toISOString(),
    estimated: true,
  }
}

const RANGE_NAVIGATION_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
])

function tickPriority(kind: TimelineTickKind) {
  if (kind === 'boundary') return 4
  if (kind === 'ref') return 3
  if (kind === 'merge') return 2
  return 1
}

/** Build meaningful marks from time boundaries, refs, and merges rather than arbitrary decoration. */
export function buildTimelineTicks(
  commits: readonly CommitSummary[],
  maximum = 9,
  headOid?: string,
): TimelineTick[] {
  if (commits.length === 0) return []
  if (commits.length === 1) {
    return [{ index: 0, label: formatDate(commits[0].authoredAt, 'short'), kind: 'boundary' }]
  }

  const byIndex = new Map<number, TimelineTick>()
  const add = (tick: TimelineTick) => {
    const existing = byIndex.get(tick.index)
    const nextKind = tick.kind ?? 'date'
    const existingKind = existing?.kind ?? 'date'
    if (!existing || tickPriority(nextKind) > tickPriority(existingKind)) byIndex.set(tick.index, tick)
  }

  add({ index: 0, label: `Initial · ${formatDate(commits[0].authoredAt, 'short')}`, kind: 'boundary' })
  const lastCommit = commits[commits.length - 1]
  add({
    index: commits.length - 1,
    label: `${lastCommit.oid === headOid ? 'HEAD' : 'Latest'} · ${formatDate(lastCommit.authoredAt, 'short')}`,
    kind: 'boundary',
  })
  const headIndex = headOid ? commits.findIndex((commit) => commit.oid === headOid) : -1
  if (headIndex > 0 && headIndex < commits.length - 1) {
    add({ index: headIndex, label: `HEAD · ${formatDate(commits[headIndex].authoredAt, 'short')}`, kind: 'boundary' })
  }

  let previousMonth = ''
  commits.forEach((commit, index) => {
    const date = validDate(commit.authoredAt)
    const monthKey = date ? `${date.getFullYear()}-${date.getMonth()}` : ''
    if (monthKey && monthKey !== previousMonth) {
      add({ index, label: formatDate(commit.authoredAt, 'short'), kind: 'date' })
      previousMonth = monthKey
    }

    if (commit.directRefs.length > 0) {
      const label = commit.directRefs[0]
        .replace(/^refs\/(heads|tags|remotes)\//, '')
        .replace(/^tag:\s*/, '')
      add({ index, label, kind: 'ref' })
    } else if (commit.parents.length > 1) {
      add({ index, label: `Merge · ${commit.shortOid}`, kind: 'merge' })
    }
  })

  const candidates = [...byIndex.values()].sort((a, b) => a.index - b.index)
  const limit = Math.max(2, Math.floor(maximum))
  if (candidates.length <= limit) return candidates

  const mustKeep = candidates.filter((tick) => tick.kind === 'boundary' || tick.kind === 'ref')
  if (mustKeep.length >= limit) {
    const first = candidates[0]
    const last = candidates[candidates.length - 1]
    const interior = mustKeep.filter((tick) => tick.index !== first.index && tick.index !== last.index)
    const slots = Math.max(0, limit - 2)
    const sampled = Array.from({ length: slots }, (_, slot) => {
      const position = Math.round(((slot + 1) * (interior.length - 1)) / Math.max(1, slots + 1))
      return interior[position]
    }).filter((tick): tick is TimelineTick => Boolean(tick))
    return Array.from(new Map([first, ...sampled, last].map((tick) => [tick.index, tick])).values()).sort(
      (a, b) => a.index - b.index,
    )
  }

  const selected = new Map(mustKeep.map((tick) => [tick.index, tick]))
  const optional = candidates.filter((tick) => !selected.has(tick.index))
  const slots = limit - selected.size
  for (let slot = 0; slot < slots && optional.length; slot += 1) {
    const position = Math.round(((slot + 1) * (optional.length - 1)) / (slots + 1))
    const tick = optional[position]
    if (tick) selected.set(tick.index, tick)
  }
  return [...selected.values()].sort((a, b) => a.index - b.index)
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toLowerCase()
  return target.isContentEditable
    || tag === 'input'
    || tag === 'textarea'
    || tag === 'select'
    || tag === 'button'
    || target.getAttribute('role') === 'application'
    || Boolean(target.closest('[role="application"]'))
}

export function PlaybackBar({
  commits,
  totalCommits = commits.length,
  windowOffset = 0,
  currentCommit: suppliedCurrentCommit,
  currentIndex,
  isPlaying,
  speed,
  onTogglePlay,
  onRestart,
  onPrevious,
  onNext,
  onSeek,
  onScrubPreview,
  onScrubStart,
  onScrubEnd,
  onSpeedChange,
  dateRange,
  headOid,
  speeds = [0.5, 1, 2],
  ticks,
  maxTicks = 9,
  keyboardShortcuts = true,
  className = '',
}: PlaybackBarProps) {
  const lastIndex = Math.max(0, totalCommits - 1)
  const safeIndex = totalCommits ? clamp(currentIndex, 0, lastIndex) : 0
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const [isScrubbing, setIsScrubbing] = useState(false)
  const previewIndexRef = useRef<number | null>(null)
  const previewFrameRef = useRef<number | null>(null)
  const pointerBoundsRef = useRef<DOMRect | null>(null)
  const activePointerRef = useRef<number | null>(null)
  const scrubbingRef = useRef(false)
  const committedIndexRef = useRef(safeIndex)
  committedIndexRef.current = safeIndex
  const displayedIndex = previewIndex ?? safeIndex
  const currentCommit = suppliedCurrentCommit
    ?? commits[safeIndex - windowOffset]
    ?? (totalCommits === commits.length ? commits[safeIndex] : undefined)
  const disabled = totalCommits === 0
  const progress = totalCommits <= 1 ? (totalCommits ? 100 : 0) : (displayedIndex / lastIndex) * 100
  const semanticTicks = useMemo(
    () => (ticks
      ? [...ticks]
      : buildTimelineTicks(commits, maxTicks, headOid).map((tick) => ({
          ...tick,
          index: tick.index + windowOffset,
        }))),
    [commits, headOid, maxTicks, ticks, windowOffset],
  )
  const dateAnchors = useMemo(() => {
    const byIndex = new Map<number, DateAnchor>()
    const add = (index: number, value: string | undefined) => {
      if (!value || index < 0 || index > lastIndex) return
      const date = validDate(value)
      if (date) byIndex.set(index, { index, time: date.getTime() })
    }

    if (dateRange) {
      add(0, dateRange.start)
      add(lastIndex, dateRange.end)
    }
    commits.forEach((commit, localIndex) => add(windowOffset + localIndex, commit.authoredAt))
    add(safeIndex, suppliedCurrentCommit?.authoredAt)
    return [...byIndex.values()].sort((a, b) => a.index - b.index)
  }, [commits, dateRange, lastIndex, safeIndex, suppliedCurrentCommit?.authoredAt, windowOffset])
  const previewDate = useMemo(
    () => resolvePreviewDate(displayedIndex, dateAnchors),
    [dateAnchors, displayedIndex],
  )
  const displayedCommit = commits[displayedIndex - windowOffset]
    ?? (displayedIndex === safeIndex ? currentCommit : undefined)

  useEffect(() => {
    if (!keyboardShortcuts) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditableTarget(event.target) || disabled) return
      if (event.code === 'Space') {
        event.preventDefault()
        onTogglePlay()
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        if (safeIndex > 0) onPrevious()
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        if (safeIndex < lastIndex) onNext()
      } else if (event.key === 'Home') {
        event.preventDefault()
        onRestart()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [disabled, keyboardShortcuts, lastIndex, onNext, onPrevious, onRestart, onTogglePlay, safeIndex])

  useEffect(() => {
    if (scrubbingRef.current) return
    previewIndexRef.current = null
    setPreviewIndex(null)
  }, [safeIndex, totalCommits])

  const beginScrub = useCallback(() => {
    if (scrubbingRef.current) return
    scrubbingRef.current = true
    setIsScrubbing(true)
    onScrubStart?.(committedIndexRef.current)
  }, [onScrubStart])

  const updatePreview = useCallback((requestedIndex: number) => {
    beginScrub()
    const nextIndex = clamp(Math.round(requestedIndex), 0, lastIndex)
    if (previewIndexRef.current === nextIndex) return
    previewIndexRef.current = nextIndex
    if (previewFrameRef.current !== null) return
    previewFrameRef.current = window.requestAnimationFrame(() => {
      previewFrameRef.current = null
      const latest = previewIndexRef.current
      if (latest === null) return
      setPreviewIndex(latest)
      onScrubPreview?.(latest)
    })
  }, [beginScrub, lastIndex, onScrubPreview])

  const updatePreviewFromPointer = useCallback((element: HTMLInputElement, clientX: number) => {
    const bounds = pointerBoundsRef.current ?? element.getBoundingClientRect()
    if (bounds.width <= 0) return
    const ratio = clamp((clientX - bounds.left) / bounds.width, 0, 1)
    updatePreview(ratio * lastIndex)
  }, [lastIndex, updatePreview])

  const finishScrub = useCallback((commit: boolean) => {
    if (!scrubbingRef.current) return
    const origin = committedIndexRef.current
    const draft = previewIndexRef.current
    const target = draft ?? origin
    const didCommit = commit && draft !== null && target !== origin

    scrubbingRef.current = false
    if (previewFrameRef.current !== null) window.cancelAnimationFrame(previewFrameRef.current)
    previewFrameRef.current = null
    pointerBoundsRef.current = null
    activePointerRef.current = null
    previewIndexRef.current = null
    setPreviewIndex(null)
    setIsScrubbing(false)
    if (didCommit) onSeek(target)
    onScrubEnd?.(target, didCommit)
  }, [onScrubEnd, onSeek])

  useEffect(() => () => {
    if (previewFrameRef.current !== null) window.cancelAnimationFrame(previewFrameRef.current)
  }, [])

  const valueText = previewIndex !== null && previewIndex !== safeIndex
    ? displayedCommit
      ? `Commit ${previewIndex + 1} of ${totalCommits}: ${displayedCommit.subject}, ${formatDate(displayedCommit.authoredAt)}; release to settle here`
      : `Commit ${previewIndex + 1} of ${totalCommits}${previewDate ? `; approximately ${formatDate(previewDate.value)}` : ''}; release to settle here`
    : currentCommit
    ? `Commit ${safeIndex + 1} of ${totalCommits}: ${currentCommit.subject}, ${formatDate(currentCommit.authoredAt)}`
    : 'No commits available'

  return (
    <section
      className={`playback-bar ${className}`.trim()}
      aria-label="Git history playback"
      data-playing={isPlaying || undefined}
      data-scrubbing={isScrubbing || undefined}
    >
      <div className="playback-bar__transport" role="group" aria-label="Playback controls">
        <button
          type="button"
          className="playback-bar__control playback-bar__control--restart"
          onClick={onRestart}
          disabled={disabled}
          aria-label="Restart from the initial commit"
          title="Restart (Home)"
        >
          <RestartIcon size={21} />
          <span className="playback-bar__control-label">Restart</span>
        </button>
        <button
          type="button"
          className="playback-bar__control"
          onClick={onPrevious}
          disabled={disabled || safeIndex === 0}
          aria-label="Go to previous commit"
          title="Previous commit (Left arrow)"
        >
          <PreviousIcon size={19} />
          <span className="playback-bar__control-label">Prev</span>
        </button>
        <button
          type="button"
          className="playback-bar__control playback-bar__control--primary"
          onClick={onTogglePlay}
          disabled={disabled}
          aria-label={isPlaying ? 'Pause history playback' : 'Play history from this commit'}
          aria-pressed={isPlaying}
          title={`${isPlaying ? 'Pause' : 'Play'} (Space)`}
        >
          {isPlaying ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
          <span className="playback-bar__control-label">{isPlaying ? 'Pause' : 'Play'}</span>
        </button>
        <button
          type="button"
          className="playback-bar__control"
          onClick={onNext}
          disabled={disabled || safeIndex === lastIndex}
          aria-label="Go to next commit"
          title="Next commit (Right arrow)"
        >
          <NextIcon size={19} />
          <span className="playback-bar__control-label">Next</span>
        </button>
      </div>

      <div className="playback-bar__timeline">
        <div className="playback-bar__timeline-meta">
          <output className="playback-bar__count" aria-live={isScrubbing ? 'off' : 'polite'}>
            <strong>{disabled ? 0 : (displayedIndex + 1).toLocaleString()}</strong>
            <span aria-hidden="true"> / </span>
            <span>{totalCommits.toLocaleString()}</span>
            <span className="playback-bar__count-unit"> commits</span>
          </output>
          <span className="playback-bar__percent">{Math.round(progress)}%</span>
        </div>

        <div className="playback-bar__scrubber-wrap">
          <div className="playback-bar__track" aria-hidden="true">
            <span className="playback-bar__progress" style={{ width: `${progress}%` }} />
          </div>
          <input
            className="playback-bar__scrubber"
            type="range"
            min={0}
            max={lastIndex}
            step={1}
            value={displayedIndex}
            onChange={(event) => updatePreview(Number(event.currentTarget.value))}
            onPointerDown={(event) => {
              if (event.pointerType === 'mouse' && event.button !== 0) return
              // Own pointer gestures so the native range widget cannot also
              // change the value or release capture before our seek completes.
              event.preventDefault()
              event.currentTarget.focus()
              activePointerRef.current = event.pointerId
              pointerBoundsRef.current = event.currentTarget.getBoundingClientRect()
              event.currentTarget.setPointerCapture(event.pointerId)
              updatePreviewFromPointer(event.currentTarget, event.clientX)
            }}
            onPointerMove={(event) => {
              if (!scrubbingRef.current || activePointerRef.current !== event.pointerId) return
              // An outer editor overlay can consume pointerup outside the webview.
              // Settle the last preview when the released mouse returns.
              if (event.pointerType === 'mouse' && event.buttons === 0) {
                finishScrub(true)
                return
              }
              updatePreviewFromPointer(event.currentTarget, event.clientX)
            }}
            onPointerUp={(event) => {
              if (!scrubbingRef.current || activePointerRef.current !== event.pointerId) return
              updatePreviewFromPointer(event.currentTarget, event.clientX)
              finishScrub(true)
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId)
              }
            }}
            onPointerCancel={() => finishScrub(false)}
            onLostPointerCapture={() => finishScrub(false)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                finishScrub(false)
              } else if (RANGE_NAVIGATION_KEYS.has(event.key)) {
                beginScrub()
              }
            }}
            onKeyUp={(event) => {
              if (RANGE_NAVIGATION_KEYS.has(event.key)) finishScrub(true)
            }}
            onBlur={() => finishScrub(true)}
            disabled={disabled}
            aria-label="Scrub through repository history"
            aria-valuetext={valueText}
          />
          <div className="playback-bar__ticks" aria-hidden={disabled || undefined}>
            {semanticTicks.map((tick) => {
              const tickIndex = clamp(tick.index, 0, lastIndex)
              const left = totalCommits <= 1 ? 0 : (tickIndex / lastIndex) * 100
              return (
                <button
                  type="button"
                  className="playback-bar__tick"
                  data-kind={tick.kind ?? 'date'}
                  data-passed={tickIndex <= displayedIndex || undefined}
                  key={`${tickIndex}-${tick.label}`}
                  style={{ '--timeline-tick-position': `${left}%` } as CSSProperties}
                  onClick={() => onSeek(tickIndex)}
                  disabled={disabled}
                  tabIndex={-1}
                  aria-label={`Jump to ${tick.label}, commit ${tickIndex + 1}`}
                  title={tick.label}
                >
                  <span className="playback-bar__tick-mark" />
                  <span className="playback-bar__tick-label">{tick.label}</span>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <div className="playback-bar__status">
        <time className="playback-bar__date" dateTime={previewDate?.value ?? currentCommit?.authoredAt}>
          {isScrubbing && previewDate
            ? `${previewDate.estimated ? '≈ ' : ''}${formatDate(previewDate.value)}`
            : currentCommit
              ? formatDate(currentCommit.authoredAt)
              : '—'}
        </time>
        <div className="playback-bar__speed" role="group" aria-label="Playback speed">
          {speeds.map((candidate) => (
            <button
              type="button"
              className="playback-bar__speed-button"
              data-active={candidate === speed || undefined}
              aria-pressed={candidate === speed}
              onClick={() => onSpeedChange(candidate)}
              disabled={disabled}
              key={candidate}
            >
              {candidate}×
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}
