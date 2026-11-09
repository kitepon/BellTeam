import test from 'node:test'
import assert from 'node:assert/strict'
import { openOnboarding } from '../web/onboarding.js'

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.textContent = ''; this.dataset = {}; this.listeners = {}; this.open = false }
  append(...nodes) { this.children.push(...nodes) }
  replaceChildren(...nodes) { this.children = nodes }
  setAttribute(key, value) { this[key] = value }
  addEventListener(key, listener) { (this.listeners[key] ??= []).push(listener) }
  fire(key, event = {}) { for (const listener of this.listeners[key] ?? []) listener(event) }
  showModal() { this.open = true }
  close() { if (!this.open) return; this.open = false; this.fire('close') }
  remove() {}
}
const all = node => [node, ...node.children.flatMap(all)]
const settle = () => new Promise(resolve => setImmediate(resolve))
const setup = phase => ({ phase, harness: null, harnesses: [{ id: 'claude', name: 'Claude' }], guideBotId: null, complete: false, auth: null })

function open(t, api = async () => setup('select_harness')) {
  const previous = globalThis.document
  globalThis.document = { hidden: false, body: new Element('body'), createElement: tag => new Element(tag), addEventListener() {}, removeEventListener() {} }
  t.after(() => { globalThis.document = previous })
  const calls = { ready: [], later: [] }
  openOnboarding(setup('select_harness'), { api, onReady: s => { calls.ready.push(s) }, onLater: s => { calls.later.push(s) } })
  return { dialog: globalThis.document.body.children[0], calls }
}

test('初回設定: Escを止めず、「あとで設定する」で閉じてonLaterへ進む', t => {
  const { dialog, calls } = open(t)
  const event = { prevented: false, preventDefault() { this.prevented = true } }
  dialog.fire('cancel', event)
  assert.equal(event.prevented, false)
  all(dialog).find(node => node.textContent === 'あとで設定する').fire('click')
  assert.equal(dialog.open, false)
  assert.deepEqual(calls.later.map(s => s.phase), ['select_harness'])
  assert.equal(calls.ready.length, 0)
})

test('初回設定: readyで閉じた時はonLaterを呼ばない', async t => {
  const { dialog, calls } = open(t, async () => setup('ready'))
  all(dialog).find(node => node.textContent === 'Claude').fire('click')
  await settle()
  assert.equal(dialog.open, false)
  assert.equal(calls.ready.length, 1)
  assert.equal(calls.later.length, 0)
})
