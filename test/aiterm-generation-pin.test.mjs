import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createExecutionDispatcher } from '../src/execution-dispatcher.mjs'
import { AitermGenerationClient } from '../src/aiterm-generation-client.mjs'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
const tick = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)) }
const bot = { id: 'bot-synthetic', session: 'bot-synthetic', harness: 'codex', project: '/synthetic' }
const request = (method, ...args) => ({ method, args })
const refs = (facade, generation) => facade.references().find(row => row.generation === generation)?.references

// One injected native fake per generation; every call is recorded with its generation.
function generation(name, calls, extra = () => undefined) {
  return { async call(tool, args = {}, options = {}) {
    calls.push([name, tool, args])
    const value = await extra(tool, args, options)
    if (value !== undefined) return value
    if (tool === 'pty_observe') return { structuredContent: { exists: true, state: 'idle', activity: { cursor: `${name}-cursor` } } }
    if (tool === 'pty_send') return { structuredContent: { mode: 'agent_dispatch', session_id: bot.session,
      vendor: 'codex', launch_id: 'a'.repeat(32), event_cursor: 1, wait_process: { executable: `${name}-wait`, args: [] } } }
    if (tool === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: `${name} answer`, turn_id: 'turn' } }
    throw Error(`unexpected ${tool}`)
  } }
}

test('a delivery keeps every RPC and its wait process on the generation it started with; new work uses the published one', async t => {
  const root = await mkdtemp(join(tmpdir(), 'generation-pin-'))
  const calls = [], waits = [], wait = deferred()
  const facade = new AitermGenerationClient({ client: generation('a', calls), runtimeCapture: { generation: 'a' } })
  const bots = new Map([[bot.id, bot]]); bots.refresh = async () => {}
  const engine = createExecutionDispatcher({ generation: 'engine', ports: { native: facade, bots, rooms: {},
    membersAdmission: new MembersAdmission(), configurationStorage: { root: join(root, 'intents'), ownerUid: process.getuid() },
    access: { assertWorkAllowed() {} }, observer: { report() {} }, diagnostics: { record() {} },
    seat: { waitProcess: async descriptor => { waits.push(descriptor.executable); if (waits.length === 1) await wait.promise; return { outcome: 'done', turn_id: 'turn' } } } } })
  // Stop the engine before its activity directory is removed.
  t.after(async () => {
    try { await engine.control('quiesce', { timeoutMs: 200 }); await engine.disconnect() } catch {}
    await rm(root, { recursive: true, force: true })
  })
  await engine.control('initialize')

  const first = engine.dispatch(request('transport.turn', bot, 'FIRST'))
  await tick(20)
  assert.equal(refs(facade, 'a'), 1)
  facade.publishGeneration({ client: generation('b', calls), runtimeCapture: { generation: 'b' } })
  wait.resolve()
  assert.equal(await first, 'a answer')
  await tick()
  assert.equal(refs(facade, 'a'), 0)
  assert.equal(await engine.dispatch(request('transport.turn', bot, 'SECOND')), 'b answer')

  const chain = name => calls.filter(([, tool]) => ['pty_send', 'pty_read'].includes(tool)).map(([g, tool]) => `${g}:${tool}`)
  assert.deepEqual(chain(), ['a:pty_send', 'a:pty_read', 'b:pty_send', 'b:pty_read'])
  assert.deepEqual(waits, ['a-wait', 'b-wait'])
})

test('a cursor is sent only to the generation that issued it; a switch restarts the chain', async () => {
  const calls = []
  const facade = new AitermGenerationClient({ client: generation('a', calls), runtimeCapture: { generation: 'a' } })
  const transport = new AitermTransport({ client: facade })
  const first = await transport.observeChain(bot)
  const second = await transport.observeChain(bot, { cursor: first.observation.activity.cursor, generation: first.generation })
  facade.publishGeneration({ client: generation('b', calls), runtimeCapture: { generation: 'b' } })
  const third = await transport.observeChain(bot, { cursor: second.observation.activity.cursor, generation: second.generation })
  assert.deepEqual([first.generation, second.generation, third.generation], ['a', 'a', 'b'])
  assert.deepEqual(calls.map(([g, , args]) => [g, args.cursor ?? null]), [['a', null], ['a', 'a-cursor'], ['b', null]])
  assert.equal(refs(facade, 'a'), 0)
})

test('a seat turn watch keeps the generation of the turn list until the watch ends', async () => {
  const calls = [], wait = deferred()
  const turn = { state: 'running', turn_id: 'self', event_cursor: 4, wait_process: { executable: 'a-wait', args: [] } }
  const a = generation('a', calls, tool => tool === 'pty_list'
    ? { _meta: { 'aiterm/seat_turns': { schema: 'aiterm.seat-turns.v1', seats: [{ harness: 'codex-cli', session_id: bot.session, turn }] } } } : undefined)
  const facade = new AitermGenerationClient({ client: a, runtimeCapture: { generation: 'a' } })
  const waited = []
  const transport = new AitermTransport({ client: facade, waitProcess: async descriptor => { waited.push(descriptor.executable); await wait.promise; return { outcome: 'done' } } })
  assert.equal(await transport.watchSeatTurns([bot]), true)
  facade.publishGeneration({ client: generation('b', calls), runtimeCapture: { generation: 'b' } })
  await tick()
  assert.equal(refs(facade, 'a'), 1)
  const watch = transport.activity.watches.get(bot.id)
  wait.resolve()
  watch.end()
  await watch.completion
  await tick()
  assert.equal(refs(facade, 'a'), 0)
  assert.deepEqual(waited, ['a-wait'])
})
