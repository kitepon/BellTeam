import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { AitermClient, createManagedTransport } from '../src/aiterm-transport.mjs'
import { AiControl, stopRegisteredWork } from '../src/ai-control.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'

// The SDK and production transport/HTTP entry are real. Tool responses are
// synthetic contract fixtures; these tests do not prove native interruption.
async function fixture(t, mode) {
  const bot = { id: 'bot-a', session: 'bot-a' }
  const launch = { session_id: bot.session, launch_id: 'a'.repeat(32) }
  const calls = []
  const server = new Server({ name: 'synthetic-interruption', version: '1' }, { capabilities: { tools: {} } })
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params
    calls.push({ name, args: structuredClone(args) })
    if (name === 'agent_execution_roots') return { content: [], structuredContent: {
      schema: 'aiterm.execution-roots.v1', session_id: bot.session, observation: 'present',
      current: launch, roots: [launch], relation_coverage: 'complete', unresolved: [],
    } }
    assert.equal(name, 'agent_stop', 'stop must not issue close or raw key fallback')
    assert.deepEqual(args, { schema: 'aiterm.cascade-stop-request.v2', mode: 'interrupt', roots: [launch] })
    if (mode === 'unsupported') return { isError: true, content: [{ type: 'text', text: 'unsupported' }] }
    const confirmed = mode === 'confirmed'
    return { content: [], structuredContent: {
      schema: 'aiterm.cascade-stop-result.v2', mode: 'interrupt', roots: [launch],
      status: confirmed ? 'confirmed' : 'unconfirmed', relation_coverage: confirmed ? 'complete' : 'incomplete',
      unresolved: confirmed ? [] : [{ reason: 'native_interruption_unconfirmed' }],
      targets: [{ launch, run: { launch, boundary: { event_cursor: 1, operation_id: null, turn_id: 'fixture-turn', steer_id: null } },
        key: 'Escape', key_receipt: 'accepted', interruption: confirmed ? 'interrupted' : 'unconfirmed',
        session_preserved: confirmed ? 'confirmed' : 'unconfirmed', reason: 'synthetic' }],
    } }
  })
  const sdk = new Client({ name: 'bellteam', version: 'synthetic' })
  const [left, right] = InMemoryTransport.createLinkedPair()
  await server.connect(left)
  await sdk.connect(right)
  t.after(async () => { await sdk.close(); await server.close() })
  const client = new AitermClient({ command: 'must-not-spawn', env: {} })
  client.client = sdk
  const transport = createManagedTransport({ client })
  const bots = new Map([[bot.id, bot]])
  return { bot, bots, transport, calls }
}

async function http(t, options) {
  const server = createBellTeamServer({ ...options, authorize: async () => true })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  return `http://127.0.0.1:${server.address().port}`
}

test('supervisor transport routes individual HTTP stop through the shared SDK v2 control', async t => {
  const f = await fixture(t, 'confirmed')
  const base = await http(t, f)
  const response = await fetch(`${base}/api/bots/bot-a/stop`, { method: 'POST' })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { botId: 'bot-a', status: 'interrupted', sessionPreserved: true })
  assert.deepEqual(f.calls.map(c => c.name), ['agent_execution_roots', 'agent_stop'])
  assert.equal(f.transport.session(f.bot), 'bot-a')
})

test('supervisor transport reports native control unsupported without legacy close fallback', async t => {
  const f = await fixture(t, 'unsupported')
  const base = await http(t, f)
  const response = await fetch(`${base}/api/bots/bot-a/stop`, { method: 'POST' })
  assert.equal(response.status, 502)
  assert.equal((await response.json()).error, 'BOT_STOP_UNCONFIRMED')
  assert.deepEqual(f.calls.map(c => c.name), ['agent_execution_roots', 'agent_stop'])
})

test('global HTTP pause keeps admission blocked when the connected SDK only acknowledges Escape', async t => {
  const f = await fixture(t, 'unconfirmed')
  const directory = await mkdtemp(join(tmpdir(), 'managed-pause-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const aiControl = new AiControl({ path: join(directory, 'control.json'),
    stopAll: () => stopRegisteredWork({ ...f, scheduler: { interruptCommands: async () => true } }),
  })
  await aiControl.initialize()
  const base = await http(t, { ...f, aiControl })
  const response = await fetch(`${base}/api/ai-control`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"paused":true}' })
  assert.equal(response.status, 202)
  await aiControl.enforcement
  const state = (await (await fetch(`${base}/api/ai-control`)).json()).control
  assert.equal(state.paused, true)
  assert.equal(state.state, 'unconfirmed')
  assert.deepEqual(state.unconfirmedBotIds, ['bot-a'])
  assert.throws(() => aiControl.admit(), { code: 'AI_GLOBAL_PAUSED' })
  assert.deepEqual(f.calls.map(c => c.name), ['agent_execution_roots', 'agent_stop'])
})
