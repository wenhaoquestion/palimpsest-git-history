import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { API_JSON_RESPONSE, createApiMiddleware } from './api-middleware.mjs'
import { createGitService } from './git-service.mjs'
import { createRpcClient } from './rpc-client.mjs'

const environment = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' }
for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete environment[name]
function git(repoPath, args) {
  return execFileSync('git', args, { cwd: repoPath, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
async function put(repoPath, filePath, content) {
  const target = path.join(repoPath, filePath)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content)
}
async function fixture(t, { bare = false, identity = true, initial = false } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'palimpsest-workspace-')))
  const repoPath = path.join(root, 'repository')
  await mkdir(repoPath)
  git(repoPath, ['init', '-b', 'main', ...(bare ? ['--bare'] : [])])
  git(repoPath, ['config', 'user.useConfigOnly', 'true'])
  if (identity) {
    git(repoPath, ['config', 'user.name', 'Workspace Test'])
    git(repoPath, ['config', 'user.email', 'workspace@example.test'])
  }
  if (initial) {
    await put(repoPath, 'tracked.txt', 'initial\n')
    git(repoPath, ['add', 'tracked.txt'])
    git(repoPath, ['commit', '-m', 'Initial commit'])
  }
  const service = createGitService({ repoPath, environment })
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }) })
  return { root, repoPath, service }
}

test('unborn repositories stage literal paths and unstage without changing working files', async (t) => {
  const { repoPath, service } = await fixture(t)
  const names = ['literal[1].txt', 'literal1.txt', '--option.txt', '资料/换\n行.txt']
  for (const name of names) await put(repoPath, name, 'first version\n')
  const before = await service.getWorkspace()
  assert.equal(before.branch, 'main')
  assert.equal(before.headOid, null)
  assert.deepEqual(new Set(before.untracked.map((entry) => entry.path)), new Set(names))
  const stage = await service.mutateWorkspace('stage', { paths: ['literal[1].txt', '--option.txt', '资料/换\n行.txt'] })
  assert.equal(stage.repositoryChanged, false)
  assert.equal(stage.workspace.counts.staged, 3)
  assert.deepEqual(stage.workspace.untracked.map((entry) => entry.path), ['literal1.txt'])
  await put(repoPath, 'literal[1].txt', 'modified after staging\n')
  const unstage = await service.mutateWorkspace('unstage', { paths: ['literal[1].txt'] })
  assert.equal(unstage.workspace.counts.staged, 2)
  assert.equal(await readFile(path.join(repoPath, 'literal[1].txt'), 'utf8'), 'modified after staging\n')
  await service.mutateWorkspace('stage', { all: true })
  const all = await service.mutateWorkspace('unstage', { all: true })
  assert.equal(all.workspace.counts.staged, 0)
  assert.equal(all.workspace.counts.untracked, 4)
  await assert.rejects(service.mutateWorkspace('stage', { all: true, paths: ['tracked.txt'] }), { code: 'INVALID_PATHS' })
  await assert.rejects(service.mutateWorkspace('stage', { paths: ['../outside'] }), { code: 'INVALID_PATH' })
  await assert.rejects(service.mutateWorkspace('stage', { paths: ['.git/config'] }), { code: 'INVALID_PATH' })
})

test('staged and unstaged previews stay separate and commits include only the index', async (t) => {
  const { repoPath, service } = await fixture(t, { initial: true })
  const repositoryBefore = await service.getRepository({ includeStats: false })
  await put(repoPath, 'tracked.txt', 'staged version\n')
  await service.mutateWorkspace('stage', { paths: ['tracked.txt'] })
  await put(repoPath, 'tracked.txt', 'unstaged version\n')
  await put(repoPath, 'untracked.txt', 'keep this untracked\n')
  const staged = await service.getWorkspaceDiff('tracked.txt', { staged: true })
  const unstaged = await service.getWorkspaceDiff('tracked.txt')
  assert.match(staged.patch, /\+staged version/)
  assert.doesNotMatch(staged.patch, /\+unstaged version/)
  assert.match(unstaged.patch, /\+unstaged version/)
  assert.strictEqual(await service.getRepository({ includeStats: false }), repositoryBefore, 'staging preserves cached history')
  const committed = await service.mutateWorkspace('commit', { message: 'Commit staged changes\n\nA useful body.' })
  assert.equal(committed.repositoryChanged, true)
  assert.notEqual(committed.workspace.headOid, repositoryBefore.repo.headOid)
  assert.equal(committed.workspace.counts.staged, 0)
  assert.equal(committed.workspace.counts.unstaged, 1)
  assert.equal(committed.workspace.counts.untracked, 1)
  assert.equal(git(repoPath, ['show', 'HEAD:tracked.txt']), 'staged version')
  assert.equal((await service.getRepository({ includeStats: false })).repo.counts.commits, 2)
  await assert.rejects(service.mutateWorkspace('commit', { message: 'Nothing staged' }), { code: 'NOTHING_TO_COMMIT' })
})

test('unstaging a rename restores both index paths while preserving the renamed file', async (t) => {
  const { repoPath, service } = await fixture(t, { initial: true })
  await rename(path.join(repoPath, 'tracked.txt'), path.join(repoPath, 'renamed.txt'))
  const staged = await service.mutateWorkspace('stage', { all: true })
  assert.deepEqual(staged.workspace.staged, [{ path: 'renamed.txt', previousPath: 'tracked.txt', status: 'R' }])
  const unstage = await service.mutateWorkspace('unstage', { paths: ['renamed.txt'] })
  assert.equal(unstage.workspace.counts.staged, 0)
  assert.equal(unstage.workspace.unstaged[0].path, 'tracked.txt')
  assert.equal(unstage.workspace.untracked[0].path, 'renamed.txt')
  assert.equal(await readFile(path.join(repoPath, 'renamed.txt'), 'utf8'), 'initial\n')
})

test('concurrent mutations preserve submission order, and branch checkout preserves conflicting local changes', async (t) => {
  const { repoPath, service } = await fixture(t, { initial: true })
  await put(repoPath, 'queued.txt', 'queued content\n')
  const [, committed] = await Promise.all([
    service.mutateWorkspace('stage', { paths: ['queued.txt'] }),
    service.mutateWorkspace('commit', { message: 'Commit after queued stage' }),
  ])
  assert.equal(committed.workspace.clean, true)
  const created = await service.mutateWorkspace('branch', { name: 'feature/safe' })
  assert.equal(created.workspace.branch, 'feature/safe')
  await put(repoPath, 'tracked.txt', 'feature version\n')
  await service.mutateWorkspace('stage', { all: true })
  await service.mutateWorkspace('commit', { message: 'Feature version' })
  await put(repoPath, 'tracked.txt', 'unsaved local work\n')
  await assert.rejects(service.mutateWorkspace('checkout', { name: 'main' }), { code: 'GIT_OPERATION_FAILED' })
  assert.equal((await service.getWorkspace()).branch, 'feature/safe')
  assert.equal(await readFile(path.join(repoPath, 'tracked.txt'), 'utf8'), 'unsaved local work\n')
  await put(repoPath, 'tracked.txt', 'feature version\n')
  assert.equal((await service.mutateWorkspace('checkout', { name: 'main' })).workspace.branch, 'main')
  const inactive = await service.mutateWorkspace('branch', { name: 'later', checkout: false })
  assert.equal(inactive.workspace.branch, 'main')
  assert.ok(inactive.workspace.branches.some((branch) => branch.name === 'later'))
  await assert.rejects(service.mutateWorkspace('branch', { name: '--force' }), { code: 'INVALID_BRANCH' })
  await assert.rejects(service.mutateWorkspace('branch', { name: '@{-1}' }), { code: 'INVALID_BRANCH' })
})

test('commit identity errors preserve staged data without writing Git identity configuration', async (t) => {
  const { repoPath, service } = await fixture(t, { identity: false })
  await put(repoPath, 'new.txt', 'new file\n')
  await service.mutateWorkspace('stage', { all: true })
  const configBefore = await readFile(path.join(repoPath, '.git', 'config'), 'utf8')
  await assert.rejects(service.mutateWorkspace('commit', { message: 'Needs identity' }), { code: 'IDENTITY_REQUIRED' })
  const after = await service.getWorkspace()
  assert.equal(after.headOid, null)
  assert.equal(after.counts.staged, 1)
  assert.equal(await readFile(path.join(repoPath, '.git', 'config'), 'utf8'), configBefore)
})

test('untracked previews are bounded, show binary files, and never follow links outside the repository', { skip: process.platform === 'win32' }, async (t) => {
  const { root, repoPath, service } = await fixture(t)
  await put(repoPath, 'new.txt', 'preview this line\n')
  await put(repoPath, 'binary.bin', Buffer.from([0, 1, 2, 3]))
  await put(repoPath, 'large.txt', 'x'.repeat(300_000))
  await put(root, 'secret.txt', 'DO NOT READ THIS CONTENT\n')
  await mkdir(path.join(root, 'outside'))
  await put(root, 'outside/private.txt', 'DO NOT READ THIS CONTENT\n')
  await symlink(path.join(root, 'secret.txt'), path.join(repoPath, 'link.txt'))
  await symlink(path.join(root, 'outside'), path.join(repoPath, 'linked-directory'))
  assert.match((await service.getWorkspaceDiff('new.txt')).patch, /\+preview this line/)
  assert.equal((await service.getWorkspaceDiff('binary.bin')).binary, true)
  const large = await service.getWorkspaceDiff('large.txt')
  assert.equal(large.truncated, true)
  assert.ok(large.patch.length < 270_000)
  const linked = await service.getWorkspaceDiff('link.txt')
  assert.doesNotMatch(linked.patch, /DO NOT READ THIS CONTENT/)
  assert.match(linked.patch, /120000/)
  await assert.rejects(service.getWorkspaceDiff('linked-directory/private.txt'), { code: 'INVALID_PATH' })
  await assert.rejects(service.getWorkspaceDiff('.git/config'), { code: 'INVALID_PATH' })
})

test('fetch, fast-forward-only pull, and non-forced push use configured local remotes and establish tracking', async (t) => {
  const { root, repoPath, service } = await fixture(t, { initial: true })
  const remotePath = path.join(root, 'remote.git')
  await mkdir(remotePath)
  git(remotePath, ['init', '--bare', '-b', 'main'])
  git(repoPath, ['remote', 'add', 'origin', remotePath])
  const pushed = await service.mutateWorkspace('push', { remote: 'origin', branch: 'main' })
  assert.equal(pushed.workspace.upstream, 'origin/main')
  assert.equal(pushed.workspace.ahead, 0)
  const peer = path.join(root, 'peer')
  git(root, ['clone', '--branch', 'main', remotePath, peer])
  git(peer, ['config', 'user.name', 'Peer'])
  git(peer, ['config', 'user.email', 'peer@example.test'])
  await put(peer, 'remote.txt', 'remote addition\n')
  git(peer, ['add', 'remote.txt'])
  git(peer, ['commit', '-m', 'Remote addition'])
  git(peer, ['push', 'origin', 'main'])
  const oldHead = (await service.getWorkspace()).headOid
  const fetched = await service.mutateWorkspace('fetch', {})
  assert.equal(fetched.workspace.headOid, oldHead)
  assert.equal(fetched.workspace.behind, 1)
  const pulled = await service.mutateWorkspace('pull', {})
  assert.equal(pulled.workspace.behind, 0)
  assert.equal(await readFile(path.join(repoPath, 'remote.txt'), 'utf8'), 'remote addition\n')
  await put(repoPath, 'local.txt', 'local divergence\n')
  await service.mutateWorkspace('stage', { all: true })
  await service.mutateWorkspace('commit', { message: 'Local divergence' })
  const divergentHead = (await service.getWorkspace()).headOid
  await put(peer, 'peer.txt', 'peer divergence\n')
  git(peer, ['add', 'peer.txt'])
  git(peer, ['commit', '-m', 'Peer divergence'])
  git(peer, ['push', 'origin', 'main'])
  const remoteHead = git(remotePath, ['rev-parse', 'HEAD'])
  await assert.rejects(service.mutateWorkspace('pull', {}), { code: 'GIT_OPERATION_FAILED' })
  assert.equal((await service.getWorkspace()).headOid, divergentHead)
  assert.equal(await readFile(path.join(repoPath, 'local.txt'), 'utf8'), 'local divergence\n')
  await assert.rejects(service.mutateWorkspace('push', {}), { code: 'GIT_OPERATION_FAILED' })
  assert.equal(git(remotePath, ['rev-parse', 'HEAD']), remoteHead)
  await assert.rejects(service.mutateWorkspace('fetch', { remote: 'file:///etc' }), { code: 'REMOTE_REQUIRED' })
})

test('bare repositories report worktree requirements and linked worktrees operate on their own index', async (t) => {
  const bare = await fixture(t, { bare: true })
  await assert.rejects(bare.service.getWorkspace(), { code: 'WORKTREE_REQUIRED' })
  await assert.rejects(bare.service.mutateWorkspace('stage', { all: true }), { code: 'WORKTREE_REQUIRED' })
  const { root, repoPath, service } = await fixture(t, { initial: true })
  const worktree = path.join(root, 'linked')
  git(repoPath, ['worktree', 'add', '-b', 'linked', worktree])
  const linked = createGitService({ repoPath: worktree, environment })
  t.after(() => linked.dispose())
  await put(worktree, 'linked.txt', 'belongs to linked worktree\n')
  await linked.mutateWorkspace('stage', { all: true })
  const committed = await linked.mutateWorkspace('commit', { message: 'Linked worktree commit' })
  assert.equal(committed.workspace.branch, 'linked')
  assert.equal((await service.getWorkspace()).clean, true)
  assert.equal(git(repoPath, ['rev-list', '--count', 'HEAD']), '1')
})

test('workspace mutations travel through RPC and rotate history identity only when refs change', async (t) => {
  const { repoPath } = await fixture(t)
  const client = createRpcClient({ repoPath })
  t.after(() => client.dispose())
  await put(repoPath, 'rpc.txt', 'RPC operation\n')
  const initial = await client.request({ url: '/api/repository?stats=false' })
  const workspace = await client.request({ url: '/api/workspace' })
  assert.equal(workspace.status, 200)
  assert.equal(workspace.body.counts.untracked, 1)
  const preview = await client.request({ url: '/api/workspace/diff?path=rpc.txt&staged=false' })
  assert.equal(preview.status, 200)
  assert.match(preview.body.patch, /RPC operation/)
  const staged = await client.request({ url: `/api/workspace/stage?repository=${initial.body.repositoryId}`, method: 'POST', body: '{"all":true}' })
  assert.equal(staged.status, 200)
  assert.equal(staged.body.repositoryId, initial.body.repositoryId)
  const committed = await client.request({ url: `/api/workspace/commit?repository=${initial.body.repositoryId}`, method: 'POST', body: '{"message":"Commit through RPC"}' })
  assert.equal(committed.status, 200)
  assert.equal(committed.body.repositoryChanged, true)
  assert.notEqual(committed.body.repositoryId, initial.body.repositoryId)
  assert.equal((await client.request({ url: `/api/workspace?repository=${initial.body.repositoryId}` })).status, 409)
  assert.equal((await client.request({ url: '/api/repository?stats=false' })).body.repo.counts.commits, 1)
})

test('the public read-only API rejects workspace inspection and every workspace mutation before calling Git', async (t) => {
  const api = createApiMiddleware({ readOnly: true, service: {} })
  t.after(() => api.dispose())
  for (const url of ['/api/workspace', '/api/workspace/diff?path=secret.txt', ...['stage', 'unstage', 'commit', 'branch', 'checkout', 'fetch', 'pull', 'push'].map((action) => `/api/workspace/${action}`)]) {
    const request = Readable.from([])
    Object.assign(request, { url, method: url === '/api/workspace' || url.includes('/diff?') ? 'GET' : 'POST', headers: { host: 'localhost' }, socket: {} })
    const result = await new Promise((resolve) => {
      api(request, { writableEnded: false, setHeader() {}, [API_JSON_RESPONSE](status, body) { this.writableEnded = true; resolve({ status, body }) } })
    })
    assert.equal(result.status, 405, url)
    assert.equal(result.body.error.code, 'READ_ONLY', url)
  }
})

test('large workspaces keep complete counts while bounding returned rows', async (t) => {
  const { repoPath, service } = await fixture(t)
  await Promise.all(Array.from({ length: 1100 }, (_, index) => put(repoPath, `files/file-${index}.txt`, 'content\n')))
  const before = await service.getWorkspace()
  assert.equal(before.counts.untracked, 1100)
  assert.equal(before.untracked.length, 1024)
  assert.equal(before.truncated, true)
  const staged = await service.mutateWorkspace('stage', { all: true })
  assert.equal(staged.workspace.counts.staged, 1100)
  assert.equal(staged.workspace.staged.length, 1024)
  assert.equal(staged.workspace.truncated, true)
  const unstaged = await service.mutateWorkspace('unstage', { all: true })
  assert.equal(unstaged.workspace.counts.untracked, 1100)
  assert.equal(unstaged.workspace.counts.staged, 0)
})

test('merge conflicts are reported separately and cannot be committed until staged as resolved', async (t) => {
  const { repoPath, service } = await fixture(t, { initial: true })
  git(repoPath, ['switch', '-c', 'other'])
  await put(repoPath, 'tracked.txt', 'other branch\n')
  git(repoPath, ['add', 'tracked.txt'])
  git(repoPath, ['commit', '-m', 'Other version'])
  git(repoPath, ['switch', 'main'])
  await put(repoPath, 'tracked.txt', 'main branch\n')
  git(repoPath, ['add', 'tracked.txt'])
  git(repoPath, ['commit', '-m', 'Main version'])
  assert.throws(() => git(repoPath, ['merge', 'other']))
  const conflicted = await service.getWorkspace()
  assert.equal(conflicted.counts.conflicts, 1)
  assert.deepEqual(conflicted.conflicts, [{ path: 'tracked.txt', status: 'UU' }])
  await assert.rejects(service.mutateWorkspace('commit', { message: 'Unresolved merge' }), { code: 'UNRESOLVED_CONFLICTS' })
  await put(repoPath, 'tracked.txt', 'resolved version\n')
  await service.mutateWorkspace('stage', { paths: ['tracked.txt'] })
  const resolved = await service.mutateWorkspace('commit', { message: 'Resolved merge' })
  assert.equal(resolved.workspace.clean, true)
  assert.equal(git(repoPath, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ').length, 3)
})

test('refresh waits for an in-flight commit instead of killing the mutation', { skip: process.platform === 'win32' }, async (t) => {
  const { root, repoPath, service } = await fixture(t, { initial: true })
  const started = path.join(root, 'hook-started')
  await writeFile(path.join(repoPath, '.git', 'hooks', 'pre-commit'), `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(started)}, 'started')\nsetTimeout(() => process.exit(0), 200)\n`, { mode: 0o755 })
  await put(repoPath, 'tracked.txt', 'ready to commit\n')
  await service.mutateWorkspace('stage', { all: true })
  const committing = service.mutateWorkspace('commit', { message: 'Finish before refresh' })
  for (let attempt = 0; ; attempt += 1) {
    if (await access(started).then(() => true, () => false)) break
    assert.ok(attempt < 100, 'The commit hook should start')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const refreshing = service.refresh({ includeStats: false })
  const committed = await committing
  const refreshed = await refreshing
  assert.equal(committed.workspace.clean, true)
  assert.equal(refreshed.repo.headOid, committed.workspace.headOid)
  assert.equal(refreshed.repo.counts.commits, 2)
})
