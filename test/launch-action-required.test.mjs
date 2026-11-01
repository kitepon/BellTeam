import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AitermClient, AitermTransport } from '../src/aiterm-transport.mjs'
import { launchFailureDetails } from '../src/agent-launch-error.mjs'
import { diagnosticRequestContext } from '../src/diagnostic-request-context.mjs'
import { ERROR_META } from '../src/execution-bridge.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'
import { BellTeamMessenger } from '../src/messenger.mjs'
import { RoomMessenger } from '../src/room-messenger.mjs'

const args = () => ({ harness: 'antigravity-cli', session_name: 'bot-a', trust_project: true })
const launch = () => ({ schema: 'aiterm.agent-launch-result.v1', provider: 'antigravity', harness: 'antigravity-cli',
  session_id: 'bot-a', managed_completion: true, event_cursor: null, wait_process: null, wait_command: null,
  submit_residue: null, startup: { status: 'blocked', reason: 'vendor_action_required' },
  initial_prompt: { status: 'not_requested', reason: 'not_requested', turn_started: false } })
const safe = { harness: 'antigravity-cli', session_created: true,
  startup: { status: 'blocked', reason: 'vendor_action_required' },
  initial_prompt: { status: 'not_requested', reason: 'not_requested', turn_started: false } }
const rejected = value => ({ isError: true, content: [{ type: 'text', text: 'private-ui Bearer private-token' }], structuredContent: value })
async function failure(value = launch(), input = args(), name = 'agent_launch', meta) {
  const client = new AitermClient()
  let calls = 0
  client.client = { async callTool() { calls++; return { ...rejected(value), ...(meta ? { _meta: meta } : {}) } } }
  const error = await client.call(name, input).catch(error => error)
  assert.equal(calls, 1)
  return error
}

test('native unprompted vendor action is a409 input refusal; created session is distinct from unsent body', async () => {
  const native = { ...launch(), screen: 'private-ui', environment: { TOKEN: 'private-token' } }
  const error = await failure(native)
  assert.equal(error.code, 'BOT_INPUT_NOT_READY'); assert.equal(error.status, 409)
  assert.equal(error.aitermResponseReturned, true)
  assert.deepEqual(error.launch, native)
  assert.deepEqual(launchFailureDetails(error), safe)
  assert.match(error.publicMessage, /AIの認証・初期設定/u)
  assert.doesNotMatch(error.publicMessage, /private-|vendor_action_required|Botの画面/u)
  assert.doesNotMatch(error.message + error.stack, /private-/u)
  const context = diagnosticRequestContext({ method: 'POST', url: '/api/deliveries/direct' }, [], error)
  assert.ok(context.includes(`native_launch=${JSON.stringify(safe)}`))
  assert.doesNotMatch(context, /private-|session_created=false|authentication_preflight/u)
})

test('malformed, different-generation or possibly submitted launches never gain an unsent409 classification', async () => {
  const changes = [
    value => { value.schema = 'other' }, value => { value.harness = 'codex-cli' },
    value => { value.session_id = 'other-session' }, value => { value.startup.status = 'ready' },
    value => { value.startup.reason = 'startup_dialog' }, value => { value.startup.reason = 'startup_failed' },
    value => { delete value.initial_prompt }, value => { value.initial_prompt.status = 'started' },
    value => { value.initial_prompt.status = 'submitted_unconfirmed' },
    value => { value.initial_prompt.reason = 'private-reason' },
    value => { value.initial_prompt.turn_started = true }, value => { value.initial_prompt.turn_started = null },
    value => { value.event_cursor = 0 }, value => { delete value.event_cursor },
    value => { value.submit_residue = true }, value => { delete value.submit_residue },
  ]
  for (const change of changes) {
    const value = launch(); change(value)
    const error = await failure(value)
    assert.equal(error.status, undefined); assert.equal(error.code, undefined)
    assert.equal(launchFailureDetails(error), null)
  }
  for (const input of [{ ...args(), prompt: 'private-body' }, { ...args(), prompt: '' },
    { ...args(), image: ['private-image'] }, { ...args(), image: {} },
    { ...args(), throughline_source_session: 'private-source' },
    { ...args(), throughline_supplement_file: 'private-path' },
    { ...args(), session_name: undefined }, { ...args(), harness: 'codex-cli' }]) {
    const error = await failure(launch(), input)
    assert.equal(error.status, undefined); assert.equal(launchFailureDetails(error), null)
  }
  for (const [value, tool] of [[null, 'agent_launch'], [launch(), 'pty_send'], [launch(), 'claude_agent']]) {
    const error = await failure(value, args(), tool)
    assert.equal(error.status, undefined); assert.equal(launchFailureDetails(error), null)
  }
  assert.equal(launchFailureDetails({ launch: launch() }), null)
})

test('existing typed execution uncertainty takes precedence over startup input refusal', async () => {
  for (const effect of ['possible', 'not_started']) {
    const receipt = { schema: 'aiterm.execution-error.v1', code: 'EXECUTION_UNCONFIRMED', effect, follow_up: 'status_only' }
    const error = await failure(launch(), args(), 'agent_launch', { [ERROR_META]: receipt })
    assert.deepEqual(error.executionError, receipt)
    assert.equal(error.status, undefined); assert.equal(error.code, undefined)
    assert.equal(launchFailureDetails(error), null)
  }
})

test('Owner send closes blocked launch once and returns409 without relaunch/body resend or a500 report', async t => {
  const root = await mkdtemp(join(tmpdir(), 'launch-action-required-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const calls = [], client = new AitermClient()
  client.client = { async callTool({ name, arguments: input }) {
    calls.push({ name, args: input })
    if (name === 'pty_send') return { isError: true, content: [{ type: 'text', text: 'SESSION_NOT_FOUND' }] }
    if (name === 'pty_list') return { content: [{ type: 'text', text: '(セッション無し)' }] }
    if (name === 'agent_launch') return rejected(launch())
    if (name === 'pty_close') return { structuredContent: { outcome: 'closed' } }
    throw new Error(`unexpected tool ${name}`)
  } }
  // All MCP calls stay in the fixture; environment handoff never spawns a real CLI.
  const transport = new AitermTransport({ client: { call: (name, input) => client.call(name, input) }, handoffContext: async () => '' })
  const bot = { id: 'bot-a', name: 'fixture', session: 'bot-a', harness: 'antigravity', project: root }
  const bots = new Map([[bot.id, bot]])
  const messenger = new BellTeamMessenger({ bots, transport, logPath: join(root, 'messages.jsonl') })
  const reports = []
  const server = createBellTeamServer({ bots, transport, messenger, store: messenger.store, authorize: () => true,
    diagnostics: { async record(value) { reports.push(value) } }, writeLog() {} })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bots/bot-a/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'synthetic owner body' }) })
  assert.equal(response.status, 409)
  const body = await response.json()
  assert.equal(body.error, 'BOT_INPUT_NOT_READY'); assert.match(body.message, /送信されませんでした。AIの認証・初期設定/u)
  assert.deepEqual(calls.map(call => call.name), ['pty_send', 'pty_list', 'agent_launch', 'pty_close'])
  assert.equal(calls[2].args.prompt, undefined)
  assert.deepEqual(calls[3].args, { session_id: 'bot-a' })
  assert.deepEqual(reports, [])
  await transport.idle(bot.id)
  const rows = (await readFile(join(root, 'messages.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  const failed = rows.find(row => row.delivery === 'failed')
  assert.equal(failed.delivery_id, rows[0].delivery_id)
  assert.deepEqual(failed.native_launch, safe)
  assert.doesNotMatch(JSON.stringify(failed), /private-|synthetic owner body|bot-a|session_id/u)
  assert.equal(transport.active.size, 0)
})

test('direct and room failures persist only safe startup enums on the existing failed record', async t => {
  const error = await failure({ ...launch(), screen: 'private-ui', argv: ['private-argument'] })
  const root = await mkdtemp(join(tmpdir(), 'launch-enum-record-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const direct = new BellTeamMessenger({ bots: new Map(), transport: {}, logPath: join(root, 'history.jsonl') })
  await direct.appendDeliveryStatus('existing-delivery', 'failed', error)
  const record = JSON.parse((await readFile(join(root, 'history.jsonl'), 'utf8')).trim())
  assert.equal(record.schema, 'bellteam.delivery-status.v1'); assert.deepEqual(record.native_launch, safe)
  const bot = { id: 'bot-a', name: 'fixture' }, room = { id: 'room-a', name: 'fixture', memberIds: [bot.id] }
  const records = [], rooms = new Map([[room.id, room]])
  rooms.messages = async () => records; rooms.appendMessage = async (_id, value) => records.push(value)
  const messenger = new RoomMessenger({ rooms, bots: new Map([[bot.id, bot]]), automaticRouting: () => false,
    roomTurns: async () => [], transport: { async notify(_bot, _text, { onStatus }) { await onStatus('failed', error); throw error } } })
  await messenger.sendroommessage({ from: 'user', room: room.id, message: 'private-body', targets: [bot.id] })
  const failed = records.find(row => row.delivery === 'failed')
  assert.deepEqual(failed.native_launch, safe)
  assert.equal(failed.message_id, records[0].id); assert.equal(failed.target, bot.id)
  assert.doesNotMatch(JSON.stringify([record, failed]), /private-|session_id|argv|screen/u)
})
