import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { serialize, deserialize } from 'node:v8'
import { createConversationParentChannel, createConversationChildChannel } from '../src/conversation-ipc.mjs'
import { createConversationPeer } from '../src/conversation-channel.mjs'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'

const report = { code: 'MESSAGE_LOG_INVALID', line: 1, offset: 0, length: 0, reason: 'nul' }
const invalid = [
  { code: report.code },
  ...['line', 'offset', 'length', 'reason'].map(key => Object.fromEntries(Object.entries(report).filter(([name]) => name !== key))),
  ...[0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(line => ({ ...report, line })),
  ...['offset', 'length'].flatMap(key => [-1, 0.5, '0', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(value => ({ ...report, [key]: value }))),
  { ...report, reason: 'other' }, { ...report, body: 'private' }, { ...report, stack: 'private' },
  { ...report, code: 'OTHER_FAILURE' }, { code: 'OTHER_FAILURE', message: 'private' },
  { code: 'OTHER_FAILURE', reason: 'OBSERVER_PROJECT_CHANGED' },
  ...['free text', 'lower_case', '', 1, null].map(reason => ({ code: 'CONVERSATION_OBSERVATION_FAILED', reason })),
  { code: 'CONVERSATION_OBSERVATION_FAILED', reason: 'OBSERVER_PROJECT_CHANGED', message: 'private' },
]
function channels(t, raw = false) {
  const endpoints = [new EventEmitter(), new EventEmitter()], reports = []
  for (const [index, endpoint] of endpoints.entries()) {
    endpoint.connected = true
    endpoint.send = (frame, callback) => {
      const copy = deserialize(serialize(frame))
      setImmediate(() => { if (endpoint.connected) endpoints[1 - index].emit('message', copy); callback?.(null) })
    }
    endpoint.disconnect = () => { for (const peer of endpoints) if (peer.connected) { peer.connected = false; peer.emit('disconnect') } }
  }
  const parent = createConversationParentChannel(endpoints[0], { generation: 'diagnostic-fixture',
    admission: new ConversationLifetimes('diagnostic-fixture'), authorizeActor: () => false,
    onEffect: () => assert.fail('diagnostic must not invoke a business effect'), onDiagnostic: value => { reports.push(value) } })
  const child = raw
    ? createConversationPeer(endpoints[1], { side: 'child', validateResult: (_kind, _method, value) => assert.deepEqual(value, { acknowledged: true }) })
    : createConversationChildChannel({ dispatcher: { disconnect: async () => {} }, endpoint: endpoints[1], versionId: null })
  t.after(async () => { child.close(); await parent.drainIncoming(); parent.reaped() })
  return { child, reports }
}

test('diagnostic wire accepts only fixed corruption positions and preserves other code-only reports', { timeout: 4000 }, async t => {
  const h = channels(t)
  for (const reason of ['nul', 'syntax', 'schema']) {
    const value = { ...report, reason, line: Number.MAX_SAFE_INTEGER, offset: Number.MAX_SAFE_INTEGER, length: Number.MAX_SAFE_INTEGER }
    assert.deepEqual(await h.child.diagnostic(value), { acknowledged: true })
    assert.deepEqual(h.reports.at(-1), value)
  }
  await h.child.diagnostic(report)
  await h.child.diagnostic({ code: 'CONVERSATION_BACKGROUND_FAILED' })
  await h.child.diagnostic({ code: 'CONVERSATION_OBSERVATION_FAILED', reason: 'OBSERVER_PROJECT_CHANGED' })
  await h.child.diagnostic({ code: 'CONVERSATION_OBSERVATION_FAILED' })
  for (const value of [...invalid, null, {}, 'private'])
    assert.throws(() => h.child.diagnostic(value), { code: 'CONVERSATION_IPC_INVALID' })
  assert.equal(h.reports.length, 7)
  assert.deepEqual(h.reports.at(-2), { code: 'CONVERSATION_OBSERVATION_FAILED', reason: 'OBSERVER_PROJECT_CHANGED' })
})

test('parent diagnostic wire rejects malformed corruption reports before the persistence callback', { timeout: 4000 }, async t => {
  const h = channels(t, true)
  for (const value of invalid) {
    const attempt = h.child.call('diagnostic', 'diagnostic', value)
    await assert.rejects(attempt, { code: 'CONVERSATION_IPC_INVALID' })
    await assert.rejects(attempt.completion, { code: 'CONVERSATION_IPC_INVALID' })
  }
  assert.deepEqual(h.reports, [])
  await h.child.call('diagnostic', 'diagnostic', report)
  await h.child.call('diagnostic', 'diagnostic', { code: 'CONVERSATION_BACKGROUND_FAILED' })
  assert.deepEqual(h.reports, [report, { code: 'CONVERSATION_BACKGROUND_FAILED' }])
})
