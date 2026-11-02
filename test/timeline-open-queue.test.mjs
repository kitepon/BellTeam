import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createConversationTimeline } from '../web/conversation-timeline.js'
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const settle = () => new Promise(resolve => setImmediate(resolve))
class Element {
  children = []; dataset = {}; style = {}; listeners = {}; scrollTop = 0; clientHeight = 100
  classes = new Set()
  classList = { add: name => this.classes.add(name), toggle() {} }
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
const saved = { document: globalThis.document, ResizeObserver: globalThis.ResizeObserver, CSS: globalThis.CSS }
function fixture(t, history) {
  globalThis.document = { createElement: () => new Element(), querySelectorAll: () => [] }
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
  const open = (id, type = 'bot') => view.open({ type, id, name: id })
  const ids = () => timeline.children[0].children.map(row => row.dataset.id).filter(Boolean)
  const texts = node => [node.textContent ?? '', ...node.children.map(texts)].join(' ')
  return { view, open, queues, requests, timeline, ids, text: () => texts(timeline) }
}
for (const type of ['bot', 'room']) test(`${type} secret guide uses shared page rendering and is removed by an updated projection`, async t => {
  const request = { id: 'guide-current', botId: 'a', toolId: 'olrw-auth', label: '認証コード', message: '公式ページで認証してください。', status: 'pending',
    ownerGuide: { url: 'https://claude.ai/oauth/authorize?state=synthetic-only' } }
  const row = id => ({ id, at: '2026-11-03T00:00:00Z', secret_request: { ...request, id } })
  const current = row('guide-current'), older = row('guide-older'), added = row('guide-added')
  const before = JSON.stringify([current, older, added])
  let updated = false
  const f = fixture(t, path => {
    if (path.includes('before=')) return { items: [older], has_more: false }
    if (path.includes('after=')) return { items: [added], has_more: false }
    return { items: [updated ? { ...current, secret_request: { ...request, ownerGuide: undefined } } : current], has_more: true }
  })
  const links = node => [...(node.href ? [node] : []), ...node.children.flatMap(links)]
  await f.open('a', type)
  assert.equal(links(f.timeline).length, 1)
  assert.equal(links(f.timeline)[0].textContent, '公式認証ページを開く')
  f.timeline.scrollTop = 0; f.timeline.listeners.scroll(); await settle()
  assert.deepEqual(f.ids(), ['guide-older', 'guide-current'])
  assert.equal(links(f.timeline).length, 2)
  updated = true; await f.view.refresh()
  assert.deepEqual(f.ids(), ['guide-older', 'guide-current', 'guide-added'])
  const currentCard = f.timeline.children[0].children.find(child => child.dataset.id === 'guide-current')
  assert.equal(links(currentCard).length, 0)
  assert.equal(links(f.timeline).length, 2)
  assert.equal(JSON.stringify([current, older, added]), before)
  assert.ok(f.requests.every(path => new RegExp(`^/api/${type === 'room' ? 'rooms' : 'bots'}/a/(messages|queue)(?:[?]|$)`).test(path)))
})

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


const tracking = { schema: 'bellteam.delivery-tracking.v1', admission: 'accepted', completion: 'unknown' }
const messageTimes = f => f.timeline.children[0].children.filter(row => row.dataset.id && row.className?.startsWith('message '))
  .map(row => row.children.at(-1).children.find(node => node.className === 'message-time'))

test('accepted tracking failure is neutral; old, incomplete and unknown tuples retain delivery failure', async t => {
  const variants = [undefined, null, {}, true, 'accepted', { ...tracking, schema: 'future' },
    { ...tracking, admission: 'unknown' }, { ...tracking, completion: 'complete' },
    { schema: tracking.schema, admission: tracking.admission }, tracking]
  const f = fixture(t, () => ({ items: variants.map((value, i) => ({ id: `m${i}`, direction: 'outgoing',
    delivery: 'failed', deliveryTracking: value, delivery_tracking: tracking })), has_more: false }))
  await f.open('a')
  const times = messageTimes(f)
  assert.equal(times.length, variants.length)
  for (const time of times.slice(0, -1)) {
    assert.equal(time.textContent, '配達失敗'); assert.equal(time.classes.has('failed'), true)
  }
  assert.equal(times.at(-1).textContent, '受付済み・完了未確認')
  assert.equal(times.at(-1).classes.has('failed'), false)
})

test('tracking metadata cannot replace a known nonfailed status', async t => {
  const statuses = ['queued', 'running', 'delivered', 'stopped']
  const f = fixture(t, () => ({ items: statuses.map(delivery => ({ id: delivery, direction: 'outgoing',
    delivery, deliveryTracking: tracking })), has_more: false }))
  await f.open('a')
  assert.deepEqual(messageTimes(f).map(node => node.textContent), ['送信待ち', '処理中', '配達済み', '停止'])
})

const roomRecord = (id, deliveries, routing = { status: 'ready', responders: [] }) => ({
  id, sender: { id: 'user', name: 'Owner' }, message: 'room', room: { members: [] }, routing, deliveries,
})
test('room projection requires tracking evidence on every failed participant and keeps routing failures', async t => {
  const accepted = { delivery: 'failed', deliveryTracking: tracking }
  const f = fixture(t, () => ({ items: [
    roomRecord('all', [accepted, { ...accepted }]),
    roomRecord('partial', [accepted, { delivery: 'delivered' }]),
    roomRecord('running', [accepted, { delivery: 'running' }]),
    roomRecord('queued', [accepted, { delivery: 'queued' }]),
    roomRecord('stopped', [accepted, { delivery: 'stopped' }]),
    roomRecord('mixed', [accepted, { delivery: 'failed' }]),
    roomRecord('unknown', [accepted, { delivery: 'failed', deliveryTracking: { ...tracking, schema: 'future' } }]),
    roomRecord('routing', [accepted], { status: 'failed' }),
    { ...roomRecord('wrong-location', [{ delivery: 'failed' }]), deliveryTracking: tracking },
  ], has_more: false }))
  await f.open('r', 'room')
  assert.deepEqual(messageTimes(f).map(node => node.textContent),
    [...Array(5).fill('完了未確認の宛先あり'), ...Array(4).fill('配達失敗')])
  assert.deepEqual(messageTimes(f).map(node => node.classes.has('failed')), [false, false, false, false, false, true, true, true, true])
})

test('latest/after and before pages share evidence rendering; queue removal exposes the accepted unknown result', async t => {
  let latest = 0
  const item = id => ({ id, direction: 'outgoing', delivery: 'failed', deliveryTracking: tracking })
  const f = fixture(t, path => path.includes('before=') ? { items: [item('older')], has_more: false }
    : path.includes('after=') ? { items: [item('added')], has_more: false }
    : { items: [latest++ ? item('initial') : { ...item('initial'), delivery: 'running' }], has_more: true })
  await f.open('a')
  f.queues[0].resolve({ items: [{ botId: 'a', groupId: 'initial', status: 'running' }] }); await settle()
  assert.equal(messageTimes(f)[0].textContent, '')
  await f.view.refresh()
  f.queues[1].resolve({ items: [] }); await settle()
  f.timeline.scrollTop = 0; f.timeline.listeners.scroll(); await settle()
  assert.deepEqual(f.ids(), ['older', 'initial', 'added'])
  assert.deepEqual(messageTimes(f).map(node => node.textContent), Array(3).fill('受付済み・完了未確認'))
})


test('writer-to-HTTP wire fixture renders accepted direct, existing peer details and mixed room failure', async t => {
  const wire = JSON.parse(await readFile(new URL('./fixtures/delivery-tracking-wire.json', import.meta.url), 'utf8'))
  const before = JSON.stringify(wire)
  const direct = fixture(t, () => wire.direct)
  await direct.open('a')
  assert.equal(messageTimes(direct).length, 1)
  assert.match(messageTimes(direct)[0].textContent, /受付済み・完了未確認$/u)
  assert.equal(messageTimes(direct)[0].classes.has('failed'), false)
  const peer = direct.timeline.children[0].querySelector('[data-id="d2"]')
  assert.equal(peer.className, 'peer-event')
  assert.match(peer.innerHTML, /Bからメッセージを受け取りました/u)
  assert.doesNotMatch(peer.innerHTML, /配達失敗|再送/u)
  const room = fixture(t, () => wire.room)
  await room.open('room-a', 'room')
  assert.match(messageTimes(room)[0].textContent, /配達失敗$/u)
  assert.equal(messageTimes(room)[0].classes.has('failed'), true)
  assert.doesNotMatch(room.text(), /完了未確認の宛先あり|受付済み/u)
  assert.equal(JSON.stringify(wire), before, 'the consumer must preserve original failed values and evidence')
})
