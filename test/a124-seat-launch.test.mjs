import assert from 'node:assert/strict'
import test from 'node:test'
import { createSeatLaunchCheck, resolveInternalSeat } from '../src/seat-mcp.mjs'

test('a124: a seat name speaks on the internal listener only with that session\'s current Aiterm launch id', async () => {
  const launch = 'b'.repeat(32), calls = []
  const bots = { has: id => id === 'bot-a', get: id => ({ id }) }
  const transport = { observe: async bot => { calls.push(bot.id); return { session_id: bot.id, exists: true, launch_id: launch } } }
  const check = createSeatLaunchCheck(transport, bots)
  const seat = (headers) => resolveInternalSeat({ headers }, bots, null, check)
  assert.deepEqual(await seat({ 'x-bellteam-seat': 'bot-a', 'x-bellteam-launch-id': launch }), { botId: 'bot-a', fork: null })
  assert.deepEqual(await seat({ 'x-bellteam-seat': 'bot-a', 'x-bellteam-launch-id': launch }), { botId: 'bot-a', fork: null })
  assert.equal(calls.length, 1) // a confirmed pair is cached
  // Forged: the name alone, a wrong launch id, or a session Aiterm says is not running.
  assert.deepEqual(await seat({ 'x-bellteam-seat': 'bot-a' }), { botId: null, fork: null })
  assert.deepEqual(await seat({ 'x-bellteam-seat': 'bot-a', 'x-bellteam-launch-id': 'c'.repeat(32) }), { botId: null, fork: null })
  transport.observe = async () => ({ session_id: 'bot-a', exists: false, launch_id: null })
  assert.deepEqual(await seat({ 'x-bellteam-seat': 'bot-a', 'x-bellteam-launch-id': 'd'.repeat(32) }), { botId: null, fork: null })
  // An unreachable execution is a 503, never an unverified pass.
  transport.observe = async () => { throw new Error('down') }
  await assert.rejects(seat({ 'x-bellteam-seat': 'bot-a', 'x-bellteam-launch-id': 'e'.repeat(32) }), { code: 'EXECUTION_UNAVAILABLE', status: 503 })
  // No check configured (no transport.observe): unchanged behaviour.
  assert.deepEqual(await resolveInternalSeat({ headers: { 'x-bellteam-seat': 'bot-a' } }, bots, null, null), { botId: 'bot-a', fork: null })
})
