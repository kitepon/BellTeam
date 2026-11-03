import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { callBellTeamTool } from '../src/mcp-tools.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'
import { createSeatMcp, seatExecutionSource, SEAT_HEADER, LAUNCH_HEADER } from '../src/seat-mcp.mjs'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { validateCurrentWork, unknownCurrentWork } from '../src/current-work-contract.mjs'

const work = () => ({ state: 'working', summary: '現在の段階', summaryStatus: 'current', summaryUpdatedAt: '2026-11-03T18:00:00Z', observedAt: '2026-11-03T18:01:00Z', source: 'self_reported' })
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}` }

test('both HTTP lists project only after awaits and Room reuses current participant snapshots', async t => {
  const a = { id: 'bot-a', name: 'Alpha', harness: 'codex', session: 'old' }, b = { id: 'bot-b', name: 'Beta', harness: 'codex' }
  const bots = new Map([[a.id, a], [b.id, b]]); bots.refresh = async () => {}
  const rooms = new Map([['room-a', { id: 'room-a', memberIds: [a.id, b.id] }], ['room-b', { id: 'room-b', memberIds: [a.id] }]])
  rooms.refresh = async () => {}; let mutateRoom = false
  rooms.messages = async id => { if (mutateRoom) { rooms.set('room-a', { id: 'room-a', memberIds: [a.id, a.id, 'bot-absent'] }); rooms.delete('room-b') }; return [] }
  let legacyOnlineReads = 0, projections = []
  const transport = { runningBots: async () => { legacyOnlineReads++; return new Set([a.id]) }, currentWork: bot => { projections.push(bot.id); assert.equal(bot.session, 'new'); return work() } }
  const server = createBellTeamServer({ bots, rooms, transport, store: { async timeline() { bots.set(a.id, { ...a, session: 'new' }); bots.delete(b.id); return [] } }, authorize: async () => true, writeLog() {} })
  const base = await listen(server); t.after(() => new Promise(resolve => server.close(resolve)))
  const listed = await (await fetch(base + '/api/bots?avatar=omit')).json()
  assert.deepEqual(listed.bots.map(bot => bot.id), [a.id]); assert.deepEqual(listed.bots[0].currentWork, work()); assert.equal(legacyOnlineReads, 1)
  assert.equal(Object.hasOwn(listed.bots[0].currentWork, 'revision'), false)
  projections = []; const roomList = await (await fetch(base + '/api/rooms')).json()
  assert.deepEqual(projections, [a.id]); assert.equal(roomList.rooms.length, 2)
  assert.deepEqual(roomList.rooms[0].currentWork, { scope: 'participants', members: [{ botId: a.id, currentWork: work() }] })
  mutateRoom = true; projections = []
  const fresh = await (await fetch(base + '/api/rooms')).json()
  assert.equal(fresh.rooms.length, 1); assert.equal(fresh.rooms[0].currentWork.members.length, 1); assert.deepEqual(projections, [a.id])
  assert.equal(legacyOnlineReads, 1)
})

test('missing or invalid current-work data stays unknown without exposing provider metadata', async t => {
  const bot = { id: 'bot-a' }, bots = new Map([[bot.id, bot]]); bots.refresh = async () => {}
  const rooms = new Map(); rooms.refresh = async () => {}
  const server = createBellTeamServer({ bots, rooms, transport: { runningBots: async () => new Set(), currentWork: () => ({ ...work(), revision: 'private' }) }, store: { timeline: async () => [] }, authorize: async () => true, writeLog() {} })
  const base = await listen(server); t.after(() => new Promise(resolve => server.close(resolve)))
  const result = await (await fetch(base + '/api/bots')).json()
  assert.deepEqual(result.bots[0].currentWork, unknownCurrentWork()); assert.equal(validateCurrentWork(result.bots[0].currentWork).valid, true)
})

test('real transport and seat MCP share actor binding, updates, typed failures and existing observer only', async t => {
  const bot = { id: 'bot-a', harness: 'codex', session: 'bot-a' }, launch = 'a'.repeat(32), calls = []
  const bots = new Map([[bot.id, bot]]); bots.refresh = async () => {}
  const transport = new AitermTransport({ client: { async call(name) { calls.push(name); assert.equal(name, 'pty_list'); return { _meta: { 'aiterm/seat_turns': { schema: 'aiterm.seat-turns.v1', seats: [{ session_id: bot.id, launch_id: launch, harness: 'codex-cli', turn: { state: 'running', turn_id: 'turn-a', event_cursor: 10, wait_process: { executable: 'synthetic', args: [] } } }] } } } } } })
  await transport.seatTurns([bot])
  let accepted
  const began = new Promise(resolve => { accepted = resolve })
  const seat = createSeatMcp({ bots, tools: { registry: bots }, toolsForSource: source => ({
    currentWork: bot => transport.currentWork(bot), currentWorkBinding: bot => transport.currentWorkBinding(bot, source),
    updateWorkSummary: (bot, input) => { const pending = transport.updateWorkSummary(bot, input, source); accepted(); return pending },
  }) })
  const server = createServer((request, response) => seat(request, response, new URL(request.url, 'http://fixture')))
  const base = await listen(server), clients = []
  t.after(async () => { for (const client of clients) await client.close(); await seat.close(); await transport.close(); await new Promise(resolve => server.close(resolve)) })
  async function connect(launchId) {
    const client = new Client({ name: 'fixture', version: '1' }); clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { [SEAT_HEADER]: bot.id, [LAUNCH_HEADER]: launchId } } })); return client
  }
  const client = await connect(launch), self = JSON.parse((await client.callTool({ name: 'get_self', arguments: {} })).content[0].text).bot
  assert.equal(self.currentWork.state, 'working'); assert.equal(self.currentWorkBinding.launchId, launch); assert.deepEqual(calls, ['pty_list'])
  const other = JSON.parse((await client.callTool({ name: 'get_bot', arguments: { botId: bot.id } })).content[0].text).bot
  assert.equal(Object.hasOwn(other, 'currentWorkBinding'), false)
  const pending = client.callTool({ name: 'update_work_summary', arguments: { expected: self.currentWorkBinding, summary: ' 段階を更新 ' } })
  await began; assert.deepEqual(calls, ['pty_list']); await transport.seatTurns([bot])
  const result = JSON.parse((await pending).content[0].text)
  assert.equal(result.currentWork.summary, '段階を更新'); assert.notEqual(result.currentWorkBinding.revision, self.currentWorkBinding.revision)
  for (const [input, code, status] of [[{ expected: result.currentWorkBinding, summary: 'x', botId: bot.id }, 'CURRENT_WORK_INPUT_INVALID', 400],
    [{ expected: self.currentWorkBinding, summary: 'x' }, 'CURRENT_WORK_CONFLICT', 409]]) {
    const error = await client.callTool({ name: 'update_work_summary', arguments: input }); assert.equal(error.isError, true); assert.deepEqual(error.structuredContent, { error: code, status })
  }
  const forged = await connect('b'.repeat(32))
  const error = await forged.callTool({ name: 'update_work_summary', arguments: { expected: result.currentWorkBinding, summary: 'x' } })
  assert.equal(error.isError, true); assert.deepEqual(error.structuredContent, { error: 'CURRENT_WORK_FORBIDDEN', status: 403 })
  await transport.close()
  const unavailable = await client.callTool({ name: 'update_work_summary', arguments: { expected: result.currentWorkBinding, summary: 'x' } })
  assert.equal(unavailable.isError, true); assert.deepEqual(unavailable.structuredContent, { error: 'CURRENT_WORK_UNAVAILABLE', status: 503 })
  assert.deepEqual(calls, ['pty_list', 'pty_list'])
  assert.deepEqual(seatExecutionSource({ headers: { 'x-bellteam-seat': bot.id, 'x-bellteam-launch-id': launch } }, bots).source.launch, { session_id: bot.id, launch_id: launch })
})


test('member retirement during the common MCP await rejects before the self writer', async () => {
  const bots = new Map([['bot-a', { id: 'bot-a' }]])
  bots.refresh = async () => {}
  let updates = 0
  await assert.rejects(callBellTeamTool({ name: 'update_work_summary', arguments: { expected: {}, summary: 'x' }, from: 'bot-a', registry: bots,
    rooms: { refresh: async () => { bots.delete('bot-a') } }, updateWorkSummary: async () => { updates++ } }), { code: 'CURRENT_WORK_FORBIDDEN', status: 403 })
  assert.equal(updates, 0)
})
