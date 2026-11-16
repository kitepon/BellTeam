import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseEntries } from '../src/harness-entries.mjs'

const read = async name => JSON.parse(await readFile(new URL(`../${name}`, import.meta.url), 'utf8'))

test('lattice code graph: the E1 file is valid, MCP only, for every CLI, and E2 names it', async () => {
  const parsed = parseEntries('lattice', await read('config/lattice-harness-entries.json'))
  assert.deepEqual(parsed.servers.map(item => `${item.harness}:${item.name}`).sort(),
    ['claude', 'codex', 'cursor', 'gemini', 'grok'].map(harness => `${harness}:lattice-code-graph`))
  assert.ok(parsed.servers.every(item => item.entry.command === '/usr/local/bin/lattice-mcp'))
  assert.deepEqual(parsed.hooks, {})
  const e2 = (await read('config/harness-products.json')).find(item => item.product === 'lattice')
  assert.equal(e2.file, '/app/config/lattice-harness-entries.json')
})

// The wrapper calls the image's bundled bin, so this runs only where the body is installed (the container).
const bin = '/app/src/lattice/node_modules/@quolu/lattice/bin/lattice.mjs'
// g2 (.lattice/sensor/ excluded by sensor init) is in 0.107.0; a body image still on 0.106.x indexes but leaves .lattice/ untracked.
const g2 = existsSync(bin) && JSON.parse(readFileSync(join(bin, '../../package.json'), 'utf8')).version.split('.').map(Number).reduce((n, part) => n * 1000 + part, 0) >= 107000
test('lattice-sensor-init: indexes the clone twice and it stays clean (Lattice excludes .lattice/sensor/ once)', { skip: !g2 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sensor-init-'))
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  git('init', '-q'); await writeFile(join(dir, 'a.mjs'), 'export const a = () => 1\n')
  git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i')
  const script = new URL('../scripts/lattice-sensor-init', import.meta.url).pathname
  for (let run = 0; run < 2; run++) assert.match(execFileSync(script, [dir], { encoding: 'utf8' }), /"status":"ok"/u)
  assert.equal(git('status', '--short'), '')
  assert.equal((await readFile(join(dir, '.git/info/exclude'), 'utf8')).split('\n').filter(line => line === '.lattice/sensor/').length, 1)
  assert.throws(() => execFileSync(script, [tmpdir()], { stdio: 'pipe' }))
})
