import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { AitermClient, createManagedTransport } from '../src/aiterm-transport.mjs'
import { AiControl, stopRegisteredWork } from '../src/ai-control.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'

// Real HTTP, AiControl, transport and MCP SDK; native pause/key are synthetic.
// This verifies BellTeam's ownership, not a real harness interruption.
async function fixture(t, pauseStatus = 'paused') {
  const bot = { id: 'bot-a', session: 'fixture-goal-seat' }, calls = []
  let resolvePause
  const pause = new Promise(resolve => { resolvePause = resolve })
  let nativeGoal = 'active', keys = 0, commands = 0
  const server = new Server({ name: 'synthetic-goal-stop', version: '1' }, { capabilities: { tools: {} } })
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    calls.push(structuredClone(params))
    assert.equal(params.name, 'agent_stop')
    if (params.arguments.pause_goals) {
      assert.deepEqual(params._meta, { 'aiterm/goal': { origin: 'user' } })
      await pause
      if (pauseStatus === 'paused') nativeGoal = 'paused'
    } else assert.equal(params._meta, undefined)
    keys++
    return { content: [], structuredContent: { status: 'sent', targets: [{ session_id: bot.session, status: 'sent',
      ...(params.arguments.pause_goals && pauseStatus !== 'missing' ? { goal_pause: pauseStatus } : {}),
    }] } }
  })
  const sdk = new Client({ name: 'bellteam', version: 'fixture' })
  const [left, right] = InMemoryTransport.createLinkedPair()
  await server.connect(left); await sdk.connect(right)
  const client = new AitermClient({ command: 'must-not-spawn', env: {} }); client.client = sdk
  const transport = createManagedTransport({ client }), bots = new Map([[bot.id, bot]])
  const directory = await mkdtemp(join(tmpdir(), 'goal-global-stop-'))
  const aiControl = new AiControl({ path: join(directory, 'control.json'), stopAll: () => stopRegisteredWork({ bots, transport,
    scheduler: { interruptCommands() { commands++; return true } },
  }) })
  await aiControl.initialize()
  const http = createBellTeamServer({ bots, rooms: new Map(), transport, aiControl, store: {}, writeLog() {},
    authorize: async request => request.headers.authorization === 'synthetic-owner',
  })
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  t.after(async () => {
    resolvePause(); await aiControl.enforcement
    http.closeAllConnections(); await new Promise(resolve => http.close(resolve))
    await sdk.close(); await server.close(); await rm(directory, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${http.address().port}`
  const toggle = paused => fetch(base + '/api/ai-control', { method: 'PATCH', headers: { authorization: 'synthetic-owner', 'content-type': 'application/json' }, body: JSON.stringify({ paused }) })
  return { bot, aiControl, transport, calls, toggle, resolvePause,
    state: () => ({ nativeGoal, keys, commands }),
    stopTurn: () => fetch(base + '/api/bots/bot-a/stop', { method: 'POST', headers: { authorization: 'synthetic-owner' } }),
  }
}

test('global pause closes admission before native wait, preserves barriers and pauses goal; ON never resumes it', async t => {
  const f = await fixture(t)
  assert.equal((await f.toggle(true)).status, 202)
  assert.throws(() => f.aiControl.admit(), { code: 'AI_GLOBAL_PAUSED' })
  assert.ok(f.transport.stopVersions.get(f.bot.id) > 0)
  assert.equal(f.state().commands, 1)
  assert.equal(f.state().keys, 0)
  f.resolvePause(); await f.aiControl.enforcement
  assert.equal(f.aiControl.snapshot().state, 'stopped')
  assert.deepEqual(f.state(), { nativeGoal: 'paused', keys: 1, commands: 1 })
  assert.equal((await f.toggle(false)).status, 200)
  assert.equal(f.calls.length, 1)
  assert.equal(f.state().nativeGoal, 'paused')
})

test('ordinary conversation stop sends its existing key request and does not pause goal continuation', async t => {
  const f = await fixture(t)
  assert.equal((await f.stopTurn()).status, 202)
  assert.deepEqual(f.calls[0].arguments, { session_id: f.bot.session })
  assert.deepEqual(f.state(), { nativeGoal: 'active', keys: 1, commands: 0 })
})

test('accepted key with unknown or unsupported goal pause stays globally unconfirmed without resend', async t => {
  for (const status of ['outcome_unknown', 'unsupported']) {
    const f = await fixture(t, status)
    await f.toggle(true); f.resolvePause(); await f.aiControl.enforcement
    assert.equal(f.aiControl.snapshot().state, 'unconfirmed')
    assert.deepEqual(f.aiControl.snapshot().unconfirmedBotIds, [f.bot.id])
    assert.equal(f.calls.length, 1)
    assert.equal(f.state().keys, 1)
    assert.throws(() => f.aiControl.admit(), { code: 'AI_GLOBAL_PAUSED' })
  }
})

test('old key-only response cannot satisfy newly requested global goal pause', async t => {
  const f = await fixture(t, 'missing')
  await f.toggle(true); f.resolvePause(); await f.aiControl.enforcement
  assert.equal(f.aiControl.snapshot().state, 'unconfirmed')
  assert.deepEqual(f.aiControl.snapshot().unconfirmedBotIds, [f.bot.id])
  assert.equal(f.calls.length, 1)
  assert.equal(f.state().keys, 1)
})
