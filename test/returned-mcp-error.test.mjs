import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AitermClient, AitermTransport } from '../src/aiterm-transport.mjs'
import { BellTeamMessenger } from '../src/messenger.mjs'
import { Diagnostics } from '../src/diagnostics.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'
import { RoomMessenger } from '../src/room-messenger.mjs'
import { diagnosticRequestContext } from '../src/diagnostic-request-context.mjs'

test('返却済みMCP拒否をHTTP診断と同じ配送の失敗へ残す', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-returned-error-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const nativeMessage = 'aiterm: 送信文字列が65536 bytesを超えています（191813 bytes）'
  const client = new AitermClient()
  client.client = { async callTool() { return { isError: true, content: [{ type: 'text', text: nativeMessage }] } } }
  const transport = new AitermTransport({ client })
  transport.dispatchInOrder = async () => client.call('pty_send', { session_id: 'fixture', text: 'private-notification' })
  const bot = { id: 'bot-a', name: 'fixture', session: 'fixture', harness: 'codex', project: root }
  const bots = new Map([[bot.id, bot]])
  const messenger = new BellTeamMessenger({ bots, transport, logPath: join(root, 'messages.jsonl') })
  const diagnostics = new Diagnostics(join(root, 'diagnostics.json'))
  await diagnostics.initialize()
  const old = await diagnostics.record({ code: 'SERVER_HTTP_500', module: 'server', diagnostic_log: 'legacy row' })
  const server = createBellTeamServer({ bots, transport, messenger, diagnostics, authorize: () => true })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/deliveries/direct`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: bot.id, target: bot.id, message: 'private-notification' }),
  })
  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), { error: 'INTERNAL_ERROR', message: nativeMessage })
  const rows = (await readFile(join(root, 'messages.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  const failed = rows.find(row => row.delivery === 'failed')
  assert.deepEqual(failed.mcp_error, { tool: 'pty_send', message: nativeMessage, truncated: false })
  assert.equal(failed.delivery_id, rows[0].delivery_id)
  assert.equal(JSON.stringify(failed).includes('private-notification'), false)
  const log = diagnostics.list().find(row => row.fingerprint !== old.fingerprint).diagnostic_log
  assert.ok(log.includes(`mcp_error=${JSON.stringify(failed.mcp_error)}`))
  assert.equal(log.includes('private-notification'), false)
  assert.deepEqual(diagnostics.list().find(row => row.fingerprint === old.fingerprint), old)
  await transport.idle(bot.id)
  assert.equal(transport.active.size, 0)
})

test('配送のMCP返却文から入力と秘密を除き、authと応答欠測を混ぜない', async () => {
  const client = new AitermClient()
  let text = '拒否 private-input Bearer private-token api_key=private-key Basic private-basic "access_token":"private-access" https://user:private-pass@example.test/\nerror_code=ECONNRESET'
  client.client = { async callTool() { return { isError: true, content: [{ type: 'text', text }] } } }
  const error = await client.call('pty_send', { text: 'private-input' }).catch(error => error)
  assert.equal(error.aitermResponseReturned, true)
  assert.equal(JSON.stringify(error.mcp_error).includes('private-'), false)
  assert.equal(error.message.includes('private-'), false)
  assert.equal(error.mcp_error.truncated, false)
  const context = diagnosticRequestContext({ method: 'POST', url: '/api/deliveries/direct' }, [], error)
  assert.deepEqual(context.split('\n').filter(line => line.startsWith('error_code=')), ['error_code=unknown'])
  text = 'x'.repeat(5000)
  const long = await client.call('agent_execution', { action: 'invoke', input: { prompt: 'private-input' } }).catch(error => error)
  assert.equal(long.mcp_error.message.length, 4096)
  assert.equal(long.mcp_error.truncated, true)
  const read = await client.call('pty_list', {}).catch(error => error)
  assert.equal(read.mcp_error.tool, 'pty_list')
  const auth = await client.call('agent_launch', { prompt: 'private-input' }).catch(error => error)
  assert.equal(auth.mcp_error, undefined)
  client.client.callTool = async () => { throw new Error('RPC response missing') }
  const missing = await client.call('pty_send', {}).catch(error => error)
  assert.equal(missing.mcp_error, undefined)
  assert.equal(missing.aitermResponseReturned, undefined)
})

test('ルームも同じ対象の失敗記録だけに返却済みMCP拒否を結ぶ', async () => {
  const client = new AitermClient()
  client.client = { async callTool() { return { isError: true, content: [{ type: 'text', text: 'native refusal' }] } } }
  const error = await client.call('pty_send', { text: 'private-input' }).catch(error => error)
  const bot = { id: 'bot-a', name: 'fixture' }, room = { id: 'room-a', name: 'fixture', memberIds: [bot.id] }
  const records = [], rooms = new Map([[room.id, room]])
  rooms.messages = async () => records
  rooms.appendMessage = async (_id, record) => records.push(record)
  const messenger = new RoomMessenger({ rooms, bots: new Map([[bot.id, bot]]), automaticRouting: () => false,
    roomTurns: async () => [], transport: { async notify(_bot, _text, { onStatus }) { await onStatus('failed', error); throw error } } })
  await messenger.sendroommessage({ from: 'user', room: room.id, message: 'private-input', targets: [bot.id] })
  const failed = records.find(row => row.delivery === 'failed')
  assert.deepEqual(failed.mcp_error, error.mcp_error)
  assert.equal(failed.target, bot.id)
  assert.equal(failed.message_id, records[0].id)
})

for (const { name, text, args, markers } of [
  { name: 'escaped multiline input', text: 'aiterm: invalid ' + JSON.stringify({ text: 'PRIVATE_LINE_A\nPRIVATE_LINE_B' }),
    args: { text: 'PRIVATE_LINE_A\nPRIVATE_LINE_B' }, markers: ['PRIVATE_LINE_A', 'PRIVATE_LINE_B'] },
  { name: 'quoted secret with whitespace', text: 'aiterm: password="PRIVATE_FIRST PRIVATE_SECOND"',
    args: { session_id: 'fixture' }, markers: ['PRIVATE_FIRST', 'PRIVATE_SECOND'] },
]) test(`${name} is absent from every returned-error persistence boundary`, async t => {
  const client = new AitermClient()
  client.client = { async callTool() { return { isError: true, content: [{ type: 'text', text }] } } }
  const error = await client.call('pty_send', args).catch(error => error)
  const root = await mkdtemp(join(tmpdir(), 'bellteam-private-error-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const messenger = new BellTeamMessenger({ bots: new Map(), transport: {}, logPath: join(root, 'history.jsonl') })
  await messenger.appendDeliveryStatus('existing-delivery', 'failed', error)
  const bots = new Map(); bots.refresh = async () => { throw error }
  const server = createBellTeamServer({ bots, authorize: () => true })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bots`)
  assert.equal(response.status, 500)
  const values = [error.message, error.publicMessage, JSON.stringify(error.mcp_error),
    diagnosticRequestContext({ method: 'GET', url: '/api/bots' }, [], error),
    await readFile(join(root, 'history.jsonl'), 'utf8'), JSON.stringify(await response.json())]
  for (const value of values) for (const marker of markers) assert.equal(value.includes(marker), false)
})
