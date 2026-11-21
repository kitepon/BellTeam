import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createConversationTimeline, locateQuotePart, splitOrigin } from '../web/conversation-timeline.js'
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const settle = () => new Promise(resolve => setImmediate(resolve))
class Element {
  children = []; dataset = {}; style = {}; listeners = {}; scrollTop = 0; clientHeight = 100
  classes = new Set()
  classList = { add: name => this.classes.add(name), remove: name => this.classes.delete(name), toggle() {} }
  scrollIntoView(options) { this.scrolledTo = options }
  get scrollHeight() { return this.children.reduce((sum, child) => sum + 100 + child.scrollHeight, 0) }
  get firstChild() { return this.children[0] }
  addEventListener(name, listener) { this.listeners[name] = listener }
  attrs = {}
  setAttribute(name, value) { this.attrs[name] = value }
  append(...rows) { for (const row of rows) { row.parent = this; this.children.push(row) } }
  replaceChildren(...rows) { this.children = []; this.append(...rows) }
  remove() { const i = this.parent?.children.indexOf(this) ?? -1; if (i >= 0) this.parent.children.splice(i, 1) }
  replaceWith(row) { const i = this.parent.children.indexOf(this); this.parent.children.splice(i, 1, row); row.parent = this.parent }
  after(...rows) { const i = this.parent.children.indexOf(this); this.parent.children.splice(i + 1, 0, ...rows); for (const row of rows) row.parent = this.parent }
  scrollTo({ top, behavior }) { this.scrollTop = top; this.lastBehavior = behavior }
  contains() { return true }
  querySelector(selector) { return this.querySelectorAll(selector)[0] }
  querySelectorAll(selector) {
    return this.children.flatMap(child => {
      const match = selector.startsWith('[data-id=') ? child.dataset.id === selector.slice(10, -2) : selector === '.message-text' ? child.className === 'message-text' : selector === '[data-stop-bot-id]' && child.dataset.stopBotId
      return [...(match ? [child] : []), ...child.querySelectorAll(selector)]
    })
  }
}
const saved = { document: globalThis.document, ResizeObserver: globalThis.ResizeObserver, CSS: globalThis.CSS }
function fixture(t, history, extra = {}) {
  globalThis.document = { createElement: () => new Element(), querySelectorAll: () => [] }
  const resizers = []
  globalThis.ResizeObserver = class { constructor(callback) { resizers.push(callback) } observe() {} }
  globalThis.CSS = { escape: value => value }
  t.after(() => Object.assign(globalThis, saved))
  const queues = [], requests = [], timeline = new Element(), latestButton = new Element()
  timeline.clientHeight = 1e6 // a tall view: the 3-screen margin is never full, so the background read of one older page happens (a471-fill-drawn-web)
  const view = createConversationTimeline({ timeline, latestButton,
    api: async (path, options) => {
      requests.push(path)
      if (path.endsWith('/queue')) { const pending = deferred(); queues.push(pending); return pending.promise }
      return history ? history(path, options) : { items: [{ id: path.split('/')[3] + '-message', message: 'hello', direction: 'incoming' }], has_more: false }
    }, messageImages: { load() {}, get() {}, failed() {} }, getBot() {}, avatarColor: async () => '', isStopping: () => false, onStop() {}, onQueueChange() {}, ...extra,
  })
  const open = (id, type = 'bot') => view.open({ type, id, name: id })
  const ids = () => timeline.children[2].children.map(row => row.dataset.id).filter(Boolean)
  const texts = node => [node.textContent ?? '', ...node.children.map(texts)].join(' ')
  return { view, open, queues, requests, timeline, latestButton, resizers, ids, text: () => texts(timeline) }
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
  await settle() // the older page is read in the background after the first paint
  assert.equal(links(f.timeline)[0].textContent, '公式認証ページを開く')
  assert.deepEqual(f.ids(), ['guide-older', 'guide-current'])
  assert.equal(links(f.timeline).length, 2)
  updated = true; await f.view.refresh()
  assert.deepEqual(f.ids(), ['guide-older', 'guide-current', 'guide-added'])
  const currentCard = f.timeline.children[2].children.find(child => child.dataset.id === 'guide-current')
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
  assert.match(f.text(), /送信待ちの状態を読み込めませんでした。 もう一度読み込む/)
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
  const row = f.timeline.children[2].querySelector('[data-id="initial"]')
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
  await f.open('a'); await settle(); f.timeline.listeners.scroll()
  await f.open('b'); await settle(); f.timeline.listeners.scroll()
  assert.equal(before.length, 2, 'each target reads its own older page in the background; a scroll does not start a second one while it is on its way')
  before[0].resolve({ items: [], has_more: false }); await settle()
  f.timeline.listeners.scroll(); assert.equal(before.length, 2)
  before[1].resolve({ items: [{ id: 'older', message: 'older' }, { id: 'b', message: 'duplicate' }], has_more: false }); await settle()
  assert.deepEqual(f.ids(), ['older', 'b'])
  assert.equal(f.timeline.scrollTop, 0, 'the older page goes above the view: nothing is scrolled to keep the place (the bottom is the anchor)')
})

test('late question answer callback cannot replace a same-ID card in a new conversation', async t => {
  const answer = deferred()
  const f = fixture(t, path => {
    if (path.includes('/answer')) return answer.promise
    const id = path.includes('/a/') ? 'a' : 'b'
    return { items: [{ id: 'same', owner_question: { id: 'q-' + id, botId: id, question: 'question-' + id, status: 'pending', options: ['yes'] } }] }
  })
  await f.open('a')
  const firstCard = f.timeline.children[2].children[1]
  firstCard.children[2].children[0].listeners.click()
  await f.open('b')
  answer.resolve({ question: { id: 'q-a', question: 'old answered', status: 'answered', answer: 'yes' } }); await settle()
  assert.match(f.text(), /question-b/)
  assert.doesNotMatch(f.text(), /old answered|回答: yes/)
})


const tracking = { schema: 'bellteam.delivery-tracking.v1', admission: 'accepted', completion: 'unknown' }
const messageTimes = f => f.timeline.children[2].children.filter(row => row.dataset.id && row.className?.startsWith('message '))
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

test('D1 failed input renders closed reasons without running or replay affordances', async t => {
  const observation = '席の状態を確認できず、送信できませんでした。席を再起動してください。'
  const launch = '席を起動できず、送信できませんでした。席を再起動してください。'
  const codes = ['BOT_OBSERVATION_FAILED', 'BOT_CONFIGURATION_FAILED', 'BOT_LAUNCH_FAILED', 'BOT_SEND_FAILED', 'BOT_DELIVERY_FAILED', 'BOT_SESSION_UNCONFIRMED']
  const items = codes.map(code => ({ id: code, direction: 'outgoing', delivery: 'failed', delivery_error: { code } }))
  items.push({ id: 'future', direction: 'outgoing', delivery: 'failed', delivery_error: { code: 'FUTURE', message: 'raw-native-error' } },
    { id: 'accepted', direction: 'outgoing', delivery: 'failed', deliveryTracking: tracking, delivery_error: { code: codes[0] } },
    { id: 'peer', kind: 'peer', direction: 'sent', peerName: 'B', message: 'peer input', delivery: 'failed', delivery_error: { code: 'BOT_SEND_FAILED' } })
  const roomItems = [
    roomRecord('room-refused', [{ delivery: 'failed', delivery_error: { code: 'BOT_LAUNCH_FAILED' } }, { delivery: 'failed', deliveryTracking: tracking }]),
    roomRecord('room-accepted', [{ delivery: 'failed', deliveryTracking: tracking, delivery_error: { code: codes[0] } }]),
    { ...roomRecord('room-wrong-location', [{ delivery: 'failed' }]), delivery_error: { code: codes[0] } },
    roomRecord('room-routing', [{ delivery: 'failed', delivery_error: { code: codes[0] } }], { status: 'failed' }),
  ]
  const before = JSON.stringify([items, roomItems])
  let delivered = false
  const f = fixture(t, (path, options) => {
    assert.ok(!options?.method || options.method === 'GET', 'rendering must not replay input')
    return { items: path.includes('after=') ? [] : path.includes('/rooms/') ? roomItems
      : delivered ? items.map(item => ({ ...item, delivery: 'delivered' })) : items, has_more: false }
  })
  await f.open('a')
  f.queues[0].resolve({ items: [
    { id: 'delivery-id', groupId: codes[0], botId: 'a', botName: 'A', status: 'failed', errorCode: codes[0] },
    { id: 'tail-delivery', groupId: 'tail-group', botId: 'a', botName: 'A', status: 'failed', errorCode: 'BOT_LAUNCH_FAILED' },
  ] }); await settle()
  assert.equal(f.view.isBusy('a'), false)
  assert.equal(f.timeline.querySelectorAll('[data-stop-bot-id]').length, 0)
  assert.match(f.text(), /配達失敗/)
  assert.ok(f.text().includes(observation) && f.text().includes(launch))
  assert.doesNotMatch(f.text(), /処理中|raw-native-error|FUTURE/)
  assert.deepEqual(f.ids(), items.map(item => item.id))
  await f.view.refresh(); f.queues[1].resolve({ items: [] }); await settle()
  assert.deepEqual(messageTimes(f).map(node => node.textContent), [observation,
    '席の設定を反映できず、送信できませんでした。設定を確認してください。', launch,
    '席への送信に失敗しました。送信結果を確認してください。', '送信に失敗しました。会話を確認してください。',
    observation, '配達失敗', '受付済み・完了未確認'])
  assert.equal(messageTimes(f).at(-1).classes.has('failed'), false)
  assert.ok(f.text().includes('席への送信に失敗しました。送信結果を確認してください。'))
  await f.open('r', 'room'); f.queues[2].resolve({ items: [] }); await settle()
  assert.deepEqual(messageTimes(f).map(node => node.textContent), [launch, '完了未確認の宛先あり', '配達失敗', '配達失敗'])
  delivered = true
  await f.open('a'); f.queues[3].resolve({ items: [] }); await settle()
  assert.deepEqual(messageTimes(f).map(node => node.textContent), Array(8).fill('配達済み'))
  assert.doesNotMatch(f.text(), /送信できませんでした|送信に失敗|配達失敗/)
  assert.equal(JSON.stringify([items, roomItems]), before)
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
  await f.open('a'); await settle() // the older page is read in the background
  f.queues[0].resolve({ items: [{ botId: 'a', groupId: 'initial', status: 'running' }] }); await settle()
  assert.equal(messageTimes(f)[1].textContent, '')
  await f.view.refresh()
  f.queues[1].resolve({ items: [] }); await settle()
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
  const peer = direct.timeline.children[2].querySelector('[data-id="d2"]')
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

test('fork rows (seat.kind fork) carry the 分身 label; rows without seat stay main', async t => {
  const items = [
    { id: 'ask', kind: 'peer', direction: 'received', peerName: 'アン', message: 'q', at: '2026-11-10T00:00:00Z', seat: { kind: 'fork', fork_id: 'f1' } },
    { id: 'words', kind: 'interim', direction: 'incoming', message: 'w', at: '2026-11-10T00:00:01Z', seat: { kind: 'fork', fork_id: 'f1' } },
    { id: 'relay', kind: 'peer', direction: 'sent', peerName: 'アン', message: 'a', at: '2026-11-10T00:00:02Z', seat: { kind: 'fork', fork_id: 'f1' }, in_reply_to: 'ask' },
    { id: 'main', kind: 'message', direction: 'incoming', message: 'm', at: '2026-11-10T00:00:03Z' },
    { id: 'main-peer', kind: 'peer', direction: 'received', peerName: 'アン', message: 'p', at: '2026-11-10T00:00:04Z' },
  ]
  const f = fixture(t, () => ({ items, has_more: false }))
  await f.open('b')
  const row = id => f.timeline.children[2].children.find(child => child.dataset.id === id)
  const labels = node => [...(node.className === 'seat-label' ? [node.textContent] : []), ...node.children.flatMap(labels)]
  const html = node => [node.innerHTML ?? '', ...node.children.map(html)].join('')
  assert.match(html(row('ask')), /<summary><span class="seat-label">分身<\/span>アンからメッセージを受け取りました/)
  assert.match(html(row('relay')), /<summary><span class="seat-label">分身<\/span>アンへメッセージを送りました/)
  assert.deepEqual(labels(row('words')), ['分身'])
  assert.deepEqual(labels(row('main')), [])
  assert.doesNotMatch(html(row('main-peer')), /seat-label/)
})
test('a failed older page is the retry target: 「もう一度読み込む」 re-reads that page and its success clears the error', async t => {
  let olderFails = true
  const f = fixture(t, path => {
    if (path.includes('before=')) { if (olderFails) throw new Error('offline'); return { items: [{ id: 'old', message: 'old', direction: 'incoming' }], has_more: false } }
    return { items: [{ id: 'new', message: 'new', direction: 'incoming' }], has_more: true }
  })
  await f.open('a'); f.queues[0].resolve({ items: [] }); await settle()
  const box = () => f.timeline.children[0].children.find(node => node.className === 'inline-error')
  assert.ok(box(), 'the older-page failure is shown in place')
  const before = f.requests.length
  olderFails = false
  box().children.find(node => node.textContent === 'もう一度読み込む').listeners.click(); await settle()
  assert.deepEqual(f.requests.slice(before), ['/api/bots/a/messages?limit=1000&before=new']) // the same older page, not the newest page
  assert.equal(box(), undefined)
  assert.deepEqual(f.ids(), ['old', 'new'])
})

test('an older page that fails and then succeeds by scrolling clears its error; a newest-page read does not settle it', async t => {
  let olderFails = true
  const f = fixture(t, path => {
    if (path.includes('before=')) { if (olderFails) throw new Error('offline'); return { items: [{ id: 'old', message: 'old', direction: 'incoming' }], has_more: false } }
    if (path.includes('after=')) return { items: [], has_more: false }
    return { items: [{ id: 'new', message: 'new', direction: 'incoming' }], has_more: true }
  })
  await f.open('a'); f.queues[0].resolve({ items: [] }); await settle()
  f.timeline.scrollTop = 0; f.timeline.listeners.scroll(); await settle()
  await f.view.refresh(); f.queues.at(-1).resolve({ items: [] }); await settle()
  assert.match(f.text(), /会話を読み込めませんでした/) // the newest page read does not settle the older page's failure
  olderFails = false
  f.timeline.scrollTop = 0; f.timeline.listeners.scroll(); await settle()
  assert.doesNotMatch(f.text(), /会話を読み込めませんでした/)
})

// ---- reply (a269): the quote is drawn only from item.reply_to; tapping it jumps by id ----
const everyNode = node => [node, ...node.children.flatMap(everyNode)]
const quotes = timeline => everyNode(timeline).filter(node => /^reply-quote( is-gone)?$/u.test(String(node.className)))
const snapshot = (id, extra = {}) => ({ id, available: true, sender: { id: 'bot-a', name: 'A' }, at: '2026-11-16T00:00:00Z', text: '元の1行目', ...extra })
const msg = (id, extra = {}) => ({ id, at: '2026-11-16T00:00:00Z', message: `text ${id}`, direction: 'incoming', sender: 'A', ...extra })

test('reply: a quote is drawn from reply_to (sender, text, ellipsis, image-only), an unavailable original is a fixed untappable line, items without it are unchanged', async t => {
  const f = fixture(t, () => ({ has_more: false, items: [
    msg('plain'),
    msg('r1', { direction: 'outgoing', reply_to: snapshot('o1', { sender: { id: 'user', name: 'オーナー' }, truncated: true }) }),
    msg('r2', { direction: 'outgoing', reply_to: snapshot('o2', { text: '', image: true }) }),
    msg('r3', { direction: 'outgoing', reply_to: { id: 'gone', available: false } }),
  ] }))
  await f.open('a'); await settle()
  const drawn = quotes(f.timeline)
  assert.equal(drawn.length, 3)
  assert.equal(f.text().includes('あなた'), true); assert.equal(f.text().includes('元の1行目…'), true, 'truncated shows the ellipsis')
  assert.equal(f.text().includes('（画像）'), true)
  const gone = drawn.find(node => String(node.className).includes('is-gone'))
  assert.equal(gone.textContent, '元のメッセージを表示できません'); assert.equal(gone.listeners.click, undefined, 'not tappable')
  assert.equal(drawn.filter(node => node.listeners.click).length, 2)
})

test('reply: 返信 on a message hands {id, sender, first line} to the composer; an image-only message reads （画像）', async t => {
  const picked = []
  const f = fixture(t, () => ({ has_more: false, items: [msg('m1', { message: '一行目\n二行目' }), msg('m2', { direction: 'outgoing', message: '', image: true })] }), { onReply: reply => picked.push(reply) })
  await f.open('a'); await settle()
  const buttons = everyNode(f.timeline).filter(node => node.className === 'message-reply')
  assert.equal(buttons.length, 2)
  buttons[0].listeners.click(); buttons[1].listeners.click()
  assert.deepEqual(picked, [{ id: 'm1', sender: 'A', text: '一行目' }, { id: 'm2', sender: 'あなた', text: '（画像）' }])
})

test('actions: every message row shows reply, forward and copy icons; copy writes the message text, an image-only row has no copy', async t => {
  const f = fixture(t, () => ({ has_more: false, items: [msg('m1', { message: '一行目\n二行目' }), msg('m2', { direction: 'outgoing', message: '', image: true })] }))
  await f.open('a'); await settle()
  const rows = everyNode(f.timeline).filter(node => node.className === 'message-actions')
  assert.deepEqual(rows.map(row => row.children.map(button => button.attrs['aria-label'])), [['このメッセージに返信', 'このメッセージを転送', 'このメッセージをコピー'], ['このメッセージに返信', 'このメッセージを転送']])
  assert.equal(rows[0].children.every(button => button.innerHTML.startsWith('<svg') && !button.textContent), true, 'icons only, no text')
  const written = []
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async text => { written.push(text) } } }, configurable: true })
  t.after(() => saved ? Object.defineProperty(globalThis, 'navigator', saved) : delete globalThis.navigator)
  await rows[0].children[2].listeners.click()
  assert.deepEqual(written, ['一行目\n二行目'])
})

test('reply: tapping the quote scrolls to a loaded original and highlights it', async t => {
  const f = fixture(t, () => ({ has_more: false, items: [msg('o1'), msg('r1', { direction: 'outgoing', reply_to: snapshot('o1') })] }))
  await f.open('a'); await settle()
  quotes(f.timeline)[0].listeners.click(); await settle()
  const original = f.timeline.children[2].children.find(row => row.dataset.id === 'o1')
  assert.deepEqual(original.scrolledTo, { block: 'center' }); assert.equal(original.classes.has('reply-jumped'), true)
})

test('reply: an original on an older page is loaded with the before cursor until it appears; one that never appears shows a note and does not jump', async t => {
  const f = fixture(t, path => {
    if (path.includes('before=m3')) return { has_more: true, items: [msg('m2')] }
    if (path.includes('before=m2')) return { has_more: false, items: [msg('m1')] }
    return { has_more: true, items: [msg('m3', { direction: 'outgoing', reply_to: snapshot('m1') }), msg('m4', { direction: 'outgoing', reply_to: snapshot('nowhere') })] }
  })
  await f.open('a'); await settle()
  const [far, never] = quotes(f.timeline)
  far.listeners.click(); await settle(); await settle()
  assert.equal(f.requests.filter(path => path.includes('before=')).length, 2, 'paged older twice')
  assert.deepEqual(f.timeline.children[2].children.find(row => row.dataset.id === 'm1').scrolledTo, { block: 'center' })
  never.listeners.click(); await settle(); await settle()
  assert.equal(everyNode(f.timeline).filter(node => node.className === 'reply-quote-note' && node.textContent === '元のメッセージは見つかりません').length, 1)
  never.listeners.click(); await settle(); await settle()
  assert.equal(everyNode(f.timeline).filter(node => node.className === 'reply-quote-note').length, 1, 'one note only')
})

test('reply: a room record passes reply_to through to its quote', async t => {
  const f = fixture(t, () => ({ has_more: false, items: [{ id: 'rm1', at: '2026-11-16T00:00:00Z', message: 'hi', sender: { id: 'user', name: 'オーナー' }, room: { members: [] }, reply_to: snapshot('rm0') }] }))
  await f.open('room1', 'room'); await settle()
  assert.equal(quotes(f.timeline).length, 1); assert.equal(f.text().includes('元の1行目'), true)
})

// ---- reply to a selected part (a269r) ----
test('locateQuotePart: first hit at or after from, else the first hit, across text nodes; none -> null', () => {
  const n = ['前の', '文章です。そして', '文章です。'].map(textContent => ({ textContent }))
  assert.deepEqual(locateQuotePart([n[1]], 'そして', 0), { startNode: n[1], startOffset: 5, endNode: n[1], endOffset: 8 })
  const first = locateQuotePart(n, '文章です。', 0), later = locateQuotePart(n, '文章です。', 5)
  assert.deepEqual([first.startNode === n[1], first.startOffset], [true, 0]); assert.deepEqual([later.startNode === n[2], later.startOffset], [true, 0], 'the hit at or after from')
  assert.equal(locateQuotePart(n, '文章です。', 99).startNode, n[1], 'nothing at or after from: the first hit')
  const across = locateQuotePart(n, 'の文章', 0); assert.deepEqual([across.startNode === n[0], across.startOffset, across.endNode === n[1], across.endOffset], [true, 1, true, 2])
  assert.equal(locateQuotePart(n, '無い', 0), null); assert.equal(locateQuotePart(n, '', 0), null)
})

test('reply part: the quote draws the saved part; an unavailable original keeps the excerpt with the fixed line and is not tappable', async t => {
  const f = fixture(t, () => ({ has_more: false, items: [
    msg('p1', { direction: 'outgoing', reply_to: snapshot('o1', { text: '選んだ部分', part: true, range: { start: 3, end: 8 } }) }),
    msg('p2', { direction: 'outgoing', reply_to: { id: 'lost', available: false, part: true, text: '消えた元の抜粋', truncated: true } }),
  ] }))
  await f.open('a'); await settle()
  const [ok, gone] = quotes(f.timeline)
  assert.equal(ok.listeners.click !== undefined, true); assert.equal(f.text().includes('選んだ部分'), true)
  assert.equal(gone.listeners.click, undefined); const flat = node => [node.textContent ?? '', ...node.children.map(flat)].join(''); assert.equal(flat(gone), '消えた元の抜粋…元のメッセージを表示できません')
})

test('reply part: tapping a part quote highlights that text in the original (first hit at or after range.start); without the API only the row is marked', async t => {
  const highlights = new Map(), made = []
  globalThis.Highlight = class { constructor(range) { this.range = range; made.push(this) } }
  globalThis.Range = class { setStart(node, offset) { this.start = [node, offset] } setEnd(node, offset) { this.end = [node, offset] } }
  globalThis.CSS = { escape: value => value, highlights: { set: (name, value) => highlights.set(name, value), delete: name => highlights.delete(name) } }
  t.after(() => { delete globalThis.Highlight; delete globalThis.Range })
  const f = fixture(t, () => ({ has_more: false, items: [msg('o1', { message: '前置き。大事な点。後ろ。大事な点。' }), msg('r1', { direction: 'outgoing', reply_to: snapshot('o1', { text: '大事な点。', part: true, range: { start: 10, end: 15 } }) })] }))
  globalThis.CSS = { escape: value => value, highlights: { set: (name, value) => highlights.set(name, value), delete: name => highlights.delete(name) } }
  await f.open('a'); await settle()
  const original = f.timeline.children[2].children.find(row => row.dataset.id === 'o1')
  const holder = everyNode(original).find(node => node.className === 'message-text'); const text = { textContent: '前置き。大事な点。後ろ。大事な点。', children: [], dataset: {}, querySelectorAll: () => [] }; holder.children = [text]
  document.createTreeWalker = root => { const list = [...root.children]; return { nextNode: () => list.shift() ?? null } }
  quotes(f.timeline)[0].listeners.click(); await settle()
  const range = highlights.get('reply-part').range
  assert.deepEqual([range.start[0] === text, range.start[1], range.end[1]], [true, 12, 17], 'the second hit, at or after range.start (10)')
  assert.equal(original.classes.has('reply-jumped'), true)
  highlights.clear(); delete globalThis.Highlight
  quotes(f.timeline)[0].listeners.click(); await settle()
  assert.equal(highlights.size, 0, 'no Highlight API: no throw, row mark only')
})

test('reply part: a selection inside one message text shows 引用して返信 and hands {id, sender, text, quote} to the composer; other selections hide it', async t => {
  const body = new Element(), handlers = {}, picked = []
  globalThis.document = { ...globalThis.document, body, addEventListener: (name, fn) => { handlers[name] = fn }, createElement: () => new Element(), querySelectorAll: () => [] }
  let removed = 0, selection = null
  globalThis.getSelection = () => selection ?? { isCollapsed: true, removeAllRanges() { removed++ } }
  t.after(() => { delete globalThis.getSelection })
  const f = fixture(t, () => ({ has_more: false, items: [msg('m1', { message: '一行目の文章\n二行目' })] }), { onReply: reply => picked.push(reply) })
  document.body = body; handlers.selectionchange = undefined
  // fixture installs its own document; rebuild the timeline with the body present
  globalThis.document.body = body
  const view = (await import('../web/conversation-timeline.js')).createConversationTimeline
  const requests = [], timeline = new Element(), latestButton = new Element()
  globalThis.document.addEventListener = (name, fn) => { handlers[name] = fn }
  const v = view({ timeline, latestButton, api: async path => path.endsWith('/queue') ? { items: [] } : { items: [msg('m1', { message: '一行目の文章\n二行目' })], has_more: false }, messageImages: { load() {}, get() {}, failed() {} }, getBot() {}, isStopping: () => false, onStop() {}, onQueueChange() {}, onReply: reply => picked.push(reply) })
  await v.open({ type: 'bot', id: 'a', name: 'A' }); await settle()
  const button = body.children.find(node => node.className === 'reply-selection')
  assert.equal(button.hidden, true)
  const holder = { className: 'message-text', closest: sel => sel === '.message-text' ? holder : sel === '[data-id]' ? { dataset: { id: 'm1' } } : null }
  const node = { nodeType: 3, parentElement: holder }
  const selecting = text => ({ isCollapsed: false, toString: () => text, getRangeAt: () => ({ startContainer: node, endContainer: node, getBoundingClientRect: () => ({ left: 40, bottom: 100 }) }), removeAllRanges() { removed++ } })
  selection = selecting(' 一行目の文章\n二行目 '); handlers.selectionchange()
  assert.equal(button.hidden, false); assert.equal(button.style.top, '106px')
  assert.equal(button.listeners.mousedown({ preventDefault() { this.stopped = true } }) ?? true, true)
  button.listeners.click()
  assert.deepEqual(picked, [{ id: 'm1', sender: 'A', text: '一行目の文章 二行目', quote: { text: '一行目の文章\n二行目' } }]); assert.equal(button.hidden, true); assert.equal(removed, 1)
  const other = { className: 'message-text', closest: () => null }
  selection = { ...selecting('x'), getRangeAt: () => ({ startContainer: node, endContainer: { nodeType: 3, parentElement: other }, getBoundingClientRect: () => ({ left: 0, bottom: 0 }) }) }
  handlers.selectionchange(); assert.equal(button.hidden, true, 'a selection across bubbles is not offered')
  selection = selecting('   '); handlers.selectionchange(); assert.equal(button.hidden, true, 'whitespace only')
  selection = null; handlers.selectionchange(); assert.equal(button.hidden, true)
})

test('reply part (touch): the browser may clear the selection when the button is pressed; the button stays for the press and still sends the picked text', async t => {
  const body = new Element(), handlers = {}, picked = []
  globalThis.document = { createElement: () => new Element(), querySelectorAll: () => [], body, addEventListener: (name, fn) => { handlers[name] = fn } }
  globalThis.ResizeObserver = class { observe() {} }; globalThis.CSS = { escape: value => value }
  let selection = null
  globalThis.getSelection = () => selection ?? { isCollapsed: true, removeAllRanges() {} }
  t.after(() => { Object.assign(globalThis, saved); delete globalThis.getSelection })
  const timeline = new Element()
  const view = createConversationTimeline({ timeline, latestButton: new Element(), api: async path => path.endsWith('/queue') ? { items: [] } : { items: [msg('m1', { message: '選ぶ文章' })], has_more: false }, messageImages: { load() {}, get() {}, failed() {} }, getBot() {}, isStopping: () => false, onStop() {}, onQueueChange() {}, onReply: reply => picked.push(reply) })
  await view.open({ type: 'bot', id: 'a', name: 'A' }); await settle()
  const button = body.children.find(node => node.className === 'reply-selection')
  const holder = { className: 'message-text', closest: sel => sel === '.message-text' ? holder : sel === '[data-id]' ? { dataset: { id: 'm1' } } : null }
  const node = { nodeType: 3, parentElement: holder }
  selection = { isCollapsed: false, toString: () => '選ぶ文章', getRangeAt: () => ({ startContainer: node, endContainer: node, getBoundingClientRect: () => ({ left: 10, bottom: 50 }) }), removeAllRanges() {} }
  handlers.selectionchange(); assert.equal(button.hidden, false)
  button.listeners.pointerdown()
  selection = null; handlers.selectionchange() // the touch collapsed the selection
  assert.equal(button.hidden, false, 'kept while it is pressed')
  button.listeners.click()
  assert.deepEqual(picked, [{ id: 'm1', sender: 'A', text: '選ぶ文章', quote: { text: '選ぶ文章' } }])
  timeline.listeners.scroll?.()
})

// ---- forward / share (a282) ----
test('splitOrigin splits comment and content at content_start in code points; no origin or no comment are handled', () => {
  assert.deepEqual(splitOrigin('これお願い\n\n元の発言', 5), { comment: 'これお願い', content: '\n\n元の発言' })
  assert.deepEqual(splitOrigin('😀🙂コメント\n\n内容', 6), { comment: '😀🙂コメント', content: '\n\n内容' }, 'astral characters count once')
  assert.deepEqual(splitOrigin('内容だけ', 0), { comment: '', content: '内容だけ' })
  assert.deepEqual(splitOrigin('ふつうの発言', undefined), { comment: 'ふつうの発言', content: '' })
})

test('forward / share rows: mark, the comment as the Owner\'s words, the content as a quoted block; rows without origin are unchanged', async t => {
  const f = fixture(t, () => ({ has_more: false, items: [
    msg('plain', { message: 'ふつう' }),
    msg('fw', { direction: 'outgoing', message: 'これお願い\n\n元の発言の文章', origin: { kind: 'forward', from: { id: 'bot-a', name: 'N102' }, at: '2026-11-16T12:20:00Z', content_start: 5 } }),
    msg('sh', { direction: 'outgoing', message: '共有された文章\nhttps://example.com/a', origin: { kind: 'share', app: 'LINE', urls: ['https://example.com/a'], content_start: 0 } }),
  ] }))
  await f.open('a'); await settle()
  const marks = everyNode(f.timeline).filter(node => String(node.className).startsWith('origin-mark'))
  assert.equal(marks.length, 2); assert.match(marks[0].textContent, /^転送 · N102 · /u); assert.equal(marks[1].textContent, '共有 · LINE')
  const blocks = everyNode(f.timeline).filter(node => String(node.className).startsWith('origin-content'))
  assert.deepEqual(blocks.map(node => node.className), ['origin-content is-forward', 'origin-content is-share'])
  assert.equal(blocks[0].innerHTML.includes('元の発言の文章'), true); assert.equal(blocks[0].innerHTML.includes('これお願い'), false, 'the comment is not inside the quoted block')
  const texts = everyNode(f.timeline).filter(node => node.className === 'message-text').map(node => node.innerHTML)
  assert.equal(texts.some(html => html.includes('これお願い')), true); assert.equal(texts.length, 2, 'plain + forward comment; the share has no comment')
})

test('forward: 転送 hands the source (conversation + item id) and a preview to the app; a room record passes origin through', async t => {
  const asked = []
  const f = fixture(t, () => ({ has_more: false, items: [msg('m1', { message: '一行目\n二行目' })] }), { onForward: request => asked.push(request) })
  await f.open('a'); await settle()
  const buttons = everyNode(f.timeline).filter(node => node.className === 'message-reply message-forward')
  assert.equal(buttons.length, 1); buttons[0].listeners.click()
  assert.deepEqual(asked, [{ source: { kind: 'bot', id: 'a' }, messageId: 'm1', preview: { sender: 'A', text: '一行目' } }])
  const room = fixture(t, () => ({ has_more: false, items: [{ id: 'rm1', at: '2026-11-16T00:00:00Z', message: '内容', sender: { id: 'user', name: 'オーナー' }, room: { members: [] }, origin: { kind: 'share', content_start: 0 } }] }), { onForward: request => asked.push(request) })
  await room.open('room1', 'room'); await settle()
  assert.equal(everyNode(room.timeline).filter(node => String(node.className).startsWith('origin-mark')).length, 1)
  everyNode(room.timeline).find(node => node.className === 'message-reply message-forward').listeners.click()
  assert.deepEqual(asked.at(-1).source, { kind: 'room', id: 'room1' })
})

test('first screen: older pages are read one after another until the drawn height above the view passes one screen; a page that draws little does not end it; enough drawn stops it', async t => {
  const pages = { m4: { items: [{ id: 'm3', message: 'x', direction: 'incoming' }], has_more: true }, m3: { items: [{ id: 'm2', message: 'x', direction: 'incoming' }], has_more: true },
    m2: { items: [{ id: 'm1', message: 'x', direction: 'incoming' }], has_more: true }, m1: { items: [{ id: 'm0', message: 'x', direction: 'incoming' }], has_more: false } }
  const f = fixture(t, path => path.includes('before=') ? pages[path.split('before=')[1]] : { items: [{ id: 'm4', message: 'x', direction: 'incoming' }], has_more: true })
  await f.open('a'); await settle()
  assert.deepEqual(f.ids(), ['m0', 'm1', 'm2', 'm3', 'm4']) // one-row pages draw little each: it keeps chaining until has_more ends
  assert.equal(f.requests.filter(path => path.includes('before=')).length, 4)
  const rows = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, message: 'x', direction: 'incoming' }))
  const full = fixture(t, () => ({ items: rows, has_more: true }))
  full.timeline.clientHeight = 100 // the fake rows draw more than one screen above the view (a471-open-newest-web: one screen, not three)
  await full.open('a'); await settle()
  assert.equal(full.requests.filter(path => path.includes('before=')).length, 0, 'enough is drawn: nothing more is read until the view nears the top')
  full.timeline.scrollTop = -(full.timeline.scrollHeight - 100); full.timeline.listeners.scroll(); await settle() // scrolled up to the top (scrollTop is 0 at the bottom, negative going up)
  assert.equal(full.requests.filter(path => path.includes('before=')).length, 1, 'scrolling up to the top reads the next older page')
  assert.match(full.requests.find(path => path.includes('before=')), /limit=1000&before=r0$/)
})

test('a471-fill-after-refresh-web: a refresh that fills the empty map after the open was overtaken still reads the older pages', async t => {
  const first = deferred()
  let firsts = 0
  const f = fixture(t, path => {
    if (path.includes('before=')) return { items: [{ id: 'm0', message: 'x', direction: 'incoming' }], has_more: false }
    return firsts++ === 0 ? first.promise : { items: [{ id: 'm1', message: 'x', direction: 'incoming' }], has_more: true }
  })
  const opening = f.open('a') // its newest page is still on its way
  await settle(); const refreshing = f.view.refresh(); await settle() // the refresh answers first and fills the map
  await refreshing; await settle()
  first.resolve({ items: [{ id: 'm1', message: 'x', direction: 'incoming' }], has_more: true }); await opening; await settle()
  assert.deepEqual(f.ids(), ['m0', 'm1'])
  assert.equal(f.requests.filter(path => path.includes('before=')).length, 1, 'the open was overtaken: the refresh starts the fill')
})

test('a471-scroll-jump-web: while reading above the newest, a row growing below the viewed row moves the scroll so the viewed row stays; at the newest nothing is held; a click on a fold line holds nothing', async t => {
  globalThis.requestAnimationFrame = () => {} // the re-note after a click is not needed here
  t.after(() => { delete globalThis.requestAnimationFrame })
  const f = fixture(t, () => ({ items: [{ id: 'm1', message: 'x', direction: 'incoming' }], has_more: false }))
  await f.open('a'); await settle()
  f.timeline.clientHeight = 100; f.timeline.scrollTop = -400 // reading older rows
  let rowTop = 50
  const items = f.timeline.children[2], row = items.children.find(child => child.dataset.id)
  row.isConnected = true; row.getBoundingClientRect = () => ({ top: rowTop, bottom: rowTop + 100, height: 100 })
  f.timeline.getBoundingClientRect = () => ({ top: 0 })
  items.querySelectorAll = selector => selector === '[data-id]' ? [row] : []
  f.timeline.listeners.scroll() // the view looks at the row, 50 px below its top edge
  rowTop = 20 // rows below it grew by 30 px: the row moved up
  f.resizers.at(-1)(); assert.equal(f.timeline.scrollTop, -430, 'the scroll position follows, so the row stays where it was in the view')
  rowTop = 50; f.timeline.scrollTop = -400; f.timeline.listeners.scroll()
  items.listeners.click(); rowTop = 20 // the Owner opened a fold line: its content is for him to see
  f.resizers.at(-1)(); assert.equal(f.timeline.scrollTop, -400, 'after a click nothing is held back')
  f.timeline.scrollTop = 0; f.timeline.listeners.scroll(); rowTop = 50; f.timeline.listeners.scroll(); rowTop = 20
  f.resizers.at(-1)(); assert.equal(f.timeline.scrollTop, 0, 'at the newest the bottom is the anchor: nothing is held')
})

test('a471-open-newest-web: the list is laid out from the bottom (tail, pending, items); opening, new rows and an older page need no scroll command', async t => {
  let page = 0
  const f = fixture(t, path => {
    if (path.includes('before=')) return { items: [{ id: 'm0', message: 'older', direction: 'incoming' }], has_more: false }
    if (path.includes('after=')) return { items: [{ id: 'm2', message: 'new', direction: 'incoming' }], has_more: false }
    return { items: [{ id: 'm1', message: 'x', direction: 'incoming' }], has_more: true, page: page++ }
  })
  f.timeline.clientHeight = 100
  await f.open('a'); await settle()
  assert.deepEqual(f.timeline.children.map(node => node.className), ['timeline-tail', 'timeline-pending', 'timeline-items'], 'DOM order is bottom-up')
  assert.equal(f.timeline.scrollTop, 0, 'the first frame is the newest row')
  assert.equal(f.timeline.lastBehavior, undefined, 'opening issues no scroll command, no catch-up')
  await f.view.refresh(); await settle()
  assert.deepEqual(f.ids().slice(-1), ['m2'], 'a new row is appended, the list is not rebuilt')
  assert.equal(f.timeline.lastBehavior, undefined, 'a new row at the newest issues no scroll command')
  assert.equal(f.timeline.scrollTop, 0)
  const top = -(f.timeline.scrollHeight - 100)
  f.timeline.scrollTop = top // the Owner scrolled up to the top
  f.timeline.listeners.scroll(); await settle()
  assert.deepEqual(f.ids(), ['m0', 'm1', 'm2'])
  assert.equal(f.timeline.scrollTop, top, 'an older page goes above the view: the place is kept without any compensation')
  assert.equal(f.timeline.lastBehavior, undefined)
})

test('a471-open-newest-web: 最新へ is the only scroll command and goes to scrollTop 0', async t => {
  const f = fixture(t, () => ({ items: [{ id: 'm1', message: 'x', direction: 'incoming' }], has_more: false }))
  f.timeline.clientHeight = 100
  await f.open('a'); await settle()
  f.timeline.scrollTop = -500; f.timeline.listeners.scroll()
  assert.equal(f.latestButton.hidden, false, 'away from the newest the button shows')
  f.latestButton.listeners.click()
  assert.equal(f.timeline.scrollTop, 0); assert.equal(f.timeline.lastBehavior, 'instant'); assert.equal(f.latestButton.hidden, true)
})

test('a471-open-newest-web: a sent bubble shows at once at the newest position; the answered send is replaced by the real row in the same refresh; a failed send takes it back', async t => {
  const rows = []
  const f = fixture(t, path => path.includes('after=') ? { items: rows.splice(0), has_more: false } : { items: [{ id: 'm1', message: 'x', direction: 'incoming' }], has_more: false })
  await f.open('a'); await settle()
  const pending = f.view.addPending({ type: 'bot', id: 'a' }, '送ったよ')
  assert.equal(f.timeline.children[1].children.length, 1, 'the bubble is there before any request answered')
  assert.equal(everyNode(f.timeline.children[1]).some(node => String(node.innerHTML ?? node.textContent ?? '').includes('送ったよ')), true)
  assert.equal(f.view.addPending({ type: 'bot', id: 'other' }, 'x'), null, 'another conversation takes none')
  await f.view.refresh(); await settle()
  assert.equal(f.timeline.children[1].children.length, 1, 'a read while the POST is unanswered keeps it (its real row may not exist yet)')
  pending.accept(); rows.push({ id: 'm2', message: '送ったよ', direction: 'outgoing' })
  await f.view.refresh(); await settle()
  assert.equal(f.timeline.children[1].children.length, 0, 'the real row replaced it')
  assert.deepEqual(f.ids().slice(-1), ['m2'])
  const failed = f.view.addPending({ type: 'bot', id: 'a' }, '届かない'); failed.remove()
  assert.equal(f.timeline.children[1].children.length, 0, 'a failed send takes the bubble back')
  f.view.addPending({ type: 'bot', id: 'a' }, '開き直すと消える'); await f.open('a'); await settle()
  assert.equal(f.timeline.children[1].children.length, 0, 'a new conversation starts clean')
})

test('a471-scrollback-web: the first page asks 1000, an older page 1000 with before_at (the at of the oldest loaded row); no at, no before_at', async t => {
  const f = fixture(t, path => path.includes('before=') ? { items: [], has_more: false } : { items: [{ id: 'm4', at: '2026-11-21T01:02:03Z', message: 'x', direction: 'incoming' }], has_more: true })
  await f.open('a'); await settle()
  assert.deepEqual(f.requests.filter(path => path.includes('messages')), ['/api/bots/a/messages?limit=1000', '/api/bots/a/messages?limit=1000&before=m4&before_at=2026-11-21T01%3A02%3A03Z'])
})

test('first screen: a failed older page stops the fill and shows the retry; a hidden timeline reads nothing more', async t => {
  const f = fixture(t, path => { if (path.includes('before=')) throw Error('down'); return { items: [{ id: 'm4', message: 'x', direction: 'incoming' }], has_more: true } })
  f.timeline.clientHeight = 5000
  await f.open('a')
  assert.equal(f.requests.filter(path => path.includes('before=')).length, 1)
  assert.match(f.text(), /もう一度読み込む/)
  const hidden = fixture(t, () => ({ items: [{ id: 'm4', message: 'x', direction: 'incoming' }], has_more: true }))
  hidden.timeline.clientHeight = 0
  await hidden.open('a')
  assert.equal(hidden.requests.filter(path => path.includes('before=')).length, 0)
})

test('turn answer: a words row with bubble:true is an ordinary incoming bubble with Markdown; other words rows stay plain text', async t => {
  const row = (id, event) => ({ id, kind: 'machine_event', at: '2026-11-21T06:35:00Z', sender: { id: 'a', name: 'テスト席' }, message: event.text, machine_event: { view: 'words', display: 'show', ...event } })
  const f = fixture(t, () => ({ items: [row('me-1', { text: '途中の発言' }), row('me-2', { text: '**答え**です', bubble: true })], has_more: false }))
  await f.open('a')
  const rows = f.timeline.children[2].children.filter(child => child.dataset.id)
  assert.equal(rows[0].className, 'machine-show view-words')
  assert.equal(rows[1].className, 'message incoming')
  const text = rows[1].querySelectorAll('.message-text')[0]
  assert.match(text.innerHTML, /<strong>答え<\/strong>/)
  assert.match(f.text(), /テスト席/)
})

test('a471-reply-forward-web: a bubble row has reply / forward / copy by its own id and the whole text; plain words and an open turn do not', async t => {
  const row = (id, event) => ({ id, kind: 'machine_event', at: '2026-11-21T06:35:00Z', sender: { id: 'a', name: 'テスト席' }, message: event.text.split('\n')[0], machine_event: { view: 'words', display: 'show', ...event } })
  const asked = [], replied = [], copied = []
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async text => { copied.push(text) } } }, configurable: true })
  t.after(() => { delete globalThis.navigator })
  const f = fixture(t, () => ({ items: [row('me-1-0', { text: '途中の発言' }), row('me-2-0', { text: '一行目\n二行目', bubble: true })], has_more: false }), { onForward: request => asked.push(request), onReply: reply => replied.push(reply) })
  await f.open('a'); await settle()
  const forwards = everyNode(f.timeline).filter(node => node.className === 'message-reply message-forward')
  assert.equal(forwards.length, 1, 'only the bubble row has actions')
  forwards[0].listeners.click()
  assert.deepEqual(asked, [{ source: { kind: 'bot', id: 'a' }, messageId: 'me-2-0', preview: { sender: 'テスト席', text: '一行目' } }])
  everyNode(f.timeline).find(node => node.className === 'message-reply').listeners.click()
  assert.deepEqual(replied, [{ id: 'me-2-0', sender: 'テスト席', text: '一行目' }])
  everyNode(f.timeline).find(node => node.className === 'message-reply message-copy').listeners.click(); await settle()
  assert.deepEqual(copied, ['一行目\n二行目'], 'the whole machine_event.text, not the first line')
})

test('a471-thinking-bubble-web: a shown thinking row is an incoming bubble with the whole text and copy only; an empty folded one and plain words are not', async t => {
  const row = (id, event) => ({ id, kind: 'machine_event', at: '2026-11-21T06:35:00Z', sender: { id: 'a', name: 'テスト席' }, message: event.text.split('\n')[0], machine_event: { display: 'show', ...event } })
  const whole = '一行目の考え\n二行目の考え'
  const copied = []
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async text => { copied.push(text) } } }, configurable: true })
  t.after(() => { delete globalThis.navigator })
  const f = fixture(t, () => ({ items: [row('me-1-0', { view: 'thinking', title: 'thinking', text: whole }), row('me-2-0', { view: 'thinking', title: 'thinking (no text)', text: '', display: 'fold' }), row('me-3-0', { view: 'words', text: '途中の発言' })], has_more: false }))
  await f.open('a'); await settle()
  const rows = f.timeline.children[2].children.filter(child => child.dataset.id)
  assert.equal(rows[0].className, 'message incoming', 'drawn in the answer bubble container')
  const nodes = everyNode(rows[0])
  assert.ok(nodes.some(node => String(node.className).includes('is-thinking')), 'lighter and slanted')
  assert.equal(nodes.filter(node => node.className === 'message-reply').length, 0, 'no reply')
  assert.equal(nodes.filter(node => node.className === 'message-reply message-forward').length, 0, 'no forward')
  nodes.find(node => node.className === 'message-reply message-copy').listeners.click(); await settle()
  assert.deepEqual(copied, [whole], 'copy is the whole text')
  assert.notEqual(rows[1].className, 'message incoming', 'an empty thinking stays a folded line')
  assert.equal(rows[2].className, 'machine-show view-words', 'plain words keep their drawing')
})

test('a471-spinner-words: running rows draw the server word in the queue line and the thinking bubble; no word keeps today\'s indicator', async t => {
  const f = fixture(t)
  await f.open('a')
  f.queues[0].resolve({ items: [{ botId: 'a', botName: 'A', groupId: 'q', status: 'running', workingWord: 'Mulling' }, { botId: 'b', botName: 'B', groupId: 'r', status: 'queued' }] }); await settle()
  assert.match(f.text(), /Aが作業中・Mulling/)
  assert.doesNotMatch(f.text(), /Bが作業中/)
  const words = node => [...(node.className === 'queue-working' && node.textContent === 'Mulling' ? [node] : []), ...node.children.flatMap(words)]
  assert.equal(words(f.timeline).length, 1) // the queue line has the word inside its text; the thinking bubble has its own span
  await f.view.refresh(); f.queues[1].resolve({ items: [{ botId: 'a', botName: 'A', groupId: 'q', status: 'running' }] }); await settle()
  assert.match(f.text(), /Aが作業中/); assert.doesNotMatch(f.text(), /・/)
  const bubbles = node => [...(node.innerHTML === '<i></i><i></i><i></i>' ? [node] : []), ...node.children.flatMap(bubbles)]
  assert.equal(bubbles(f.timeline).length, 1)
})
