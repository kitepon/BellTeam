import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createLatticeCli } from '../src/lattice/cli.mjs'
import { createCodeCharts } from '../src/lattice/code-chart.mjs'
import { createLatticeCore } from '../src/lattice/core.mjs'

// a102: the checkout, git and sensor are Lattice's (K7); the module binds once and asks for a sync when due.
test('code chart: bind once per child, sync at most every 120 s, a non-current status is one log line, never throws', async () => {
  const calls = [], logs = [], clock = { now: 0 }
  let next = { status: 'synced' }
  const cli = { repoBind: async (id, url, branch) => { calls.push(['bind', id, url, branch]); return { status: 'bound' } },
    repoSync: async id => { calls.push(['sync', id]); if (next instanceof Error) throw next; return next } }
  const codes = createCodeCharts({ cli, charts: { code: { url: 'u', branch: 'main' } }, now: () => clock.now, log: line => logs.push(line) })
  assert.equal(await codes.maintain('other'), null, 'not a code chart')
  assert.equal(await codes.maintain('code'), 'synced')
  assert.equal(await codes.maintain('code'), null, 'not due yet')
  clock.now += 120000; next = { status: 'diverged', failure: { step: 'fast-forward', message: 'x' } }
  assert.equal(await codes.maintain('code'), 'diverged')
  clock.now += 120000; next = Object.assign(new Error('x'), { code: 'LATTICE_UNAVAILABLE' })
  assert.equal(await codes.maintain('code'), 'failed')
  assert.deepEqual(calls, [['bind', 'code', 'u', 'main'], ['sync', 'code'], ['sync', 'code'], ['sync', 'code']])
  assert.deepEqual(logs, ['lattice-code code diverged fast-forward', 'lattice-code code LATTICE_UNAVAILABLE'])
})

test('seat input: @input places the file where the command wants it; @input without input is refused', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lattice-input-')); t.after(() => rm(root, { recursive: true, force: true }))
  const bin = join(root, 'bin.mjs'), log = join(root, 'calls.txt')
  await writeFile(bin, `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n')\nconsole.log('{}')`)
  const cli = createLatticeCli({ bin, chartsRoot: join(root, 'charts'), home: join(root, 'home') })
  await cli.run({ id: 'code', args: ['todo', 'structure', 'realize', '--plan', 'p', '--task', 't1', '--realized', '@input'], input: { a: 1 } })
  await cli.run({ id: 'code', args: ['todo', 'independence', 'witness', 'scaffold', '--plan', 'p'], input: { a: 1 } })
  const [realize, scaffold] = (await readFile(log, 'utf8')).trim().split('\n')
  assert.match(realize, /^todo structure realize --plan p --task t1 --realized \/.+input\.json$/u)
  assert.match(scaffold, /^todo independence witness scaffold --plan p --input \/.+input\.json$/u)
  await assert.rejects(cli.run({ id: 'code', args: ['todo', 'structure', 'realize', '--realized', '@input'] }), { code: 'LATTICE_INPUT_CONFLICT' })
})

test('core: seat runs on one chart run one at a time, with the code chart maintained first', async () => {
  const order = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  const cli = { exists: async () => true, setName: async () => {},
    run: async ({ args }) => { order.push(`start ${args[0]}`); if (args[0] === 'plan') await gate; order.push(`end ${args[0]}`); return { exitCode: 0, stdout: '{}', stderr: '' } } }
  const codeCharts = { maintain: async id => { order.push(`maintain ${id}`) } }
  const core = createLatticeCore({ cli, codeCharts, log: () => {} })
  const first = core.run({ from: 'bot-a', projectId: 'bellteam', args: ['plan', 'create'], input: { a: 1 } })
  const second = core.run({ from: 'bot-b', projectId: 'bellteam', args: ['todo', 'start'], input: null })
  await new Promise(resolve => setImmediate(resolve)); release(); await Promise.all([first, second])
  assert.deepEqual(order, ['maintain bellteam', 'start plan', 'end plan', 'maintain bellteam', 'start todo', 'end todo'])
})
