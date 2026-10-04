const statusText = { waiting: '公式認証の完了を待っています。', authenticated: '認証済みです。確認して案内役との会話を始めてください。', blocked: '認証に必要な操作を確認してください。', failed: '認証に失敗しました。表示された理由を確認してください。' }

export function openOnboarding(initial, { api, onReady }) {
  const dialog = document.createElement('dialog')
  dialog.className = 'sheet-dialog onboarding-dialog'
  dialog.setAttribute('aria-label', 'BellTeamの初回設定')
  dialog.addEventListener('cancel', event => event.preventDefault())
  const content = document.createElement('div')
  content.className = 'sheet-body onboarding-body'
  dialog.append(content)
  document.body.append(dialog)
  let setup = initial
  let busy = false
  let stopped = false
  let timer
  let errorText = ''
  let password
  const clear = () => { if (password) password.value = '' }
  const visibility = () => {
    clearTimeout(timer)
    if (document.hidden) clear()
    else schedule()
  }
  document.addEventListener('visibilitychange', visibility)
  dialog.addEventListener('close', () => {
    stopped = true
    clearTimeout(timer)
    clear()
    document.removeEventListener('visibilitychange', visibility)
    dialog.remove()
  }, { once: true })
  function button(label, action) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = label === '認証を確認して始める' ? 'solid-button' : 'setup-action'
    item.textContent = label
    item.disabled = busy
    item.addEventListener('click', () => void perform(action))
    return item
  }
  function schedule() {
    clearTimeout(timer)
    if (stopped || document.hidden || errorText || setup.auth?.status !== 'waiting') return
    timer = setTimeout(async () => {
      if (busy) { schedule(); return }
      try {
        const next = await api('/api/setup')
        // 状態が同じ間は、入力中の認証欄を作り直さない。
        if (JSON.stringify(next) !== JSON.stringify(setup)) { setup = next; render() }
        schedule()
      } catch (error) { errorText = error.message; render() }
    }, 3000)
  }
  async function post(path, body = {}) {
    return api(`/api/setup/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', cache: 'no-store',
    })
  }
  async function perform(action) {
    if (busy) return
    busy = true
    clearTimeout(timer)
    errorText = ''
    clear()
    render()
    try {
      setup = await action()
      if (setup.phase === 'ready') { await onReady(setup); dialog.close(); return }
    } catch (error) { errorText = error.message }
    finally { busy = false; if (!stopped) { render(); schedule() } }
  }
  function render() {
    clear()
    const title = document.createElement('h2')
    title.textContent = 'BellTeamを始める'
    const note = document.createElement('p')
    note.textContent = '最初に使うAIを選んで公式サイトで認証します。設定は、そのあと案内役と会話しながら進められます。'
    content.replaceChildren(title, note)
    if (setup.phase === 'select_harness') {
      const cards = document.createElement('div')
      cards.className = 'harness-cards'
      for (const harness of setup.harnesses) cards.append(button(harness.name, () => post('harness', { harness: harness.id })))
      content.append(cards)
    } else {
      const name = document.createElement('h3')
      name.textContent = setup.harnesses.find(h => h.id === setup.harness)?.name ?? '公式認証'
      content.append(name)
      const auth = setup.auth
      if (auth) {
        const state = document.createElement('p')
        state.setAttribute('role', 'status')
        state.textContent = statusText[auth.status] ?? '認証状態を確認してください。'
        content.append(state)
        if (auth.message) content.append(Object.assign(document.createElement('p'), { textContent: auth.message }))
        if (auth.url) {
          const url = new URL(auth.url)
          if (url.protocol === 'https:') {
            const link = document.createElement('a')
            link.href = url.href
            link.target = '_blank'
            link.rel = 'noopener noreferrer'
            link.textContent = '公式サイトで認証する'
            content.append(link)
          }
        }
        if (auth.user_code) {
          const code = document.createElement('p')
          code.className = 'auth-user-code'
          code.textContent = `利用者コード: ${auth.user_code}`
          content.append(code)
        }
        if (auth.input_required) {
          const label = document.createElement('label')
          label.className = 'field'
          label.append(Object.assign(document.createElement('span'), { textContent: '認証に必要な入力' }))
          password = document.createElement('input')
          password.type = 'password'
          password.autocomplete = 'off'
          password.autocapitalize = 'none'
          password.spellcheck = false
          password.disabled = busy
          label.append(password)
          const send = document.createElement('button')
          send.type = 'button'
          send.textContent = '入力を送る'
          send.disabled = true
          password.addEventListener('input', () => { send.disabled = busy || !password.value })
          send.addEventListener('click', () => {
            const text = password.value
            void perform(() => post('auth/input', { text }))
          })
          const keys = document.createElement('div')
          keys.className = 'secret-actions'
          for (const key of ['Enter', 'Up', 'Down', 'Tab']) keys.append(button(key, () => post('auth/input', { key })))
          content.append(label, send, keys)
        }
      }
      content.append(button('認証を確認して始める', () => post('start')), button('認証の状態を更新', () => api('/api/setup')))
      const change = document.createElement('details')
      change.append(Object.assign(document.createElement('summary'), { textContent: '使うAIを変更' }))
      for (const harness of setup.harnesses) change.append(button(harness.name, () => post('harness', { harness: harness.id })))
      content.append(change)
    }
    if (errorText) content.append(Object.assign(document.createElement('p'), { className: 'form-error', textContent: errorText }))
  }
  render()
  dialog.showModal()
  schedule()
}

function featureSettingTitle(setting) {
  return `${setting.title} · ${setting.error ? '反映エラー' : { enabled: '有効', disabled: '無効', unconfigured: '未設定' }[setting.status]}`
}

// 設定変更の通知では入力中のフォームを保ち、状態とエラーだけを更新する。
export function refreshFeatureSettingsStatus(container, settings) {
  for (const setting of settings) {
    const details = [...container.children].find(item => item.dataset.featureId === setting.id)
    if (!details) continue
    details.children[0].textContent = featureSettingTitle(setting)
    let failure = details.querySelector('.feature-application-error')
    if (setting.error) {
      if (!failure) {
        failure = document.createElement('p')
        failure.className = 'form-error feature-application-error'
        failure.setAttribute('role', 'alert')
        details.append(failure)
      }
      failure.textContent = `${setting.error.code}: ${setting.error.message}`
    } else failure?.remove()
  }
}

export function renderFeatureSettings(container, settings, { api, onChange }) {
  container.replaceChildren()
  for (const setting of settings) {
    const details = document.createElement('details')
    details.className = 'feature-setting'
    details.dataset.featureId = setting.id
    const summary = document.createElement('summary')
    summary.textContent = featureSettingTitle(setting)
    const form = document.createElement('form')
    const toggle = document.createElement('label')
    toggle.className = 'feature-toggle'
    const enabled = document.createElement('input')
    enabled.type = 'checkbox'
    enabled.checked = setting.enabled
    toggle.append(enabled, document.createTextNode('有効にする'))
    form.append(toggle)
    const inputs = []
    for (const field of setting.fields) {
      const label = document.createElement('label')
      label.className = 'field'
      label.append(Object.assign(document.createElement('span'), { textContent: field.label }))
      const input = document.createElement('input')
      input.type = field.secret ? 'password' : 'text'
      input.value = field.secret ? '' : field.value
      input.autocomplete = 'off'
      input.autocapitalize = 'none'
      input.spellcheck = false
      if (field.secret) input.placeholder = field.configured ? '登録済み・変更するときだけ入力' : '未設定'
      inputs.push({ field, input })
      label.append(input)
      form.append(label)
    }
    const error = document.createElement('p')
    error.className = 'form-error'
    error.setAttribute('role', 'alert')
    const save = document.createElement('button')
    save.type = 'submit'
    save.textContent = 'この機能を保存'
    form.append(error, save)
    form.addEventListener('submit', async event => {
      event.preventDefault()
      if (save.disabled) return
      save.disabled = true
      error.textContent = ''
      const values = Object.fromEntries(inputs.filter(({ field, input }) => !field.secret || input.value).map(({ field, input }) => [field.key, input.value]))
      for (const { field, input } of inputs) if (field.secret) input.value = ''
      try {
        await api(`/api/settings/${encodeURIComponent(setting.id)}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: enabled.checked, values }),
          redirect: 'error', cache: 'no-store', credentials: 'same-origin',
        })
        await onChange()
      } catch (cause) {
        if (setting.id === 'cloudflare' && enabled.checked && (cause.status === 401 || cause.status === 403 || cause instanceof TypeError)) {
          error.textContent = '外部接続の保存後に認証が必要になった可能性があります。再読み込みしてログインしてください。'
          const login = document.createElement('button')
          login.type = 'button'
          login.textContent = '再読み込みしてログイン'
          login.addEventListener('click', () => location.reload())
          error.append(login)
        } else error.textContent = cause.message
      } finally { save.disabled = false }
    })
    details.append(summary)
    if (setting.error) {
      const failure = document.createElement('p')
      failure.className = 'form-error feature-application-error'
      failure.setAttribute('role', 'alert')
      failure.textContent = `${setting.error.code}: ${setting.error.message}`
      details.append(failure)
    }
    details.append(form)
    container.append(details)
  }
}
