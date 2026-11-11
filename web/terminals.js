import { openSecretInput } from './secret-input.js?v=__ASSET_VERSION__'

// Terminals (F-SEAT-HOST P2). The server owns registry, trust and secrets; this view only renders projections and calls the
// Owner routes once per tap. No key value, op:// reference or key handle ever passes through here.
const TRUST = /^(HOST_TRUST_|HOST_KEY_|TARGET_MISMATCH$)/
const CREDENTIAL = /^CREDENTIAL_/
// terminals README "Windows and Linux terminals": the Owner declares os; a record without it is a Mac (older registry).
const OS = { macos: { name: 'Mac', badge: 'macOS' }, linux: { name: 'Linux', badge: 'Linux' }, windows: { name: 'Windows', badge: 'Windows' } }
export const osOf = terminal => OS[terminal?.os] ? terminal.os : 'macos'
const osName = os => OS[os]?.name ?? OS.macos.name
// Precondition for SSH on each OS (self-service step 1).
export const REMOTE_LOGIN = {
  macos: 'Macの「システム設定 > 一般 > 共有」で「リモートログイン」をオンにしてください。',
  windows: 'Windowsの「設定 > システム > オプション機能」で「OpenSSH サーバー」を追加し、サービスの「OpenSSH SSH Server」を開始して、スタートアップの種類を「自動」にしてください。',
  linux: 'Linuxに openssh-server を入れて、sudo systemctl enable --now ssh で sshd を開始してください。',
}
const REFUSED = { macos: 'Macのリモートログインがオンか確かめてください。', windows: 'WindowsでOpenSSH サーバー（sshd）が動いているか確かめてください。', linux: 'Linuxで sshd が動いているか確かめてください。' }

// One observation from POST /check -> plain words. Raw codes stay in the title only.
export function terminalStatus(observation, os = 'macos') {
  if (!observation) return { tone: 'muted', label: '未確認', help: '「届くか確かめる」で、いまSSHで届くかを一度だけ確かめます。' }
  if (observation.reachable === true) return { tone: 'ok', label: 'つながります', help: '' }
  const reason = typeof observation.reason === 'string' ? observation.reason : ''
  if (reason === 'SSH_KEY_UNSET') return { tone: 'attention', label: 'SSH鍵が未設定', help: 'SSH鍵を設定すると、この端末で席を動かせます。', reason }
  // Reasons are evidence, not diagnoses: offer the likely fix without asserting the cause (terminals README step 4).
  const action = typeof observation.action === 'string' && observation.action.trim() ? observation.action : ''
  if (reason === 'AUTH_FAILED') return { tone: 'danger', label: '鍵が通りません', help: `この鍵がまだ${osName(os)}に入っていないかもしれません。`, reason, authorize: true }
  // terminals' action names the OS and its step; the Web words are for a body without it.
  if (reason === 'CONNECTION_REFUSED') return { tone: 'attention', label: '届きません', help: action || (REFUSED[os] ?? REFUSED.macos), reason }
  if (reason === 'UNREACHABLE') return { tone: 'attention', label: '届きません', help: action || `${osName(os)}が起きていて、同じネットワークにあるか確かめてください。`, reason }
  if (CREDENTIAL.test(reason)) return { tone: 'danger', label: '鍵が使えません', help: 'SSH鍵が端末に受け付けられませんでした。鍵を入れ直してください。', reason }
  if (TRUST.test(reason)) return { tone: 'danger', label: 'ホスト鍵の確認が必要', help: 'この端末をまだ信用していません。端末で指紋を確かめて、下に入れてください。', reason, trust: true }
  if (reason === 'REMOTE_AITERM_TOO_OLD') return { tone: 'attention', label: '端末のAitermが古い', help: '端末のAitermを新しくすると届くようになります。', reason }
  if (reason === 'TERMINAL_NOT_FOUND') return { tone: 'danger', label: '登録がありません', help: '一覧を更新してください。', reason }
  return { tone: 'attention', label: '届きません', help: action || '端末が眠っているか、ネットワークにつながっていません。起きれば、届いていない依頼から自動で再開します。', reason }
}

// Bot DTO seatLaunch (Kiro #892) -> one plain line, or null when the member has no not-started remote launch.
export function seatLaunchText(seatLaunch) {
  if (!seatLaunch || typeof seatLaunch !== 'object') return null
  const action = typeof seatLaunch.action === 'string' ? seatLaunch.action.trim() : ''
  const code = typeof seatLaunch.code === 'string' ? seatLaunch.code.trim() : ''
  return action || code ? `端末で起動できません：${action || code}` : '端末で起動できません。'
}

// members C1: '' or an absolute POSIX path without empty / . / .. segments and no trailing slash.
// windows: drive-absolute X:\... with \ only, no : after the drive (members #966 validProjectRoot), ≤ 4096 bytes like POSIX.
export function projectRootProblem(path, os = 'macos') {
  if (path === '') return ''
  if (os === 'windows') {
    if (!/^[A-Za-z]:\\/u.test(path)) return 'フォルダは C:\\ のようにドライブから始まるパスで入れてください（例 C:\\Users\\kite\\work\\app）。'
    if (/[/:]/u.test(path.slice(2))) return 'Windowsのフォルダは「\\」で区切ってください。「/」と、ドライブのあとの「:」は使えません。'
    if (path.includes('\0') || new TextEncoder().encode(path).length > 4096) return 'フォルダのパスが長すぎるか、使えない文字を含んでいます。'
    if (path.length > 3 && path.slice(3).split('\\').some(part => part === '' || part === '.' || part === '..')) return 'フォルダのパスに、空の区切り・「.」・「..」・最後の「\\」は使えません。'
    return ''
  }
  if (!path.startsWith('/')) return 'フォルダは / で始まる絶対パスで入れてください（例 /Users/kite/work/app）。'
  if (path.includes('\0') || new TextEncoder().encode(path).length > 4096) return 'フォルダのパスが長すぎるか、使えない文字を含んでいます。'
  if (path !== '/' && path.split('/').slice(1).some(part => part === '' || part === '.' || part === '..')) return 'フォルダのパスに、空の区切り・「.」・「..」・最後の「/」は使えません。'
  return ''
}

// Member body part: only fields that differ from the saved member, so older bodies never receive them.
export function remoteBindingBody(saved, terminalId, projectRoot, os = 'macos') {
  const root = terminalId ? projectRoot.trim() : ''
  if (Boolean(terminalId) !== Boolean(root)) return { error: terminalId ? '端末で動かすときは、フォルダも入れてください。' : '' }
  const problem = projectRootProblem(root, os)
  if (problem) return { error: problem }
  if ((saved?.terminalId ?? '') === terminalId && (saved?.projectRoot ?? '') === root) return { body: {} }
  return { body: { terminalId, projectRoot: root } }
}

// members S5 default folder per os; same slug and roots as bot-registry memberFolderSlug / defaultProjectRoot (#966).
export function memberFolder(user, name, os = 'macos') {
  const slug = String(name ?? '').trim().replace(/[/:\\\0]/gu, '-')
  const leaf = slug && slug !== '.' && slug !== '..' ? slug : 'member'
  if (os === 'windows') return `C:\\Users\\${user}\\BellTeam\\${leaf}`
  return `${os === 'linux' ? '/home' : '/Users'}/${user}/BellTeam/${leaf}`
}

// members S5 save refusals carry only the code (#859), so the Web words them (reference: terminals FOLDER_ACTIONS)
// and names the folder from the form. null = not a folder refusal.
const FOLDER_REFUSALS = {
  FOLDER_MISSING: 'このフォルダは端末にありません。作るか、あるフォルダを選んでください',
  FOLDER_NOT_DIRECTORY: 'これはファイルです。フォルダを選んでください',
  FOLDER_NOT_WRITABLE: 'この端末のユーザーが書き込めるフォルダを選んでください',
  // macOS only (Full Disk Access); other OSes never send this code.
  FOLDER_NOT_PERMITTED: 'Macがこのフォルダを開かせてくれません。デスクトップ・書類・ダウンロードの外を選ぶか、リモートログインの「リモートユーザにフルディスクアクセスを許可」をオンにしてください',
}
export function folderRefusal(error, folder) {
  if (error?.code === 'TERMINAL_NOT_FOUND') return 'この端末は登録されていません。'
  if (!/^FOLDER_/u.test(error?.code ?? '')) return null
  return `${FOLDER_REFUSALS[error.code] ?? 'このフォルダは使えません'}（${folder}）。`
}
export const FOLDER_UNCHECKED = '端末につながらなかったので、フォルダはまだ確かめていません。席を起こす時にもう一度確かめます。'
// Connection reasons (terminals S6 screen rule 3); any other reason means the terminal was reached (e.g. COMMAND_FAILED, rabbit 2026-11-11).
export const unreachableReason = reason => /^(TERMINAL_UNAVAILABLE$|TARGET_MISMATCH$|UNREACHABLE$|AUTH_FAILED$|SEAT_FORWARD_UNAVAILABLE$|CONNECTION_|CREDENTIAL_|HOST_TRUST_|HOST_KEY_)/u.test(reason ?? '')
export const sentence = text => { const value = typeof text === 'string' ? text.trim() : ''; return value && !/[。！？]$/u.test(value) ? `${value}。` : value }
// Saved unchecked (members S5 folderCheck): a reached terminal's failure shows its action instead of 「つながらなかった」.
export function folderUncheckedText(check) {
  if (!check?.reason || unreachableReason(check.reason)) return FOLDER_UNCHECKED
  return `${sentence(check.action)}フォルダはまだ確かめていません。席を起こす時にもう一度確かめます。`
}

// GET /api/terminals with the tolerance every caller shares: older bodies (404) and an unmounted core (503).
export async function readTerminals(api, options) {
  try { return { terminals: (await api('/api/terminals', options)).terminals ?? [] } }
  catch (error) {
    if (error?.name === 'AbortError') throw error
    return { error, unsupported: error?.status === 404 || error?.status === 405,
      message: error?.status === 404 || error?.status === 405 ? '端末は、本体を「Update」で更新すると使えます。'
        : error?.code === 'TERMINALS_UNAVAILABLE' ? '端末の機能が、いま本体で動いていません。'
        : '端末の一覧を取得できませんでした。' }
  }
}

const ERRORS = {
  INVALID_TERMINAL: '入力の形が違います。下の詳細にある欄を直してください。',
  TERMINAL_EXISTS: '同じIDの端末がもうあります。',
  TERMINAL_NOT_FOUND: 'その端末は登録されていません。一覧を更新してください。',
  HOST_KEY_FINGERPRINT_MISMATCH: '指紋が端末のものと一致しません。端末でもう一度確かめてください。',
  CREDENTIAL_UNAVAILABLE: 'SSH鍵がまだ使えません。先に鍵を設定してください。',
  TERMINALS_UNAVAILABLE: '端末の機能が、いま本体で動いていません。',
  HOST_TRUST_MISSING: '先にこの端末を確かめてください。',
  SSH_KEY_UNSET: '先にSSH鍵を設定してください。',
}
// keyAuthorization.outcome -> plain words; success runs the check again instead.
const AUTHORIZE_TEXT = { PASSWORD_REJECTED: 'パスワードが違いました。', AUTHORIZATION_UNCONFIRMED: '入れられたか確かめられませんでした。もう一度お試しください。' }
export const authorizeText = (outcome, os = 'macos') => outcome === 'PASSWORD_AUTH_DISABLED' ? `この${osName(os)}はパスワードでのログインを受け付けていません。` : AUTHORIZE_TEXT[outcome] ?? 'もう一度お試しください。'
const AUTHORIZE_WAIT_MS = 1000
// The SHA256 token out of whatever the Owner pasted: the bare fingerprint or the whole `ssh-keygen -lf` line (256 SHA256:… user@host (ED25519)).
export const fingerprintOf = text => /(?:^|\s)(SHA256:[A-Za-z0-9+/]{43})(?=\s|$)/u.exec(String(text ?? ''))?.[1] ?? null
const errorText = error => ERRORS[error?.code] ?? '結果を確認できませんでした。一覧を更新して確かめてください。'
const keyLabel = { ssh: 'SSH鍵', sudo: 'sudo鍵' }
// Source of each purpose's key. The native (terminal-held) capability is SSH only (usage C5), so the shared keySource never describes sudo.
export const keySourceOf = (terminal, purpose) => purpose === 'ssh' ? terminal?.sshKeySource ?? terminal?.keySource : terminal?.sudoKeySource ?? 'secret'
const sourceLabel = { 'terminal-native': '端末の鍵', secret: '秘密入力' }

const element = (tag, text, className) => {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  if (className) node.className = className
  return node
}
const badge = (text, tone, title = '') => { const node = element('span', text, `terminal-badge ${tone}`); if (title) node.title = title; return node }
const button = (label, run, className) => { const node = element('button', label, className); node.type = 'button'; node.addEventListener('click', run); return node }

export function createTerminalsView(dialog, { api }) {
  const body = dialog.querySelector('[data-terminals-body]')
  const notice = dialog.querySelector('[data-terminals-notice]')
  const addButton = dialog.querySelector('[data-terminals-add]')
  const refreshButton = dialog.querySelector('[data-terminals-refresh]')
  let opened = null

  // An older body (404/405) is an expected state: a neutral notice, not an error.
  const say = (text, detail = '', tone = 'error') => {
    notice.replaceChildren()
    notice.className = tone === 'info' ? 'terminals-info' : 'form-error'
    if (text && tone === 'info') { const icon = element('span', '', 'terminals-info-icon'); icon.setAttribute('aria-hidden', 'true'); notice.append(icon) }
    if (text) notice.append(element('span', text))
    if (detail) { const more = element('details'); more.append(element('summary', '詳細'), element('code', detail)); notice.append(more) }
  }
  addButton.addEventListener('click', () => { if (opened && !opened.unsupported) { opened.editing = 'new'; opened.draft = null; render() } })
  refreshButton.addEventListener('click', () => { void load() })
  dialog.addEventListener('close', () => { opened = null })

  async function open() {
    opened = { terminals: [], observations: new Map(), busy: new Set(), keyRoute: true, editing: null, unsupported: false, trustDraft: new Map(), authorizing: new Map(), authorizeRequest: new Map(), errors: new Map() }
    say('')
    body.replaceChildren(element('p', '読み込んでいます…', 'field-help'))
    if (!dialog.open) dialog.showModal()
    await load()
  }

  async function load() {
    const current = opened
    if (!current) return
    refreshButton.disabled = true
    const result = await readTerminals(api)
    if (opened !== current) return
    refreshButton.disabled = false
    current.unsupported = Boolean(result.error)
    addButton.disabled = current.unsupported
    refreshButton.hidden = Boolean(result.unsupported)
    if (result.error) { current.terminals = []; say(result.message, result.unsupported ? '' : result.error.code ?? result.error.message, result.unsupported ? 'info' : 'error') }
    else { current.terminals = result.terminals; say('') }
    render()
  }

  // One request per tap; the reply is applied only to the same open dialog. Its failure is kept under the tap's key and shown next to
  // that button (errorNode), not in the dialog's top notice, which is off-screen while the Owner is scrolled to a card.
  async function run(key, request, onDone) {
    const current = opened
    if (!current || current.busy.has(key)) return
    current.busy.add(key); current.errors.delete(key); render()
    try { const result = await request(); if (opened === current) await onDone?.(result) }
    catch (error) { if (opened === current) current.errors.set(key, { text: errorText(error), detail: error?.message && error.message !== error.code ? error.message : error?.code ?? '' }) }
    finally { if (opened === current) { current.busy.delete(key); render() } }
  }
  const fail = (key, text) => { opened.errors.set(key, { text, detail: '' }); render() }
  function errorNode(key) {
    const error = opened.errors.get(key)
    if (!error) return []
    const node = element('div', undefined, 'form-error terminal-error'); node.setAttribute('role', 'alert')
    node.append(element('span', error.text))
    if (error.detail) { const more = element('details'); more.append(element('summary', '詳細'), element('code', error.detail)); node.append(more) }
    return [node]
  }

  // A check adopts first-use trust on the body; a card still without hostTrust reads the list again to show it.
  const check = id => run(`check:${id}`, () => api(`/api/terminals/${id}/check`, { method: 'POST' }), async observation => {
    opened.observations.set(id, observation); say('')
    if (!opened.terminals.find(item => item.terminalId === id)?.hostTrust) await load()
  })
  // done() runs only after a successful save, in the same open dialog; each caller decides whether its intent is still current.
  // key = the tapped control (form:<id|new> / trust:<id>), so busy state and the failure stay with that button.
  const save = (key, id, fields, done) => run(key, () => api(`/api/terminals/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fields) }),
    async () => { const current = opened; current.observations.delete(id); say(''); await load(); if (opened === current) done() })
  const remove = terminal => {
    if (!window.confirm(`端末「${terminal.terminalId}」の登録を消しますか？\nこの端末を使うメンバーの設定と、届いていない依頼は残ります。`)) return
    return run(`remove:${terminal.terminalId}`, () => api(`/api/terminals/${terminal.terminalId}`, { method: 'DELETE' }), async () => { opened.observations.delete(terminal.terminalId); await load() })
  }
  const setKey = (terminal, purpose) => run(`key:${terminal.terminalId}`, async () => {
    try { return await api(`/api/terminals/${terminal.terminalId}/keys/${purpose}`, { method: 'POST' }) }
    catch (error) { if (error?.status === 404 || error?.status === 405) return { unsupported: true }; throw error }
  }, result => {
    if (result.unsupported) { opened.keyRoute = false; fail(`key:${terminal.terminalId}`, 'この本体では、まだ画面から鍵を設定できません。'); return }
    const request = result.secretRequest
    if (!request?.id) { fail(`key:${terminal.terminalId}`, '鍵の入力欄を開けませんでした。一覧を更新して確かめてください。'); return }
    const current = opened
    openSecretInput({ message: `端末「${terminal.terminalId}」の${keyLabel[purpose]}です。値はこの入力欄だけに入れてください。`, ...request }, api, () => { if (opened === current) void load() })
  })
  // Self-service step 4: the terminal's login password goes only into Mika's card; this view waits for the outcome.
  const authorizeKey = id => run(`authorize:${id}`, () => api(`/api/terminals/${id}/keys/ssh/authorize`, { method: 'POST' }), result => {
    const request = result.secretRequest
    if (!request?.id) { fail(`authorize:${id}`, '入力欄を開けませんでした。一覧を更新して確かめてください。'); return }
    const current = opened
    current.authorizing.delete(id); current.authorizeRequest.set(id, request.id)
    // onComplete also fires for 入力を断る; only a submitted password has an outcome to wait for.
    openSecretInput(request, api, done => { if (opened === current && done?.status === 'submitted') void awaitAuthorization(id, request.id) })
  })
  // Pending stays true until the outcome is recorded (#858); the requestId match also ignores an older outcome.
  // Keeps observing the submitted request while it can still finish. Exits: its outcome, or the Owner closing the dialog /
  // starting a newer request for this terminal. A failed read is retried on the next tick, never a give-up.
  async function awaitAuthorization(id, requestId) {
    const current = opened
    const observing = () => opened === current && current.authorizeRequest.get(id) === requestId
    const os = osOf(current.terminals.find(item => item.terminalId === id))
    current.authorizing.set(id, { text: `${osName(os)}に鍵を入れています…`, waiting: true }); render()
    let outcome = null
    for (let read = 0; !outcome; read++) {
      if (read) await new Promise(resolve => setTimeout(resolve, AUTHORIZE_WAIT_MS))
      if (!observing()) return
      const terminal = await api(`/api/terminals/${id}`).catch(() => null)
      if (!observing()) return
      if (terminal?.keyAuthorizationPending !== true && terminal?.keyAuthorization?.requestId === requestId) outcome = terminal.keyAuthorization.outcome
    }
    if (outcome === 'AUTHORIZED' || outcome === 'ALREADY_AUTHORIZED') { current.authorizing.delete(id); render(); await check(id); return }
    current.authorizing.set(id, { text: authorizeText(outcome, os), retry: outcome === 'PASSWORD_REJECTED' }); render()
  }
  const unbindKey = (terminal, purpose) => {
    if (!window.confirm(`端末「${terminal.terminalId}」の${keyLabel[purpose]}を外しますか？`)) return
    return run(`key:${terminal.terminalId}`, () => api(`/api/terminals/${terminal.terminalId}/keys/${purpose}`, { method: 'DELETE' }), () => load())
  }

  function keyRow(terminal, purpose) {
    const configured = terminal[`${purpose}KeyConfigured`]
    const row = element('div', undefined, 'terminal-key')
    row.append(element('span', keyLabel[purpose], 'terminal-key-name'))
    const source = keySourceOf(terminal, purpose)
    row.append(configured === true ? badge(sourceLabel[source] ? `設定済み · ${sourceLabel[source]}` : '設定済み', 'ok')
      : configured === false ? badge(purpose === 'ssh' ? '未設定' : 'なし', purpose === 'ssh' ? 'attention' : 'muted') : badge('未確認', 'muted'))
    const busy = opened.busy.has(`key:${terminal.terminalId}`)
    if (opened.keyRoute) {
      const setter = button(configured ? '入れ直す' : '設定する', () => { void setKey(terminal, purpose) })
      setter.disabled = busy
      row.append(setter)
      if (configured === true && source !== 'terminal-native') { const unbind = button('外す', () => { void unbindKey(terminal, purpose) }, 'text-button'); unbind.disabled = busy; row.append(unbind) }
    }
    return row
  }

  function form(terminal = null) {
    const node = element('form', undefined, 'terminal-form')
    const field = (label, input, help = '') => { const wrap = element('label', undefined, 'field'); wrap.append(element('span', label), input); if (help) wrap.append(element('small', help, 'field-help')); return wrap }
    const input = (value, attributes) => { const node = element('input'); Object.assign(node, attributes); node.value = value ?? ''; return node }
    const draft = opened.draft ?? (opened.draft = { terminalId: terminal?.terminalId ?? '', host: terminal?.host ?? '', user: terminal?.user ?? '', port: String(terminal?.port ?? 22), accountOwner: terminal?.accountOwner ?? 'owner', os: osOf(terminal), revision: 0 })
    const id = input(draft.terminalId, { required: true, pattern: '[a-z0-9][a-z0-9\\-]{0,62}', maxLength: 63, placeholder: 'owner-macbook', disabled: Boolean(terminal), autocapitalize: 'none', spellcheck: false })
    const host = input(draft.host, { required: true, maxLength: 253, placeholder: '192.168.1.12', autocapitalize: 'none', spellcheck: false })
    const user = input(draft.user, { required: true, maxLength: 64, placeholder: 'kite', autocapitalize: 'none', spellcheck: false })
    const port = input(draft.port, { type: 'number', min: 1, max: 65535, required: true, inputMode: 'numeric' })
    const owner = element('select')
    for (const [value, label] of [['owner', '自分の機械（自分のClaudeアカウントで動かす）'], ['terminal-owner', 'ほかの人の機械（その機械のClaudeログインで動かす）']]) { const option = element('option', label); option.value = value; owner.append(option) }
    owner.value = draft.accountOwner
    const os = element('select')
    for (const [value, { badge: label }] of Object.entries(OS)) { const option = element('option', label); option.value = value; os.append(option) }
    os.value = draft.os
    // Precondition first: SSH needs the OS's SSH server on (self-service step 1); follows the OS choice.
    const precondition = element('p', REMOTE_LOGIN[draft.os], 'field-help')
    // Typed values survive re-renders (busy state, a failed save) until the form is closed.
    node.addEventListener('input', () => { Object.assign(draft, { terminalId: id.value, host: host.value, user: user.value, port: port.value, accountOwner: owner.value, os: os.value, revision: draft.revision + 1 }); precondition.textContent = REMOTE_LOGIN[os.value] })
    node.append(element('h4', terminal ? `「${terminal.terminalId}」を編集` : '端末を追加'))
    node.append(field('OS', os), precondition,
      field('端末ID', id, '英小文字・数字・ハイフン。あとから変えられません。'), field('ホスト', host, 'IPアドレスかホスト名だけ。user@ やポートは入れません。'),
      field('ユーザー名', user), field('SSHのポート', port), field('機械の持ち主', owner), element('p', '鍵は、登録したあとに「設定する」から入れます。', 'field-help'))
    const actions = element('div', undefined, 'terminal-actions')
    const key = `form:${terminal?.terminalId ?? 'new'}`
    const submit = element('button', terminal ? '保存' : '登録', 'primary'); submit.type = 'submit'
    submit.disabled = opened.busy.has(key)
    actions.append(submit, button('やめる', () => { opened.editing = null; opened.draft = null; opened.errors.delete(key); render() }, 'text-button'))
    node.append(actions, ...errorNode(key))
    node.addEventListener('submit', event => {
      event.preventDefault()
      const terminalId = terminal?.terminalId ?? id.value.trim()
      const revision = draft.revision
      // Close only the form this save came from, unchanged since the tap (bot-editor pattern); newer add/edit/input stays.
      void save(key, terminalId, { host: host.value.trim(), user: user.value.trim(), port: Number(port.value), os: os.value, accountOwner: owner.value }, () => {
        if (opened.draft === draft && draft.revision === revision) { opened.editing = null; opened.draft = null }
        else say('保存しました。そのあとに変えた入力は残しています。')
      })
    })
    return node
  }

  function trustForm(terminal, os) {
    const node = element('form', undefined, 'terminal-trust')
    const input = element('input'); input.required = true; input.placeholder = 'SHA256:…'; input.autocapitalize = 'none'; input.spellcheck = false
    input.value = opened.trustDraft.get(terminal.terminalId) ?? ''
    input.addEventListener('input', () => opened.trustDraft.set(terminal.terminalId, input.value))
    const wrap = element('label', undefined, 'field'); wrap.append(element('span', 'ホスト鍵の指紋'), input,
      element('small', `${os === 'windows' ? '端末のPowerShellで ssh-keygen -lf C:\\ProgramData\\ssh\\ssh_host_ed25519_key.pub' : '端末のターミナルで ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub'} を実行し、表示された SHA256: から始まる指紋を入れます。推測では入れないでください。`, 'field-help'))
    const key = `trust:${terminal.terminalId}`
    const busy = opened.busy.has(key)
    const submit = element('button', busy ? '確かめています…' : 'この指紋を信用する', 'primary'); submit.type = 'submit'
    submit.disabled = busy
    node.append(wrap, submit, ...errorNode(key))
    node.addEventListener('submit', event => {
      event.preventDefault()
      const typed = input.value
      const fingerprint = fingerprintOf(typed)
      if (!fingerprint) { fail(key, '指紋が見つかりません。SHA256: のあとに43文字が続く形です。ssh-keygen の表示をそのまま貼ってもかまいません。'); return }
      void save(key, terminal.terminalId, { confirmHostKey: fingerprint }, () => { if (opened.trustDraft.get(terminal.terminalId) === typed) opened.trustDraft.delete(terminal.terminalId) })
    })
    return node
  }

  function card(terminal) {
    const id = terminal.terminalId
    const node = element('section', undefined, 'terminal-card')
    node.dataset.terminalId = id
    const os = osOf(terminal)
    const status = terminalStatus(opened.observations.get(id), os)
    const head = element('div', undefined, 'terminal-head')
    const title = element('div', undefined, 'terminal-title')
    title.append(element('strong', id), element('span', `${terminal.user}@${terminal.host}${terminal.port && terminal.port !== 22 ? `:${terminal.port}` : ''}`, 'terminal-target'))
    head.append(element('span', undefined, 'terminal-icon'), title, badge(status.label, status.tone, status.reason ?? ''))
    const meta = element('div', undefined, 'terminal-meta')
    meta.append(badge(OS[os].badge, 'muted'), badge(terminal.accountOwner === 'terminal-owner' ? 'ほかの人の機械' : '自分の機械', 'muted'),
      terminal.hostTrust ? badge('ホスト鍵 登録済み', 'ok') : badge('ホスト鍵 未登録', 'attention'))
    node.append(head, meta)
    // First use is trusted by the body like ssh accept-new (terminals #1000, Owner ruling 2026-11-11): the sheet is only for a check
    // that reports a trust reason (a changed key, or an older body that still needs the Owner's fingerprint).
    const needsTrust = Boolean(status.trust)
    // Only a Mac runs the BellTeam app that confirms the host key by itself (S2).
    if (needsTrust && os === 'macos') node.append(element('p', 'このMacでBellTeamアプリを開くと、自動で確かめます。', 'field-help'))
    if (status.help && !status.trust) node.append(element('p', status.help, 'field-help'))
    const authorizing = opened.authorizing.get(id)
    if (authorizing) node.append(element('p', authorizing.text, 'field-help'))
    if ((status.authorize && !authorizing) || authorizing?.retry) {
      const authorize = button(`この${osName(os)}にこの鍵を入れる`, () => { void authorizeKey(id) }, 'primary')
      authorize.disabled = opened.busy.has(`authorize:${id}`)
      const row = element('div', undefined, 'terminal-actions'); row.append(authorize); node.append(row, ...errorNode(`authorize:${id}`))
    }
    const observed = opened.observations.get(id)?.observedAt
    if (observed) node.append(element('p', `確かめた時刻 ${new Date(observed).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`, 'terminal-time'))
    const claude = terminal.maintenance
    if (claude?.after || claude?.before) node.append(element('p', `Claude Code ${claude.after ?? claude.before}${claude.outcome === 'updated' ? '（最新に更新しました）' : claude.outcome === 'failed' ? '（更新できませんでした。入っている版で動きます）' : ''}`, 'terminal-time'))
    // windows has no sudo key (terminals refuses it as INVALID_TERMINAL).
    node.append(keyRow(terminal, 'ssh'))
    if (os !== 'windows') node.append(keyRow(terminal, 'sudo'))
    node.append(...errorNode(`key:${id}`))
    // Manual sheet (a Mac without the app; the only way on Windows/Linux); PUT confirmHostKey uses the SSH key's binding, so the key comes first.
    if (needsTrust) {
      const manual = terminal.sshKeyConfigured === false
        ? element('p', '先にSSH鍵を設定してください。そのあと、ホスト鍵の指紋を確かめます。', 'field-help') : trustForm(terminal, os)
      if (os === 'macos') {
        const other = element('details', undefined, 'terminal-other')
        other.append(element('summary', 'ほかの方法'), manual)
        if (opened.trustDraft.get(id)) other.open = true
        node.append(other)
      } else node.append(manual)
    }
    if (opened.editing === id) node.append(form(terminal))
    const actions = element('div', undefined, 'terminal-actions')
    const checkButton = button(opened.busy.has(`check:${id}`) ? '確かめています…' : '届くか確かめる', () => { void check(id) }, 'primary')
    checkButton.disabled = opened.busy.has(`check:${id}`)
    const removeButton = button('登録を消す', () => { void remove(terminal) }, 'text-button danger')
    removeButton.disabled = opened.busy.has(`remove:${id}`)
    actions.append(checkButton, button('編集', () => { opened.editing = id; opened.draft = null; render() }), removeButton)
    node.append(actions, ...errorNode(`check:${id}`), ...errorNode(`remove:${id}`))
    return node
  }

  function render() {
    if (!opened) return
    body.replaceChildren()
    if (opened.editing === 'new') body.append(form())
    if (!opened.unsupported && !opened.terminals.length && opened.editing !== 'new') body.append(element('p', 'まだ端末はありません。「追加」から、メンバーを動かす機械を登録できます。', 'terminal-empty'))
    for (const terminal of opened.terminals) body.append(card(terminal))
  }

  return { open }
}
