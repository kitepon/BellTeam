import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AitermTransport } from '../src/aiterm-transport.mjs'

const unknown = { schema: 'bellteam.delivery-tracking.v1', admission: 'accepted', completion: 'unknown' }

async function fixture(t, { mode = 'agent_dispatch', sendError, wait, readError, statusError } = {}) {
  const project = await mkdtemp(join(tmpdir(), 'bellteam-tracking-status-'))
  t.after(() => rm(project, { recursive: true, force: true }))
  const calls = [], statuses = []
  const transport = new AitermTransport({ handoffContext: async () => '', waitProcess: wait,
    client: { async call(name) {
      calls.push(name)
      if (name === 'pty_send') {
        if (sendError) throw sendError
        return { structuredContent: { mode, event_cursor: 1,
          wait_process: { executable: 'fixture-only', args: [] } },
          ...(mode === 'agent_steer' ? { _meta: { 'aiterm/steer': {
            schema: 'aiterm.steer-ref.v1', steer_id: '0123456789abcdef', interim_from: 'v1:1:b:1',
          } } } : {}) }
      }
      if (name === 'pty_read') {
        if (readError) throw readError
        return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: 'fixture answer' } }
      }
      assert.fail(`unexpected operation ${name}`)
    } } })
  const bot = { id: 'bot-fixture', session: 'fixture-session', harness: 'codex', project }
  const start = (options = {}) => transport.turn(bot, 'fixture input', { ...options, onStatus: (...args) => {
    statuses.push(args)
    if (statusError && args[0] === 'running') throw statusError
  } })
  return { transport, bot, calls, statuses, start }
}

test('accepted input with a broken waiter keeps the original error and reports unknown completion once', async t => {
  const error = Object.assign(new Error('private canary'), { code: 'SEAT_PROCESS_FAILED', exitCode: 1, signal: null })
  const f = await fixture(t, { wait: async () => { throw error } })
  const completion = f.start()
  const rejected = assert.rejects(completion, value => value === error)
  assert.deepEqual(await completion.accepted, { delivery: 'running' })
  await rejected
  assert.deepEqual(f.statuses, [['running'], ['failed', error, unknown]])
  assert.deepEqual(f.calls, ['pty_send'])
  assert.equal(Object.hasOwn(error, 'delivery_tracking'), false)
})

for (const [name, options] of [
  ['pre-admission refusal', { sendError: new Error('REFUSED') }],
  ['running status persistence failure', { statusError: new Error('SAVE_FAILED') }],
  ['answer read failure after completion', { readError: new Error('READ_FAILED'), wait: async () => ({ outcome: 'done' }) }],
  ['native terminal error', { wait: async () => ({ outcome: 'error', error: 'fixture vendor failure' }) }],
  ['native terminal rate limit', { wait: async () => ({ outcome: 'rate_limited', rate_limit: 'fixture limit' }) }],
]) test(`${name} has no tracking-unknown attribution`, async t => {
  const f = await fixture(t, options)
  const completion = f.start()
  await assert.rejects(completion)
  const failed = f.statuses.find(([status]) => status === 'failed')
  assert.ok(failed)
  assert.equal(failed[2], undefined)
  assert.equal(f.calls.filter(name => name === 'pty_send').length, 1)
})

test('normal timeout and running continue to completion without tracking-unknown attribution', async t => {
  const outcomes = ['timeout', 'running', 'done']
  const f = await fixture(t, { wait: async () => ({ outcome: outcomes.shift() }) })
  assert.equal(await f.start(), 'fixture answer')
  assert.deepEqual(f.statuses, [['running'], ['delivered']])
  assert.deepEqual(outcomes, [])
  assert.equal(f.calls.filter(name => name === 'pty_send').length, 1)
})

test('a confirmed stopped job does not become tracking unknown', async t => {
  let failWait
  const f = await fixture(t, { wait: () => new Promise((_, reject) => { failWait = reject }) })
  const completion = f.start()
  const rejected = assert.rejects(completion, { code: 'BOT_STOPPED' })
  await completion.accepted
  const job = [...f.transport.active.values()][0]
  job.markStopped()
  failWait(new Error('wait aborted'))
  await rejected
  assert.equal(f.statuses.at(-1)[0], 'stopped')
  assert.equal(f.statuses.at(-1)[2], undefined)
})

test('an accepted steer with invalid wait JSON has unknown completion', async t => {
  const error = Object.assign(new Error('AITERM_WAIT_INVALID'), { code: 'AITERM_WAIT_INVALID', exitCode: 0 })
  const f = await fixture(t, { mode: 'agent_steer', wait: async () => { throw error } })
  const completion = f.start()
  const rejected = assert.rejects(completion, value => value === error)
  assert.deepEqual(await completion.accepted, { delivery: 'steered' })
  await rejected
  assert.deepEqual(f.statuses.at(-1), ['failed', error, unknown])
  assert.deepEqual(f.calls, ['pty_send'])
})

for (const waitFails of [false, true]) test(`interim persistence failure is not attributed to tracking (wait failure=${waitFails})`, async t => {
  const saveError = new Error('SAVE_INTERIM_FAILED')
  const waitError = new Error('WAIT_FAILED')
  const f = await fixture(t, { wait: async () => {
    if (waitFails) throw waitError
    return { outcome: 'done' }
  } })
  f.transport.followInterim = () => ({ stop: async () => { throw saveError } })
  const completion = f.start({ onInterim: () => {} })
  await assert.rejects(completion, value => value === saveError)
  assert.deepEqual(f.statuses.at(-1), ['failed', saveError])
})
