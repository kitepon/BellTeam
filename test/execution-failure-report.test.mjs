import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { BotAdministration } from '../src/bot-administration.mjs'
import { Diagnostics } from '../src/diagnostics.mjs'
import { executionFailureReport, reportExecutionFailure } from '../src/execution-failure-report.mjs'
import { runWaitProcess } from '../src/aiterm-wait-process.mjs'

const root = process.env.BELLTEAM_EXECUTION_FAILURE_SOURCE
  ? pathToFileURL(process.env.BELLTEAM_EXECUTION_FAILURE_SOURCE + '/') : new URL('../', import.meta.url)
const { AitermTransport } = await import(new URL('src/aiterm-transport.mjs', root))
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const bot = { id: 'bot-a', session: 'bot-a', harness: 'codex', model: 'old', reasoningEffort: 'high', fastMode: false }
const running = id => ({ state: 'running', turn_id: id, wait_process: { executable: process.execPath, args: [] } })
const failedProcess = () => Object.assign(new Error('synthetic-secret-message'), {
  code: 'SEAT_PROCESS_FAILED', exitCode: 3, signal: null, stderr: 'synthetic-secret-stderr', stack: 'synthetic-secret-stack',
})

function watchFixture(t, waitProcess, reportError = () => {}) {
  const calls = []
  let turn = running('turn-a')
  const transport = new AitermTransport({ waitProcess, reportError,
    client: { async call(name, args) {
      calls.push([name, args])
      if (name === 'pty_list') return { _meta: { 'aiterm/seat_turns': {
        schema: 'aiterm.seat-turns.v1', seats: [{ session_id: bot.session, turn }],
      } } }
      assert.equal(name, 'agent_configure')
      return {}
    } },
  })
  t.after(() => transport.close())
  return { transport, calls, setTurn: value => { turn = value } }
}

test('waiter failures retain watch until native idle before configure', { timeout: 10_000 }, async t => {
  const failed = deferred(), reports = []
  const f = watchFixture(t, async () => { failed.resolve(); throw failedProcess() }, report => {
    reports.push(report); throw Error('diagnostic fixture failure')
  })
  await f.transport.watchSeatTurns([bot]); await failed.promise; await tick()
  const configure = f.transport.reconfigure(bot, { ...bot, model: 'next' })
  await tick()
  assert.equal(f.transport.isIdle(bot.id), false)
  assert.equal(f.calls.some(([name]) => name === 'agent_configure'), false)
  f.setTurn(null); await f.transport.watchSeatTurns([bot]); await tick()
  assert.equal(f.transport.isIdle(bot.id), false)
  assert.equal(f.calls.some(([name]) => name === 'agent_configure'), false)
  f.setTurn({ state: 'unknown' }); await f.transport.watchSeatTurns([bot]); await tick()
  assert.equal(f.transport.isIdle(bot.id), false)
  assert.equal(f.calls.some(([name]) => name === 'agent_configure'), false)
  f.setTurn({ state: 'idle' }); await f.transport.watchSeatTurns([bot]); await configure
  assert.equal(f.calls.filter(([name]) => name === 'agent_configure').length, 1)
  assert.equal(reports.length, 1)
  assert.deepEqual(JSON.parse(reports[0].diagnostic_log), {
    schema: 'bellteam.execution-failure.v1', botId: bot.id, phase: 'seat_watch',
    errorCode: 'SEAT_PROCESS_FAILED', exitCode: 3, signal: null,
  })
  assert.doesNotMatch(JSON.stringify(reports), /synthetic-secret/u)
})

test('a replacement running turn stays busy and survives the previous watch finally', { timeout: 10_000 }, async t => {
  let waits = 0
  const nextDone = deferred()
  const f = watchFixture(t, async () => {
    if (++waits === 1) throw failedProcess()
    return nextDone.promise
  })
  t.after(() => nextDone.resolve({ outcome: 'done' }))
  await f.transport.watchSeatTurns([bot]); await tick()
  const old = f.transport.watches.get(bot.id)
  const configure = f.transport.reconfigure(bot, { ...bot, model: 'next' })
  f.setTurn(running('turn-b')); await f.transport.watchSeatTurns([bot]); await tick()
  const next = f.transport.watches.get(bot.id)
  assert.notEqual(next, old)
  assert.equal(next.turnId, 'turn-b')
  assert.equal(f.transport.isIdle(bot.id), false)
  assert.equal(f.calls.some(([name]) => name === 'agent_configure'), false)
  nextDone.resolve({ outcome: 'done' }); await configure
  assert.equal(f.transport.watches.size, 0)
  assert.equal(f.calls.filter(([name]) => name === 'agent_configure').length, 1)
})

test('malformed real waiter output records a safe diagnostic and holds until native absence', { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'execution-wait-diagnostic-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'diagnostics.json'), diagnostics = new Diagnostics(path)
  await diagnostics.initialize()
  const recorded = deferred()
  const f = watchFixture(t, (_process, signal) => runWaitProcess({ executable: process.execPath,
    args: ['-e', "process.stdout.write('synthetic-secret-invalid-json');process.exitCode=1"] }, signal),
  async report => { await diagnostics.record(report); recorded.resolve() })
  await f.transport.watchSeatTurns([bot]); await recorded.promise
  assert.equal(f.transport.isIdle(bot.id), false)
  const [row] = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(row.category, 'SERVER_TURN_TRACKING_FAILED')
  assert.equal(JSON.parse(row.diagnostic_log).errorCode, 'AITERM_WAIT_INVALID')
  assert.equal(JSON.parse(row.diagnostic_log).exitCode, 1)
  assert.equal(JSON.parse(row.diagnostic_log).signal, null)
  assert.doesNotMatch(JSON.stringify(row), /synthetic-secret/u)
  f.setTurn(undefined); await f.transport.watchSeatTurns([bot]); await f.transport.idle(bot.id)
})

test('configuration failure reaches Diagnostics with the original typed effect and no raw text', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'execution-config-diagnostic-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'diagnostics.json'), diagnostics = new Diagnostics(path)
  await diagnostics.initialize()
  const bots = new Map([[bot.id, bot]]), logs = []
  bots.previewUpdate = async (id, changes) => ({ ...bots.get(id), ...changes })
  bots.update = async (id, changes) => { const value = { ...bots.get(id), ...changes }; bots.set(id, value); return value }
  let calls = 0
  const admin = new BotAdministration({ bots, writeLog: line => logs.push(line), reportError: report => diagnostics.record(report),
    transport: { async isRunning() { return true }, async reconfigure() {
      calls++
      throw Object.assign(failedProcess(), { effect: 'not_started' })
    } },
  })
  await admin.update(bot.id, { model: 'next' }); await tick(); await diagnostics.pending
  const application = admin.view(bots.get(bot.id)).configurationApplication
  assert.deepEqual([application.state, application.outcome, application.effect], ['failed', 'not_applied', 'not_started'])
  const [row] = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(row.category, 'SERVER_MODEL_CONFIGURATION_FAILED')
  const detail = JSON.parse(row.diagnostic_log)
  assert.deepEqual([detail.errorCode, detail.exitCode, detail.signal, detail.outcome, detail.effect],
    ['SEAT_PROCESS_FAILED', 3, null, 'not_applied', 'not_started'])
  assert.doesNotMatch(JSON.stringify([row, logs]), /synthetic-secret/u)
  assert.equal(calls, 1)
})

test('diagnostic and stderr failures cannot change configuration failure or retry it', async () => {
  const bots = new Map([[bot.id, bot]])
  bots.previewUpdate = async (id, changes) => ({ ...bots.get(id), ...changes })
  bots.update = async (id, changes) => { const value = { ...bots.get(id), ...changes }; bots.set(id, value); return value }
  let calls = 0, reports = 0
  const admin = new BotAdministration({ bots, writeLog() { throw Error('logging failed') },
    reportError() { reports++; throw Error('diagnostics failed') },
    transport: { async isRunning() { return true }, async reconfigure() { calls++; throw failedProcess() } },
  })
  await admin.update(bot.id, { model: 'next' }); await tick()
  assert.deepEqual(admin.view(bots.get(bot.id)).configurationApplication.outcome, 'outcome_unknown')
  assert.equal(calls, 1); assert.equal(reports, 1)
})

test('diagnostics omit absent/unsafe fields and ignore normal or completed wait outcomes', async () => {
  const raw = Object.assign(new Error('synthetic-secret'), { code: 'SYNTHETIC_SECRET', signal: 'synthetic-secret',
    stdout: 'synthetic-secret', waitOutcome: 'synthetic-secret' })
  assert.deepEqual(JSON.parse(executionFailureReport(bot.id, 'seat_watch', raw).diagnostic_log),
    { schema: 'bellteam.execution-failure.v1', botId: bot.id, phase: 'seat_watch', waitOutcome: 'unknown' })
  for (const waitOutcome of ['timeout', 'running'])
    assert.equal(executionFailureReport(bot.id, 'seat_watch', { waitOutcome }), null)
  assert.equal(executionFailureReport(bot.id, 'seat_watch', { waitOutcome: 'error', turnCompleted: true }), null)
  assert.equal(JSON.parse(executionFailureReport(bot.id, 'configuration', raw).diagnostic_log).effect, 'possible')
  let called = 0
  await reportExecutionFailure(() => { called++; throw Error('synthetic-secret') }, bot.id, 'seat_watch', failedProcess())
  assert.equal(called, 1)
})

test('delivery wait keeps the original exception when diagnostic reporting fails', async () => {
  const original = failedProcess(), reports = []
  const transport = new AitermTransport({ waitProcess: async () => { throw original },
    reportError(report) { reports.push(report); throw Error('diagnostic fixture failure') },
  })
  await assert.rejects(transport.waitForTurnCompletion({ bot, follows: false, controller: new AbortController() },
    { receipt: { wait_process: {} } }), error => error === original)
  assert.equal(reports.length, 1)
  assert.equal(JSON.parse(reports[0].diagnostic_log).phase, 'delivery_wait')
})
