import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { BotAdministration } from '../src/bot-administration.mjs'
import { BellTeamMessenger } from '../src/messenger.mjs'
import { CapacityContinuation, recoverableTurnFailure } from '../src/capacity-continuation.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const observation = receipt => ({ schema: 'aiterm.agent-wait-result.v1', outcome: 'error', error: 'provider limit',
  session_id: receipt.session_id, launch_id: receipt.launch_id, vendor: receipt.vendor, operation_id: null,
  turn_id: receipt.vendor === 'codex' ? `turn-${receipt.event_cursor}` : null, ...(receipt.input_id ? { input_id: receipt.input_id } : {}),
  failure: { category: 'rate_limited', execution: 'unknown', terminal: true, future_effects: 'unknown', boundary: {
    event_cursor: receipt.event_cursor, operation_id: null, turn_id: receipt.vendor === 'codex' ? `turn-${receipt.event_cursor}` : null,
    ...(receipt.input_id ? { input_id: receipt.input_id } : {}),
  } } })

async function fixture(t, { failures = 1, onAuth = () => {}, changeFailure = x => x, closeUnknown = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'capacity-continuation-')); t.after(() => rm(root, { recursive: true, force: true }))
  const bot = { id: 'bot-synthetic', name: 'Synthetic', session: 'bot-synthetic', project: root,
    harness: 'claude', model: 'fable', reasoningEffort: 'high', fastMode: false }
  const bots = new Map([[bot.id, bot]]), calls = [], receipts = new Map()
  bots.refresh = async () => {}
  bots.previewUpdate = async (id, changes) => ({ ...bots.get(id), ...changes })
  bots.update = async (id, changes) => { const value = { ...bots.get(id), ...changes }; bots.set(id, value); return value }
  let sends = 0, enabled = true
  const client = { launchOptions: async () => ({}), async call(name, args, options = {}) {
    options.admissionCheck?.(); calls.push({ name, args })
    if (name === 'pty_send') {
      sends++
      const current = bots.get(bot.id), receipt = { mode: 'agent_dispatch', session_id: args.session_id, launch_id: 'a'.repeat(32),
        vendor: current.harness, event_cursor: sends, ...(current.harness === 'claude' ? { input_id: String(sends).padStart(32, '0') } : {}),
        wait_process: { executable: 'synthetic', args: [String(sends)] } }
      receipts.set(sends, receipt)
      return { structuredContent: receipt }
    }
    if (name === 'pty_close') { if (closeUnknown) throw Error('lost close result'); return { structuredContent: { session_id: args.session_id } } }
    if (name === 'agent_launch') return { structuredContent: { session_id: bot.id } }
    if (name === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: '', turn_id: `turn-${sends}` } }
    if (name === 'pty_observe') return { structuredContent: { words: [], event_cursor: sends } }
    throw Error(`unexpected ${name}`)
  } }
  const transport = new AitermTransport({ client, handoffContext: async () => '',
    updateSession: (id, session) => bots.update(id, { session }),
    assertWorkAllowed: () => { if (!enabled) throw Object.assign(Error('paused'), { code: 'AI_GLOBAL_PAUSED' }) },
    waitProcess: async descriptor => {
      const n = Number(descriptor.args[0]), receipt = receipts.get(n)
      return n <= failures ? changeFailure(observation(receipt)) : { outcome: 'done', turn_id: `turn-${n}` }
    } })
  transport.isRunning = async () => true
  const admin = new BotAdministration({ bots, transport, writeLog() {} })
  const messenger = new BellTeamMessenger({ bots, transport, logPath: join(root, 'messages.jsonl') })
  const recovery = new CapacityContinuation({ bots, administration: admin, messenger,
    assertEnabled: () => { if (!enabled) throw Object.assign(Error('paused'), { code: 'AI_GLOBAL_PAUSED' }) },
    harnessAuth: { status: async harness => { await onAuth({ harness, bots, stop: () => { enabled = false } }); return { status: 'authenticated' } } },
    models: { forHarness: async harness => ({ defaultModel: harness === 'codex' ? 'gpt-6.1-sol' : 'available', models: [
      { id: harness === 'codex' ? 'gpt-6-sol' : 'available', efforts: ['high'] },
      ...(harness === 'codex' ? [{ id: 'gpt-6.1-sol', efforts: ['high'] }] : []),
    ] }) } })
  transport.continuation = recovery
  t.after(() => transport.close())
  const start = () => messenger.sendmessage({ from: 'scheduler', target: bot.id, message: 'ORIGINAL_PRIVATE_BODY' })
  const settle = async () => { for (let i = 0; i < 100; i++) { await new Promise(resolve => setTimeout(resolve, 2)); if (!recovery.pending.size && !transport.jobs.size) return } throw Error('recovery did not settle') }
  return { root, bot, bots, calls, transport, admin, recovery, start, settle }
}

test('bound Fable limit closes old native, selects live latest Sol and sends a new saved-work continuation', async t => {
  const f = await fixture(t); const original = await f.start(); await f.settle()
  const sends = f.calls.filter(x => x.name === 'pty_send')
  assert.equal(sends.length, 2)
  assert.equal(sends[0].args.text.split('ORIGINAL_PRIVATE_BODY').length - 1, 1)
  assert.doesNotMatch(sends[1].args.text, /ORIGINAL_PRIVATE_BODY/)
  assert.match(sends[1].args.text, /docs\//)
  assert.ok(sends[1].args.text.includes(original.delivery_id), 'new continuation names the saved original request without copying its body')
  assert.equal(f.bots.get(f.bot.id).harness, 'codex'); assert.equal(f.bots.get(f.bot.id).model, 'gpt-6.1-sol')
  assert.ok(f.calls.findIndex(x => x.name === 'pty_close') < f.calls.findIndex(x => x.name === 'agent_launch'))
  const rows = (await readFile(join(f.root, 'messages.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.ok(rows.some(x => x.delivery_id === original.delivery_id && x.delivery === 'failed'))
  assert.equal(rows.filter(x => x.schema === 'bellteam.direct-message.v1').length, 2)
})

test('capacity and repeated alternate limits have a finite two-harness continuation budget', async t => {
  const f = await fixture(t, { failures: 10, changeFailure: x => ({ ...x, failure: { ...x.failure, category: 'capacity' } }) })
  await f.start(); await f.settle()
  assert.equal(f.calls.filter(x => x.name === 'pty_send').length, 3)
  assert.equal(f.calls.filter(x => x.name === 'pty_close').length, 2)
  assert.equal(f.recovery.states.get(f.bot.id).sent, 2)
})

test('pause or newer model during candidate lookup prevents automatic configuration and send', async t => {
  for (const change of ['pause', 'model']) {
    const f = await fixture(t, { onAuth: ({ bots, stop }) => { if (change === 'pause') stop(); else bots.set('bot-synthetic', { ...bots.get('bot-synthetic'), model: 'owner-new-model' }) } })
    await f.start(); await f.settle()
    assert.equal(f.calls.filter(x => x.name === 'pty_send').length, 1)
    assert.equal(f.calls.filter(x => x.name === 'pty_close').length, 0)
  }
})

test('unknown close preserves uncertainty and does not launch or send continuation', async t => {
  const f = await fixture(t, { closeUnknown: true }); await f.start(); await f.settle()
  assert.equal(f.calls.filter(x => x.name === 'pty_send').length, 1)
  assert.equal(f.calls.filter(x => x.name === 'agent_launch').length, 0)
})

test('unbound, nonterminal, legacy and mismatched input failures never authorize recovery', async () => {
  const receipt = { mode: 'agent_dispatch', session_id: 'original', launch_id: 'a'.repeat(32), vendor: 'claude', event_cursor: 1, input_id: 'b'.repeat(32) }
  const result = observation(receipt)
  assert.equal(recoverableTurnFailure(receipt, result).execution, 'unknown')
  for (const changed of [{ failure: undefined }, { failure: { ...result.failure, terminal: false } },
    { failure: { ...result.failure, boundary: null } }, { input_id: 'c'.repeat(32) }, { launch_id: 'c'.repeat(32) },
    { failure: { ...result.failure, boundary: { ...result.failure.boundary, event_cursor: 2 } } }])
    assert.equal(recoverableTurnFailure(receipt, { ...result, ...changed }), null)
  assert.equal(recoverableTurnFailure({ ...receipt, mode: 'agent_steer' }, result), null)
  const recovery = new CapacityContinuation({})
  recovery.failed({ deliveryId: 'untrusted\ntext', failure: result.failure })
  assert.equal(recovery.pending.size, 0)
})
