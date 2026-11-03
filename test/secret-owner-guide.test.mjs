import assert from 'node:assert/strict'
import test from 'node:test'
import { renderSecretRequest } from '../web/secret-input.js'
import { Element } from './helpers/editor-dom.mjs'

class SecretElement extends Element {
  dataset = {}; attributes = {}
  constructor(tag) { super(); this.tag = tag }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child) } }
  setAttribute(name, value) { this.attributes[name] = value }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...((selector.startsWith('.') ? child.className === selector.slice(1) : child.tag === selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ])
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
  replaceWith(node) { const i = this.parent.children.indexOf(this); this.parent.children.splice(i, 1, node); node.parent = this.parent }
  remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1) }
}
const origins = ['https://claude.ai', 'https://console.anthropic.com', 'https://platform.claude.com']
const pending = { id: 'request-a', botId: 'bot-a', toolId: 'olrw-auth', label: '認証コード', message: '公式ページで認証してください。', status: 'pending' }
const turn = () => new Promise(resolve => setImmediate(resolve))
const text = node => [node.textContent ?? '', ...node.children.map(text)].join(' ')
function fixture(t, api = async () => { throw Error('UNEXPECTED_API') }) {
  const body = new SecretElement('body'), events = new Map(), completed = []
  const previous = Object.fromEntries(['document', 'location', 'fetch', 'localStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  let network = 0, writes = 0
  Object.assign(globalThis, {
    document: { body, hidden: false, createElement: tag => new SecretElement(tag), querySelectorAll: selector => body.querySelectorAll(selector),
      addEventListener: (name, handler) => events.set(name, handler), removeEventListener: name => events.delete(name) },
    location: { href: 'https://bellteam.example.invalid/' },
    fetch: () => { network++; throw Error('UNEXPECTED_FETCH') },
    localStorage: { setItem() { writes++ }, getItem() {}, removeItem() { writes++ } },
  })
  const logs = []
  for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, (...args) => logs.push(args))
  t.after(() => {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
    assert.equal(network, 0); assert.equal(writes, 0); assert.deepEqual(logs, [])
  })
  const render = request => renderSecretRequest(request, { api, sender: '担当', onComplete: updated => { completed.push(updated); render(updated) } })
  const open = card => { card.querySelector('button').handlers.click(); return body.querySelectorAll('dialog').at(-1) }
  return { render, open, body, events, completed }
}

test('fixed official origins render the same protected anchor in card and dialog without mutating input or fetching', t => {
  const f = fixture(t)
  for (const origin of origins) {
    const request = { ...pending, ownerGuide: { url: `${origin}/oauth/authorize?state=synthetic-only&redirect_uri=https%3A%2F%2Flocalhost%2Fcallback` } }
    const before = JSON.stringify(request)
    const card = f.render(request), dialog = f.open(card)
    for (const node of [card, dialog]) {
      const [link] = node.querySelectorAll('a')
      assert.equal(node.querySelectorAll('a').length, 1)
      assert.equal(link.href, request.ownerGuide.url)
      assert.equal(link.textContent, '公式認証ページを開く')
      assert.equal(link.target, '_blank'); assert.equal(link.rel, 'noopener noreferrer'); assert.equal(link.referrerPolicy, 'no-referrer')
      assert.ok(!text(node).includes(request.ownerGuide.url))
    }
    assert.equal(dialog.querySelector('input').type, 'password')
    assert.equal(JSON.stringify(request), before)
    dialog.close()
  }
})

test('missing/malformed/nonofficial URLs preserve input controls without creating anchors', t => {
  const f = fixture(t)
  const invalid = [undefined, null, {}, { url: null }, { url: 42 }, { url: '' }, { url: '/oauth/authorize' },
    ...['http://claude.ai/login', 'javascript:alert(1)', 'data:text/html,hello', 'https://claude.ai.evil.invalid/',
      'https://sub.claude.ai/', 'https://claude.ai:444/', 'https://evil.invalid/?next=https://claude.ai',
      'https://claude.ai@evil.invalid/', 'https://user@claude.ai/', 'https://user:password@claude.ai/', 'https://:password@claude.ai/',
      'https://claude.ai:invalid/'].map(url => ({ url }))]
  for (const ownerGuide of invalid) {
    const request = { ...pending, ownerGuide }
    const card = f.render(request), dialog = f.open(card)
    assert.equal(card.querySelectorAll('a').length, 0)
    assert.equal(dialog.querySelectorAll('a').length, 0)
    assert.equal(dialog.querySelector('input').type, 'password')
    assert.equal(dialog.querySelectorAll('button').length, 3)
    dialog.close()
  }
})

test('closed cards never show links and retain submitted/notification failure and cancelled labels', t => {
  const f = fixture(t)
  for (const status of ['submitted', 'cancelled']) {
    const card = f.render({ ...pending, status, notification: 'failed', ownerGuide: { url: `${origins[0]}/oauth/authorize` } })
    assert.equal(card.querySelectorAll('a').length, 0)
    assert.equal(card.querySelectorAll('button').length, 0)
    assert.match(text(card), status === 'submitted' ? /登録済み/ : /入力を取り消しました/)
    assert.match(text(card), /AIへの通知に失敗/)
  }
})

test('updated projection removes an open dialog link without clearing input or altering unrelated dialogs', t => {
  const f = fixture(t)
  const request = { ...pending, ownerGuide: { url: `${origins[0]}/oauth/authorize` } }
  const dialog = f.open(f.render(request))
  dialog.querySelector('input').value = 'synthetic-input'
  const other = f.open(f.render({ ...request, id: 'request-b' }))
  const card = f.render(pending)
  assert.equal(card.querySelectorAll('a').length, 0)
  assert.equal(dialog.querySelectorAll('a').length, 0)
  assert.equal(dialog.querySelector('input').value, 'synthetic-input')
  assert.equal(other.querySelectorAll('a').length, 1)
  dialog.close(); other.close()
})

for (const action of ['submit', 'cancel']) test(`explicit ${action} keeps existing request/transport and clear/close behavior`, async t => {
  const calls = [], f = fixture(t, async (path, options) => {
    calls.push({ path, options })
    return { request: { ...pending, status: action === 'submit' ? 'submitted' : 'cancelled' } }
  })
  const dialog = f.open(f.render({ ...pending, ownerGuide: { url: `${origins[0]}/oauth/authorize` } }))
  const input = dialog.querySelector('input')
  input.value = 'synthetic-input'
  document.hidden = true; f.events.get('visibilitychange')(); assert.equal(input.value, '')
  input.value = 'synthetic-input'
  if (action === 'submit') dialog.querySelector('form').handlers.submit({ preventDefault() {} })
  else dialog.querySelectorAll('button')[1].handlers.click()
  await turn()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, `/api/secret-requests/request-a/${action}`)
  assert.deepEqual(JSON.parse(calls[0].options.body), action === 'submit' ? { value: 'synthetic-input' } : {})
  assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[0].options.cache, 'no-store')
  assert.equal(calls[0].options.credentials, 'same-origin')
  assert.equal(input.value, ''); assert.equal(dialog.open, false)
  assert.equal(dialog.querySelectorAll('a').length, 0)
  assert.equal(f.completed.length, 1)
  assert.equal(f.body.querySelectorAll('dialog').length, 0)
  assert.equal(f.events.has('visibilitychange'), false)
})

test('failed submission displays the existing fixed error without exposing the guide URL or retrying', async t => {
  const url = `${origins[0]}/oauth/authorize?state=synthetic-only`
  let calls = 0
  const f = fixture(t, async () => { calls++; throw Error(url) })
  const dialog = f.open(f.render({ ...pending, ownerGuide: { url } }))
  dialog.querySelector('input').value = 'synthetic-input'
  dialog.querySelector('form').handlers.submit({ preventDefault() {} })
  await turn()
  assert.equal(calls, 1)
  assert.match(text(dialog), /登録結果を確認できませんでした/)
  assert.ok(!text(dialog).includes(url))
  assert.equal(dialog.querySelector('input').value, '')
  assert.equal(dialog.open, true)
  assert.deepEqual(f.completed, [])
  dialog.close()
})
