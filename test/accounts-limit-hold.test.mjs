import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { CapacityContinuation } from '../src/capacity-continuation.mjs'
import { HarnessAccounts } from '../src/harness-accounts.mjs'
import { claudeLimitHold, isLimitText } from '../src/claude-limit-text.mjs'

// harness-accounts.md "All slots limited: limit hold and account recovery".
const HELD = `● Usage limit reached · continuing automatically at 7pm · esc to cancel

✻ Worked for 27s · done 12:51 PM

────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
  ⚠ Usage limit reached · limit resets 7pm
    Continuing automatically at 7pm · Esc to cancel · /usage-credits to
    continue now
  ⏵⏵ bypass permissions on (shift+tab to cycle)`
const CANCELLED = `                                      Automatic continue cancelled · /rate-limit-options to re-arm
────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle)`
const TOKEN = 'sk-ant-oat01-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'

test('limit hold: only the footer of a turn Claude Code keeps for its reset', () => {
  assert.match(claudeLimitHold(HELD), /Continuing automatically at 7pm/u)
  assert.equal(claudeLimitHold(CANCELLED), null)
  // The line above the composer alone is history, not a hold.
  assert.equal(claudeLimitHold('● Usage limit reached · continuing automatically at 7pm\n───────────\n❯\n────────────\n  ⏵⏵ on'), null)
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

function seats({ screens, bots }) {
  const calls = []
  const client = { launchOptions: async () => ({}), async call(name, args, options = {}) {
    options.admissionCheck?.(); calls.push([name, args])
    if (name === 'pty_list') return { structuredContent: { sessions: [...screens.keys()].map(session_id => ({ session_id, harness: 'claude-code', current_command: 'claude' })) } }
    if (name === 'pty_read') return { content: [{ type: 'text', text: screens.get(args.session_id) ?? '' }] }
    if (name === 'pty_key') { screens.set(args.session_id, CANCELLED); return {} }
    throw Error(`unexpected ${name}`)
  } }
  return { client, calls }
}

async function recovery(t, { held, limited }) {
  const now = { at: Date.UTC(2026, 10, 11, 14, 0) }
  const { accounts } = await registry(t, now)
  t.after(() => accounts.close())
  for (const slot of limited) await accounts.recordLimit({ harness: 'claude', slot, model: 'opus', text: "You've hit your weekly limit · resets 7pm (UTC)" })
  const bots = new Map([
    ['bot-elegg', { id: 'bot-elegg', session: 'bot-elegg', harness: 'claude', model: 'opus' }],
    ['bot-n102', { id: 'bot-n102', session: 'bot-n102-1st-abc', harness: 'claude', model: 'opus' }],
  ])
  await accounts.setSeat('bot-elegg', '2nd'); await accounts.setSeat('bot-n102', '1st')
  const screens = new Map([['bot-elegg', held ? HELD : CANCELLED], ['bot-n102', held ? HELD : CANCELLED], ['bot-n102-1st-abc', CANCELLED]])
  const { client, calls } = seats({ screens, bots })
  const transport = new AitermTransport({ client, accounts, resolveBot: id => bots.get(id) })
  transport.holdReleasePollMs = 1
  const switched = [], sent = []
  transport.switchAccount = async bot => { switched.push(bot.id); const session = `${bot.id}-1st-new`; bots.set(bot.id, { ...bot, session }); transport.sessions.set(bot.id, session); await accounts.setSeat(bot.id, '1st') }
  const continuation = new CapacityContinuation({ bots, accounts, transport, assertEnabled: () => {},
    messenger: { sendmessage: async (input, options) => { options.admissionCheck(); sent.push(input); return { delivery_id: `d-${sent.length}` } } } })
  continuation.states.set('bot-n102', { deliveryId: 'n102-original' })
  transport.continuation = continuation
  const review = async () => { await transport.reviewAccounts(); while (transport.accountMoves.size) await Promise.all(transport.accountMoves.values()) }
  return { accounts, calls, transport, switched, sent, review, screens }
}

// Production 2026-11-11: Elegg's self-started turn held on the 2nd and N102's old seat held after its move to the 1st.
test('a free slot recovers held members at engine start: Esc each hold, a new seat only for a held current seat, one message each', async t => {
  const { calls, switched, sent, review, accounts } = await recovery(t, { held: true, limited: ['2nd'] })
  await review()
  assert.deepEqual(calls.filter(([name]) => name === 'pty_key').map(([, args]) => [args.session_id, args.key]).sort(),
    [['bot-elegg', 'Escape'], ['bot-n102', 'Escape']])
  assert.deepEqual(switched, ['bot-elegg'], 'N102 already runs on the free slot')
  assert.deepEqual(sent.map(input => [input.target, input.from]).sort(), [['bot-elegg', 'scheduler'], ['bot-n102', 'scheduler']])
  assert.match(sent.find(input => input.target === 'bot-n102').message, /delivery_id=n102-original/u)
  assert.doesNotMatch(sent.find(input => input.target === 'bot-elegg').message, /delivery_id/u)
  assert.equal(accounts.seatSlot('bot-elegg'), '1st')
  // Nothing is held any more: a later review sends nothing again.
  await accounts.recordLimit({ harness: 'claude', slot: '2nd', model: 'fable', text: "You've reached your Fable limit · resets 7pm (UTC)" })
  await review()
  assert.equal(sent.length, 2)
})

test('every slot limited: holds and pending stay, nothing is pressed or sent; a freed slot then recovers once', async t => {
  const { calls, switched, sent, review, accounts } = await recovery(t, { held: true, limited: ['1st', '2nd'] })
  await accounts.setPending('bot-n102', { harness: 'claude', slot: '1st', deliveryId: 'n102-original' })
  await review()
  assert.equal(calls.some(([name]) => name === 'pty_key'), false)
  assert.deepEqual([switched, sent], [[], []])
  assert.equal(accounts.pendingFor('bot-n102').deliveryId, 'n102-original')
  // The 1st frees: Elegg moves from its held 2nd seat; N102's own slot freed while its old seat held, so it gets the message.
  await accounts.clear(accounts.limitFor('claude', '1st', 'opus')[0])
  await review()
  assert.deepEqual(switched, ['bot-elegg'])
  assert.equal(sent.filter(input => input.target === 'bot-n102').length, 1)
  assert.equal(sent.filter(input => input.target === 'bot-elegg').length, 1)
  assert.equal(accounts.pendingFor('bot-n102'), null)
})

test('a held current seat whose own slot freed is left to continue by itself; no message', async t => {
  const { calls, switched, sent, review, accounts, screens } = await recovery(t, { held: false, limited: ['1st'] })
  screens.set('bot-n102-1st-abc', HELD)
  await accounts.setPending('bot-n102', { harness: 'claude', slot: '1st', deliveryId: 'n102-original' })
  await accounts.clear(accounts.limitFor('claude', '1st', 'opus')[0])
  await review()
  assert.equal(calls.some(([name, args]) => name === 'pty_key' && args.session_id === 'bot-n102-1st-abc'), false)
  // Elegg, not held, only returns to the freed 1st at its boundary (no message); N102 is neither moved nor told.
  assert.deepEqual([switched, sent], [['bot-elegg'], []])
  assert.equal(accounts.pendingFor('bot-n102'), null)
})
