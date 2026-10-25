import test from 'node:test'
import assert from 'node:assert/strict'
import { renderHarnessAuth } from '../web/harness-auth.js'
import { openOnboarding } from '../web/onboarding.js'

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.textContent = ''; this.value = ''; this.dataset = {}; this.listeners = {}; this.open = false }
  append(...nodes) { this.children.push(...nodes) }
  replaceChildren(...nodes) { this.children = nodes }
  setAttribute(key, value) { this[key] = value }
  addEventListener(key, listener) { (this.listeners[key] ??= []).push(listener) }
  fire(key) { for (const listener of this.listeners[key] ?? []) listener({ preventDefault() {} }) }
  showModal() { this.open = true }
  remove() {}
}
const all = node => [node, ...node.children.flatMap(all)]
const settle = () => new Promise(resolve => setImmediate(resolve))
const binding = { session_id: 'synthetic-auth', launch_id: null, metadata_identity: 'owned', native_id: 'native',
  pane_id: '%1', server_pid: 100, server_started: 'birth', pane_pid: 101, pane_started: 'birth' }
const waiting = { status: 'waiting', session_id: binding.session_id, auth_ui: { schema: 'aiterm.auth-ui.v1', binding,
  stage: 'paste_code', title: '以前のコード入力', message: '', url: 'https://example.invalid/login',
  input: 'authorization_code', prompt_digest: 'a'.repeat(64), choices: [], user_code: null } }
const completed = { status: 'authenticated', session_id: null, auth_ui: { schema: 'aiterm.auth-ui.v1', binding: null,
  stage: 'complete', title: '認証完了', message: '', url: null, input: null, prompt_digest: null, choices: [], user_code: null } }

for (const kind of ['settings', 'onboarding']) for (const late of ['success', 'error']) {
  test(`${kind}: hidden→visibleで新しい確認が先に完了した後、古い${late}で入力画面へ戻らない`, async t => {
    const previous = globalThis.document, listeners = []
    const document = { hidden: false, body: new Element('body'), createElement: tag => new Element(tag),
      addEventListener: (_type, listener) => listeners.push(listener),
      removeEventListener: (_type, listener) => { const i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1) } }
    globalThis.document = document
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const pending = []
    let reads = 0, posts = 0, section, row
    const setup = auth => ({ phase: 'authenticate', harness: 'claude', harnesses: [{ id: 'claude', name: 'Claude' }], auth, complete: false })
    const hold = wrap => new Promise((resolve, reject) => pending.push({ resolve: auth => resolve(wrap(auth)), reject }))
    try {
      if (kind === 'settings') {
        const container = new Element('div')
        section = await renderHarnessAuth(container, { api: async (path, options = {}) => {
          if (options.method === 'POST') posts++
          if (path === '/api/harness-auth') return { harnesses: [{ id: 'claude', name: 'Claude', members: 1 }] }
          if (++reads === 1) return { auth: waiting }
          return hold(auth => ({ auth }))
        } })
        row = container.children[0]; row.open = true; row.fire('toggle'); await settle()
      } else {
        openOnboarding(setup(waiting), { api: async (_path, options = {}) => {
          if (options.method === 'POST') posts++
          reads++; return hold(setup)
        }, onReady() {} })
        row = document.body.children[0]
      }
      t.mock.timers.tick(3000); await settle(); assert.equal(pending.length, 1)
      document.hidden = true; for (const listener of [...listeners]) listener()
      document.hidden = false; for (const listener of [...listeners]) listener()
      t.mock.timers.tick(3000); await settle(); assert.equal(pending.length, 2)
      pending[1].resolve(completed); await settle()
      assert.ok(all(row).some(node => node.textContent === '認証完了'))
      if (late === 'success') pending[0].resolve(waiting)
      else pending[0].reject(Error('以前の状態確認の失敗'))
      await settle()
      assert.ok(all(row).some(node => node.textContent === '認証完了'))
      assert.equal(all(row).some(node => node.tag === 'input'), false)
      assert.equal(all(row).some(node => node.textContent === '以前の状態確認の失敗'), false)
      t.mock.timers.tick(9000); await settle()
      assert.equal(pending.length, 2); assert.equal(posts, 0)
    } finally {
      section?.stop(); if (kind === 'onboarding') row?.fire('close')
      t.mock.timers.reset(); globalThis.document = previous
    }
  })
}
