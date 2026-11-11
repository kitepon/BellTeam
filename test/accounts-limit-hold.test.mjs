import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { CapacityContinuation } from '../src/capacity-continuation.mjs'
import { HarnessAccounts } from '../src/harness-accounts.mjs'
import { isLimitText } from '../src/claude-limit-text.mjs'

// harness-accounts.md "All slots limited: limit end and account recovery" (Aiterm 0.70.26 pty_list limit_end).
const TOKEN = 'sk-ant-oat01-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'

test('limit text: the lines Claude Code prints for an account limit', () => {
  assert.equal(isLimitText("You've hit your weekly limit · resets 7pm (UTC)"), true)
  assert.equal(isLimitText("You've reached your Fable limit. Run /usage-credits"), true)
  assert.equal(isLimitText('API Error: 500'), false)
})

async function registry(t, now) {
  const home = await mkdtemp(join(tmpdir(), 'accounts-hold-')); t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, '.claude/projects'), { recursive: true })
  for (const slot of ['1st', '2nd']) {
    await mkdir(join(home, '.bellteam-accounts/claude', slot), { recursive: true })
    await writeFile(join(home, '.bellteam-accounts/claude', slot, 'oauth-token'), TOKEN)
  }
  const timers = new Map(); let next = 0
  const accounts = new HarnessAccounts({ home, statePath: join(home, 'state.json'), readUsage: async () => [], now: () => now.at,
    log: () => {}, seat: async () => null, timers: { set: (fn, ms) => { timers.set(++next, { fn, at: now.at + ms }); return next }, clear: id => timers.delete(id) } })
  const fire = async ms => {
    now.at += ms
    for (const [id, timer] of [...timers]) if (timer.at <= now.at) { timers.delete(id); timer.fn() }
    for (let i = 0; i < 5; i++) { await accounts.writing; await new Promise(resolve => setImmediate(resolve)) }
  }
  return { home, accounts, fire }
}

// Production 2026-11-11 22:25 JST: two clears at one resetAt each saved a stale snapshot; the second restored 1st/fable.
test('two reset timers firing together clear both entries and keep the other slot', async t => {
  const now = { at: Date.UTC(2026, 10, 11, 12, 0) }
  const { home, accounts, fire } = await registry(t, now)
  await accounts.recordLimit({ harness: 'claude', slot: '1st', model: 'opus', text: "You've hit your weekly limit · resets 1:25pm (UTC)" })
  await accounts.recordLimit({ harness: 'claude', slot: '1st', model: 'fable', text: "You've reached your Fable limit · resets 1:25pm (UTC)" })
  await accounts.recordLimit({ harness: 'claude', slot: '2nd', model: 'opus', text: "You've hit your weekly limit · resets 7pm (UTC)" })
  await fire(85 * 60_000)
  const saved = JSON.parse(await readFile(join(home, 'state.json'), 'utf8'))
  for (const limits of [accounts.state.limits, saved.limits])
    assert.deepEqual(limits.map(entry => [entry.slot, entry.scope]), [['2nd', 'all']])
})

// A fake Aiterm 0.70.26: pty_list rows carry last_input_at / limit_end; pty_key Escape on an armed hold cancels it.
function aiterm(rows) {
  const calls = [], keys = { refuse: new Set(), ignore: new Set() }
  const client = { launchOptions: async () => ({}), async call(name, args, options = {}) {
    options.admissionCheck?.(); calls.push([name, args])
    if (name === 'pty_list') return { structuredContent: { sessions: [...rows.values()].map(row => ({ harness: 'claude-code', current_command: 'claude', ...structuredClone(row) })) } }
    if (name === 'pty_key') {
      if (keys.refuse.has(args.session_id)) throw Error('key refused')
      const row = rows.get(args.session_id)
      if (args.key === 'Escape' && row?.limit_end?.hold === 'armed' && !keys.ignore.has(args.session_id)) row.limit_end.hold = 'cancelled'
      return {}
    }
    throw Error(`unexpected ${name}`)
  } }
  return { client, calls, keys }
}

const END = (at, hold = 'armed', continued = false) => ({ at, reset_at: '2026-11-11T19:00:00.000Z', continued, hold })
const row = (session_id, last_input_at, limit_end = null) => [session_id, { session_id, last_input_at, limit_end }]

async function recovery(t, { limited = ['2nd'], rows }) {
  const now = { at: Date.UTC(2026, 10, 11, 16, 0) }
  const { accounts } = await registry(t, now)
  t.after(() => accounts.close())
  for (const slot of limited) await accounts.recordLimit({ harness: 'claude', slot, model: 'opus', text: "You've hit your weekly limit · resets 7pm (UTC)" })
  const bots = new Map([
    ['bot-elegg', { id: 'bot-elegg', session: 'bot-elegg', harness: 'claude', model: 'opus' }],
    ['bot-n102', { id: 'bot-n102', session: 'bot-n102-1st-new', harness: 'claude', model: 'opus' }],
  ])
  await accounts.setSeat('bot-elegg', '2nd'); await accounts.setSeat('bot-n102', '1st')
  const { client, calls, keys } = aiterm(new Map(rows))
  const transport = new AitermTransport({ client, accounts, resolveBot: id => bots.get(id) })
  transport.holdReleasePollMs = 1
  const switched = [], sent = []
  transport.switchAccount = async bot => { switched.push(bot.id); await accounts.setSeat(bot.id, '1st') }
  const continuation = new CapacityContinuation({ bots, accounts, transport, assertEnabled: () => {},
    messenger: { sendmessage: async (input, options) => { options.admissionCheck(); sent.push(input); return { delivery_id: `d-${sent.length}` } } } })
  transport.continuation = continuation
  // Settled: no move running, and the registry writes and reviews they caused are done.
  const review = async () => {
    await transport.reviewAccounts()
    do {
      while (transport.accountMoves.size) await Promise.all(transport.accountMoves.values())
      await accounts.writing; await transport.accountReview; await new Promise(resolve => setImmediate(resolve))
    } while (transport.accountMoves.size)
  }
  const keyed = () => calls.filter(([name]) => name === 'pty_key').map(([, args]) => [args.session_id, args.key])
  return { accounts, calls, keys, transport, switched, sent, review, keyed }
}

// Production 2026-11-12 01:14 JST after eb8c94a5: N102's hold was cancelled (no continuation); Elegg already continued on a new seat.
test('limit end: an un-continued last turn gets exactly one continuation; a continued member and a later review get none', async t => {
  const { switched, sent, review, keyed, accounts } = await recovery(t, { rows: [
    row('bot-n102', '2026-11-11T12:53:25.000Z', END('2026-11-11T12:53:29.000Z', 'cancelled')),
    row('bot-elegg', '2026-11-11T12:51:33.000Z', END('2026-11-11T12:51:56.000Z', 'cancelled')),
    row('bot-elegg-1st-mwcbl0hj', '2026-11-11T16:14:58.000Z'),
  ] })
  await review()
  assert.deepEqual(keyed(), [], 'no armed hold: nothing pressed')
  assert.deepEqual(sent.map(input => [input.target, input.from]), [['bot-n102', 'scheduler']])
  assert.equal(switched.includes('bot-n102'), false, 'N102 is recorded on the free 1st: its delivery launches the 1st seat')
  // Before Aiterm records the continuation's input, a later review (or the next engine) must not send it again.
  await accounts.load()
  await review()
  assert.equal(sent.length, 1)
})

test('limit end: armed holds are pressed once each, then one continuation on the free slot', async t => {
  const { switched, sent, review, keyed, accounts } = await recovery(t, { rows: [
    row('bot-elegg', '2026-11-11T12:51:33.000Z', END('2026-11-11T12:51:56.000Z')),
  ] })
  await review()
  assert.deepEqual(keyed(), [['bot-elegg', 'Escape']])
  assert.deepEqual(switched, ['bot-elegg'], 'its seat was on the limited 2nd')
  assert.deepEqual(sent.map(input => input.target), ['bot-elegg'])
  assert.equal(accounts.seatSlot('bot-elegg'), '1st')
})

test('limit end: every slot limited -> nothing pressed or sent; a freed slot then recovers once', async t => {
  const { sent, review, keyed, accounts } = await recovery(t, { limited: ['1st', '2nd'], rows: [
    row('bot-n102', '2026-11-11T12:53:25.000Z', END('2026-11-11T12:53:29.000Z')),
  ] })
  await review()
  assert.deepEqual([keyed(), sent], [[], []])
  await accounts.clear(accounts.limitFor('claude', '1st', 'opus')[0])
  await review()
  assert.deepEqual(keyed(), [['bot-n102', 'Escape']])
  assert.deepEqual(sent.map(input => input.target), ['bot-n102'])
})

test('limit end: a hold still armed after its one Esc -> no second Esc and no continuation (two turns over one work)', async t => {
  const { sent, review, keyed, keys } = await recovery(t, { rows: [
    row('bot-elegg', '2026-11-11T12:51:33.000Z', END('2026-11-11T12:51:56.000Z')),
  ] })
  keys.ignore.add('bot-elegg')
  await review(); await review()
  assert.deepEqual(keyed(), [['bot-elegg', 'Escape']])
  assert.deepEqual(sent, [])
})

test('limit end: continued by itself, or a stop after the limit end -> no continuation', async t => {
  const { sent, review, accounts, transport } = await recovery(t, { rows: [
    row('bot-elegg', '2026-11-11T12:51:33.000Z', END('2026-11-11T12:51:56.000Z', null, true)),
    row('bot-n102', '2026-11-11T12:53:25.000Z', END('2026-11-11T12:53:29.000Z', 'cancelled')),
  ] })
  await accounts.setStopped('bot-n102')
  await review()
  assert.deepEqual(sent, [])
  assert.ok(transport.accounts.stoppedAt('bot-n102'))
})

// Production 2026-11-12 01:14 JST: the handed-over dc4b63be engine launched a second Elegg seat from its stale registry copy.
test('limit end: an engine that is not running (handed over) presses nothing and sends nothing', async t => {
  const { sent, review, keyed, transport, switched } = await recovery(t, { rows: [
    row('bot-elegg', '2026-11-11T12:51:33.000Z', END('2026-11-11T12:51:56.000Z')),
  ] })
  let running = true
  transport.accountRecoveryAllowed = () => running
  transport.limitEnds = (original => async () => { const ends = await original(); running = false; return ends })(transport.limitEnds.bind(transport))
  await review()
  assert.deepEqual([keyed(), switched, sent], [[], [], []])
})

test('limit end: an older Aiterm without the fields -> no recovery, no screen read', async t => {
  const { sent, review, calls } = await recovery(t, { rows: [] })
  calls.length = 0
  await review()
  assert.deepEqual(calls.map(([name]) => name).filter(name => name !== 'pty_list'), [])
  assert.deepEqual(sent, [])
})

test('registry: a pending key from dc4b63be / eb8c94a5 is dropped on load', async t => {
  const now = { at: Date.UTC(2026, 10, 11, 16, 0) }
  const { accounts } = await registry(t, now)
  t.after(() => accounts.close())
  await writeFile(accounts.statePath, JSON.stringify({ schema: 'bellteam.harness-accounts.v1', seats: { 'bot-n102': '1st' },
    pending: { 'bot-n102': { harness: 'claude', slot: '2nd', deliveryId: null, since: '2026-11-11T15:57:11.000Z', escaped: ['bot-n102'] } } }))
  await accounts.load()
  assert.equal(accounts.state.pending, undefined)
  assert.equal(accounts.seatSlot('bot-n102'), '1st')
})
