import assert from 'node:assert/strict'
import test from 'node:test'
import { selectResets } from '../src/aiterm-state-compat.mjs'

const declaration = stores => JSON.stringify({ schema: 'aiterm.state-compat.v1', stores })
const target = declaration({ s: { path: 'a/s', writes: 'f2', reads: ['f2'], resets: ['f1'], legacy: [{ from: '0.60.0', through: '0.66.9', format: 'f1' }] } })

// Byte content of aiterm-mcp 0.68.0 state-compat.json (Elegg 2026-11-09).
const released = JSON.stringify({ schema: 'aiterm.state-compat.v1', stores: { 'state-root': { path: 'aiterm-mcp-{uid}', writes: 'v1', reads: ['v1'], resets: [],
  legacy: [{ from: '0.63.17', through: '0.67.0', format: 'v1' }] } } })

test('aiterm-mcp 0.68.0 declaration preserves every swap from 0.63.17 on', () => {
  for (const version of ['0.63.17', '0.64.2', '0.67.0']) assert.deepEqual(selectResets({ version, declaration: null }, { declaration: released }), { resets: [], note: null })
  assert.deepEqual(selectResets({ version: '0.68.0', declaration: released }, { declaration: released }), { resets: [], note: null })
})

test('only a source format the target declares in resets resets that store; everything else keeps state', () => {
  assert.deepEqual(selectResets({ version: '0.64.2', declaration: null }, { declaration: target }).resets, [{ store: 's', path: 'a/s', format: 'f1' }])
  // Old declaration wins over the version legacy map; numeric compare (0.10.0 > 0.9.0).
  assert.deepEqual(selectResets({ version: '0.64.2', declaration: declaration({ s: { path: 'a/s', writes: 'f2' } }) }, { declaration: target }).resets, [])
  assert.deepEqual(selectResets({ version: '0.67.0', declaration: null }, { declaration: target }).resets, [])
  assert.deepEqual(selectResets({ version: '0.6.10', declaration: null }, { declaration: target }).resets, [])
  assert.deepEqual(selectResets({ version: '0.64.2' }, { declaration: null }), { resets: [], note: 'TARGET_UNDECLARED' })
  assert.deepEqual(selectResets(null, null), { resets: [], note: 'TARGET_UNDECLARED' })
  for (const bad of ['{', declaration({ s: { path: '../x' } }), declaration({ s: { path: '.bellteam-reset/x' } }),
    declaration({ s: { path: 'a' }, t: { path: 'a/b' } }), JSON.stringify({ schema: 'other', stores: {} })])
    assert.deepEqual(selectResets({ version: '0.64.2' }, { declaration: bad }), { resets: [], note: 'TARGET_DECLARATION_INVALID' })
})

test('apply reads the selection from stdin; empty applies none, malformed fails the step', async () => {
  const { spawnSync } = await import('node:child_process'), { mkdtempSync, readFileSync, mkdirSync, existsSync } = await import('node:fs'), { tmpdir } = await import('node:os')
  const cli = new URL('../src/aiterm-state-compat.mjs', import.meta.url).pathname, run = (root, input) => spawnSync(process.execPath, [cli, 'apply', root, 'aiterm=preserved'], { input })
  const root = mkdtempSync(tmpdir() + '/compat-'), uid = String(process.getuid())
  mkdirSync(`${root}/a/s-${uid}`, { recursive: true })
  assert.equal(run(root, '').status, 0)
  assert.match(readFileSync(`${root}/.bellteam-reset/aiterm-state.log`, 'utf8'), / aiterm=preserved\n$/)
  assert.notEqual(run(root, '{').status, 0)
  assert.equal(run(root, JSON.stringify({ resets: [{ store: 's', path: 'a/s-{uid}', format: 'f1' }], note: null })).status, 0)
  assert.equal(existsSync(`${root}/a/s-${uid}`), false)
})
