import test from 'node:test'
import assert from 'node:assert/strict'
import { forwardConversationWriter } from '../src/conversation-writer.mjs'

test('direct writer handoff drains old writes and retains one notification per forwarded save', async () => {
  const oldWrite = Promise.withResolvers(), events = []
  const writer = { appendQueue: oldWrite.promise, append() {},
    onMessage(record) { events.push(`notify:${record.id}`) } }
  const before = writer
  const handoff = forwardConversationWriter(writer, async record => {
    events.push(`save:${record.id}`)
    if (record.fail) throw new Error('SAVE_FAILED')
  })
  const first = writer.append({ id: 'first' })
  await Promise.resolve()
  assert.deepEqual(events, [])
  oldWrite.resolve()
  await handoff.ready
  await first
  await assert.rejects(writer.append({ id: 'failed', fail: true }), /SAVE_FAILED/)
  await writer.append({ id: 'last' })
  assert.equal(writer, before)
  assert.deepEqual(events, ['save:first', 'notify:first', 'save:failed', 'save:last', 'notify:last'])
  const original = writer.append
  assert.throws(() => forwardConversationWriter(writer, null), { code: 'DIRECT_WRITER_HANDOFF_INVALID' })
  assert.equal(writer.append, original)
})
