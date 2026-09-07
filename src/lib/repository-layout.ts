import type { ChangeKind, FileChange, LandscapeDirectory, TreeFile } from '../types/git'

export interface LayoutPoint {
  x: number
  y: number
}

export interface LayoutBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface DirectoryDistrict {
  path: string
  label: string
  level: 0 | 1
  x: number
  y: number
  width: number
  depth: number
  fileCount: number
  totalSize: number
  topLevelPath: string
  baseElevation: number
  elevation: number
  changedFileCount: number
  dominantStatus: ChangeKind | null
}

export interface FileBlock {
  id: string
  path: string
  name: string
  directory: string
  extension: string
  x: number
  y: number
  width: number
  depth: number
  height: number
  baseElevation: number
  lod: 0 | 1 | 2
  size: number | null
  status: ChangeKind | null
  ghost: boolean
  aggregate: boolean
  aggregateCount: number
  aggregatePaths: string[]
  topLevelPath: string
}

export interface DistrictRoad {
  id: string
  fromPath: string
  toPath: string
  from: LayoutPoint
  to: LayoutPoint
  fromElevation: number
  toElevation: number
  weight: number
}

export interface ChangeTrace {
  id: string
  from: LayoutPoint
  to: LayoutPoint
  fromDirectory: string
  toDirectory: string
  status: ChangeKind
  count: number
  kind: 'move' | 'impact'
}

export interface RepositoryLayout {
  blocks: FileBlock[]
  directories: DirectoryDistrict[]
  roads: DistrictRoad[]
  traces: ChangeTrace[]
  bounds: LayoutBounds
  projectedBounds: LayoutBounds
  sourceFileCount: number
  sourceDirectoryCount: number
  sourceTotalBytes: number | null
  representedFileCount: number
  omittedFileCount: number
  aggregateCount: number
}

export interface RepositoryLayoutOptions {
  maxBlocks?: number
  selectedPath?: string | null
  sourceFileCount?: number
  sourceDirectoryCount?: number
  sourceTotalBytes?: number | null
  directorySummaries?: readonly LandscapeDirectory[]
}

export const CHANGE_COLORS: Record<ChangeKind, string> = {
  A: '#69c9a5',
  M: '#deb76d',
  D: '#dc776b',
  R: '#8ea7dd',
  C: '#76b8c2',
  T: '#c69ad2',
  U: '#d98b79',
}

export const ISO_X = 0.8660254038
export const ISO_Y = 0.5
// View modes change paint detail, while sharing one deterministic city plan.
export const REPOSITORY_BLOCK_LIMIT = 620

const ROOT_LABEL = 'Repository root'
const CELL_SIZE = 18
const GROUP_PADDING = 13
const DISTRICT_PADDING = 18
const DISTRICT_GAP = 15
const MAX_AGGREGATE_GROUPS = 48

interface VisualEntry {
  id: string
  path: string
  name: string
  directory: string
  extension: string
  size: number | null
  status: ChangeKind | null
  ghost: boolean
  aggregate: boolean
  aggregateCount: number
  aggregatePaths: string[]
}

interface GroupPlan {
  path: string
  entries: VisualEntry[]
  width: number
  depth: number
  x: number
  y: number
  sourceCount: number
  totalSize: number
  changedFileCount: number
  dominantStatus: ChangeKind | null
}

interface DistrictPlan {
  path: string
  groups: GroupPlan[]
  width: number
  depth: number
  x: number
  y: number
  sourceCount: number
  totalSize: number
  changedFileCount: number
  dominantStatus: ChangeKind | null
}

interface DirectoryStats {
  path: string
  topLevelPath: string
  sourceCount: number
  totalSize: number
  statusCounts: Map<ChangeKind, number>
}

interface TopLevelStats {
  path: string
  sourceCount: number
  totalSize: number
  statusCounts: Map<ChangeKind, number>
}

interface PackedRect {
  id: string
  width: number
  depth: number
  x: number
  y: number
}

export function normalizeGitPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '')
}

export function directoryOf(path: string): string {
  const normalized = normalizeGitPath(path)
  const index = normalized.lastIndexOf('/')
  return index < 0 ? '' : normalized.slice(0, index)
}

export function topLevelOf(path: string): string {
  const normalized = normalizeGitPath(path)
  if (!normalized) return ''
  return normalized.split('/')[0] ?? ''
}

export function projectIsometric(x: number, y: number, z = 0): LayoutPoint {
  return {
    x: (x - y) * ISO_X,
    y: (x + y) * ISO_Y - z,
  }
}

export function buildRepositoryLayout(
  files: TreeFile[],
  changes: FileChange[],
  options: RepositoryLayoutOptions = {},
): RepositoryLayout {
  const maxBlocks = Math.max(80, options.maxBlocks ?? REPOSITORY_BLOCK_LIMIT)
  const normalizedSelectedPath = options.selectedPath ? normalizeGitPath(options.selectedPath) : null
  const inventory = buildVisualInventory(files, changes, maxBlocks, normalizedSelectedPath, {
    sourceFileCount: options.sourceFileCount,
    sourceDirectoryCount: options.sourceDirectoryCount,
    sourceTotalBytes: options.sourceTotalBytes,
    directorySummaries: options.directorySummaries,
  })
  const entries = inventory.entries
  // The city stays legible by treating top-level directories as districts.
  // Deeper paths remain attached to their real file blocks and inspector data,
  // but do not each create a padded plot that would shrink large repositories.
  const visualGroups = groupBy(entries, (entry) => entry.directory ? topLevelOf(entry.directory) : '')
  const districtGroups = new Map<string, GroupPlan[]>()

  for (const [directory, groupEntries] of visualGroups) {
    const columns = Math.max(1, Math.ceil(Math.sqrt(groupEntries.length * 1.18)))
    const rows = Math.max(1, Math.ceil(groupEntries.length / columns))
    const source = inventory.directoryStats.get(directory)
    const containsAggregate = groupEntries.some((entry) => entry.aggregate)
    const plan: GroupPlan = {
      path: directory,
      entries: [...groupEntries].sort(compareEntriesForPlacement),
      width: GROUP_PADDING * 2 + columns * CELL_SIZE,
      depth: GROUP_PADDING * 2 + rows * CELL_SIZE,
      x: 0,
      y: 0,
      sourceCount: containsAggregate
        ? groupEntries.reduce((sum, entry) => sum + entry.aggregateCount, 0)
        : source?.sourceCount ?? groupEntries.reduce((sum, entry) => sum + entry.aggregateCount, 0),
      totalSize: containsAggregate
        ? groupEntries.reduce((sum, entry) => sum + (entry.size ?? 0), 0)
        : source?.totalSize ?? groupEntries.reduce((sum, entry) => sum + (entry.size ?? 0), 0),
      changedFileCount: groupEntries.reduce((sum, entry) => sum + (entry.status ? 1 : 0), 0),
      dominantStatus: dominantStatus(groupEntries),
    }
    const topLevel = directory ? topLevelOf(directory) : ''
    const district = districtGroups.get(topLevel)
    if (district) district.push(plan)
    else districtGroups.set(topLevel, [plan])
  }

  const districtPlans: DistrictPlan[] = []

  for (const [path, groups] of districtGroups) {
    const orderedGroups = [...groups].sort((a, b) => stableHash(a.path) - stableHash(b.path))
    const groupRects = orderedGroups.map((group) => ({
      id: group.path,
      width: group.width,
      depth: group.depth,
      x: 0,
      y: 0,
    }))
    const totalArea = groupRects.reduce((sum, rect) => sum + rect.width * rect.depth, 0)
    const packed = packShelves(groupRects, Math.max(96, Math.sqrt(totalArea * 1.3)), DISTRICT_GAP)
    const packedById = new Map(packed.rects.map((rect) => [rect.id, rect]))

    for (const group of orderedGroups) {
      const rect = packedById.get(group.path)
      if (!rect) continue
      group.x = rect.x + DISTRICT_PADDING
      group.y = rect.y + DISTRICT_PADDING
    }

    const source = inventory.topLevelStats.get(path)
    districtPlans.push({
      path,
      groups: orderedGroups,
      width: packed.width + DISTRICT_PADDING * 2,
      depth: packed.depth + DISTRICT_PADDING * 2,
      x: 0,
      y: 0,
      sourceCount: source?.sourceCount ?? orderedGroups.reduce((sum, group) => sum + group.sourceCount, 0),
      totalSize: source?.totalSize ?? orderedGroups.reduce((sum, group) => sum + group.totalSize, 0),
      changedFileCount: countStatuses(source?.statusCounts),
      dominantStatus: dominantStatusCounts(source?.statusCounts),
    })
  }

  const orderedDistricts = [...districtPlans].sort(
    (a, b) => stableHash(a.path || ROOT_LABEL) - stableHash(b.path || ROOT_LABEL),
  )
  const districtRects = orderedDistricts.map((district) => ({
    id: district.path,
    width: district.width,
    depth: district.depth,
    x: 0,
    y: 0,
  }))
  const totalDistrictArea = districtRects.reduce((sum, rect) => sum + rect.width * rect.depth, 0)
  const packedDistricts = packShelves(
    districtRects,
    Math.max(180, Math.sqrt(totalDistrictArea * 1.36)),
    DISTRICT_GAP * 1.8,
  )
  const districtPositions = new Map(packedDistricts.rects.map((rect) => [rect.id, rect]))

  const blocks: FileBlock[] = []
  const directories: DirectoryDistrict[] = []
  const directoryCenters = new Map<string, LayoutPoint>()
  let maximumBlockHeight = 0

  for (const district of orderedDistricts) {
    const position = districtPositions.get(district.path)
    if (!position) continue
    district.x = position.x
    district.y = position.y
    const districtElevation = terrainElevation(district.sourceCount, district.totalSize)
    directories.push({
      path: district.path,
      label: district.path || ROOT_LABEL,
      level: 0,
      x: district.x,
      y: district.y,
      width: district.width,
      depth: district.depth,
      fileCount: district.sourceCount,
      totalSize: district.totalSize,
      topLevelPath: district.path,
      baseElevation: 0,
      elevation: districtElevation,
      changedFileCount: district.changedFileCount,
      dominantStatus: district.dominantStatus,
    })
    directoryCenters.set(district.path, {
      x: district.x + district.width / 2,
      y: district.y + district.depth / 2,
    })

    for (const group of district.groups) {
      const groupX = district.x + group.x
      const groupY = district.y + group.y
      const hasRaisedGroup = group.path !== district.path || district.groups.length > 1
      const groupElevation = hasRaisedGroup ? districtElevation + 0.95 : districtElevation
      if (hasRaisedGroup) {
        directories.push({
          path: group.path,
          label: group.path ? basename(group.path) : ROOT_LABEL,
          level: 1,
          x: groupX,
          y: groupY,
          width: group.width,
          depth: group.depth,
          fileCount: group.sourceCount,
          totalSize: group.totalSize,
          topLevelPath: district.path,
          baseElevation: districtElevation,
          elevation: groupElevation,
          changedFileCount: group.changedFileCount,
          dominantStatus: group.dominantStatus,
        })
      }
      directoryCenters.set(group.path, {
        x: groupX + group.width / 2,
        y: groupY + group.depth / 2,
      })

      const columns = Math.max(1, Math.floor((group.width - GROUP_PADDING * 2) / CELL_SIZE))
      group.entries.forEach((entry, index) => {
        const column = index % columns
        const row = Math.floor(index / columns)
        const dimensions = blockDimensions(entry)
        const x = groupX + GROUP_PADDING + column * CELL_SIZE + (CELL_SIZE - dimensions.width) / 2
        const y = groupY + GROUP_PADDING + row * CELL_SIZE + (CELL_SIZE - dimensions.depth) / 2
        maximumBlockHeight = Math.max(maximumBlockHeight, dimensions.height)
        blocks.push({
          ...entry,
          x,
          y,
          width: dimensions.width,
          depth: dimensions.depth,
          height: dimensions.height,
          baseElevation: groupElevation,
          lod: 2,
          topLevelPath: district.path,
        })
      })
    }
  }

  assignBlockLod(blocks, normalizedSelectedPath)
  blocks.sort((a, b) => a.x + a.y - (b.x + b.y))
  directories.sort((a, b) => a.level - b.level || a.x + a.y - (b.x + b.y))
  const width = Math.max(packedDistricts.width, 140)
  const depth = Math.max(packedDistricts.depth, 110)
  const bounds: LayoutBounds = { minX: -12, minY: -12, maxX: width + 12, maxY: depth + 12 }
  const projectedBounds = projectedBoundsFor(bounds, maximumBlockHeight + 24)
  const roads = buildDistrictRoads(directories)
  const traces = buildTraces(changes, directoryCenters)
  const aggregateCount = entries.reduce((sum, entry) => sum + (entry.aggregate ? 1 : 0), 0)
  const representedFileCount = entries.reduce((sum, entry) => sum + entry.aggregateCount, 0)
  const sourceFileCount = inventory.sourceFileCount
  const omittedFileCount = entries
    .filter((entry) => entry.aggregate)
    .reduce((sum, entry) => sum + entry.aggregateCount, 0)

  return {
    blocks,
    directories,
    roads,
    traces,
    bounds,
    projectedBounds,
    sourceFileCount,
    sourceDirectoryCount: inventory.sourceDirectoryCount,
    sourceTotalBytes: inventory.sourceTotalBytes,
    representedFileCount,
    omittedFileCount,
    aggregateCount,
  }
}

function buildVisualInventory(
  files: TreeFile[],
  changes: FileChange[],
  maxBlocks: number,
  selectedPath: string | null,
  sourceOverride: {
    sourceFileCount?: number
    sourceDirectoryCount?: number
    sourceTotalBytes?: number | null
    directorySummaries?: readonly LandscapeDirectory[]
  },
): {
  entries: VisualEntry[]
  directoryStats: Map<string, DirectoryStats>
  topLevelStats: Map<string, TopLevelStats>
  sourceFileCount: number
  sourceDirectoryCount: number
  sourceTotalBytes: number | null
} {
  const changesByPath = new Map<string, FileChange>()
  for (const change of changes) changesByPath.set(normalizeGitPath(change.path), change)

  const directoryStats = new Map<string, DirectoryStats>()
  const topLevelStats = new Map<string, TopLevelStats>()
  const presentChangedPaths = new Set<string>()
  const detailedReserve = Math.max(24, maxBlocks - MAX_AGGREGATE_GROUPS)
  const changedSampler = new BoundedEntrySampler(Math.max(16, Math.floor(detailedReserve * 0.56)))
  const stableSampler = new BoundedEntrySampler(detailedReserve)
  const topLevelRepresentatives = new Map<string, { score: number; entry: VisualEntry }>()
  const statusRepresentatives = new Map<ChangeKind, { score: number; entry: VisualEntry }>()
  let selectedEntry: VisualEntry | null = null
  let sourceFileCount = 0

  for (const file of files) {
    if (file.type === 'tree') continue
    const path = normalizeGitPath(file.path)
    if (!path) continue
    const directory = normalizeGitPath(file.directory || directoryOf(path))
    const topLevel = directory ? topLevelOf(directory) : ''
    const change = changesByPath.get(path)
    sourceFileCount += 1
    addToStats(directoryStats, directory, topLevel, file.size, change?.status ?? null)
    addToTopLevelStats(topLevelStats, topLevel, file.size, change?.status ?? null)
    if (change) presentChangedPaths.add(path)

    const makeEntry = (): VisualEntry => ({
      id: `file:${path}`,
      path,
      name: file.name || basename(path),
      directory,
      extension: (file.extension || extensionOf(path)).toLowerCase(),
      size: file.size,
      status: change?.status ?? null,
      ghost: false,
      aggregate: false,
      aggregateCount: 1,
      aggregatePaths: [path],
    })
    const score = samplingScore(path, file.size, change)

    if (path === selectedPath) selectedEntry = makeEntry()
    if (change) {
      changedSampler.consider(score, path, makeEntry)
      const representative = statusRepresentatives.get(change.status)
      if (!representative || score > representative.score) {
        statusRepresentatives.set(change.status, { score, entry: makeEntry() })
      }
    } else {
      stableSampler.consider(score, path, makeEntry)
      const representative = topLevelRepresentatives.get(topLevel)
      if (!representative || score > representative.score) {
        topLevelRepresentatives.set(topLevel, { score, entry: makeEntry() })
      }
    }
  }

  // Deletions and move origins are not present in the destination tree. Keep a
  // bounded set of their foundations so history remains spatially explicit.
  for (const change of changes) {
    const path = normalizeGitPath(change.path)
    if (change.status === 'D' && path && !presentChangedPaths.has(path)) {
      const entry = ghostEntry(`deleted:${path}`, path, path, 'D', 1)
      const score = samplingScore(path, null, change)
      changedSampler.consider(score, entry.id, () => entry)
      ensureVisualStats(directoryStats, topLevelStats, entry)
      const representative = statusRepresentatives.get('D')
      if (!representative || score > representative.score) statusRepresentatives.set('D', { score, entry })
    }
    const previousPath = change.previousPath ? normalizeGitPath(change.previousPath) : ''
    if (change.status === 'R' && path && previousPath && previousPath !== path) {
      const entry = ghostEntry(`moved-from:${previousPath}:${path}`, path, previousPath, 'R', 0)
      changedSampler.consider(samplingScore(previousPath, null, change) - 1, entry.id, () => entry)
      ensureVisualStats(directoryStats, topLevelStats, entry)
    }
  }

  applyLandscapeDirectories(
    directoryStats,
    topLevelStats,
    sourceOverride.directorySummaries,
    sourceOverride.sourceFileCount,
  )

  const entriesById = new Map<string, VisualEntry>()
  const addEntry = (entry: VisualEntry | null | undefined) => {
    if (entry) entriesById.set(entry.id, entry)
  }
  addEntry(selectedEntry)
  for (const representative of statusRepresentatives.values()) addEntry(representative.entry)
  for (const entry of changedSampler.values().sort(compareEntriesForSampling)) {
    if (entriesById.size >= Math.floor(detailedReserve * 0.62)) break
    addEntry(entry)
  }
  for (const representative of [...topLevelRepresentatives.values()].sort((a, b) => b.score - a.score)) {
    if (entriesById.size >= detailedReserve) break
    addEntry(representative.entry)
  }
  for (const entry of stableSampler.values().sort(compareEntriesForSampling)) {
    if (entriesById.size >= detailedReserve) break
    addEntry(entry)
  }

  const detailed = [...entriesById.values()]
  const selectedCounts = new Map<string, number>()
  const selectedSizes = new Map<string, number>()
  const selectedStatuses = new Map<string, Map<ChangeKind, number>>()
  for (const entry of detailed) {
    if (entry.ghost || entry.aggregateCount === 0) continue
    const topLevel = entry.directory ? topLevelOf(entry.directory) : ''
    selectedCounts.set(topLevel, (selectedCounts.get(topLevel) ?? 0) + entry.aggregateCount)
    selectedSizes.set(topLevel, (selectedSizes.get(topLevel) ?? 0) + (entry.size ?? 0))
    if (entry.status) incrementStatus(selectedStatuses, topLevel, entry.status)
  }

  const aggregateCandidates = [...topLevelStats.values()]
    .map((stats) => {
      const aggregateCount = Math.max(0, stats.sourceCount - (selectedCounts.get(stats.path) ?? 0))
      const remainingStatuses = subtractStatuses(stats.statusCounts, selectedStatuses.get(stats.path))
      return {
        stats,
        aggregateCount,
        aggregateSize: Math.max(0, stats.totalSize - (selectedSizes.get(stats.path) ?? 0)),
        status: dominantStatusCounts(remainingStatuses),
      }
    })
    .filter((candidate) => candidate.aggregateCount > 0)
    .sort((a, b) => b.aggregateCount - a.aggregateCount || stableHash(a.stats.path) - stableHash(b.stats.path))

  const sampledTotalBytes = [...topLevelStats.values()].reduce((sum, stats) => sum + stats.totalSize, 0)
  const reportedFileCount = Math.max(sourceFileCount, sourceOverride.sourceFileCount ?? 0)
  const reportedTotalBytes = sourceOverride.sourceTotalBytes === null
    ? null
    : Math.max(sampledTotalBytes, sourceOverride.sourceTotalBytes ?? sampledTotalBytes)
  const locatedFileCount = [...topLevelStats.values()].reduce((sum, stats) => sum + stats.sourceCount, 0)
  const externalFileCount = Math.max(0, reportedFileCount - locatedFileCount)
  const externalSize = reportedTotalBytes === null ? null : Math.max(0, reportedTotalBytes - sampledTotalBytes)
  const needsArchive = externalFileCount > 0 || aggregateCandidates.length > MAX_AGGREGATE_GROUPS
  const retainedLimit = needsArchive ? MAX_AGGREGATE_GROUPS - 1 : MAX_AGGREGATE_GROUPS
  const retained = aggregateCandidates.slice(0, retainedLimit)
  const overflow = aggregateCandidates.slice(retainedLimit)
  const aggregates = retained.map(({ stats, aggregateCount, aggregateSize, status }): VisualEntry => ({
    id: `aggregate:${stats.path || '__root__'}`,
    path: stats.path,
    name: `${aggregateCount.toLocaleString()} files`,
    directory: stats.path,
    extension: '',
    size: aggregateSize || null,
    status,
    ghost: false,
    aggregate: true,
    aggregateCount,
    aggregatePaths: [],
  }))

  const archiveCount = externalFileCount + overflow.reduce((sum, candidate) => sum + candidate.aggregateCount, 0)
  const archiveSize = externalSize === null
    ? null
    : externalSize + overflow.reduce((sum, candidate) => sum + candidate.aggregateSize, 0)
  if (archiveCount > 0) {
    aggregates.push({
      id: 'aggregate:__repository_archive__',
      path: '',
      name: `${archiveCount.toLocaleString()} files`,
      directory: '',
      extension: '',
      size: archiveSize,
      status: null,
      ghost: false,
      aggregate: true,
      aggregateCount: archiveCount,
      aggregatePaths: [],
    })
    if (externalFileCount > 0) {
      let rootStats = topLevelStats.get('')
      if (!rootStats) {
        rootStats = { path: '', sourceCount: 0, totalSize: 0, statusCounts: new Map() }
        topLevelStats.set('', rootStats)
      }
      rootStats.sourceCount += externalFileCount
      rootStats.totalSize += externalSize ?? 0
    }
  }

  const allowedDetailed = Math.max(0, maxBlocks - aggregates.length)
  return {
    entries: [...detailed.slice(0, allowedDetailed), ...aggregates],
    directoryStats,
    topLevelStats,
    sourceFileCount: reportedFileCount,
    sourceDirectoryCount: Math.max(directoryStats.size, sourceOverride.sourceDirectoryCount ?? 0),
    sourceTotalBytes: reportedTotalBytes,
  }
}

interface SampleNode {
  score: number
  key: string
  entry: VisualEntry
}

class BoundedEntrySampler {
  private readonly heap: SampleNode[] = []

  constructor(private readonly capacity: number) {}

  consider(score: number, key: string, createEntry: () => VisualEntry): void {
    if (this.capacity <= 0) return
    const root = this.heap[0]
    if (this.heap.length >= this.capacity && root && compareSampleValues(score, key, root.score, root.key) <= 0) return
    const node = { score, key, entry: createEntry() }
    if (this.heap.length < this.capacity) {
      this.heap.push(node)
      this.bubbleUp(this.heap.length - 1)
      return
    }
    this.heap[0] = node
    this.sinkDown(0)
  }

  values(): VisualEntry[] {
    return this.heap.map((node) => node.entry)
  }

  private bubbleUp(index: number): void {
    let cursor = index
    while (cursor > 0) {
      const parent = Math.floor((cursor - 1) / 2)
      if (compareSampleNodes(this.heap[cursor], this.heap[parent]) >= 0) break
      ;[this.heap[cursor], this.heap[parent]] = [this.heap[parent], this.heap[cursor]]
      cursor = parent
    }
  }

  private sinkDown(index: number): void {
    let cursor = index
    while (true) {
      const left = cursor * 2 + 1
      const right = left + 1
      let smallest = cursor
      if (left < this.heap.length && compareSampleNodes(this.heap[left], this.heap[smallest]) < 0) smallest = left
      if (right < this.heap.length && compareSampleNodes(this.heap[right], this.heap[smallest]) < 0) smallest = right
      if (smallest === cursor) return
      ;[this.heap[cursor], this.heap[smallest]] = [this.heap[smallest], this.heap[cursor]]
      cursor = smallest
    }
  }
}

function compareSampleNodes(a: SampleNode, b: SampleNode): number {
  return compareSampleValues(a.score, a.key, b.score, b.key)
}

function compareSampleValues(aScore: number, aKey: string, bScore: number, bKey: string): number {
  return aScore - bScore || stableHash(aKey) - stableHash(bKey)
}

function samplingScore(path: string, size: number | null, change?: FileChange): number {
  const volume = Math.log2(Math.max(0, size ?? 384) + 2)
  const churn = change ? Math.log2((change.additions ?? 0) + (change.deletions ?? 0) + 2) : 0
  const statusWeight = change ? 24 : 0
  return (statusWeight + churn * 2.4 + volume) * 1_000_000 + (stableHash(path) & 0xfffff)
}

function ghostEntry(
  id: string,
  destinationPath: string,
  visualPath: string,
  status: ChangeKind,
  aggregateCount: number,
): VisualEntry {
  return {
    id,
    path: destinationPath,
    name: basename(visualPath),
    directory: directoryOf(visualPath),
    extension: extensionOf(visualPath),
    size: null,
    status,
    ghost: true,
    aggregate: false,
    aggregateCount,
    aggregatePaths: [destinationPath],
  }
}

function addToStats(
  target: Map<string, DirectoryStats>,
  path: string,
  topLevelPath: string,
  size: number | null,
  status: ChangeKind | null,
): void {
  let stats = target.get(path)
  if (!stats) {
    stats = { path, topLevelPath, sourceCount: 0, totalSize: 0, statusCounts: new Map() }
    target.set(path, stats)
  }
  stats.sourceCount += 1
  stats.totalSize += size ?? 0
  if (status) stats.statusCounts.set(status, (stats.statusCounts.get(status) ?? 0) + 1)
}

function addToTopLevelStats(
  target: Map<string, TopLevelStats>,
  path: string,
  size: number | null,
  status: ChangeKind | null,
): void {
  let stats = target.get(path)
  if (!stats) {
    stats = { path, sourceCount: 0, totalSize: 0, statusCounts: new Map() }
    target.set(path, stats)
  }
  stats.sourceCount += 1
  stats.totalSize += size ?? 0
  if (status) stats.statusCounts.set(status, (stats.statusCounts.get(status) ?? 0) + 1)
}

function applyLandscapeDirectories(
  directoryStats: Map<string, DirectoryStats>,
  topLevelStats: Map<string, TopLevelStats>,
  summaries: readonly LandscapeDirectory[] | undefined,
  reportedFileCount: number | undefined,
): void {
  if (!summaries?.length) return
  let rootSummary: LandscapeDirectory | undefined
  let topLevelTotal = 0

  for (const summary of summaries) {
    const path = summary.path === '.' ? '' : normalizeGitPath(summary.path)
    if (summary.depth === 0) {
      rootSummary = summary
      continue
    }
    if (summary.depth > 2 || !path) continue
    const topLevel = topLevelOf(path)
    const existingDirectory = directoryStats.get(path)
    directoryStats.set(path, {
      path,
      topLevelPath: topLevel,
      sourceCount: summary.fileCount,
      totalSize: summary.totalBytes ?? existingDirectory?.totalSize ?? 0,
      statusCounts: existingDirectory?.statusCounts ?? new Map(),
    })
    if (summary.depth !== 1) continue
    const existingTopLevel = topLevelStats.get(path)
    topLevelStats.set(path, {
      path,
      sourceCount: summary.fileCount,
      totalSize: summary.totalBytes ?? existingTopLevel?.totalSize ?? 0,
      statusCounts: existingTopLevel?.statusCounts ?? new Map(),
    })
    topLevelTotal += summary.fileCount
  }

  const totalFiles = Math.max(rootSummary?.fileCount ?? 0, reportedFileCount ?? 0)
  const rootFileCount = Math.max(0, totalFiles - topLevelTotal)
  const existingRoot = topLevelStats.get('')
  if (rootFileCount > 0 || existingRoot) {
    topLevelStats.set('', {
      path: '',
      sourceCount: rootFileCount,
      totalSize: existingRoot?.totalSize ?? 0,
      statusCounts: existingRoot?.statusCounts ?? new Map(),
    })
  }
}

function ensureVisualStats(
  directoryStats: Map<string, DirectoryStats>,
  topLevelStats: Map<string, TopLevelStats>,
  entry: VisualEntry,
): void {
  const topLevel = entry.directory ? topLevelOf(entry.directory) : ''
  if (!directoryStats.has(entry.directory)) {
    directoryStats.set(entry.directory, {
      path: entry.directory,
      topLevelPath: topLevel,
      sourceCount: 0,
      totalSize: 0,
      statusCounts: new Map(),
    })
  }
  if (!topLevelStats.has(topLevel)) {
    topLevelStats.set(topLevel, {
      path: topLevel,
      sourceCount: 0,
      totalSize: 0,
      statusCounts: new Map(),
    })
  }
}

function incrementStatus(
  target: Map<string, Map<ChangeKind, number>>,
  path: string,
  status: ChangeKind,
): void {
  let statuses = target.get(path)
  if (!statuses) {
    statuses = new Map()
    target.set(path, statuses)
  }
  statuses.set(status, (statuses.get(status) ?? 0) + 1)
}

function subtractStatuses(
  source: Map<ChangeKind, number>,
  subtract: Map<ChangeKind, number> | undefined,
): Map<ChangeKind, number> {
  const result = new Map<ChangeKind, number>()
  for (const [status, count] of source) {
    const remaining = count - (subtract?.get(status) ?? 0)
    if (remaining > 0) result.set(status, remaining)
  }
  return result
}

function countStatuses(statuses: Map<ChangeKind, number> | undefined): number {
  if (!statuses) return 0
  let total = 0
  for (const count of statuses.values()) total += count
  return total
}

function dominantStatusCounts(statuses: Map<ChangeKind, number> | undefined): ChangeKind | null {
  if (!statuses) return null
  let result: ChangeKind | null = null
  let maximum = 0
  for (const [status, count] of statuses) {
    if (count > maximum) {
      maximum = count
      result = status
    }
  }
  return result
}

function terrainElevation(fileCount: number, totalSize: number): number {
  const population = Math.log10(fileCount + 1)
  const volume = Math.log10(totalSize + 32)
  return 3.6 + Math.min(5.8, population * 1.08 + volume * 0.12)
}

function assignBlockLod(blocks: FileBlock[], selectedPath: string | null): void {
  const ordered = [...blocks].sort((a, b) => {
    const aPriority = (a.path === selectedPath ? 100 : 0) + (a.status ? 36 : 0) + (a.aggregate ? 24 : 0) + a.height
    const bPriority = (b.path === selectedPath ? 100 : 0) + (b.status ? 36 : 0) + (b.aggregate ? 24 : 0) + b.height
    return bPriority - aPriority || stableHash(a.id) - stableHash(b.id)
  })
  const primary = Math.max(48, Math.ceil(ordered.length * 0.28))
  const secondary = Math.max(primary, Math.ceil(ordered.length * 0.62))
  ordered.forEach((block, index) => {
    block.lod = index < primary ? 0 : index < secondary ? 1 : 2
  })
}

function buildDistrictRoads(directories: DirectoryDistrict[]): DistrictRoad[] {
  const districts = directories.filter((directory) => directory.level === 0)
  if (districts.length < 2) return []
  const ordered = [...districts].sort((a, b) => b.fileCount - a.fileCount || stableHash(a.path) - stableHash(b.path))
  const connected = [ordered[0]]
  const remaining = new Set(ordered.slice(1))
  const roads: DistrictRoad[] = []

  while (remaining.size > 0 && roads.length < 42) {
    let bestFrom = connected[0]
    let bestTo: DirectoryDistrict | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const from of connected) {
      const fromX = from.x + from.width / 2
      const fromY = from.y + from.depth / 2
      for (const to of remaining) {
        const toX = to.x + to.width / 2
        const toY = to.y + to.depth / 2
        const distance = (fromX - toX) ** 2 + (fromY - toY) ** 2
        if (distance < bestDistance) {
          bestDistance = distance
          bestFrom = from
          bestTo = to
        }
      }
    }
    if (!bestTo) break
    const fromCenter = { x: bestFrom.x + bestFrom.width / 2, y: bestFrom.y + bestFrom.depth / 2 }
    const toCenter = { x: bestTo.x + bestTo.width / 2, y: bestTo.y + bestTo.depth / 2 }
    roads.push({
      id: `road:${bestFrom.path}:${bestTo.path}`,
      fromPath: bestFrom.path,
      toPath: bestTo.path,
      from: fromCenter,
      to: toCenter,
      fromElevation: bestFrom.elevation + 0.18,
      toElevation: bestTo.elevation + 0.18,
      weight: Math.min(bestFrom.fileCount, bestTo.fileCount),
    })
    connected.push(bestTo)
    remaining.delete(bestTo)
  }
  return roads
}

function buildTraces(
  changes: FileChange[],
  centers: Map<string, LayoutPoint>,
): ChangeTrace[] {
  if (changes.length === 0 || centers.size === 0) return []

  const traces = new Map<string, ChangeTrace>()
  const touchedCounts = new Map<string, number>()

  for (const change of changes) {
    const toDirectory = directoryOf(change.path)
    touchedCounts.set(toDirectory, (touchedCounts.get(toDirectory) ?? 0) + 1)
    if (change.status !== 'R' || !change.previousPath) continue
    const fromDirectory = directoryOf(change.previousPath)
    if (fromDirectory === toDirectory) continue
    const from = resolveDirectoryCenter(fromDirectory, centers)
    const to = resolveDirectoryCenter(toDirectory, centers)
    if (!from || !to) continue
    const key = `move:${fromDirectory}:${toDirectory}`
    const existing = traces.get(key)
    if (existing) existing.count += 1
    else {
      traces.set(key, {
        id: key,
        from,
        to,
        fromDirectory,
        toDirectory,
        status: 'R',
        count: 1,
        kind: 'move',
      })
    }
  }

  const touched = [...touchedCounts.entries()]
    .map(([directory, count]) => ({ directory, count, point: resolveDirectoryCenter(directory, centers) }))
    .filter((item): item is { directory: string; count: number; point: LayoutPoint } => item.point !== null)
    .sort((a, b) => b.count - a.count || a.directory.localeCompare(b.directory))

  const hub = touched[0]
  if (hub && touched.length > 1) {
    for (const destination of touched.slice(1, 25)) {
      if (destination.directory === hub.directory) continue
      const key = `impact:${hub.directory}:${destination.directory}`
      if (traces.has(`move:${hub.directory}:${destination.directory}`)) continue
      traces.set(key, {
        id: key,
        from: hub.point,
        to: destination.point,
        fromDirectory: hub.directory,
        toDirectory: destination.directory,
        status: 'M',
        count: Math.min(hub.count, destination.count),
        kind: 'impact',
      })
    }
  }

  return [...traces.values()].sort((a, b) => a.kind.localeCompare(b.kind) || b.count - a.count).slice(0, 32)
}

function resolveDirectoryCenter(path: string, centers: Map<string, LayoutPoint>): LayoutPoint | null {
  let candidate = normalizeGitPath(path)
  while (candidate) {
    const exact = centers.get(candidate)
    if (exact) return exact
    candidate = directoryOf(candidate)
  }
  return centers.get('') ?? centers.get(topLevelOf(path)) ?? null
}

function projectedBoundsFor(bounds: LayoutBounds, maximumHeight: number): LayoutBounds {
  const corners = [
    projectIsometric(bounds.minX, bounds.minY, 0),
    projectIsometric(bounds.maxX, bounds.minY, 0),
    projectIsometric(bounds.maxX, bounds.maxY, 0),
    projectIsometric(bounds.minX, bounds.maxY, 0),
    projectIsometric(bounds.minX, bounds.minY, maximumHeight),
    projectIsometric(bounds.maxX, bounds.minY, maximumHeight),
    projectIsometric(bounds.maxX, bounds.maxY, maximumHeight),
    projectIsometric(bounds.minX, bounds.maxY, maximumHeight),
  ]
  return {
    minX: Math.min(...corners.map((point) => point.x)),
    minY: Math.min(...corners.map((point) => point.y)),
    maxX: Math.max(...corners.map((point) => point.x)),
    maxY: Math.max(...corners.map((point) => point.y)),
  }
}

function packShelves(rects: PackedRect[], targetWidth: number, gap: number): {
  rects: PackedRect[]
  width: number
  depth: number
} {
  if (rects.length === 0) return { rects: [], width: 0, depth: 0 }
  let x = 0
  let y = 0
  let rowDepth = 0
  let packedWidth = 0
  const packed: PackedRect[] = []

  for (const rect of rects) {
    if (x > 0 && x + rect.width > targetWidth) {
      x = 0
      y += rowDepth + gap
      rowDepth = 0
    }
    packed.push({ ...rect, x, y })
    x += rect.width + gap
    rowDepth = Math.max(rowDepth, rect.depth)
    packedWidth = Math.max(packedWidth, x - gap)
  }

  return { rects: packed, width: packedWidth, depth: y + rowDepth }
}

function blockDimensions(entry: VisualEntry): { width: number; depth: number; height: number } {
  if (entry.aggregate) {
    const scale = Math.min(1, Math.log10(entry.aggregateCount + 1) / 3.6)
    return { width: 10 + scale * 4.5, depth: 9 + scale * 4, height: 3.2 + scale * 5.4 }
  }
  const byteSize = entry.size ?? 420
  const scale = Math.max(0.08, Math.min(1, Math.log10(byteSize + 24) / 6.1))
  return {
    width: 4.8 + scale * 4.8,
    depth: 4.5 + scale * 4.2,
    height: entry.ghost ? 1.8 : 4.2 + scale * 30,
  }
}

function compareEntriesForPlacement(a: VisualEntry, b: VisualEntry): number {
  return stableHash(a.path || a.id) - stableHash(b.path || b.id)
}

function compareEntriesForSampling(a: VisualEntry, b: VisualEntry): number {
  const aPriority = (a.status ? 3 : 0) + (a.ghost ? 1 : 0)
  const bPriority = (b.status ? 3 : 0) + (b.ghost ? 1 : 0)
  if (aPriority !== bPriority) return bPriority - aPriority
  const sizeDifference = (b.size ?? 0) - (a.size ?? 0)
  if (sizeDifference !== 0) return sizeDifference
  return stableHash(a.path) - stableHash(b.path)
}

function dominantStatus(entries: VisualEntry[]): ChangeKind | null {
  const counts = new Map<ChangeKind, number>()
  for (const entry of entries) {
    if (entry.status) counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1)
  }
  let result: ChangeKind | null = null
  let maximum = 0
  for (const [status, count] of counts) {
    if (count > maximum) {
      result = status
      maximum = count
    }
  }
  return result
}

function basename(path: string): string {
  const normalized = normalizeGitPath(path)
  return normalized.split('/').at(-1) || ROOT_LABEL
}

function extensionOf(path: string): string {
  const name = basename(path)
  const index = name.lastIndexOf('.')
  return index > 0 ? name.slice(index + 1).toLowerCase() : ''
}

function stableHash(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    const current = result.get(key)
    if (current) current.push(item)
    else result.set(key, [item])
  }
  return result
}
