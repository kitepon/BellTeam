const node = (tag, text) => Object.assign(document.createElement(tag), text === undefined ? {} : { textContent: text })

export function authFlowView(auth) {
  if (auth?.status === 'blocked' && auth.session_id === null && !auth.auth_ui?.binding) return {
    stage: 'not_started', binding: null, title: 'ログインが必要です', message: '「ログインを始める」を押すと、公式ログインの案内が出ます。',
  }
  const ui = auth?.auth_ui
  if (!ui) return { stage: auth?.status === 'authenticated' ? 'complete' : 'unavailable', title: auth?.status === 'authenticated' ? '認証が完了しました' : 'ログインの案内を取得できません',
    message: auth?.status === 'authenticated' ? '' : '認証の手順を確認できませんでした。処理を保持しています。状態を更新して確認してください。', binding: null }
  return ui
}

// Shared by initial setup and Settings. It renders only named native actions;
// terminal navigation keys are not a user-facing authentication interface.
// plain: the caller says the stage in its own words, so the Aiterm title/message are not drawn twice (Settings).
export function renderAuthFlow(auth, { name, busy = false, respond, plain = false, sendLabel = '認証を完了する', sendClass = '' }) {
  const view = authFlowView(auth), elements = []
  if (!plain) {
    const title = node('p', view.title); title.setAttribute('role', view.stage === 'unavailable' || view.stage === 'failed' ? 'alert' : 'status')
    elements.push(title)
    if (view.message) elements.push(node('p', view.message))
  }
  if (view.stage === 'device_code') {
    elements.push(node('p', 'ログイン画面で、次のコードを入力してください。'))
    const box = Object.assign(node('div'), { className: 'auth-code-box' })
    box.append(Object.assign(node('p', view.user_code), { className: 'auth-user-code' }))
    const clipboard = globalThis.navigator?.clipboard
    if (clipboard?.writeText) {
      const copy = node('button', 'コピー'); copy.type = 'button'
      copy.addEventListener('click', () => { void clipboard.writeText(view.user_code).then(() => { copy.textContent = 'コピーしました' }, () => { copy.textContent = 'コピーできませんでした' }) })
      box.append(copy)
    }
    elements.push(box)
  }
  if (view.url) {
    const link = node('a', `${name}のログイン画面を開く`)
    link.href = view.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.className = 'auth-open'
    elements.push(link)
  }
  let password
  if (view.stage === 'paste_code') {
    const label = Object.assign(node('label'), { className: 'field' })
    label.append(node('span', '公式ページに表示された認証コード'))
    password = node('input'); password.type = 'password'; password.autocomplete = 'off'
    password.autocapitalize = 'none'; password.spellcheck = false; password.disabled = busy
    label.append(password)
    const field = password, send = node('button', sendLabel)
    send.type = 'button'; send.disabled = true; if (sendClass) send.className = sendClass
    field.addEventListener('input', () => { send.disabled = busy || !field.value })
    send.addEventListener('click', () => {
      if (send.disabled) return
      const value = field.value; field.value = ''; send.disabled = true
      void respond({ binding: view.binding, prompt_digest: view.prompt_digest, response: { kind: 'authorization_code', value } })
    })
    elements.push(label, send)
  }
  if (view.stage === 'select') {
    const actions = Object.assign(node('div'), { className: 'secret-actions' })
    for (const choice of view.choices) {
      const button = node('button', choice.label); button.type = 'button'; button.disabled = busy
      button.addEventListener('click', () => { if (!button.disabled) void respond({ binding: view.binding, prompt_digest: view.prompt_digest, response: { kind: 'choice', id: choice.id } }) })
      actions.append(button)
    }
    elements.push(actions)
  }
  return { elements, password, poll: ['open_url', 'device_code', 'paste_code', 'select', 'waiting'].includes(view.stage) }
}
