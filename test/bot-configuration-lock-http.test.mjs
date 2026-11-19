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

test('a442d: the seat entrance works over the frozen execution facade (restart reached it, update still marked as a Bot\'s)', async t => {
  const bots = new Map([['bot-a', { id: 'bot-a', harness: 'claude', model: 'opus' }]])
  bots.readMember = async key => bots.get(key); bots.refresh = async () => {}
  const calls = []
  // Same shape as createExecutionFacade().administration: a frozen object of plain functions.
  const administration = Object.freeze({
    restart: async bot => { calls.push(['restart', bot.id]); return { session: 'bot-a' } },
    update: async (id, changes, options) => { calls.push(['update', id, options?.actorKind]); return { ...bots.get(id), ...changes } },
    view: bot => bot,
  })
  const server = createBellTeamServer({ bots, administration, store: {}, transport: {}, authorize: async () => true, internal: true, writeLog() {} })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/api/bots/bot-a`
  const restart = await fetch(`${base}/restart`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(restart.status, 200)
  assert.deepEqual(await restart.json(), { restarted: 'bot-a', session: 'bot-a' })
  const update = await fetch(base, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'haiku' }) })
  assert.equal(update.status, 200)
  assert.deepEqual(calls, [['restart', 'bot-a'], ['update', 'bot-a', 'bot']])
})

test('a312: the seat entrance refuses a locked Bot\'s model change with the plain message; the Owner entrance applies it', async t => {
  const seat = await patch(t, true), body = await seat.response.json()
  assert.equal(seat.response.status, 403)
  assert.equal(body.error, 'BOT_CONFIGURATION_LOCKED'); assert.match(body.message, /固定中/)
  assert.equal(seat.bot.model, 'opus')
  const owner = await patch(t, false)
  assert.equal(owner.response.status, 200); assert.equal(owner.bot.model, 'haiku')
})
