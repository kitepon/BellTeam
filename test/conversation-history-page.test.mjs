import assert from 'node:assert/strict'
import test from 'node:test'
import { TimelineIndex, timelinePage } from '../src/timeline-index.mjs'
import { conversationHistoryPage } from '../src/conversation/history-page.mjs'
import { validateConversationRequest } from '../src/conversation/requests.mjs'

const context = { generation: 'generation-a', operationId: 'operation-a', actor: { kind: 'owner' }, continuation: false }
test('child page equals full parent composition including card identities and cursor edge cases', () => {
  const base = Array.from({ length: 35 }, (_, n) => ({ id: n === 4 ? 'duplicate' : `row-${n}`, at: `${Math.floor(n / 3)}`.padStart(3, '0'), message: `body-${n}` }))
  const cards = [
    [{ id: 'secret', at: '003', secret_request: { id: 'request', private: 'parent-only' } }, { id: 'duplicate', at: '001' }],
    [{ id: 'question', at: '003', question: 'parent-only' }],
  ]
  for (const rows of [base, []]) for (const extras of [cards, [[], []], [cards[0]]]) {
    const sources = [new TimelineIndex(rows), ...extras.map(items => new TimelineIndex(items))]
    const metadata = extras.map(items => items.map(({ id, at }) => ({ id, at })))
    for (const limit of [null, '1', '2.5', '200', '0', '-1', 'Infinity', 'invalid']) {
      for (const before of [null, 'row-0', 'secret', 'duplicate', 'missing']) for (const after of [null, 'row-2', 'secret', 'question', 'missing']) {
        const query = { limit, before, after }
        const expected = timelinePage(sources, { searchParams: new URLSearchParams(Object.entries(query).filter(([, value]) => value !== null)) })
        const actual = conversationHistoryPage(sources[0], { query, cards: metadata })
        assert.deepEqual({ ...actual, items: actual.items.map(ref => ref.source ? extras[ref.source - 1][ref.index] : ref.item) }, expected)
        for (const ref of actual.items) if (ref.source) assert.deepEqual(Object.keys(ref).sort(), ['index', 'source'])
      }
    }
  }
})

test('page and recent batch payloads reject nested authority/body extras and wrong card/room shapes', () => {
  const page = { kind: 'bots', id: 'bot-a', query: { limit: null, before: null, after: null }, cards: [[], []] }
  for (const value of [
    { ...page, query: { ...page.query, limit: 10 } }, { ...page, query: { ...page.query, authority: {} } },
    { ...page, cards: [[{ id: 'card', at: 'now', body: 'private' }], []] }, { ...page, cards: [[]] },
    { ...page, kind: 'rooms', id: 'a'.repeat(65), cards: [[]] },
  ]) assert.throws(() => validateConversationRequest('history.page', value, context))
  for (const botIds of [[null], ['../../x'], 'bot-a']) assert.throws(() => validateConversationRequest('history.recentBatch', { botIds }, context))
})

test('decoded stream envelopes reject invalid card references and reordered or extra batch rows', async () => {
  const { validateConversationPageRows, validateConversationRecentRows } = await import('../src/conversation/results.mjs')
  const page = { items: [{ source: 0, item: { id: 'row', future: 'retained' } }, { source: 1, index: 0 }], has_more: true, remaining_before: 2 }
  assert.equal(validateConversationPageRows([page], [[{ id: 'card' }], []]), page)
  for (const rows of [[], [page, page], [{ ...page, authority: {} }], [{ ...page, has_more: 1 }], [{ ...page, remaining_before: -1 }],
    ...[{ source: 1, index: 1 }, { source: 2, index: 0 }, { source: 3, index: 0 }, { source: 1, index: -1 }, { source: 1, index: 0.5 },
      { source: 0, item: null }, { source: 1, index: 0, body: 'private' }, { source: 0, item: {}, authority: {} }].map(ref => [{ ...page, items: [ref] }])])
    assert.throws(() => validateConversationPageRows(rows, [[{}], []]))
  const ids = ['bot-a', 'bot-b', 'bot-a'], recent = ids.map(botId => ({ botId, message: null }))
  assert.equal(validateConversationRecentRows(recent, ids), recent)
  for (const rows of [recent.slice(1), [...recent, recent[0]], [recent[1], recent[0], recent[2]], [{ ...recent[0], authority: {} }, ...recent.slice(1)], [{ ...recent[0], message: [] }, ...recent.slice(1)]])
    assert.throws(() => validateConversationRecentRows(rows, ids))
})
