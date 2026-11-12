import assert from 'node:assert/strict'
import test from 'node:test'
import { createNoticeDelivery, noticeMessage, NOTICE_SLICE } from '../src/lattice/notices.mjs'
import { createLatticeEffects, createLatticeFacade } from '../src/lattice-facade.mjs'
import { validateLatticeEffect, validateLatticeEffectResult, validateLatticeRequest, validateLatticeResult } from '../src/lattice-protocol.mjs'

const roster = ids => ids.map(id => ({ id, name: id, color: 'sky', avatarVersion: 'v1', deleting: false }))
const notice = (id, lane, extra = {}) => ({ notice_id: id, plan_key: 'p1', plan_version: 'v1', task_id: `t-${id}`, title: `Task ${id}`, lane,
  done_condition: 'shipped', coordination_mode: 'conversation', next_action: `lattice todo start --plan p1 --task t-${id}`,
  triggers: [{ plan_key: 'p1', task_id: 't0', kind: 'done', actor: { agent: 'bot-a' } }], ...extra })

function rig({ listed = [], ackFails = false } = {}) {
  const calls = [], sent = [], logs = []
  const world = { listed, deliveries: {} }
  const run = async (id, args) => {
    calls.push([id, ...args].join(' '))
    if (args[2] === 'list') return { notices: world.listed }
    if (args[2] === 'ack') { if (ackFails) throw Object.assign(new Error('x'), { code: 'LATTICE_CLI_EXIT_1' }); return { acked: [] } }
    throw new Error(`unexpected ${args}`)
  }
  const effect = async (method, params) => {
    assert.equal(method, 'messages.send')
    sent.push(params)
    const delivery = world.deliveries[params.target] ?? 'running'
    if (delivery === 'throw') throw Object.assign(new Error('LATTICE_INVALID'), { code: 'LATTICE_INVALID' })
    return { delivery, deliveryId: delivery === 'refused' ? null : 'd1' }
  }
  return { delivery: createNoticeDelivery({ run, log: line => logs.push(line) }), calls, sent, logs, world, effect }
}

test('notices: a run result is sent to roster lanes from the releasing Bot and acked per lane; others are skipped', async () => {
  const x = rig()
  const notices = [notice('n1', 'bot-b'), notice('n2', 'bot-b'), notice('n3', 'owner'), notice('n4', 'bot-a'), notice('n5', 'bot-gone')]
  await x.delivery.afterRun('alpha', { notices }, { from: 'bot-a', roster: roster(['bot-a', 'bot-b']), effect: x.effect })
  assert.deepEqual(x.sent.map(item => [item.from, item.target]), [['bot-a', 'bot-b'], ['bot-a', 'bot-b']])
  assert.match(x.sent[0].message, /information, not a request[\s\S]*p1\/t-n1 「Task n1」 on chart alpha \(lane bot-b\) can start now \(prerequisite done of p1\/t0 by bot-a\)\.\nWhether and when to start is your call[\s\S]*For reference, if you start it: lattice todo start/)
  assert.doesNotMatch(x.sent[0].message, /^Next:/m, 'next_action is never phrased as an instruction')
  // the releasing Bot's own notice is acked without a message (it sees it in its tool result); owner / unknown lanes stay unacked
  assert.deepEqual(x.calls, ['alpha todo notice ack --lane bot-b --notice n1,n2', 'alpha todo notice ack --lane bot-a --notice n4'])
})

test('notices: a failed send stays unacked and is re-listed at the next run; refused is acked; notices:null re-lists at once', async () => {
  const x = rig()
  const context = { from: 'bot-a', roster: roster(['bot-a', 'bot-b', 'bot-c']), effect: x.effect }
  x.world.deliveries = { 'bot-b': 'failed', 'bot-c': 'refused' }
  await x.delivery.afterRun('alpha', { notices: [notice('n1', 'bot-b'), notice('n2', 'bot-c')] }, context)
  assert.deepEqual(x.calls, ['alpha todo notice ack --lane bot-c --notice n2'], 'failed is not acked, not retried in the same run')
  x.world.deliveries = {}; x.world.listed = [notice('n1', 'bot-b')]; x.calls.length = 0; x.sent.length = 0
  await x.delivery.afterRun('alpha', { exitCode: 0 }, context)
  assert.deepEqual([x.calls, x.sent.map(item => item.from)], [['alpha todo notice list --json', 'alpha todo notice ack --lane bot-b --notice n1'], ['bot-a']],
    'recovery sends from the trigger actor when it is a roster Bot')
  x.calls.length = 0
  await x.delivery.afterRun('alpha', { exitCode: 0 }, context)
  assert.deepEqual(x.calls, [], 'nothing pending: no list')
  x.world.listed = [notice('n9', 'bot-b', { triggers: [{ plan_key: 'p1', task_id: 't0', kind: 'done', actor: { agent: 'kite' } }] })]; x.sent.length = 0
  await x.delivery.afterRun('alpha', { notices: null, notices_unavailable: 'x' }, context)
  assert.deepEqual([x.calls.at(-2), x.sent.map(item => item.from)], ['alpha todo notice list --json', ['scheduler']])
})

test('notices: old body (effect refused) keeps everything unacked; empty roster waits; ack failure keeps the chart pending', async () => {
  const x = rig()
  x.world.deliveries = { 'bot-b': 'throw' }
  await x.delivery.afterRun('alpha', { notices: [notice('n1', 'bot-b')] }, { from: 'bot-a', roster: roster(['bot-b']), effect: x.effect })
  assert.deepEqual(x.calls, [])
  const y = rig()
  await y.delivery.afterRun('alpha', { notices: [notice('n1', 'bot-b')] }, { from: 'bot-a', roster: [], effect: y.effect })
  assert.deepEqual([y.sent, y.calls], [[], []])
  y.world.listed = [notice('n1', 'bot-b')]
  await y.delivery.afterRun('alpha', {}, { from: 'bot-a', roster: roster(['bot-b']), effect: y.effect })
  assert.equal(y.sent.length, 1, 'the next run with a roster recovers it')
  const z = rig({ ackFails: true })
  await z.delivery.afterRun('alpha', { notices: [notice('n1', 'bot-b')] }, { from: 'bot-a', roster: roster(['bot-b']), effect: z.effect })
  assert.deepEqual(z.logs, ['lattice-notice-ack alpha LATTICE_CLI_EXIT_1'])
  z.world.listed = []
  await z.delivery.afterRun('alpha', {}, { from: 'bot-a', roster: roster(['bot-b']), effect: z.effect })
  assert.equal(z.calls.at(-1), 'alpha todo notice list --json')
})

test('notices: a waiting notice wakes every roster waiter, tells a non-lane waiter who starts it, and acks once under the lane', async () => {
  const x = rig()
  const waiting = [{ agent: 'bot-b', since: '2026-11-12T09:00:00.000Z', reason: null }, { agent: 'bot-c', since: '2026-11-12T09:01:00.000Z', reason: 'needs the API' },
    { agent: 'owner', since: '2026-11-12T09:02:00.000Z', reason: null }]
  const notices = [notice('n1', 'bot-b', { waiting, waiting_digest: 'w1', acked_recipients: [] }),
    notice('n2', 'owner', { waiting: [waiting[1]], waiting_digest: 'w2', acked_recipients: [] }),
    notice('n3', 'bot-b', { waiting: [waiting[1]], waiting_digest: 'w3', acked_recipients: ['bot-b'] })]
  await x.delivery.afterRun('alpha', { notices }, { from: 'bot-a', roster: roster(['bot-a', 'bot-b', 'bot-c']), effect: x.effect })
  assert.deepEqual(x.sent.map(item => item.target), ['bot-b', 'bot-c', 'bot-c', 'bot-c'], 'owner is never sent; n3 skips bot-b (already informed)')
  assert.match(x.sent[0].message, /\(lane bot-b\), which you are waiting for \(todo wait since 2026-11-12T09:00:00.000Z\), can start now[\s\S]*Whether and when to start is your call[\s\S]*For reference, if you start it/)
  assert.match(x.sent[1].message, /which you are waiting for \(todo wait since 2026-11-12T09:01:00.000Z: needs the API\)[\s\S]*\nThe lane bot-b starts it; your wait ends when it is started or retired/)
  assert.doesNotMatch(x.sent[1].message, /For reference/, 'start command only for the lane')
  assert.deepEqual(x.calls, ['alpha todo notice ack --lane bot-b --notice n1,n3', 'alpha todo notice ack --lane owner --notice n2'])
})

test('notices: a failed waiter keeps the notice unacked; the retry wakes only that waiter, then acks', async () => {
  const x = rig()
  const context = { from: 'bot-a', roster: roster(['bot-a', 'bot-b', 'bot-c']), effect: x.effect }
  const n1 = notice('n1', 'bot-b', { waiting: [{ agent: 'bot-c', since: '2026-11-12T09:01:00.000Z', reason: null }], waiting_digest: 'w1', acked_recipients: [] })
  x.world.deliveries = { 'bot-c': 'failed' }
  await x.delivery.afterRun('alpha', { notices: [n1] }, context)
  assert.deepEqual([x.sent.map(item => item.target), x.calls], [['bot-b', 'bot-c'], []])
  x.world.deliveries = {}; x.world.listed = [n1]; x.sent.length = 0
  await x.delivery.afterRun('alpha', { exitCode: 0 }, context)
  assert.deepEqual([x.sent.map(item => item.target), x.calls], [['bot-c'], ['alpha todo notice list --json', 'alpha todo notice ack --lane bot-b --notice n1']])
})

test('notices: deliverAll lists every chart under its lock and sends at most NOTICE_SLICE', async () => {
  const x = rig({ listed: Array.from({ length: NOTICE_SLICE + 5 }, (_, i) => notice(`n${i}`, 'bot-b')) })
  const locked = []
  const out = await x.delivery.deliverAll(['alpha', 'beta'], { roster: roster(['bot-b']), effect: x.effect, lock: (id, fn) => { locked.push(id); return fn() } })
  assert.deepEqual([out, x.sent.length, locked], [{ delivered: NOTICE_SLICE, failed: 0 }, NOTICE_SLICE, ['alpha']])
  assert.ok(noticeMessage('alpha', notice('n', 'bot-b', { title: 'x'.repeat(5000) })).length <= 4000)
})

test('protocol: deliver root and messages.send effect', () => {
  const bad = fn => assert.throws(fn)
  validateLatticeRequest('deliver', {}, { generation: 'g' })
  bad(() => validateLatticeRequest('deliver', { x: 1 }, { generation: 'g' }))
  validateLatticeResult('deliver', { delivered: 1, failed: 0 })
  bad(() => validateLatticeResult('deliver', { delivered: -1, failed: 0 }))
  validateLatticeEffect('messages.send', { from: 'bot-a', target: 'bot-b', message: 'm' })
  bad(() => validateLatticeEffect('messages.send', { from: 'bot-a', target: 'bot-b', message: '' }))
  bad(() => validateLatticeEffect('messages.send', { from: 'bot-a', target: 'bot-b', message: 'x'.repeat(4001) }))
  bad(() => validateLatticeEffect('messages.send', { from: 'bot-a', target: 'bot-b' }))
  validateLatticeEffectResult('messages.send', { delivery: 'running', deliveryId: 'd' })
  validateLatticeEffectResult('messages.send', { delivery: 'refused', deliveryId: null, code: 'BOT_NOT_FOUND' })
  bad(() => validateLatticeEffectResult('messages.send', { delivery: '', deliveryId: 'd' }))
})

test('effects: messages.send goes through messenger.sendmessage; permanent refusals become refused, others throw', async () => {
  const seen = []
  let fail = null
  const messenger = { sendmessage: async value => { seen.push(value); if (fail) throw new Error(fail); return { delivery: 'running', delivery_id: 'd1', from: value.from, target: value.target } } }
  const effect = createLatticeEffects({ bots: { listForClient: async () => [] }, messenger })
  assert.deepEqual(await effect('messages.send', { from: 'bot-a', target: 'bot-b', message: 'm' }), { delivery: 'running', deliveryId: 'd1' })
  assert.deepEqual(seen, [{ from: 'bot-a', target: 'bot-b', message: 'm' }])
  fail = 'BOT_NOT_FOUND: bot-b'
  assert.deepEqual(await effect('messages.send', { from: 'bot-a', target: 'bot-b', message: 'm' }), { delivery: 'refused', deliveryId: null, code: 'BOT_NOT_FOUND' })
  const before = seen.length
  for (const params of [{ from: 'user', target: 'bot-b', message: 'm' }, { from: 'bot-a', target: 'user', message: 'm' }])
    assert.deepEqual(await effect('messages.send', params), { delivery: 'refused', deliveryId: null, code: 'LATTICE_SEND_USER_NOT_ALLOWED' })
  assert.equal(seen.length, before, "'user' never reaches the messenger")
  fail = 'AI_PAUSED'
  await assert.rejects(effect('messages.send', { from: 'bot-a', target: 'bot-b', message: 'm' }), /AI_PAUSED/)
})

test('facade: deliver is one root call; a refusing (old) child is swallowed', async () => {
  const calls = []
  let refuse = false
  const facade = createLatticeFacade({ controller: { request: async (method, params) => { calls.push([method, params]); if (refuse) throw Object.assign(new Error('x'), { code: 'LATTICE_INVALID' }); return { delivered: 2, failed: 0 } } } })
  assert.deepEqual(await facade.deliver(), { delivered: 2, failed: 0 })
  refuse = true
  assert.equal(await facade.deliver(), null)
  assert.deepEqual(calls, [['deliver', {}], ['deliver', {}]])
})
