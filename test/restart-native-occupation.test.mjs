import test from 'node:test'
import assert from 'node:assert/strict'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { DeliveryJob } from '../src/delivery-job.mjs'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const closeResult = session => ({ structuredContent: {
  schema: 'aiterm.pty-close-result.v1', session_id: session, outcome: 'closed',
} })

async function acceptedFixture({ close = closeResult('old-session'), ack } = {}) {
  const bot = { id: 'bot-recovery', session: 'old-session' }
  const gate = new ConversationLifetimes('original-generation'), root = gate.enter()
  const statuses = [], waiting = Promise.withResolvers(), calls = []
  const delivery = gate.registerDelivery(root, { deliveryId: 'original-delivery', target: bot.id,
    kinds: ['delivery.status'], dispatch: async (_kind, params) => {
      statuses.push(params)
      if (params.delivery !== 'running' && ack) return ack.promise
      return { applied: true }
    } })
  const transport = new AitermTransport({ conversationAdmission: gate, waitProcess: (_process, signal) => {
    signal.addEventListener('abort', () => waiting.reject(Error('wait aborted after close')), { once: true })
    return waiting.promise
  }, client: { async call(name, args) {
    calls.push({ name, args }); assert.equal(name, 'pty_close'); return close
  } } })
  transport.dispatchInOrder = async () => ({ session: transport.session(bot),
    receipt: { mode: 'agent_dispatch', event_cursor: 1, wait_process: { executable: 'synthetic', args: [] } } })
  transport.wake = async () => { calls.push({ name: 'wake' }); transport.sessions.set(bot.id, 'new-session'); return 'new-session' }
  const result = transport.turn(bot, 'original synthetic input', {
    queue: { groupId: 'original-delivery' }, conversationDelivery: delivery,
  })
  result.catch(() => {})
  await result.accepted
  const job = [...transport.activity.jobs][0]
  gate.finish(root)
  return { bot, gate, root, delivery, statuses, waiting, calls, transport, result, job }
}

test('confirmed session closure retires old native occupation without rewriting its unknown result', async () => {
  const bot = { id: 'bot-recovery', session: 'old-session' }, calls = []
  const transport = new AitermTransport({ client: { async call(name, args) {
    calls.push({ name, args })
    assert.equal(name, 'pty_close')
    return { structuredContent: { schema: 'aiterm.pty-close-result.v1', session_id: args.session_id, outcome: 'closed' } }
  } } })
  transport.wake = async () => { calls.push({ name: 'wake' }); return 'new-session' }
  const unknown = Error('original native completion unknown')
  const job = new DeliveryJob({ id: 'original-job', bot, info: {}, startedAt: 'original-time' })
  job.nativeUnconfirmed = unknown
  job.nativeSession = 'old-session'
  job.receipt = { session_id: 'old-session', mode: 'agent_dispatch', event_cursor: 1 }
  job.completion = Promise.resolve()
  transport.activity.register(job); transport.activity.admit(job)
  const other = { id: 'other-job', bot: { id: 'other-bot' }, nativeUnconfirmed: Error('other unknown') }
  transport.activity.register(other); transport.activity.admit(other)
  assert.throws(() => transport.assertConversationOccupation(bot.id), { code: 'CONVERSATION_NOT_ACCEPTED' })

  assert.deepEqual(await transport.restart(bot), { botId: bot.id, session: 'new-session' })

  assert.doesNotThrow(() => transport.assertConversationOccupation(bot.id))
  assert.equal(transport.activity.idle(bot.id), true)
  assert.equal(job.nativeUnconfirmed, unknown)
  assert.equal(job.receipt.session_id, 'old-session')
  assert.equal(job.stopped, true)
  assert.throws(() => transport.assertConversationOccupation('other-bot'), { code: 'CONVERSATION_NOT_ACCEPTED' })
  assert.deepEqual(calls.map(call => call.name), ['pty_close', 'wake'])
})

test('normal restart retires the real unknown native lifetime while retaining original failure and receipt', async () => {
  const f = await acceptedFixture(), failure = Error('original native failure')
  f.waiting.reject(failure)
  await assert.rejects(f.result, error => error === failure); await tick()
  const receipt = f.job.receipt
  assert.equal(f.gate.snapshot().unconfirmed, true)
  assert.equal(f.gate.snapshot().active, 2)

  await f.transport.restart(f.bot); await tick()

  assert.equal(f.transport.activity.idle(f.bot.id), true)
  assert.equal(f.job.nativeUnconfirmed, failure)
  assert.equal(f.job.receipt, receipt)
  assert.equal(f.job.nativeClosure.session_id, 'old-session')
  assert.equal(f.gate.snapshot().unconfirmed, false)
  assert.equal(f.gate.snapshot().active, 0)
  assert.deepEqual(f.statuses.map(value => value.delivery), ['running', 'failed'])
  assert.doesNotThrow(() => f.transport.assertConversationOccupation(f.bot.id))
  const root = f.gate.enter(), delivery = f.gate.registerDelivery(root, { deliveryId: 'new-delivery', target: f.bot.id,
    kinds: [], dispatch: async () => ({ applied: true }) })
  f.transport.waitProcess = async () => ({ outcome: 'done', turn_id: 'new-turn' })
  f.transport.client.call = async name => {
    assert.equal(name, 'pty_read')
    return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', turn_id: 'new-turn', text: 'new reply' } }
  }
  assert.equal(await f.transport.turn(f.bot, 'new synthetic request', {
    queue: { groupId: 'new-delivery' }, conversationDelivery: delivery,
  }), 'new reply')
  f.gate.finish(root)
  await tick()
  assert.equal(f.gate.snapshot().active, 0)
})

test('closure before waiter rejection does not recreate unknown occupation or complete a pending save ACK', async () => {
  const ack = Promise.withResolvers(), f = await acceptedFixture({ ack })
  await f.transport.restart(f.bot); await tick()
  assert.equal(f.gate.snapshot().unconfirmed, false)
  assert.equal(f.gate.snapshot().active, 2, 'real pending save ACK must remain')
  assert.ok(f.job.nativeUnconfirmed)
  assert.equal(f.job.nativeClosure.session_id, 'old-session')
  ack.resolve({ applied: true })
  await assert.rejects(f.result, { code: 'BOT_STOPPED' }); await tick()
  assert.equal(f.gate.snapshot().active, 0)
  assert.equal(f.transport.activity.idle(f.bot.id), true)
})

test('invalid or missing closure retains the original unknown and never launches', async () => {
  for (const close of [{}, { isError: true, ...closeResult('old-session') }, closeResult('other-session'),
    { structuredContent: { ...closeResult('old-session').structuredContent, outcome: 'unknown' } }]) {
    const f = await acceptedFixture({ close }), failure = Error('original unknown')
    f.waiting.reject(failure); await assert.rejects(f.result, error => error === failure); await tick()
    await assert.rejects(f.transport.restart(f.bot), { code: 'BOT_SESSION_UNCONFIRMED' })
    assert.equal(f.job.nativeUnconfirmed, failure)
    assert.equal(f.transport.activity.idle(f.bot.id), false)
    assert.equal(f.gate.snapshot().unconfirmed, true)
    assert.deepEqual(f.calls.map(value => value.name), ['pty_close'])
  }
})

test('missing original session binding or old parent capability refuses before close', async () => {
  for (const missing of ['nativeSession', 'parentCapability']) {
    const f = await acceptedFixture(), failure = Error('original unknown')
    f.waiting.reject(failure); await assert.rejects(f.result, error => error === failure); await tick()
    if (missing === 'nativeSession') delete f.job.nativeSession
    else f.gate.confirmNativeClosure = undefined
    await assert.rejects(f.transport.restart(f.bot), { code: 'CONVERSATION_RECOVERY_UNAVAILABLE' })
    assert.deepEqual(f.calls, [])
    assert.equal(f.job.nativeUnconfirmed, failure)
    assert.equal(f.gate.snapshot().unconfirmed, true)
  }
})

test('closure retirement rejects a different receipt and forged delivery opaque', async () => {
  const f = await acceptedFixture(), failure = Error('original unknown')
  f.waiting.reject(failure); await assert.rejects(f.result, error => error === failure); await tick()
  assert.throws(() => f.gate.confirmNativeClosure(f.delivery, { ...f.job.receipt }, closeResult('old-session')))
  assert.throws(() => f.gate.confirmNativeClosure({ ...f.delivery }, f.job.receipt, closeResult('old-session')))
  assert.equal(f.gate.snapshot().unconfirmed, true)
  assert.equal(f.gate.snapshot().active, 2)
})

test('confirmed native closure does not clear an independently failed callback', async () => {
  const ack = Promise.withResolvers(), f = await acceptedFixture({ ack })
  await f.transport.restart(f.bot); await tick()
  ack.resolve({ applied: false })
  await assert.rejects(f.result); await tick()
  assert.equal(f.gate.inspectAdmission().failed, true)
  assert.equal(f.gate.snapshot().unconfirmed, true)
  assert.throws(() => f.gate.enter(), { code: 'CONVERSATION_NOT_ACCEPTED' })
})

test('a send receipt returning after confirmed close consumes that original session closure without replay', async () => {
  const bot = { id: 'bot-late-receipt', session: 'old-session' }, gate = new ConversationLifetimes('generation')
  const root = gate.enter(), entered = Promise.withResolvers(), sent = Promise.withResolvers(), calls = []
  const delivery = gate.registerDelivery(root, { deliveryId: 'late-delivery', target: bot.id,
    kinds: [], dispatch: async () => ({ applied: true }) })
  const transport = new AitermTransport({ conversationAdmission: gate, waitProcess: (_process, signal) => {
    assert.equal(signal.aborted, true)
    return Promise.reject(Error('closed original waiter'))
  }, client: { async call(name, args) {
    calls.push({ name, args })
    if (name === 'pty_send') { entered.resolve(); return sent.promise }
    assert.equal(name, 'pty_close'); return closeResult(args.session_id)
  } } })
  transport.wake = async () => { transport.sessions.set(bot.id, 'new-session'); return 'new-session' }
  const result = transport.turn(bot, 'original synthetic input', {
    queue: { groupId: 'late-delivery' }, conversationDelivery: delivery,
  })
  result.catch(() => {}); result.accepted.catch(() => {})
  await entered.promise
  const job = [...transport.activity.jobs][0]
  await transport.restart(bot)
  sent.resolve({ structuredContent: { mode: 'agent_dispatch', event_cursor: 1,
    wait_process: { executable: 'synthetic', args: [] } } })
  await assert.rejects(result, { code: 'BOT_STOPPED' }); gate.finish(root); await tick()
  assert.equal(job.receipt.mode, 'agent_dispatch')
  assert.equal(job.nativeClosure.session_id, 'old-session')
  assert.equal(transport.activity.idle(bot.id), true)
  assert.equal(gate.snapshot().active, 0)
  assert.equal(gate.snapshot().unconfirmed, false)
  assert.equal(calls.filter(call => call.name === 'pty_send').length, 1)
  assert.equal(calls.find(call => call.name === 'pty_send').args.session_id, 'old-session')
})
