// 設定の「AIの認証」。初期設定の後に、AIの公式認証をやり直す。
// AIの認証が切れると、そのAIを使うメンバーは起動できず、入り直しを頼める相手も居なくなる。利用者がここから自分で戻す。
// 段階と札・ボタンはAppleのAuthenticationProgressと同じ（docs/architecture/modules/web/user-paths.md 4.4）。
import { authFlowView, renderAuthFlow } from './auth-flow.js?v=__ASSET_VERSION__'
import { claudeAccounts, renderClaudeAccounts } from './harness-accounts.js?v=__ASSET_VERSION__'

export function harnessAuthTitle(harness) {
  return harness.members > 0 ? `${harness.name} · ${harness.members}人が使用` : `${harness.name} · 使用していません`
}

// 公式認証の進行から、画面に出す物を決める。linkはhttpsの公式サイトだけ。pollは、待っている間だけ数秒おきに見に行く印。
export function harnessAuthView(auth) {
  const view = authFlowView(auth)
  return { ...view, poll: ['open_url', 'device_code', 'paste_code', 'select', 'waiting'].includes(view.stage) }
}

// 始める前の知らせが要るか。今の認証が消えうるAIで、認証が無い・切れていると分かっている時を除く。
export function needsStartConfirmation(harness, auth) {
  return harness.reloginSupported !== false && Boolean(harness.startWarning) && auth?.status !== 'blocked'
}

// 行の段階。/api/accounts の loggedIn は使わない（期限切れの旧資格情報で真を返すことがある）。signedOutAt だけ見る。
export function authStage({ auth, loaded, busy, signedOutAt = null }) {
  if (!auth) return !loaded && busy ? 'checking' : 'unknown'
  const stage = auth.auth_ui?.stage
  if (auth.status === 'authenticated') return signedOutAt ? 'needsLogin' : 'done'
  if (auth.status === 'blocked' || signedOutAt) return 'needsLogin'
  if (auth.status === 'failed' || stage === 'failed') return 'failed'
  if (auth.status === 'waiting') return ['open_url', 'device_code', 'select'].includes(stage) ? 'waitingSite' : stage === 'paste_code' ? 'waitingCode' : 'confirming'
  return 'unknown'
}

export const STAGES = {
  checking: { badge: '確認中', tone: 'muted', text: '' },
  unknown: { badge: '確認できません', tone: 'attention', text: '状態を確認できませんでした。「確認する」で読み直してください。' },
  done: { badge: '認証済み', tone: 'ok', text: '' },
  needsLogin: { badge: 'ログインが必要', tone: 'attention', text: 'ログインし直してください。「認証する」から公式サイトで認証します。' },
  failed: { badge: '失敗', tone: 'attention', text: '認証できませんでした。「認証し直す」からやり直してください。' },
  waitingSite: { badge: '認証の途中', tone: 'info', text: 'まだ終わっていません。公式サイトで認証してください。' },
  waitingCode: { badge: 'コード待ち', tone: 'info', text: 'まだ終わっていません。公式サイトに表示された認証コードを下に貼り付けて「認証コードを送る」を押してください。' },
  confirming: { badge: '確認中', tone: 'info', text: '公式の応答を待っています。' },
}

// サーバーの文はそのまま、符号だけの文は平易な文にして、符号は閉じた「詳細」へ。
function failureNode(message) {
  const box = Object.assign(document.createElement('p'), { className: 'form-error' })
  box.setAttribute('role', 'alert')
  const coded = /^[A-Z0-9_]+$/u.test(message ?? '')
  box.append(Object.assign(document.createElement('span'), { textContent: coded || !message ? '通信がうまくいきませんでした。もう一度お試しください。' : message }))
  if (coded) {
    const more = document.createElement('details')
    more.append(Object.assign(document.createElement('summary'), { textContent: '詳細' }), Object.assign(document.createElement('code'), { textContent: message }))
    box.append(more)
  }
  return box
}

// AIの種類ごとの行を描く。onSummary は行の段階が変わるたびに、全行の段階の一覧を受け取る（設定のホームの一行と札）。
// 返す stop は、設定を閉じる時に呼ぶ（見に行くのを止め、入力欄を空にする）。recheck は「すべて確認し直す」。
// Claudeは /api/accounts があれば1つ目/2つ目の2行。無い旧本体では従来の1行のまま。
export async function renderHarnessAuth(container, { api, onSummary = () => {} }) {
  const stops = [], rechecks = [], sections = [], stages = new Map()
  container.replaceChildren()
  const { harnesses } = await api('/api/harness-auth')
  const accounts = harnesses.some(harness => harness.id === 'claude') ? await api('/api/accounts').catch(() => null) : null
  const report = (key, value) => { stages.set(key, value); onSummary([...stages.values()]) }
  for (const harness of harnesses) {
    const item = harness.id === 'claude' && claudeAccounts(accounts)
      ? renderClaudeAccounts(harness, accounts, { api, renderSlotAuth: (target, options) => {
        const slotItem = harnessAuthItem(target, { api, ...options, onStage: stage => report(`claude:${options.slot}`, { name: harness.name, slot: options.slot, stage }) })
        rechecks.push(slotItem.recheck)
        return slotItem
      } })
      : harnessAuthItem(harness, { api, onStage: stage => report(harness.id, { name: harness.name, slot: null, stage }) })
    if (item.recheck) rechecks.push(item.recheck)
    if (item.refresh) sections.push(item)
    stops.push(item.stop)
    container.append(item.element)
  }
  return {
    refresh() { for (const section of sections) void section.refresh() },
    recheck() { for (const recheck of rechecks) void recheck(); for (const section of sections) void section.refresh() },
    stop() { for (const stop of stops) stop() },
  }
}

// slotがあれば、その枠の公式ログイン。枠は ?slot= だけで渡し、入力の本文は変えない（1つ目は従来と同じ要求）。
function harnessAuthItem(harness, { api, slot, title, label, signedOutAt = () => null, onAuthenticated, onStage = () => {} }) {
  const row = document.createElement(slot ? 'div' : 'section')
  row.className = slot ? 'harness-auth slot-auth' : 'feature-setting harness-auth'
  row.dataset.harnessId = harness.id
  const head = document.createElement('div')
  head.className = 'harness-auth-head'
  const status = document.createElement('p')
  status.setAttribute('role', 'status')
  const body = document.createElement('div')
  body.className = 'harness-auth-body'
  if (slot) {
    const names = document.createElement('div')
    names.append(Object.assign(document.createElement('h5'), { textContent: title ?? slot }))
    if (label) names.append(Object.assign(document.createElement('p'), { className: 'slot-label', textContent: label }))
    head.append(names, status)
  } else head.append(Object.assign(document.createElement('h4'), { textContent: harnessAuthTitle(harness) }), status)
  row.append(head, body)
  const base = `/api/harness-auth/${encodeURIComponent(harness.id)}`
  const query = slot && slot !== '1st' ? `?slot=${encodeURIComponent(slot)}` : ''
  const path = base + query
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
  let lastStage = null
  let timer
  let password
  const clear = () => { if (password) password.value = '' }
  const post = (action, payload) => api(`${base}/${action}${query}`, {
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
        if (JSON.stringify(next) !== JSON.stringify(auth)) { const before = auth?.status; auth = next; if (auth?.status === 'authenticated') { started = false; if (before !== 'authenticated') onAuthenticated?.() } render() }
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
      const before = auth?.status
      auth = (await action()).auth
      inputBlocked = false
      if (auth?.status === 'authenticated') started = false
      if (auth?.status === 'authenticated' && before !== 'authenticated' && loaded) onAuthenticated?.()
      loaded = true
    } catch (error) { errorText = error.message }
    finally { busy = false; if (!stopped) { render(); schedule() } }
  }
  function button(text, action, className = 'setup-action') {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = className
    item.textContent = text
    item.disabled = busy
    item.addEventListener('click', () => void action())
    return item
  }
  const read = () => perform(async () => { const next = await api(path); if (next.auth?.status === 'authenticated') started = false; return next })
  const start = () => perform(async () => { confirming = false; const next = await post('start'); started = next.auth?.status !== 'authenticated'; return next })
  const cancel = () => perform(async () => { await post('cancel'); started = false; return api(path) })
  const begin = () => { if (needsStartConfirmation(harness, auth)) { confirming = true; render() } else return start() }
  const sentence = text => Object.assign(document.createElement('p'), { className: 'auth-stage-text', textContent: text })
  function render() {
    clear()
    password = undefined
    const stage = inputBlocked ? 'unknown' : authStage({ auth, loaded, busy, signedOutAt: signedOutAt() })
    const meta = STAGES[stage]
    status.className = `harness-auth-status ${stage} tone-${meta.tone}`
    status.textContent = meta.badge
    if (stage !== lastStage) { lastStage = stage; onStage(stage) }
    const nodes = [], actions = document.createElement('div')
    actions.className = 'secret-actions'
    const relogin = slot ? 'ログインし直す' : '認証し直す'
    if (confirming) {
      const warning = Object.assign(document.createElement('p'), { className: 'form-error', textContent: harness.startWarning })
      warning.setAttribute('role', 'alert')
      nodes.push(warning)
      actions.append(button('今の認証を手放して始める', start, 'setup-action primary'), button('やめる', () => { confirming = false; render() }))
    } else if (stage === 'checking') {
      // 状態が分かるまで、何も押させない。
    } else if (stage === 'unknown') {
      nodes.push(sentence(inputBlocked ? '認証結果を確かめられませんでした。同じ入力を繰り返さず、「確認する」で読み直してください。' : meta.text))
      actions.append(button('確認する', read, 'setup-action primary'))
    } else if (stage === 'done') {
      // 使える行に主ボタンは置かない。やり直しは閉じた中にだけある。
      if (harness.reloginSupported === false) { if (harness.startWarning) nodes.push(sentence(harness.startWarning)) }
      else {
        const more = Object.assign(document.createElement('details'), { className: 'auth-more' })
        more.append(Object.assign(document.createElement('summary'), { textContent: 'やり直す' }), button(relogin, begin))
        nodes.push(more)
      }
    } else if (stage === 'needsLogin') {
      nodes.push(sentence(slot ? 'ログインし直してください。「ログイン」から公式サイトでログインします。' : meta.text))
      actions.append(button(slot ? 'ログイン' : '認証する', begin, 'setup-action primary'))
    } else if (stage === 'failed') {
      nodes.push(sentence(auth?.auth_ui?.message || meta.text))
      actions.append(button(relogin, begin, 'setup-action primary'))
    } else {
      nodes.push(sentence(meta.text))
      const flow = renderAuthFlow(auth, { name: harness.name, busy, plain: true, sendLabel: '認証コードを送る', sendClass: 'primary',
        respond: input => perform(async () => { try { return await post('input', input) } catch (error) { inputBlocked = true; throw error } }),
      })
      password = flow.password
      nodes.push(...flow.elements)
      if (started || auth?.session_id) actions.append(button('やめる', cancel))
    }
    if (actions.children.length) nodes.push(actions)
    if (errorText && !inputBlocked) nodes.push(failureNode(errorText))
    body.replaceChildren(...nodes)
  }
  // 利用人数にかかわらず、設定を開いた時に一度だけ公式の状態を確認する。
  const visibility = () => { if (document.hidden) { clearTimeout(timer); clear() } else schedule() }
  document.addEventListener('visibilitychange', visibility)
  void perform(() => api(path))
  return { element: row, render, recheck: read, stop() {
    stopped = true
    clearTimeout(timer)
    clear()
    document.removeEventListener('visibilitychange', visibility)
  } }
}

// 設定のホームの一行と札。最も悪い段階を言う。
export function authSummary(list) {
  const name = item => item.slot ? `${item.name} ${item.slot === '2nd' ? '2つ目' : '1つ目'}` : item.name
  if (!list.length) return { line: '確認しています', badge: '', tone: 'muted' }
  for (const stage of ['needsLogin', 'failed', 'unknown']) {
    const hit = list.find(item => item.stage === stage)
    if (hit) return { line: stage === 'needsLogin' ? `${name(hit)}のログインが必要` : stage === 'failed' ? `${name(hit)}の認証に失敗` : `${name(hit)}の状態を確認できません`, badge: STAGES[stage].badge, tone: 'attention' }
  }
  const waiting = list.find(item => ['waitingSite', 'waitingCode', 'confirming'].includes(item.stage))
  if (waiting) return { line: `${name(waiting)}の認証の途中`, badge: '途中', tone: 'info' }
  if (list.some(item => item.stage === 'checking')) return { line: '確認しています', badge: '', tone: 'muted' }
  return { line: 'すべて認証済み', badge: '認証済み', tone: 'ok' }
}
