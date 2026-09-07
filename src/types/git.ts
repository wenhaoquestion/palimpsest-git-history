export type ChangeKind = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U'

export interface GitRef {
  name: string
  shortName: string
  kind: 'branch' | 'remote' | 'tag' | 'other'
  oid: string
  current: boolean
}

export interface CommitStats {
  files: number
  additions: number
  deletions: number
  binaries: number
}

export interface CommitSummary {
  oid: string
  shortOid: string
  parents: string[]
  author: { name: string; email: string }
  authoredAt: string
  committedAt: string
  subject: string
  body: string
  directRefs: string[]
  branches: string[]
  lane: number
  stats: CommitStats | null
}

export interface RepositoryInfo {
  name: string
  displayPath: string
  branch: string | null
  headOid: string
  shallow: boolean
  objectFormat: string
  counts: {
    commits: number
    allCommits?: number
    authors: number
    branches: number
    tags: number
  }
}

export interface CommitHistoryPage {
  items: CommitSummary[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
  ref: string
  order: 'chronological-topological'
}

export interface RepositoryHistory {
  ref: string
  total: number
  offset: number
  limit: number
  hasMore: boolean
  order: 'chronological-topological'
}

export type RepositoryPayload = { repositoryId?: string } & (
  | {
      status: 'ready'
      repo: RepositoryInfo
      commits: CommitSummary[]
      history: RepositoryHistory
      refs: GitRef[]
      authors: string[]
      dateRange: { start: string; end: string }
    }
  | {
      status: 'empty' | 'error'
      repoName: string
      displayPath: string
      message: string
      detail?: string
    }
)

export interface TreeFile {
  path: string
  name: string
  directory: string
  extension: string
  oid: string
  mode: string
  type: 'blob' | 'tree' | 'commit' | 'unknown'
  size: number | null
}

export interface FileChange {
  id: string
  status: ChangeKind
  path: string
  previousPath?: string
  similarity?: number
  additions: number | null
  deletions: number | null
  binary: boolean
}

export interface CommitLandscape {
  totalFiles: number
  totalDirectories: number
  totalBytes: number | null
  sampledFiles: number
  sampledDirectories: number
  complete: boolean
  sizeCoverage?: 'sampled'
  directories?: LandscapeDirectory[]
  directorySummary?: { included: number; total: number; maxDepth: number; complete: boolean }
  extensions?: LandscapeExtension[]
}

export interface LandscapeExtension {
  extension: string
  count: number
  totalBytes: number | null
}

export interface LandscapeDirectory {
  path: string
  name: string
  directory: string
  depth: number
  fileCount: number
  directoryCount: number
  totalBytes: number | null
  extensions: LandscapeExtension[]
}

export interface IncludedPage {
  total: number
  included: number
  hasMore: boolean
}

export interface ChangeSummary {
  added: number
  modified: number
  deleted: number
  renamed: number
  copied: number
  typeChanged: number
  unmerged: number
}

export interface CommitDetails {
  oid: string
  tree: TreeFile[]
  changes: FileChange[]
  stats: CommitStats | null
  landscape?: CommitLandscape
  treePage?: IncludedPage
  changesPage?: IncludedPage
  changeSummary?: ChangeSummary
}

export interface TreePagePayload {
  oid: string
  path: string
  items: TreeFile[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
}

export interface ChangesPagePayload {
  oid: string
  items: FileChange[]
  stats: CommitStats
  total: number
  offset: number
  limit: number
  hasMore: boolean
}

export interface DiffPayload {
  oid: string
  path: string
  parentIndex: number
  patch: string
  truncated: boolean
  binary: boolean
}

export interface FileHistoryEntry {
  oid: string
  shortOid: string
  subject: string
  author: string
  authoredAt: string
}

export interface CommitIndexPayload {
  oid: string
  index: number
  total: number
  ref: string
}

export interface WorkspaceChange {
  path: string
  previousPath?: string
  status: string
}

export interface WorkspaceStatus {
  repoPath: string
  branch: string | null
  headOid: string | null
  upstream: string | null
  ahead: number
  behind: number
  staged: WorkspaceChange[]
  unstaged: WorkspaceChange[]
  untracked: WorkspaceChange[]
  conflicts: WorkspaceChange[]
  branches: { name: string; current: boolean; upstream: string | null; remote: string | null; remoteBranch: string | null }[]
  remotes: { name: string }[]
  counts: { staged: number; unstaged: number; untracked: number; conflicts: number }
  clean: boolean
  truncated: boolean
}

export interface WorkspaceMutationResult {
  workspace: WorkspaceStatus
  repositoryChanged: boolean
  repositoryId: string
  message: string
}

export interface WorkspaceDiff {
  path: string
  patch: string
  binary: boolean
  truncated: boolean
  untracked?: boolean
}
