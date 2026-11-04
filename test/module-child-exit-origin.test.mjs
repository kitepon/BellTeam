import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { observeModuleChild, reportConversationChildExitOrigin } from '../src/module-child-restart.mjs'

const marker = (origin = 'peer_failure', failureCode = 'CONVERSATION_IPC_INVALID') =>
  JSON.stringify({ code: 'CONVERSATION_CHILD_EXIT_ORIGIN', origin, failureCode })
const fixture = () => {
  const stderr = Object.assign(new EventEmitter(), { resume() {} })
  return { stderr, observe: observeModuleChild({ stderr }) }
}

test('origin crosses stderr chunks, keeps the first reason and emits no extra fields', t => {
  const { stderr, observe } = fixture(), raw = marker(), rows = []
  stderr.emit('data', raw.slice(0, 20)); stderr.emit('data', raw.slice(20) + '\n')
  stderr.emit('data', marker('parent_disconnect', null) + '\nprivate body token\n')
  stderr.emit('close')
  t.mock.method(console, 'error', line => rows.push(JSON.parse(line)))
  reportConversationChildExitOrigin(7, observe())
  assert.deepEqual(Object.keys(rows[0]).sort(), ['childSequence', 'code', 'component', 'failureCode', 'observedAt', 'origin'])
  assert.equal(rows[0].origin, 'peer_failure'); assert.equal(rows[0].childSequence, 7)
  assert.equal(rows[0].failureCode, 'CONVERSATION_IPC_INVALID')
  assert.doesNotMatch(JSON.stringify(observe()), /private|body|token/)
})

test('invalid, oversized and truncated markers stay unknown; later whole lines remain readable', t => {
  const { stderr, observe } = fixture()
  for (const line of [marker('arbitrary'), marker('peer_failure', 'secret'), marker().slice(0, -1) + ',"extra":"secret"}', 'x'.repeat(12000) + marker()])
    stderr.emit('data', line + '\n')
  assert.equal(observe().childExitOrigin, null)
  const rows = []
  t.mock.method(console, 'error', line => rows.push(JSON.parse(line)))
  reportConversationChildExitOrigin(1, observe())
  assert.equal(rows[0].origin, 'unknown'); assert.equal(rows[0].failureCode, null)
  stderr.emit('data', marker('exit_writer_control', null) + '\n')
  assert.deepEqual(observe().childExitOrigin, { origin: 'exit_writer_control', failureCode: null })
  t.mock.method(console, 'error', () => { throw Error('sink failed') })
  assert.doesNotThrow(() => reportConversationChildExitOrigin(1, observe()))
})
