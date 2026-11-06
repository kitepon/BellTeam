import test from 'node:test'
import assert from 'node:assert/strict'
import { callBellTeamTool } from '../src/mcp-tools.mjs'

test('direct send tools reach the receiver despite unavailable Room reads and still validate the sender', async () => {
  let refreshes = 0, roomReads = 0
  const registry = Object.assign(new Map([
    ['bot-a', { id: 'bot-a', name: 'A' }], ['bot-b', { id: 'bot-b', name: 'B' }],
  ]), { async refresh() { refreshes++ } })
  const calls = []
  const receipt = { delivery: 'received', delivery_id: 'same-id' }
  const context = { from: 'bot-a', registry,
    rooms: { async refresh() { roomReads++; throw Object.assign(new Error('unavailable'), { code: 'CONVERSATION_NOT_ACCEPTED' }) } },
    deliverMessage: async input => { calls.push(input); return receipt },
  }
  for (const name of ['sendmessage', 'send_user_message']) {
    assert.deepEqual(await callBellTeamTool({ ...context, name, arguments: { target: 'bot-b', message: 'message' } }), receipt)
  }
  assert.equal(refreshes, 2)
  assert.equal(roomReads, 0)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map(call => call.from), ['bot-a', 'user'])
  assert.ok(calls.every(call => call.target === 'bot-b' && call.message === 'message'))
  await assert.rejects(callBellTeamTool({ ...context, from: 'missing', name: 'sendmessage',
    arguments: { target: 'bot-b', message: 'message' } }), /BOT_NOT_FOUND: missing/u)
  assert.equal(calls.length, 2)
})
