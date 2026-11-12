import test from 'node:test'
import assert from 'node:assert/strict'
import { createLatticeFacade, createLatticeEffects, NUDGE_MS } from '../src/lattice-facade.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const snap = (projectId, version) => ({ schema: 'bellteam.lattice-chart.v1', projectId, epoch: 'e', version })

function fixture({ respond = () => null } = {}) {
  const calls = [], timers = [], nudges = []
  let gate = null
  const controller = { request: async (method, params) => {
    calls.push([method, params])
    if (gate) await gate
    const value = respond(method, params)
    if (value instanceof Error) throw value
    return value ?? (method === 'refresh' ? { snapshots: [], nextRefreshMs: 2000 } : { method, params })
  } }
  const facade = createLatticeFacade({ controller,
    // The nudge timer (300 s, always armed) is kept apart from the refresh loop's timers.
    setTimer: (run, ms) => { const timer = { run, ms }; (ms === NUDGE_MS ? nudges : timers).push(timer); return timer }, clearTimer: timer => { if (timer) timer.cleared = true } })
  const fire = async () => { for (const timer of timers.splice(0)) if (!timer.cleared) timer.run(); await tick(); await tick() }
  return { facade, calls, timers, nudges, fire, hold: () => { let open; gate = new Promise(resolve => { open = resolve }); return () => { gate = null; open() } } }
}

test('root calls share one chain in call order', async () => {
  const f = fixture()
  const release = f.hold()
  const results = [f.facade.charts(), f.facade.chart('alpha'), f.facade.run({ from: 'bot-a', projectId: 'alpha', args: ['status'] }), f.facade.run({ from: 'bot-a', projectId: 'alpha', args: [], name: '工程表' })]
  await tick()
  assert.deepEqual(f.calls.map(([method]) => method), ['charts'])
  release()
  assert.deepEqual((await Promise.all(results)).map(value => value.method), ['charts', 'chart', 'run', 'run'])
  assert.deepEqual(f.calls.map(([method, params]) => [method, params]), [['charts', {}], ['chart', { projectId: 'alpha' }],
    ['run', { from: 'bot-a', projectId: 'alpha', args: ['status'], input: null }], ['run', { from: 'bot-a', projectId: 'alpha', args: [], input: null, name: '工程表' }]])
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

test('nudge: one 300 s timer from creation, re-armed after each call, failures swallowed', async () => {
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
