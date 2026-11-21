import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversationComposer, installShareDrop, shareFromTransfer } from '../web/conversation-composer.js'

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
class Element {
  value = ''; hidden = false; disabled = false; clientWidth = 0; children = []; listeners = {}; style = {}
  addEventListener(name, listener) { this.listeners[name] = listener }
  setAttribute() {}
  replaceChildren(...children) { this.children = children }
  append(...children) { this.children.push(...children) }
}
const previous = { document: globalThis.document, ResizeObserver: globalThis.ResizeObserver, create: URL.createObjectURL, revoke: URL.revokeObjectURL }
function fixture(t, options = {}) {
  globalThis.document = { createElement: () => new Element(), fonts: { ready: Promise.resolve() } }
  globalThis.ResizeObserver = class { observe() {} }
  let serial = 0
  const revoked = []
  URL.createObjectURL = () => `blob:${++serial}`
  URL.revokeObjectURL = url => revoked.push(url)
  t.after(() => { globalThis.document = previous.document; globalThis.ResizeObserver = previous.ResizeObserver; URL.createObjectURL = previous.create; URL.revokeObjectURL = previous.revoke })
  const input = new Element(), attachments = new Element(), error = new Element(), sendButton = new Element(), recovery = new Element()
  const calls = [], accepted = [], targets = new Map()
  const a = { type: 'bot', id: 'a', name: 'A' }, b = { type: 'bot', id: 'b', name: 'B' }
  const available = [a, b]
  const composer = createConversationComposer({ input, attachments, error, sendButton, recovery,
    api: async (path, request) => { calls.push({ path, body: JSON.parse(request.body) }); return { id: 'accepted' } },
    readImage: async () => ({ mime: 'image/png', data: 'AA==' }),
    getTargets: target => targets.get(target.id) ?? null,
    setTargets: (target, value) => { if (value) targets.set(target.id, value) },
    findTarget: target => available.find(item => item.id === target.id),
    onSelect: target => composer.select(target),
    onAccepted: async (...args) => { accepted.push(args) }, ...options,
  })
  composer.select(a)
  return { composer, input, attachments, error, sendButton, recovery, calls, accepted, revoked, targets, a, b, available }
}
const image = { type: 'image/png' }

test('members admission refusal preserves room text, image and responders without automatic resend', async t => {
  const calls = []
  const f = fixture(t, { api: async (path, request) => {
    calls.push({ path, body: JSON.parse(request.body) })
    throw Object.assign(new Error('MEMBERS_NOT_ACCEPTED'), { status: 503 })
  } })
  const room = { type: 'room', id: 'room', name: 'Room' }
  f.available.push(room); f.targets.set(room.id, ['a'])
  f.composer.select(room); f.input.value = '保持する本文'; f.composer.addImages([image])
  await f.composer.send()
  assert.equal(f.input.value, '保持する本文')
  assert.equal(f.attachments.children.length, 1)
  assert.deepEqual(f.targets.get(room.id), ['a'])
  assert.match(f.error.textContent, /新しい操作を受け付けられません。入力は保持/)
  assert.doesNotMatch(f.error.textContent, /MEMBERS_NOT_ACCEPTED/)
  assert.deepEqual(f.revoked, [])
  f.composer.select(f.a); f.composer.select(room); f.composer.update()
  assert.equal(f.input.value, '保持する本文')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].body.targets, ['a'])
})

test('accepted POST followed by display failure keeps the new input and never restores sent text', async t => {
  const f = fixture(t, { onAccepted: async () => { throw new Error('GET failed') } })
  f.input.value = 'sent'
  await f.composer.send()
  assert.equal(f.calls.length, 1)
  assert.equal(f.input.value, '')
  assert.match(f.error.textContent, /受け付けました/)
  assert.equal(f.recovery.hidden, true)
})

test('failed A does not overwrite B and is restored to A when its draft is empty', async t => {
  const pending = deferred()
  const f = fixture(t, { api: () => pending.promise })
  f.input.value = 'old A'
  const sending = f.composer.send()
  f.composer.select(f.b)
  f.input.value = 'new B'
  pending.reject(new Error('network'))
  await sending
  assert.equal(f.input.value, 'new B')
  f.composer.select(f.a)
  assert.equal(f.input.value, 'old A')
  assert.match(f.error.textContent, /再送する前に会話を確認/)
  f.composer.select(f.b)
  assert.equal(f.input.value, 'new B')
})

test('old and new input/images survive together; recovery cannot overwrite and discard releases only its images', async t => {
  const pending = deferred()
  const f = fixture(t, { api: () => pending.promise })
  f.input.value = 'old'
  f.composer.addImages([image])
  const sending = f.composer.send()
  f.input.value = 'new'
  f.composer.addImages([image])
  pending.reject(new Error('network'))
  await sending
  assert.equal(f.input.value, 'new')
  assert.deepEqual(f.revoked, [])
  const row = f.recovery.children[1]
  assert.equal(row.children[1].value, 'old')
  row.children.at(-2).listeners.click()
  assert.equal(f.input.value, 'new')
  row.children.at(-1).listeners.click()
  assert.deepEqual(f.revoked, ['blob:1'])
  assert.equal(f.attachments.children[0].children[0].src, 'blob:2')
})

test('recovery returns to an empty original draft without posting and can still be read after target deletion', async t => {
  const pending = deferred()
  const f = fixture(t, { api: () => pending.promise })
  f.input.value = 'old'
  const sending = f.composer.send()
  f.input.value = 'new'
  pending.reject(new Error('failed'))
  await sending
  f.input.value = ''
  f.composer.update()
  f.recovery.children[1].children.at(-2).listeners.click()
  assert.equal(f.input.value, 'old')
  assert.equal(f.recovery.hidden, true)
  const second = deferred()
  const g = fixture(t, { api: () => second.promise })
  g.input.value = 'deleted target'
  const other = g.composer.send()
  g.available.splice(0, 1)
  second.reject(new Error('failed'))
  await other
  assert.equal(g.recovery.children[1].children[1].value, 'deleted target')
  assert.equal(g.recovery.children[1].children.at(-2).disabled, true)
})

test('room responders are captured before image encoding and same-target repeated send stays single flight', async t => {
  const encoding = deferred()
  const f = fixture(t, { readImage: () => encoding.promise })
  const room = { type: 'room', id: 'room', name: 'Room' }
  f.available.push(room)
  f.targets.set(room.id, ['first'])
  f.composer.select(room)
  f.input.value = 'room message'
  f.composer.addImages([image])
  const sending = f.composer.send()
  f.targets.set(room.id, ['later'])
  f.input.value = 'next'
  await f.composer.send()
  encoding.resolve({ mime: 'image/png', data: 'AA==' })
  await sending
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.calls[0].body.targets, ['first'])
  assert.equal(f.input.value, 'next')
  assert.deepEqual(f.revoked, ['blob:1'])
})

test('encoding failure never posts and explicit refusal preserves input and reason', async t => {
  const f = fixture(t, { readImage: async () => { throw new Error('IMAGE_INVALID') } })
  f.input.value = 'photo'
  f.composer.addImages([image])
  await f.composer.send()
  assert.equal(f.calls.length, 0)
  assert.equal(f.input.value, 'photo')
  assert.match(f.error.textContent, /IMAGE_INVALID/)
  assert.deepEqual(f.revoked, [])
  const g = fixture(t, { api: async () => { throw Object.assign(new Error('ROOM_REPRESENTATIVE_REQUIRED'), { status: 400 }) } })
  g.input.value = 'declined'
  await g.composer.send()
  assert.equal(g.input.value, 'declined')
  assert.match(g.error.textContent, /ROOM_REPRESENTATIVE_REQUIRED/)
})

test('deletion pending disables sends while keeping drafts; a forced submit cannot post', async t => {
 const f=fixture(t)
 f.input.value='未送信の入力';f.available[0].deletionRequested=true;f.composer.update()
 assert.equal(f.sendButton.disabled,true)
 await f.composer.send();assert.equal(f.calls.length,0);assert.equal(f.input.value,'未送信の入力')
 f.composer.select(f.b);f.composer.select(f.a);assert.equal(f.input.value,'未送信の入力')
 assert.match(f.error.textContent,/未確認/)
})

test('reply: the picked reply is sent as reply_to from that conversation only, is not input by itself, is kept when the send fails and is gone once accepted', async t => {
  const bar = new Element()
  let fail = true
  const f = fixture(t, { replyBar: bar, api: async (path, request) => {
    f.calls.push({ path, body: JSON.parse(request.body) })
    if (fail) { fail = false; throw Object.assign(new Error('x'), { status: 503 }) }
    return { id: 'accepted' }
  } })
  f.composer.setReply({ id: 'orig-1', sender: 'A', text: '元の発言' })
  assert.equal(bar.hidden, false); assert.equal(bar.children[0].textContent, 'Aへの返信'); assert.equal(bar.children[1].textContent, '元の発言')
  assert.equal(f.sendButton.disabled, true, 'a reply alone is not sendable')
  f.input.value = '返事'; f.composer.update()
  f.composer.select(f.b); assert.equal(bar.hidden, true, 'another conversation has no reply'); f.composer.select(f.a); assert.equal(bar.hidden, false, 'kept with its draft')
  f.input.value = '返事'
  await f.composer.send()
  assert.deepEqual(f.calls[0].body.reply_to, 'orig-1'); assert.equal(bar.hidden, false, 'a failed send keeps the reply')
  await f.composer.send()
  assert.equal(f.calls[1].body.reply_to, 'orig-1'); assert.equal(bar.hidden, true, 'accepted: the reply is gone')
  f.input.value = '次'; await f.composer.send()
  assert.equal('reply_to' in f.calls[2].body, false, 'no reply_to unless one was picked')
})

test('reply: × cancels the reply and the next send has no reply_to', async t => {
  const bar = new Element()
  const f = fixture(t, { replyBar: bar })
  f.composer.setReply({ id: 'orig-2', sender: 'A', text: 't' })
  bar.children[2].listeners.click()
  assert.equal(bar.hidden, true)
  f.input.value = 'x'; await f.composer.send()
  assert.equal('reply_to' in f.calls[0].body, false)
})

test('reply part: a quoted selection is sent as reply_quote next to reply_to and the bar says 一部への返信', async t => {
  const bar = new Element()
  const f = fixture(t, { replyBar: bar })
  f.composer.setReply({ id: 'orig-3', sender: 'A', text: '選んだ部分', quote: { text: '選んだ部分' } })
  assert.equal(bar.children[0].textContent, 'Aの一部への返信'); assert.equal(bar.children[1].textContent, '選んだ部分')
  f.input.value = '賛成です'; await f.composer.send()
  assert.deepEqual([f.calls[0].body.reply_to, f.calls[0].body.reply_quote], ['orig-3', { text: '選んだ部分' }])
  f.composer.setReply({ id: 'orig-4', sender: 'A', text: 't' }); f.input.value = '全体'; await f.composer.send()
  assert.equal(f.calls[1].body.reply_to, 'orig-4'); assert.equal('reply_quote' in f.calls[1].body, false, 'whole-message reply has no reply_quote')
})

test('shareFromTransfer: text, links and images from a drop; a lone URL is a url; a dragged link is not duplicated; other files are refused', () => {
  const transfer = (data, files = []) => ({ files, getData: type => data[type] ?? '' })
  const png = { type: 'image/png' }, pdf = { type: 'application/pdf' }
  assert.deepEqual(shareFromTransfer(transfer({ 'text/plain': ' 共有された文章 ' })), { text: '共有された文章', urls: [], images: [], refused: false })
  assert.deepEqual(shareFromTransfer(transfer({ 'text/plain': 'https://example.com/a' })), { text: '', urls: ['https://example.com/a'], images: [], refused: false })
  assert.deepEqual(shareFromTransfer(transfer({ 'text/uri-list': '# c\r\nhttps://example.com/a\r\nhttps://example.com/b\r\nftp://x/y', 'text/plain': 'https://example.com/a' })).urls, ['https://example.com/a', 'https://example.com/b'])
  assert.equal(shareFromTransfer(transfer({ 'text/uri-list': 'https://example.com/a', 'text/plain': 'https://example.com/a' })).text, '')
  const both = shareFromTransfer(transfer({}, [png, pdf])); assert.deepEqual([both.images, both.refused], [[png], true])
  assert.equal(shareFromTransfer(transfer({ 'text/plain': 'x'.repeat(30000) })).text.length, 20000)
  assert.equal(shareFromTransfer(transfer({ 'text/uri-list': Array.from({ length: 30 }, (_, i) => `https://e.com/${i}`).join('\n') })).urls.length, 20)
  assert.deepEqual(shareFromTransfer(undefined), { text: '', urls: [], images: [], refused: false })
})

test('share: shared content alone is sendable, goes as share (never with reply_to), replaces a reply, is kept on failure and cleared by ×', async t => {
  const bar = new Element()
  let fail = true
  const f = fixture(t, { replyBar: bar, api: async (path, request) => { f.calls.push({ path, body: JSON.parse(request.body) }); if (fail) { fail = false; throw Object.assign(new Error('x'), { status: 503 }) } return { id: 'ok' } } })
  f.composer.setReply({ id: 'orig', sender: 'A', text: 't' })
  f.composer.setShare({ text: '共有された文章', urls: ['https://example.com/a', 'https://example.com/b'] })
  assert.equal(bar.children[0].textContent, '共有する内容'); assert.equal(bar.children[1].textContent, '共有された文章 / https://example.com/a ほか1件')
  assert.equal(f.sendButton.disabled, false, 'content alone is enough; the comment is optional')
  await f.composer.send()
  assert.deepEqual(f.calls[0].body.share, { text: '共有された文章', urls: ['https://example.com/a', 'https://example.com/b'] }); assert.equal('reply_to' in f.calls[0].body, false); assert.equal(f.calls[0].body.message, '')
  assert.equal(bar.hidden, false, 'kept after a failed send')
  await f.composer.send()
  assert.equal(f.calls.length, 2); assert.equal(bar.hidden, true, 'accepted: gone')
  f.composer.setShare({ text: 'もう一度' }); bar.children[2].listeners.click()
  assert.equal(bar.hidden, true); assert.equal(f.sendButton.disabled, true, '× removes the content; nothing left to send')
  f.input.value = '普通'; await f.composer.send(); assert.equal('share' in f.calls[2].body, false)
})

test('installShareDrop: a drop on the open conversation becomes a share (text, urls, images); closed conversation and unrelated drags are left alone; other files are refused in words', () => {
  const handlers = {}, classes = new Set(), calls = []
  const panel = { addEventListener: (name, fn) => { handlers[name] = fn }, contains: node => node === 'inside', classList: { add: n => classes.add(n), remove: n => classes.delete(n) } }
  let open = true
  const composer = { setShare: share => calls.push(['share', share]), addImages: files => calls.push(['images', files.length]), showError: message => calls.push(['error', message]) }
  installShareDrop(panel, { enabled: () => open, composer })
  const png = { type: 'image/png' }, pdf = { type: 'application/pdf' }
  const drag = (types, data = {}, files = []) => ({ dataTransfer: { types, files, getData: type => data[type] ?? '' }, prevented: false, preventDefault() { this.prevented = true } })
  const over = drag(['text/plain']); handlers.dragover(over); assert.equal(over.prevented, true); assert.equal(classes.has('is-dropping'), true)
  handlers.dragleave({ relatedTarget: 'inside' }); assert.equal(classes.has('is-dropping'), true, 'moving inside the panel keeps the overlay'); handlers.dragleave({ relatedTarget: null }); assert.equal(classes.has('is-dropping'), false)
  handlers.drop(drag(['text/plain', 'Files'], { 'text/plain': '共有', 'text/uri-list': 'https://example.com/a' }, [png, pdf]))
  assert.deepEqual(calls, [['error', '画像以外のファイルは、まだ送れません。画像・文章・URLは共有できます。'], ['share', { text: '共有', urls: ['https://example.com/a'] }], ['images', 1]])
  calls.length = 0
  handlers.drop(drag(['Files'], {}, [png])); assert.deepEqual(calls, [['share', {}], ['images', 1]], 'images only: a share with no text')
  calls.length = 0; const unrelated = drag(['application/x-other']); handlers.drop(unrelated); assert.equal(unrelated.prevented, false); assert.deepEqual(calls, [])
  open = false; const closed = drag(['text/plain'], { 'text/plain': 'x' }); handlers.dragover(closed); handlers.drop(closed); assert.equal(closed.prevented, false); assert.deepEqual(calls, [])
})

test('a471-open-newest-web: the Owner\'s bubble is asked for the moment the send starts; the answer marks it accepted before the refresh; a failed send takes it back', async t => {
  const events = []
  const handle = { accept: () => events.push('accept'), remove: () => events.push('remove') }
  const f = fixture(t, { onSending: (target, message, count) => { events.push(['sending', target.id, message, count]); return handle }, onAccepted: async () => { events.push('refresh') } })
  f.input.value = 'こんにちは'
  await f.composer.send()
  assert.deepEqual(events, [['sending', 'a', 'こんにちは', 0], 'accept', 'refresh'], 'shown first, accepted by the answer, then the incremental read')
  events.length = 0
  const failing = fixture(t, { api: async () => { throw Object.assign(new Error('down'), { status: 503 }) }, onSending: () => handle })
  failing.input.value = '届かない'
  await failing.composer.send()
  assert.deepEqual(events, ['remove'], 'a refused send takes the bubble back and keeps the draft')
  assert.equal(failing.input.value, '届かない')
})
