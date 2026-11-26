import assert from 'node:assert/strict'
import test from 'node:test'
import { createLatticeDecisions } from '../src/lattice-decisions.mjs'
import { createLatticeEffects } from '../src/lattice-facade.mjs'

const portError = (kind, status) => Object.assign(new Error('APPROVAL_BOX_PORT_' + kind), { kind, status })
const fixture = decisions => {
  const calls = []
  const port = { file: async p => { calls.push(['file', p]); return { decisionId: 'd1', existing: false } }, read: async id => { calls.push(['read', id]); return decisions.read(id) },
    cancel: async (id, reason) => { calls.push(['cancel', id, reason]); return decisions.cancel(id, reason) } }
  return { calls, effects: createLatticeEffects({ decisions: createLatticeDecisions({ port: () => port }) }) }
}

test('f24: read and cancel go to P1 with plain arguments; file passes origin lattice', async () => {
  const x = fixture({ read: () => ({ status: 'answered', answer: { optionId: 'done' } }), cancel: () => ({ status: 'cancelled' }) })
  assert.deepEqual(await x.effects('decisions.read', { decisionId: 'd1' }), { status: 'answered', answer: { optionId: 'done' } })
  assert.deepEqual(await x.effects('decisions.cancel', { decisionId: 'd1', reason: '済んだ' }), { status: 'cancelled' })
  const filed = { title: 't', context: 'c', options: [], requester: 'r', session_label: 's' }
  assert.deepEqual(await x.effects('decisions.file', filed), { decisionId: 'd1', existing: false })
  assert.deepEqual(x.calls, [['read', 'd1'], ['cancel', 'd1', '済んだ'], ['file', { ...filed, origin: 'lattice' }]])
})

test('f24: P1 kinds map to the three codes the child tells apart; cancel of a GONE id stays REFUSED; no port or an unknown failure is UNAVAILABLE', async () => {
  const failing = kind => fixture({ read: () => { throw portError(kind) }, cancel: () => { throw portError(kind) } })
  const code = async (x, method, params) => x.effects(method, params).then(() => null, error => [error.code, error.status])
  const read = { decisionId: 'd1' }, cancel = { decisionId: 'd1', reason: 'r' }
  assert.deepEqual(await code(failing('UNAVAILABLE'), 'decisions.read', read), ['LATTICE_DECISIONS_UNAVAILABLE', 503])
  assert.deepEqual(await code(failing('REFUSED'), 'decisions.read', read), ['LATTICE_DECISIONS_REFUSED', 409])
  assert.deepEqual(await code(failing('GONE'), 'decisions.read', read), ['LATTICE_DECISIONS_GONE', 404])
  assert.deepEqual(await code(failing('GONE'), 'decisions.cancel', cancel), ['LATTICE_DECISIONS_REFUSED', 409], 'a request the Approval Box no longer knows is already over')
  assert.deepEqual(await code(failing('WHATEVER'), 'decisions.cancel', cancel), ['LATTICE_DECISIONS_UNAVAILABLE', 503])
  const none = createLatticeEffects({ decisions: createLatticeDecisions({ port: () => undefined }) })
  assert.deepEqual(await code({ effects: none }, 'decisions.read', read), ['LATTICE_DECISIONS_UNAVAILABLE', 503], 'approvals not built')
})
