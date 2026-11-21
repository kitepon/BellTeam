import assert from 'node:assert/strict'
import test from 'node:test'
import { TimelineIndex, cardWindow, conversationHistoryPage } from '../src/timeline-index.mjs'

const at = n => new Date(Date.UTC(2026, 10, 1) + n * 1000).toISOString()
const cardRows = (count, step = 2) => Array.from({ length: count }, (_, n) => ({ id: `me-${n}`, at: at(n * step) }))
const base = () => new TimelineIndex(Array.from({ length: 40 }, (_, n) => ({ id: `m-${n}`, at: at(n * 5 + 1), message: `m${n}` })))
const ids = page => page.items.map(entry => entry.item?.id ?? `me-${entry.index}`)

// The windowed page must equal the page built from every card, for every kind of request.
test('a windowed card list gives the same page, has_more and remaining_before as the whole list', () => {
  const all = cardRows(500)
  const requests = [
    { limit: '20' }, { limit: '300' }, { limit: '20', before: 'm-30', hint: at(30 * 5 + 1) }, { limit: '50', before: 'me-200' },
    { limit: '50', before: 'me-3' }, { limit: '1000', before: 'm-39', hint: at(39 * 5 + 1) }, { limit: '20', after: 'me-480' }, { limit: '20', after: 'm-5', hint: at(26) },
  ]
  for (const { hint, ...request } of requests) {
    const query = { limit: request.limit ?? null, before: request.before ?? null, after: request.after ?? null }
    const whole = conversationHistoryPage(base(), { query, cards: [all.map(({ id, at }) => ({ id, at }))] })
    const window = cardWindow(all, { ...query, hint })
    const bounded = conversationHistoryPage(base(), { query, cards: [window.rows], skipped: [window.skipped] })
    const back = page => page.items.map(entry => entry.source === 0 ? entry.item.id : (entry.source === 1 ? (page === bounded ? window.rows : all)[entry.index].id : '?'))
    assert.deepEqual(back(bounded), back(whole), JSON.stringify(request))
    assert.equal(bounded.has_more, whole.has_more, JSON.stringify(request))
    assert.equal(bounded.remaining_before, whole.remaining_before, JSON.stringify(request))
    if (request.limit && !request.after) assert.ok(window.rows.length <= Number(request.limit) * 2 + 4, `window stays bounded for ${JSON.stringify(request)}`)
  }
})

test('a page asks for at most 1000 rows and the card window does not grow with the stream', () => {
  const small = cardWindow(cardRows(2000), { limit: '5000', before: null, after: null, hint: null })
  assert.equal(small.rows.length, 1000)
  assert.equal(small.skipped, 1000)
  const long = cardWindow(cardRows(100000), { limit: '100', before: null, after: null, hint: null })
  assert.equal(long.rows.length, 100)
  assert.equal(long.skipped, 99900)
})

test('without a hint a before cursor that is not a card keeps the whole list', () => {
  const rows = cardRows(50)
  const window = cardWindow(rows, { limit: '10', before: 'm-3', after: null, hint: null })
  assert.equal(window.rows.length, 50); assert.equal(window.skipped, 0)
})
