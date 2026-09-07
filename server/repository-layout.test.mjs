import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = await mkdtemp(path.join(tmpdir(), 'palimpsest-layout-test-'))
let buildRepositoryLayout
let REPOSITORY_BLOCK_LIMIT
try {
  execFileSync(process.execPath, [
    path.join(root, 'node_modules/typescript/bin/tsc'),
    '--target', 'ES2022', '--module', 'ESNext', '--skipLibCheck',
    '--outDir', output, path.join(root, 'src/lib/repository-layout.ts'),
  ], { cwd: output, stdio: 'pipe' })
  const source = await readFile(path.join(output, 'lib/repository-layout.js'), 'utf8')
  ;({ buildRepositoryLayout, REPOSITORY_BLOCK_LIMIT } = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  ))
} finally {
  await rm(output, { recursive: true, force: true })
}

function file(filePath, index = 0) {
  const separator = filePath.lastIndexOf('/')
  return {
    path: filePath,
    name: filePath.slice(separator + 1),
    directory: separator < 0 ? '' : filePath.slice(0, separator),
    extension: 'c', oid: index.toString(16).padStart(40, '0'),
    mode: '100644', type: 'blob', size: index % 7 === 0 ? null : 128 + index * 137,
  }
}

function change(status, filePath, previousPath) {
  return {
    id: `${status}:${filePath}`, status, path: filePath, previousPath,
    additions: null, deletions: null, binary: false,
  }
}

// Like a bounded Linux landscape: uneven top-level populations, deep paths,
// unknown sizes, and complete directory counts larger than the file sample.
function landscape() {
  const groups = [['drivers', 220], ['include', 190], ['arch', 150], ['fs', 60],
    ['net', 40], ['sound', 30], ['Documentation', 18], ['', 12]]
  const files = groups.flatMap(([directory, count]) => Array.from({ length: count }, (_, index) =>
    file(directory ? `${directory}/section-${index % 9}/file-${index}.c` : `root-${index}.c`, index),
  ))
  const options = {
    sourceFileCount: 17_291,
    sourceDirectoryCount: 1_241,
    sourceTotalBytes: null,
    directorySummaries: groups.filter(([directory]) => directory).map(([directory, count]) => ({
      path: directory, name: directory, directory: '', depth: 1,
      fileCount: count * 20, directoryCount: 30, totalBytes: null, extensions: [],
    })),
  }
  return { files, options }
}

function overlaps(a, b) {
  return Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) + 1e-7
    && Math.min(a.y + a.depth, b.y + b.depth) > Math.max(a.y, b.y) + 1e-7
}

function contains(outer, inner) {
  return inner.x >= outer.x - 1e-7 && inner.y >= outer.y - 1e-7
    && inner.x + inner.width <= outer.x + outer.width + 1e-7
    && inner.y + inner.depth <= outer.y + outer.depth + 1e-7
}

function assertCityGeometry(layout, limit) {
  assert.ok(layout.blocks.length <= limit, 'the city remains within its render budget')
  const districts = layout.directories.filter((directory) => directory.level === 0)
  const byPath = new Map(districts.map((directory) => [directory.path, directory]))
  assert.equal(byPath.size, districts.length, 'top-level districts are unique')
  assert.equal(new Set(layout.blocks.map((block) => block.id)).size, layout.blocks.length)
  for (const [index, district] of districts.entries()) {
    for (const other of districts.slice(index + 1)) {
      assert.equal(overlaps(district, other), false, `districts overlap: ${district.path}, ${other.path}`)
    }
  }
  for (const [index, block] of layout.blocks.entries()) {
    assert.ok([block.x, block.y, block.width, block.depth, block.height, block.baseElevation]
      .every(Number.isFinite), `non-finite building: ${block.id}`)
    assert.ok(block.width > 0 && block.depth > 0 && block.height > 0)
    const district = byPath.get(block.topLevelPath)
    assert.ok(district, `missing parent district: ${block.id}`)
    assert.ok(contains(district, block), `building left its district: ${block.id}`)
    assert.ok(block.baseElevation >= district.elevation, `building below its terrain: ${block.id}`)
    for (const other of layout.blocks.slice(index + 1)) {
      assert.equal(overlaps(block, other), false, `buildings overlap: ${block.id}, ${other.id}`)
    }
    if (index > 0) {
      const previous = layout.blocks[index - 1]
      assert.ok(block.x + block.y >= previous.x + previous.y - 1e-7, 'paint order follows final coordinates')
    }
  }
}

test('bounded Linux-shaped landscapes have separate plots and buildings at both former view budgets', () => {
  const { files, options } = landscape()
  const scenarios = [[], files.map((item) => change('A', item.path)), [change('M', files[0].path)]]
  for (const maxBlocks of [80, 440, 620]) {
    for (const changes of scenarios) {
      const layout = buildRepositoryLayout(files, changes, { ...options, maxBlocks })
      assertCityGeometry(layout, maxBlocks)
      assert.equal(layout.sourceFileCount, options.sourceFileCount)
      assert.ok(layout.aggregateCount > 0, 'unsampled files retain aggregate buildings')
    }
  }
})

test('directory growth, removals and rename foundations remain inside non-overlapping districts', () => {
  const { files, options } = landscape()
  const removed = files.slice(0, 45)
  const renamed = file('new district/deep/renamed.c', 4000)
  const changes = [
    ...removed.map((item) => change('D', item.path)),
    change('R', renamed.path, 'former district/source.c'),
    change('C', 'new district/copied.c', files[50].path),
  ]
  const destination = [...files.slice(45), renamed, file('new district/copied.c', 4001)]
  const layout = buildRepositoryLayout(destination, changes, { ...options, maxBlocks: 620 })
  assertCityGeometry(layout, 620)
  assert.ok(layout.blocks.some((block) => block.ghost && block.status === 'D'))
  const origin = layout.blocks.find((block) => block.id.startsWith('moved-from:'))
  assert.ok(origin)
  assert.equal(origin.topLevelPath, 'former district')
  assert.equal(layout.blocks.find((block) => block.id === `file:${renamed.path}`)?.topLevelPath, 'new district')
})

test('many top-level directories and their overflow archive fit the fixed render budget', () => {
  const files = Array.from({ length: 2400 }, (_, index) =>
    file(`package-${index % 120}/src/file-${index}.c`, index),
  )
  for (const maxBlocks of [80, 440, 620]) {
    const layout = buildRepositoryLayout(files, [], { maxBlocks })
    assertCityGeometry(layout, maxBlocks)
    assert.ok(layout.blocks.some((block) => block.id === 'aggregate:__repository_archive__'))
    assert.equal(layout.representedFileCount, files.length)
  }
})

test('returning through snapshots and former view budgets restores the exact same geometry', () => {
  const { files, options } = landscape()
  const snapshots = Array.from({ length: 7 }, (_, index) => ({
    files: [...files.slice(index * 3), ...Array.from({ length: index * 4 }, (_, added) =>
      file(`new-${index % 3}/file-${added}.c`, added + 6000))],
    changes: index === 0 ? files.map((item) => change('A', item.path))
      : [change('M', files[index * 13].path)],
  }))
  const initialInputs = structuredClone(snapshots)
  const expected = snapshots.map((snapshot) => buildRepositoryLayout(snapshot.files, snapshot.changes, options))
  const frozenFirst = structuredClone(expected[0])
  for (const index of [0, 6, 5, 4, 3, 2, 1, 0, 6, 0]) {
    const snapshot = snapshots[index]
    assertCityGeometry(buildRepositoryLayout(snapshot.files, snapshot.changes, { ...options, maxBlocks: 440 }), 440)
    const current = buildRepositoryLayout(snapshot.files, snapshot.changes, options)
    assertCityGeometry(current, REPOSITORY_BLOCK_LIMIT)
    assert.deepEqual(current, expected[index], 'geometry depends only on the current snapshot')
  }
  assert.deepEqual(expected[0], frozenFirst, 'later layouts do not mutate a retained snapshot')
  assert.deepEqual(snapshots, initialInputs, 'building a layout does not mutate its source data')
})

test('default and explicit shared view budgets produce identical geometry', () => {
  const { files, options } = landscape()
  assert.equal(REPOSITORY_BLOCK_LIMIT, 620)
  assert.deepEqual(
    buildRepositoryLayout(files, [], options),
    buildRepositoryLayout(files, [], { ...options, maxBlocks: REPOSITORY_BLOCK_LIMIT }),
  )
})

test('empty repositories and a single root file have finite, usable geometry', () => {
  for (const files of [[], [file('README.md')]]) {
    const layout = buildRepositoryLayout(files, [])
    assertCityGeometry(layout, REPOSITORY_BLOCK_LIMIT)
    assert.ok(Object.values(layout.bounds).every(Number.isFinite))
    assert.ok(Object.values(layout.projectedBounds).every(Number.isFinite))
    assert.ok(layout.bounds.maxX > layout.bounds.minX && layout.bounds.maxY > layout.bounds.minY)
  }
})
