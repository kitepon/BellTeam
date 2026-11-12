import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authorizeText, checkBadge, checkTime, friendlyName, keySourceOf, memberFolder, projectRootProblem, readTerminals, remoteBindingBody, seatLaunchText, terminalIdFromName, terminalStatus } from '../web/terminals.js'

test('check observation -> plain words; host trust reasons ask for the fingerprint', () => {
  assert.equal(terminalStatus(null).label, '未確認')
  assert.equal(terminalStatus({ reachable: true }).tone, 'ok')
  assert.equal(terminalStatus({ reachable: false, reason: 'SSH_KEY_UNSET' }).label, 'SSH鍵が未設定')
  // Self-service step 4: evidence reasons offer the likely fix; AUTH_FAILED offers authorizing the key.
  assert.deepEqual([terminalStatus({ reachable: false, reason: 'AUTH_FAILED' }).help, terminalStatus({ reachable: false, reason: 'AUTH_FAILED' }).authorize], ['この鍵がまだMacに入っていないかもしれません。', true])
  assert.equal(terminalStatus({ reachable: false, reason: 'CONNECTION_REFUSED' }).help, 'Macのリモートログインがオンか確かめてください。')
  assert.equal(terminalStatus({ reachable: false, reason: 'UNREACHABLE' }).help, 'Macが起きていて、同じネットワークにあるか確かめてください。')
  assert.equal(terminalStatus({ reachable: false, reason: 'SOMETHING_NEW', action: 'do X' }).help, 'do X')
  // Windows / Linux: the OS name in the words; terminals' action (it names the OS) wins over the Web fallback.
  assert.equal(terminalStatus({ reachable: false, reason: 'CONNECTION_REFUSED' }, 'windows').help, 'WindowsでOpenSSH サーバー（sshd）が動いているか確かめてください。')
  assert.equal(terminalStatus({ reachable: false, reason: 'CONNECTION_REFUSED', action: 'Linuxで sshd を開始してください。' }, 'linux').help, 'Linuxで sshd を開始してください。')
  assert.equal(terminalStatus({ reachable: false, reason: 'UNREACHABLE' }, 'linux').help, 'Linuxが起きていて、同じネットワークにあるか確かめてください。')
  assert.equal(terminalStatus({ reachable: false, reason: 'AUTH_FAILED' }, 'windows').help, 'この鍵がまだWindowsに入っていないかもしれません。')
  assert.equal(authorizeText('PASSWORD_AUTH_DISABLED', 'windows'), 'このWindowsはパスワードでのログインを受け付けていません。')
  assert.deepEqual(['PASSWORD_REJECTED', 'PASSWORD_AUTH_DISABLED', 'AUTHORIZATION_UNCONFIRMED', 'TERMINAL_CHANGED', null].map(authorizeText),
    ['パスワードが違いました。', 'このMacはパスワードでのログインを受け付けていません。', '入れられたか確かめられませんでした。もう一度お試しください。', 'もう一度お試しください。', 'もう一度お試しください。'])
  for (const reason of ['CREDENTIAL_UNAVAILABLE', 'CREDENTIAL_REVISION_STALE']) assert.equal(terminalStatus({ reachable: false, reason }).label, '鍵が使えません')
  for (const reason of ['HOST_TRUST_MISSING', 'HOST_KEY_MISMATCH', 'HOST_TRUST_STALE', 'TARGET_MISMATCH']) assert.equal(terminalStatus({ reachable: false, reason }).trust, true)
  for (const reason of ['UNREACHABLE', 'CONNECTION_LOST', 'TERMINAL_UNAVAILABLE', 'SOMETHING_NEW', null]) assert.equal(terminalStatus({ reachable: false, reason }).label, '届きません')
  assert.equal(terminalStatus({ reachable: false, reason: 'UNREACHABLE' }).reason, 'UNREACHABLE')
})

test('projectRoot follows members C1', () => {
  for (const ok of ['', '/', '/Users/kite/work/app']) assert.equal(projectRootProblem(ok), '')
  for (const bad of ['Users/kite', '/Users//kite', '/Users/./kite', '/Users/../etc', '/Users/kite/', '/a\0b', `/${'a'.repeat(4096)}`]) assert.notEqual(projectRootProblem(bad), '', bad)
  // windows (members #966): X:\... with \ only, no : after the drive, root X:\, no trailing \, <= 4096 bytes.
  for (const ok of ['', 'C:\\', 'C:\\Users\\kite_\\BellTeam\\アドミ', 'd:\\work']) assert.equal(projectRootProblem(ok, 'windows'), '', ok)
  for (const bad of ['/Users/kite', 'C:', 'C:/Users', 'C:\\Users/kite', 'C:\\Users\\', 'C:\\a\\\\b', 'C:\\a\\..\\b', 'C:\\a\0', 'C:\\a:b', `C:\\${'a'.repeat(4094)}`]) assert.notEqual(projectRootProblem(bad, 'windows'), '', bad)
  assert.ok(remoteBindingBody(null, 'fox', '/Users/kite', 'windows').error)
  assert.deepEqual(remoteBindingBody(null, 'fox', 'C:\\Users\\kite_\\app', 'windows'), { body: { terminalId: 'fox', projectRoot: 'C:\\Users\\kite_\\app' } })
  assert.deepEqual([memberFolder('kite_', 'a\\b', 'windows'), memberFolder('kite', 'アドミ', 'linux'), memberFolder('kite', 'アドミ')],
    ['C:\\Users\\kite_\\BellTeam\\a-b', '/home/kite/BellTeam/アドミ', '/Users/kite/BellTeam/アドミ'])
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
  const dialog = new E('dialog'), puts = [], checks = []
  const api = async (path, options) => {
    if (options?.method === 'PUT') { const d = deferred(); puts.push({ path, body: JSON.parse(options.body), ...d }); return d.promise }
    if (path.endsWith('/check')) { checks.push(path); return { reachable: false, reason: 'HOST_KEY_MISMATCH', observedAt: '2026-11-11T00:00:00Z' } }
    return { terminals }
  }
  const terminalsView = createTerminalsView(dialog, { api })
  const body = dialog.querySelector('[data-terminals-body]')
  const all = () => nodes(body)
  const click = text => all().find(node => node.tagName === 'button' && node.textContent === text).fire('click')
  const typed = (form, placeholder, value) => { nodes(form).find(node => node.placeholder === placeholder).value = value; form.fire('input') }
  return { dialog, body, all, click, typed, puts, checks, open: () => terminalsView.open(), add: () => dialog.querySelector('[data-terminals-add]').fire('click'),
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
  assert.ok(!rows[0].includes('外す') && rows[0].includes('鍵: 設定済み'))
  assert.ok(rows[1].includes('外す') && rows[1].includes('管理者の鍵: 設定済み'))
})

test('a suspended save keeps a newer edit; failure keeps the draft; an unchanged save closes its form', async t => {
  const v = await view(t, [{ ...mac, hostTrust: { provider: 'p', revision: 'r' } }]); await v.open()
  v.add(); v.typed(v.form(), '例：自分のMac', 'new-mac'); v.typed(v.form(), '192.168.1.12', '10.0.0.2'); v.typed(v.form(), 'kite', 'kite')
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

test('Windows / Linux: OS choice sends os and follows the precondition; card names the OS, no sudo on Windows, app line + ほかの方法 on Windows, sheet directly on Linux', async t => {
  const fox = { ...mac, terminalId: 'fox', os: 'windows', user: 'kite_', sudoKeyConfigured: false }
  const v = await view(t, [fox, { ...mac, terminalId: 'rabbit', os: 'linux', user: 'kite' }]); await v.open()
  const card = id => v.all().find(node => node.dataset?.terminalId === id)
  const text = node => nodes(node).map(item => item.textContent).join('|')
  assert.match(text(card('fox')), /\|Windows\|/); assert.match(text(card('rabbit')), /\|Linux\|/)
  assert.deepEqual(nodes(card('fox')).filter(node => node.className === 'terminal-key').length, 1)
  assert.equal(nodes(card('rabbit')).filter(node => node.className === 'terminal-key').length, 2)
  // First use is trusted by the body (accept-new, #1000): no sheet until a check reports a trust reason.
  assert.doesNotMatch(text(card('fox')), /ホスト鍵の指紋/)
  for (const id of ['fox', 'rabbit']) { nodes(card(id)).find(node => node.tagName === 'button' && node.textContent === '届くか確かめる').fire('click'); await settle(); await settle() }
  // Untrusted Windows: the Windows app attests it (S2, #1035); the sheet sits under ほかの方法. Linux has no app.
  assert.match(text(card('fox')), /このPCでBellTeamアプリを開くと、自動で確かめます。/)
  assert.equal(nodes(card('fox')).find(node => node.className === 'terminal-other').children[0].textContent, 'ほかの方法')
  assert.doesNotMatch(text(card('rabbit')), /BellTeamアプリ|ほかの方法/)
  assert.match(text(card('fox')), /PowerShellで ssh-keygen -lf C:\\ProgramData\\ssh\\ssh_host_ed25519_key\.pub/)
  assert.match(text(card('rabbit')), /ssh-keygen -lf \/etc\/ssh\/ssh_host_ed25519_key\.pub/)

  v.add()
  const select = nodes(v.form()).find(node => node.tagName === 'select' && node.children.some(option => option.value === 'windows'))
  assert.match(text(v.form()), /リモートログイン/)
  select.value = 'windows'; v.typed(v.form(), '例：自分のMac', 'fox2')
  assert.match(text(v.form()), /オプション機能」で「OpenSSH サーバー」を追加/); assert.doesNotMatch(text(v.form()), /macOS だけ|リモートログイン/)
  select.value = 'linux'; v.form().fire('input'); assert.match(text(v.form()), /openssh-server/)
  v.typed(v.form(), '192.168.1.12', '192.168.1.5'); v.typed(v.form(), 'kite', 'kite'); v.form().fire('submit'); await settle()
  assert.equal(v.puts[0].body.os, 'linux')
  v.puts[0].resolve({}); await settle(); await settle()
  // Editing keeps the saved OS.
  nodes(card('fox')).find(node => node.tagName === 'button' && node.textContent === '編集').fire('click')
  v.form().fire('submit'); await settle(); assert.equal(v.puts[1].body.os, 'windows')
})

test('host key draft: failure keeps it, a reopened dialog keeps its newer draft, success in the same dialog clears it', async t => {
  const v = await view(t, [mac]); await v.open()
  const changed = async () => { v.click('届くか確かめる'); await settle(); await settle() }
  const fingerprint = value => { nodes(v.trust()).find(node => node.placeholder === 'SHA256:…').value = value; nodes(v.trust()).find(node => node.placeholder === 'SHA256:…').fire('input') }
  const field = () => nodes(v.trust()).find(node => node.placeholder === 'SHA256:…').value
  const old = `SHA256:${'o'.repeat(43)}`, fresh = `SHA256:${'n'.repeat(43)}`
  await changed()
  fingerprint(old); v.trust().fire('submit'); await settle()
  v.puts[0].reject(Object.assign(new Error('x'), { code: 'HOST_KEY_FINGERPRINT_MISMATCH' })); await settle(); await settle()
  assert.equal(field(), old)

  v.trust().fire('submit'); await settle()
  v.dialog.close(); await v.open(); await changed(); fingerprint(fresh)
  v.puts[1].resolve({}); await settle(); await settle()
  assert.equal(field(), fresh)

  v.trust().fire('submit'); await settle(); v.puts[2].resolve({}); await settle(); await settle()
  // A successful confirm drops the observation, so the sheet goes away; the next trust reason shows it empty.
  assert.equal(v.trust(), undefined); await changed(); assert.equal(field(), '')
})

test('accept-new (#1000): no sheet without a trust reason; errors sit next to the tapped button; the whole ssh-keygen line is accepted', async t => {
  const v = await view(t, [{ ...mac, os: 'windows' }]); await v.open()
  const text = node => nodes(node).map(item => item.textContent).join('|')
  assert.equal(v.trust(), undefined)
  v.click('届くか確かめる'); await settle(); await settle()
  assert.ok(v.trust(), 'a changed key shows the sheet')
  const paste = value => { const input = nodes(v.trust()).find(node => node.placeholder === 'SHA256:…'); input.value = value; input.fire('input') }
  // Owner case 2026-11-11 (fox-windows): nothing left the page and the reason went to the off-screen top notice.
  paste('not a fingerprint'); v.trust().fire('submit'); await settle()
  assert.equal(v.puts.length, 0)
  assert.match(text(v.trust()), /指紋が見つかりません/); assert.equal(v.notice(), '')
  const fp = `SHA256:qJ0Ez4Y1f/${'A'.repeat(33)}`
  paste(`256 ${fp} kite_@fox (ED25519)`); v.trust().fire('submit'); await settle()
  assert.equal(v.puts[0].body.confirmHostKey, fp)
  assert.match(text(v.trust()), /確かめています…/)
  v.puts[0].reject(Object.assign(new Error('Host key did not match'), { code: 'HOST_KEY_FINGERPRINT_MISMATCH' })); await settle(); await settle()
  const error = nodes(v.trust()).find(node => node.className === 'form-error terminal-error')
  assert.equal(error.role, 'alert'); assert.match(text(error), /指紋が端末のものと一致しません/); assert.equal(v.notice(), '')
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

test('self-service: precondition line, auto trust with the manual sheet under ほかの方法, authorize key -> outcome -> check again', async t => {
  const previous = { document: globalThis.document, location: globalThis.location }
  const page = new E('body')
  globalThis.document = { createElement: tag => new E(tag), body: page, addEventListener() {}, removeEventListener() {} }
  globalThis.location = { href: 'https://bellteam.local/' }
  t.after(() => { globalThis.document = previous.document; globalThis.location = previous.location })
  E.prototype.focus = () => {}; E.prototype.remove = function () {}
  const { createTerminalsView } = await import('../web/terminals.js')
  const trusted = { ...mac, hostTrust: { provider: 'p', revision: 'r' } }
  let list = [{ ...mac, sshKeyConfigured: false }], reads = [], requests = 0, authorizeError = null, checkReason = 'HOST_KEY_MISMATCH'
  const calls = []
  const api = async (path, options = {}) => {
    calls.push(`${options.method ?? 'GET'} ${path}`)
    if (path === '/api/terminals') return { terminals: list }
    if (path === '/api/terminals/a/check') return { reachable: false, reason: checkReason, observedAt: '2026-11-10T00:00:00Z' }
    if (path === '/api/terminals/a/keys/ssh/authorize') { assert.equal(options.body, undefined); if (authorizeError) throw authorizeError; return { secretRequest: { id: `r${++requests}`, label: 'L', message: 'このMacのログインパスワード（1回だけ使い、保存しません）', purpose: 'terminal.login', status: 'pending' } } }
    if (path.startsWith('/api/secret-requests/')) return { request: { status: path.endsWith('/submit') ? 'submitted' : 'cancelled' } }
    if (path === '/api/terminals/a') return reads.shift()
    throw new Error(path)
  }
  const dialog = new E('dialog'), body = dialog.querySelector('[data-terminals-body]')
  const text = () => nodes(body).map(node => node.textContent).join('|')
  const click = label => nodes(body).find(node => node.tagName === 'button' && node.textContent === label).fire('click')
  const submitPassword = async () => { const card = page.children.at(-1); nodes(card).find(node => node.type === 'password').value = 'pw'; nodes(card).find(node => node.tagName === 'form').fire('submit'); await settle(); await settle() }
  await createTerminalsView(dialog, { api }).open()
  // No host trust and no trust reason: nothing to confirm (the body trusts first use, #1000).
  assert.doesNotMatch(text(), /自動で確かめます|ほかの方法/)
  // A changed key: the auto line, and the manual sheet only under ほかの方法 (key first there).
  click('届くか確かめる'); await settle(); await settle()
  assert.match(text(), /このMacでBellTeamアプリを開くと、自動で確かめます。/)
  const other = nodes(body).find(node => node.className === 'terminal-other')
  assert.equal(other.children[0].textContent, 'ほかの方法'); assert.match(nodes(other).map(node => node.textContent).join(''), /先にSSH鍵を設定してください/)
  dialog.querySelector('[data-terminals-add]').fire('click')
  assert.match(text(), /Macの「システム設定 > 一般 > 共有」で「リモートログイン」をオンにしてください。/)

  // A changed key on a trusted Mac: the app attests only untrusted terminals (S2), so no auto line and the sheet shows directly.
  list = [{ ...trusted, sshKeyConfigured: false }]; dialog.close(); await createTerminalsView(dialog, { api }).open()
  click('届くか確かめる'); await settle(); await settle()
  assert.doesNotMatch(text(), /自動で確かめます|ほかの方法/); assert.match(text(), /先にSSH鍵を設定してください/)

  list = [trusted]; checkReason = 'AUTH_FAILED'; dialog.close(); await createTerminalsView(dialog, { api }).open()
  assert.doesNotMatch(text(), /自動で確かめます|ほかの方法/)
  click('届くか確かめる'); await settle(); await settle()
  assert.match(text(), /この鍵がまだMacに入っていないかもしれません。/)
  // 409 before any password card.
  authorizeError = Object.assign(new Error('x'), { status: 409, code: 'HOST_TRUST_MISSING' })
  click('このMacにこの鍵を入れる'); await settle(); await settle()
  assert.match(text(), /このMacにこの鍵を入れる\|\|先にこの端末を確かめてください。/)
  assert.equal(page.children.length, 0); authorizeError = null
  // Pending is cleared before the outcome is recorded: a stale outcome is ignored until this request's outcome appears.
  reads = [{ keyAuthorizationPending: false, keyAuthorization: null }, { keyAuthorizationPending: false, keyAuthorization: { requestId: 'r1', outcome: 'PASSWORD_REJECTED' } }]
  click('このMacにこの鍵を入れる'); await settle(); await settle()
  assert.equal(page.children.at(-1).children[0].children[1].textContent, 'このMacのログインパスワード（1回だけ使い、保存しません）')
  await submitPassword(); await new Promise(resolve => setTimeout(resolve, 1100)); await settle()
  assert.match(text(), /パスワードが違いました。/)
  reads = [{ keyAuthorizationPending: false, keyAuthorization: { requestId: 'r2', outcome: 'AUTHORIZED' } }]
  const checks = calls.filter(call => call === 'POST /api/terminals/a/check').length
  click('このMacにこの鍵を入れる'); await settle(); await settle(); await submitPassword(); await settle(); await settle()
  assert.equal(calls.filter(call => call === 'POST /api/terminals/a/check').length, checks + 1)
  assert.doesNotMatch(text(), /パスワードが違いました/)
  // 入力を断る starts no wait.
  const gets = calls.filter(call => call === 'GET /api/terminals/a').length
  click('このMacにこの鍵を入れる'); await settle(); await settle()
  nodes(page.children.at(-1)).find(node => node.textContent === '入力を断る').fire('click'); await settle(); await settle()
  assert.equal(calls.filter(call => call === 'GET /api/terminals/a').length, gets)
})

test('seatLaunch -> one line; action first, else code; null/absent -> nothing', () => {
  assert.equal(seatLaunchText({ code: 'HOST_KEY_UNTRUSTED', action: ' confirm the host key of 192.168.1.12 ', terminalId: 'mac', at: 'x' }), '端末で起動できません：confirm the host key of 192.168.1.12')
  assert.equal(seatLaunchText({ code: 'UNREACHABLE', action: '' }), '端末で起動できません。')
  assert.equal(seatLaunchText({}), '端末で起動できません。')
  for (const value of [null, undefined, 'x']) assert.equal(seatLaunchText(value), null)
})

test('badge from the last check: reachable with JST time, not reachable amber with the action, never checked', () => {
  assert.equal(checkTime('2026-11-11T11:48:00Z'), '11/11 20:48')
  assert.equal(checkTime('2026-01-05T15:05:00Z'), '1/6 00:05')
  assert.deepEqual(checkBadge({ reachable: true, reason: null, checkedAt: '2026-11-11T11:48:00Z' }), { tone: 'ok', label: '11/11 20:48 につながりました' })
  assert.deepEqual(checkBadge({ reachable: true, observedAt: '2026-11-11T11:48:00Z' }), { tone: 'ok', label: '11/11 20:48 につながりました' })
  assert.deepEqual(checkBadge({ reachable: false, reason: 'UNREACHABLE', action: 'Macが起きているか確かめてください', checkedAt: 'x' }), { tone: 'attention', label: 'つながりません', action: 'Macが起きているか確かめてください。' })
  assert.deepEqual(checkBadge({ reachable: false, reason: 'UNREACHABLE' }), { tone: 'attention', label: 'つながりません', action: '' })
  assert.deepEqual(checkBadge({ reachable: false, reason: 'UNREACHABLE', checkedAt: '2026-11-11T11:00:00Z' }), { tone: 'attention', label: '11/11 20:00 につながりませんでした', action: '' })
  assert.deepEqual(checkBadge({ reachable: false, reason: 'UNREACHABLE', observedAt: '2026-11-11T11:48:00Z' }), { tone: 'attention', label: '11/11 20:48 につながりませんでした', action: '' })
  assert.deepEqual(checkBadge(null), { tone: 'muted', label: '未確認' })
})

test('card badges follow lastCheck; a press here wins; one help line on top; address closed under 詳細', async t => {
  const checked = { ...mac, terminalId: 'ok-mac', lastCheck: { reachable: true, reason: null, checkedAt: '2026-11-11T11:48:00Z' } }
  const failed = { ...mac, terminalId: 'bad-mac', lastCheck: { reachable: false, reason: 'UNREACHABLE', action: 'Macを起こしてください', checkedAt: '2026-11-11T11:00:00Z' } }
  const never = { ...mac, terminalId: 'terminal-3', lastCheck: null }
  const v = await view(t, [checked, failed, never]); await v.open()
  const card = id => v.all().find(node => node.dataset?.terminalId === id)
  const badges = id => nodes(card(id)).filter(node => /terminal-badge/.test(node.className ?? '')).map(node => [node.textContent, node.className])
  assert.deepEqual(badges('ok-mac')[0], ['11/11 20:48 につながりました', 'terminal-badge ok'])
  assert.deepEqual(badges('bad-mac')[0], ['11/11 20:00 につながりませんでした', 'terminal-badge attention'])
  assert.deepEqual(badges('terminal-3')[0], ['未確認', 'terminal-badge muted'])
  const text = node => nodes(node).map(item => item.textContent).join('|')
  assert.match(text(card('bad-mac')), /Macを起こしてください。/)
  assert.doesNotMatch(text(card('terminal-3')), /いまSSHで届くか/)
  assert.equal(v.all().filter(node => node.className === 'terminals-help').length, 1)
  const details = nodes(card('ok-mac')).find(node => node.className === 'terminal-details')
  assert.deepEqual(details.children.map(node => node.textContent), ['詳細', 'u@h'])
  assert.equal(text(card('ok-mac')).split('u@h').length, 2, 'the address appears once, inside 詳細')
  assert.match(text(card('terminal-3')), /\|Mac（u）\|/)
  assert.doesNotMatch(text(card('ok-mac')), /秘密入力/)
  assert.equal(nodes(card('ok-mac')).find(node => node.textContent === '外す').className, 'terminal-quiet')
  // The press result replaces the recorded one.
  nodes(card('ok-mac')).find(node => node.tagName === 'button' && node.textContent === '届くか確かめる').fire('click'); await settle(); await settle()
  assert.equal(badges('ok-mac')[0][1], 'terminal-badge attention')
  assert.equal(friendlyName({ terminalId: 'owner-mac' }), 'owner-mac')
})

test('terminal id from the name: lowercase ascii/digits/hyphen, 63 max, terminal-<n> without ascii, never an id already taken', () => {
  const valid = id => /^[a-z0-9][a-z0-9-]{0,62}$/.test(id)
  for (const [name, id] of [['Owner MacBook', 'owner-macbook'], ['kiteのMac', 'kite-mac'], ['  --Fox_PC--  ', 'fox-pc'], ['ＭＡＣ１', 'mac1'], ['abc', 'abc']]) assert.equal(terminalIdFromName(name), id, name)
  for (const name of ['自分', '', '!!!', '🙂']) assert.equal(terminalIdFromName(name), 'terminal-1', name)
  assert.equal(terminalIdFromName('あ', ['terminal-1', 'terminal-2']), 'terminal-3')
  assert.equal(terminalIdFromName('mac', ['mac']), 'mac-2')
  assert.equal(terminalIdFromName('mac', ['mac', 'mac-2']), 'mac-3')
  const long = terminalIdFromName(`${'a'.repeat(80)}-${'b'.repeat(10)}`)
  assert.equal(long.length, 63); assert.ok(valid(long))
  const crowded = terminalIdFromName('a'.repeat(70), ['a'.repeat(63)])
  assert.ok(valid(crowded) && crowded.length <= 63 && crowded.endsWith('-2'), crowded)
})

test('add sheet: in front of the list, header 追加 hidden, steps for the OS, check registers then checks, id from the name, name locks, 完了 closes', async t => {
  const previous = globalThis.document
  globalThis.document = { createElement: tag => new E(tag) }
  t.after(() => { globalThis.document = previous })
  const { createTerminalsView } = await import('../web/terminals.js')
  const dialog = new E('dialog'), calls = []
  let list = [{ ...mac, terminalId: 'kite-mac' }], observation = { reachable: false, reason: 'SSH_KEY_UNSET', observedAt: '2026-11-11T11:48:00Z' }
  const api = async (path, options = {}) => {
    calls.push(`${options.method ?? 'GET'} ${path}${options.body ? ` ${options.body}` : ''}`)
    if (options.method === 'PUT') { list = [...list.filter(item => item.terminalId !== path.split('/').pop()), { ...mac, terminalId: path.split('/').pop() }]; return {} }
    if (path.endsWith('/check')) return observation
    return { terminals: list }
  }
  await createTerminalsView(dialog, { api }).open()
  const body = dialog.querySelector('[data-terminals-body]'), add = dialog.querySelector('[data-terminals-add]')
  const text = node => nodes(node).map(item => item.textContent).join('|')
  const form = () => nodes(body).find(node => node.className === 'terminal-form')
  const typed = (placeholder, value) => { nodes(form()).find(node => node.placeholder === placeholder).value = value; form().fire('input') }
  const nameInput = () => nodes(form()).find(node => node.placeholder === '例：自分のMac')
  assert.ok(!add.hidden)
  add.fire('click')
  assert.ok(add.hidden)
  assert.equal(body.children[0].className, 'terminal-sheet')
  // Order: OS, the steps, address (host, user), the check button, then the name.
  const marks = ['OS', 'この機械で、先にこれを済ませてください。', '機械のアドレス', 'ユーザー名', 'つながるか確かめる', '名前']
  assert.deepEqual(nodes(form()).filter(node => marks.includes(node.textContent)).map(node => node.textContent), marks)
  assert.match(text(form()), /Macの「システム設定 > 一般 > 共有」/)
  assert.doesNotMatch(text(form()), /端末ID|ホスト/)
  assert.equal(nodes(form()).find(node => node.className === 'terminal-advanced').children[0].textContent, 'くわしい設定')
  typed('192.168.1.12', '192.168.1.5'); typed('kite', 'kite')
  assert.equal(nameInput().value, 'kiteのMac')
  typed('例：自分のMac', 'kite Mac'); typed('kite', 'kite2') // a typed name is not overwritten by the suggestion
  assert.equal(nameInput().value, 'kite Mac')
  form().fire('submit'); await settle(); await settle()
  // kite-mac is taken, so the new one is kite-mac-2; the PUT body is unchanged, then the check.
  assert.deepEqual(calls.filter(call => /^(PUT|POST)/.test(call)).map(call => call.split(' ').slice(0, 2).join(' ')), ['PUT /api/terminals/kite-mac-2', 'POST /api/terminals/kite-mac-2/check'])
  assert.deepEqual(JSON.parse(calls.find(call => call.startsWith('PUT')).split(' ').slice(2).join(' ')), { host: '192.168.1.5', user: 'kite2', port: 22, os: 'macos', accountOwner: 'owner' })
  // Result next to the button; a new terminal's first check asks for the key, which the card sets: 完了 is the real next step.
  assert.match(text(form()), /登録しました。まだSSH鍵がありません。/)
  assert.ok(nodes(form()).some(node => node.tagName === 'button' && node.textContent === '完了'))
  assert.equal(nameInput().disabled, true)
  nodes(form()).find(node => node.tagName === 'button' && node.textContent === '完了').fire('click')
  assert.equal(form(), undefined); assert.ok(!add.hidden)
  assert.ok(nodes(body).some(node => node.dataset?.terminalId === 'kite-mac-2'))
  // Not reachable for another reason: the sheet stays with the sentence and a retry; the registration is kept.
  list = [{ ...mac, terminalId: 'kite-mac' }]; observation = { reachable: false, reason: 'UNREACHABLE', observedAt: '2026-11-11T11:48:00Z' }
  add.fire('click'); typed('192.168.1.12', '10.0.0.9'); typed('kite', 'kite'); typed('例：自分のMac', '書斎'); form().fire('submit'); await settle(); await settle()
  assert.ok(calls.some(call => call.startsWith('PUT /api/terminals/terminal-1 ')))
  assert.match(text(form()), /11\/11 20:48 につながりませんでした\|.*登録はできています/)
  assert.ok(nodes(form()).some(node => node.tagName === 'button' && node.textContent === 'もう一度確かめる'))
  assert.ok(nodes(form()).some(node => node.tagName === 'button' && node.textContent === '閉じる'))
})
