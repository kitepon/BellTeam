import assert from 'node:assert/strict'
import test from 'node:test'
import { BotSessionState } from '../src/bot-session-state.mjs'

function fixture({ call = async () => ({}), bridge = null, hasJobs = () => false } = {}) {
  return new BotSessionState({ assertWorkAllowed() {}, executionBridge: () => bridge, call, invalidateRunning() {},
    activity: { configuration: () => false, interruption: () => false, waking: () => false, hasJobs, idle: () => true },
  })
}
const bot = { id: 'bot-synthetic', session: 'slot-synthetic' }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('席変更は配送実体なしでpending/返却済み拒否/通信不明を区別し自動再送しない', async () => {
  let calls = 0
  const response = deferred()
  const state = fixture({ call: async () => { calls++; return response.promise } })
  const pending = state.changeSession(bot, 'agent_launch', { session_name: bot.session })
  assert.equal(pending.executionIssued, true)
  assert.equal(pending.executionBound, false)
  assert.equal(state.sessionChanges.get(bot.id).has(pending), true)
  response.resolve({ synthetic: 'accepted' })
  assert.deepEqual(await pending, { synthetic: 'accepted' })
  assert.equal(state.sessionChanges.has(bot.id), false)
  assert.equal(calls, 1)
  state.call = async () => { calls++; throw Object.assign(new Error('synthetic returned refusal'), { aitermResponseReturned: true }) }
  await assert.rejects(state.changeSession(bot, 'pty_close', { session_id: bot.session }))
  assert.equal(state.uncertainChanges.has(bot.id), false)
  state.call = async () => { calls++; throw new Error('synthetic lost response') }
  await assert.rejects(state.changeSession(bot, 'pty_close', { session_id: bot.session }))
  assert.equal(state.uncertainChanges.get(bot.id), 'pty_close')
  assert.throws(() => state.requireSessionKnown(bot.id), { code: 'BOT_SESSION_UNCONFIRMED' })
  assert.equal(state.sessionChanges.has(bot.id), false)
  assert.equal(calls, 3)
})

test('既存停止の対象になった準備を発行前に終え、結果不明として次の席へ混ぜない', async () => {
  let calls = 0
  const stop = deferred()
  const state = fixture({ bridge: {}, call: async () => { calls++; return {} } })
  state.stopVersions.set(bot.id, 0)
  stop.promise.rootIds = new Set([bot.id])
  state.stopping = stop.promise
  const pending = state.changeSession(bot, 'agent_configure', { session_id: bot.session })
  assert.equal(pending.executionIssued, false)
  state.stopVersions.set(bot.id, 1)
  stop.resolve({ cascade: { targets: [] } })
  await assert.rejects(pending, { code: 'BOT_STOPPED', effect: 'not_started' })
  assert.equal(calls, 0)
  assert.equal(state.uncertainChanges.size, 0)
  assert.equal(state.sessionChanges.size, 0)
  state.stopping = null
  await state.changeSession({ id: 'other', session: 'other-slot' }, 'agent_configure', { session_id: 'other-slot' })
  assert.equal(calls, 1)
})

test('配送中の照合を拒否し、照合中に更新された同じ原因の不明を消さない', async () => {
  let busy = true, calls = 0
  const result = deferred()
  const request = { target_session_id: bot.session }
  const target = { session_id: bot.session, launch_id: 'synthetic-launch' }
  const state = fixture({ bridge: { closeLaunch() { calls++; return result.promise } }, hasJobs: () => busy })
  state.uncertainChanges.set(bot.id, 'agent_launch', request)
  await assert.rejects(state.closeLaunch(bot, request, target), { code: 'EXECUTION_BUSY', effect: 'not_started' })
  assert.equal(calls, 0)
  busy = false
  const pending = state.closeLaunch(bot, request, target)
  state.uncertainChanges.set(bot.id, 'agent_launch', request)
  result.resolve({ synthetic: 'close-result' })
  await assert.rejects(pending, { code: 'BOT_SESSION_UNCONFIRMED' })
  assert.equal(state.uncertainChanges.get(bot.id), 'agent_launch')
  assert.equal(state.sessionChanges.size, 0)
  assert.equal(calls, 1)
})
