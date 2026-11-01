import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversationComposer } from '../web/conversation-composer.js'

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
