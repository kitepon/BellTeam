import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createBellTeamServer } from '../src/http-server.mjs'
import { BotAdministration } from '../src/bot-administration.mjs'

async function patch(t, internal) {
  const bots = new Map([['bot-a', { id: 'bot-a', harness: 'claude', model: 'opus', configurationLocked: true }]])
  bots.readMember = async key => bots.get(key); bots.refresh = async () => {}
  bots.previewUpdate = async (id, changes) => ({ ...bots.get(id), ...changes })
  bots.update = async (id, changes) => { const next = { ...bots.get(id), ...changes }; bots.set(id, next); return next }
  const administration = new BotAdministration({ bots, rooms: {}, writeLog() {}, transport: { async isRunning() { return false } } })
  const server = createBellTeamServer({ bots, administration, store: {}, transport: {}, authorize: async () => true, internal, writeLog() {} })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bots/bot-a`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'haiku' }) })
  return { response, bot: bots.get('bot-a') }
}

test('a312: the seat entrance refuses a locked Bot\'s model change with the plain message; the Owner entrance applies it', async t => {
  const seat = await patch(t, true), body = await seat.response.json()
  assert.equal(seat.response.status, 403)
  assert.equal(body.error, 'BOT_CONFIGURATION_LOCKED'); assert.match(body.message, /固定中/)
  assert.equal(seat.bot.model, 'opus')
  const owner = await patch(t, false)
  assert.equal(owner.response.status, 200); assert.equal(owner.bot.model, 'haiku')
})
