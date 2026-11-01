import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversationTimeline } from '../web/conversation-timeline.js'
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const settle = () => new Promise(resolve => setImmediate(resolve))
class Element {
  children = []; dataset = {}; style = {}; listeners = {}; scrollTop = 0; clientHeight = 100
  classList = { add() {}, toggle() {} }
  get scrollHeight() { return this.children.reduce((sum, child) => sum + 100 + child.scrollHeight, 0) }
  get firstChild() { return this.children[0] }
  addEventListener(name, listener) { this.listeners[name] = listener }
  setAttribute() {}
  append(...rows) { for (const row of rows) { row.parent = this; this.children.push(row) } }
  replaceChildren(...rows) { this.children = []; this.append(...rows) }
  replaceWith(row) { const i = this.parent.children.indexOf(this); this.parent.children.splice(i, 1, row); row.parent = this.parent }
  after(...rows) { const i = this.parent.children.indexOf(this); this.parent.children.splice(i + 1, 0, ...rows); for (const row of rows) row.parent = this.parent }
  scrollTo({ top }) { this.scrollTop = top }
  querySelector(selector) { return this.querySelectorAll(selector)[0] }
  querySelectorAll(selector) {
    return this.children.flatMap(child => {
      const match = selector.startsWith('[data-id=') ? child.dataset.id === selector.slice(10, -2) : selector === '[data-stop-bot-id]' && child.dataset.stopBotId
      return [...(match ? [child] : []), ...child.querySelectorAll(selector)]
    })
  }
}
function fixture(t, history) {
  const saved = { document: globalThis.document, ResizeObserver: globalThis.ResizeObserver, CSS: globalThis.CSS }
  globalThis.document = { createElement: () => new Element() }
  globalThis.ResizeObserver = class { observe() {} }
  globalThis.CSS = { escape: value => value }
  t.after(() => Object.assign(globalThis, saved))
  const queues = [], requests = [], timeline = new Element(), latestButton = new Element()
  const view = createConversationTimeline({ timeline, latestButton,
    api: async (path, options) => {
      requests.push(path)
      if (path.endsWith('/queue')) { const pending = deferred(); queues.push(pending); return pending.promise }
      return history ? history(path, options) : { items: [{ id: path.split('/')[3] + '-message', message: 'hello', direction: 'incoming' }], has_more: false }
    }, messageImages: { load() {}, get() {}, failed() {} }, getBot() {}, avatarColor: async () => '', isStopping: () => false, onStop() {}, onQueueChange() {},
  })
  const open = id => view.open({ type: 'bot', id, name: id })
  const ids = () => timeline.children[0].children.map(row => row.dataset.id).filter(Boolean)
  const texts = node => [node.textContent ?? '', ...node.children.map(texts)].join(' ')
  return { view, open, queues, requests, timeline, ids, text: () => texts(timeline) }
}
test('new history appears without queue; late queue from old target cannot replace current queue', async t => {
  const f = fixture(t)
  await f.open('a'); assert.deepEqual(f.ids(), ['a-message'])
  await f.open('b'); assert.deepEqual(f.ids(), ['b-message'])
  f.queues[1].resolve({ items: [{ botId: 'b', groupId: 'q', status: 'queued' }] }); await settle()
  f.queues[0].resolve({ items: [{ botId: 'a', groupId: 'q', status: 'queued' }] }); await settle()
  assert.equal(f.view.isBusy('b'), true)
  assert.equal(f.view.isBusy('a'), false)
})
test('queue failure keeps history and explicitly displays unknown work state', async t => {
  const f = fixture(t)
  await f.open('a'); f.queues[0].reject(new Error('unavailable')); await settle()
  assert.deepEqual(f.ids(), ['a-message'])
  assert.match(f.text(), /送信待ちの状態を取得できません/)
})
test('old history success/failure and close cannot populate a different conversation', async t => {
  const pending = deferred()
  const f = fixture(t, path => path.includes('/a/') ? pending.promise : { items: [{ id: 'b', message: 'B' }], has_more: false })
  const old = f.open('a'); await f.open('b')
  pending.reject(new Error('old failure')); await old
  assert.deepEqual(f.ids(), ['b'])
  assert.doesNotMatch(f.text(), /読み込めません/)
  const late = deferred()
  const g = fixture(t, () => late.promise)
  const opened = g.open('a'); g.view.close()
  late.resolve({ items: [{ id: 'old', message: 'old' }] }); await opened
  assert.deepEqual(g.ids(), [])
})
test('overlapping refreshes apply only newest response; current read failure stays in the view', async t => {
  const pending = []
  let first = true
  const f = fixture(t, path => {
    if (first) { first = false; return { items: [{ id: 'initial', message: 'old' }] } }
    if (path.includes('after=')) return { items: [] }
    const next = deferred(); pending.push(next); return next.promise
  })
  await f.open('a')
  const older = f.view.refresh(), newer = f.view.refresh()
  pending[1].resolve({ items: [{ id: 'initial', message: 'new' }] }); await newer
  pending[0].resolve({ items: [{ id: 'initial', message: 'stale' }] }); await older
  const row = f.timeline.children[0].querySelector('[data-id="initial"]')
  const bubble = row.children[0].children[0]
  assert.equal(bubble.children[0].innerHTML.includes('new'), true)
  const failed = f.view.refresh(); pending[2].reject(new Error('GET failed'))
  assert.equal(await failed, false)
  assert.match(f.text(), /会話を読み込めません/)
})
test('old before-page finally cannot unlock a new before request; current page prepends without duplicates', async t => {
  const before = []
  const f = fixture(t, path => {
    if (path.includes('before=')) { const next = deferred(); before.push(next); return next.promise }
    return { items: [{ id: path.includes('/a/') ? 'a' : 'b', message: 'latest' }], has_more: true }
  })
  await f.open('a'); f.timeline.scrollTop = 0; f.timeline.listeners.scroll()
  await f.open('b'); f.timeline.scrollTop = 0; f.timeline.listeners.scroll()
  before[0].resolve({ items: [], has_more: false }); await settle()
  f.timeline.listeners.scroll(); assert.equal(before.length, 2)
  before[1].resolve({ items: [{ id: 'older', message: 'older' }, { id: 'b', message: 'duplicate' }], has_more: false }); await settle()
  assert.deepEqual(f.ids(), ['older', 'b'])
  assert.ok(f.timeline.scrollTop > 0)
})

test('late question answer callback cannot replace a same-ID card in a new conversation', async t => {
  const answer = deferred()
  const f = fixture(t, path => {
    if (path.includes('/answer')) return answer.promise
    const id = path.includes('/a/') ? 'a' : 'b'
    return { items: [{ id: 'same', owner_question: { id: 'q-' + id, botId: id, question: 'question-' + id, status: 'pending', options: ['yes'] } }] }
  })
  await f.open('a')
  const firstCard = f.timeline.children[0].children[1]
  firstCard.children[2].children[0].listeners.click()
  await f.open('b')
  answer.resolve({ question: { id: 'q-a', question: 'old answered', status: 'answered', answer: 'yes' } }); await settle()
  assert.match(f.text(), /question-b/)
  assert.doesNotMatch(f.text(), /old answered|回答: yes/)
})
