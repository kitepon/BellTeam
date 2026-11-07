import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { UpdateHold } from '../src/update-hold.mjs'
import { createExecutionFacade } from '../src/execution-facade.mjs'
import { AitermTransport } from '../src/aiterm-transport.mjs'

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'update-hold-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let clock = 1_000_000, timer = null
  const released = [], path = join(root, 'execution-update-hold.json')
  const hold = new UpdateHold({ path, now: () => clock, sleep: async ms => { clock += ms },
    setTimer: (callback, ms) => (timer = { callback, ms }), clearTimer: () => { timer = null }, ...options })
  hold.watch(event => released.push(event))
  return { hold, path, released, read: async () => JSON.parse(await readFile(path, 'utf8')),
    advance: ms => { clock += ms }, get timer() { return timer }, get clock() { return clock } }
}

test('drained quiesce saves the hold and answer first, refuses input as not_started, is idempotent, and expires after the stop window', async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.hold.quiesce({ requestId: 'r1', deadline: f.clock + 300_000 }), { result: 'drained' })
  const saved = await f.read()
  assert.equal(saved.result, 'drained'); assert.equal(saved.requestId, 'r1'); assert.deepEqual(saved.interrupted, [])
  assert.throws(() => f.hold.assertInput(), { code: 'BOT_UPDATE_HOLD', effect: 'not_started', status: 503 })
  assert.deepEqual(await f.hold.quiesce({ requestId: 'r1', deadline: 0 }), { result: 'drained' })
  // Aborted update: the body is still alive after the 120 s window, so the hold ends and input is admitted again.
  assert.equal(f.timer.ms, 120_000)
  f.timer.callback()
  while (!f.released.length) await new Promise(resolve => setTimeout(resolve, 5))
  f.hold.assertInput()
  await assert.rejects(readFile(f.path), { code: 'ENOENT' })
  assert.deepEqual(f.released, [{ released: true, reason: 'expired' }])
})

test('deadline with a running delivery records it as interrupted before answering', async t => {
  const running = [{ id: 'job', botId: 'bot-a', groupId: 'delivery-a', status: 'running', startedAt: 'T' }, { botId: 'bot-b', status: 'failed' }]
  const f = await fixture(t, { active: () => running })
  assert.deepEqual(await f.hold.quiesce({ requestId: 'r2', deadline: f.clock + 1_000 }), { result: 'deadline' })
  assert.deepEqual((await f.read()).interrupted, [{ botId: 'bot-a', deliveryId: 'delivery-a', startedAt: 'T' }])
})

test('a hold saved by the replaced box holds input until afterListenReady releases it; shutdown before an answer keeps running work', async t => {
  const f = await fixture(t, { active: () => [{ botId: 'bot-a', groupId: 'd1', status: 'running', startedAt: 'T' }] })
  await writeFile(f.path, JSON.stringify({ schema: 'bellteam.update-hold.v1', requestId: 'old', result: 'drained', answeredAt: 1, interrupted: [] }))
  await f.hold.initialize()
  assert.throws(() => f.hold.assertInput(), { code: 'BOT_UPDATE_HOLD' })
  assert.equal(await f.hold.release('startup'), true)
  f.hold.assertInput(); assert.deepEqual(f.released, [{ released: true, reason: 'startup' }])

  const g = await fixture(t, { active: () => [{ botId: 'bot-a', groupId: 'd1', status: 'running', startedAt: 'T' }] })
  const answer = g.hold.quiesce({ requestId: 'r3', deadline: g.clock + 10_000 })
  await new Promise(resolve => setImmediate(resolve))
  await g.hold.onShutdownSignal()
  assert.deepEqual((await g.read()).interrupted, [{ botId: 'bot-a', deliveryId: 'd1', startedAt: 'T' }])
  await answer
})

test('release admits input even when the hold file cannot be removed', async t => {
  const f = await fixture(t)
  const reports = []
  const hold = new UpdateHold({ path: f.path, report: error => reports.push(error) })
  hold.state = { schema: 'bellteam.update-hold.v1' }
  hold.path = join(f.path, '\0invalid') // rm rejects a path containing NUL
  assert.equal(await hold.release('startup'), true)
  hold.assertInput(); assert.equal(reports.length, 1)
})

test('a quiesce whose hold cannot be saved releases instead of refusing input forever', async t => {
  const f = await fixture(t)
  const hold = new UpdateHold({ path: join(f.path, 'missing-dir', 'hold.json'), now: () => 0 })
  await assert.rejects(hold.quiesce({ requestId: 'r4', deadline: 10 }))
  hold.assertInput()
})

test('input is refused before typing: facade guard and the transport check gate, running work untouched', async t => {
  const calls = []
  const facade = createExecutionFacade({ getController: () => ({ dispatch: request => { calls.push(request.method); return Promise.resolve('ok') }, project: () => 'project', close: async () => {} }),
    client: {}, membersAdmission: {}, requestStop: async () => {}, watchQueue: () => () => {}, hold: { held: true } })
  await assert.rejects(facade.transport.notify({ id: 'bot-a' }, 'x'), { code: 'BOT_UPDATE_HOLD', effect: 'not_started' })
  assert.equal(await facade.transport.stop({ id: 'bot-a' }), 'ok'); assert.equal(facade.transport.session({ id: 'bot-a' }), 'project')
  assert.deepEqual(calls, ['transport.stop'])

  const native = []
  const transport = new AitermTransport({ client: { call: async name => { native.push(name); return { content: [] } }, close: async () => {} },
    handoffContext: async () => '', assertInputAllowed: () => { throw Object.assign(new Error('BOT_UPDATE_HOLD'), { code: 'BOT_UPDATE_HOLD', effect: 'not_started' }) } })
  t.after(() => transport.close())
  await assert.rejects(transport.turn({ id: 'bot-a', session: 'bot-a', harness: 'codex', project: '/unused' }, 'held input'), { code: 'BOT_UPDATE_HOLD', effect: 'not_started' })
  assert.equal(native.includes('pty_send'), false)
})
