import test from 'node:test'
import assert from 'node:assert/strict'
import { createConversationAssembly } from '../src/conversation-assembly.mjs'
import { createConversationFacade } from '../src/conversation-facade.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'
import { createRoomApi } from '../src/http-room-api.mjs'
import { createMessageViews } from '../src/http-messages.mjs'
import { TimelineIndex } from '../src/timeline-index.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const ids = Array.from({ length: 17 }, (_, i) => `item-${i}`)
const row = id => ({ id: `row-${id}`, kind: 'message', at: '2026-11-04T08:00:00+09:00', message: id })
const room = id => ({ id, name: id, memberIds: [] })
function harness() {
  const calls = [], admission = new MembersAdmission()
  let active = 0, maximum = 0
  const assembly = createConversationAssembly({ root: '/unused-artificial-root', membersAdmission: admission,
    getServices: () => ({ aiControl: { assertEnabled() {} }, bots: {} }), onExecution() {},
    createProcess: () => ({ request(method, params) {
      calls.push({ method, params }); maximum = Math.max(maximum, ++active)
      const result = Promise.resolve(method === 'rooms.list' ? { rooms: ids.map(room) }
        : { async *[Symbol.asyncIterator]() { yield row(params.botId ?? params.roomId) } })
      result.completion = new Promise(resolve => setImmediate(() => { active--; resolve() }))
      return result
    } }) })
  return { assembly, calls, admission, maximum: () => maximum }
}
function roomRequest(rooms, sources) {
  const response = { writeHead(status) { this.status = status }, end(body) { this.body = JSON.parse(body) } }
  const api = createRoomApi({ rooms, sources })
  return { response, run: () => api({ method: 'GET' }, response, new URL('http://fixture/api/rooms')) }
}

test('17 Bot histories use actual assembly and logical8 without overlapping root completions', async () => {
  const h = harness()
  const result = await h.assembly.run({ kind: 'owner' }, () => h.assembly.facade.store.timelineViews(ids))
  assert.deepEqual([...result.keys()], ids)
  for (const id of ids) assert.equal(result.get(id).at(0).id, `row-${id}`)
  assert.equal(h.calls.length, 17); assert.equal(h.maximum(), 1)
  const leases = Array.from({ length: 8 }, () => h.admission.enter())
  assert.throws(() => h.admission.enter(), { code: 'MEMBERS_NOT_ACCEPTED' })
  for (const lease of leases) h.admission.finish(lease)
})

test('17 Room histories retain existing recent and usage composition with one request per history', async () => {
  const h = harness(), { rooms, store } = h.assembly.facade
  const views = createMessageViews({ rooms, store, secretRequests: { timeline: ({ roomId }) => [
    { ...row(`usage-${roomId}`), kind: 'secret_request', at: '2026-11-04T08:01:00+09:00' },
  ] } })
  const request = roomRequest(rooms, views.sources)
  await h.assembly.run({ kind: 'owner' }, request.run)
  assert.equal(request.response.status, 200)
  assert.deepEqual(request.response.body.rooms.map(value => value.id), ids)
  assert.deepEqual(request.response.body.rooms.map(value => value.recent.id), ids.map(id => `row-usage-${id}`))
  assert.deepEqual(h.calls.map(value => value.method), ['rooms.list', ...ids.map(() => 'history.listRoomMessages')])
  assert.equal(h.maximum(), 1)
})

test('Bot aggregation preserves options identity, input order and duplicate Map last value after actual completion', async () => {
  const options = {}, captured = [], completions = [], calls = []
  const facade = createConversationFacade({ context(method, value) { assert.equal(value, options); const c = {}; captured.push(c); return c },
    getController: () => ({ request(method, params, context) {
      assert.equal(context, captured.at(-1)); calls.push(params.botId)
      const actual = Promise.withResolvers(); completions.push(actual)
      const result = Promise.resolve({ async *[Symbol.asyncIterator]() { yield row(`${params.botId}-${calls.length}`) } })
      result.completion = actual.promise; return result
    } }) })
  const pending = facade.store.timelineViews(['a', 'b', 'a'], options)
  await tick(); assert.deepEqual(calls, ['a'])
  completions[0].resolve(); await tick(); assert.deepEqual(calls, ['a', 'b'])
  completions[1].resolve(); await tick(); assert.deepEqual(calls, ['a', 'b', 'a'])
  completions[2].resolve(); const result = await pending
  assert.deepEqual([...result.keys()], ['a', 'b']); assert.equal(result.get('a').at(0).id, 'row-a-3')
})

for (const stage of ['result', 'completion']) test(`Bot ${stage} rejection retains original error and stops further issuance`, async () => {
  const error = Object.assign(new Error('original refusal'), { code: 'MEMBERS_NOT_ACCEPTED' }), calls = []
  const facade = createConversationFacade({ context: () => ({}), getController: () => ({ request(method, params) {
    calls.push(params.botId)
    const result = stage === 'result' ? Promise.reject(error) : Promise.resolve({ async *[Symbol.asyncIterator]() {} })
    result.completion = stage === 'completion' ? Promise.reject(error) : Promise.resolve()
    result.completion.catch(() => {}); return result
  } }) })
  await assert.rejects(facade.store.timelineViews(ids), value => value === error)
  assert.deepEqual(calls, [ids[0]])
})

test('Room refresh and history result wait for actual completion before next issuance', async () => {
  const refreshed = Promise.withResolvers(), history = Promise.withResolvers(), calls = []
  const rooms = new Map(ids.slice(0, 2).map(id => [id, room(id)]))
  rooms.refresh = () => { const result = Promise.resolve(); result.completion = refreshed.promise; return result }
  rooms.messageView = id => {
    calls.push(id); const result = Promise.resolve(new TimelineIndex([row(id)]))
    result.completion = calls.length === 1 ? history.promise : Promise.resolve(); return result
  }
  const request = roomRequest(rooms, createMessageViews({ rooms }).sources), pending = request.run()
  await tick(); assert.deepEqual(calls, [])
  refreshed.resolve(); await tick(); assert.deepEqual(calls, [ids[0]])
  history.resolve(); await pending; assert.deepEqual(calls, ids.slice(0, 2))
})

for (const stage of ['result', 'completion']) test(`Room ${stage} rejection retains original error and stops further issuance`, async () => {
  const error = Object.assign(new Error('original refusal'), { code: 'MEMBERS_NOT_ACCEPTED' }), calls = []
  const rooms = new Map(ids.map(id => [id, room(id)])); rooms.refresh = async () => {}
  rooms.messageView = id => {
    calls.push(id)
    const result = stage === 'result' ? Promise.reject(error) : Promise.resolve(new TimelineIndex([]))
    result.completion = stage === 'completion' ? Promise.reject(error) : Promise.resolve()
    result.completion.catch(() => {}); return result
  }
  await assert.rejects(roomRequest(rooms, createMessageViews({ rooms }).sources).run(), value => value === error)
  assert.deepEqual(calls, [ids[0]])
})

test('Room legacy sources fallback retains all records and order', async () => {
  const rooms = new Map(ids.map(id => [id, room(id)])); rooms.refresh = async () => {}
  rooms.messages = async id => [row(id)]
  const request = roomRequest(rooms, createMessageViews({ rooms }).sources)
  await request.run(); assert.deepEqual(request.response.body.rooms.map(value => value.id), ids)
})
