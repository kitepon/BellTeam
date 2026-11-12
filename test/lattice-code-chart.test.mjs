import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createLatticeCli } from '../src/lattice/cli.mjs'
import { CODE_CHART_EXCLUDE, createCodeCharts } from '../src/lattice/code-chart.mjs'
import { createLatticeCore } from '../src/lattice/core.mjs'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString().trim()

async function world(t) {
  const root = await mkdtemp(join(tmpdir(), 'lattice-code-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bin = join(root, 'bin.mjs')
  // Fake Lattice: records argv beside the chart. sensor follows Lattice 0.86.1: sync without an index is the typed
  // LATTICE_SENSOR_NOT_INITIALIZED on stderr; init makes .lattice/sensor/sensor.db, or (when ../init-breaks exists) is cut off after the dir.
  await writeFile(bin, `import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
const argv = process.argv.slice(2), db = '.lattice/sensor/sensor.db'
appendFileSync('../calls.log', argv.join(' ') + '\\n')
if (argv[0] === 'sensor' && argv[1] === 'init') {
  mkdirSync('.lattice/sensor', { recursive: true })
  if (existsSync('../init-breaks')) process.exit(1)
  writeFileSync(db, 'index')
}
if (argv[0] === 'sensor' && argv[1] === 'sync' && !existsSync(db)) {
  console.error('✗ LatticeSensor not initialized'); console.error(JSON.stringify({ schema: 'lattice.cli_error.v2', code: 'LATTICE_SENSOR_NOT_INITIALIZED' })); process.exit(1)
}
console.log(JSON.stringify({ ok: true }))`)
  const work = join(root, 'work'), origin = join(root, 'origin.git')
  git(root, 'init', '-q', '--bare', '-b', 'main', origin)
  git(root, 'init', '-q', '-b', 'main', work)
  await writeFile(join(work, 'a.txt'), 'one'); git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'c1'); git(work, 'push', '-q', origin, 'main')
  const chartsRoot = join(root, 'charts'), chart = join(chartsRoot, 'code')
  // An existing chart made before it was a code chart: unborn git repo with a store and a sidecar.
  await mkdir(join(chart, '.lattice'), { recursive: true }); git(chart, 'init', '-q', '-b', 'main')
  await writeFile(join(chart, '.lattice', 'store.json'), 'keep'); await writeFile(join(chart, '.bellteam-chart.json'), '{"name":"x"}')
  const cli = createLatticeCli({ bin, chartsRoot, home: join(root, 'home') })
  const clock = { now: 0 }, logs = []
  const codes = createCodeCharts({ cli, charts: { code: { url: origin, branch: 'main' } }, now: () => clock.now, log: line => logs.push(line) })
  const calls = async () => (await readFile(join(chartsRoot, 'calls.log'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
  return { root, work, origin, chart, chartsRoot, cli, codes, clock, logs, calls, bin }
}

test('code chart: an existing chart is converted to a checkout without touching the store, then fast-forwards when due', async t => {
  const w = await world(t)
  assert.equal(await w.codes.maintain('code'), 'synced')
  assert.equal(git(w.chart, 'rev-parse', 'HEAD'), git(w.work, 'rev-parse', 'HEAD'))
  assert.deepEqual([await readFile(join(w.chart, '.lattice', 'store.json'), 'utf8'), await readFile(join(w.chart, '.bellteam-chart.json'), 'utf8')], ['keep', '{"name":"x"}'], 'store and sidecar untouched')
  assert.equal(git(w.chart, 'status', '--porcelain'), '', 'worktree clean: store and sidecar excluded')
  for (const line of CODE_CHART_EXCLUDE) assert.ok((await readFile(join(w.chart, '.git', 'info', 'exclude'), 'utf8')).split('\n').includes(line))
  assert.deepEqual(await w.calls(), ['sensor sync . --json', 'sensor init . --json'], 'not initialized (typed) -> init')
  await writeFile(join(w.work, 'b.txt'), 'two'); git(w.work, 'add', '.'); git(w.work, 'commit', '-q', '-m', 'c2'); git(w.work, 'push', '-q', w.origin, 'main')
  assert.equal(await w.codes.maintain('code'), null, 'not due yet')
  w.clock.now += 120000
  assert.equal(await w.codes.maintain('code'), 'synced')
  assert.equal(git(w.chart, 'rev-parse', 'HEAD'), git(w.work, 'rev-parse', 'HEAD'))
  assert.deepEqual((await w.calls()).at(-1), 'sensor sync . --json')
  w.clock.now += 120000
  assert.equal(await w.codes.maintain('code'), 'current', 'nothing new: no sensor run')
  assert.equal(await w.codes.maintain('other'), null, 'not a code chart')
})

test('code chart: a chart left as a blob-less clone is turned into a depth-1 checkout; Lattice\'s object walk fetches nothing (production 2026-11-12)', async t => {
  const w = await world(t)
  git(w.origin, 'config', 'uploadpack.allowfilter', 'true')
  for (const n of [2, 3]) { await writeFile(join(w.work, 'a.txt'), `v${n}`); git(w.work, 'commit', '-q', '-am', `c${n}`) }
  git(w.work, 'push', '-q', w.origin, 'main')
  // what the previous module left: promisor remote, history without blobs, main = last fetched tip
  const url = `file://${w.origin}`
  git(w.chart, 'remote', 'add', 'origin', url); git(w.chart, 'fetch', '-q', '--filter=blob:none', '--no-tags', 'origin', 'main'); git(w.chart, 'checkout', '-q', '-B', 'main', 'FETCH_HEAD')
  assert.equal(git(w.chart, 'config', 'remote.origin.promisor'), 'true')
  const codes = createCodeCharts({ cli: w.cli, charts: { code: { url, branch: 'main' } }, now: () => 0 })
  assert.equal(await codes.maintain('code'), 'synced', 'same tip: grafted in place')
  assert.throws(() => git(w.chart, 'config', 'remote.origin.promisor'), 'promisor dropped')
  assert.equal(git(w.chart, 'rev-parse', '--is-shallow-repository'), 'true')
  const walk = () => execFileSync('git', ['rev-list', '--objects', '--all'], { cwd: w.chart, env: { ...process.env, GIT_NO_LAZY_FETCH: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  assert.doesNotThrow(walk, 'every reachable object is local')
  // upstream moves: main follows the grafted tip, the walk still needs nothing remote
  await writeFile(join(w.work, 'a.txt'), 'v4'); git(w.work, 'commit', '-q', '-am', 'c4'); git(w.work, 'push', '-q', w.origin, 'main')
  const later = createCodeCharts({ cli: w.cli, charts: { code: { url, branch: 'main' } }, now: () => 0 })
  assert.equal(await later.maintain('code'), 'synced')
  assert.deepEqual([git(w.chart, 'rev-parse', 'HEAD'), await readFile(join(w.chart, 'a.txt'), 'utf8')], [git(w.work, 'rev-parse', 'HEAD'), 'v4'])
  assert.doesNotThrow(walk)
  assert.equal(await readFile(join(w.chart, '.lattice', 'store.json'), 'utf8'), 'keep')
})

test('code chart: a diverged checkout or a foreign origin is never reset or repointed; the next due run retries', async t => {
  const w = await world(t)
  await w.codes.maintain('code')
  await writeFile(join(w.chart, 'local.txt'), 'mine'); git(w.chart, 'add', 'local.txt'); git(w.chart, 'commit', '-q', '-m', 'local')
  const local = git(w.chart, 'rev-parse', 'HEAD')
  await writeFile(join(w.work, 'c.txt'), 'three'); git(w.work, 'add', '.'); git(w.work, 'commit', '-q', '-m', 'c3'); git(w.work, 'push', '-q', w.origin, 'main')
  w.clock.now += 120000
  assert.equal(await w.codes.maintain('code'), 'diverged')
  assert.deepEqual([git(w.chart, 'rev-parse', 'HEAD'), existsSync(join(w.chart, 'local.txt'))], [local, true], 'no reset')
  assert.equal(w.logs.at(-1), 'lattice-code code diverged')
  git(w.chart, 'remote', 'set-url', 'origin', join(w.root, 'elsewhere.git')); w.clock.now += 120000
  assert.equal(await w.codes.maintain('code'), 'origin-elsewhere')
  assert.equal(git(w.chart, 'remote', 'get-url', 'origin'), join(w.root, 'elsewhere.git'), 'origin not repointed')
})

test('code chart: tracked edits in the checkout are never fetched over, merged or indexed; once gone it catches up (Epinel 2026-11-12)', async t => {
  const w = await world(t)
  assert.equal(await w.codes.maintain('code'), 'synced')
  const head = git(w.chart, 'rev-parse', 'HEAD'), before = (await w.calls()).length
  // equal HEAD + index present + a tracked modification: dirty, not current
  await writeFile(join(w.chart, 'a.txt'), 'edited'); w.clock.now += 120000
  assert.equal(await w.codes.maintain('code'), 'dirty')
  // upstream moved on while still dirty (non-overlapping file): still no fast-forward
  await writeFile(join(w.work, 'd.txt'), 'four'); git(w.work, 'add', '.'); git(w.work, 'commit', '-q', '-m', 'c4'); git(w.work, 'push', '-q', w.origin, 'main')
  w.clock.now += 120000
  assert.equal(await w.codes.maintain('code'), 'dirty')
  assert.deepEqual([git(w.chart, 'rev-parse', 'HEAD'), await readFile(join(w.chart, 'a.txt'), 'utf8'), (await w.calls()).length], [head, 'edited', before], 'no merge, edit kept, no sensor run')
  assert.equal(w.logs.at(-1), 'lattice-code code dirty')
  // a staged edit is dirty too
  git(w.chart, 'add', 'a.txt'); w.clock.now += 120000
  assert.equal(await w.codes.maintain('code'), 'dirty')
  // edits removed elsewhere: the next due run fast-forwards and indexes
  git(w.chart, 'reset', '-q', 'HEAD', 'a.txt'); git(w.chart, 'checkout', '-q', 'a.txt'); w.clock.now += 120000
  assert.equal(await w.codes.maintain('code'), 'synced')
  assert.equal(git(w.chart, 'rev-parse', 'HEAD'), git(w.work, 'rev-parse', 'HEAD'))
})

test('code chart: an interrupted sensor init (dir without index) is retried by the next due run and recovers (Epinel 2026-11-12)', async t => {
  const w = await world(t)
  await writeFile(join(w.chartsRoot, 'init-breaks'), '')
  assert.equal(await w.codes.maintain('code'), 'sensor-failed')
  assert.deepEqual([existsSync(join(w.chart, '.lattice', 'sensor')), existsSync(join(w.chart, '.lattice', 'sensor', 'sensor.db'))], [true, false], 'partial init')
  // same HEAD, sensor dir present: not current, it retries
  w.clock.now += 120000
  assert.equal(await w.codes.maintain('code'), 'sensor-failed')
  await rm(join(w.chartsRoot, 'init-breaks')); w.clock.now += 120000
  assert.equal(await w.codes.maintain('code'), 'synced')
  assert.deepEqual((await w.calls()).slice(-2), ['sensor sync . --json', 'sensor init . --json'])
  w.clock.now += 120000
  assert.equal(await w.codes.maintain('code'), 'current')
  // the store was never touched along the way
  assert.equal(await readFile(join(w.chart, '.lattice', 'store.json'), 'utf8'), 'keep')
})

test('seat input: @input places the file where the command wants it; @input without input is refused', async t => {
  const w = await world(t)
  await w.cli.run({ id: 'code', args: ['todo', 'structure', 'realize', '--plan', 'p', '--task', 't1', '--realized', '@input'], input: { a: 1 } })
  await w.cli.run({ id: 'code', args: ['todo', 'independence', 'witness', 'scaffold', '--plan', 'p'], input: { a: 1 } })
  const [realize, scaffold] = await w.calls()
  assert.match(realize, /^todo structure realize --plan p --task t1 --realized \/.+input\.json$/u)
  assert.match(scaffold, /^todo independence witness scaffold --plan p --input \/.+input\.json$/u)
  await assert.rejects(w.cli.run({ id: 'code', args: ['todo', 'structure', 'realize', '--realized', '@input'] }), { code: 'LATTICE_INPUT_CONFLICT' })
})

test('core: seat runs on one chart run one at a time, with the code chart maintained first', async () => {
  const order = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  const cli = { exists: async () => true, ensure: async () => ({ created: false }), meta: async () => ({ name: null, createdBy: null }), setMeta: async () => {},
    run: async ({ args }) => { order.push(`start ${args[0]}`); if (args[0] === 'plan') await gate; order.push(`end ${args[0]}`); return { exitCode: 0, stdout: '{}', stderr: '' } } }
  const codeCharts = { maintain: async id => { order.push(`maintain ${id}`) } }
  const core = createLatticeCore({ cli, codeCharts, log: () => {} })
  const first = core.run({ from: 'bot-a', projectId: 'bellteam', args: ['plan', 'show'], input: null })
  const second = core.run({ from: 'bot-b', projectId: 'bellteam', args: ['todo', 'status'], input: null })
  await new Promise(resolve => setImmediate(resolve)); release(); await Promise.all([first, second])
  assert.deepEqual(order, ['maintain bellteam', 'start plan', 'end plan', 'maintain bellteam', 'start todo', 'end todo'])
})
