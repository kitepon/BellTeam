const node = (tag, text) => Object.assign(document.createElement(tag), text === undefined ? {} : { textContent: text })

export function authFlowView(auth) {
  if (auth?.status === 'blocked' && auth.session_id === null && !auth.auth_ui?.binding) return {
    stage: 'not_started', binding: null, title: 'ログインが必要です', message: 'ログインするを押すと、公式ログインの案内が表示されます。',
  }
  const ui = auth?.auth_ui
  if (!ui) return { stage: auth?.status === 'authenticated' ? 'complete' : 'unavailable', title: auth?.status === 'authenticated' ? '認証が完了しました' : 'ログインの案内を取得できません',
    message: auth?.status === 'authenticated' ? '' : '認証の手順を確認できませんでした。処理を保持しています。状態を更新して確認してください。', binding: null }
  return ui
}

// Shared by initial setup and Settings. It renders only named native actions;
// terminal navigation keys are not a user-facing authentication interface.
export function renderAuthFlow(auth, { name, busy = false, respond }) {
  const view = authFlowView(auth), elements = []
  const title = node('p', view.title); title.setAttribute('role', view.stage === 'unavailable' || view.stage === 'failed' ? 'alert' : 'status')
  elements.push(title)
  if (view.message) elements.push(node('p', view.message))
  if (view.url) {
    const link = node('a', `${name}のログイン画面を開く`)
    link.href = view.url; link.target = '_blank'; link.rel = 'noopener noreferrer'
    elements.push(link)
  }
  if (view.stage === 'device_code') {
    elements.push(node('p', 'ログイン画面で、次のコードを入力してください。'))
    elements.push(Object.assign(node('p', view.user_code), { className: 'auth-user-code' }))
  }
  let password
  if (view.stage === 'paste_code') {
    const label = Object.assign(node('label'), { className: 'field' })
    label.append(node('span', '公式ページに表示された認証コード'))
    password = node('input'); password.type = 'password'; password.autocomplete = 'off'
    password.autocapitalize = 'none'; password.spellcheck = false; password.disabled = busy
    label.append(password)
    const field = password, send = node('button', '認証を完了する')
    send.type = 'button'; send.disabled = true
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
