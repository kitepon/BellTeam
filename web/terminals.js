import { openSecretInput } from './secret-input.js?v=__ASSET_VERSION__'

// Terminals (F-SEAT-HOST P2). The server owns registry, trust and secrets; this view only renders projections and calls the
// Owner routes once per tap. No key value, op:// reference or key handle ever passes through here.
const TRUST = /^(HOST_TRUST_|HOST_KEY_|TARGET_MISMATCH$)/
const CREDENTIAL = /^(CREDENTIAL_|AUTH_FAILED$)/

// One observation from POST /check -> plain words. Raw codes stay in the title only.
export function terminalStatus(observation) {
  if (!observation) return { tone: 'muted', label: '未確認', help: '「届くか確かめる」で、いまSSHで届くかを一度だけ確かめます。' }
  if (observation.reachable === true) return { tone: 'ok', label: 'つながります', help: '' }
  const reason = typeof observation.reason === 'string' ? observation.reason : ''
  if (reason === 'SSH_KEY_UNSET') return { tone: 'attention', label: 'SSH鍵が未設定', help: 'SSH鍵を設定すると、この端末で席を動かせます。', reason }
  if (CREDENTIAL.test(reason)) return { tone: 'danger', label: '鍵が使えません', help: 'SSH鍵が端末に受け付けられませんでした。鍵を入れ直してください。', reason }
  if (TRUST.test(reason)) return { tone: 'danger', label: 'ホスト鍵の確認が必要', help: 'この端末をまだ信用していません。端末で指紋を確かめて、下に入れてください。', reason, trust: true }
  if (reason === 'REMOTE_AITERM_TOO_OLD') return { tone: 'attention', label: '端末のAitermが古い', help: '端末のAitermを新しくすると届くようになります。', reason }
  if (reason === 'TERMINAL_NOT_FOUND') return { tone: 'danger', label: '登録がありません', help: '一覧を更新してください。', reason }
  return { tone: 'attention', label: '届きません', help: '端末が眠っているか、ネットワークにつながっていません。起きれば、届いていない依頼から自動で再開します。', reason }
}

// members C1: '' or an absolute POSIX path without empty / . / .. segments and no trailing slash.
export function projectRootProblem(path) {
  if (path === '') return ''
  if (!path.startsWith('/')) return 'フォルダは / で始まる絶対パスで入れてください（例 /Users/kite/work/app）。'
  if (path.includes('\0') || new TextEncoder().encode(path).length > 4096) return 'フォルダのパスが長すぎるか、使えない文字を含んでいます。'
  if (path !== '/' && path.split('/').slice(1).some(part => part === '' || part === '.' || part === '..')) return 'フォルダのパスに、空の区切り・「.」・「..」・最後の「/」は使えません。'
  return ''
}

// Member body part: only fields that differ from the saved member, so older bodies never receive them.
export function remoteBindingBody(saved, terminalId, projectRoot) {
  const root = terminalId ? projectRoot.trim() : ''
  if (Boolean(terminalId) !== Boolean(root)) return { error: terminalId ? '端末で動かすときは、フォルダも入れてください。' : '' }
  const problem = projectRootProblem(root)
  if (problem) return { error: problem }
  if ((saved?.terminalId ?? '') === terminalId && (saved?.projectRoot ?? '') === root) return { body: {} }
  return { body: { terminalId, projectRoot: root } }
}

// GET /api/terminals with the tolerance every caller shares: older bodies (404) and an unmounted core (503).
export async function readTerminals(api, options) {
  try { return { terminals: (await api('/api/terminals', options)).terminals ?? [] } }
  catch (error) {
    if (error?.name === 'AbortError') throw error
    return { error, unsupported: error?.status === 404 || error?.status === 405,
      message: error?.status === 404 || error?.status === 405 ? 'この本体は、まだ端末に対応していません。'
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
}
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

  const say = (text, detail = '') => {
    notice.replaceChildren()
    if (text) notice.append(element('span', text))
    if (detail) { const more = element('details'); more.append(element('summary', '詳細'), element('code', detail)); notice.append(more) }
  }
  addButton.addEventListener('click', () => { if (opened && !opened.unsupported) { opened.editing = 'new'; opened.draft = null; render() } })
  refreshButton.addEventListener('click', () => { void load() })
  dialog.addEventListener('close', () => { opened = null })

  async function open() {
    opened = { terminals: [], observations: new Map(), busy: new Set(), keyRoute: true, editing: null, unsupported: false, trustDraft: new Map() }
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
    if (result.error) { current.terminals = []; say(result.message, result.unsupported ? '' : result.error.code ?? result.error.message) }
    else { current.terminals = result.terminals; say('') }
    render()
  }

  // One request per tap; the reply is applied only to the same open dialog.
  async function run(key, request, onDone) {
    const current = opened
    if (!current || current.busy.has(key)) return
    current.busy.add(key); render()
    try { const result = await request(); if (opened === current) await onDone?.(result) }
    catch (error) { if (opened === current) say(errorText(error), error?.message && error.message !== error.code ? error.message : error?.code ?? '') }
    finally { if (opened === current) { current.busy.delete(key); render() } }
  }

  const check = id => run(`check:${id}`, () => api(`/api/terminals/${id}/check`, { method: 'POST' }), observation => { opened.observations.set(id, observation); say('') })
  // done() runs only after a successful save, in the same open dialog; each caller decides whether its intent is still current.
  const save = (id, fields, done) => run(`save:${id}`, () => api(`/api/terminals/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fields) }),
    async () => { const current = opened; current.observations.delete(id); say(''); await load(); if (opened === current) done() })
  const remove = terminal => {
    if (!window.confirm(`端末「${terminal.terminalId}」の登録を消しますか？\nこの端末を使うメンバーの設定と、届いていない依頼は残ります。`)) return
    return run(`remove:${terminal.terminalId}`, () => api(`/api/terminals/${terminal.terminalId}`, { method: 'DELETE' }), async () => { opened.observations.delete(terminal.terminalId); await load() })
  }
  const setKey = (terminal, purpose) => run(`key:${terminal.terminalId}`, async () => {
    try { return await api(`/api/terminals/${terminal.terminalId}/keys/${purpose}`, { method: 'POST' }) }
    catch (error) { if (error?.status === 404 || error?.status === 405) return { unsupported: true }; throw error }
  }, result => {
    if (result.unsupported) { opened.keyRoute = false; say('この本体では、まだ画面から鍵を設定できません。'); return }
    const request = result.secretRequest
    if (!request?.id) { say('鍵の入力欄を開けませんでした。一覧を更新して確かめてください。'); return }
    const current = opened
    openSecretInput({ message: `端末「${terminal.terminalId}」の${keyLabel[purpose]}です。値はこの入力欄だけに入れてください。`, ...request }, api, () => { if (opened === current) void load() })
  })
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
    const draft = opened.draft ?? (opened.draft = { terminalId: terminal?.terminalId ?? '', host: terminal?.host ?? '', user: terminal?.user ?? '', port: String(terminal?.port ?? 22), accountOwner: terminal?.accountOwner ?? 'owner', revision: 0 })
    const id = input(draft.terminalId, { required: true, pattern: '[a-z0-9][a-z0-9\\-]{0,62}', maxLength: 63, placeholder: 'owner-macbook', disabled: Boolean(terminal), autocapitalize: 'none', spellcheck: false })
    const host = input(draft.host, { required: true, maxLength: 253, placeholder: '192.168.1.12', autocapitalize: 'none', spellcheck: false })
    const user = input(draft.user, { required: true, maxLength: 64, placeholder: 'kite', autocapitalize: 'none', spellcheck: false })
    const port = input(draft.port, { type: 'number', min: 1, max: 65535, required: true, inputMode: 'numeric' })
    const owner = element('select')
    for (const [value, label] of [['owner', '自分の機械（自分のClaudeアカウントで動かす）'], ['terminal-owner', 'ほかの人の機械（その機械のClaudeログインで動かす）']]) { const option = element('option', label); option.value = value; owner.append(option) }
    owner.value = draft.accountOwner
    // Typed values survive re-renders (busy state, a failed save) until the form is closed.
    node.addEventListener('input', () => Object.assign(draft, { terminalId: id.value, host: host.value, user: user.value, port: port.value, accountOwner: owner.value, revision: draft.revision + 1 }))
    node.append(element('h4', terminal ? `「${terminal.terminalId}」を編集` : '端末を追加'),
      field('端末ID', id, '英小文字・数字・ハイフン。あとから変えられません。'), field('ホスト', host, 'IPアドレスかホスト名だけ。user@ やポートは入れません。'),
      field('ユーザー名', user), field('SSHのポート', port), field('機械の持ち主', owner), element('p', 'OSは今は macOS だけです。鍵は、登録したあとに「設定する」から入れます。', 'field-help'))
    const actions = element('div', undefined, 'terminal-actions')
    const submit = element('button', terminal ? '保存' : '登録', 'primary'); submit.type = 'submit'
    submit.disabled = opened.busy.has(`save:${terminal?.terminalId ?? id.value}`)
    actions.append(submit, button('やめる', () => { opened.editing = null; opened.draft = null; render() }, 'text-button'))
    node.append(actions)
    node.addEventListener('submit', event => {
      event.preventDefault()
      const terminalId = terminal?.terminalId ?? id.value.trim()
      const revision = draft.revision
      // Close only the form this save came from, unchanged since the tap (bot-editor pattern); newer add/edit/input stays.
      void save(terminalId, { host: host.value.trim(), user: user.value.trim(), port: Number(port.value), os: 'macos', accountOwner: owner.value }, () => {
        if (opened.draft === draft && draft.revision === revision) { opened.editing = null; opened.draft = null }
        else say('保存しました。そのあとに変えた入力は残しています。')
      })
    })
    return node
  }

  function trustForm(terminal) {
    const node = element('form', undefined, 'terminal-trust')
    const input = element('input'); input.required = true; input.placeholder = 'SHA256:…'; input.autocapitalize = 'none'; input.spellcheck = false
    input.value = opened.trustDraft.get(terminal.terminalId) ?? ''
    input.addEventListener('input', () => opened.trustDraft.set(terminal.terminalId, input.value))
    const wrap = element('label', undefined, 'field'); wrap.append(element('span', 'ホスト鍵の指紋'), input,
      element('small', '端末のターミナルで ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub を実行し、表示された SHA256: から始まる指紋を入れます。推測では入れないでください。', 'field-help'))
    const submit = element('button', 'この指紋を信用する', 'primary'); submit.type = 'submit'
    submit.disabled = opened.busy.has(`save:${terminal.terminalId}`)
    node.append(wrap, submit)
    node.addEventListener('submit', event => {
      event.preventDefault()
      const fingerprint = input.value.trim()
      if (!fingerprint.startsWith('SHA256:')) { say('指紋は SHA256: から始まる形で入れてください。'); return }
      void save(terminal.terminalId, { confirmHostKey: fingerprint }, () => { if (opened.trustDraft.get(terminal.terminalId)?.trim() === fingerprint) opened.trustDraft.delete(terminal.terminalId) })
    })
    return node
  }

  function card(terminal) {
    const id = terminal.terminalId
    const node = element('section', undefined, 'terminal-card')
    node.dataset.terminalId = id
    const status = terminalStatus(opened.observations.get(id))
    const head = element('div', undefined, 'terminal-head')
    const title = element('div', undefined, 'terminal-title')
    title.append(element('strong', id), element('span', `${terminal.user}@${terminal.host}${terminal.port && terminal.port !== 22 ? `:${terminal.port}` : ''}`, 'terminal-target'))
    head.append(element('span', undefined, 'terminal-icon'), title, badge(status.label, status.tone, status.reason ?? ''))
    const meta = element('div', undefined, 'terminal-meta')
    meta.append(badge('macOS', 'muted'), badge(terminal.accountOwner === 'terminal-owner' ? 'ほかの人の機械' : '自分の機械', 'muted'),
      terminal.hostTrust ? badge('ホスト鍵 登録済み', 'ok') : badge('ホスト鍵 未登録', 'attention'))
    node.append(head, meta)
    const needsKeyFirst = (status.trust || !terminal.hostTrust) && terminal.sshKeyConfigured === false
    const help = needsKeyFirst && status.trust ? '先にSSH鍵を設定してください。そのあと、ホスト鍵の指紋を確かめます。' : status.help
    if (help) node.append(element('p', help, 'field-help'))
    const observed = opened.observations.get(id)?.observedAt
    if (observed) node.append(element('p', `確かめた時刻 ${new Date(observed).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`, 'terminal-time'))
    const claude = terminal.maintenance
    if (claude?.after || claude?.before) node.append(element('p', `Claude Code ${claude.after ?? claude.before}${claude.outcome === 'updated' ? '（最新に更新しました）' : claude.outcome === 'failed' ? '（更新できませんでした。入っている版で動きます）' : ''}`, 'terminal-time'))
    node.append(keyRow(terminal, 'ssh'), keyRow(terminal, 'sudo'))
    if ((status.trust || !terminal.hostTrust) && !needsKeyFirst) node.append(trustForm(terminal))
    if (opened.editing === id) node.append(form(terminal))
    const actions = element('div', undefined, 'terminal-actions')
    const checkButton = button(opened.busy.has(`check:${id}`) ? '確かめています…' : '届くか確かめる', () => { void check(id) }, 'primary')
    checkButton.disabled = opened.busy.has(`check:${id}`)
    const removeButton = button('登録を消す', () => { void remove(terminal) }, 'text-button danger')
    removeButton.disabled = opened.busy.has(`remove:${id}`)
    actions.append(checkButton, button('編集', () => { opened.editing = id; opened.draft = null; render() }), removeButton)
    node.append(actions)
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
