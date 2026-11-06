import test from 'node:test'
import assert from 'node:assert/strict'
import { AitermTransport } from '../src/aiterm-transport.mjs'

test('new session-uncertain input: pre-registration pending, exact ready reuse and retained mutation ownership', async () => {
  const bot = { id: 'bot-new-input', session: 'bot-new-input', harness: 'codex', model: 'requested-model' }
  const launch = 'a'.repeat(32), calls = [], statuses = []
  let observation = { schema: 'aiterm.pty-observe-result.v1', session_id: bot.session, exists: false, launch_id: null, state: 'missing' }
  const transport = new AitermTransport({
    client: { call: async name => { calls.push(name); assert.equal(name, 'pty_observe'); return { structuredContent: structuredClone(observation) } } },
    executionBridge: { reserve: async input => {
      calls.push('register')
      const handle = { reservation: { request: input.request, target: { session_id: input.targetSession, expected_launch_id: input.expectedLaunch } },
        issued: new Set(), binding: null,
        invoke: async name => {
          calls.push(name); assert.equal(name, 'pty_send'); handle.issued.add('send')
          handle.binding = { target: { launch: { session_id: bot.session, launch_id: launch }, boundary: { event_cursor: 1 } } }
          return { structuredContent: { mode: 'agent_dispatch', event_cursor: 1, wait_process: { executable: 'fixture', args: [] } } }
        }, finish: async () => { calls.push('finish') } }
      return handle
    } }, waitProcess: async () => ({ outcome: 'done' }),
  })
  transport.uncertainChanges.set(bot.id, 'agent_configure', { old: 'retained' })
  const unknown = transport.uncertainChanges.version(bot.id), sessions = transport.sessions, jobs = transport.jobs
  const input = id => transport.submit(bot, 'new synthetic input', { info: { context: 'direct', groupId: id }, onStatus: (status, error) => statuses.push({ status, error }) })
  const pending = input('new-pending')
  await assert.rejects(pending.accepted, error => error.normalInputPending?.deliveryId === 'new-pending'
    && error.normalInputPending.stage === 'before_execution_registration' && error.effect === 'not_started')
  await assert.rejects(pending)
  assert.deepEqual(calls, ['pty_observe'])
  assert.equal(statuses[0].error.normalInputPending.sessionId, bot.session)
  observation = { ...observation, exists: true, launch_id: launch, state: 'idle', pane_alive: true, harness_alive: true }
  const accepted = input('new-ready')
  assert.deepEqual(await accepted.accepted, { delivery: 'running' }); await accepted
  assert.equal(calls.filter(name => name === 'pty_send').length, 1)
  assert.equal(await transport.wake(bot), bot.session)
  assert.equal(await transport.wake(bot, { execution: { reservation: { target: { session_id: bot.session, expected_launch_id: launch } } } }), bot.session)
  await assert.rejects(transport.wake(bot, { execution: { reservation: { target: { session_id: bot.session, expected_launch_id: null } } } }), { code: 'BOT_SESSION_UNCONFIRMED' })
  for (const patch of [{ state: 'unknown' }, { session_id: 'wrong' }]) {
    const original = observation; observation = { ...original, ...patch }
    const refused = input('new-unproven')
    await assert.rejects(refused.accepted, error => error.code === 'BOT_SESSION_UNCONFIRMED' && !error.normalInputPending)
    await assert.rejects(refused); observation = original
  }
  const count = calls.length
  transport.requireAccess = async () => { throw Object.assign(Error('denied'), { code: 'BOT_FORBIDDEN' }) }
  await assert.rejects(transport.wake(bot), { code: 'BOT_FORBIDDEN' }); assert.equal(calls.length, count)
  transport.requireAccess = async () => {}
  transport.observe = async () => { transport.sessionState.invalidate(bot.id); return observation }
  await assert.rejects(transport.wake(bot), { code: 'BOT_STOPPED' })
  assert.equal(transport.uncertainChanges.version(bot.id), unknown)
  assert.equal(transport.sessions, sessions); assert.equal(transport.jobs, jobs)
  assert.equal(bot.model, 'requested-model')
  assert.throws(() => transport.changeSession(bot, 'agent_configure', {}), { code: 'BOT_SESSION_UNCONFIRMED' })
  assert.equal(calls.some(name => ['agent_launch', 'pty_close', 'agent_configure'].includes(name)), false)
})
