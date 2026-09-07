import { spawn } from 'node:child_process'
import { constants, createWriteStream, rmSync } from 'node:fs'
import { lstat, mkdtemp, open, readlink, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const DEFAULT_MAX_OUTPUT = 64 * 1024 * 1024
const DEFAULT_CACHE_BUDGET = 48 * 1024 * 1024
const DEFAULT_BUFFER_BUDGET = 96 * 1024 * 1024
const DEFAULT_DIRECTORY_LIMIT = 256
const DEFAULT_DIFF_LIMIT = 512 * 1024
// A full Linux snapshot contains tens of thousands of tree entries. Keeping
// only the current and previous snapshots prevents a count-bounded cache from
// becoming a de-facto multi-gigabyte cache.
const DETAILS_CACHE_SIZE = 2
const LANDSCAPE_CACHE_SIZE = 12
const TREE_CACHE_SIZE = 64
const EXACT_CHANGES_CACHE_SIZE = 8
const DIFF_CACHE_SIZE = 48
const HISTORY_CACHE_SIZE = 48
const COMMIT_CACHE_SIZE = 512
const INDEX_CACHE_SIZE = 4
const INDEX_LOOKUP_CACHE_SIZE = 256
const DEFAULT_PAGE_LIMIT = 128
const MAX_PAGE_LIMIT = 512
const PAGE_OBJECT_LIMIT = 32 * 1024 * 1024
const PAGE_STATS_LIMIT = 8 * 1024 * 1024
const DETAILS_OUTPUT_LIMIT = 64 * 1024 * 1024
const DEFAULT_LANDSCAPE_FILE_LIMIT = 720
const DEFAULT_LANDSCAPE_CHANGE_LIMIT = 384
const DEFAULT_TREE_PAGE_LIMIT = 256
const MAX_TREE_PAGE_LIMIT = 1000
const MAX_WORKSPACE_ENTRIES = 1024
const MAX_MUTATION_QUEUE = 16
const MUTATION_QUEUES = new Map()

const EMPTY_STATS = Object.freeze({ files: 0, additions: 0, deletions: 0, binaries: 0 })
const ACTIVE_INDEX_DIRECTORIES = new Set()
let indexCleanupInstalled = false

function registerIndexDirectory(directory) {
  ACTIVE_INDEX_DIRECTORIES.add(directory)
  if (indexCleanupInstalled) return directory
  indexCleanupInstalled = true
  process.once('exit', () => {
    for (const activeDirectory of ACTIVE_INDEX_DIRECTORIES) {
      try {
        rmSync(activeDirectory, { recursive: true, force: true })
      } catch {
        // Temporary indexes are safe to leave for the operating system to
        // reclaim when an unclean shutdown keeps a file handle open.
      }
    }
  })
  return directory
}

export class GitServiceError extends Error {
  constructor(message, { code = 'GIT_ERROR', status = 500, detail, cause } = {}) {
    super(message, { cause })
    this.name = 'GitServiceError'
    this.code = code
    this.status = status
    this.detail = detail
  }
}

// Conservative retained-size accounting, without serializing another copy of
// a large tree. Shared objects within one value count once; across caches they
// count twice deliberately, so eviction errs on the side of less memory.
function retainedBytes(value, limit, seen = new WeakSet()) {
  if (typeof value === 'string') return 24 + value.length * 2
  if (value === null || typeof value !== 'object') return 8
  if (seen.has(value)) return 0
  seen.add(value)
  if (Buffer.isBuffer(value)) return 64 + value.byteLength
  let bytes = 64
  for (const key of Object.keys(value)) {
    bytes += 16 + key.length * 2 + retainedBytes(value[key], limit - bytes, seen)
    if (bytes > limit) break
  }
  return bytes
}

class CacheBudget {
  constructor(limit) {
    this.limit = limit
    this.bytes = 0
    this.entries = new Map()
  }

  touch(entry) {
    this.entries.delete(entry)
    this.entries.set(entry, true)
  }

  remove(entry) {
    if (this.entries.delete(entry)) this.bytes -= entry.bytes
  }

  update(entry, bytes) {
    if (bytes > this.limit) { entry.cache.delete(entry.key); return }
    if (this.entries.has(entry)) this.bytes += bytes - entry.bytes
    else this.bytes += bytes
    entry.bytes = bytes
    this.touch(entry)
    while (this.bytes > this.limit) {
      const oldest = this.entries.keys().next().value
      oldest.cache.delete(oldest.key)
    }
  }
}

class LruCache extends Map {
  constructor(limit, budget) {
    super()
    this.limit = limit
    this.budget = budget
    this.entriesByKey = new Map()
  }

  get(key) {
    if (!super.has(key)) return undefined
    const value = super.get(key)
    super.delete(key)
    super.set(key, value)
    this.budget.touch(this.entriesByKey.get(key))
    return value
  }

  set(key, value) {
    this.delete(key)
    super.set(key, value)
    const entry = { cache: this, key, bytes: 0 }
    this.entriesByKey.set(key, entry)
    const update = (resolved) => {
      if (this.entriesByKey.get(key) !== entry) return
      this.budget.update(entry, 128 + String(key).length * 2 + retainedBytes(resolved, this.budget.limit))
    }
    if (value instanceof Promise) {
      this.budget.update(entry, 512)
      value.then(update, () => {
        if (this.entriesByKey.get(key) === entry) this.delete(key)
      })
    } else update(value)
    while (this.size > this.limit) this.delete(this.keys().next().value)
    return this
  }

  delete(key) {
    const entry = this.entriesByKey.get(key)
    if (entry) this.budget.remove(entry)
    this.entriesByKey.delete(key)
    return super.delete(key)
  }

  clear() {
    for (const key of this.keys()) this.delete(key)
  }
}

const ACTIVE_GIT_PROCESSES = new Set()
process.once('exit', () => {
  for (const child of ACTIVE_GIT_PROCESSES) child.kill('SIGKILL')
})

function cancellationError() {
  return new GitServiceError('The repository service was disposed.', { code: 'SERVICE_DISPOSED', status: 410 })
}

// Slots remain occupied until child.close, including cancellation and output
// failures. A canceled request cannot briefly launch a second wave of Git.
class GitProcessPool {
  constructor({ concurrency, queueLimit, bufferBudget }) {
    this.concurrency = concurrency
    this.queueLimit = queueLimit
    this.bufferBudget = bufferBudget
    this.active = 0
    this.buffered = 0
    this.queue = []
    this.children = new Set()
    this.running = new Set()
    this.disposed = false
    this.controller = new AbortController()
  }

  run(outputBudget, launch) {
    if (this.disposed) return Promise.reject(cancellationError())
    if (this.queue.length >= this.queueLimit) {
      return Promise.reject(new GitServiceError('Git is busy. Retry after the current requests complete.', {
        code: 'GIT_BUSY', status: 503,
      }))
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ outputBudget, launch, resolve, reject })
      this.drain()
    })
  }

  drain() {
    while (!this.disposed && this.active < this.concurrency && this.queue.length) {
      const pending = this.queue[0]
      if (this.buffered + pending.outputBudget > this.bufferBudget) break
      this.queue.shift()
      this.active += 1
      this.buffered += pending.outputBudget
      const work = Promise.resolve().then(() => pending.launch({
        signal: this.controller.signal,
        track: (child) => {
          this.children.add(child)
          ACTIVE_GIT_PROCESSES.add(child)
          child.once('close', () => {
            this.children.delete(child)
            ACTIVE_GIT_PROCESSES.delete(child)
          })
        },
      })).then(pending.resolve, pending.reject).finally(() => {
        this.active -= 1
        this.buffered -= pending.outputBudget
        this.running.delete(work)
        this.drain()
      })
      this.running.add(work)
    }
  }

  async dispose() {
    this.disposed = true
    for (const pending of this.queue.splice(0)) pending.reject(cancellationError())
    this.controller.abort()
    // A custom Git executable may ignore TERM. Native Git normally closes
    // immediately; the escalation prevents a stuck extension shutdown.
    const timer = setTimeout(() => {
      for (const child of this.children) child.kill('SIGKILL')
    }, 500)
    timer.unref()
    await Promise.allSettled([...this.running])
    clearTimeout(timer)
  }
}

function runProcess(command, args, {
  cwd,
  env,
  input,
  maxOutput = DEFAULT_MAX_OUTPUT,
  truncate = false,
  allowFailure = false,
  signal,
  track,
} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(cancellationError()); return }
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    track?.(child)

    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let wasTruncated = false
    let failure
    const fail = (error) => {
      if (failure) return
      failure = error
      stdout.length = 0
      stderr.length = 0
      child.kill()
    }
    const abort = () => fail(cancellationError())
    signal?.addEventListener('abort', abort, { once: true })

    child.on('error', (cause) => {
      fail(new GitServiceError(`Unable to run ${command}.`, {
        code: cause?.code === 'ENOENT' ? 'GIT_NOT_FOUND' : 'PROCESS_ERROR',
        status: 500,
        detail: cause?.message,
        cause,
      }))
    })

    child.stdout.on('data', (chunk) => {
      if (failure || wasTruncated && truncate) return

      if (stdoutBytes + chunk.length <= maxOutput) {
        stdout.push(chunk)
        stdoutBytes += chunk.length
        return
      }

      if (!truncate) {
        child.kill()
        fail(new GitServiceError('Git produced more data than this viewer can safely buffer.', {
          code: 'OUTPUT_TOO_LARGE',
          status: 413,
          detail: `Output exceeded ${maxOutput} bytes.`,
        }))
        return
      }

      const remaining = Math.max(0, maxOutput - stdoutBytes)
      if (remaining > 0) {
        stdout.push(chunk.subarray(0, remaining))
        stdoutBytes += remaining
      }
      wasTruncated = true
      // Continue draining stdout. Killing git here can leave a partial multibyte
      // character and produces platform-dependent exit codes.
    })

    child.stderr.on('data', (chunk) => {
      if (failure) return
      const remaining = Math.max(0, 1024 * 1024 - stderrBytes)
      if (remaining > 0) {
        stderr.push(chunk.subarray(0, remaining))
        stderrBytes += Math.min(remaining, chunk.length)
      }
    })

    child.on('close', (exitCode, exitSignal) => {
      signal?.removeEventListener('abort', abort)
      if (failure) { reject(failure); return }
      const result = {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString('utf8').trim(),
        exitCode: exitCode ?? 1,
        signal: exitSignal,
        truncated: wasTruncated,
      }

      if (result.exitCode !== 0 && !allowFailure) {
        reject(new GitServiceError('Git could not complete the requested operation.', {
          code: 'GIT_COMMAND_FAILED',
          status: 500,
          detail: result.stderr || `git exited with status ${result.exitCode}`,
        }))
      } else {
        resolve(result)
      }
    })

    if (input == null) {
      child.stdin.end()
    } else {
      child.stdin.on('error', (error) => {
        if (error.code !== 'EPIPE') fail(error)
      })
      child.stdin.end(input)
    }
  })
}

/**
 * Stream stdout directly to disk instead of retaining a repository-sized
 * rev-list in the Node heap. Git still performs the full graph walk once, but
 * the viewer's memory use stays constant even for histories with millions of
 * commits.
 */
function runProcessToFile(command, args, filePath, { cwd, env, signal, track } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(cancellationError()); return }
    const child = spawn(command, args, {
      cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    track?.(child)
    const output = createWriteStream(filePath, { flags: 'wx' })
    const stderr = []
    let stderrBytes = 0
    let records = 0
    let childClosed = false
    let outputClosed = false
    let exitCode = 1
    let failure

    const finish = () => {
      if (!childClosed || !outputClosed) return
      signal?.removeEventListener('abort', abort)
      if (failure) { reject(failure); return }
      const detail = Buffer.concat(stderr).toString('utf8').trim()
      if (exitCode !== 0) {
        reject(new GitServiceError('Git could not build the history index.', {
          code: 'GIT_COMMAND_FAILED', status: 500,
          detail: detail || `git exited with status ${exitCode}`,
        }))
      } else resolve({ records })
    }
    const fail = (error) => {
      if (failure) return
      failure = error
      child.kill()
      output.destroy()
    }
    const abort = () => fail(cancellationError())
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', (cause) => fail(new GitServiceError(`Unable to run ${command}.`, {
      code: cause?.code === 'ENOENT' ? 'GIT_NOT_FOUND' : 'PROCESS_ERROR',
      status: 500, detail: cause?.message, cause,
    })))
    output.on('error', (cause) => fail(new GitServiceError('The history index could not be written.', {
      code: 'INDEX_WRITE_FAILED', status: 500, detail: cause?.message, cause,
    })))
    output.on('close', () => { outputClosed = true; finish() })
    child.stdout.on('data', (chunk) => {
      let cursor = -1
      while ((cursor = chunk.indexOf(0x0a, cursor + 1)) !== -1) records += 1
    })
    child.stderr.on('data', (chunk) => {
      if (failure) return
      const remaining = Math.max(0, 1024 * 1024 - stderrBytes)
      if (remaining > 0) {
        stderr.push(chunk.subarray(0, remaining))
        stderrBytes += Math.min(remaining, chunk.length)
      }
    })
    child.on('close', (code) => {
      childClosed = true
      exitCode = code ?? 1
      finish()
    })
    child.stdout.pipe(output)
  })
}

function normalizeOutput(buffer) {
  return buffer.toString('utf8').replace(/\r\n/g, '\n')
}

function cleanGitError(detail) {
  if (!detail) return undefined
  return detail
    .replace(/(?:fatal|error):\s*/gi, '')
    .replace(/\r?\n/g, ' ')
    .trim()
    .slice(0, 500)
}

function parseIdentity(value = '') {
  const match = /^(.*) <([^<>]*)> (-?\d+) ([+-]\d{4})$/.exec(value)
  if (!match) {
    return { name: value || 'Unknown author', email: '', at: new Date(0).toISOString() }
  }
  return {
    name: match[1] || 'Unknown author',
    email: match[2],
    at: gitTimestampToIso(Number(match[3]), match[4]),
  }
}

function gitTimestampToIso(seconds, offset) {
  if (!Number.isFinite(seconds) || !/^[+-]\d{4}$/.test(offset)) {
    return new Date(0).toISOString()
  }
  const sign = offset[0] === '-' ? -1 : 1
  const hours = Number(offset.slice(1, 3))
  const minutes = Number(offset.slice(3, 5))
  const offsetMinutes = sign * (hours * 60 + minutes)
  const local = new Date((seconds + offsetMinutes * 60) * 1000)
  const localIso = local.toISOString().slice(0, 19)
  return `${localIso}${offset.slice(0, 3)}:${offset.slice(3, 5)}`
}

function decodeCommitMessage(buffer, encoding) {
  const normalized = String(encoding || '').trim().toLowerCase()
  if (normalized === 'iso-8859-1' || normalized === 'latin1' || normalized === 'latin-1') {
    return buffer.toString('latin1')
  }
  if (normalized === 'utf-16le' || normalized === 'ucs-2') return buffer.toString('utf16le')
  return buffer.toString('utf8')
}

function splitCommitMessage(message) {
  const cleaned = message.replace(/\r\n/g, '\n').replace(/\n+$/g, '')
  if (!cleaned) return { subject: '(no commit message)', body: '' }

  const paragraphs = cleaned.split(/\n[ \t]*\n/)
  const subject = (paragraphs.shift() || '(no commit message)')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
  return { subject: subject || '(no commit message)', body: paragraphs.join('\n\n').trim() }
}

function parseCommitObject(oid, content) {
  const separator = content.indexOf(Buffer.from('\n\n'))
  const headerBuffer = separator === -1 ? content : content.subarray(0, separator)
  const messageBuffer = separator === -1 ? Buffer.alloc(0) : content.subarray(separator + 2)
  const headerLines = headerBuffer.toString('utf8').split('\n')
  const parents = []
  let authorLine = ''
  let committerLine = ''
  let encoding = ''

  for (const line of headerLines) {
    if (line.startsWith('parent ')) parents.push(line.slice(7).trim())
    else if (line.startsWith('author ')) authorLine = line.slice(7)
    else if (line.startsWith('committer ')) committerLine = line.slice(10)
    else if (line.startsWith('encoding ')) encoding = line.slice(9)
  }

  const author = parseIdentity(authorLine)
  const committer = parseIdentity(committerLine)
  const { subject, body } = splitCommitMessage(decodeCommitMessage(messageBuffer, encoding))

  return {
    oid,
    shortOid: oid.slice(0, 8),
    parents,
    author: { name: author.name, email: author.email },
    authoredAt: author.at,
    committedAt: committer.at,
    subject,
    body,
    directRefs: [],
    branches: [],
    lane: 0,
    stats: null,
  }
}

function parseBatchObjects(buffer, requestedOids) {
  const objects = new Map()
  let cursor = 0

  while (cursor < buffer.length) {
    const lineEnd = buffer.indexOf(0x0a, cursor)
    if (lineEnd === -1) break
    const header = buffer.subarray(cursor, lineEnd).toString('ascii')
    cursor = lineEnd + 1
    const match = /^([0-9a-f]+) (\S+) (\d+)$/.exec(header)
    if (!match) {
      throw new GitServiceError('Git returned malformed object data.', {
        code: 'MALFORMED_GIT_OUTPUT',
        status: 500,
        detail: header.slice(0, 160),
      })
    }
    const size = Number(match[3])
    if (cursor + size > buffer.length) {
      throw new GitServiceError('Git returned an incomplete commit object.', {
        code: 'MALFORMED_GIT_OUTPUT',
        status: 500,
      })
    }
    const content = buffer.subarray(cursor, cursor + size)
    cursor += size
    if (buffer[cursor] === 0x0a) cursor += 1
    if (match[2] === 'commit') objects.set(match[1], parseCommitObject(match[1], content))
  }

  for (const oid of requestedOids) {
    if (!objects.has(oid)) {
      throw new GitServiceError(`Commit ${oid.slice(0, 12)} could not be read.`, {
        code: 'MISSING_COMMIT',
        status: 500,
      })
    }
  }
  return objects
}

function parseShortStatsLog(text) {
  const result = new Map()
  let currentOid = null
  let stats = null

  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith('@@PALIMPSEST:')) {
      if (currentOid && stats) result.set(currentOid, stats)
      currentOid = line.slice('@@PALIMPSEST:'.length).trim()
      stats = { ...EMPTY_STATS }
      continue
    }
    if (!currentOid || !stats || !line) continue
    const shortStat = /(\d+) files? changed/.exec(line)
    if (shortStat) {
      stats.files = Number(shortStat[1]) || 0
      stats.additions = Number(/(\d+) insertions?\(\+\)/.exec(line)?.[1]) || 0
      stats.deletions = Number(/(\d+) deletions?\(-\)/.exec(line)?.[1]) || 0
    }
  }
  if (currentOid && stats) result.set(currentOid, stats)
  return result
}

function parseRefs(text, currentBranch) {
  const refs = []
  for (const record of text.split('\n')) {
    if (!record) continue
    const [name, directOid, peeledOid, objectType, symbolicTarget] = record.split('\0')
    if (!name || symbolicTarget) continue

    let kind = 'other'
    let shortName = name
    if (name.startsWith('refs/heads/')) {
      kind = 'branch'
      shortName = name.slice('refs/heads/'.length)
    } else if (name.startsWith('refs/remotes/')) {
      kind = 'remote'
      shortName = name.slice('refs/remotes/'.length)
    } else if (name.startsWith('refs/tags/')) {
      kind = 'tag'
      shortName = name.slice('refs/tags/'.length)
    }

    refs.push({
      name,
      shortName,
      kind,
      oid: peeledOid || directOid,
      current: kind === 'branch' && currentBranch === shortName,
      objectType,
    })
  }

  const order = { branch: 0, remote: 1, tag: 2, other: 3 }
  refs.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1
    return order[a.kind] - order[b.kind] || a.shortName.localeCompare(b.shortName)
  })
  return refs
}

async function mapLimit(items, limit, mapper) {
  const output = new Array(items.length)
  let next = 0
  async function worker() {
    while (true) {
      const index = next
      next += 1
      if (index >= items.length) return
      output[index] = await mapper(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return output
}

function assignLanes(commits, refs, headOid) {
  const byOid = new Map(commits.map((commit) => [commit.oid, commit]))
  const preferredChild = new Map()

  const claimFirstParentPath = (tipOid) => {
    const seen = new Set()
    let childOid = tipOid
    while (byOid.has(childOid) && !seen.has(childOid)) {
      seen.add(childOid)
      const commit = byOid.get(childOid)
      const parentOid = commit.parents[0]
      if (!parentOid || !byOid.has(parentOid)) break
      if (!preferredChild.has(parentOid)) preferredChild.set(parentOid, childOid)
      childOid = parentOid
    }
  }

  claimFirstParentPath(headOid)
  for (const ref of refs) claimFirstParentPath(ref.oid)
  for (const commit of commits) {
    const parentOid = commit.parents[0]
    if (parentOid && !preferredChild.has(parentOid)) preferredChild.set(parentOid, commit.oid)
  }

  const chainByOid = new Map()
  const ranges = []
  for (let index = 0; index < commits.length; index += 1) {
    const commit = commits[index]
    const parentOid = commit.parents[0]
    let chainId
    if (parentOid && chainByOid.has(parentOid) && preferredChild.get(parentOid) === commit.oid) {
      chainId = chainByOid.get(parentOid)
    } else {
      chainId = ranges.length
      ranges.push({ id: chainId, start: index, end: index, lane: 0 })
    }
    chainByOid.set(commit.oid, chainId)
    ranges[chainId].end = index
  }

  const laneEnds = []
  for (const range of ranges) {
    let lane = laneEnds.findIndex((end) => end < range.start)
    if (lane === -1) lane = laneEnds.length
    range.lane = lane
    laneEnds[lane] = range.end
  }

  for (const commit of commits) commit.lane = ranges[chainByOid.get(commit.oid)].lane
}

function decorateCommits(commits, refs) {
  const byOid = new Map(commits.map((commit) => [commit.oid, commit]))
  for (const ref of refs) {
    const commit = byOid.get(ref.oid)
    if (commit) commit.directRefs.push(ref.shortName)
  }
}

function validateOid(oid) {
  if (typeof oid !== 'string' || !/^[0-9a-fA-F]{7,64}$/.test(oid)) {
    throw new GitServiceError('The commit identifier is invalid.', {
      code: 'INVALID_OID',
      status: 400,
    })
  }
  return oid.toLowerCase()
}

export function validateGitPath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 8192) {
    throw new GitServiceError('A repository-relative file path is required.', {
      code: 'INVALID_PATH',
      status: 400,
    })
  }
  if (filePath.includes('\0') || filePath.startsWith('/') || filePath.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(filePath)) {
    throw new GitServiceError('The file path must stay inside the repository.', {
      code: 'INVALID_PATH',
      status: 400,
    })
  }
  if (filePath === '.') return filePath
  const segments = filePath.split('/')
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    throw new GitServiceError('The file path must stay inside the repository.', {
      code: 'INVALID_PATH',
      status: 400,
    })
  }
  return filePath
}

function parseLsTreeRecord(record, prefix = '') {
  const tab = record.indexOf('\t')
  if (tab === -1) return null
  const metadata = record.slice(0, tab).trim().split(/\s+/)
  const relativePath = record.slice(tab + 1)
  const filePath = prefix ? `${prefix}/${relativePath}` : relativePath
  const [mode = '', rawType = 'unknown', oid = '', rawSize = '-'] = metadata
  const slash = filePath.lastIndexOf('/')
  const name = slash === -1 ? filePath : filePath.slice(slash + 1)
  const directory = slash === -1 ? '' : filePath.slice(0, slash)
  const dot = name.lastIndexOf('.')
  const extension = rawType === 'blob' && dot > 0 && dot < name.length - 1
    ? name.slice(dot + 1).toLowerCase()
    : ''
  const type = rawType === 'blob' || rawType === 'tree' || rawType === 'commit'
    ? rawType
    : 'unknown'
  return {
    path: filePath,
    name,
    directory,
    extension,
    oid,
    mode,
    type,
    size: /^\d+$/.test(rawSize) ? Number(rawSize) : null,
  }
}

function forEachNullRecord(buffer, visitor) {
  let start = 0
  while (start < buffer.length) {
    let end = buffer.indexOf(0, start)
    if (end === -1) end = buffer.length
    if (end > start) visitor(buffer.subarray(start, end).toString('utf8'))
    start = end + 1
  }
}

function parseLsTree(buffer, { prefix = '' } = {}) {
  const tree = []
  forEachNullRecord(buffer, (record) => {
    const entry = parseLsTreeRecord(record, prefix)
    if (entry) tree.push(entry)
  })
  return tree
}

function stableHash(value) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function topLevelPath(filePath) {
  const slash = filePath.indexOf('/')
  return slash === -1 ? '' : filePath.slice(0, slash)
}

function sampleIsWorse(left, right) {
  return left.priority > right.priority
    || left.priority === right.priority && left.score > right.score
}

function heapPushBounded(heap, candidate, limit, isWorse = sampleIsWorse) {
  if (limit <= 0) return
  if (heap.length < limit) {
    heap.push(candidate)
    let cursor = heap.length - 1
    while (cursor > 0) {
      const parent = Math.floor((cursor - 1) / 2)
      if (!isWorse(heap[cursor], heap[parent])) break
      ;[heap[cursor], heap[parent]] = [heap[parent], heap[cursor]]
      cursor = parent
    }
    return
  }
  if (!isWorse(heap[0], candidate)) return
  heap[0] = candidate
  let cursor = 0
  while (true) {
    const left = cursor * 2 + 1
    const right = left + 1
    let worse = cursor
    if (left < heap.length && isWorse(heap[left], heap[worse])) worse = left
    if (right < heap.length && isWorse(heap[right], heap[worse])) worse = right
    if (worse === cursor) break
    ;[heap[cursor], heap[worse]] = [heap[worse], heap[cursor]]
    cursor = worse
  }
}

function topExtensions(counts, limit) {
  const heap = []
  const isWorse = (left, right) => left.count < right.count
    || left.count === right.count && left.extension.localeCompare(right.extension) > 0
  for (const [extension, count] of counts) {
    heapPushBounded(heap, { extension, count, totalBytes: null }, limit, isWorse)
  }
  return heap.sort((left, right) => right.count - left.count || left.extension.localeCompare(right.extension))
}

function representativeSampler(limit) {
  const groups = new Map()
  const heap = []
  return {
    add(group, candidate) {
      const existing = groups.get(group)
      if (existing) {
        if (sampleIsWorse(existing.sample, candidate)) existing.sample = candidate
        return
      }
      const entry = { entry: group, priority: 0, score: stableHash(group), sample: candidate }
      if (heap.length >= limit && !sampleIsWorse(heap[0], entry)) return
      if (heap.length >= limit) groups.delete(heap[0].entry)
      heapPushBounded(heap, entry, limit)
      groups.set(group, entry)
    },
    values: () => [...groups.values()].map((entry) => entry.sample),
  }
}

function summarizeLsTree(buffer, changedPaths, limit, directoryLimit) {
  const sampleHeap = []
  const representatives = representativeSampler(limit)
  const directories = new Map()
  const directoryHeap = []
  let totalSummaryDirectories = 1
  let exactEntries = []
  let totalFiles = 0
  let totalDirectories = 0

  const ensureDirectory = (directoryPath, depth) => {
    let summary = directories.get(directoryPath)
    if (!summary) {
      const candidate = { priority: depth, score: stableHash(directoryPath) }
      // ls-tree visits a directory before its children. The heap cutoff only
      // improves, so an evicted/skipped path cannot re-enter with partial totals.
      if (directoryPath !== '.') {
        if (directoryLimit <= 1) return undefined
        if (directoryHeap.length >= directoryLimit - 1 && !sampleIsWorse(directoryHeap[0], candidate)) return undefined
      }
      const normalized = directoryPath === '.' ? '' : directoryPath
      const slash = normalized.lastIndexOf('/')
      summary = {
        path: directoryPath,
        name: directoryPath === '.' ? 'Repository root' : normalized.slice(slash + 1),
        directory: directoryPath === '.' || slash === -1 ? '' : normalized.slice(0, slash),
        depth,
        fileCount: 0,
        directoryCount: 0,
        totalBytes: null,
        extensions: new Map(),
      }
      if (directoryPath !== '.') {
        if (directoryHeap.length >= directoryLimit - 1) directories.delete(directoryHeap[0].entry.path)
        heapPushBounded(directoryHeap, { ...candidate, entry: summary }, directoryLimit - 1)
      }
      directories.set(directoryPath, summary)
    }
    return summary
  }
  ensureDirectory('.', 0)

  const recordExtension = (summary, extension) => {
    if (!extension) return
    summary.extensions.set(extension, (summary.extensions.get(extension) || 0) + 1)
  }

  forEachNullRecord(buffer, (record) => {
    const entry = parseLsTreeRecord(record)
    if (!entry) return
    if (exactEntries) {
      exactEntries.push(entry)
      if (exactEntries.length > limit) exactEntries = null
    }

    const segments = entry.path.split('/')
    if (entry.type === 'tree') {
      totalDirectories += 1
      if (segments.length <= 2) totalSummaryDirectories += 1
      ensureDirectory('.', 0).directoryCount += 1
      for (let depth = 1; depth <= Math.min(2, segments.length); depth += 1) {
        const directoryPath = segments.slice(0, depth).join('/')
        const summary = ensureDirectory(directoryPath, depth)
        if (summary && depth < segments.length) summary.directoryCount += 1
      }
      return
    }

    totalFiles += 1
    const root = ensureDirectory('.', 0)
    root.fileCount += 1
    recordExtension(root, entry.extension)
    const directorySegments = segments.slice(0, -1)
    for (let depth = 1; depth <= Math.min(2, directorySegments.length); depth += 1) {
      const directoryPath = directorySegments.slice(0, depth).join('/')
      const summary = ensureDirectory(directoryPath, depth)
      if (summary) {
        summary.fileCount += 1
        recordExtension(summary, entry.extension)
      }
    }

    const candidate = {
      entry,
      priority: changedPaths === null || changedPaths.has(entry.path) ? 0 : 1,
      score: stableHash(entry.path),
    }
    heapPushBounded(sampleHeap, candidate, limit)
    const topLevel = topLevelPath(entry.path)
    representatives.add(topLevel, candidate)
  })

  const complete = exactEntries !== null
  let tree
  if (complete) {
    tree = exactEntries
  } else {
    const representativeEntries = [...representatives.values()]
      .sort((left, right) => left.score - right.score)
    const representativePaths = new Set(representativeEntries.map((candidate) => candidate.entry.path))
    const remaining = sampleHeap
      .filter((candidate) => !representativePaths.has(candidate.entry.path))
      .sort((left, right) => left.priority - right.priority || left.score - right.score)
    tree = [...representativeEntries, ...remaining].slice(0, limit).map((candidate) => candidate.entry)
  }

  const globalExtensions = topExtensions(directories.get('.').extensions, 24)
  const publicDirectories = [...directories.values()]
    .map((summary) => ({
      ...summary,
      totalBytes: null,
      extensions: summary.path === '.' ? globalExtensions.slice(0, 6) : topExtensions(summary.extensions, 6),
    }))
    .sort((left, right) => left.depth - right.depth || right.fileCount - left.fileCount || left.path.localeCompare(right.path))

  return {
    tree,
    landscape: {
      totalFiles,
      totalDirectories,
      totalBytes: null,
      sampledFiles: tree.filter((entry) => entry.type !== 'tree').length,
      sampledDirectories: publicDirectories.length,
      complete,
      sizeCoverage: 'sampled',
      directories: publicDirectories,
      directorySummary: {
        included: publicDirectories.length,
        total: totalSummaryDirectories,
        maxDepth: 2,
        complete: publicDirectories.length === totalSummaryDirectories,
      },
      extensions: globalExtensions,
    },
  }
}

function nullTokenReader(buffer) {
  let cursor = 0
  return () => {
    if (cursor >= buffer.length) return null
    let end = buffer.indexOf(0, cursor)
    if (end === -1) end = buffer.length
    // Decode each record separately. Slicing one repository-sized string kept
    // that entire string alive even when only 384 sampled changes were cached.
    const token = buffer.subarray(cursor, end).toString('utf8')
    cursor = end + 1
    return token
  }
}

function readChange(statusToken, next, commitOid) {
  const status = statusToken[0]
  if (!'AMDRCTU'.includes(status)) return null
  let previousPath
  let filePath
  let similarity
  if (status === 'R' || status === 'C') {
    previousPath = next() ?? ''
    filePath = next() ?? ''
    const parsed = Number(statusToken.slice(1))
    similarity = Number.isFinite(parsed) ? parsed : undefined
  } else filePath = next() ?? ''
  return {
    id: `${commitOid}:${status}:${previousPath ? `${previousPath}:` : ''}${filePath}`,
    status,
    path: filePath,
    ...(previousPath ? { previousPath } : {}),
    ...(similarity == null ? {} : { similarity }),
    additions: null,
    deletions: null,
    binary: false,
  }
}

function* parseNameStatus(buffer, commitOid) {
  const next = nullTokenReader(buffer)
  let token
  while ((token = next()) !== null) {
    if (!token) continue
    const change = readChange(token, next, commitOid)
    if (change) yield change
  }
}

function parseExactChanges(buffer, commitOid) {
  const next = nullTokenReader(buffer)
  const changes = []
  const byPath = new Map()
  let token
  while ((token = next()) !== null) {
    if (!token) continue
    if (token.startsWith(':')) {
      const status = token.slice(token.lastIndexOf(' ') + 1)
      const change = readChange(status, next, commitOid)
      if (change) { changes.push(change); byPath.set(change.path, change) }
      continue
    }
    const firstTab = token.indexOf('\t')
    const secondTab = firstTab === -1 ? -1 : token.indexOf('\t', firstTab + 1)
    if (secondTab === -1) continue
    const additionsRaw = token.slice(0, firstTab)
    const deletionsRaw = token.slice(firstTab + 1, secondTab)
    let filePath = token.slice(secondTab + 1)
    if (!filePath) { next(); filePath = next() ?? '' }
    const change = byPath.get(filePath)
    if (!change) continue
    change.binary = additionsRaw === '-' || deletionsRaw === '-'
    change.additions = change.binary ? null : Number(additionsRaw) || 0
    change.deletions = change.binary ? null : Number(deletionsRaw) || 0
  }
  return changes
}

function aggregateChanges(changes) {
  return changes.reduce((stats, change) => {
    stats.files += 1
    if (change.binary) stats.binaries += 1
    else {
      stats.additions += change.additions || 0
      stats.deletions += change.deletions || 0
    }
    return stats
  }, { ...EMPTY_STATS })
}

function summarizeChanges(changes, limit, { trackPaths = true } = {}) {
  const changedPaths = trackPaths ? new Set() : null
  let total = 0
  let exactEntries = []
  const statusCounts = { A: 0, M: 0, D: 0, R: 0, C: 0, T: 0, U: 0 }
  const heap = []
  const representatives = representativeSampler(limit)
  for (const change of changes) {
    total += 1
    if (exactEntries) {
      exactEntries.push(change)
      if (exactEntries.length > limit) exactEntries = null
    }
    if (changedPaths) {
      changedPaths.add(change.path)
      if (change.previousPath) changedPaths.add(change.previousPath)
    }
    statusCounts[change.status] = (statusCounts[change.status] || 0) + 1
    const candidate = { entry: change, priority: 0, score: stableHash(`${change.status}:${change.path}`) }
    heapPushBounded(heap, candidate, limit)
    const topLevel = topLevelPath(change.path)
    representatives.add(topLevel, candidate)
  }
  if (exactEntries) {
    return { changes: exactEntries, total, complete: true, statusCounts, changedPaths }
  }
  const representativeEntries = [...representatives.values()].sort((left, right) => left.score - right.score)
  const representativeIds = new Set(representativeEntries.map((candidate) => candidate.entry.id))
  const remaining = heap
    .filter((candidate) => !representativeIds.has(candidate.entry.id))
    .sort((left, right) => left.score - right.score)
  return {
    changes: [...representativeEntries, ...remaining].slice(0, limit).map((candidate) => candidate.entry),
    total,
    changedPaths,
    complete: false,
    statusCounts,
  }
}

function detailsDiffArgs(commit, format, { copiesHarder = true } = {}) {
  const options = [
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    '--find-renames',
    '--find-copies',
    ...(copiesHarder ? ['--find-copies-harder'] : []),
    '-r',
    '-z',
    ...(Array.isArray(format) ? format : [format]),
  ]
  if (commit.parents.length === 0) {
    return ['diff-tree', '--root', '--no-commit-id', ...options, commit.oid]
  }
  return ['diff', ...options, commit.parents[0], commit.oid, '--']
}

function publicRef(ref) {
  const { objectType: _objectType, ...value } = ref
  return value
}

function validateWorkspacePath(value) {
  const filePath = validateGitPath(value)
  if (filePath.includes('\\') || filePath.split('/').some((part) => part.toLowerCase() === '.git')) {
    throw new GitServiceError('Choose a working-tree path using forward slashes, outside Git metadata.', {
      code: 'INVALID_PATH', status: 400,
    })
  }
  return filePath
}

function parseWorkspaceStatus(buffer) {
  const workspace = {
    branch: null, headOid: null, upstream: null, ahead: 0, behind: 0,
    staged: [], unstaged: [], untracked: [], conflicts: [],
    counts: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 },
    clean: true, truncated: false,
  }
  let included = 0
  const add = (kind, change) => {
    workspace.counts[kind] += 1
    if (included < MAX_WORKSPACE_ENTRIES) { workspace[kind].push(change); included += 1 }
    else workspace.truncated = true
  }
  const pathAfter = (record, fields) => {
    let offset = 0
    for (let index = 0; index < fields; index += 1) offset = record.indexOf(' ', offset) + 1
    return record.slice(offset)
  }
  const records = buffer.toString('utf8').split('\0')
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record.startsWith('# branch.oid ')) {
      workspace.headOid = record.slice(13) === '(initial)' ? null : record.slice(13)
    } else if (record.startsWith('# branch.head ')) {
      workspace.branch = record.slice(14) === '(detached)' ? null : record.slice(14)
    } else if (record.startsWith('# branch.upstream ')) {
      workspace.upstream = record.slice(18)
    } else if (record.startsWith('# branch.ab ')) {
      const match = /^# branch.ab \+(\d+) -(\d+)$/.exec(record)
      if (match) { workspace.ahead = Number(match[1]); workspace.behind = Number(match[2]) }
    } else if (record.startsWith('? ')) {
      add('untracked', { path: record.slice(2), status: '?' })
    } else if (record.startsWith('u ')) {
      add('conflicts', { path: pathAfter(record, 10), status: record.slice(2, 4) })
    } else if (record.startsWith('1 ') || record.startsWith('2 ')) {
      const renamed = record[0] === '2'
      const filePath = pathAfter(record, renamed ? 9 : 8)
      const previousPath = renamed ? records[++index] : undefined
      const change = { path: filePath, ...(previousPath ? { previousPath } : {}) }
      if (record[2] !== '.') add('staged', { ...change, status: record[2] })
      if (record[3] !== '.') add('unstaged', { ...change, status: record[3] })
    }
  }
  workspace.clean = Object.values(workspace.counts).every((count) => count === 0)
  return workspace
}

export function createGitService({
  repoPath = process.cwd(),
  gitBinary = 'git',
  environment = process.env,
  diffLimit = DEFAULT_DIFF_LIMIT,
  landscapeFileLimit = DEFAULT_LANDSCAPE_FILE_LIMIT,
  landscapeChangeLimit = DEFAULT_LANDSCAPE_CHANGE_LIMIT,
  landscapeDirectoryLimit = DEFAULT_DIRECTORY_LIMIT,
  cacheBudgetBytes = DEFAULT_CACHE_BUDGET,
  maxConcurrentProcesses = 4,
  maxQueuedProcesses = 64,
  maxBufferedBytes = DEFAULT_BUFFER_BUDGET,
  maxOutputBytes = DEFAULT_MAX_OUTPUT,
} = {}) {
  const requestedPath = path.resolve(repoPath)
  const requestedSafeDirectory = requestedPath.replaceAll('\\', '/')
  const gitEnvironment = {
    ...environment,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    LC_ALL: 'C',
    LANG: 'C',
  }
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']) {
    delete gitEnvironment[name]
  }
  const literalPathEnvironment = { ...gitEnvironment, GIT_LITERAL_PATHSPECS: '1' }
  let rootPromise
  let repositoryPromise
  let indexDirectoryPromise
  let indexSequence = 0
  let generation = 0
  let disposed = false
  let permanentlyDisposed = false
  let restartPromise
  let disposalPromise
  const resourceLimit = (value, fallback, ceiling, minimum = 1) => Number.isSafeInteger(value)
    ? Math.max(minimum, Math.min(ceiling, value)) : fallback
  const cacheBudget = new CacheBudget(resourceLimit(cacheBudgetBytes, DEFAULT_CACHE_BUDGET, 256 * 1024 * 1024, 0))
  const bufferBudget = resourceLimit(maxBufferedBytes, DEFAULT_BUFFER_BUDGET, 256 * 1024 * 1024, 2)
  const outputLimit = Math.min(resourceLimit(maxOutputBytes, DEFAULT_MAX_OUTPUT, DEFAULT_MAX_OUTPUT), Math.floor(bufferBudget / 2))
  const newPool = () => new GitProcessPool({
    concurrency: resourceLimit(maxConcurrentProcesses, 4, 16),
    queueLimit: resourceLimit(maxQueuedProcesses, 64, 256, 4),
    bufferBudget,
  })
  let processPool = newPool()
  const assertActive = () => { if (disposed) throw cancellationError() }
  const detailsCache = new LruCache(DETAILS_CACHE_SIZE, cacheBudget)
  const landscapeCache = new LruCache(LANDSCAPE_CACHE_SIZE, cacheBudget)
  const treeCache = new LruCache(TREE_CACHE_SIZE, cacheBudget)
  const exactChangesCache = new LruCache(EXACT_CHANGES_CACHE_SIZE, cacheBudget)
  const diffCache = new LruCache(DIFF_CACHE_SIZE, cacheBudget)
  const historyCache = new LruCache(HISTORY_CACHE_SIZE, cacheBudget)
  const commitCache = new LruCache(COMMIT_CACHE_SIZE, cacheBudget)
  const pageCache = new LruCache(8, cacheBudget)
  const refResolutionCache = new LruCache(32, cacheBudget)
  const indexLookupCache = new LruCache(INDEX_LOOKUP_CACHE_SIZE, cacheBudget)
  const indexCache = new Map()
  const boundedDirectoryLimit = resourceLimit(landscapeDirectoryLimit, DEFAULT_DIRECTORY_LIMIT, 1024)
  const boundedLandscapeFileLimit = Math.trunc(Math.max(
    1,
    Math.min(5000, Number(landscapeFileLimit) || DEFAULT_LANDSCAPE_FILE_LIMIT),
  ))
  const boundedLandscapeChangeLimit = Math.trunc(Math.max(
    1,
    Math.min(5000, Number(landscapeChangeLimit) || DEFAULT_LANDSCAPE_CHANGE_LIMIT),
  ))

  function executeGit(args, options = {}) {
    assertActive()
    const maxOutput = Math.min(options.maxOutput ?? DEFAULT_MAX_OUTPUT, outputLimit)
    return processPool.run(maxOutput * 2, (lifecycle) => runProcess(gitBinary, args, {
      env: gitEnvironment, ...options, maxOutput, ...lifecycle,
    }))
  }

  const systemGit = (args, options = {}) => executeGit([
    '-c', `safe.directory=${requestedSafeDirectory}`, ...args,
  ], options)

  async function resolveRoot() {
    assertActive()
    if (!rootPromise) {
      rootPromise = (async () => {
        try {
          const info = await stat(requestedPath)
          if (!info.isDirectory()) throw new Error('The path is not a directory.')
        } catch (cause) {
          throw new GitServiceError('The repository folder is not available.', {
            code: 'REPOSITORY_PATH_MISSING',
            status: 404,
            detail: cause?.message,
            cause,
          })
        }

        let result = await systemGit(['-C', requestedPath, 'rev-parse', '--show-toplevel'], {
          allowFailure: true,
        })
        if (result.exitCode !== 0) {
          const bare = await systemGit(['-C', requestedPath, 'rev-parse', '--is-bare-repository'], { allowFailure: true })
          if (bare.exitCode === 0 && normalizeOutput(bare.stdout).trim() === 'true') {
            result = await systemGit(['-C', requestedPath, 'rev-parse', '--absolute-git-dir'], { allowFailure: true })
          }
        }
        if (result.exitCode !== 0) {
          throw new GitServiceError('No Git repository was found in this folder.', {
            code: 'NOT_A_REPOSITORY',
            status: 404,
            detail: cleanGitError(result.stderr),
          })
        }
        const resolved = normalizeOutput(result.stdout).trim()
        if (!resolved) {
          throw new GitServiceError('Git did not report a repository root.', {
            code: 'NOT_A_REPOSITORY',
            status: 404,
          })
        }
        return path.resolve(resolved)
      })()
    }
    return rootPromise
  }

  async function git(args, options = {}) {
    const root = await resolveRoot()
    const safeDirectory = root.replaceAll('\\', '/')
    return executeGit([
      '-c', `safe.directory=${safeDirectory}`,
      '-c', 'core.quotepath=false',
      '-C', root,
      ...args,
    ], {
      env: options.literalPaths ? literalPathEnvironment : gitEnvironment,
      ...options,
    })
  }

  async function gitToFile(args, filePath) {
    const root = await resolveRoot()
    const safeDirectory = root.replaceAll('\\', '/')
    assertActive()
    return processPool.run(0, (lifecycle) => runProcessToFile(gitBinary, [
      '-c', `safe.directory=${safeDirectory}`,
      '-c', 'core.quotepath=false',
      '-C', root,
      ...args,
    ], filePath, { env: gitEnvironment, ...lifecycle }))
  }

  function normalizePage(offset = 0, limit = DEFAULT_PAGE_LIMIT) {
    const parsedOffset = Number(offset)
    const parsedLimit = Number(limit)
    if (!Number.isSafeInteger(parsedOffset) || parsedOffset < 0) {
      throw new GitServiceError('The history offset must be a non-negative integer.', {
        code: 'INVALID_OFFSET',
        status: 400,
      })
    }
    if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_PAGE_LIMIT) {
      throw new GitServiceError(`The history limit must be between 1 and ${MAX_PAGE_LIMIT}.`, {
        code: 'INVALID_LIMIT',
        status: 400,
      })
    }
    return { offset: parsedOffset, limit: parsedLimit }
  }

  function normalizeTreePage(offset = 0, limit = DEFAULT_TREE_PAGE_LIMIT) {
    const parsedOffset = Number(offset)
    const parsedLimit = Number(limit)
    if (!Number.isSafeInteger(parsedOffset) || parsedOffset < 0) {
      throw new GitServiceError('The tree offset must be a non-negative integer.', {
        code: 'INVALID_OFFSET',
        status: 400,
      })
    }
    if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_TREE_PAGE_LIMIT) {
      throw new GitServiceError(`The tree limit must be between 1 and ${MAX_TREE_PAGE_LIMIT}.`, {
        code: 'INVALID_LIMIT',
        status: 400,
      })
    }
    return { offset: parsedOffset, limit: parsedLimit }
  }

  function normalizeRefInput(value) {
    const ref = value == null || value === '' ? 'HEAD' : String(value)
    if (ref.length > 512 || /[\u0000-\u001f\u007f]/.test(ref) || ref.startsWith('-')) {
      throw new GitServiceError('The history ref is invalid.', {
        code: 'INVALID_REF',
        status: 400,
      })
    }
    return ref
  }

  async function resolveHistoryRef(value = 'HEAD') {
    const ref = normalizeRefInput(value)
    const cached = refResolutionCache.get(ref)
    if (cached) return cached

    const promise = (async () => {
      if (ref === 'all') {
        return { ref, key: 'all', revisionArgs: ['--all', 'HEAD'], tipOid: null }
      }
      const result = await git([
        'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`,
      ], { allowFailure: true, maxOutput: 1024 * 1024 })
      if (result.exitCode !== 0) {
        throw new GitServiceError('The requested branch, tag, or commit does not exist.', {
          code: 'REF_NOT_FOUND',
          status: 404,
          detail: cleanGitError(result.stderr),
        })
      }
      const tipOid = normalizeOutput(result.stdout).trim().toLowerCase()
      if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(tipOid)) {
        throw new GitServiceError('Git returned an invalid commit identifier for that ref.', {
          code: 'MALFORMED_GIT_OUTPUT',
          status: 500,
        })
      }
      return { ref, key: `tip:${tipOid}`, revisionArgs: [tipOid], tipOid }
    })()
    refResolutionCache.set(ref, promise)
    try {
      return await promise
    } catch (error) {
      refResolutionCache.delete(ref)
      throw error
    }
  }

  async function getIndexDirectory() {
    if (!indexDirectoryPromise) {
      indexDirectoryPromise = mkdtemp(path.join(tmpdir(), 'palimpsest-history-'))
        .then(registerIndexDirectory)
    }
    return indexDirectoryPromise
  }

  function touchIndex(key, value) {
    if (indexCache.has(key)) indexCache.delete(key)
    indexCache.set(key, value)
    while (indexCache.size > INDEX_CACHE_SIZE) {
      const oldestKey = indexCache.keys().next().value
      const stale = indexCache.get(oldestKey)
      indexCache.delete(oldestKey)
      void Promise.resolve(stale)
        .then((entry) => rm(entry.filePath, { force: true }))
        .catch(() => undefined)
    }
  }

  async function ensureHistoryIndex(resolvedRef, objectFormat = 'sha1') {
    const cached = indexCache.get(resolvedRef.key)
    if (cached) {
      touchIndex(resolvedRef.key, cached)
      return cached
    }

    const activeGeneration = generation
    const promise = (async () => {
      const directory = await getIndexDirectory()
      const filePath = path.join(directory, `history-${indexSequence += 1}.oids`)
      try {
        // --date-order preserves the parent-before-child invariant when
        // reversed, while keeping independent branches close to wall-clock
        // chronology. Only fixed-width OIDs are written to the disk index.
        const { records } = await gitToFile([
          'rev-list', ...resolvedRef.revisionArgs, '--date-order', '--reverse', '--',
        ], filePath)
        const oidLength = objectFormat === 'sha256' ? 64 : 40
        const recordSize = oidLength + 1
        const info = await stat(filePath)
        if (info.size !== records * recordSize) {
          throw new GitServiceError('Git returned a malformed history index.', {
            code: 'MALFORMED_GIT_OUTPUT',
            status: 500,
          })
        }
        if (generation !== activeGeneration) {
          await rm(filePath, { force: true })
          throw new GitServiceError('The repository changed while its history was being indexed.', {
            code: 'STALE_HISTORY_INDEX',
            status: 409,
          })
        }
        return {
          key: resolvedRef.key,
          filePath,
          total: records,
          oidLength,
          recordSize,
          tipOid: resolvedRef.tipOid,
        }
      } catch (error) {
        await rm(filePath, { force: true }).catch(() => undefined)
        throw error
      }
    })()
    touchIndex(resolvedRef.key, promise)
    try {
      return await promise
    } catch (error) {
      if (indexCache.get(resolvedRef.key) === promise) indexCache.delete(resolvedRef.key)
      throw error
    }
  }

  async function readIndexOids(index, offset, limit) {
    if (offset >= index.total || limit === 0) return []
    const count = Math.min(limit, index.total - offset)
    const buffer = Buffer.allocUnsafe(count * index.recordSize)
    const handle = await open(index.filePath, 'r')
    let bytesRead = 0
    try {
      while (bytesRead < buffer.length) {
        const result = await handle.read(
          buffer,
          bytesRead,
          buffer.length - bytesRead,
          offset * index.recordSize + bytesRead,
        )
        if (result.bytesRead === 0) break
        bytesRead += result.bytesRead
      }
    } finally {
      await handle.close()
    }
    if (bytesRead !== buffer.length) {
      throw new GitServiceError('The history index ended unexpectedly.', {
        code: 'INDEX_READ_FAILED',
        status: 500,
      })
    }
    const oids = []
    for (let cursor = 0; cursor < buffer.length; cursor += index.recordSize) {
      const oid = buffer.subarray(cursor, cursor + index.oidLength).toString('ascii')
      if (!/^[0-9a-f]+$/.test(oid) || buffer[cursor + index.oidLength] !== 0x0a) {
        throw new GitServiceError('The history index contains invalid commit data.', {
          code: 'INDEX_READ_FAILED',
          status: 500,
        })
      }
      oids.push(oid)
    }
    return oids
  }

  async function readCommitObjects(oids) {
    const byOid = new Map()
    const missing = []
    for (const oid of oids) {
      const cached = commitCache.get(oid)
      if (cached) byOid.set(oid, cached)
      else missing.push(oid)
    }
    if (missing.length) {
      const result = await git(['cat-file', '--batch'], {
        input: Buffer.from(`${missing.join('\n')}\n`),
        maxOutput: PAGE_OBJECT_LIMIT,
      })
      const parsed = parseBatchObjects(result.stdout, missing)
      for (const oid of missing) {
        const commit = parsed.get(oid)
        commitCache.set(oid, commit)
        byOid.set(oid, commit)
      }
    }
    return oids.map((oid) => {
      const commit = byOid.get(oid)
      return cloneCommit(commit)
    })
  }

  function cloneCommit(commit) {
    return {
      ...commit,
      parents: [...commit.parents],
      author: { ...commit.author },
      directRefs: [],
      branches: [],
      stats: null,
    }
  }

  async function loadPageStats(oids) {
    const stats = new Map()
    // Keep Windows' process command line comfortably below its length limit,
    // including for future SHA-256 repositories.
    const chunks = []
    for (let index = 0; index < oids.length; index += 128) chunks.push(oids.slice(index, index + 128))
    const partials = await mapLimit(chunks, 2, async (chunk) => {
      const result = await git([
        'show', '--no-ext-diff', '--no-textconv', '--no-renames', '--shortstat', '--root', '--diff-merges=first-parent',
        '--format=@@PALIMPSEST:%H', ...chunk, '--',
      ], { maxOutput: PAGE_STATS_LIMIT })
      return parseShortStatsLog(normalizeOutput(result.stdout))
    })
    for (const partial of partials) {
      for (const [oid, value] of partial) stats.set(oid, value)
    }
    return stats
  }

  function selectedBranchName(ref, refs, currentBranch) {
    if (ref === 'HEAD') return currentBranch
    if (ref === 'all') return null
    const match = refs.find((entry) => (
      (entry.kind === 'branch' || entry.kind === 'remote')
      && (entry.name === ref || entry.shortName === ref)
    ))
    return match?.shortName || null
  }

  async function loadCommitPage({ resolvedRef, index, offset, limit, refs, currentBranch, includeStats = true }) {
    const cacheKey = `${generation}:${resolvedRef.key}:${resolvedRef.ref}:${offset}:${limit}:${includeStats}`
    const cached = pageCache.get(cacheKey)
    if (cached) return cached
    const promise = (async () => {
      const oids = await readIndexOids(index, offset, limit)
      const [commits, statsByOid] = await Promise.all([
        readCommitObjects(oids),
        includeStats && oids.length ? loadPageStats(oids) : Promise.resolve(new Map()),
      ])
      decorateCommits(commits, refs)
      const branchName = selectedBranchName(resolvedRef.ref, refs, currentBranch)
      for (let itemIndex = 0; itemIndex < commits.length; itemIndex += 1) {
        const commit = commits[itemIndex]
        commit.index = offset + itemIndex
        commit.stats = includeStats ? statsByOid.get(commit.oid) || { ...EMPTY_STATS } : null
        const directBranches = refs
          .filter((entry) => entry.oid === commit.oid && (entry.kind === 'branch' || entry.kind === 'remote'))
          .map((entry) => entry.shortName)
        commit.branches = [...new Set([...(branchName ? [branchName] : []), ...directBranches])]
      }
      assignLanes(commits, refs, index.tipOid || commits.at(-1)?.oid)
      return commits
    })()
    pageCache.set(cacheKey, promise)
    try {
      return await promise
    } catch (error) {
      pageCache.delete(cacheKey)
      throw error
    }
  }

  function parseAuthors(text) {
    const authors = new Set()
    for (const line of text.split('\n')) {
      const identity = line.replace(/^\s*\d+\s+/, '').trim()
      if (!identity) continue
      const name = identity.replace(/\s+<[^<>]*>\s*$/, '').trim()
      authors.add(name || identity)
    }
    return [...authors].sort((left, right) => left.localeCompare(right))
  }

  async function repositoryFailure(error) {
    return {
      status: 'error',
      repoName: path.basename(requestedPath) || requestedPath,
      displayPath: requestedPath,
      message: error instanceof GitServiceError ? error.message : 'The repository could not be loaded.',
      ...(error?.detail ? { detail: error.detail } : {}),
    }
  }

  async function loadRepository() {
    let root
    try {
      root = await resolveRoot()
    } catch (error) {
      return repositoryFailure(error)
    }

    const headResult = await git(['rev-parse', '--verify', 'HEAD^{commit}'], { allowFailure: true })
    if (headResult.exitCode !== 0) {
      return {
        status: 'empty',
        repoName: path.basename(root) || root,
        displayPath: root,
        message: 'This Git repository does not contain any commits yet.',
      }
    }

    try {
      const headOid = normalizeOutput(headResult.stdout).trim()
      const [branchResult, shallowResult, formatResult, refResult] = await Promise.all([
        git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true }),
        git(['rev-parse', '--is-shallow-repository'], { allowFailure: true }),
        git(['rev-parse', '--show-object-format'], { allowFailure: true }),
        git([
          'for-each-ref',
          '--format=%(refname)%00%(objectname)%00%(*objectname)%00%(objecttype)%00%(symref)',
          'refs/heads',
          'refs/remotes',
          'refs/tags',
        ]),
      ])

      const currentBranch = branchResult.exitCode === 0 ? normalizeOutput(branchResult.stdout).trim() || null : null
      const shallow = shallowResult.exitCode === 0 && normalizeOutput(shallowResult.stdout).trim() === 'true'
      const objectFormat = formatResult.exitCode === 0 ? normalizeOutput(formatResult.stdout).trim() || 'sha1' : 'sha1'
      const refsInternal = parseRefs(normalizeOutput(refResult.stdout), currentBranch)
      const resolvedRef = await resolveHistoryRef('HEAD')
      // These are independent graph walks. Running them together keeps Linux'
      // one-time cold start near the slowest walk instead of their sum.
      const [authorResult, allCountResult, index] = await Promise.all([
        git(['shortlog', '-sne', '--all', 'HEAD'], { maxOutput: 16 * 1024 * 1024 }),
        git(['rev-list', '--count', '--all', 'HEAD', '--'], { maxOutput: 1024 * 1024 }),
        ensureHistoryIndex(resolvedRef, objectFormat),
      ])
      const authors = parseAuthors(normalizeOutput(authorResult.stdout))
      const allCommits = Number(normalizeOutput(allCountResult.stdout).trim())
      const commits = await loadCommitPage({
        resolvedRef,
        index,
        offset: 0,
        limit: DEFAULT_PAGE_LIMIT,
        refs: refsInternal,
        currentBranch,
        includeStats: false,
      })
      const headCommit = (await readCommitObjects([headOid]))[0]
      const startTime = commits
        .map((commit) => commit.authoredAt)
        .filter(Boolean)
        .sort((left, right) => Date.parse(left) - Date.parse(right))[0]

      return {
        status: 'ready',
        repo: {
          name: path.basename(root) || root,
          displayPath: root,
          branch: currentBranch,
          headOid,
          shallow,
          objectFormat,
          counts: {
            commits: index.total,
            allCommits: Number.isSafeInteger(allCommits) ? allCommits : index.total,
            authors: authors.length,
            branches: refsInternal.filter((ref) => ref.kind === 'branch' || ref.kind === 'remote').length,
            tags: refsInternal.filter((ref) => ref.kind === 'tag').length,
          },
        },
        commits,
        refs: refsInternal.map(publicRef),
        authors,
        dateRange: {
          start: startTime || headCommit.authoredAt,
          end: headCommit.authoredAt,
        },
        history: {
          ref: 'HEAD',
          offset: 0,
          limit: DEFAULT_PAGE_LIMIT,
          total: index.total,
          hasMore: commits.length < index.total,
          order: 'chronological-topological',
        },
      }
    } catch (error) {
      return repositoryFailure(error)
    }
  }

  async function getRepository({ includeStats = true } = {}) {
    assertActive()
    if (!repositoryPromise) {
      const activeGeneration = generation
      repositoryPromise = loadRepository().then((payload) => {
        if (generation !== activeGeneration) return getRepository({ includeStats: false })
        return payload
      })
    }
    const payload = await repositoryPromise
    if (!includeStats || payload.status !== 'ready') return payload
    const activeGeneration = generation
    try {
      const page = await getCommits({ includeStats: true })
      if (generation !== activeGeneration) return getRepository({ includeStats })
      return { ...payload, commits: page.items }
    } catch (error) {
      return repositoryFailure(error)
    }
  }

  async function requireReadyRepository() {
    const payload = await getRepository({ includeStats: false })
    if (payload.status !== 'ready') {
      throw new GitServiceError(payload.message, {
        code: payload.status === 'empty' ? 'EMPTY_REPOSITORY' : 'REPOSITORY_UNAVAILABLE',
        status: payload.status === 'empty' ? 409 : 404,
        detail: payload.detail,
      })
    }
    return payload
  }

  async function resolveKnownCommit(oid) {
    const inputOid = validateOid(oid)
    await requireReadyRepository()
    // Timeline pages already loaded these full object IDs through cat-file.
    // Reusing that proof avoids another ~60 ms Git process launch on Windows
    // for the overwhelmingly common playback path.
    if (inputOid.length === 40 || inputOid.length === 64) {
      const cached = commitCache.get(inputOid)
      if (cached) return cloneCommit(cached)
    }
    const result = await git([
      'rev-parse', '--verify', '--end-of-options', `${inputOid}^{commit}`,
    ], { allowFailure: true, maxOutput: 1024 * 1024 })
    if (result.exitCode !== 0) {
      throw new GitServiceError('That commit is not part of the visible repository history.', {
        code: 'COMMIT_NOT_FOUND',
        status: 404,
        detail: cleanGitError(result.stderr),
      })
    }
    const resolvedOid = normalizeOutput(result.stdout).trim().toLowerCase()
    return (await readCommitObjects([resolvedOid]))[0]
  }

  async function getCommits({ offset = 0, limit = DEFAULT_PAGE_LIMIT, ref = 'HEAD', includeStats = true } = {}) {
    const page = normalizePage(offset, limit)
    const repository = await requireReadyRepository()
    const resolvedRef = await resolveHistoryRef(ref)
    const index = await ensureHistoryIndex(resolvedRef, repository.repo.objectFormat)
    const items = await loadCommitPage({
      resolvedRef,
      index,
      ...page,
      refs: repository.refs,
      currentBranch: repository.repo.branch,
      includeStats,
    })
    return {
      items,
      total: index.total,
      offset: page.offset,
      limit: page.limit,
      hasMore: page.offset + items.length < index.total,
      ref: resolvedRef.ref,
      order: 'chronological-topological',
    }
  }

  async function getCommitIndex(oid, { ref = 'HEAD' } = {}) {
    const commit = await resolveKnownCommit(oid)
    const repository = await requireReadyRepository()
    const resolvedRef = await resolveHistoryRef(ref)
    const index = await ensureHistoryIndex(resolvedRef, repository.repo.objectFormat)
    const cacheKey = `${generation}:${index.key}:${resolvedRef.ref}:${commit.oid}`
    const cached = indexLookupCache.get(cacheKey)
    if (cached) return cached

    const promise = (async () => {
      const scanSize = 8192
      for (let offset = 0; offset < index.total; offset += scanSize) {
        const oids = await readIndexOids(index, offset, scanSize)
        const relative = oids.indexOf(commit.oid)
        if (relative !== -1) {
          return { oid: commit.oid, index: offset + relative, total: index.total, ref: resolvedRef.ref }
        }
      }
      throw new GitServiceError('That commit is not reachable from the requested history ref.', {
        code: 'COMMIT_NOT_IN_REF',
        status: 404,
      })
    })()
    indexLookupCache.set(cacheKey, promise)
    try {
      return await promise
    } catch (error) {
      indexLookupCache.delete(cacheKey)
      throw error
    }
  }

  async function loadExactChanges(commit) {
    const cached = exactChangesCache.get(commit.oid)
    if (cached) return cached
    const promise = (async () => {
      // One Git diff computes rename/copy matching and line counts once. Raw
      // records and numstat are consumed into the same change objects, avoiding
      // two full output buffers, a token array, and a second stats-object array.
      const result = await git(detailsDiffArgs(commit, ['--raw', '--numstat']), { maxOutput: DETAILS_OUTPUT_LIMIT })
      const changes = parseExactChanges(result.stdout, commit.oid)
      return { changes, stats: aggregateChanges(changes) }
    })()
    exactChangesCache.set(commit.oid, promise)
    try {
      return await promise
    } catch (error) {
      exactChangesCache.delete(commit.oid)
      throw error
    }
  }

  async function hydrateTreeSizes(entries) {
    const objectIds = [...new Set(entries
      .filter((entry) => entry.type === 'blob' && entry.oid)
      .map((entry) => entry.oid))]
    if (objectIds.length === 0) return entries
    const result = await git(['cat-file', '--batch-check=%(objectname) %(objectsize)'], {
      input: Buffer.from(`${objectIds.join('\n')}\n`),
      maxOutput: 4 * 1024 * 1024,
    })
    const sizes = new Map()
    for (const line of normalizeOutput(result.stdout).split('\n')) {
      const match = /^([0-9a-f]+) (\d+)$/.exec(line)
      if (match) sizes.set(match[1], Number(match[2]))
    }
    for (const entry of entries) {
      if (sizes.has(entry.oid)) entry.size = sizes.get(entry.oid)
    }
    return entries
  }

  async function getCommitLandscape(oid) {
    const inputOid = validateOid(oid)
    if (inputOid.length === 40 || inputOid.length === 64) {
      const directCached = landscapeCache.get(inputOid)
      if (directCached) return directCached
    }
    const commit = await resolveKnownCommit(inputOid)
    const cached = landscapeCache.get(commit.oid)
    if (cached) return cached
    const promise = (async () => {
      // Per-file numstat is intentionally absent here. On Linux's root commit
      // it costs ~1.3 seconds by itself; the exact /api/changes endpoint keeps
      // it available when the user opens detailed inspection.
      const [treeResult, statusResult] = await Promise.all([
        git(['ls-tree', '-r', '-t', '-z', commit.oid], { maxOutput: DETAILS_OUTPUT_LIMIT }),
        git(detailsDiffArgs(commit, '--name-status', { copiesHarder: false }), { maxOutput: DETAILS_OUTPUT_LIMIT }),
      ])
      const changeSummary = summarizeChanges(
        parseNameStatus(statusResult.stdout, commit.oid),
        boundedLandscapeChangeLimit,
        { trackPaths: commit.parents.length > 0 },
      )
      statusResult.stdout = null
      const treeSummary = summarizeLsTree(treeResult.stdout, changeSummary.changedPaths, boundedLandscapeFileLimit, boundedDirectoryLimit)
      treeResult.stdout = null
      changeSummary.changedPaths = null
      await hydrateTreeSizes(treeSummary.tree)
      return {
        oid: commit.oid,
        tree: treeSummary.tree,
        changes: changeSummary.changes,
        stats: null,
        landscape: treeSummary.landscape,
        treePage: {
          total: treeSummary.landscape.totalFiles + treeSummary.landscape.totalDirectories,
          included: treeSummary.tree.length,
          hasMore: !treeSummary.landscape.complete,
          scope: 'recursive-sample',
        },
        changesPage: {
          total: changeSummary.total,
          included: changeSummary.changes.length,
          hasMore: !changeSummary.complete,
        },
        changeSummary: {
          added: changeSummary.statusCounts.A,
          modified: changeSummary.statusCounts.M,
          deleted: changeSummary.statusCounts.D,
          renamed: changeSummary.statusCounts.R,
          copied: changeSummary.statusCounts.C,
          typeChanged: changeSummary.statusCounts.T,
          unmerged: changeSummary.statusCounts.U,
          total: changeSummary.total,
          statuses: changeSummary.statusCounts,
          complete: changeSummary.complete,
        },
      }
    })()
    landscapeCache.set(commit.oid, promise)
    try {
      return await promise
    } catch (error) {
      landscapeCache.delete(commit.oid)
      throw error
    }
  }

  async function getCommit(oid, { view = 'exact' } = {}) {
    if (view === 'landscape') return getCommitLandscape(oid)
    if (view !== 'exact') {
      throw new GitServiceError('The commit view must be exact or landscape.', {
        code: 'INVALID_VIEW',
        status: 400,
      })
    }
    const commit = await resolveKnownCommit(oid)
    const cached = detailsCache.get(commit.oid)
    if (cached) return cached

    const promise = (async () => {
      const [treeResult, exactChanges] = await Promise.all([
        git(['ls-tree', '-r', '-t', '-l', '-z', commit.oid], { maxOutput: DETAILS_OUTPUT_LIMIT }),
        loadExactChanges(commit),
      ])
      const tree = parseLsTree(treeResult.stdout)
      return { oid: commit.oid, tree, changes: exactChanges.changes, stats: exactChanges.stats }
    })()
    detailsCache.set(commit.oid, promise)
    try {
      return await promise
    } catch (error) {
      detailsCache.delete(commit.oid)
      throw error
    }
  }

  async function getTree(oid, filePath = '.', { offset = 0, limit = DEFAULT_TREE_PAGE_LIMIT } = {}) {
    const commit = await resolveKnownCommit(oid)
    const safePath = filePath == null || filePath === '' || filePath === '.' ? '.' : validateGitPath(filePath)
    const page = normalizeTreePage(offset, limit)
    const cacheKey = `${generation}:${commit.oid}:${safePath}:${page.offset}:${page.limit}`
    const cached = treeCache.get(cacheKey)
    if (cached) return cached
    const promise = (async () => {
      const treeish = safePath === '.' ? commit.oid : `${commit.oid}:${safePath}`
      const result = await git(['ls-tree', '-z', treeish], {
        allowFailure: true,
        maxOutput: DETAILS_OUTPUT_LIMIT,
      })
      if (result.exitCode !== 0) {
        throw new GitServiceError('That directory does not exist in this commit.', {
          code: 'TREE_PATH_NOT_FOUND',
          status: 404,
          detail: cleanGitError(result.stderr),
        })
      }
      const items = []
      let total = 0
      forEachNullRecord(result.stdout, (record) => {
        if (!record.includes('\t')) return
        if (total >= page.offset && items.length < page.limit) {
          const entry = parseLsTreeRecord(record, safePath === '.' ? '' : safePath)
          if (entry) items.push(entry)
        }
        total += 1
      })
      await hydrateTreeSizes(items)
      return {
        oid: commit.oid,
        path: safePath,
        items,
        total,
        offset: page.offset,
        limit: page.limit,
        hasMore: page.offset + items.length < total,
      }
    })()
    treeCache.set(cacheKey, promise)
    try {
      return await promise
    } catch (error) {
      treeCache.delete(cacheKey)
      throw error
    }
  }

  async function getChanges(oid, { offset = 0, limit = DEFAULT_TREE_PAGE_LIMIT } = {}) {
    const commit = await resolveKnownCommit(oid)
    const page = normalizeTreePage(offset, limit)
    const exact = await loadExactChanges(commit)
    const items = exact.changes.slice(page.offset, page.offset + page.limit)
    return {
      oid: commit.oid,
      items,
      stats: exact.stats,
      total: exact.changes.length,
      offset: page.offset,
      limit: page.limit,
      hasMore: page.offset + items.length < exact.changes.length,
    }
  }

  async function getDiff(oid, filePath, { parentIndex = 0 } = {}) {
    const commit = await resolveKnownCommit(oid)
    const safePath = validateGitPath(filePath)
    const selectedParent = Number(parentIndex)
    if (!Number.isInteger(selectedParent) || selectedParent < 0 || (
      commit.parents.length > 0 && selectedParent >= commit.parents.length
    )) {
      throw new GitServiceError('The selected parent does not exist for this commit.', {
        code: 'INVALID_PARENT',
        status: 400,
      })
    }
    const normalizedParent = commit.parents.length === 0 ? 0 : selectedParent
    const cacheKey = `${commit.oid}:${normalizedParent}:${safePath}`
    const cached = diffCache.get(cacheKey)
    if (cached) return cached

    const promise = (async () => {
      let args
      if (commit.parents.length === 0) {
        args = [
          'show', '--format=', '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames',
          '--find-copies', '--unified=3', commit.oid, '--', safePath,
        ]
      } else {
        args = [
          'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', '--find-copies',
          '--unified=3', commit.parents[normalizedParent], commit.oid, '--', safePath,
        ]
      }
      const result = await git(args, {
        maxOutput: diffLimit,
        truncate: true,
        literalPaths: true,
      })
      const patch = result.stdout.toString('utf8')
      return {
        oid: commit.oid,
        path: safePath,
        parentIndex: normalizedParent,
        patch,
        truncated: result.truncated,
        binary: /(?:^|\n)(?:Binary files .* differ|GIT binary patch)(?:\n|$)/.test(patch),
      }
    })()
    diffCache.set(cacheKey, promise)
    try {
      return await promise
    } catch (error) {
      diffCache.delete(cacheKey)
      throw error
    }
  }

  async function getFileHistory(oid, filePath, { offset = 0, limit = 200 } = {}) {
    const commit = await resolveKnownCommit(oid)
    const safePath = validateGitPath(filePath)
    const page = normalizePage(offset, limit)
    const cacheKey = `${commit.oid}:${safePath}:${page.offset}:${page.limit}`
    const cached = historyCache.get(cacheKey)
    if (cached) return cached

    const promise = (async () => {
      let isDirectory = safePath === '.'
      if (!isDirectory) {
        // Asking Git for one object's type avoids materializing the complete
        // 100k-path Linux tree merely to decide whether --follow is valid.
        const candidates = [commit.oid, commit.parents[0]].filter(Boolean)
        for (const candidate of candidates) {
          const typeResult = await git(['cat-file', '-t', `${candidate}:${safePath}`], {
            allowFailure: true,
            maxOutput: 1024 * 1024,
          })
          if (typeResult.exitCode !== 0) continue
          isDirectory = normalizeOutput(typeResult.stdout).trim() === 'tree'
          break
        }
      }
      const result = await git([
        'log', ...(isDirectory ? [] : ['--follow']),
        `--skip=${page.offset}`, `--max-count=${page.limit + 1}`,
        '--format=%H', commit.oid, '--', safePath,
      ], { literalPaths: true, maxOutput: 1024 * 1024 })
      const historyOids = normalizeOutput(result.stdout)
        .split('\n')
        .map((entry) => entry.trim())
        .filter(Boolean)
      const hasMore = historyOids.length > page.limit
      const entries = await readCommitObjects(historyOids.slice(0, page.limit))
      const history = entries
        .map((entry) => ({
          oid: entry.oid,
          shortOid: entry.shortOid,
          subject: entry.subject,
          author: entry.author.name,
          authoredAt: entry.authoredAt,
        }))
      return {
        oid: commit.oid,
        path: safePath,
        entries: history,
        offset: page.offset,
        limit: page.limit,
        hasMore,
      }
    })()
    historyCache.set(cacheKey, promise)
    try {
      return await promise
    } catch (error) {
      historyCache.delete(cacheKey)
      throw error
    }
  }

  async function requireWorktree() {
    const root = await resolveRoot()
    const result = await git(['rev-parse', '--is-inside-work-tree'], { maxOutput: 1024 })
    if (result.stdout.toString('utf8').trim() !== 'true') {
      throw new GitServiceError('This repository has no working tree. Open a working copy to use Git operations.', {
        code: 'WORKTREE_REQUIRED', status: 409,
      })
    }
    return root
  }

  async function readWorkspace() {
    const root = await requireWorktree()
    const [statusResult, branchResult, remoteResult] = await Promise.all([
      git(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'], { maxOutput: 4 * 1024 * 1024 }),
      git(['for-each-ref', '--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:remotename)%00%(upstream:remoteref)', 'refs/heads'], { maxOutput: 1024 * 1024 }),
      git(['remote'], { maxOutput: 64 * 1024 }),
    ])
    const workspace = parseWorkspaceStatus(statusResult.stdout)
    workspace.repoPath = root
    workspace.branches = branchResult.stdout.toString('utf8').trim().split('\n').filter(Boolean).map((line) => {
      const [name, current, upstream, remote, remoteRef] = line.split('\0')
      return {
        name, current: current === '*', upstream: upstream || null,
        remote: remote || null,
        remoteBranch: remoteRef?.startsWith('refs/heads/') ? remoteRef.slice(11) : null,
      }
    })
    workspace.remotes = remoteResult.stdout.toString('utf8').split('\n').filter(Boolean).map((name) => ({ name }))
    return workspace
  }

  async function getWorkspace() {
    const root = await resolveRoot()
    await MUTATION_QUEUES.get(root)?.tail
    return readWorkspace()
  }

  async function queueMutation(operation) {
    const root = await resolveRoot()
    let queue = MUTATION_QUEUES.get(root)
    if (!queue) { queue = { tail: Promise.resolve(), count: 0 }; MUTATION_QUEUES.set(root, queue) }
    if (queue.count >= MAX_MUTATION_QUEUE) {
      throw new GitServiceError('Too many Git operations are pending for this repository.', { code: 'GIT_BUSY', status: 503 })
    }
    queue.count += 1
    const result = queue.tail.then(() => { assertActive(); return operation() })
    queue.tail = result.catch(() => undefined).finally(() => {
      queue.count -= 1
      if (!queue.count) MUTATION_QUEUES.delete(root)
    })
    return result
  }

  function invalidateMutableHistory() {
    generation += 1
    repositoryPromise = undefined
    refResolutionCache.clear()
    pageCache.clear()
    // OID-keyed trees, diffs, objects, and already-built history indexes remain
    // valid. Fetch/push/staging must not rebuild an unchanged Linux HEAD.
  }

  async function validateBranchName(value) {
    if (typeof value !== 'string' || !value || value.length > 240 || value !== value.trim()
      || value.startsWith('-') || value.includes('@{') || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new GitServiceError('Provide a valid branch name.', { code: 'INVALID_BRANCH', status: 400 })
    }
    const result = await git(['check-ref-format', '--branch', value], { allowFailure: true, maxOutput: 1024 })
    if (result.exitCode !== 0) throw new GitServiceError('Provide a valid branch name.', { code: 'INVALID_BRANCH', status: 400 })
    return value
  }

  function selectedPaths(options, workspace, action) {
    if (options.all === true && options.paths !== undefined) {
      throw new GitServiceError('Choose either all files or specific paths.', { code: 'INVALID_PATHS', status: 400 })
    }
    if (options.all === true) return ['.']
    if (!Array.isArray(options.paths) || options.paths.length === 0 || options.paths.length > 256) {
      throw new GitServiceError('Select between 1 and 256 paths, or choose all files.', { code: 'INVALID_PATHS', status: 400 })
    }
    const paths = new Set(options.paths.map(validateWorkspacePath))
    if (action === 'unstage') {
      for (const entry of workspace.staged) {
        if (entry.status !== 'R' || !entry.previousPath) continue
        if ([...paths].some((selected) => [entry.path, entry.previousPath].some((name) => name === selected || name.startsWith(`${selected}/`)))) {
          paths.add(entry.path)
          paths.add(entry.previousPath)
        }
      }
    }
    return [...paths]
  }

  async function runMutationGit(args, options = {}) {
    const result = await git(args, { maxOutput: 1024 * 1024, truncate: true, allowFailure: true, ...options })
    if (result.exitCode !== 0) {
      const detail = cleanGitError(result.stderr || result.stdout.toString('utf8'))
      const missingIdentity = /identity unknown|unable to auto-detect email|tell me who you are/i.test(result.stderr)
      throw new GitServiceError(missingIdentity
        ? 'Configure your Git user.name and user.email before committing.'
        : detail || 'Git could not complete this operation.', {
        code: missingIdentity ? 'IDENTITY_REQUIRED' : 'GIT_OPERATION_FAILED', status: 409, detail,
      })
    }
    return result
  }

  async function mutateWorkspace(action, options = {}) {
    const actions = ['stage', 'unstage', 'commit', 'branch', 'checkout', 'fetch', 'pull', 'push']
    if (!actions.includes(action) || !options || typeof options !== 'object' || Array.isArray(options)) {
      throw new GitServiceError('The requested Git operation is invalid.', { code: 'INVALID_OPERATION', status: 400 })
    }
    return queueMutation(async () => {
      const before = await readWorkspace()
      const repositoryChanged = action !== 'stage' && action !== 'unstage'
      if (action === 'stage' || action === 'unstage') {
        const paths = selectedPaths(options, before, action)
        const input = Buffer.from(`${paths.join('\0')}\0`)
        const args = action === 'stage' ? ['add', '--all']
          : before.headOid ? ['restore', '--staged', '--source=HEAD']
            : ['rm', '--cached', '-r', '-f', '--ignore-unmatch']
        await runMutationGit([...args, '--pathspec-from-file=-', '--pathspec-file-nul'], { input, literalPaths: true })
      } else if (action === 'commit') {
        if (typeof options.message !== 'string' || !options.message.trim() || Buffer.byteLength(options.message) > 12 * 1024 || options.message.includes('\0')) {
          throw new GitServiceError('Provide a commit message of at most 12 KB.', { code: 'INVALID_COMMIT_MESSAGE', status: 400 })
        }
        if (before.counts.conflicts) throw new GitServiceError('Resolve and stage merge conflicts before committing.', { code: 'UNRESOLVED_CONFLICTS', status: 409 })
        if (!before.counts.staged) throw new GitServiceError('Stage changes before committing.', { code: 'NOTHING_TO_COMMIT', status: 409 })
        await runMutationGit(['commit', '--file=-', '--cleanup=strip'], { input: Buffer.from(options.message) })
      } else if (action === 'branch' || action === 'checkout') {
        const name = await validateBranchName(options.name)
        if (action === 'branch') {
          if (options.checkout !== undefined && typeof options.checkout !== 'boolean') {
            throw new GitServiceError('The checkout option must be a boolean.', { code: 'INVALID_OPERATION', status: 400 })
          }
          if (!before.headOid && options.checkout === false) {
            throw new GitServiceError('Create the first commit before creating an inactive branch.', { code: 'EMPTY_REPOSITORY', status: 409 })
          }
          await runMutationGit(options.checkout === false ? ['branch', '--', name] : ['switch', '-c', name])
        } else {
          if (!before.branches.some((branch) => branch.name === name)) {
            throw new GitServiceError('Choose an existing local branch.', { code: 'BRANCH_NOT_FOUND', status: 404 })
          }
          await runMutationGit(['switch', '--no-guess', '--', name])
        }
      } else {
        if (before.counts.conflicts && action === 'pull') {
          throw new GitServiceError('Resolve existing conflicts before pulling.', { code: 'UNRESOLVED_CONFLICTS', status: 409 })
        }
        const tracking = before.branches.find((branch) => branch.current)
        const remote = options.remote ?? tracking?.remote
          ?? before.remotes.find((entry) => entry.name === 'origin')?.name
          ?? (before.remotes.length === 1 ? before.remotes[0].name : undefined)
        if (typeof remote !== 'string' || !before.remotes.some((entry) => entry.name === remote) || remote.startsWith('-')) {
          throw new GitServiceError('Choose a configured Git remote.', { code: 'REMOTE_REQUIRED', status: 400 })
        }
        const requestedBranch = options.branch ?? (tracking?.remote === remote ? tracking.remoteBranch : null) ?? before.branch
        const branch = requestedBranch ? await validateBranchName(requestedBranch) : null
        if (action !== 'fetch' && (!before.branch || !branch)) {
          throw new GitServiceError('Check out a local branch before pulling or pushing.', { code: 'BRANCH_REQUIRED', status: 409 })
        }
        if (action === 'fetch') {
          const fetchBranch = options.branch === undefined ? [] : [await validateBranchName(options.branch)]
          await runMutationGit(['fetch', '--', remote, ...fetchBranch])
        } else if (action === 'pull') {
          await runMutationGit(['-c', 'merge.autoStash=false', '-c', 'rebase.autoStash=false', 'pull', '--ff-only', '--no-rebase', '--no-autostash', '--', remote, branch])
        } else {
          if (!before.headOid) throw new GitServiceError('Create a commit before pushing.', { code: 'EMPTY_REPOSITORY', status: 409 })
          await runMutationGit(['push', '--porcelain', '--set-upstream', '--', remote, `HEAD:refs/heads/${branch}`])
        }
      }
      if (repositoryChanged) invalidateMutableHistory()
      return {
        workspace: await readWorkspace(), repositoryChanged,
        message: { stage: 'Changes staged.', unstage: 'Changes unstaged.', commit: 'Commit created.', branch: 'Branch created.', checkout: 'Branch switched.', fetch: 'Remote fetched.', pull: 'Fast-forward pull completed.', push: 'Changes pushed.' }[action],
      }
    })
  }

  async function getWorkspaceDiff(filePath, { staged = false } = {}) {
    const root = await requireWorktree()
    await MUTATION_QUEUES.get(root)?.tail
    const safePath = validateWorkspacePath(filePath)
    const segments = safePath.split('/')
    let target = root
    for (let index = 0; index < segments.length - 1; index += 1) {
      target = path.join(target, segments[index])
      const parent = await lstat(target).catch((error) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (!parent) break
      if (parent.isSymbolicLink()) {
        throw new GitServiceError('Workspace previews cannot traverse symbolic-link directories.', { code: 'INVALID_PATH', status: 400 })
      }
    }
    const result = await git(['diff', '--no-ext-diff', '--no-textconv', '--no-color',
      ...(staged ? ['--cached'] : []), '--', safePath], {
      literalPaths: true, maxOutput: diffLimit, truncate: true,
    })
    const patch = result.stdout.toString('utf8')
    if (staged || patch) {
      return { path: safePath, patch, truncated: result.truncated, binary: /(?:^|\n)Binary files .* differ(?:\n|$)/.test(patch) }
    }
    const tracked = await git(['ls-files', '--error-unmatch', '--', safePath], { literalPaths: true, allowFailure: true, maxOutput: 1024 * 1024 })
    if (tracked.exitCode === 0) return { path: safePath, patch: '', binary: false, truncated: false }

    target = path.join(root, ...segments)
    const info = await lstat(target).catch(() => null)
    if (!info || (!info.isFile() && !info.isSymbolicLink())) {
      throw new GitServiceError('Choose an existing working-tree file to preview.', { code: 'FILE_NOT_FOUND', status: 404 })
    }
    const limit = Math.min(diffLimit, 256 * 1024)
    let contents
    if (info.isSymbolicLink()) contents = Buffer.from(await readlink(target))
    else {
      const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
      try {
        const buffer = Buffer.alloc(Math.min(info.size, limit + 1))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        contents = buffer.subarray(0, bytesRead)
      } finally { await handle.close() }
    }
    const truncated = contents.length > limit || info.size > limit
    contents = contents.subarray(0, limit)
    const binary = contents.includes(0)
    const text = contents.toString('utf8')
    const lines = text ? text.replace(/\n$/, '').split('\n') : []
    const preview = binary ? `Binary untracked file (${info.size} bytes).`
      : `diff --git ${JSON.stringify(`a/${safePath}`)} ${JSON.stringify(`b/${safePath}`)}\nnew file mode ${info.isSymbolicLink() ? '120000' : '100644'}\n--- /dev/null\n+++ ${JSON.stringify(`b/${safePath}`)}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n`
    return { path: safePath, patch: preview, binary, truncated, untracked: true }
  }

  async function clearRepository() {
    disposed = true
    const stopped = processPool.dispose()
    generation += 1
    const staleIndexes = [...indexCache.values()]
    const staleDirectory = indexDirectoryPromise
    repositoryPromise = undefined
    rootPromise = undefined
    indexDirectoryPromise = undefined
    indexCache.clear()
    detailsCache.clear()
    landscapeCache.clear()
    treeCache.clear()
    exactChangesCache.clear()
    diffCache.clear()
    historyCache.clear()
    commitCache.clear()
    pageCache.clear()
    refResolutionCache.clear()
    indexLookupCache.clear()
    await stopped
    await Promise.allSettled(staleIndexes)
    if (staleDirectory) {
      await Promise.resolve(staleDirectory)
        .then(async (directory) => {
          ACTIVE_INDEX_DIRECTORIES.delete(directory)
          await rm(directory, { recursive: true, force: true })
        })
        .catch(() => undefined)
    }
  }


  function dispose() {
    permanentlyDisposed = true
    disposalPromise ||= clearRepository()
    return disposalPromise
  }

  async function refreshSnapshot(options) {
    if (permanentlyDisposed) throw cancellationError()
    restartPromise ||= (async () => {
      disposalPromise ||= clearRepository()
      await disposalPromise
      // Extension shutdown may race a refresh. Explicit disposal is terminal;
      // a refresh finishing its cleanup must never revive a retired service.
      if (permanentlyDisposed) throw cancellationError()
      processPool = newPool()
      disposed = false
      disposalPromise = undefined
    })().finally(() => { restartPromise = undefined })
    await restartPromise
    return getRepository(options)
  }

  async function refresh(options) {
    if (permanentlyDisposed) throw cancellationError()
    // An explicit refresh must wait for a commit/push already in flight; its
    // cache cleanup stops Git processes and would otherwise interrupt writes.
    const root = await resolveRoot().catch(() => null)
    return root ? queueMutation(() => refreshSnapshot(options)) : refreshSnapshot(options)
  }

  function getResourceUsage() {
    return {
      cacheBytes: cacheBudget.bytes,
      cacheBudgetBytes: cacheBudget.limit,
      cachedEntries: cacheBudget.entries.size,
      activeGitProcesses: processPool.active,
      queuedGitProcesses: processPool.queue.length,
      reservedOutputBytes: processPool.buffered,
      maxBufferedBytes: bufferBudget,
      disposed,
    }
  }

  return {
    getRepository,
    getCommits,
    getCommitIndex,
    getCommit,
    getCommitLandscape,
    getTree,
    getChanges,
    getDiff,
    getFileHistory,
    getWorkspace,
    getWorkspaceDiff,
    mutateWorkspace,
    refresh,
    dispose,
    getResourceUsage,
    get repoPath() {
      return requestedPath
    },
  }
}
