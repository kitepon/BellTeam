import assert from 'node:assert/strict'
import test from 'node:test'
import { createManagedTransport } from '../src/aiterm-transport.mjs'
import { BotAdministration } from '../src/bot-administration.mjs'
import { stopRegisteredWork } from '../src/ai-control.mjs'
import { RoomMessenger } from '../src/room-messenger.mjs'

// The managed production factory/stop wiring is under test. RPC replies are
// synthetic; no Aiterm process, real Bot, native terminal or HTTP is used.
const bots = () => Array.from({ length: 11 }, (_, i) => ({ id: `fixture-seat-${i}`, session: `fixture-seat-${i}` }))
const deferred = () => {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}
const steer = () => ({ structuredContent: { mode: 'agent_steer' } })
const sent = ids => ({ structuredContent: { status: 'sent', targets: ids.map(session_id => ({ session_id, status: 'sent' })) } })

test('managed factory submits 11 ordinary deliveries without tracking RPC; ten finish while one send is held', { timeout: 5000 }, async () => {
  const group = bots(), entered = deferred(), held = deferred(), calls = []
  const client = { async call(name, args) {
    calls.push({ name, args })
    assert.equal(name, 'pty_send', 'no execution registration, roots or observation RPC may gate ordinary dispatch')
    assert.equal(args.require_agent, true)
    if (args.session_id === group[0].id) { entered.resolve(); await held.promise }
    return steer()
  } }
  const transport = createManagedTransport({ client })
  assert.equal(transport.executionBridge, null)
  const first = transport.submit(group[0], 'fixture text 0')
  await entered.promise
  try {
    const others = group.slice(1).map((bot, i) => transport.submit(bot, `fixture text ${i + 1}`))
    const results = await Promise.all(others)
    assert.equal(results.length, 10)
    assert.equal(calls.length, 11)
    assert.equal(transport.jobs.size, 1)
    for (const bot of group) assert.equal(calls.filter(call => call.args.session_id === bot.id).length, 1)
  } finally { held.resolve() }
  assert.deepEqual(await first, { delivery: 'steered' })
  assert.equal(transport.jobs.size, 0)
})

test('individual BotAdministration stop reaches direct agent_stop with tracking disabled', async () => {
  const bot = bots()[0], calls = []
  const transport = createManagedTransport({ client: { async call(name, args) {
    calls.push({ name, args })
    assert.equal(name, 'agent_stop')
    return sent([args.session_id])
  } } })
  const admin = new BotAdministration({ transport, writeLog() {} })
  assert.deepEqual(await admin.stop(bot), { botId: bot.id, status: 'stop_sent' })
  assert.deepEqual(calls, [{ name: 'agent_stop', args: { session_id: bot.id } }])
})

test('global stop uses one direct batch and existing scheduler command interruption without tracking', async () => {
  const group = bots(), calls = []
  let commandStops = 0
  const transport = createManagedTransport({ client: { async call(name, args) {
    calls.push({ name, args })
    assert.equal(name, 'agent_stop')
    return sent(args.session_ids)
  } } })
  const result = await stopRegisteredWork({ bots: new Map(group.map(bot => [bot.id, bot])), transport,
    scheduler: { interruptCommands() { commandStops++; return true } } })
  assert.deepEqual(result, { unconfirmedBotIds: [], commandsConfirmed: true })
  assert.equal(commandStops, 1)
  assert.deepEqual(calls, [{ name: 'agent_stop', args: { session_ids: group.map(bot => bot.id) } }])
})

test('a failed direct stop is reported without closing, tracking lookup or resend', async () => {
  const bot = bots()[0], calls = []
  const transport = createManagedTransport({ client: { async call(name, args) {
    calls.push({ name, args })
    assert.equal(name, 'agent_stop')
    return { structuredContent: { status: 'failed', targets: [{ session_id: bot.id, status: 'failed' }] } }
  } } })
  const admin = new BotAdministration({ transport, writeLog() {} })
  await assert.rejects(admin.stop(bot), { code: 'BOT_STOP_UNCONFIRMED' })
  assert.deepEqual(calls, [{ name: 'agent_stop', args: { session_id: bot.id } }])
})


test('real room routing delivers to eleven members with one responder while one send is held', { timeout: 5000 }, async () => {
  const group = bots().map((bot, i) => ({ ...bot, name: `member ${i}` }))
  const entered = deferred(), held = deferred(), tenDelivered = deferred(), calls = [], records = []
  const members = new Map(group.map(bot => [bot.id, bot]))
  const room = { id: 'fixture-room', name: 'fixture', purpose: 'fixture', memberIds: group.map(bot => bot.id) }
  const rooms = new Map([[room.id, room]])
  rooms.appendMessage = async (_id, record) => {
    records.push(record)
    if (records.filter(item => item.delivery === 'delivered' && item.target !== group[0].id).length === 10) tenDelivered.resolve()
  }
  const transport = createManagedTransport({ client: { async call(name, args) {
    assert.equal(name, 'pty_send')
    calls.push(args)
    if (args.session_id === group[0].id) { entered.resolve(); await held.promise }
    return steer()
  } } })
  const messenger = new RoomMessenger({ rooms, bots: members, transport, automaticRouting: () => false, roomTurns: async () => [] })
  const operation = messenger.sendroommessage({ from: 'user', room: room.id, message: 'fixture room text', targets: [group[0].id] })
  await entered.promise
  try {
    await tenDelivered.promise
    assert.equal(calls.length, 11)
    assert.equal(records.some(item => item.target === group[0].id && item.delivery === 'delivered'), false)
  } finally { held.resolve() }
  const result = await operation
  assert.deepEqual(result.targets, [group[0].id])
  assert.equal(result.failedTargets, undefined)
  assert.equal(calls.length, 11)
  assert.equal(records.filter(item => item.delivery === 'delivered').length, 11)
  await transport.close()
})
