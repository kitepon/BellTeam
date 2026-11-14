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

test('a124: the local /mcp ingress refuses a Bot name without that session\'s launch id before the seat MCP runs', async t => {
  const { createBellTeamServer } = await import('../src/http-server.mjs')
  const launch = 'f'.repeat(32), served = []
  const bots = { has: id => id === 'bot-a', get: id => ({ id }), list: () => [] }
  const transport = { observe: async bot => ({ session_id: bot.id, exists: true, launch_id: launch }) }
  const server = createBellTeamServer({ authorize: async () => true, writeLog() {}, bots, transport, internal: true,
    seatMcp: Object.assign(async (request, response) => { served.push(request.headers['x-bellteam-seat']); response.end('{}') }, { close: async () => {} }) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const post = headers => fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' })
  assert.equal((await post({ 'X-Bellteam-Seat': 'bot-a' })).status, 403) // name only: the forged MCP request never reaches the seat MCP
  assert.equal((await post({ 'X-Bellteam-Seat': 'bot-a', 'X-Bellteam-Launch-Id': 'c'.repeat(32) })).status, 403)
  assert.deepEqual(served, [])
  assert.equal((await post({ 'X-Bellteam-Seat': 'bot-a', 'X-Bellteam-Launch-Id': launch })).status, 200)
  assert.equal((await post({ 'X-Bellteam-Seat': 'not-a-bot' })).status, 200) // non-Bot names keep their own path in the seat MCP
  assert.deepEqual(served, ['bot-a', 'not-a-bot'])
})
