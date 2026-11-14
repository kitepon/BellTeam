import test from 'node:test'
import assert from 'node:assert/strict'
import { createLatticeFacade, createLatticeEffects, NUDGE_MS, QUEUE_WAIT_MS } from '../src/lattice-facade.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const snap = (projectId, version) => ({ schema: 'bellteam.lattice-chart.v1', projectId, epoch: 'e', version })

function fixture({ respond = () => null, now } = {}) {
  const calls = [], timers = [], nudges = []
  let gate = null
  const controller = { request: async (method, params) => {
    calls.push([method, params])
    if (gate) await gate
    const value = respond(method, params)
    if (value instanceof Error) throw value
    return value ?? (method === 'refresh' ? { snapshots: [], nextRefreshMs: 2000 } : { method, params })
  } }
  const facade = createLatticeFacade({ controller, ...(now && { now }),
    // The nudge timer (60 s, always armed) is kept apart from the refresh loop's timers.
    setTimer: (run, ms) => { const timer = { run, ms }; (ms === NUDGE_MS ? nudges : timers).push(timer); return timer }, clearTimer: timer => { if (timer) timer.cleared = true } })
  const fire = async () => { for (const timer of timers.splice(0)) if (!timer.cleared) timer.run(); await tick(); await tick() }
  return { facade, calls, timers, nudges, fire, hold: () => { let open; gate = new Promise(resolve => { open = resolve }); return () => { gate = null; open() } } }
}

test('writes run one at a time in call order; reads go at once beside a write in flight', async () => {
  const f = fixture()
  const release = f.hold()
  const writes = [f.facade.run({ from: 'bot-a', projectId: 'alpha', args: ['status'] }), f.facade.run({ from: 'bot-a', projectId: 'alpha', args: [], name: '工程表' })]
  await tick()
  const reads = [f.facade.charts(), f.facade.chart('alpha'), f.facade.blockers()]
  await tick()
  // The first write is in flight; the reads were sent beside it, the second write waits.
  assert.deepEqual(f.calls.map(([method]) => method), ['run', 'charts', 'chart', 'blockers'])
  release()
  assert.deepEqual((await Promise.all([...writes, ...reads])).map(value => value.method), ['run', 'run', 'charts', 'chart', 'blockers'])
  assert.deepEqual(f.calls.map(([method, params]) => [method, params]), [['run', { from: 'bot-a', projectId: 'alpha', args: ['status'], input: null }],
    ['charts', {}], ['chart', { projectId: 'alpha' }], ['blockers', {}], ['run', { from: 'bot-a', projectId: 'alpha', args: [], input: null, name: '工程表' }]])
})

test('seat writes go before queued background writes; the write in flight finishes first', async () => {
  const f = fixture()
  const release = f.hold()
  const nudge = f.facade.nudge()
  await tick()
  const later = [f.facade.deliver(), f.facade.run({ from: 'bot-a', projectId: 'alpha', args: ['status'] }), f.facade.unblock({ projectId: 'alpha', stopId: 'a'.repeat(24) })]
  await tick()
  assert.deepEqual(f.calls.map(([method]) => method), ['nudge'])
  release()
  await Promise.all([nudge, ...later])
  assert.deepEqual(f.calls.map(([method]) => method), ['nudge', 'run', 'unblock', 'deliver'])
})

test('a write queued past the wait bound is never sent; the next write is sent at once', async () => {
  let clock = 0
  const f = fixture({ now: () => clock })
  const release = f.hold()
  const first = f.facade.run({ from: 'bot-a', projectId: 'alpha', args: ['todo', 'note'] })
  await tick()
  const stale = f.facade.run({ from: 'bot-a', projectId: 'alpha', args: ['todo', 'start'] })
  clock = QUEUE_WAIT_MS + 1
  const fresh = f.facade.unblock({ projectId: 'alpha', stopId: 'b'.repeat(24) })
  release()
  await first
  await assert.rejects(stale, { code: 'LATTICE_UNAVAILABLE', status: 503 })
  assert.equal((await fresh).method, 'unblock')
  assert.deepEqual(f.calls.map(([method, params]) => [method, params.args?.[1] ?? null]), [['run', 'note'], ['unblock', null]], 'the stale run never reached the child')
})

test('subscribers get only their chart; the loop follows nextRefreshMs and stops with the last subscriber', async () => {
  let next = { snapshots: [snap('alpha', 1), snap('beta', 1)], nextRefreshMs: 2000 }
  const f = fixture({ respond: method => method === 'refresh' ? next : null })
  const alpha = [], beta = []
  const offAlpha = f.facade.subscribe('alpha', value => alpha.push(value))
  const offBeta = f.facade.subscribe('beta', value => beta.push(value))
  await tick(); await tick()
  // The first subscriber starts one refresh at once; a later chart joins at the next tick (its first snapshot is the route's own chart read).
  assert.deepEqual(f.calls, [['refresh', { projectIds: ['alpha'] }]])
  assert.deepEqual([alpha.map(s => s.version), beta.map(s => s.version)], [[1], [1]])
  assert.deepEqual(f.timers.map(timer => timer.ms), [2000])
  next = { snapshots: [snap('beta', 2)], nextRefreshMs: 500 }
  await f.fire()
  assert.deepEqual(f.calls.at(-1), ['refresh', { projectIds: ['alpha', 'beta'] }])
  offAlpha()
  next = { snapshots: [snap('beta', 3)], nextRefreshMs: 500 }
  await f.fire()
  assert.deepEqual(f.calls.at(-1), ['refresh', { projectIds: ['beta'] }])
  assert.deepEqual([alpha.length, beta.map(s => s.version)], [1, [1, 2, 3]])
  assert.equal(f.timers.at(-1).ms, 500)
  offBeta()
  assert.equal(f.timers.at(-1).cleared, true)
  const count = f.calls.length
  await f.fire()
  assert.equal(f.calls.length, count)
})

test('a run refreshes a subscribed chart at once; a failed refresh re-arms and passes codes through', async () => {
  let down = false
  const f = fixture({ respond: (method, params) => down ? Object.assign(new Error('LATTICE_IPC_DISCONNECTED'), { code: 'LATTICE_IPC_DISCONNECTED' })
    : method === 'refresh' ? { snapshots: [snap(params.projectIds[0], 3)], nextRefreshMs: 5000 }
      : method === 'chart' ? Object.assign(new Error('LATTICE_CHART_NOT_FOUND'), { code: 'LATTICE_CHART_NOT_FOUND', status: 404 }) : null })
  const sent = []
  f.facade.subscribe('alpha', value => sent.push(value))
  await tick(); await tick()
  await f.facade.run({ from: 'bot-a', projectId: 'alpha', args: ['todo', 'start'], input: { a: 1 } })
  await tick()
  assert.deepEqual(f.calls.map(([method]) => method), ['refresh', 'run', 'refresh'])
  assert.equal(sent.length, 2)
  await f.facade.run({ from: 'bot-a', projectId: 'other', args: ['status'] })
  await tick()
  assert.deepEqual(f.calls.at(-1)[0], 'run')
  await assert.rejects(f.facade.chart('missing'), { code: 'LATTICE_CHART_NOT_FOUND', status: 404 })
  assert.equal(f.timers.at(-1).ms, 5000)
  down = true
  await assert.rejects(f.facade.charts(), { code: 'LATTICE_UNAVAILABLE', status: 503 })
  await f.fire()
  assert.equal(sent.length, 2)
  assert.deepEqual(f.timers.map(timer => timer.ms), [2000], 'a failed refresh re-arms with the retry delay')
})

test('members.list returns exactly the agreed fields; other effects are refused', async () => {
  const effect = createLatticeEffects({ bots: { listForClient: async () => [{ id: 'a', name: 'A', color: 'red', avatarVersion: 7, deleting: false, secret: 'x' }] } })
  assert.deepEqual(await effect('members.list', {}), { members: [{ id: 'a', name: 'A', color: 'red', avatarVersion: '7', deleting: false }] })
  await assert.rejects(effect('queue.read', {}), { code: 'LATTICE_EFFECT_INVALID' })
})

test('nudge: one 60 s timer from creation, re-armed after each call, failures swallowed', async () => {
  let down = false
  const f = fixture({ respond: method => method === 'nudge' && down ? Object.assign(new Error('x'), { code: 'LATTICE_INVALID' }) : { charts: 1, prompted: 1, skipped: 0, failed: 0 } })
  assert.deepEqual(f.nudges.map(timer => timer.ms), [NUDGE_MS])
  assert.deepEqual(f.calls, [])
  f.nudges.shift().run(); await tick(); await tick()
  assert.deepEqual(f.calls, [['nudge', {}]])
  assert.equal(f.nudges.length, 1, 're-armed after the call')
  down = true
  f.nudges.shift().run(); await tick(); await tick()
  assert.equal(f.calls.length, 2)
  assert.equal(f.nudges.length, 1, 'an old child refusing nudge does not stop the timer')
})

test('turns.read: working and idle pass, anything else or a failed read is unknown', async () => {
  const transport = { currentTurn: id => id === 'w' ? { state: 'working' } : id === 'i' ? Promise.resolve({ state: 'idle' }) : id === 'x' ? Promise.reject(new Error('down')) : { state: 'paused' } }
  const effect = createLatticeEffects({ bots: {}, transport })
  assert.deepEqual(await effect('turns.read', { botIds: ['w', 'i', 'x', 'p'] }), { turns: { w: 'working', i: 'idle', x: 'unknown', p: 'unknown' } })
  assert.deepEqual(await createLatticeEffects({ bots: {} })('turns.read', { botIds: ['w'] }), { turns: { w: 'unknown' } })
})

test('turns.read: runningState counts a command wait; a missing method falls back to currentTurn', async () => {
  // The scheduler reports a command wait while the native turn is idle.
  const transport = { runningState: id => id === 'c' ? 'working' : id === 'x' ? (() => { throw new Error('down') })() : id === 'a' ? Promise.reject(new Error('down')) : 'idle',
    currentTurn: () => ({ state: 'idle' }) }
  assert.deepEqual(await createLatticeEffects({ bots: {}, transport })('turns.read', { botIds: ['c', 'i', 'x', 'a'] }),
    { turns: { c: 'working', i: 'idle', x: 'unknown', a: 'unknown' } })
  assert.deepEqual(await createLatticeEffects({ bots: {}, transport: { currentTurn: () => ({ state: 'working' }) } })('turns.read', { botIds: ['w'] }), { turns: { w: 'working' } })
})

test('messages.send runs the messenger in the actor scope named by from, outside any request scope', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks')
  const scope = new AsyncLocalStorage(), seen = []
  // Like conversation-assembly: a send with no actor in scope is refused (CONVERSATION_CONTEXT_REQUIRED).
  const messenger = { sendmessage: async input => {
    const actor = scope.getStore()
    if (!actor) throw new Error('CONVERSATION_CONTEXT_REQUIRED')
    seen.push([input.from, actor]); return { delivery: 'queued', delivery_id: 'd1' }
  } }
  const effect = createLatticeEffects({ bots: {}, messenger, runAs: (actor, send) => scope.run(actor, send) })
  assert.deepEqual(await effect('messages.send', { from: 'scheduler', target: 'p', message: 'm' }), { delivery: 'queued', deliveryId: 'd1' })
  assert.deepEqual(await effect('messages.send', { from: 'bot-a', target: 'p', message: 'm' }), { delivery: 'queued', deliveryId: 'd1' })
  assert.deepEqual(seen, [['scheduler', { kind: 'scheduler' }], ['bot-a', { kind: 'bot', botId: 'bot-a' }]])
  // Without a scope port the old behavior stays: the error is thrown, the child keeps the notice unacked.
  await assert.rejects(createLatticeEffects({ bots: {}, messenger })('messages.send', { from: 'scheduler', target: 'p', message: 'm' }), /CONVERSATION_CONTEXT_REQUIRED/)
})
