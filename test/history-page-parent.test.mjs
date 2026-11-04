import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversationFacade } from '../src/conversation-facade.mjs'
import { createMessageViews } from '../src/http-messages.mjs'
import { createMemberProfileApi } from '../src/members/profiles-http.mjs'
import { TimelineIndex, conversationHistoryPage } from '../src/timeline-index.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const row = (id, n, extra = {}) => ({ id, at: `2026-11-04T08:${String(n).padStart(2, '0')}:00+09:00`, message: id, ...extra })
const task = (rows, completion = Promise.resolve()) => {
  const promise = Promise.resolve({ async *[Symbol.asyncIterator]() { yield* rows } })
  promise.completion = completion
  return promise
}
const facade = request => createConversationFacade({ context: () => ({}), getController: () => ({ request }) })

test('recent batch retains options, order, duplicates and real completion with one request for 17 bots', async () => {
  const ids = [...Array.from({ length: 17 }, (_, n) => `bot-${n}`), 'bot-0'], options = {}, actual = Promise.withResolvers(), calls = []
  const f = createConversationFacade({ context(method, value) { assert.equal(value, options); return options },
    getController: () => ({ request(method, params, context) {
      calls.push(method); assert.equal(context, options); assert.deepEqual(params, { botIds: ids })
      return task(ids.map((botId, n) => ({ botId, message: n === 1 ? null : row(`row-${n}`, 0) })), actual.promise)
    } }) })
  const pending = f.store.recentViews(ids, options)
  assert.equal(pending.completion, actual.promise)
  let settled = false; pending.then(() => { settled = true })
  await tick(); assert.equal(settled, false); assert.deepEqual(calls, ['history.recentBatch'])
  actual.resolve(); const result = await pending
  assert.deepEqual([...result.keys()], ids.slice(0, -1))
  assert.equal(result.get('bot-0').at(0).id, 'row-17'); assert.equal(result.get('bot-1').length, 0)
})

for (const method of ['recentViews', 'messagePage']) for (const stage of ['result', 'completion'])
  test(`${method} propagates original ${stage} failure`, async () => {
    const error = new Error('original failure')
    const f = facade(() => {
      if (stage === 'result') { const result = Promise.reject(error); result.completion = Promise.resolve(); return result }
      const actual = Promise.reject(error); actual.catch(() => {})
      return task(method === 'recentViews' ? [{ botId: 'bot-a', message: null }] : [{ items: [], has_more: false, remaining_before: 0 }], actual)
    })
    await assert.rejects(method === 'recentViews' ? f.store.recentViews(['bot-a'])
      : f.store.messagePage({ kind: 'bots', id: 'bot-a', query: {}, cards: [[], []] }), value => value === error)
  })

test('parent rejects malformed decoded references and batch identities before consumers use them', async () => {
  const f = facade(method => task(method === 'history.page'
    ? [{ items: [{ source: 1, index: 1 }], has_more: false }] : [{ botId: 'another-bot', message: null }]))
  await assert.rejects(f.store.messagePage({ kind: 'bots', id: 'bot-a', query: {}, cards: [[]] }), { code: 'CONVERSATION_RESULT_INVALID' })
  await assert.rejects(f.store.recentViews(['bot-a']), { code: 'CONVERSATION_RESULT_INVALID' })
})

test('HTTP page matches existing card composition, cursors, image URLs and guide behavior; export stays whole', async () => {
  const base = [row('base-a', 1), row('same-id', 2), row('base-c', 3, { imageAsset: { owner: 'bot-a', file: 'image-a.png' } })]
  const secret = new TimelineIndex([row('secret-a', 2, { kind: 'secret_request', secret_request: { id: 'secret-a', botId: 'bot-a' } }), row('same-id', 2)])
  const questions = new TimelineIndex([row('question-a', 2), row('question-b', 4)])
  const calls = [], f = facade((method, params) => {
    calls.push(method)
    if (method === 'history.page') {
      assert(params.cards.flat().every(value => Object.keys(value).sort().join(',') === 'at,id'))
      return task([conversationHistoryPage(new TimelineIndex(base), params)])
    }
    return task(base)
  })
  const legacy = { timelineView: async () => new TimelineIndex(base) }, rooms = { messageView: legacy.timelineView }
  const services = { rooms, secretRequests: { timelineView: () => secret }, ownerQuestions: { timelineView: () => questions },
    ownerSecretGuide: async () => ({ url: 'https://example.test/guide' }) }
  const modern = createMessageViews({ ...services, store: f.store }), old = createMessageViews({ ...services, store: legacy })
  for (const kind of ['bots', 'rooms']) for (const query of ['', '?limit=1.8', '?limit=2000', '?before=secret-a&limit=1',
    '?before=missing', '?after=base-a&limit=1', '?after=secret-a', '?after=same-id', '?after=missing&limit=1.8']) {
    const url = new URL(`http://fixture/api/${kind}/bot-a/messages${query}`)
    assert.deepEqual(await modern.messagePage(kind, 'bot-a', url), await old.messagePage(kind, 'bot-a', url), kind + query)
  }
  assert(calls.every(method => method === 'history.page'))
  assert.deepEqual(await modern.timeline('bots', 'bot-a'), await old.timeline('bots', 'bot-a'))
  assert.equal(calls.at(-1), 'history.listMessages')
})

test('page restores card bodies from the snapshot captured before waiting and retains actual completion', async () => {
  const old = row('secret-a', 1, { kind: 'secret_request', secret_request: { id: 'secret-a', botId: 'bot-a' } })
  const index = new TimelineIndex([old], ['secret-a']), actual = Promise.withResolvers(), calls = []
  const f = facade((method, input) => {
    calls.push(input); return task([{ items: [{ source: 1, index: 0 }], has_more: false, remaining_before: 0 }], actual.promise)
  })
  const views = createMessageViews({ store: f.store, secretRequests: { timelineView: () => index }, ownerSecretGuide: async () => { throw new Error('guide unavailable') } })
  const pending = views.messagePage('bots', 'bot-a', new URL('http://fixture/messages'))
  await tick(); index.set('secret-a', { ...old, message: 'changed while waiting' })
  let settled = false; pending.then(() => { settled = true }); await tick(); assert.equal(settled, false)
  actual.resolve(); assert.deepEqual((await pending).items, [old])
  assert.deepEqual(calls[0].cards, [[{ id: old.id, at: old.at }], []])
})

test('bot listing prefers recent batch while preserving usage cards and post-await membership state', async () => {
  const bots = new Map(['a', 'b', 'c'].map(id => [id, { id, name: id }])), states = new Map(), actual = Promise.withResolvers()
  bots.clientListingState = id => states.get(id) ?? 'active'
  const store = { recentViews: async ids => {
    assert.deepEqual(ids, ['a', 'b', 'c']); await actual.promise
    return new Map(ids.map(id => [id, new TimelineIndex([row(`recent-${id}`, 1)])]))
  }, timelineViews() { assert.fail('whole histories requested') } }
  const views = createMessageViews({ store, secretRequests: { timeline: () => [row('newest-card', 2)] } })
  const api = createMemberProfileApi({ bots, store, sources: views.sources, transport: { runningBots: async () => new Set(['a', 'b', 'c']) }, administration: {} })
  const response = { writeHead(status) { this.status = status }, end(body) { this.body = JSON.parse(body) } }
  const pending = api({ method: 'GET' }, response, new URL('http://fixture/api/bots'))
  await tick(); states.set('a', 'pending'); states.set('b', 'absent'); actual.resolve(); await pending
  assert.equal(response.status, 200); assert.deepEqual(response.body.bots.map(bot => bot.id), ['a', 'c'])
  assert.equal(response.body.bots[0].deleting, true); assert.equal(response.body.bots[0].online, false)
  assert(response.body.bots.every(bot => bot.recent.id === 'newest-card'))
})
