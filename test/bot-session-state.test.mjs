import assert from 'node:assert/strict'
import test from 'node:test'
import { BotSessionState } from '../src/bot-session-state.mjs'

function fixture({ call = async () => ({}), bridge = null, hasJobs = () => false, writeLog = () => {} } = {}) {
  return new BotSessionState({ assertWorkAllowed() {}, executionBridge: () => bridge, call, invalidateRunning() {},
    activity: { configuration: () => false, interruption: () => false, waking: () => false, hasJobs, idle: () => true },
    writeLog,
  })
}
const bot = { id: 'bot-synthetic', session: 'slot-synthetic' }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('席のclose/新launchは返却後に状態だけ記録し本文やenvを残さない', async () => {
  const lines = [], response = deferred()
  const state = fixture({ call: async () => response.promise, writeLog: line => lines.push(line) })
  const pending = state.changeSession(bot, 'pty_close', { session_id: bot.session })
  assert.deepEqual(lines, [])
  const receipt = { content: [{ type: 'text', text: 'private-close-text' }], structuredContent: {
    schema: 'aiterm.pty-close-result.v1', session_id: bot.session, outcome: 'closed', private: 'private-close-field' } }
  response.resolve(receipt)
  assert.equal(await pending, receipt)
  const launch = { structuredContent: { schema: 'aiterm.agent-launch-result.v1', session_id: bot.session,
    launch_id: 'a'.repeat(32), startup: { status: 'ready', reason: 'private-startup-text' },
    initial_prompt: { status: 'not_requested', prompt: 'private-prompt' }, env: { TOKEN: 'private-token' } } }
  state.call = async () => launch
  assert.equal(await state.changeSession(bot, 'agent_launch', { session_name: bot.session, env_vars: ['TOKEN'] }), launch)
  const reports = lines.map(line => JSON.parse(line.slice('BellTeam session result: '.length)))
  assert.deepEqual(reports.map(r => [r.tool, r.returned, r.isError, r.session_id, r.outcome, r.startup, r.initial_prompt]), [
    ['pty_close', true, false, bot.session, 'closed', null, null],
    ['agent_launch', true, false, bot.session, null, 'ready', 'not_requested'],
  ])
  assert.equal(reports[1].launch_id, 'a'.repeat(32))
  assert.equal(lines.join('').includes('private-'), false)
  assert.equal(lines.join('').includes('TOKEN'), false)
})

test('返却済みclose拒否と通信不明を分け、ログ障害で結果や再送回数を変えない', async () => {
  const lines = []; let calls = 0
  const refusal = Object.assign(new Error('private-failure-text'), { aitermResponseReturned: true, code: 'CLOSE_REFUSED' })
  const state = fixture({ call: async () => { calls++; throw refusal }, writeLog: line => lines.push(line) })
  await assert.rejects(state.changeSession(bot, 'pty_close', { session_id: bot.session }), error => error === refusal)
  assert.equal(state.uncertainChanges.has(bot.id), false)
  state.call = async () => { calls++; throw new Error('private-disconnected') }
  await assert.rejects(state.changeSession(bot, 'pty_close', { session_id: bot.session }))
  assert.equal(state.uncertainChanges.get(bot.id), 'pty_close')
  assert.deepEqual(lines.map(line => { const r = JSON.parse(line.slice('BellTeam session result: '.length)); return [r.returned, r.isError, r.error] }),
    [[true, true, 'CLOSE_REFUSED'], [false, null, null]])
  assert.equal(lines.join('').includes('private-'), false)
  const other = fixture({ call: async () => { calls++; return {} }, writeLog() { throw new Error('logger failed') } })
  assert.deepEqual(await other.changeSession(bot, 'pty_close', { session_id: bot.session }), {})
  assert.equal(other.sessionChanges.size, 0)
  assert.equal(calls, 3)
})

test('不正な返却の値や未発行操作をログ上の正常receiptへ補わない', async () => {
  const lines = []
  const state = fixture({ call: async () => ({ structuredContent: { schema: 'private-schema', session_id: 'private value',
    launch_id: 'private-launch', outcome: 'private-outcome', startup: { status: 'private-status' } } }), writeLog: line => lines.push(line) })
  await state.changeSession(bot, 'agent_launch', { session_name: bot.session })
  const r = JSON.parse(lines[0].slice('BellTeam session result: '.length))
  assert.deepEqual([r.schema, r.session_id, r.launch_id, r.outcome, r.startup], [null, null, null, null, null])
  assert.equal(lines.join('').includes('private-'), false)
  await state.changeSession(bot, 'agent_configure', { session_id: bot.session })
  assert.equal(lines.length, 1)
})

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
