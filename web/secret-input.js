import { supportsServerTransport } from './server-origin.js?v=__ASSET_VERSION__'

const ownerGuideOrigins = new Set(['https://claude.ai', 'https://console.anthropic.com', 'https://platform.claude.com'])

function renderOwnerGuide(request) {
  const guide = document.createElement('p')
  guide.className = 'secret-owner-guide'
  guide.hidden = true
  if (request.status !== 'pending' || typeof request.ownerGuide?.url !== 'string') return guide
  let url
  try { url = new URL(request.ownerGuide.url) } catch { return guide }
  if (url.protocol !== 'https:' || url.username || url.password || !ownerGuideOrigins.has(url.origin)) return guide
  const link = document.createElement('a')
  link.href = url.href
  link.textContent = '公式認証ページを開く'
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  link.referrerPolicy = 'no-referrer'
  guide.append(link)
  guide.hidden = false
  return guide
}

export function renderSecretRequest(request, { api, sender, onComplete }) {
  for (const dialog of document.querySelectorAll('.secret-dialog')) {
    if (dialog.dataset.requestId === request.id) dialog.querySelector('.secret-owner-guide').replaceWith(renderOwnerGuide(request))
  }
  const card = document.createElement('section')
  card.className = 'secret-request'
  const heading = document.createElement('strong')
  heading.textContent = `${sender} · 秘密情報の入力`
  const message = document.createElement('p')
  message.textContent = request.message
  const label = document.createElement('p')
  label.className = 'secret-label'
  label.textContent = `${request.label} / ${request.toolId}`
  card.append(heading, message, label)
  if (request.status !== 'pending') {
    const status = document.createElement('p')
    status.textContent = request.status === 'submitted' ? '登録済み' : '入力を取り消しました'
    if (request.notification === 'failed') status.textContent += '。AIへの通知に失敗しました。チャットで完了を知らせてください。'
    card.append(status)
    return card
  }
  card.append(renderOwnerGuide(request))
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = '安全な入力欄を開く'
  button.addEventListener('click', () => openSecretInput(request, api, onComplete))
  card.append(button)
  return card
}

export function openSecretInput(request, api, onComplete) {
  const dialog = document.createElement('dialog')
  dialog.className = 'secret-dialog'
  dialog.dataset.requestId = request.id
  const form = document.createElement('form')
  const title = document.createElement('h2')
  title.textContent = request.label
  const message = document.createElement('p')
  message.textContent = request.message
  const note = document.createElement('p')
  note.className = 'secret-note'
  // An OpenSSH private key is multiline; a password input would drop its newlines. The value is sent as typed, never trimmed.
  const multiline = request.purpose === 'terminal.ssh'
  // A value used once never says it is saved or registered.
  const oneTime = request.purpose === 'terminal.login' || request.oneTime === true
  const input = document.createElement(multiline ? 'textarea' : 'input')
  if (multiline) { input.rows = 6; input.className = 'secret-multiline' } else input.type = 'password'
  input.autocomplete = 'off'
  // Browser 1Password autofill would insert the public key here; the private key comes from the picker instead.
  input.setAttribute('data-1p-ignore', '')
  input.setAttribute('aria-label', request.label)
  input.spellcheck = false
  input.autocapitalize = 'none'
  // Terminal SSH and sudo cards pick an existing 1Password item by name; other cards keep the typed reference.
  const picker = multiline || request.purpose === 'terminal.sudo'
  const noun = multiline ? '鍵' : 'パスワード'
  const reference = document.createElement(picker ? 'select' : 'input')
  // Narrows a long item list by title or vault; the text is not secret and is never sent.
  const search = document.createElement('input')
  search.type = 'search'
  search.className = 'secret-reference-search'
  search.placeholder = '名前や保管庫で絞り込む'
  search.setAttribute('aria-label', `${request.label}の1Password項目を名前や保管庫で絞り込む`)
  search.autocomplete = 'off'
  search.setAttribute('data-1p-ignore', '')
  search.spellcheck = false
  search.autocapitalize = 'none'
  search.hidden = true
  if (picker) {
    reference.className = 'secret-reference-picker'
    reference.append(Object.assign(document.createElement('option'), { value: '', textContent: `1Passwordの${noun}を読み込んでいます…`, disabled: true, selected: true }))
  } else {
    reference.type = 'text'
    reference.autocomplete = 'off'
    reference.placeholder = 'op://保管庫/アイテム/フィールド'
  }
  reference.setAttribute('aria-label', `${request.label}の1Password参照`)
  reference.spellcheck = false
  reference.autocapitalize = 'none'
  // usageが1Password接続済みと示した時だけ選択肢を出す。欠落時は旧serverと同じ値入力だけ。
  const onePassword = request.inputOptions?.onePasswordAvailable === true
  const sources = []
  const radios = {}
  if (onePassword) {
    const fieldset = document.createElement('fieldset')
    fieldset.className = 'secret-sources'
    const legend = document.createElement('legend')
    legend.textContent = '入力方法'
    fieldset.append(legend)
    // Both choices say where the value comes from; whether it is kept is said only by the note (Owner 2026-11-11).
    for (const [value, text] of [['onepassword', picker ? '1Passwordから選ぶ' : '1Passwordから読み出す'], ['stored', multiline ? 'ここに貼り付ける' : 'ここに入力する']]) {
      const choice = document.createElement('label')
      const radio = radios[value] = document.createElement('input')
      radio.type = 'radio'
      radio.name = `secret-source-${request.id}`
      radio.value = value
      radio.addEventListener('change', () => select(value))
      const caption = document.createElement('span')
      caption.textContent = text
      choice.append(radio, caption)
      fieldset.append(choice)
    }
    sources.push(fieldset)
  }
  let source = 'stored'
  let items = null
  function select(next) {
    source = next
    for (const [value, radio] of Object.entries(radios)) radio.checked = value === next
    input.hidden = next !== 'stored'
    reference.hidden = next !== 'onepassword'
    search.hidden = !(next === 'onepassword' && items?.length)
    if (next === 'stored') reference.value = ''
    else input.value = ''
    note.textContent = next === 'onepassword'
      ? picker ? `選んだ${noun}は、使うときに1Passwordから読み出します。${noun}は会話に送られません。` : '参照は会話に送信されません。値は1Passwordから読み出します。'
      : multiline
        ? '秘密鍵（「-----BEGIN OPENSSH PRIVATE KEY-----」で始まる文字）をそのまま貼ってください。1Passwordを使っている場合は、設定の「1Password連携」を済ませると、ここで鍵を一覧から選べます。値は会話に送信されません。'
        : picker
          ? 'sudoのパスワードを入力してください。1Passwordを使っている場合は、設定の「1Password連携」を済ませると、ここで一覧から選べます。値は会話に送信されず、BellTeamの利用者領域へ保存します。'
        : request.purpose === 'terminal.login'
          ? 'このMacに鍵を入れるときに1回だけ使い、すぐに消します。保存せず、会話にも送信されません。'
        : oneTime
          ? '1回だけ使い、使い終わったら消します。保存せず、会話にも送られません。'
          : '値は会話に送信されません。BellTeamの利用者領域へ保存します。'
  }
  select(onePassword && request.inputOptions.preferred !== 'stored' ? 'onepassword' : 'stored')
  const error = document.createElement('p')
  error.className = 'secret-error'
  error.setAttribute('role', 'alert')
  if (onePassword && picker) void loadKeys()
  async function loadKeys() {
    let loaded
    try {
      ({ items: loaded } = await api(`/api/secret-requests/${encodeURIComponent(request.id)}/onepassword-items`, {
        method: 'GET', redirect: 'error', cache: 'no-store', credentials: 'same-origin' }))
    } catch { loaded = null }
    // An older body lists SSH keys for every purpose; the sudo picker keeps only password-field references.
    items = Array.isArray(loaded) ? loaded.filter(item => multiline || /\/password$/u.test(item?.reference ?? '')) : null
    const placeholder = reference.children[0]
    if (!items) placeholder.textContent = `1Passwordの${noun}一覧を読めませんでした。閉じて開き直してください。`
    else if (!items.length) placeholder.textContent = multiline ? '1Passwordで読めるSSH鍵がありません。' : '1Passwordで読めるパスワードがありません。'
    search.hidden = reference.hidden || !items?.length
    filter()
  }
  // Rebuilds the options instead of hiding them: iOS Safari ignores hidden on <option>.
  function filter() {
    if (!items?.length) return
    const query = search.value.trim().toLocaleLowerCase()
    const shown = items.filter(item => !query || `${item.title}\n${item.vault}`.toLocaleLowerCase().includes(query))
    const chosen = reference.value
    const placeholder = reference.children[0]
    reference.replaceChildren(placeholder)
    placeholder.textContent = shown.length ? `${shown.length}件から選んでください` : `「${search.value.trim()}」に合う${noun}がありません`
    for (const item of shown) {
      reference.append(Object.assign(document.createElement('option'), { value: item.reference, textContent: item.vault ? `${item.title}（${item.vault}）` : item.title }))
    }
    reference.value = shown.some(item => item.reference === chosen) ? chosen : ''
  }
  search.addEventListener('input', filter)
  const submit = document.createElement('button')
  submit.type = 'submit'
  submit.textContent = oneTime ? '渡して続ける' : '登録して続ける'
  const decline = document.createElement('button')
  decline.type = 'button'
  decline.textContent = '入力を断る'
  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = '閉じる'
  close.addEventListener('click', () => dialog.close())
  const actions = document.createElement('div')
  actions.className = 'secret-actions'
  actions.append(submit, decline, close)
  form.append(title, message, renderOwnerGuide(request), ...sources, note, input, ...(onePassword ? picker ? [search, reference] : [reference] : []), error, actions)
  dialog.append(form)
  document.body.append(dialog)
  const clearWhenHidden = () => { if (document.hidden) input.value = reference.value = '' }
  document.addEventListener('visibilitychange', clearWhenHidden)
  dialog.addEventListener('close', () => {
    input.value = reference.value = ''
    document.removeEventListener('visibilitychange', clearWhenHidden)
    dialog.remove()
  }, { once: true })
  let sending = false
  dialog.addEventListener('cancel', event => { if (sending) event.preventDefault() })
  async function finish(action) {
    if (sending) return
    if (!supportsServerTransport(location.href)) {
      error.textContent = '秘密情報はHTTPS、またはlocalhost・LANのHTTP接続から登録してください。'
      return
    }
    if (action === 'submit' && source === 'stored' && !input.value) {
      error.textContent = '値を入力してください。'
      return
    }
    if (action === 'submit' && source === 'onepassword' && !reference.value.trim().startsWith('op://')) {
      error.textContent = picker ? `1Passwordの${noun}を選んでください。` : '1Passwordの参照（op://で始まる）を入力してください。'
      return
    }
    sending = true
    submit.disabled = decline.disabled = close.disabled = true
    try {
      const body = JSON.stringify(action !== 'submit' ? {}
        : source === 'onepassword' ? { source, reference: reference.value.trim() } : { value: input.value })
      input.value = ''
      // リダイレクト先へ秘密の本文を転送しない。
      const result = await api(`/api/secret-requests/${encodeURIComponent(request.id)}/${action}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body, redirect: 'error', cache: 'no-store', credentials: 'same-origin',
      })
      onComplete(result.request)
      dialog.close()
    } catch {
      error.textContent = '登録結果を確認できませんでした。閉じて最新の状態を確認してください。'
    } finally {
      sending = false
      submit.disabled = decline.disabled = close.disabled = false
    }
  }
  form.addEventListener('submit', event => { event.preventDefault(); void finish('submit') })
  decline.addEventListener('click', () => { void finish('cancel') })
  dialog.showModal()
  ;(source === 'onepassword' ? reference : input).focus()
}
