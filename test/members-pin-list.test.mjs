import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createBellTeamServer } from '../src/http-server.mjs'

// a480: GET /api/bots lists pinned Bots first by pin time, then the rest in the registry's order; pinned/pinnedAt are on every item.
test('a480: pinned Bots come first in pin order, the rest keep their order', async t => {
  const bots = new Map([
    ['bot-a', { id: 'bot-a', harness: 'claude' }],
    ['bot-b', { id: 'bot-b', harness: 'claude', pinnedAt: '2026-11-21T09:30:00.000Z' }],
    ['bot-c', { id: 'bot-c', harness: 'claude' }],
    ['bot-d', { id: 'bot-d', harness: 'claude', pinnedAt: '2026-11-21T09:10:00.000Z' }],
  ])
  bots.refresh = async () => {}
  const server = createBellTeamServer({ bots, rooms: new Map(), transport: { runningBots: async () => new Set() }, store: { timeline: async () => [] }, authorize: async () => true, writeLog() {} })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)))
  const { bots: listed } = await (await fetch(`http://127.0.0.1:${server.address().port}/api/bots`)).json()
  assert.deepEqual(listed.map(bot => bot.id), ['bot-d', 'bot-b', 'bot-a', 'bot-c'])
  assert.deepEqual(listed.map(bot => bot.pinned), [true, true, false, false])
  assert.equal(listed[0].pinnedAt, '2026-11-21T09:10:00.000Z'); assert.equal(listed[2].pinnedAt, null)
})
