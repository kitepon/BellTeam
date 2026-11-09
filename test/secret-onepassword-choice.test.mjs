import assert from 'node:assert/strict'
import test from 'node:test'
import { renderSecretRequest } from '../web/secret-input.js'
import { Element } from './helpers/editor-dom.mjs'

class SecretElement extends Element {
  dataset = {}; attributes = {}; hidden = false; checked = false
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
const pending = { id: 'request-a', botId: 'bot-a', toolId: 'example', label: '接続トークン', message: '入力してください。', status: 'pending' }
const reference = 'op://vault-synthetic/item-synthetic/password'
const turn = () => new Promise(resolve => setImmediate(resolve))
const text = node => [node.textContent ?? '', node.value ?? '', ...node.children.map(text)].join(' ')

function fixture(t, api) {
  const body = new SecretElement('body'), events = new Map(), calls = [], logs = []
  const previous = Object.fromEntries(['document', 'location'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  Object.assign(globalThis, {
    document: { body, hidden: false, createElement: tag => new SecretElement(tag), querySelectorAll: selector => body.querySelectorAll(selector),
      addEventListener: (name, handler) => events.set(name, handler), removeEventListener: name => events.delete(name) },
    location: { href: 'https://bellteam.example.invalid/' },
  })
  for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, (...args) => logs.push(args))
  t.after(() => {
    for (const [key, descriptor] of Object.entries(previous)) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]
    assert.deepEqual(logs, [])
  })
  const cards = []
  const call = async (path, options) => { calls.push({ path, body: JSON.parse(options.body) }); return api(path, options) }
  const render = request => { const card = renderSecretRequest(request, { api: call, sender: '担当', onComplete: updated => cards.push(render(updated)) }); return card }
  const open = request => { render(request).querySelector('button').handlers.click(); return body.querySelectorAll('dialog').at(-1) }
  const parts = dialog => {
    const inputs = dialog.querySelectorAll('input')
    return { radios: inputs.filter(i => i.type === 'radio'), value: inputs.find(i => i.type === 'password'), reference: inputs.find(i => i.type === 'text'),
      error: dialog.querySelector('.secret-error'), submit: () => dialog.querySelector('form').handlers.submit({ preventDefault() {} }) }
  }
  return { open, parts, calls, cards, events }
}
const ok = async () => ({ request: { ...pending, status: 'submitted' } })

test('connected 1Password is listed first and selected; submit sends only source+reference and the card echoes neither', async t => {
  const f = fixture(t, ok)
  for (const preferred of ['onepassword', undefined]) {
    const dialog = f.open({ ...pending, inputOptions: { preferred, onePasswordAvailable: true } })
    const p = f.parts(dialog)
    assert.deepEqual(p.radios.map(r => [r.value, r.checked]), [['onepassword', true], ['stored', false]])
    assert.equal(p.value.hidden, true); assert.equal(p.reference.hidden, false)
    p.reference.value = ` ${reference} `
    p.submit(); await turn()
    assert.deepEqual(f.calls.at(-1), { path: '/api/secret-requests/request-a/submit', body: { source: 'onepassword', reference } })
    assert.equal(dialog.open, false); assert.equal(p.reference.value, '')
    assert.ok(!text(f.cards.at(-1)).includes('op://'))
  }
})

test('preferred stored selects the value fallback and switching sources clears the other field', async t => {
  const f = fixture(t, ok)
  const dialog = f.open({ ...pending, inputOptions: { preferred: 'stored', onePasswordAvailable: true } })
  const p = f.parts(dialog)
  assert.deepEqual(p.radios.map(r => r.checked), [false, true])
  p.value.value = 'synthetic-value'
  p.radios[0].handlers.change(); assert.equal(p.value.value, ''); assert.equal(p.value.hidden, true)
  p.reference.value = reference
  p.radios[1].handlers.change(); assert.equal(p.reference.value, ''); assert.equal(p.reference.hidden, true)
  p.value.value = 'synthetic-value'
  p.submit(); await turn()
  assert.deepEqual(f.calls.map(c => c.body), [{ value: 'synthetic-value' }])
})

test('missing or non-op:// reference is refused locally; a failed submit keeps the reference; hiding the page clears it', async t => {
  const f = fixture(t, async () => { throw Error('HTTP_400') })
  const dialog = f.open({ ...pending, inputOptions: { preferred: 'onepassword', onePasswordAvailable: true } })
  const p = f.parts(dialog)
  for (const bad of ['', 'vault/item/field', 'https://op.example/']) {
    p.reference.value = bad; p.submit(); await turn()
    assert.match(p.error.textContent, /op:\/\//)
  }
  assert.equal(f.calls.length, 0)
  p.reference.value = reference; p.submit(); await turn()
  assert.equal(f.calls.length, 1); assert.equal(dialog.open, true)
  assert.equal(p.reference.value, reference)
  assert.ok(!p.error.textContent.includes(reference))
  document.hidden = true; f.events.get('visibilitychange')(); assert.equal(p.reference.value, '')
})

test('without onePasswordAvailable === true the dialog is the existing value-only form', async t => {
  const f = fixture(t, ok)
  for (const inputOptions of [undefined, null, {}, { onePasswordAvailable: false, preferred: 'onepassword' }, { onePasswordAvailable: 'true' }]) {
    const dialog = f.open({ ...pending, inputOptions })
    const p = f.parts(dialog)
    assert.equal(p.radios.length, 0); assert.equal(p.reference, undefined)
    assert.equal(dialog.querySelectorAll('fieldset').length, 0)
    p.value.value = 'synthetic-value'; p.submit(); await turn()
    assert.deepEqual(f.calls.at(-1).body, { value: 'synthetic-value' })
  }
})

test('terminal.ssh stored value is a multiline field sent byte-exact; sudo and other secrets keep the password input', async t => {
  const f = fixture(t, ok)
  const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic line one\nsynthetic line two  \n-----END OPENSSH PRIVATE KEY-----\n'
  const ssh = f.open({ ...pending, botId: null, terminalId: 'owner-macbook', purpose: 'terminal.ssh', inputOptions: { preferred: 'onepassword', onePasswordAvailable: true } })
  const area = ssh.querySelectorAll('textarea')[0], p = f.parts(ssh)
  assert.equal(p.value, undefined); assert.equal(area.hidden, true); assert.equal(p.reference.hidden, false)
  p.radios[1].handlers.change(); assert.equal(area.hidden, false)
  area.value = key; p.submit(); await turn()
  assert.deepEqual(f.calls.at(-1).body, { value: key }); assert.equal(area.value, '')
  for (const purpose of ['terminal.sudo', undefined]) {
    const dialog = f.open({ ...pending, purpose })
    assert.equal(dialog.querySelectorAll('textarea').length, 0); assert.ok(f.parts(dialog).value)
  }
})
