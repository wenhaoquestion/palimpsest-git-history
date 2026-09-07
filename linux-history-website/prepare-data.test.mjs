import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout } from 'node:timers/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const script = new URL('./scripts/prepare-data.mjs', import.meta.url)
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'linux-history-prepare-'))
  const repo = path.join(directory, 'linux.git')
  await mkdir(repo)
  await writeFile(path.join(repo, 'HEAD'), 'ref: refs/heads/master\n')
  const log = path.join(directory, 'calls.jsonl')
  const pidFile = path.join(directory, 'child.pid')
  await writeFile(path.join(directory, 'git'), `#!${process.execPath}
const { appendFileSync, writeFileSync } = require('node:fs')
const { spawn } = require('node:child_process')
const args = process.argv.slice(4)
appendFileSync(process.env.TEST_CALLS, JSON.stringify(args) + '\\n')
if (args[0] === 'remote') console.log('https://github.com/torvalds/linux.git')
else if (args[0] === 'config' && args.includes('--get')) {
  const key = args.at(-1)
  console.log(key === 'historyWebsite.fullContents' ? process.env.TEST_FULL : process.env.TEST_PARTIAL)
} else if (args[0] === 'rev-parse') console.log(args.includes('--is-shallow-repository') ? 'false' : args.includes('--is-bare-repository') ? process.env.TEST_BARE : 'a'.repeat(40))
else if (args[0] === 'rev-list') console.log('1482108')
else if (args.includes('fetch') && process.env.TEST_BLOCK === '1') {
  process.on('SIGTERM', () => {})
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {});setInterval(() => {}, 1000)"], { stdio: 'ignore' })
  writeFileSync(process.env.TEST_PID, String(child.pid))
  setInterval(() => {}, 1000)
}
`, { mode: 0o755 })
  const child = spawn(process.execPath, [fileURLToPath(script), ...(options.args || [])], {
    env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}`, LINUX_REPO: repo, TEST_CALLS: log, TEST_PID: pidFile, TEST_FULL: options.full ? 'true' : 'false', TEST_PARTIAL: options.partial ? 'true' : 'false', TEST_BLOCK: options.block ? '1' : '0', TEST_BARE: options.bare === false ? 'false' : 'true' },
    stdio: 'ignore',
  })
  const closed = once(child, 'close')
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGKILL')
    const pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'))
    if (pid) try { process.kill(pid, 'SIGKILL') } catch {}
    await rm(directory, { recursive: true, force: true })
  })
  return { child, closed, pidFile, calls: async () => (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse) }
}

test('completed full downloads stay incremental and never re-enable blob filtering', { skip: process.platform === 'win32' }, async (t) => {
  const { closed, calls } = await fixture(t, { full: true })
  assert.equal((await closed)[0], 0)
  const commands = await calls()
  const fetch = commands.find((args) => args.includes('fetch'))
  assert.ok(fetch.includes('--no-filter'))
  assert.ok(!fetch.includes('--refetch'))
  assert.ok(!fetch.some((arg) => arg.startsWith('--depth')))
  assert.ok(!commands.some((args) => args.join(' ') === 'config remote.origin.partialclonefilter blob:none'))
})

test('partial-to-full download explicitly refetches all objects before marking completion', { skip: process.platform === 'win32' }, async (t) => {
  const { closed, calls } = await fixture(t, { args: ['--full'], partial: true })
  assert.equal((await closed)[0], 0)
  const commands = await calls()
  const fetchIndex = commands.findIndex((args) => args.includes('fetch'))
  assert.ok(commands[fetchIndex].includes('--refetch'))
  assert.ok(commands[fetchIndex].includes('--no-filter'))
  assert.ok(commands.findIndex((args) => args.join(' ') === 'config historyWebsite.fullContents true') > fetchIndex)
})

test('cancelling data preparation terminates the whole Git process group', { skip: process.platform === 'win32', timeout: 8000 }, async (t) => {
  const { child, closed, pidFile } = await fixture(t, { block: true })
  const deadline = Date.now() + 4000
  let descendant = 0
  while (!descendant && Date.now() < deadline) {
    descendant = Number(await readFile(pidFile, 'utf8').catch(() => '0'))
    if (!descendant) await setTimeout(10)
  }
  assert.ok(descendant > 0)
  child.kill('SIGTERM')
  assert.equal((await closed)[0], 130)
  let alive = true
  while (alive && Date.now() < deadline) {
    try { process.kill(descendant, 0); await setTimeout(10) } catch { alive = false }
  }
  assert.equal(alive, false, 'Git descendant must not survive cancellation')
})

test('data preparation refuses to change an existing working checkout', { skip: process.platform === 'win32' }, async (t) => {
  const { closed, calls } = await fixture(t, { bare: false })
  assert.equal((await closed)[0], 1)
  assert.ok(!(await calls()).some((args) => args.includes('fetch') || args[0] === 'symbolic-ref'))
})
