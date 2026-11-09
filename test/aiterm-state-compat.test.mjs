import assert from 'node:assert/strict'
import test from 'node:test'
import { selectResets } from '../src/aiterm-state-compat.mjs'

const declaration = stores => JSON.stringify({ schema: 'aiterm.state-compat.v1', stores })
const target = declaration({ s: { path: 'a/s', writes: 'f2', reads: ['f2'], resets: ['f1'], legacy: [{ from: '0.60.0', through: '0.66.9', format: 'f1' }] } })

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
