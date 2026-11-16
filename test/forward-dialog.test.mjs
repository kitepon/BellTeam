import assert from 'node:assert/strict'
import test from 'node:test'
import { createForwardDialog, destinationsOf, forwardError, forwardPayload } from '../web/forward-dialog.js'

const settle = () => new Promise(resolve => setImmediate(resolve))
class Text { constructor(text) { this.nodeType = 3; this.textContent = text } }
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = new Map(); this.listeners = {}; this.className = ''; this.value = ''; this.open = false; this.style = {}; this.dataset = {}; this.classList = { toggle() {}, add() {}, remove() {} } }
  get textContent() { return this.children.map(child => child.textContent).join('') }
  set textContent(value) { this.children = [new Text(String(value))] }
  setAttribute(name, value) { this.attrs.set(name, String(value)) }
  getAttribute(name) { return this.attrs.get(name) ?? null }
  append(...nodes) { this.children.push(...nodes.map(node => typeof node === 'string' ? new Text(node) : node)) }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes) }
  addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn) }
  querySelector(selector) { return all(this).find(node => selector === 'input[type="search"]' && node.attrs?.get('type') === 'search') ?? null }
  click() { for (const fn of this.listeners.click ?? []) fn({ target: this }) }
  showModal() { this.open = true }
  close() { this.open = false; for (const fn of this.listeners.close ?? []) fn() }
}
const all = node => node.children.flatMap(child => child.nodeType === 3 ? [] : [child, ...all(child)])
const text = node => node.textContent
const byText = (root, label) => all(root).find(node => node.tag === 'button' && text(node).includes(label))
const saved = globalThis.document

const bots = [{ id: 'bot-a', name: 'アドミ', displayName: 'アドミ', color: 'violet' }, { id: 'bot-b', name: 'ベル', displayName: 'ベル', color: 'rose' }, { id: 'bot-gone', name: '削除中', deleting: true }]
const rooms = [{ id: 'room-1', name: '開発', memberIds: ['bot-a', 'bot-b'] }]
const source = { kind: 'bot', id: 'bot-a' }, preview = { sender: 'アドミ', text: '元の発言の一行目' }

test('forwardPayload sends identifiers and the comment only, never the text of the original', () => {
  assert.deepEqual(forwardPayload({ source, messageId: 'm1', comment: 'これお願い' }), { message: 'これお願い', images: [], forward: { source: { kind: 'bot', id: 'bot-a' }, message_id: 'm1' } })
  assert.deepEqual(forwardPayload({ source: { kind: 'room', id: 'r' }, messageId: 'm2', targets: ['bot-a'] }).targets, ['bot-a'])
  assert.equal('targets' in forwardPayload({ source, messageId: 'm1', targets: [] }), false)
  assert.equal(JSON.stringify(forwardPayload({ source, messageId: 'm1', comment: '' })).includes('元の発言'), false)
})

test('forwardError speaks plainly for 404, 415, 400 and anything else', () => {
  assert.match(forwardError({ status: 404 }), /転送する発言が見つかりません/u); assert.match(forwardError({ status: 415 }), /画像やファイルを含む発言は、まだ転送できません/u)
  assert.match(forwardError({ status: 400 }), /転送できませんでした/u); assert.match(forwardError({ status: 503, message: 'HTTP_503' }), /もう一度お試しください（HTTP_503）/u)
  assert.doesNotMatch(forwardError({ status: 404, message: 'FORWARD_SOURCE_NOT_FOUND' }), /FORWARD_SOURCE/u, 'no server code on screen')
})

test('destinationsOf lists Bots then rooms, leaves out Bots being deleted, filters by name', () => {
  assert.deepEqual(destinationsOf(bots, rooms).map(entry => [entry.type, entry.id]), [['bot', 'bot-a'], ['bot', 'bot-b'], ['room', 'room-1']])
  assert.deepEqual(destinationsOf(bots, rooms, ' ベ ').map(entry => entry.id), ['bot-b']); assert.deepEqual(destinationsOf(bots, rooms, '無い'), [])
})

function harness(t, { api, routing = true } = {}) {
  globalThis.document = { createElement: tag => new El(tag) }
  t.after(() => { globalThis.document = saved })
  const dialog = new El('dialog'), calls = [], opened = []
  const forward = createForwardDialog({ dialog, api: api ?? (async (path, options) => { calls.push({ path, body: JSON.parse(options.body) }); return { id: 'accepted' } }),
    getBots: () => bots, getRooms: () => rooms, routingEnabled: () => routing, openConversation: dest => opened.push(dest) })
  return { forward, dialog, calls, opened }
}

test('dialog: pick a Bot, add a comment, send -> POST with forward, then 転送しました and the open button', async t => {
  const h = harness(t)
  h.forward.open({ source, messageId: 'm1', preview })
  assert.equal(h.dialog.open, true); assert.match(text(h.dialog), /元の発言の一行目/u)
  const send = byText(h.dialog, '転送する'); assert.equal(send.attrs.has('disabled'), true, 'no destination yet')
  byText(h.dialog, 'ベル').click()
  const area = all(h.dialog).find(node => node.tag === 'textarea'); area.listeners.input[0]({ target: { value: ' これお願い ' } })
  byText(h.dialog, '転送する').click(); await settle()
  assert.deepEqual(h.calls, [{ path: '/api/bots/bot-b/messages', body: { message: 'これお願い', images: [], forward: { source: { kind: 'bot', id: 'bot-a' }, message_id: 'm1' } } }])
  assert.match(text(h.dialog), /転送しました（ベル）。/u)
  byText(h.dialog, 'ベルの会話を開く').click()
  assert.deepEqual(h.opened, [{ type: 'bot', id: 'bot-b', name: 'ベル' }]); assert.equal(h.dialog.open, false)
})

test('dialog: a room without auto responders must have members picked; with auto responders it does not', async t => {
  const manual = harness(t, { routing: false })
  manual.forward.open({ source, messageId: 'm1', preview })
  byText(manual.dialog, '開発').click()
  assert.match(text(manual.dialog), /返信者の自動選択がありません/u); assert.equal(byText(manual.dialog, '転送する').attrs.has('disabled'), true)
  const members = all(manual.dialog).filter(node => node.attrs?.get('aria-label') === '返信してほしいメンバー')[0]
  byText(members, 'アドミ').click(); assert.equal(byText(manual.dialog, '転送する').attrs.has('disabled'), false)
  byText(manual.dialog, '転送する').click(); await settle()
  assert.deepEqual([manual.calls[0].path, manual.calls[0].body.targets], ['/api/rooms/room-1/messages', ['bot-a']])
  const auto = harness(t, { routing: true })
  auto.forward.open({ source, messageId: 'm1', preview }); byText(auto.dialog, '開発').click()
  assert.doesNotMatch(text(auto.dialog), /自動選択がありません/u); assert.equal(byText(auto.dialog, '転送する').attrs.has('disabled'), false)
  byText(auto.dialog, '転送する').click(); await settle(); assert.equal('targets' in auto.calls[0].body, false)
})

test('dialog: a refusal keeps the dialog and the comment, shows plain words, and sending again works', async t => {
  let first = true
  const h = harness(t, { api: async (path, options) => { h.calls.push(JSON.parse(options.body)); if (first) { first = false; throw Object.assign(new Error('x'), { status: 415 }) } return {} } })
  h.forward.open({ source, messageId: 'm1', preview }); byText(h.dialog, 'アドミ').click()
  byText(h.dialog, '転送する').click(); await settle()
  assert.match(text(h.dialog), /画像やファイルを含む発言は、まだ転送できません/u); assert.equal(h.dialog.open, true)
  byText(h.dialog, '転送する').click(); await settle()
  assert.equal(h.calls.length, 2); assert.match(text(h.dialog), /転送しました（アドミ）/u)
})
