import test from 'node:test'
import assert from 'node:assert/strict'
import { createApprovalBoxClientPort } from '../src/approval-box-client.mjs'

// A fake seat runner standing in for `approval-box mcp`: answers the tools/call line of the session it was given.
function rig(tools) {
  const calls = []
  const seatRun = async (file, args, { input }) => {
    const lines = input.trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(lines.map(line => line.method), ['initialize', 'notifications/initialized', 'tools/call'])
    const { name, arguments: body } = lines[2].params
    calls.push([name, body])
    const hit = tools[name]
    const result = typeof hit === 'function' ? hit(body, calls) : hit
    if (result instanceof Error) throw result
    return { stdout: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 2, result }) + '\n' }
  }
  return { calls, port: createApprovalBoxClientPort({ seatRun }) }
}
const ok = json => ({ content: [{ type: 'text', text: 'x' }], structuredContent: json })
const bad = json => ({ content: [{ type: 'text', text: 'x' }], structuredContent: json, isError: true })
const kindOf = promise => promise.then(() => null, error => error.kind)
const decision = { title: 't', context: 'c', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], requester: 'Kiro', session_label: 'Seat bot x 1' }

test('no seat runner: every call is UNAVAILABLE and nothing runs', async () => {
  const port = createApprovalBoxClientPort({})
  assert.equal(await kindOf(port.file(decision)), 'UNAVAILABLE')
  assert.equal(await kindOf(port.read('K-AAAAAA')), 'UNAVAILABLE')
})

test('file: an open card with the same label is adopted; a cancelled or answered one is not; a new one goes through confirm_required with the token', async () => {
  const items = [{ decision_id: 'K-OLD111', session_label: 'Seat bot x 1', status: 'cancelled' }, { decision_id: 'K-OPEN22', session_label: 'Seat bot x 2', status: 'pending' }]
  const { port, calls } = rig({
    list_my_decisions: ok({ items }),
    request_decision: body => body.check_token ? ok({ decision_id: 'K-NEW333' }) : bad({ error: 'confirm_required', check_token: 'chk_1', decisions: [] }),
  })
  assert.deepEqual(await port.file({ ...decision, session_label: 'Seat bot x 2' }), { decisionId: 'K-OPEN22', existing: true })
  assert.deepEqual(await port.file(decision), { decisionId: 'K-NEW333', existing: false })
  const [, posted] = calls.filter(call => call[0] === 'request_decision').at(-1)
  assert.deepEqual([posted.requester_name, posted.session_label, posted.check_token], ['Kiro', 'Seat bot x 1', 'chk_1'])
})

test('file: origin names a missing requester; an unknown origin or a missing label is REFUSED; a duplicate_suspected open card is adopted', async () => {
  const dup = { decision_id: 'K-DUP444', session_label: 'Seat bot x 1', status: 'pending' }
  const { port, calls } = rig({ list_my_decisions: ok({ items: [] }), request_decision: () => bad({ error: 'duplicate_suspected', existing: dup }) })
  assert.deepEqual(await port.file(decision), { decisionId: 'K-DUP444', existing: true })
  await kindOf(port.file({ ...decision, requester: undefined, origin: 'running-exclusions' }))
  assert.equal(calls.filter(call => call[0] === 'request_decision').at(-1)[1].requester_name, 'running-exclusions')
  assert.equal(await kindOf(port.file({ ...decision, origin: 'other' })), 'REFUSED')
  assert.equal(await kindOf(port.file({ ...decision, session_label: '' })), 'REFUSED')
})

test('read: status and answer come back; not_found is GONE; a client failure is UNAVAILABLE', async () => {
  const { port } = rig({ get_decision: body => body.decision_id === 'K-NONE00' ? bad({ error: 'not_found' })
    : ok({ decision_id: body.decision_id, status: body.decision_id === 'K-ANS111' ? 'answered' : 'pending', answer: body.decision_id === 'K-ANS111' ? { option_id: 'approve_once', text: 'ok' } : undefined, answer_text: 'wake-up message for an AI' }) })
  assert.deepEqual(await port.read('K-ANS111'), { status: 'answered', answer: { optionId: 'approve_once', text: 'ok' } })
  assert.deepEqual(await port.read('K-PEND11'), { status: 'pending' })
  assert.equal(await kindOf(port.read('K-NONE00')), 'GONE')
  const down = createApprovalBoxClientPort({ seatRun: async () => { throw new Error('boom') } })
  assert.equal(await kindOf(down.read('K-ANS111')), 'UNAVAILABLE')
})

test('cancel: cancelled is success; an already answered card is REFUSED; an unknown id is GONE', async () => {
  const { port } = rig({ cancel_decision: body => body.decision_id === 'K-OPEN22' ? ok({ decision_id: 'K-OPEN22', status: 'cancelled' })
    : bad({ error: body.decision_id === 'K-NONE00' ? 'not_found' : 'not_pending' }) })
  assert.deepEqual(await port.cancel('K-OPEN22', 'r'), { status: 'cancelled' })
  assert.equal(await kindOf(port.cancel('K-ANS111', 'r')), 'REFUSED')
  assert.equal(await kindOf(port.cancel('K-NONE00', 'r')), 'GONE')
})
