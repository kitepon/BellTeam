import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serialize, deserialize } from 'node:v8'
import { conversationDiagnosticPort } from '../src/application-services.mjs'
import { createConversationParentChannel, createConversationChildChannel } from '../src/conversation-ipc.mjs'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'
import { Diagnostics } from '../src/diagnostics.mjs'

// 2026-11-08 conversation@96c07: a refused report rejected the child's pending call and failed quiesce/exchange with DIAGNOSTIC_INVALID.
test('a Diagnostics refusal is acknowledged to the conversation child and kept out of its call outcome', { timeout: 4000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bt-conversation-diagnostic-port-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const diagnostics = new Diagnostics(join(root, 'diagnostics.json'))
  await diagnostics.initialize()
  const endpoints = [new EventEmitter(), new EventEmitter()]
  for (const [index, endpoint] of endpoints.entries()) {
    endpoint.connected = true
    endpoint.send = (frame, callback) => {
      const copy = deserialize(serialize(frame))
      setImmediate(() => { if (endpoint.connected) endpoints[1 - index].emit('message', copy); callback?.(null) })
    }
    endpoint.disconnect = () => { for (const peer of endpoints) if (peer.connected) { peer.connected = false; peer.emit('disconnect') } }
  }
  const parent = createConversationParentChannel(endpoints[0], { generation: 'port-fixture',
    admission: new ConversationLifetimes('port-fixture'), authorizeActor: () => false,
    onEffect: () => assert.fail('diagnostic must not invoke a business effect'), onDiagnostic: conversationDiagnosticPort(diagnostics) })
  const child = createConversationChildChannel({ dispatcher: { disconnect: async () => {} }, endpoint: endpoints[1], versionId: null })
  t.after(async () => { child.close(); await parent.drainIncoming(); parent.reaped() })
  const lines = [], write = process.stderr.write
  process.stderr.write = chunk => { lines.push(String(chunk)); return true }
  try {
    const refused = child.diagnostic({ code: 'CONVERSATION_BACKGROUND_FAILED' })
    assert.deepEqual(await refused, { acknowledged: true })
    assert.deepEqual(await refused.completion, { acknowledged: true })
    const corruption = { code: 'MESSAGE_LOG_INVALID', line: 2, offset: 10, length: 3, reason: 'syntax' }
    assert.deepEqual(await child.diagnostic(corruption), { acknowledged: true })
  } finally { process.stderr.write = write }
  assert.deepEqual(lines.map(line => JSON.parse(line)),
    [{ code: 'CONVERSATION_DIAGNOSTIC_UNRECORDED', reportCode: 'CONVERSATION_BACKGROUND_FAILED', reason: 'DIAGNOSTIC_INVALID' }])
  assert.deepEqual(diagnostics.list().map(row => [row.category, row.module]), [['MESSAGE_LOG_INVALID', 'conversation']])
})
