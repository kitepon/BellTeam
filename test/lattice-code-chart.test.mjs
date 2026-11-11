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
  // Fake Lattice: records argv (sensor init/sync and seat commands) beside the chart.
  await writeFile(bin, `import { appendFileSync } from 'node:fs'
appendFileSync(process.cwd() + '/../calls.log', process.argv.slice(2).join(' ') + '\\n')
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
  assert.deepEqual(await w.calls(), ['sensor init . --json'])
  await writeFile(join(w.work, 'b.txt'), 'two'); git(w.work, 'add', '.'); git(w.work, 'commit', '-q', '-m', 'c2'); git(w.work, 'push', '-q', w.origin, 'main')
  assert.equal(await w.codes.maintain('code'), null, 'not due yet')
  w.clock.now += 120000
  await mkdir(join(w.chart, '.lattice', 'sensor'))
  assert.equal(await w.codes.maintain('code'), 'synced')
  assert.equal(git(w.chart, 'rev-parse', 'HEAD'), git(w.work, 'rev-parse', 'HEAD'))
  assert.deepEqual((await w.calls()).at(-1), 'sensor sync . --json')
  w.clock.now += 120000
  assert.equal(await w.codes.maintain('code'), 'current', 'nothing new: no sensor run')
  assert.equal(await w.codes.maintain('other'), null, 'not a code chart')
})

test('code chart: a diverged checkout or a foreign origin is never reset or repointed; the next due run retries', async t => {
  const w = await world(t)
  await w.codes.maintain('code'); await mkdir(join(w.chart, '.lattice', 'sensor'))
  await writeFile(join(w.chart, 'local.txt'), 'mine'); git(w.chart, 'add', 'local.txt'); git(w.chart, 'commit', '-q', '-m', 'local')
  const local = git(w.chart, 'rev-parse', 'HEAD')
  await writeFile(join(w.work, 'c.txt'), 'three'); git(w.work, 'add', '.'); git(w.work, 'commit', '-q', '-m', 'c3'); git(w.work, 'push', '-q', w.origin, 'main')
  w.clock.now += 120000
  assert.equal(await w.codes.maintain('code'), 'failed')
  assert.deepEqual([git(w.chart, 'rev-parse', 'HEAD'), existsSync(join(w.chart, 'local.txt'))], [local, true], 'no reset')
  assert.match(w.logs.at(-1), /^lattice-code code /)
  git(w.chart, 'remote', 'set-url', 'origin', join(w.root, 'elsewhere.git')); w.clock.now += 120000
  assert.equal(await w.codes.maintain('code'), 'origin-elsewhere')
  assert.equal(git(w.chart, 'remote', 'get-url', 'origin'), join(w.root, 'elsewhere.git'), 'origin not repointed')
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
