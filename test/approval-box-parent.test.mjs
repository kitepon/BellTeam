import test from 'node:test'
import assert from 'node:assert/strict'
import { createApprovalBoxExtensionEffects, APPROVAL_BOX_SESSION_SCOPE } from '../src/approval-box-parent-effects.mjs'
import { createApprovalsFacade } from '../src/approval-box-parent-facade.mjs'
import { createApprovalBoxExtensionProcess } from '../src/approval-box-parent-process.mjs'
import { validateApprovalsEffectResult } from '../src/approval-box-extension-protocol.mjs'

test('effects: refusal is told apart, session uses the fixed scope, put/erase absent means unavailable', async () => {
  const seen = []
  const credentials = { current: async scope => (seen.push(scope), { available: true, handle: 'h' }),
    withResolved: async (handle, scope, consume) => (seen.push(scope), consume('{"token":"t"}')), put: async (scope, value) => seen.push([scope, value]), erase: async scope => seen.push(scope) }
  const lattice = { ownerTask: async () => { throw Object.assign(new Error('x'), { code: 'LATTICE_OWNER_TASK_REFUSED' }) }, link: async () => ({}), chart: async () => ({ cards: [], edges: [] }), charts: async () => [] }
  const effects = createApprovalBoxExtensionEffects({ lattice, bots: { listForClient: async () => [{ id: 'b', name: 'B', color: 'x' }] }, credentials })
  await assert.rejects(effects('lattice.ownerTask', { projectId: 'p', args: [] }), { code: 'APPROVALS_EFFECT_REFUSED' })
  assert.deepEqual(await effects('members.list', {}), [{ id: 'b', name: 'B' }])
  assert.deepEqual(await effects('session.get', {}), { value: '{"token":"t"}' })
  assert.deepEqual(seen[0], APPROVAL_BOX_SESSION_SCOPE)
  assert.deepEqual(await effects('session.put', { value: 'v' }), { ok: true })
  assert.deepEqual(await effects('session.erase', {}), { ok: true })
  for (const [method, value] of [['session.get', { value: 'v' }], ['session.put', { ok: true }], ['members.list', [{ id: 'b', name: 'B' }]]]) validateApprovalsEffectResult(method, value)
  const bare = createApprovalBoxExtensionEffects({ lattice, bots: {}, credentials: { current: async () => null } })
  assert.equal(await bare('session.get', {}), null)
  await assert.rejects(bare('session.put', { value: 'v' }), { code: 'APPROVAL_BOX_EXTENSION_SESSION_UNAVAILABLE' })
  await assert.rejects(bare('nope', {}), { code: 'APPROVAL_BOX_EXTENSION_EFFECT_INVALID' })
})

test('facade: loop fans events out, keeps child codes, hides other failures', async () => {
  const timers = []
  const calls = []
  const controller = { request: async (method, params) => {
    calls.push([method, params])
    if (method === 'refresh') return { seq: 3, events: [{ type: 'decision.created', id: 'K-ABCD', version: 1 }], summary: { pending: 1 } }
    if (method === 'get') throw Object.assign(new Error('x'), { code: 'APPROVALS_NOT_FOUND' })
    throw new Error('boom')
  } }
  const facade = createApprovalsFacade({ controller, setTimer: fn => (timers.push(fn), { unref() {} }), clearTimer() {} })
  const got = []
  facade.subscribe(message => got.push(message))
  await timers.at(-1)()
  assert.deepEqual(calls[0], ['refresh', { since: 0 }])
  assert.deepEqual(got.map(item => item.event), ['decision.created', 'summary'])
  await assert.rejects(facade.get({ id: 'K-ABCD' }), { code: 'APPROVALS_NOT_FOUND', status: 404 })
  await assert.rejects(facade.list({ status: ['pending'] }), { code: 'APPROVALS_UNAVAILABLE', status: 503 })
  await timers.at(-1)()
  assert.deepEqual(calls.findLast(call => call[0] === 'refresh')[1], { since: 3 })
  facade.close()
})

test('process: builds for the new component', () => {
  assert.equal(typeof createApprovalBoxExtensionProcess({ root: '/tmp/x', onEffect: async () => null, spawnProcess() {} }).start, 'function')
})
