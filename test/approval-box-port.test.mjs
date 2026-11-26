import test from 'node:test'
import assert from 'node:assert/strict'
import { createApprovalBoxPort } from '../src/approval-box-port.mjs'

// A fake hosted connector: routes answer from a table; status says paired or not.
function fake({ paired = true, routes = {} } = {}) {
  const calls = []
  return { calls,
    status: async () => ({ running: true, daemon: { mode: paired ? 'pc' : 'not_paired', reason: paired ? null : 'not_paired', version: '0.2.0-pc.4' } }),
    route: async (method, path, body) => {
      calls.push([method, path, body])
      const hit = routes[`${method} ${path}`]
      if (!hit) throw Object.assign(new Error('x'), { status: 404, code: 'not_found' })
      if (typeof hit === 'function') return hit(body, calls)
      if (hit instanceof Error) throw hit
      return hit
    } }
}
const err = (status, code, body) => Object.assign(new Error(code), { status, code, ...(body ? { body } : {}) })
const kindOf = promise => promise.then(() => null, error => error.kind)
const decision = { title: 't', context: 'c', options: [{ id: 'a', label: 'A' }], requester: 'Kiro', session_label: 'Seat bot x 1' }

test('file: not linked is UNAVAILABLE and nothing is filed', async () => {
  const daemon = fake({ paired: false })
  assert.equal(await kindOf(createApprovalBoxPort({ daemon }).file(decision)), 'UNAVAILABLE')
  assert.deepEqual(daemon.calls, [])
})

test('file: the same session_label is adopted, never filed twice; a new one is filed with its own label and requester', async () => {
  const daemon = fake({ routes: { 'GET /decisions': { items: [{ id: 'K-AAAA11', session_label: 'Seat bot x 1' }] }, 'POST /decisions': { id: 'K-NEW111' } } })
  const port = createApprovalBoxPort({ daemon })
  assert.deepEqual(await port.file(decision), { decisionId: 'K-AAAA11', existing: true })
  assert.deepEqual(await port.file({ ...decision, session_label: 'Seat bot x 2', origin: 'seat-approval' }), { decisionId: 'K-NEW111', existing: false })
  const posted = daemon.calls.find(call => call[0] === 'POST')[2]
  assert.deepEqual([posted.session_label, posted.requester, posted.urgency, posted.client], ['Seat bot x 2', 'Kiro', 'normal', 'other'])
})

test('file: origin only names a missing requester; an unknown origin or a missing label is REFUSED', async () => {
  const daemon = fake({ routes: { 'GET /decisions': { items: [] }, 'POST /decisions': { id: 'K-NEW111' } } })
  const port = createApprovalBoxPort({ daemon })
  await port.file({ ...decision, requester: undefined, origin: 'running-exclusions' })
  assert.equal(daemon.calls.find(call => call[0] === 'POST')[2].requester, 'running-exclusions')
  assert.equal(await kindOf(port.file({ ...decision, origin: 'other' })), 'REFUSED')
  assert.equal(await kindOf(port.file({ ...decision, session_label: '' })), 'REFUSED')
})

test('file: confirm_required is retried once with its check_token; a duplicate_suspected existing is adopted', async () => {
  let round = 0
  const daemon = fake({ routes: { 'GET /decisions': { items: [] }, 'POST /decisions': body => {
    if (round++ === 0) throw err(409, 'confirm_required', { check_token: 'tok' })
    assert.equal(body.check_token, 'tok'); return { id: 'K-NEW222' } } } })
  assert.deepEqual(await createApprovalBoxPort({ daemon }).file(decision), { decisionId: 'K-NEW222', existing: false })
  const dup = fake({ routes: { 'GET /decisions': { items: [] }, 'POST /decisions': () => { throw err(409, 'duplicate_suspected', { existing: { id: 'K-OLD333', session_label: 'Seat bot x 1' } }) } } })
  assert.deepEqual(await createApprovalBoxPort({ daemon: dup }).file(decision), { decisionId: 'K-OLD333', existing: true })
})

test('read: status and answer come back and an answered request is marked fetched; unknown id is GONE, a 5xx is UNAVAILABLE', async () => {
  const daemon = fake({ routes: {
    'GET /decisions/K-ANS111': { id: 'K-ANS111', status: 'answered', answer: { option_id: 'approve_once', text: 'ok' } },
    'POST /decisions/K-ANS111/fetched': {},
    'GET /decisions/K-PEN111': { id: 'K-PEN111', status: 'pending' },
    'GET /decisions/K-BAD111': err(500, 'boom') } })
  const port = createApprovalBoxPort({ daemon })
  assert.deepEqual(await port.read('K-ANS111'), { status: 'answered', answer: { optionId: 'approve_once', text: 'ok' } })
  assert.ok(daemon.calls.some(call => call[1] === '/decisions/K-ANS111/fetched'))
  assert.deepEqual(await port.read('K-PEN111'), { status: 'pending' })
  assert.equal(daemon.calls.filter(call => call[1] === '/decisions/K-PEN111/fetched').length, 0)
  assert.equal(await kindOf(port.read('K-GONE11')), 'GONE')
  assert.equal(await kindOf(port.read('K-BAD111')), 'UNAVAILABLE')
})

test('cancel: cancelled on success; an answered one (4xx) is REFUSED, not success', async () => {
  const daemon = fake({ routes: { 'POST /decisions/K-OPEN11/cancel': { id: 'K-OPEN11', status: 'cancelled' }, 'POST /decisions/K-DONE11/cancel': err(409, 'already_answered') } })
  const port = createApprovalBoxPort({ daemon })
  assert.deepEqual(await port.cancel('K-OPEN11', 'もう要りません'), { status: 'cancelled' })
  assert.equal(await kindOf(port.cancel('K-DONE11', 'x')), 'REFUSED')
})

test('a call that does not answer within the bound fails UNAVAILABLE', async () => {
  const daemon = { status: async () => ({ daemon: { mode: 'pc' } }), route: () => new Promise(() => {}) }
  const timers = []
  const port = createApprovalBoxPort({ daemon, setTimer: (fn) => { timers.push(fn); return { unref() {} } }, clearTimer: () => {} })
  const pending = kindOf(port.read('K-SLOW111'))
  await new Promise(resolve => setImmediate(resolve)); timers[0]()
  assert.equal(await pending, 'UNAVAILABLE')
})

test('capabilities and connection', async () => {
  const port = createApprovalBoxPort({ daemon: fake(), readCapabilities: async () => ['bellteam-requester-wake'] })
  assert.deepEqual(await port.capabilities(), ['bellteam-requester-wake'])
  assert.deepEqual(await port.connection(), { linked: true, mode: 'pc', reason: null, version: '0.2.0-pc.4', running: true })
  const none = createApprovalBoxPort({ daemon: fake({ paired: false }), readCapabilities: async () => { throw new Error('x') } })
  assert.deepEqual(await none.capabilities(), [])
  assert.equal((await none.connection()).linked, false)
})

test('capabilities by default run the seats binary as the seat user (the seat process runner), and fall back to []', async () => {
  const seen = []
  const seatRun = async (command, args, options) => { seen.push([command, args, options.signal instanceof AbortSignal]); return { stdout: JSON.stringify({ capabilities: ['bellteam-requester-wake', 7] }) } }
  assert.deepEqual(await createApprovalBoxPort({ daemon: fake(), seatRun }).capabilities(), ['bellteam-requester-wake'])
  assert.deepEqual(seen[0], ['/home/bell/.approval-box/bin/approval-box', ['version', '--json'], true])
})
