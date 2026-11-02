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

function openSecretInput(request, api, onComplete) {
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
  note.textContent = '値は会話に送信されません。BellTeamの利用者領域へ保存します。'
  const input = document.createElement('input')
  input.type = 'password'
  input.autocomplete = 'off'
  input.setAttribute('aria-label', request.label)
  input.spellcheck = false
  input.autocapitalize = 'none'
  const error = document.createElement('p')
  error.className = 'secret-error'
  error.setAttribute('role', 'alert')
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
  form.append(title, message, renderOwnerGuide(request), note, input, error, actions)
  dialog.append(form)
  document.body.append(dialog)
  const clearWhenHidden = () => { if (document.hidden) input.value = '' }
  document.addEventListener('visibilitychange', clearWhenHidden)
  dialog.addEventListener('close', () => {
    input.value = ''
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
    if (action === 'submit' && !input.value) {
      error.textContent = '値を入力してください。'
      return
    }
    sending = true
    submit.disabled = decline.disabled = close.disabled = true
    try {
      const body = JSON.stringify(action === 'submit' ? { value: input.value } : {})
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
  input.focus()
}
