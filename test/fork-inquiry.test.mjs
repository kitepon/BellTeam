import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { BellTeamMessenger } from '../src/messenger.mjs'
import { callConversationTool, conversationTools } from '../src/mcp-conversation-tools.mjs'

const asker = { id: 'bot-asker', name: 'Asker' }, owner = { id: 'bot-owner', name: 'Owner Bot' }

async function setup(t, forkInquiry) {
  const root = await mkdtemp(join(tmpdir(), 'fork-inquiry-')); t.after(() => rm(root, { recursive: true, force: true }))
  const notified = [], turnEnds = []
  let n = 0
  const transport = {
    forkInquiry,
    async notify(bot, text, options) { notified.push({ bot: bot.id, text, options }); return { delivery: 'running' } },
  }
  const messenger = new BellTeamMessenger({
    bots: new Map([[asker.id, asker], [owner.id, owner]]), transport,
    logPath: join(root, 'direct.jsonl'), deliveryId: () => `id-${++n}`, onTurnEnd: turn => turnEnds.push(turn),
  })
  const rows = async () => (await readFile(join(root, 'direct.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  return { messenger, notified, turnEnds, rows }
}

// The relay runs after the receipt settles and the saved rows are appended.
const settle = () => new Promise(resolve => setTimeout(resolve, 50))

test('ask_readonly returns the receipt at once, labels target rows and relays the answer once to the asker', async t => {
  let callbacks, envelope
  const { messenger, notified, turnEnds, rows } = await setup(t, async (bot, text, options) => {
    envelope = text; callbacks = options; return { delivery: 'running' }
  })
  const receipt = await messenger.askReadonly({ from: asker.id, target: owner.id, message: 'What is X?' })
  assert.deepEqual(receipt, { delivery: 'running', delivery_id: 'id-2', fork_id: 'id-1', from: asker.id, target: owner.id, seat: 'fork' })
  assert.match(envelope, /「Asker」からあなたへ/)
  assert.equal(callbacks.forkId, 'id-1'); assert.equal(callbacks.deliveryId, 'id-2')
  assert.equal(notified.length, 0, 'nothing is sent to any main seat before the answer')

  await callbacks.onInterim([{ text: 'reading' }])
  await callbacks.onAnswer('X is Y.')
  assert.equal(callbacks.onTurnEnd, undefined, 'a fork registers no turn-end (fork-inquiry B4)')
  await callbacks.onStatus('delivered')
  callbacks.onStatus('failed', { code: 'LATE' })
  await settle(); await settle()

  assert.equal(notified.length, 1, 'exactly one relay')
  assert.equal(notified[0].bot, asker.id)
  assert.match(notified[0].text, /「Owner Bot（分身）」からあなたへ次のメッセージが届いています。\n\nX is Y\./)
  assert.equal(turnEnds.length, 0, 'fork turns never trigger turn reports on the main seat')
  const saved = await rows()
  const inquiry = saved.find(row => row.delivery_id === 'id-2' && row.schema === 'bellteam.direct-message.v1')
  assert.deepEqual(inquiry.seat, { kind: 'fork', fork_id: 'id-1' })
  assert.equal(inquiry.target, owner.id)
  assert.ok(saved.some(row => row.schema === 'bellteam.interim-word.v1' && row.bot === owner.id && row.group_id === 'id-2' && row.kind === 'answer'))
  const relayRow = saved.find(row => row.schema === 'bellteam.direct-message.v1' && row.in_reply_to === 'id-2')
  assert.deepEqual([relayRow.from, relayRow.target, relayRow.seat.kind, relayRow.message], [owner.id, asker.id, 'fork', 'X is Y.'])
  assert.ok(saved.filter(row => row.schema === 'bellteam.interim-word.v1').every(row => row.seat?.kind === 'fork'))

  // History items keep the label for clients (inquiry, interim, answer and relay); main rows stay without seat.
  const items = await messenger.store.timeline(owner.id)
  const forkItems = items.filter(item => item.seat?.kind === 'fork')
  assert.deepEqual(forkItems.map(item => [item.kind, item.direction]).sort(),
    [['interim', 'incoming'], ['message', 'incoming'], ['peer', 'received'], ['peer', 'sent']].sort())
})

test('a failure after receipt relays ONE FORK_FAILED message with the reason', async t => {
  let callbacks
  const { messenger, notified } = await setup(t, async (bot, text, options) => { callbacks = options; return { delivery: 'running' } })
  await messenger.askReadonly({ from: asker.id, target: owner.id, message: 'Q' })
  await callbacks.onStatus('failed', { code: 'FORK_FAILED', delivery_error: { code: 'FORK_FAILED' }, reason: 'NATIVE_EXITED' })
  await callbacks.onStatus('delivered')
  await settle(); await settle()
  assert.equal(notified.length, 1)
  assert.match(notified[0].text, /FORK_FAILED: NATIVE_EXITED$/)
})

test('delivered without an answer relays FORK_FAILED: NO_ANSWER', async t => {
  let callbacks
  const { messenger, notified } = await setup(t, async (bot, text, options) => { callbacks = options; return { delivery: 'running' } })
  await messenger.askReadonly({ from: asker.id, target: owner.id, message: 'Q' })
  await callbacks.onAnswer('  ')
  await callbacks.onStatus('delivered')
  await settle(); await settle()
  assert.equal(notified.length, 1)
  assert.match(notified[0].text, /FORK_FAILED: NO_ANSWER$/)
})

test('a rejected fork launch is the tool error, recorded failed, never relayed and never queued on main', async t => {
  const unavailable = Object.assign(new Error('FORK_UNAVAILABLE'), { code: 'FORK_UNAVAILABLE', reason: 'readonly_unenforceable' })
  const { messenger, notified, rows } = await setup(t, async (bot, text, options) => {
    options.onStatus('failed', unavailable); throw unavailable
  })
  await assert.rejects(messenger.askReadonly({ from: asker.id, target: owner.id, message: 'Q' }), { code: 'FORK_UNAVAILABLE' })
  await settle(); await settle()
  assert.equal(notified.length, 0)
  assert.ok((await rows()).some(row => row.schema === 'bellteam.delivery-status.v1' && row.delivery === 'failed'))
})

test('the Owner is never a fork target, and the tool carries no image input', async t => {
  const { messenger } = await setup(t, async () => assert.fail('must not fork'))
  await assert.rejects(messenger.askReadonly({ from: asker.id, target: 'user', message: 'Q' }), /FORK_TARGET_USER/)
  const registry = { get: id => [asker, owner].find(bot => bot.id === id), list: () => [asker, owner] }
  await assert.rejects(callConversationTool({ name: 'ask_readonly', args: { target: 'user', message: 'Q' }, from: asker.id, registry, messenger }), /FORK_TARGET_USER/)
  const tool = conversationTools.find(item => item.name === 'ask_readonly')
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['target', 'message'])
  assert.deepEqual(conversationTools.filter(item => item.annotations?.readOnlyHint === true).map(item => item.name),
    ['list_messages', 'list_rooms', 'get_room', 'list_queued_messages', 'list_room_messages'], 'only read tools are listed to fork seats')
  assert.match(tool.description, /読み取り専用/); assert.match(tool.description, /中断されず/); assert.match(tool.description, /sendmessage/)
})

test('ask_readonly from a fork seat waits and returns the answer as its result, with no relay to main', async t => {
  let callbacks, envelope
  const { messenger, notified, rows } = await setup(t, async (bot, text, options) => {
    envelope = text; callbacks = options
    setTimeout(() => callbacks.onAnswer('X is Y.'), 10)
    return { delivery: 'running' }
  })
  const result = await messenger.askReadonly({ from: asker.id, target: owner.id, message: 'What is X?', askerSeat: { kind: 'fork', forkId: 'f-asker' } })
  assert.deepEqual(result, { delivery: 'answered', answer: 'X is Y.', delivery_id: 'id-2', fork_id: 'id-1', from: asker.id, target: owner.id, seat: 'fork' })
  assert.match(envelope, /「Asker（分身）」からあなたへ/)
  await settle()
  assert.equal(notified.length, 0, 'the asking fork gets the answer itself; main is not notified')
  const inquiry = (await rows()).find(row => row.delivery_id === 'id-2' && row.schema === 'bellteam.direct-message.v1')
  assert.deepEqual(inquiry.from_seat, { kind: 'fork', fork_id: 'f-asker' })

  const failing = await setup(t, async (bot, text, options) => { setTimeout(() => options.onStatus('failed', { code: 'BOOM' }), 10); return { delivery: 'running' } })
  const failed = await failing.messenger.askReadonly({ from: asker.id, target: owner.id, message: 'Q', askerSeat: { kind: 'fork', forkId: 'f-asker' } })
  assert.equal(failed.answer, 'FORK_FAILED: BOOM')
})

test('sendmessage from a fork seat keeps its receipt and labels the record and envelope as the fork', async t => {
  const { messenger, notified, rows } = await setup(t, async () => ({ delivery: 'running' }))
  const receipt = await messenger.sendmessage({ from: asker.id, target: owner.id, message: 'please', askerSeat: { kind: 'fork', forkId: 'f-asker' } })
  assert.deepEqual([receipt.delivery, receipt.from, receipt.target], ['running', asker.id, owner.id])
  assert.match(notified[0].text, /「Asker（分身）」からあなたへ/)
  const row = (await rows()).find(item => item.schema === 'bellteam.direct-message.v1')
  assert.deepEqual(row.from_seat, { kind: 'fork', fork_id: 'f-asker' })
  assert.equal(row.seat, undefined)
})
