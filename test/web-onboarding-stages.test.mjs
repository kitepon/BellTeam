import test from 'node:test'
import assert from 'node:assert/strict'
import { openOnboarding } from '../web/onboarding.js'

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.textContent = ''; this.value = ''; this.className = ''; this.dataset = {}; this.listeners = {}; this.open = false }
  append(...nodes) { this.children.push(...nodes) }
  replaceChildren(...nodes) { this.children = nodes }
  setAttribute(key, value) { this[key] = value }
  addEventListener(key, listener) { (this.listeners[key] ??= []).push(listener) }
  showModal() { this.open = true }
  close() { this.open = false; for (const listener of this.listeners.close ?? []) listener() }
  remove() {}
}
const all = node => [node, ...node.children.flatMap(all)]
const settle = () => new Promise(resolve => setImmediate(resolve))
const setup = auth => ({ phase: 'authenticate', harness: 'claude', harnesses: [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'Codex' }], auth, complete: false })
const ui = stage => ({ status: stage === 'complete' ? 'authenticated' : 'waiting', session_id: 's', auth_ui: { schema: 'aiterm.auth-ui.v1', binding: { session_id: 's' }, stage, title: 't', message: '',
  url: ['open_url', 'device_code'].includes(stage) ? 'https://example.invalid/login' : null, user_code: stage === 'device_code' ? 'ABCD-1234' : null, input: null, prompt_digest: 'a'.repeat(64), choices: [] } })
function open(t, initial, api = async () => initial) {
  const previous = globalThis.document
  globalThis.document = { hidden: false, body: new Element('body'), createElement: tag => new Element(tag), addEventListener() {}, removeEventListener() {} }
  t.after(() => { globalThis.document = previous })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  openOnboarding(initial, { api, onReady() {} })
  const dialog = globalThis.document.body.children[0]
  return { dialog, nodes: () => all(dialog), primary: () => all(dialog).filter(node => node.className === 'primary-button').map(node => node.textContent) }
}

test('each stage has exactly its own primary step and the stepper marks it (W84)', t => {
  const cases = [
    [{ status: 'blocked', session_id: null, auth_ui: null }, ['ログインを始める'], 'ログイン'],
    [ui('complete'), ['始める'], '始める'],
    [ui('device_code'), [], 'ログイン'],
  ]
  for (const [auth, primary, current] of cases) {
    const f = open(t, setup(auth))
    assert.deepEqual(f.primary(), primary)
    assert.equal(f.nodes().find(node => node['aria-current'] === 'step').textContent, current)
    assert.equal(f.nodes().some(node => /認証を確認して始める|認証の状態を更新/.test(node.textContent)), false)
    if (auth.auth_ui?.stage === 'device_code') {
      assert.ok(f.nodes().some(node => node.textContent === 'ABCD-1234'))
      assert.ok(f.nodes().some(node => node.textContent === 'ログインを確かめる'))
    }
    f.dialog.close(); t.mock.timers.reset()
  }
})

test('「別のAIを選ぶ」 is a real button that shows the AI tiles without changing anything (W84)', t => {
  const f = open(t, setup(ui('device_code')))
  f.nodes().find(node => node.textContent === '別のAIを選ぶ').listeners.click[0]()
  assert.equal(f.nodes().find(node => node['aria-current'] === 'step').textContent, 'AIを選ぶ')
  assert.ok(f.nodes().some(node => node.textContent === 'Codex'))
  assert.ok(f.nodes().some(node => node.textContent === 'Claudeのまま進める'))
})

test('a failed check says so with 「もう一度試す」, which reads again and restarts the checks (W85)', async t => {
  let fail = true, reads = 0
  const f = open(t, setup(ui('device_code')), async () => { reads++; if (fail) throw new Error('つながりませんでした'); return setup(ui('device_code')) })
  t.mock.timers.tick(3000); await settle()
  assert.equal(reads, 1)
  const retry = f.nodes().find(node => node.textContent === 'もう一度試す')
  assert.ok(retry, 'the error carries its own retry')
  t.mock.timers.tick(9000); await settle()
  assert.equal(reads, 1) // no silent polling while the error is shown
  fail = false
  retry.listeners.click[0](); await settle()
  assert.equal(reads, 2)
  assert.equal(f.nodes().some(node => node.textContent === 'もう一度試す'), false)
  t.mock.timers.tick(3000); await settle()
  assert.equal(reads, 3) // polling resumed
})
