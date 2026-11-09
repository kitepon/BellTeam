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
  const input = document.createElement(multiline ? 'textarea' : 'input')
  if (multiline) { input.rows = 6; input.className = 'secret-multiline' } else input.type = 'password'
  input.autocomplete = 'off'
  // Browser 1Password autofill would insert the public key here; the private key comes from the picker instead.
  input.setAttribute('data-1p-ignore', '')
  input.setAttribute('aria-label', request.label)
  input.spellcheck = false
  input.autocapitalize = 'none'
  // An SSH key card picks an existing 1Password SSH Key item by name; other cards keep the typed reference.
  const picker = multiline
  const reference = document.createElement(picker ? 'select' : 'input')
  if (picker) {
    reference.className = 'secret-reference-picker'
    reference.append(Object.assign(document.createElement('option'), { value: '', textContent: '1Passwordの鍵を読み込んでいます…', disabled: true, selected: true }))
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
    for (const [value, text] of [['onepassword', picker ? '1Passwordの鍵から選ぶ' : '1Passwordの参照を使う'], ['stored', picker ? '鍵を貼り付けて保存する' : '値をBellTeamへ保存する']]) {
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
  function select(next) {
    source = next
    for (const [value, radio] of Object.entries(radios)) radio.checked = value === next
    input.hidden = next !== 'stored'
    reference.hidden = next !== 'onepassword'
    if (next === 'stored') reference.value = ''
    else input.value = ''
    note.textContent = next === 'onepassword'
      ? picker ? '選んだ鍵は、使うときに1Passwordから読み出します。鍵は会話に送られません。' : '参照は会話に送信されません。値は1Passwordから読み出します。'
      : multiline
        ? '秘密鍵（「-----BEGIN OPENSSH PRIVATE KEY-----」で始まる文字）をそのまま貼ってください。1Passwordを使っている場合は、設定の「1Password連携」を済ませると、ここで鍵を一覧から選べます。値は会話に送信されません。'
        : request.purpose === 'terminal.login'
          ? 'このMacに鍵を入れるときに1回だけ使い、すぐに消します。保存せず、会話にも送信されません。'
          : '値は会話に送信されません。BellTeamの利用者領域へ保存します。'
  }
  select(onePassword && request.inputOptions.preferred !== 'stored' ? 'onepassword' : 'stored')
  const error = document.createElement('p')
  error.className = 'secret-error'
  error.setAttribute('role', 'alert')
  if (onePassword && picker) void loadKeys()
  async function loadKeys() {
    let items
    try {
      ({ items } = await api(`/api/secret-requests/${encodeURIComponent(request.id)}/onepassword-items`, {
        method: 'GET', redirect: 'error', cache: 'no-store', credentials: 'same-origin' }))
    } catch { items = null }
    const placeholder = reference.children[0]
    if (!Array.isArray(items)) placeholder.textContent = '1Passwordの鍵一覧を読めませんでした。閉じて開き直してください。'
    else if (!items.length) placeholder.textContent = '1Passwordで読めるSSH鍵がありません。'
    else placeholder.textContent = '鍵を選んでください'
    for (const item of items ?? []) {
      reference.append(Object.assign(document.createElement('option'), { value: item.reference, textContent: item.vault ? `${item.title}（${item.vault}）` : item.title }))
    }
  }
  const submit = document.createElement('button')
  submit.type = 'submit'
  submit.textContent = '登録して続ける'
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
  form.append(title, message, renderOwnerGuide(request), ...sources, note, input, ...(onePassword ? [reference] : []), error, actions)
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
      error.textContent = picker ? '1Passwordの鍵を選んでください。' : '1Passwordの参照（op://で始まる）を入力してください。'
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
