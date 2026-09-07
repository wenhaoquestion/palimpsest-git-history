import { execFile } from 'node:child_process'
import { devNull } from 'node:os'
import { promisify } from 'node:util'
import path from 'node:path'
import { createAppServer } from '../server/app.mjs'
import { createGitService } from '../server/git-service.mjs'
import { linuxRepoPath, linuxRepository, linuxDisplayUrl, websiteRoot } from './scripts/paths.mjs'

const exec = promisify(execFile)
export function publicGitEnvironment() {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull, GIT_TERMINAL_PROMPT: '0' }
  for (const key of Object.keys(env)) {
    if (/^GIT_(?:CONFIG(?:$|_COUNT|_PARAMETERS|_KEY_|_VALUE_)|DIR$|WORK_TREE$|INDEX_FILE$|OBJECT_DIRECTORY$|ALTERNATE_OBJECT_DIRECTORIES$)/.test(key)) delete env[key]
  }
  return env
}

export async function validateLinuxRepository(repoPath = linuxRepoPath) {
  const read = async (...args) => (await exec('git', ['-C', repoPath, ...args], { env: publicGitEnvironment(), maxBuffer: 1024 * 1024 })).stdout.trim()
  const [origin, shallow, bare] = await Promise.all([
    read('remote', 'get-url', 'origin'),
    read('rev-parse', '--is-shallow-repository'),
    read('rev-parse', '--is-bare-repository'),
  ])
  if (origin.replace(/\.git$/, '').replace(/\/$/, '') !== linuxRepository.replace(/\.git$/, '')) throw new Error('The website data must come from the fixed torvalds/linux upstream.')
  if (shallow !== 'false') throw new Error('A shallow repository cannot serve this complete-history archive. Run npm run prepare:data.')
  if (bare !== 'true') throw new Error('The website expects a bare Linux repository, with no working checkout.')
  await read('rev-parse', '--verify', 'refs/heads/master^{commit}')
}

export async function createLinuxService({ repoPath = linuxRepoPath, validate = true } = {}) {
  if (validate) await validateLinuxRepository(repoPath)
  return createGitService({ repoPath, environment: publicGitEnvironment() })
}

export async function createLinuxWebsite({ repoPath = linuxRepoPath, distPath = path.join(websiteRoot, 'dist'), validate = true, service } = {}) {
  const sharedService = service || await createLinuxService({ repoPath, validate })
  return createAppServer({
    repoPath,
    distPath,
    service: sharedService,
    readOnly: true,
    publicRepository: { name: 'torvalds/linux', displayPath: linuxDisplayUrl },
    allowedRefs: ['HEAD', 'all', 'master', 'refs/heads/master'],
    maxApiRequests: 4,
  })
}
