import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkGraphFacade, createWorkGraphEffects } from '../src/work-graph-facade.mjs'
import { validateWorkGraphEffectResult } from '../src/work-graph-protocol.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))

function fixture({ refresh = () => ({ batch: null, nextRefreshMs: null }), fail = false } = {}) {
  const calls = [], listeners = [], stopped = []
  const controller = { request: async (method, params) => {
    calls.push(method)
    if (fail) throw Object.assign(new Error('WORK_GRAPH_NOT_ACCEPTED'), { code: 'WORK_GRAPH_NOT_ACCEPTED' })
    return method === 'refresh' ? refresh() : { schema: 'bellteam.work-graph.v1', params }
  } }
  const watch = name => listener => { listeners.push([name, listener]); return () => stopped.push(name) }
  const timers = []
  const facade = createWorkGraphFacade({ controller, bots: { watch: watch('bots') }, rooms: { watch: watch('rooms') },
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
  assert.deepEqual(f.listeners.map(([name]) => name).sort(), ['bots', 'queue', 'rooms', 'turn'])
  batch = { epoch: 'e', version: 1, changes: [] }
  for (const [, listener] of f.listeners) listener()
  assert.equal(f.timers.length, 1)
  await f.fire()
  assert.deepEqual(f.calls, ['refresh', 'snapshot', 'refresh'])
  assert.deepEqual(sent, [batch])
  unsubscribe()
  assert.deepEqual(f.stopped.sort(), ['bots', 'queue', 'rooms', 'turn'])
  for (const [, listener] of f.listeners) listener()
  assert.equal(f.timers.length, 0)
})

test('nextRefreshMs arms one timer; an unavailable child rejects with WORK_GRAPH_UNAVAILABLE', async () => {
  const f = fixture({ refresh: () => ({ batch: null, nextRefreshMs: 4000 }) })
  f.facade.subscribe(() => {})
  await f.facade.snapshot(); await tick()
  assert.equal(f.timers.at(-1).ms, 4000)
  const down = fixture({ fail: true })
  await assert.rejects(down.facade.snapshot(), { code: 'WORK_GRAPH_UNAVAILABLE', status: 503 })
})

test('effects return only the agreed fields from the public ports', async () => {
  const effect = createWorkGraphEffects({
    bots: { listForClient: async () => [{ id: 'a', name: 'A', color: 'red', avatarVersion: 'v', deleting: false, secret: 'x' }] },
    transport: {
      queueItems: async () => [{ status: 'running', context: 'room', contextId: 'r', groupId: 'g', from: 'a', target: 'b', message: 'm', steered: false, startedAt: 1, extra: 1 }],
      currentTurn: async id => ({ state: 'working', turnId: `t-${id}`, startedAt: 2, hidden: true }),
    },
    messagePage: async (kind, id, url) => ({ items: [{ id: 'g', body: 'x', routing: { responders: ['b'], status: 'pending', other: 1 } }], kind, id, limit: url.searchParams.get('limit') }),
  })
  const results = {
    'members.list': [{}, { members: [{ id: 'a', name: 'A', color: 'red', avatarVersion: 'v', deleting: false }] }],
    'queue.read': [{}, { items: [{ status: 'running', context: 'room', contextId: 'r', groupId: 'g', from: 'a', target: 'b', message: 'm', image: false, steered: false, startedAt: 1 }] }],
    'turns.read': [{ botIds: ['a'] }, { turns: { a: { state: 'working', turnId: 't-a', startedAt: '1970-01-01T00:00:00.002Z' } } }],
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
  await assert.rejects(invalid('other', {}), { code: 'WORK_GRAPH_EFFECT_INVALID' })
})
