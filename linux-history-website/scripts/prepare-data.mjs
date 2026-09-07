import { spawn } from 'node:child_process'
import { access, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { linuxRepoPath, linuxRepository } from './paths.mjs'

const full = process.argv.includes('--full')
const offline = process.argv.includes('--offline')
let running
let cancelled = false
let killTimer
function signalGit(child, signal) {
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    killer.once('error', () => child.kill(signal))
  } else {
    try { process.kill(-child.pid, signal) } catch { child.kill(signal) }
  }
}
const stop = () => {
  cancelled = true
  if (!running) return
  const child = running
  signalGit(child, 'SIGTERM')
  killTimer = setTimeout(() => signalGit(child, 'SIGKILL'), 1000)
  killTimer.unref()
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

function git(args, { capture = false, allowFailure = false } = {}) {
  if (cancelled) return Promise.reject(new Error('Data preparation cancelled; rerun the same command to reuse completed objects.'))
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', linuxRepoPath, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    running = child
    const chunks = []
    child.stdout?.on('data', (chunk) => chunks.push(chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      if (running === child) running = undefined
      if (cancelled) reject(new Error('Data preparation cancelled; completed packs are reusable.'))
      else if (code !== 0 && !allowFailure) reject(new Error(`git ${args[0]} exited with status ${code}`))
      else resolve(capture ? Buffer.concat(chunks).toString('utf8').trim() : code)
    })
  })
}

try {
  await mkdir(linuxRepoPath, { recursive: true })
  const initialized = await access(path.join(linuxRepoPath, 'HEAD')).then(() => true, () => false)
  if (!initialized) {
    await git(['init', '--bare', '--initial-branch=master'])
    await git(['remote', 'add', 'origin', linuxRepository])
  }
  const remote = await git(['remote', 'get-url', 'origin'], { capture: true })
  if (remote.replace(/\.git$/, '').replace(/\/$/, '') !== linuxRepository.replace(/\.git$/, '')) {
    throw new Error('This data directory does not point to torvalds/linux. Use a separate directory; no remote was changed.')
  }
  if (await git(['rev-parse', '--is-bare-repository'], { capture: true }) !== 'true') {
    throw new Error('Data preparation requires a bare repository. Use a separate directory to preserve your working checkout.')
  }
  const shallow = await git(['rev-parse', '--is-shallow-repository'], { capture: true })
  if (!offline) {
    const completedFull = await git(['config', '--bool', '--get', 'historyWebsite.fullContents'], { capture: true, allowFailure: true }) === 'true'
    const partial = await git(['config', '--bool', '--get', 'remote.origin.promisor'], { capture: true, allowFailure: true }) === 'true'
    const fetchFull = full || completedFull
    if (fetchFull) await git(['config', '--unset-all', 'remote.origin.partialclonefilter'], { allowFailure: true })
    else {
      await git(['config', 'remote.origin.promisor', 'true'])
      await git(['config', 'remote.origin.partialclonefilter', 'blob:none'])
    }
    console.log(`Fetching complete Linux commit ancestry into ${linuxRepoPath}`)
    console.log(fetchFull ? 'All reachable file contents will be downloaded.' : 'All commits and trees are retained; file contents are fetched on demand (blob:none).')
    await git([
      '-c', 'pack.threads=2', '-c', 'index.threads=2', 'fetch', '--progress', '--prune',
      ...(shallow === 'true' ? ['--unshallow'] : []),
      ...(fetchFull ? [...(partial && !completedFull ? ['--refetch'] : []), '--no-filter'] : ['--filter=blob:none']),
      'origin', '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*',
    ])
    if (fetchFull) {
      await git(['config', '--unset-all', 'remote.origin.promisor'], { allowFailure: true })
      await git(['config', '--unset-all', 'remote.origin.partialclonefilter'], { allowFailure: true })
      await git(['config', 'historyWebsite.fullContents', 'true'])
    }
  }
  await git(['symbolic-ref', 'HEAD', 'refs/heads/master'])
  if (await git(['rev-parse', '--is-shallow-repository'], { capture: true }) !== 'false') {
    throw new Error('The repository is shallow. Full ancestry is required; rerun without --offline to unshallow it.')
  }
  await git(['rev-parse', '--verify', 'HEAD^{commit}'])
  console.log('Building Git commit-graph for repeatable history walks…')
  await git(['commit-graph', 'write', '--reachable'])
  const count = await git(['rev-list', '--count', 'HEAD'], { capture: true })
  console.log(`Ready: ${Number(count).toLocaleString('en-US')} commits on master, with complete Git ancestry.`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = cancelled ? 130 : 1
} finally {
  // Keep the process-group escalation alive until it fires even if the parent Git exits first.
  if (cancelled && killTimer) killTimer.ref()
  process.off('SIGINT', stop)
  process.off('SIGTERM', stop)
}
