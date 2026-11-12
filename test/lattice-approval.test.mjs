import assert from 'node:assert/strict'
import test from 'node:test'
import { createLatticeDecisions, LATTICE_APPROVAL_SCOPE } from '../src/lattice-approval.mjs'
import { createLatticeEffects } from '../src/lattice-facade.mjs'

const params = { title: 'Alpha: Task t1', context: 'c', options: [{ id: 'done', label: '済んだ' }, { id: 'not-yet', label: 'まだ' }], requester: 'Cee', session_label: 'Alpha / p1/t1' }

function rig({ current = null, rows = [], responses = [] }) {
  const binds = [], fetches = [], resolved = []
  let selected = current
  const credentials = {
    current: async scope => { assert.deepEqual(scope, LATTICE_APPROVAL_SCOPE); return selected },
    bind: async (id, scope) => { binds.push([id, scope]); selected = { handle: `h-${id}`, revision: 1, available: true, requestId: id }; return selected },
    withResolved: async (handle, target, consume) => { resolved.push([handle, target]); return consume('tok-1') },
  }
  const secretRequests = { timeline: target => rows.filter(row => row.secret_request.botId === target.botId) }
  const fetchImpl = async (url, init) => {
    fetches.push([init.method, url.replace('https://approval-box.kitepon.dev/connector/v1', ''), init.body ? JSON.parse(init.body) : null, init.headers.authorization])
    const [status, json] = responses.shift() ?? [500, {}]
    return { ok: status < 300, json: async () => json }
  }
  return { binds, fetches, resolved, decisions: createLatticeDecisions({ credentials, secretRequests, fetchImpl }) }
}
const row = (id, status, at, botId = 'bot-7e777fe5', toolId = 'lattice-approval-box') => ({ secret_request: { id, botId, toolId, status, at } })

test('decisions.file: binds the newest submitted Flora request once, confirms with check_token, no route, client other', async () => {
  const x = rig({ rows: [row('s1', 'submitted', '2026-11-13T00:00:00Z'), row('s2', 'submitted', '2026-11-13T01:00:00Z'), row('s3', 'pending', '2026-11-13T02:00:00Z'),
    row('s4', 'submitted', '2026-11-13T03:00:00Z', 'bot-other'), row('s5', 'submitted', '2026-11-13T03:00:00Z', 'bot-7e777fe5', 'other-tool')],
  responses: [[409, { error: { code: 'confirm_required', check_token: 'ct1', decisions: [] } }], [201, { id: 'K-ABC123', status: 'pending' }]] })
  assert.deepEqual(await x.decisions.file(params), { decisionId: 'K-ABC123', existing: false })
  assert.deepEqual(x.binds, [['s2', LATTICE_APPROVAL_SCOPE]])
  assert.deepEqual(x.resolved[0], ['h-s2', { ...LATTICE_APPROVAL_SCOPE, memberId: null }])
  const [first, second] = x.fetches
  assert.equal(first[3], 'Bearer tok-1')
  assert.deepEqual(first.slice(0, 2), ['POST', '/decisions'])
  assert.deepEqual(first[2], { ...params, urgency: 'normal', client: 'other' })
  assert.ok(!('route' in first[2]) && !('work_label' in first[2]))
  assert.deepEqual(second[2], { ...first[2], check_token: 'ct1' })
})

test('decisions.file: an open request with the same session label is adopted, not filed again; no token -> unavailable', async () => {
  const x = rig({ current: { handle: 'h', revision: 1, available: true, requestId: 's' },
    responses: [[409, { error: { code: 'confirm_required', check_token: 'ct', decisions: [{ decision_id: 'K-OLD001', status: 'pending', session_label: 'Cee / Alpha / p1/t1' }] } }]] })
  assert.deepEqual(await x.decisions.file(params), { decisionId: 'K-OLD001', existing: true })
  assert.equal(x.fetches.length, 1)
  const dup = rig({ current: { handle: 'h', revision: 1, available: true, requestId: 's' }, responses: [[409, { error: { code: 'confirm_required', check_token: 'ct', decisions: [] } }],
    [409, { error: { code: 'duplicate_suspected', existing: [{ decision_id: 'K-OTHER1', status: 'pending', session_label: 'Aye / Beta / p1/t9' }] } }]] })
  await assert.rejects(dup.decisions.file(params), { code: 'LATTICE_DECISIONS_UNAVAILABLE' }, 'another task with the same title is not adopted')
  await assert.rejects(rig({}).decisions.file(params), { code: 'LATTICE_DECISIONS_UNAVAILABLE' })
  await assert.rejects(rig({ current: { handle: 'h', revision: 1, available: false, requestId: 's' } }).decisions.read({ decisionId: 'K-ABC123' }), { code: 'LATTICE_DECISIONS_UNAVAILABLE' })
})

test('decisions.read: answer mapped, collected mark posted once; effects route decisions.* and refuse without them', async () => {
  const x = rig({ current: { handle: 'h', revision: 1, available: true, requestId: 's' },
    responses: [[200, { id: 'K-ABC123', status: 'answered', answer: { option_id: 'done', text: 'ok', answered_at: 't' } }], [200, {}]] })
  assert.deepEqual(await x.decisions.read({ decisionId: 'K-ABC123' }), { status: 'answered', answer: { optionId: 'done', text: 'ok' } })
  assert.deepEqual(x.fetches.map(item => item.slice(0, 2)), [['GET', '/decisions/K-ABC123'], ['POST', '/decisions/K-ABC123/fetched']])
  const pending = rig({ current: { handle: 'h', revision: 1, available: true, requestId: 's' }, responses: [[200, { id: 'K-ABC123', status: 'pending' }]] })
  assert.deepEqual(await pending.decisions.read({ decisionId: 'K-ABC123' }), { status: 'pending' })
  assert.equal(pending.fetches.length, 1)
  const effect = createLatticeEffects({ bots: null, messenger: null, transport: null, decisions: { file: async () => ({ decisionId: 'K-X1Y2', existing: false }), read: async () => ({ status: 'held' }) } })
  assert.deepEqual(await effect('decisions.read', { decisionId: 'K-X1Y2' }), { status: 'held' })
  await assert.rejects(createLatticeEffects({ bots: null, messenger: null, transport: null })('decisions.file', params), { code: 'LATTICE_DECISIONS_UNAVAILABLE' })
})
