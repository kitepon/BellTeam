import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkGraphFacade, createWorkGraphEffects } from '../src/work-graph-facade.mjs'
import { validateWorkGraphEffectResult } from '../src/work-graph-protocol.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))

function fixture({ refresh = () => ({ batch: null, nextRefreshMs: null }), fail = false, ownWork } = {}) {
  const calls = [], listeners = [], stopped = []
  const controller = { request: async (method, params) => {
    calls.push(method)
    if (fail) throw Object.assign(new Error('WORK_GRAPH_NOT_ACCEPTED'), { code: 'WORK_GRAPH_NOT_ACCEPTED' })
    return method === 'refresh' ? refresh() : { schema: 'bellteam.work-graph.v1', params }
  } }
  const watch = name => listener => { listeners.push([name, listener]); return () => stopped.push(name) }
  const timers = []
  const facade = createWorkGraphFacade({ controller, ownWork, bots: { watch: watch('bots') }, rooms: { watch: watch('rooms') }, commandWaits: { watch: watch('wait') },
    transport: { watchCurrentTurn: watch('turn'), watchQueue: watch('queue') },
    setTimer: (run, ms) => { const timer = { run, ms }; timers.push(timer); return timer }, clearTimer: timer => { if (timer) timer.cleared = true } })
  const fire = async () => { for (const timer of timers.splice(0)) if (!timer.cleared) timer.run(); await tick() }
  return { facade, calls, listeners, stopped, timers, fire }
}

test('snapshot runs refresh then snapshot on one chain; invalidations coalesce while subscribed', async () => {
  let batch = null
  const f = fixture({ refresh: () => ({ batch, nextRefreshMs: null }) })
  const sent = []
  const unsubscribe = f.facade.subscribe(value => sent.push(value))
  const snapshot = await f.facade.snapshot()
  assert.equal(snapshot.schema, 'bellteam.work-graph.v1')
  assert.deepEqual(f.calls, ['refresh', 'snapshot'])
  await tick()
  assert.deepEqual(f.listeners.map(([name]) => name).sort(), ['bots', 'queue', 'rooms', 'turn', 'wait'])
  batch = { epoch: 'e', version: 1, changes: [] }
  for (const [, listener] of f.listeners) listener()
  assert.equal(f.timers.length, 1)
  await f.fire()
  assert.deepEqual(f.calls, ['refresh', 'snapshot', 'refresh'])
  assert.deepEqual(sent, [batch])
  unsubscribe()
  assert.deepEqual(f.stopped.sort(), ['bots', 'queue', 'rooms', 'turn', 'wait'])
  for (const [, listener] of f.listeners) listener()
  assert.equal(f.timers.length, 0)
})

test('nextRefreshMs arms one timer; an unavailable child rejects with WORK_GRAPH_UNAVAILABLE', async () => {
  const f = fixture({ refresh: () => ({ batch: null, nextRefreshMs: 4000 }) })
  f.facade.subscribe(() => {})
  await f.facade.snapshot(); await tick()
  assert.equal(f.timers.at(-1).ms, 4000)
  // a61: a direct snapshot with no SSE subscriber never arms the own-work re-check.
  const lone = fixture({ refresh: () => ({ batch: null, nextRefreshMs: null }), ownWork: () => true })
  await lone.facade.snapshot(); await tick()
  assert.equal(lone.timers.length, 0)
  // a61: while a member works by own work, re-check every ownWorkMs (the earlier of it and nextRefreshMs).
  let owned = true
  const own = fixture({ refresh: () => ({ batch: null, nextRefreshMs: null }), ownWork: () => owned })
  own.facade.subscribe(() => {})
  await own.facade.snapshot(); await tick()
  assert.equal(own.timers.at(-1).ms, 5000)
  await own.fire(); await own.fire()
  assert.deepEqual(own.calls, ['refresh', 'snapshot', 'refresh'])
  owned = false
  await own.fire(); await own.fire()
  assert.deepEqual(own.calls, ['refresh', 'snapshot', 'refresh', 'refresh'])
  assert.equal(own.timers.length, 0)
  const down = fixture({ fail: true })
  await assert.rejects(down.facade.snapshot(), { code: 'WORK_GRAPH_UNAVAILABLE', status: 503 })
})

test('effects return only the agreed fields from the public ports', async () => {
  const effect = createWorkGraphEffects({
    bots: { listForClient: async () => [{ id: 'a', name: 'A', color: 'red', avatarVersion: 'v', deleting: false, secret: 'x' }], get: id => ({ id }) },
    transport: {
      queueItems: async () => [{ status: 'running', context: 'room', contextId: 'r', groupId: 'g', from: 'a', target: 'b', message: 'm', requestSummary: '要約', steered: false, startedAt: 1, extra: 1 }],
      currentTurn: async id => ({ state: 'working', turnId: `t-${id}`, startedAt: 2, hidden: true }),
      currentWork: () => ({ state: 'working', summary: '相関図の図を直している', summaryStatus: 'current', summaryUpdatedAt: '2026-11-08T12:00:00.000Z', observedAt: '2026-11-08T12:00:00.000Z', source: 'self_reported' }),
    },
    messagePage: async (kind, id, url) => ({ items: [{ id: 'g', body: 'x', routing: { responders: ['b'], status: 'pending', other: 1 } }], kind, id, limit: url.searchParams.get('limit') }),
  })
  const results = {
    'members.list': [{}, { members: [{ id: 'a', name: 'A', color: 'red', avatarVersion: 'v', deleting: false }] }],
    'queue.read': [{}, { items: [{ status: 'running', context: 'room', contextId: 'r', groupId: 'g', from: 'a', target: 'b', requestSummary: '要約', image: false, steered: false, startedAt: 1 }] }],
    'turns.read': [{ botIds: ['a'] }, { turns: { a: { state: 'working', turnId: 't-a', startedAt: '1970-01-01T00:00:00.002Z', summary: '相関図の図を直している', summaryStatus: 'current' } } }],
    'room.messages': [{ roomId: 'r' }, { items: [{ id: 'g', routing: { responders: ['b'], status: 'pending' } }] }],
  }
  for (const [method, [params, expected]] of Object.entries(results)) {
    const value = await effect(method, params)
    assert.deepEqual(value, expected)
    validateWorkGraphEffectResult(method, value)
  }
  const invalid = createWorkGraphEffects({ bots: {}, messagePage: async () => null,
    transport: { currentTurn: async () => { throw Object.assign(new Error('x'), { code: 'EXECUTION_REQUEST_INVALID' }) } } })
  assert.deepEqual(await invalid('turns.read', { botIds: ['a'] }), { unsupported: true })
  // a61: state is GET /api/bots currentWork.state; a member that cannot be read is unknown, even if its turn reads idle.
  const unknown = createWorkGraphEffects({ bots: {}, messagePage: async () => null, transport: { currentTurn: async () => ({ state: 'idle', turnId: null }) } })
  const row = await unknown('turns.read', { botIds: ['z'] })
  assert.deepEqual(row, { turns: { z: { state: 'unknown', turnId: null, startedAt: null, summary: null, summaryStatus: 'missing' } } })
  validateWorkGraphEffectResult('turns.read', row)
  // Natively idle but working by own work (a41 reason background): the row says working and the facade re-check is on.
  const work = state => ({ state, summary: null, summaryStatus: 'missing', summaryUpdatedAt: null, observedAt: '2026-11-13T12:00:00.000Z', source: null,
    reason: state === 'working' ? { kind: 'background', detail: 'sleep 90', since: null } : null })
  let current = work('working')
  const owning = createWorkGraphEffects({ bots: { get: id => ({ id }) }, messagePage: async () => null,
    transport: { currentTurn: async () => ({ state: 'idle', turnId: 't-old', startedAt: null }), currentWork: () => current, runningState: () => 'idle' } })
  const wait = await owning('turns.read', { botIds: ['w'] })
  assert.deepEqual(wait, { turns: { w: { state: 'working', turnId: 't-old', startedAt: null, summary: null, summaryStatus: 'missing' } } })
  validateWorkGraphEffectResult('turns.read', wait)
  assert.equal(owning.ownWork(), true)
  current = work('idle')
  assert.equal((await owning('turns.read', { botIds: ['w'] })).turns.w.state, 'idle')
  assert.equal(owning.ownWork(), false)
  await assert.rejects(invalid('other', {}), { code: 'WORK_GRAPH_EFFECT_INVALID' })
})
