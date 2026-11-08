import assert from 'node:assert/strict'
import test from 'node:test'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { DeliveryJob } from '../src/delivery-job.mjs'
import { executionFailureReport } from '../src/execution-failure-report.mjs'

const jobId = 'abaf531c-4026-4b76-83d7-b6082c737ac7'
const groupId = '6efeff27-6851-4570-a222-1e97d6f27fb7'
const bot = { id: 'bot-fixture', session: 'fixture-session', harness: 'codex' }
const receipt = { mode: 'agent_dispatch', event_cursor: 1, wait_process: {} }
const abortError = () => Object.assign(new Error('private-canary'), { code: 'ABORT_ERR' })

for (const stopped of [false, true]) test(`wait abort snapshot with local stopped=${stopped}`, async () => {
  const original = abortError(), reports = []
  const job = new DeliveryJob({ id: jobId, bot, info: { groupId, message: 'private-canary' }, startedAt: '2026-11-03T00:00:00Z' })
  const transport = new AitermTransport({ waitProcess: async (_process, signal) => {
    if (stopped) job.markStopped()
    assert.equal(signal.aborted, stopped)
    throw original
  }, reportError(report) { reports.push(report); throw Error('private-canary') } })
  await assert.rejects(transport.waitForTurnCompletion(job, { receipt }), error => error === original)
  assert.equal(job.waitFailure, original)
  assert.equal(reports.length, 1)
  assert.equal(reports[0].code, 'SERVER_TURN_TRACKING_FAILED')
  assert.deepEqual(JSON.parse(reports[0].diagnostic_log), {
    schema: 'bellteam.execution-failure.v1', botId: bot.id, phase: 'delivery_wait', errorCode: 'ABORT_ERR',
    jobId, groupId, stopRequested: false, stopped, waitAborted: stopped,
  })
  assert.doesNotMatch(JSON.stringify(reports), /private-canary/)
})

test('snapshot precedes interim stop and does not claim later stop caused the original failure', async () => {
  const original = Object.assign(new Error('private-canary'), { code: 'SEAT_PROCESS_FAILED', exitCode: 2 }), reports = []
  const job = new DeliveryJob({ id: jobId, bot, info: { groupId }, startedAt: '' })
  job.follows = true
  const transport = new AitermTransport({ waitProcess: async () => { throw original }, reportError: report => reports.push(report) })
  transport.followInterim = () => ({ async stop() { job.markStopped(); return { error: false } } })
  await assert.rejects(transport.waitForTurnCompletion(job, { receipt }, () => {}), error => error === original)
  const detail = JSON.parse(reports[0].diagnostic_log)
  assert.equal(job.stopped, true)
  assert.deepEqual([detail.stopped, detail.waitAborted, detail.errorCode, detail.exitCode], [false, false, 'SEAT_PROCESS_FAILED', 2])
})

test('only safe delivery context fields are emitted; other phases and absent fields stay unchanged', () => {
  const error = abortError()
  const unsafe = { jobId: 'private-canary', groupId: `${groupId}\nprivate-canary`, stopRequested: 'false',
    stopped: 1, waitAborted: null, message: 'private-canary', receipt: { secret: 'private-canary' } }
  const baseline = executionFailureReport(bot.id, 'delivery_wait', error)
  assert.deepEqual(executionFailureReport(bot.id, 'delivery_wait', error, unsafe), baseline)
  assert.deepEqual(executionFailureReport(bot.id, 'delivery_wait', error, null), baseline)
  for (const phase of ['configuration', 'seat_watch']) {
    assert.deepEqual(executionFailureReport(bot.id, phase, error, { jobId, groupId, stopped: true }),
      executionFailureReport(bot.id, phase, error))
  }
  const detail = JSON.parse(executionFailureReport(bot.id, 'delivery_wait', error, { stopRequested: true }).diagnostic_log)
  assert.equal(detail.stopRequested, true)
  assert.equal(Object.hasOwn(detail, 'jobId'), false)
  assert.equal(Object.hasOwn(detail, 'stopped'), false)
})

for (const outcome of ['done', 'error', 'rate_limited']) test(`native outcome ${outcome} does not gain a tracking diagnostic`, async () => {
  const job = new DeliveryJob({ id: jobId, bot, info: { groupId }, startedAt: '' }), reports = []
  const transport = new AitermTransport({ waitProcess: async () => ({ outcome,
    ...(outcome === 'rate_limited' ? { rate_limit: 'fixture limit' } : {}) }), reportError: report => reports.push(report) })
  const waiting = transport.waitForTurnCompletion(job, { receipt })
  if (outcome === 'done') await waiting
  else await assert.rejects(waiting, error => error.turnCompleted === true)
  assert.deepEqual(reports, [])
})

test('accepted fake delivery cancelled locally remains stopped with one diagnostic and one send', async () => {
  const reports = [], statuses = [], calls = [], original = abortError()
  const transport = new AitermTransport({ activeId: () => jobId,
    client: { async call(name) { calls.push(name); assert.equal(name, 'pty_send'); return { structuredContent: receipt } } },
    waitProcess: async () => { [...transport.activity.jobs][0].markStopped(); throw original },
    reportError: report => reports.push(report) })
  const completion = transport.submit(bot, 'synthetic input', { info: { groupId }, onStatus: (...values) => statuses.push(values) })
  const rejected = assert.rejects(completion, { code: 'BOT_STOPPED' })
  assert.deepEqual(await completion.accepted, { delivery: 'running' })
  await rejected
  assert.deepEqual(statuses.map(([status]) => status), ['running', 'stopped'])
  assert.equal(statuses[1][2], undefined)
  assert.deepEqual(calls, ['pty_send'])
  assert.equal(reports.length, 1)
  assert.deepEqual([JSON.parse(reports[0].diagnostic_log).stopped, JSON.parse(reports[0].diagnostic_log).waitAborted], [true, true])
})

test('accepted delivery failing before its end names its step and a code token only', () => {
  const job = '11111111-1111-4111-8111-111111111111', group = '22222222-2222-4222-8222-222222222222'
  const report = executionFailureReport('bot-a', 'delivery_completion',
    Object.assign(new Error('AITERM_TRANSCRIPT_TURN_MISMATCH private words'), { turnCompleted: true }),
    { jobId: job, groupId: group, step: 'answer', extra: 'dropped' })
  assert.equal(report.code, 'SERVER_TURN_TRACKING_FAILED')
  assert.deepEqual(JSON.parse(report.diagnostic_log), { schema: 'bellteam.execution-failure.v1', botId: 'bot-a',
    phase: 'delivery_completion', step: 'answer', jobId: job, groupId: group, errorCode: 'AITERM_TRANSCRIPT_TURN_MISMATCH' })
  const coded = JSON.parse(executionFailureReport('bot-a', 'delivery_completion', Object.assign(new Error('x'), { code: 'CONVERSATION_NOT_ACCEPTED' }), { step: 'bogus' }).diagnostic_log)
  assert.equal(coded.errorCode, 'CONVERSATION_NOT_ACCEPTED'); assert.equal(coded.step, 'other')
  assert.equal(JSON.parse(executionFailureReport('bot-a', 'delivery_completion', new Error('free text')).diagnostic_log).errorCode, 'UNKNOWN')
})
