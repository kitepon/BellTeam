import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keySourceOf, projectRootProblem, readTerminals, remoteBindingBody, terminalStatus } from '../web/terminals.js'

test('check observation -> plain words; host trust reasons ask for the fingerprint', () => {
  assert.equal(terminalStatus(null).label, '未確認')
  assert.equal(terminalStatus({ reachable: true }).tone, 'ok')
  assert.equal(terminalStatus({ reachable: false, reason: 'SSH_KEY_UNSET' }).label, 'SSH鍵が未設定')
  for (const reason of ['AUTH_FAILED', 'CREDENTIAL_UNAVAILABLE', 'CREDENTIAL_REVISION_STALE']) assert.equal(terminalStatus({ reachable: false, reason }).label, '鍵が使えません')
  for (const reason of ['HOST_TRUST_MISSING', 'HOST_KEY_MISMATCH', 'HOST_TRUST_STALE', 'TARGET_MISMATCH']) assert.equal(terminalStatus({ reachable: false, reason }).trust, true)
  for (const reason of ['UNREACHABLE', 'CONNECTION_LOST', 'TERMINAL_UNAVAILABLE', 'SOMETHING_NEW', null]) assert.equal(terminalStatus({ reachable: false, reason }).label, '届きません')
  assert.equal(terminalStatus({ reachable: false, reason: 'UNREACHABLE' }).reason, 'UNREACHABLE')
})

test('projectRoot follows members C1', () => {
  for (const ok of ['', '/', '/Users/kite/work/app']) assert.equal(projectRootProblem(ok), '')
  for (const bad of ['Users/kite', '/Users//kite', '/Users/./kite', '/Users/../etc', '/Users/kite/', '/a\0b', `/${'a'.repeat(4096)}`]) assert.notEqual(projectRootProblem(bad), '', bad)
})

test('binding body: both or neither, only when changed', () => {
  assert.deepEqual(remoteBindingBody(null, '', ''), { body: {} })
  assert.deepEqual(remoteBindingBody({ terminalId: '', projectRoot: '' }, '', '/ignored'), { body: {} })
  assert.ok(remoteBindingBody(null, 'owner-macbook', ' ').error)
  assert.ok(remoteBindingBody(null, 'owner-macbook', 'relative').error)
  assert.deepEqual(remoteBindingBody(null, 'owner-macbook', ' /Users/kite/app '), { body: { terminalId: 'owner-macbook', projectRoot: '/Users/kite/app' } })
  assert.deepEqual(remoteBindingBody({ terminalId: 'owner-macbook', projectRoot: '/Users/kite/app' }, 'owner-macbook', '/Users/kite/app'), { body: {} })
  assert.deepEqual(remoteBindingBody({ terminalId: 'owner-macbook', projectRoot: '/Users/kite/app' }, '', '/Users/kite/app'), { body: { terminalId: '', projectRoot: '' } })
})

test('readTerminals tolerates older bodies and an unmounted core', async () => {
  const failing = error => async () => { throw error }
  assert.deepEqual(await readTerminals(async () => ({ terminals: [{ terminalId: 'a' }] })), { terminals: [{ terminalId: 'a' }] })
  const old = await readTerminals(failing({ status: 404 }))
  assert.equal(old.unsupported, true)
  assert.match(old.message, /端末は、本体を「Update」で更新すると使えます。/)
  assert.match((await readTerminals(failing({ status: 503, code: 'TERMINALS_UNAVAILABLE' }))).message, /動いていません/)
  await assert.rejects(readTerminals(failing(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
})

// Minimal DOM for the view's own seams (gate #812): key source per purpose, save/trust intent across suspend, failure, reopen, new edit.
class E {
  constructor(tag) { this.tagName = tag; this.children = []; this.handlers = {}; this.dataset = {}; this.value = ''; this.disabled = false; this.open = false; this.textContent = '' }
  addEventListener(name, fn) { (this.handlers[name] ??= []).push(fn) }
  setAttribute(name, value) { this[name] = value }
  append(...nodes) { this.children.push(...nodes) }
  replaceChildren(...nodes) { this.children = nodes }
  querySelector(selector) { this.nodes ??= new Map(); if (!this.nodes.has(selector)) this.nodes.set(selector, new E('x')); return this.nodes.get(selector) }
  showModal() { this.open = true }
  close() { this.open = false; this.fire('close') }
  fire(name) { for (const fn of this.handlers[name] ?? []) fn({ preventDefault() {} }) }
}
const nodes = root => [root, ...root.children.flatMap(nodes)]
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const settle = () => new Promise(resolve => setImmediate(resolve))
async function view(t, terminals) {
  const previous = globalThis.document
  globalThis.document = { createElement: tag => new E(tag) }
  t.after(() => { globalThis.document = previous })
  const { createTerminalsView } = await import('../web/terminals.js')
  const dialog = new E('dialog'), puts = []
  const api = async (path, options) => {
    if (options?.method === 'PUT') { const d = deferred(); puts.push({ path, body: JSON.parse(options.body), ...d }); return d.promise }
    return { terminals }
  }
  const terminalsView = createTerminalsView(dialog, { api })
  const body = dialog.querySelector('[data-terminals-body]')
  const all = () => nodes(body)
  const click = text => all().find(node => node.tagName === 'button' && node.textContent === text).fire('click')
  const typed = (form, placeholder, value) => { nodes(form).find(node => node.placeholder === placeholder).value = value; form.fire('input') }
  return { dialog, body, all, click, typed, puts, open: () => terminalsView.open(), add: () => dialog.querySelector('[data-terminals-add]').fire('click'),
    form: () => all().find(node => node.className === 'terminal-form'), trust: () => all().find(node => node.className === 'terminal-trust'),
    notice: () => nodes(dialog.querySelector('[data-terminals-notice]')).map(node => node.textContent).join('') }
}
const mac = { terminalId: 'a', host: 'h', user: 'u', port: 22, os: 'macos', accountOwner: 'owner', revision: 1, sshKeyConfigured: true, sudoKeyConfigured: true, keySource: 'terminal-native' }

test('key source is per purpose: native SSH never hides sudo removal', async t => {
  assert.equal(keySourceOf(mac, 'ssh'), 'terminal-native')
  assert.equal(keySourceOf(mac, 'sudo'), 'secret')
  assert.equal(keySourceOf({ ...mac, sshKeySource: 'secret', sudoKeySource: 'secret' }, 'ssh'), 'secret')
  const v = await view(t, [{ ...mac, hostTrust: { provider: 'p', revision: 'r' } }]); await v.open()
  const rows = v.all().filter(node => node.className === 'terminal-key').map(row => nodes(row).map(node => node.textContent))
  assert.ok(!rows[0].includes('外す') && rows[0].includes('設定済み · 端末の鍵'))
  assert.ok(rows[1].includes('外す') && rows[1].includes('設定済み · 秘密入力'))
})

test('a suspended save keeps a newer edit; failure keeps the draft; an unchanged save closes its form', async t => {
  const v = await view(t, [{ ...mac, hostTrust: { provider: 'p', revision: 'r' } }]); await v.open()
  v.add(); v.typed(v.form(), 'owner-macbook', 'new-mac'); v.typed(v.form(), '192.168.1.12', '10.0.0.2'); v.typed(v.form(), 'kite', 'kite')
  v.form().fire('submit'); await settle()
  v.click('編集') // newer intent while the PUT is pending
  v.puts[0].resolve({}); await settle(); await settle()
  assert.equal(v.puts[0].path, '/api/terminals/new-mac')
  assert.equal(nodes(v.form()).find(node => node.tagName === 'h4').textContent, '「a」を編集')
  assert.match(v.notice(), /そのあとに変えた入力は残しています/)

  v.typed(v.form(), '192.168.1.12', 'bad@host'); v.form().fire('submit'); await settle()
  v.puts[1].reject(Object.assign(new Error('x'), { code: 'INVALID_TERMINAL' })); await settle(); await settle()
  assert.equal(nodes(v.form()).find(node => node.placeholder === '192.168.1.12').value, 'bad@host')

  v.form().fire('submit'); await settle(); v.puts[2].resolve({}); await settle(); await settle()
  assert.equal(v.form(), undefined)
})

test('host key draft: failure keeps it, a reopened dialog keeps its newer draft, success in the same dialog clears it', async t => {
  const v = await view(t, [mac]); await v.open()
  const fingerprint = value => { nodes(v.trust()).find(node => node.placeholder === 'SHA256:…').value = value; nodes(v.trust()).find(node => node.placeholder === 'SHA256:…').fire('input') }
  const field = () => nodes(v.trust()).find(node => node.placeholder === 'SHA256:…').value
  fingerprint('SHA256:old'); v.trust().fire('submit'); await settle()
  v.puts[0].reject(Object.assign(new Error('x'), { code: 'HOST_KEY_FINGERPRINT_MISMATCH' })); await settle(); await settle()
  assert.equal(field(), 'SHA256:old')

  v.trust().fire('submit'); await settle()
  v.dialog.close(); await v.open(); fingerprint('SHA256:new')
  v.puts[1].resolve({}); await settle(); await settle()
  assert.equal(field(), 'SHA256:new')

  v.trust().fire('submit'); await settle(); v.puts[2].resolve({}); await settle(); await settle()
  assert.equal(field(), '')
})

test('older body (404) is a neutral notice: icon, no refresh, 追加 disabled; 503 stays an error with refresh', async t => {
  const previous = globalThis.document
  globalThis.document = { createElement: tag => new E(tag) }
  t.after(() => { globalThis.document = previous })
  const { createTerminalsView } = await import('../web/terminals.js')
  for (const [error, tone, hidden] of [[{ status: 404 }, 'terminals-info', true], [{ status: 503, code: 'TERMINALS_UNAVAILABLE' }, 'form-error', false]]) {
    const dialog = new E('dialog')
    await createTerminalsView(dialog, { api: async () => { throw error } }).open()
    const notice = dialog.querySelector('[data-terminals-notice]')
    assert.equal(notice.className, tone)
    assert.equal(nodes(notice).some(node => node.className === 'terminals-info-icon'), tone === 'terminals-info')
    assert.equal(Boolean(dialog.querySelector('[data-terminals-refresh]').hidden), hidden)
    assert.equal(dialog.querySelector('[data-terminals-add]').disabled, true)
  }
})
