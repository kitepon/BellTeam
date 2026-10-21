import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createBellTeamServer } from '../src/http-server.mjs'
import { createSeatMcp, internalApi, seatExecutionSource, SEAT_HEADER, LAUNCH_HEADER } from '../src/seat-mcp.mjs'
import { writeHarnessConfig } from '../src/harness-config.mjs'
import { RoomMessenger } from '../src/room-messenger.mjs'
import { ExecutionBridge, deliveryExecutionRef, SOURCE_META } from '../src/execution-bridge.mjs'

const bots = () => Object.assign(new Map([['bot-a', { id: 'bot-a', name: 'A', launch_id: 'f'.repeat(32) }], ['bot-b', { id: 'bot-b', name: 'B' }]]), { async refresh() {} })
const headers = (seat, launch) => ({ [SEAT_HEADER.toLowerCase()]: seat, [LAUNCH_HEADER.toLowerCase()]: launch })

test('sourceは受信ヘッダーの世代だけを保持し、欠測をBot名や最新jobから補完しない', () => {
  for (const value of [undefined, '${AITERM_AGENT_LAUNCH_ID}', '${env:AITERM_AGENT_LAUNCH_ID}', 'bad', ['a'.repeat(32)]]) {
    assert.deepEqual(seatExecutionSource({ headers: headers('bot-a', value) }, bots()),
      { sourceSession: 'bot-a', source: { launch: null, boundary: null } })
  }
  assert.deepEqual(seatExecutionSource({ headers: headers('bot-a', 'a'.repeat(32)) }, bots()),
    { sourceSession: 'bot-a', source: { launch: { session_id: 'bot-a', launch_id: 'a'.repeat(32) }, boundary: null } })
})

test('同時MCP要求のsourceを混ぜず、モデル引数で受信時のsourceを書き換えられない', async t => {
  const registry = bots(), deliveries = [], registrations = []
  const bridge = new ExecutionBridge({ async call(name, args, options) {
    registrations.push({ name, args: structuredClone(args), meta: structuredClone(options.meta) })
    return { structuredContent: { schema: 'aiterm.execution-record.v1', reservation: args.reservation,
      source: { status: 'unknown', reason: 'caller_unbound', point: null, boundary_status: 'missing' },
      relation: { request: args.reservation.request, target: null, phase: 'reserved', completion: 'open', target_fence: 'unknown', lifecycle: 'tracking' } } }
  } })
  const seatMcp = createSeatMcp({ bots: registry, tools: { registry }, toolsForSource: source => ({
    deliverMessage: async value => {
      await new Promise(r => setImmediate(r))
      deliveries.push({ value, source })
      await bridge.reserve({ request: deliveryExecutionRef(`synthetic-${value.message}`, value.target),
        sourceSession: source.sourceSession, source: source.source, targetSession: value.target }, {
        sourceContext: source.source.launch ? source.source : null,
      })
      return { delivery: 'running' }
    },
  }) })
  const server = createBellTeamServer({ bots: registry, internal: true, authorize: () => true, seatMcp, messenger: {}, store: {}, transport: {}, writeLog: () => {} })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const connect = async (seat, id) => {
    const client = new Client({ name: 'synthetic', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`),
      { requestInit: { headers: { [SEAT_HEADER]: seat, [LAUNCH_HEADER]: id } } }))
    t.after(() => client.close()); return client
  }
  const [a, b] = await Promise.all([connect('bot-a', 'a'.repeat(32)), connect('bot-b', 'b'.repeat(32))])
  await assert.rejects(a.callTool({ name: 'sendmessage', arguments: { target: 'bot-b', message: 'forged', executionSource: { sourceSession: 'forged' } } }), /TOOL_ARGUMENT_INVALID/u)
  await Promise.all([a.callTool({ name: 'sendmessage', arguments: { target: 'bot-b', message: 'A' } }),
    b.callTool({ name: 'sendmessage', arguments: { target: 'bot-a', message: 'B' } })])
  for (const item of deliveries) {
    const expected = item.value.message.toLowerCase()
    assert.equal(item.source.sourceSession, `bot-${expected}`)
    assert.equal(item.source.source.launch.launch_id, expected.repeat(32))
    assert.equal(item.source.source.boundary, null)
  }
  assert.equal(deliveries.length, 2)
  assert.equal(registrations.length, 2)
  for (const registration of registrations) {
    const expected = registration.args.reservation.request.delivery_id.slice(-1).toLowerCase()
    assert.deepEqual(registration.meta[SOURCE_META], { schema: 'aiterm.execution-source.v1',
      source: { launch: { session_id: `bot-${expected}`, launch_id: expected.repeat(32) }, boundary: null } })
  }
})

test('内部APIでは受信時sourceを配送とroomへ結び、入力内の偽sourceより優先する', async () => {
  const source = seatExecutionSource({ headers: headers('bot-a', 'a'.repeat(32)) }, bots()), sent = []
  const api = internalApi(123, async (url, options) => { sent.push({ url, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({}) } }, { executionSource: source })
  await api.deliverMessage({ from: 'bot-a', target: 'bot-b', message: 'fixture', executionSource: { sourceSession: 'forged' } })
  await api.deliverRoomMessage({ from: 'bot-a', room: 'room-a', message: 'fixture' })
  assert.equal(sent.length, 2)
  for (const item of sent) assert.deepEqual(item.body.executionSource, source)
})

test('4CLI設定はruntime変数を動的に輸送し、生成時の世代を埋め込まない', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-source-config-')); t.after(() => rm(root, { recursive: true, force: true }))
  await writeHarnessConfig(new Map(), root, { environment: { AITERM_SESSION_ID: 'wrong-seat', AITERM_AGENT_LAUNCH_ID: 'd'.repeat(32) } })
  const paths = ['.codex/config.toml', '.grok/config.toml', '.claude.json', '.cursor/mcp.json']
  for (const path of paths) {
    const content = await readFile(join(root, path), 'utf8')
    assert.match(content, /X-Bellteam-Launch-Id/u); assert.match(content, /AITERM_AGENT_LAUNCH_ID/u)
    assert.doesNotMatch(content, /dddddddddddddddddddddddddddddddd|wrong-seat/u)
  }
})

test('roomの返信者以外を含む全fanoutへ同じsourceと既存message参照を渡す', async () => {
  const registry = bots(), room = { id: 'room-a', name: 'fixture', memberIds: ['bot-a', 'bot-b'] }, rooms = new Map([[room.id, room]])
  const sent = [], source = seatExecutionSource({ headers: headers('bot-a', 'a'.repeat(32)) }, registry)
  rooms.appendMessage = async () => {}
  const messenger = new RoomMessenger({ bots: registry, rooms, messageId: () => 'message-1', roomTurns: async () => [],
    transport: { async notify(bot, text, options) { sent.push({ bot, options }); return { delivery: 'running' } } },
  })
  await messenger.sendroommessage({ from: 'bot-a', room: room.id, message: 'fixture', targets: ['bot-b'], executionSource: source })
  assert.deepEqual(sent.map(item => item.bot.id), ['bot-a', 'bot-b'])
  for (const item of sent) { assert.deepEqual(item.options.executionSource, source); assert.equal(item.options.queue.groupId, 'message-1') }
})
