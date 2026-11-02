import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import test from 'node:test'
import { AitermTransport, runWaitProcess } from '../src/aiterm-transport.mjs'
import { createSeatProcessRunner } from '../src/seat-process.mjs'

const seatProject = '/synthetic-seat'
const program = source => ({ executable: process.execPath, args: ['-e', source] })
const outcome = (value, code) => program(`process.stdout.write(${JSON.stringify(JSON.stringify(value))});process.exitCode=${code}`)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

function syntheticEntry(t) {
  const spawn = childProcess.spawn
  // Replace only the privilege entry; stdout, exit, limits and cancellation use real child processes.
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    if (command !== 'sudo') return spawn(command, args, options)
    assert.equal(args[2], '/usr/local/libexec/bellteam-seat-exec')
    assert.equal(args[6], seatProject)
    assert.equal(args[7], '--')
    return spawn(args[8], args.slice(9), options)
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
}

test('wait JSON keeps done and nonzero outcomes on both seat and legacy paths', async t => {
  syntheticEntry(t)
  for (const [name, code] of [['done', 0], ['timeout', 3], ['running', 3], ['closed', 1],
    ['error', 1], ['rate_limited', 2], ['not_taken', 4]]) {
    const value = { outcome: name, turn_id: 'synthetic-turn', detail: { retained: true } }
    for (const project of [null, seatProject])
      assert.deepEqual(await runWaitProcess(outcome(value, code), null, { seatProject: project }), value)
  }
})

test('wait JSON does not relax runner defaults, malformed output, start, abort or buffer failures', async t => {
  syntheticEntry(t)
  const run = createSeatProcessRunner(seatProject)
  const nonzero = outcome({ outcome: 'timeout' }, 3)
  await assert.rejects(run(nonzero.executable, nonzero.args), { code: 'SEAT_PROCESS_FAILED', exitCode: 3 })
  for (const project of [null, seatProject])
    await assert.rejects(runWaitProcess(program("process.stdout.write('invalid')"), null, { seatProject: project }), /AITERM_WAIT_INVALID/u)
  await assert.rejects(runWaitProcess({ executable: '/synthetic-missing-wait', args: [] }, null, { seatProject }),
    { code: 'SEAT_PROCESS_START_FAILED' })
  const stopped = new AbortController()
  stopped.abort()
  await assert.rejects(runWaitProcess(nonzero, stopped.signal, { seatProject }), { code: 'ABORT_ERR', effect: 'not_started' })
  const active = new AbortController()
  const waiting = runWaitProcess(program('setInterval(() => {}, 1000)'), active.signal, { seatProject })
  active.abort()
  await assert.rejects(waiting, { code: 'ABORT_ERR' })
  await assert.rejects(runWaitProcess(program("process.stdout.write(' '.repeat(17 * 1024 * 1024))"), null, { seatProject }),
    { code: 'SEAT_BUFFER_EXCEEDED' })
})

test('seat timeout and running keep the watch busy until done before configure', { timeout: 10_000 }, async t => {
  syntheticEntry(t)
  const calls = [], results = [], gates = [deferred(), deferred()]
  const seen = [deferred(), deferred()]
  t.after(() => gates.forEach(gate => gate.resolve()))
  const descriptor = outcome({ outcome: 'done' }, 0)
  const turn = { state: 'running', turn_id: 'synthetic-turn', wait_process: descriptor }
  let waits = 0
  const transport = new AitermTransport({
    client: { async call(name, args) {
      calls.push([name, args])
      if (name === 'pty_list') return { _meta: { 'aiterm/seat_turns': {
        schema: 'aiterm.seat-turns.v1', seats: [{ session_id: 'bot-a', turn }],
      } } }
      assert.equal(name, 'agent_configure')
      return {}
    } },
    waitProcess: async (spec, signal) => {
      assert.equal(spec, descriptor)
      const index = waits++
      assert.ok(index < 3, 'only timeout, running, then done')
      const result = await runWaitProcess(outcome({ outcome: ['timeout', 'running', 'done'][index] }, index < 2 ? 3 : 0),
        signal, { seatProject })
      results.push(result.outcome)
      if (index < 2) { seen[index].resolve(); await gates[index].promise }
      return result
    },
  })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'codex', model: 'old-model', reasoningEffort: 'high' }
  await transport.watchSeatTurns([bot])
  const watch = transport.watches.get(bot.id)
  const configured = transport.reconfigure(bot, { ...bot, model: 'new-model' })
  for (let index = 0; index < 2; index++) {
    await seen[index].promise
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(transport.isIdle(bot.id), false)
    assert.equal(transport.watches.get(bot.id), watch)
    assert.equal(calls.some(([name]) => name === 'agent_configure'), false)
    gates[index].resolve()
  }
  await configured
  assert.deepEqual(results, ['timeout', 'running', 'done'])
  assert.equal(transport.isIdle(bot.id), true)
  assert.deepEqual(calls.filter(([name]) => name === 'agent_configure'), [
    ['agent_configure', { session_id: 'bot-a', model: 'new-model', reasoning_effort: 'high' }],
  ])
})
