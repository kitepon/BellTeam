// 設定の「AIの認証」。初期設定の後に、AIの公式認証をやり直す。
// AIの認証が切れると、そのAIを使うメンバーは起動できず、入り直しを頼める相手も居なくなる。利用者がここから自分で戻す。
const statusText = {
  waiting: '公式サイトでの認証を待っています。',
  authenticated: '認証済みです。',
  blocked: '認証に必要な操作を確認してください。',
  failed: '認証できませんでした。',
}

export function harnessAuthTitle(harness) {
  return harness.members > 0 ? `${harness.name} · ${harness.members}人が使用` : `${harness.name} · 使用していません`
}

// 公式認証の進行から、画面に出す物を決める。linkはhttpsの公式サイトだけ。pollは、待っている間だけ数秒おきに見に行く印。
export function harnessAuthView(auth) {
  if (!auth) return { text: '', message: '', link: null, code: null, input: false, poll: false }
  let link = null
  try {
    const url = new URL(auth.url)
    if (url.protocol === 'https:') link = url.href
  } catch { /* URLが無い・読めない時はリンクを出さない */ }
  return {
    text: statusText[auth.status] ?? '認証の状態を確認してください。',
    message: auth.message || '', link, code: auth.user_code || null,
    input: auth.input_required === true, poll: auth.status === 'waiting',
  }
}

// 始める前の知らせが要るか。今の認証が消えうるAIで、認証が無い・切れているとは分かっていない時。
export function needsStartConfirmation(harness, auth) {
  return Boolean(harness.startWarning) && auth?.status !== 'blocked'
}

// AIの種類ごとの行を描く。返す stop は、設定を閉じる時に呼ぶ（見に行くのを止め、入力欄を空にする）。
export async function renderHarnessAuth(container, { api }) {
  const stops = []
  container.replaceChildren()
  const { harnesses } = await api('/api/harness-auth')
  for (const harness of harnesses) {
    const item = harnessAuthItem(harness, { api })
    stops.push(item.stop)
    container.append(item.element)
  }
  return { stop() { for (const stop of stops) stop() } }
}

function harnessAuthItem(harness, { api }) {
  const details = document.createElement('details')
  details.className = 'feature-setting harness-auth'
  details.dataset.harnessId = harness.id
  const summary = document.createElement('summary')
  summary.textContent = harnessAuthTitle(harness)
  const body = document.createElement('div')
  body.className = 'harness-auth-body'
  details.append(summary, body)
  const path = `/api/harness-auth/${encodeURIComponent(harness.id)}`
  let auth = null
  let loaded = false
  let started = false
  // 今の認証が消えうるAIでは、始める前に一度知らせて、もう一度押してもらう。
  let confirming = false
  let busy = false
  let stopped = false
  let errorText = ''
  let timer
  let password
  const clear = () => { if (password) password.value = '' }
  const post = (action, payload) => api(`${path}/${action}`, {
    method: 'POST', redirect: 'error', cache: 'no-store',
    ...(payload ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) } : {}),
  })
  function schedule() {
    clearTimeout(timer)
    if (stopped || !details.open || document.hidden || errorText || !harnessAuthView(auth).poll) return
    timer = setTimeout(async () => {
      if (busy) { schedule(); return }
      try {
        const next = (await api(path)).auth
        // 状態が同じ間は、入力中の欄を作り直さない。
        if (JSON.stringify(next) !== JSON.stringify(auth)) { auth = next; if (auth?.status === 'authenticated') started = false; render() }
        schedule()
      } catch (error) { errorText = error.message; render() }
    }, 3000)
  }
  async function perform(action) {
    if (busy) return
    busy = true
    clearTimeout(timer)
    errorText = ''
    clear()
    render()
    try {
      auth = (await action()).auth
      loaded = true
    } catch (error) { errorText = error.message }
    finally { busy = false; if (!stopped) { render(); schedule() } }
  }
  function button(label, action, className = 'setup-action') {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = className
    item.textContent = label
    item.disabled = busy
    item.addEventListener('click', () => void action())
    return item
  }
  function render() {
    clear()
    password = undefined
    const view = harnessAuthView(auth)
    const nodes = []
    if (!loaded && !errorText) nodes.push(Object.assign(document.createElement('p'), { textContent: '公式の状態を確認しています。' }))
    if (view.text) {
      const state = Object.assign(document.createElement('p'), { textContent: view.text })
      state.setAttribute('role', 'status')
      nodes.push(state)
    }
    if (view.message) nodes.push(Object.assign(document.createElement('p'), { textContent: view.message }))
    if (view.link) {
      const link = document.createElement('a')
      link.href = view.link
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.textContent = '公式サイトで認証する'
      nodes.push(link)
    }
    if (view.code) nodes.push(Object.assign(document.createElement('p'), { className: 'auth-user-code', textContent: `利用者コード: ${view.code}` }))
    if (view.input && started) {
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
      const field = password
      const send = button('入力を送る', () => { const text = field.value; return perform(() => post('input', { text })) })
      send.disabled = true
      field.addEventListener('input', () => { send.disabled = busy || !field.value })
      const keys = document.createElement('div')
      keys.className = 'secret-actions'
      for (const key of ['Enter', 'Up', 'Down', 'Tab']) keys.append(button(key, () => perform(() => post('input', { key }))))
      nodes.push(label, send, keys)
    }
    const start = () => perform(async () => { confirming = false; const next = await post('start'); started = next.auth?.status !== 'authenticated'; return next })
    const actions = document.createElement('div')
    actions.className = 'secret-actions'
    if (confirming) {
      const warning = Object.assign(document.createElement('p'), { className: 'form-error', textContent: harness.startWarning })
      warning.setAttribute('role', 'alert')
      nodes.push(warning)
      actions.append(button('今の認証を手放して始める', start), button('始めない', () => { confirming = false; render() }))
    } else {
      actions.append(
        // 認証が無い・切れていると分かっている時は、失う物が無いのですぐ始める。
        button('認証し直す', () => { if (needsStartConfirmation(harness, auth)) { confirming = true; render() } else return start() }),
        button('状態を更新', () => perform(async () => { const next = await api(path); if (next.auth?.status === 'authenticated') started = false; return next })),
      )
    }
    // やめた後は、公式の状態を見直して出す。
    if (started) actions.append(button('やめる', () => perform(async () => { await post('cancel'); started = false; return api(path) })))
    nodes.push(actions)
    if (errorText) {
      const error = Object.assign(document.createElement('p'), { className: 'form-error', textContent: errorText })
      error.setAttribute('role', 'alert')
      nodes.push(error)
    }
    body.replaceChildren(...nodes)
  }
  // 公式の状態は、行を開いた時に初めて見に行く（開くたびにAIの公式コマンドが動くので、一覧では見に行かない）。
  details.addEventListener('toggle', () => {
    if (!details.open) { clearTimeout(timer); clear(); return }
    if (!loaded && !busy) void perform(() => api(path))
    else schedule()
  })
  const visibility = () => { if (document.hidden) { clearTimeout(timer); clear() } else schedule() }
  document.addEventListener('visibilitychange', visibility)
  render()
  return { element: details, stop() {
    stopped = true
    clearTimeout(timer)
    clear()
    document.removeEventListener('visibilitychange', visibility)
  } }
}
