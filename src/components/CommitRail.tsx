import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { CommitSummary, GitRef } from '../types/git'
import { BranchIcon, ChevronDownIcon, ChevronUpIcon, CommitIcon, MergeIcon, TagIcon } from './icons'

export interface CommitRailProps {
  commits: readonly CommitSummary[]
  /** Absolute index of the first commit in this bounded window. */
  windowOffset?: number
  /** Exact number of commits reachable from the selected ref. */
  totalCommits?: number
  currentIndex: number
  onSelect: (index: number, commit?: CommitSummary) => void
  refs?: readonly GitRef[]
  /** When provided, non-matches remain spatially present but are deemphasized. */
  matchingOids?: ReadonlySet<string>
  /** Number of commits retained on either side of the viewport focus. */
  windowRadius?: number
  /** Git histories normally read newest-first in a rail, while playback remains oldest-first. */
  direction?: 'newest-first' | 'oldest-first'
  className?: string
  ariaLabel?: string
}

const ROW_HEIGHT = 68
const LANE_GAP = 15
const LANE_ORIGIN = 16
const LANE_COLORS = ['#9cc9a7', '#d3a166', '#8ca8b8', '#be8a83', '#a996c8', '#b8ae79']

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function compactRefName(value: string) {
  return value
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\//, '')
    .replace(/^refs\/tags\//, '')
    .replace(/^tag:\s*/, '')
}

function isLikelyTag(value: string, refs: readonly GitRef[], oid: string) {
  const normalized = compactRefName(value)
  return refs.some((ref) => ref.oid === oid && ref.kind === 'tag' && compactRefName(ref.name) === normalized)
}

function formatRailDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  }).format(date)
}

function fullDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

interface GraphEdge {
  key: string
  path: string
  color: string
  merge: boolean
}

export function CommitRail({
  commits,
  windowOffset = 0,
  totalCommits = commits.length,
  currentIndex,
  onSelect,
  refs = [],
  matchingOids,
  windowRadius = 9,
  direction = 'newest-first',
  className = '',
  ariaLabel = 'Repository commit history',
}: CommitRailProps) {
  const safeAbsoluteIndex = totalCommits === 0 ? 0 : clamp(currentIndex, 0, totalCommits - 1)
  const safeIndex = commits.length === 0 ? 0 : clamp(safeAbsoluteIndex - windowOffset, 0, commits.length - 1)
  const safeRadius = Math.max(3, Math.floor(windowRadius))
  const [windowFocus, setWindowFocus] = useState(safeIndex)
  const safeWindowFocus = commits.length === 0 ? 0 : clamp(windowFocus, 0, commits.length - 1)

  useEffect(() => {
    setWindowFocus(safeIndex)
  }, [safeIndex])

  const start = Math.max(0, safeWindowFocus - safeRadius)
  const end = Math.min(commits.length, safeWindowFocus + safeRadius + 1)

  const visibleIndices = useMemo(() => {
    const indices = Array.from({ length: end - start }, (_, offset) => start + offset)
    return direction === 'newest-first' ? indices.reverse() : indices
  }, [direction, end, start])

  const rowByIndex = useMemo(
    () => new Map(visibleIndices.map((index, row) => [index, row])),
    [visibleIndices],
  )
  const indexByOid = useMemo(
    () => new Map(commits.map((commit, index) => [commit.oid, index])),
    [commits],
  )
  const maximumLane = visibleIndices.reduce(
    (maximum, index) => Math.max(maximum, Math.max(0, commits[index]?.lane ?? 0)),
    0,
  )
  const graphWidth = LANE_ORIGIN * 2 + (maximumLane + 1) * LANE_GAP
  const graphHeight = visibleIndices.length * ROW_HEIGHT

  const edges = useMemo<GraphEdge[]>(() => {
    const visibleRanks = visibleIndices.map((index) =>
      direction === 'newest-first' ? commits.length - 1 - index : index,
    )
    const minimumRank = Math.min(...visibleRanks)
    const maximumRank = Math.max(...visibleRanks)

    return visibleIndices.flatMap((commitIndex) => {
      const commit = commits[commitIndex]
      const sourceRow = rowByIndex.get(commitIndex)
      if (!commit || sourceRow === undefined) return []
      const sourceX = LANE_ORIGIN + Math.max(0, commit.lane) * LANE_GAP
      const sourceY = sourceRow * ROW_HEIGHT + ROW_HEIGHT / 2

      return commit.parents.flatMap((parentOid, parentOrder) => {
        const parentIndex = indexByOid.get(parentOid)
        if (parentIndex === undefined) return []
        const parent = commits[parentIndex]
        const parentX = LANE_ORIGIN + Math.max(0, parent.lane) * LANE_GAP
        const parentRow = rowByIndex.get(parentIndex)
        const parentRank = direction === 'newest-first' ? commits.length - 1 - parentIndex : parentIndex
        const parentY =
          parentRow !== undefined
            ? parentRow * ROW_HEIGHT + ROW_HEIGHT / 2
            : parentRank < minimumRank
              ? 0
              : parentRank > maximumRank
                ? graphHeight
                : sourceY
        const midpoint = sourceY + (parentY - sourceY) * 0.52
        const color = LANE_COLORS[Math.max(0, parent.lane) % LANE_COLORS.length]

        return [
          {
            key: `${commit.oid}-${parentOid}-${parentOrder}`,
            path: `M ${sourceX} ${sourceY} C ${sourceX} ${midpoint}, ${parentX} ${midpoint}, ${parentX} ${parentY}`,
            color,
            merge: parentOrder > 0,
          },
        ]
      })
    })
  }, [commits, direction, graphHeight, indexByOid, rowByIndex, visibleIndices])

  const absoluteStart = windowOffset + start
  const absoluteEnd = windowOffset + end
  const newerCount = Math.max(0, totalCommits - absoluteEnd)
  const olderCount = Math.max(0, absoluteStart)
  const topHiddenCount = direction === 'newest-first' ? newerCount : olderCount
  const bottomHiddenCount = direction === 'newest-first' ? olderCount : newerCount

  const shiftWindow = (visualDirection: 'up' | 'down') => {
    const chronologicalDelta =
      direction === 'newest-first'
        ? visualDirection === 'up'
          ? safeRadius
          : -safeRadius
        : visualDirection === 'up'
          ? -safeRadius
          : safeRadius
    const focusAbsoluteIndex = windowOffset + safeWindowFocus
    const target = clamp(focusAbsoluteIndex + chronologicalDelta, 0, Math.max(0, totalCommits - 1))
    const localTarget = target - windowOffset
    if (localTarget >= 0 && localTarget < commits.length) {
      setWindowFocus(localTarget)
    } else {
      onSelect(target)
    }
  }

  return (
    <nav className={`commit-rail ${className}`.trim()} aria-label={ariaLabel}>
      <header className="commit-rail__header">
        <span className="commit-rail__eyebrow">Commits</span>
        <span className="commit-rail__position" aria-live="polite">
          {totalCommits ? `${(safeAbsoluteIndex + 1).toLocaleString()} of ${totalCommits.toLocaleString()}` : 'No commits'}
        </span>
      </header>

      {commits.length === 0 ? (
        <div className="commit-rail__empty">
          <CommitIcon size={20} />
          <span>This repository has no commits yet.</span>
        </div>
      ) : (
        <div className="commit-rail__viewport">
          {topHiddenCount > 0 ? (
            <button
              type="button"
              className="commit-rail__more commit-rail__more--top"
              onClick={() => shiftWindow('up')}
              aria-label={`Show ${Math.min(safeRadius, topHiddenCount)} more commits above`}
            >
              <ChevronUpIcon size={12} /> {topHiddenCount.toLocaleString()} more
            </button>
          ) : (
            <div className="commit-rail__boundary" aria-hidden="true" />
          )}

          <div
            className="commit-rail__window"
            style={{ '--commit-rail-graph-width': `${graphWidth}px` } as CSSProperties}
          >
            <svg
              className="commit-rail__graph"
              width={graphWidth}
              height={graphHeight}
              viewBox={`0 0 ${graphWidth} ${graphHeight}`}
              aria-hidden="true"
              preserveAspectRatio="none"
            >
              {edges.map((edge) => (
                <path
                  key={edge.key}
                  className={`commit-rail__edge${edge.merge ? ' commit-rail__edge--merge' : ''}`}
                  d={edge.path}
                  fill="none"
                  stroke={edge.color}
                  strokeWidth={edge.merge ? 1.35 : 1.75}
                  strokeDasharray={edge.merge ? '3 3' : undefined}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {visibleIndices.map((commitIndex, row) => {
                const commit = commits[commitIndex]
                const x = LANE_ORIGIN + Math.max(0, commit.lane) * LANE_GAP
                const y = row * ROW_HEIGHT + ROW_HEIGHT / 2
                const selected = commitIndex === safeIndex
                return (
                  <g key={commit.oid}>
                    {selected ? (
                      <circle
                        className="commit-rail__node-halo"
                        cx={x}
                        cy={y}
                        r="8"
                        fill="none"
                        stroke={LANE_COLORS[Math.max(0, commit.lane) % LANE_COLORS.length]}
                        strokeWidth="1.25"
                      />
                    ) : null}
                    <circle
                      className="commit-rail__node"
                      data-current={selected || undefined}
                      data-merge={commit.parents.length > 1 || undefined}
                      cx={x}
                      cy={y}
                      r={selected ? 4.5 : commit.parents.length > 1 ? 3.6 : 3}
                      fill={selected ? '#101310' : LANE_COLORS[Math.max(0, commit.lane) % LANE_COLORS.length]}
                      stroke={LANE_COLORS[Math.max(0, commit.lane) % LANE_COLORS.length]}
                      strokeWidth={selected ? 2 : 1}
                    />
                  </g>
                )
              })}
            </svg>

            <ol className="commit-rail__list" aria-label="Visible commits">
              {visibleIndices.map((commitIndex) => {
                const commit = commits[commitIndex]
                const selected = commitIndex === safeIndex
                const filteredOut = matchingOids ? !matchingOids.has(commit.oid) : false
                const directRefs = Array.from(new Set(commit.directRefs))
                const statsLabel = commit.stats
                  ? `${commit.stats.files} files, ${commit.stats.additions} additions, ${commit.stats.deletions} deletions`
                  : 'Change statistics unavailable'

                return (
                  <li
                    className="commit-rail__item"
                    key={commit.oid}
                    data-current={selected || undefined}
                    data-merge={commit.parents.length > 1 || undefined}
                    data-filtered-out={filteredOut || undefined}
                  >
                    <button
                      type="button"
                      className="commit-rail__commit"
                      onClick={() => onSelect(windowOffset + commitIndex, commit)}
                      aria-current={selected ? 'step' : undefined}
                      aria-label={`${selected ? 'Current commit, ' : ''}${commit.subject}, ${commit.shortOid}, by ${commit.author.name}, ${fullDate(commit.authoredAt)}. ${statsLabel}`}
                    >
                      <span className="commit-rail__commit-topline">
                        <code className="commit-rail__oid">{commit.shortOid}</code>
                        {commit.parents.length > 1 ? (
                          <span className="commit-rail__merge" title={`${commit.parents.length}-parent merge`}>
                            <MergeIcon size={12} />
                          </span>
                        ) : null}
                        <time className="commit-rail__date" dateTime={commit.authoredAt} title={fullDate(commit.authoredAt)}>
                          {formatRailDate(commit.authoredAt)}
                        </time>
                      </span>
                      <span className="commit-rail__subject">{commit.subject || 'Untitled commit'}</span>
                      {directRefs.length ? (
                        <span className="commit-rail__refs" aria-label="References">
                          {directRefs.slice(0, 2).map((refName) => {
                            const tag = isLikelyTag(refName, refs, commit.oid)
                            return (
                              <span className="commit-rail__ref" data-kind={tag ? 'tag' : 'branch'} key={refName}>
                                {tag ? <TagIcon size={10} /> : <BranchIcon size={10} />}
                                {compactRefName(refName)}
                              </span>
                            )
                          })}
                          {directRefs.length > 2 ? (
                            <span className="commit-rail__ref-overflow">+{directRefs.length - 2}</span>
                          ) : null}
                        </span>
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ol>
          </div>

          {bottomHiddenCount > 0 ? (
            <button
              type="button"
              className="commit-rail__more commit-rail__more--bottom"
              onClick={() => shiftWindow('down')}
              aria-label={`Show ${Math.min(safeRadius, bottomHiddenCount)} more commits below`}
            >
              <ChevronDownIcon size={12} /> {bottomHiddenCount.toLocaleString()} more
            </button>
          ) : (
            <div className="commit-rail__boundary" aria-hidden="true" />
          )}
        </div>
      )}
    </nav>
  )
}
