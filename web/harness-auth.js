// 設定の「AIの認証」。初期設定の後に、AIの公式認証をやり直す。
// AIの認証が切れると、そのAIを使うメンバーは起動できず、入り直しを頼める相手も居なくなる。利用者がここから自分で戻す。
import { authFlowView, renderAuthFlow } from './auth-flow.js?v=__ASSET_VERSION__'

export function harnessAuthTitle(harness) {
  return harness.members > 0 ? `${harness.name} · ${harness.members}人が使用` : `${harness.name} · 使用していません`
}

// 公式認証の進行から、画面に出す物を決める。linkはhttpsの公式サイトだけ。pollは、待っている間だけ数秒おきに見に行く印。
export function harnessAuthView(auth) {
  const view = authFlowView(auth)
  return { ...view, poll: ['open_url', 'device_code', 'paste_code', 'select', 'waiting'].includes(view.stage) }
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
  const row = document.createElement('section')
  row.className = 'feature-setting harness-auth'
  row.dataset.harnessId = harness.id
  const heading = document.createElement('h4')
  heading.textContent = harnessAuthTitle(harness)
  const body = document.createElement('div')
  body.className = 'harness-auth-body'
  const status = document.createElement('p')
  status.setAttribute('role', 'status')
  row.append(heading, status, body)
  const path = `/api/harness-auth/${encodeURIComponent(harness.id)}`
  let auth = null
  let loaded = false
  let started = false
  // 今の認証が消えうるAIでは、始める前に一度知らせて、もう一度押してもらう。
  let confirming = false
  let busy = false
  let revision = 0
  let inputBlocked = false
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
    if (stopped || document.hidden || errorText || !harnessAuthView(auth).poll) return
    timer = setTimeout(async () => {
      if (busy) { schedule(); return }
      const observedRevision = ++revision
      try {
        const next = (await api(path)).auth
        if (stopped || observedRevision !== revision) return
        // 状態が同じ間は、入力中の欄を作り直さない。
        if (JSON.stringify(next) !== JSON.stringify(auth)) { auth = next; if (auth?.status === 'authenticated') started = false; render() }
        schedule()
      } catch (error) { if (stopped || observedRevision !== revision) return; errorText = error.message; render() }
    }, 3000)
  }
  async function perform(action) {
    if (busy) return
    busy = true
    revision++
    clearTimeout(timer)
    errorText = ''
    clear()
    render()
    try {
      auth = (await action()).auth
      inputBlocked = false
      if (auth?.status === 'authenticated') started = false
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
    const state = busy && !loaded ? 'checking' : errorText ? 'failed' : auth?.status ?? 'unknown'
    status.className = `harness-auth-status ${state}`
    status.textContent = ({ checking: '確認中', authenticated: '認証済み', blocked: '未認証', waiting: '認証中', failed: '確認できません' })[state] ?? '未確認'
    const nodes = []
    const flow = renderAuthFlow(inputBlocked ? { auth_ui: { stage: 'unavailable', title: '認証結果を確認してください', message: '同じ入力を繰り返さず、状態を更新してください。', binding: null } } : auth, { name: harness.name, busy,
      respond: input => perform(async () => { try { return await post('input', input) } catch (error) { inputBlocked = true; throw error } }),
    })
    password = flow.password
    if (loaded && !errorText && harness.reloginSupported !== false) nodes.push(...flow.elements)
    if (harness.reloginSupported === false && harness.startWarning) nodes.push(Object.assign(document.createElement('p'), { textContent: harness.startWarning }))
    const start = () => perform(async () => { confirming = false; const next = await post('start'); started = next.auth?.status !== 'authenticated'; return next })
    const actions = document.createElement('div')
    actions.className = 'secret-actions'
    if (confirming) {
      const warning = Object.assign(document.createElement('p'), { className: 'form-error', textContent: harness.startWarning })
      warning.setAttribute('role', 'alert')
      nodes.push(warning)
      actions.append(button('今の認証を手放して始める', start), button('始めない', () => { confirming = false; render() }))
    } else {
      if (harness.reloginSupported !== false && (!(auth?.session_id || view.binding) || view.stage === 'complete')) actions.append(button(auth?.status === 'authenticated' ? '認証し直す' : '認証する', () => {
        if (needsStartConfirmation(harness, auth)) { confirming = true; render() } else return start()
      }))
      actions.append(button('状態を更新', () => perform(async () => { const next = await api(path); if (next.auth?.status === 'authenticated') started = false; return next })))
    }
    if (started || auth?.session_id || view.binding && view.stage !== 'complete') actions.append(button('認証を中止する', () => perform(async () => { await post('cancel'); started = false; return api(path) })))
    nodes.push(actions)
    if (errorText) {
      const error = Object.assign(document.createElement('p'), { className: 'form-error', textContent: errorText })
      error.setAttribute('role', 'alert')
      nodes.push(error)
    }
    body.replaceChildren(...nodes)
  }
  // 利用人数にかかわらず、設定を開いた時に一度だけ公式の状態を確認する。
  const visibility = () => { if (document.hidden) { clearTimeout(timer); clear() } else schedule() }
  document.addEventListener('visibilitychange', visibility)
  void perform(() => api(path))
  return { element: row, stop() {
    stopped = true
    clearTimeout(timer)
    clear()
    document.removeEventListener('visibilitychange', visibility)
  } }
}
