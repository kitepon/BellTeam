import { authFlowView, renderAuthFlow } from './auth-flow.js?v=__ASSET_VERSION__'

export function openOnboarding(initial, { api, onReady, onLater }) {
  const dialog = document.createElement('dialog')
  dialog.className = 'sheet-dialog onboarding-dialog'
  dialog.setAttribute('aria-label', 'BellTeamの初回設定')
  const content = document.createElement('div')
  content.className = 'sheet-body onboarding-body'
  dialog.append(content)
  document.body.append(dialog)
  let setup = initial
  let busy = false
  let revision = 0
  let inputBlocked = false
  let stopped = false
  let ready = false
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
    if (!ready) void onLater?.(setup)
  }, { once: true })
  let choosing = false // 「別のAIを選ぶ」 shows the AI tiles again without changing anything yet.
  function button(label, action, primary = false) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = primary ? 'primary-button' : 'setup-action'
    item.textContent = busy && primary ? `${label}…` : label
    item.disabled = busy
    item.addEventListener('click', () => void perform(action))
    return item
  }
  function schedule() {
    clearTimeout(timer)
    if (stopped || document.hidden || errorText || !['open_url', 'device_code', 'paste_code', 'select', 'waiting'].includes(authFlowView(setup.auth).stage)) return
    timer = setTimeout(async () => {
      if (busy) { schedule(); return }
      const observedRevision = ++revision
      try {
        const next = await api('/api/setup')
        if (stopped || observedRevision !== revision) return
        // 状態が同じ間は、入力中の認証欄を作り直さない。
        if (JSON.stringify(next) !== JSON.stringify(setup)) { setup = next; render() }
        schedule()
      } catch (error) { if (stopped || observedRevision !== revision) return; errorText = error.message; render() }
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
    revision++
    clearTimeout(timer)
    errorText = ''
    clear()
    render()
    try {
      setup = await action()
      inputBlocked = false
      if (setup.phase === 'ready') { ready = true; await onReady(setup); dialog.close(); return }
    } catch (error) { errorText = error.message }
    finally { busy = false; if (!stopped) { render(); schedule() } }
  }
  // W84: a stepper (1 AIを選ぶ / 2 ログイン / 3 始める) and one primary button per stage, as in user-paths.md section 8.
  function render() {
    clear()
    const name = setup.harnesses.find(h => h.id === setup.harness)?.name ?? 'AI'
    const view = setup.auth ? authFlowView(setup.auth) : null
    const picking = setup.phase === 'select_harness' || choosing
    const step = picking ? 1 : view?.stage === 'complete' ? 3 : 2
    const title = document.createElement('h2')
    title.textContent = 'BellTeamを始める'
    const steps = document.createElement('ol')
    steps.className = 'setup-steps'
    for (const [index, label] of ['AIを選ぶ', 'ログイン', '始める'].entries()) {
      const item = Object.assign(document.createElement('li'), { textContent: label })
      if (index + 1 === step) { item.className = 'is-current'; item.setAttribute('aria-current', 'step') } else if (index + 1 < step) item.className = 'is-done'
      steps.append(item)
    }
    content.replaceChildren(title, steps)
    if (picking) {
      content.append(Object.assign(document.createElement('p'), { textContent: '最初に使うAIを選んでください。選ぶと、そのAIの公式ログインが始まります。' }))
      const cards = document.createElement('div')
      cards.className = 'harness-cards'
      for (const harness of setup.harnesses) cards.append(button(harness.name, () => { choosing = false; return post('harness', { harness: harness.id }) }))
      content.append(cards)
      if (choosing) {
        const back = Object.assign(document.createElement('button'), { type: 'button', className: 'text-button', textContent: `${name}のまま進める` })
        back.addEventListener('click', () => { choosing = false; render() })
        content.append(back)
      }
    } else {
      content.append(Object.assign(document.createElement('h3'), { textContent: `${name}にログイン` }))
      const restart = () => post('harness', { harness: setup.harness }) // choosing the same AI again starts a new login
      if (view?.stage === 'complete') {
        content.append(Object.assign(document.createElement('p'), { textContent: 'ログインできました。「始める」を押すと、案内役との会話が開きます。' }), button('始める', () => post('start'), true))
      } else if (view?.stage === 'not_started') {
        content.append(Object.assign(document.createElement('p'), { textContent: `${name}の公式サイトでログインします。` }), button('ログインを始める', restart, true))
      } else if (view?.stage === 'unavailable' || view?.stage === 'failed' || inputBlocked) {
        content.append(Object.assign(document.createElement('p'), { textContent: view?.message || 'ログインの途中で止まりました。もう一度試してください。', className: 'form-error' }), button('もう一度試す', restart, true))
      } else if (setup.auth) {
        const flow = renderAuthFlow(setup.auth, { name, busy, sendLabel: 'ログインを完了', sendClass: 'primary-button',
          respond: input => perform(async () => { try { return await post('auth/input', input) } catch (error) { inputBlocked = true; throw error } }),
        })
        password = flow.password
        content.append(...flow.elements)
        // Back from the login site (open_url / device_code / waiting): one check that never starts the conversation by itself.
        if (['open_url', 'device_code', 'waiting'].includes(view?.stage)) content.append(button('ログインを確かめる', () => api('/api/setup')))
      }
      const other = Object.assign(document.createElement('button'), { type: 'button', className: 'text-button', textContent: '別のAIを選ぶ' })
      other.disabled = busy
      other.addEventListener('click', () => { choosing = true; render() })
      content.append(other)
    }
    // W85: a failed read or action says so here and carries its own retry, which also restarts the 3 s check.
    if (errorText) {
      const box = Object.assign(document.createElement('div'), { className: 'inline-error' })
      box.append(Object.assign(document.createElement('p'), { textContent: errorText }))
      const again = Object.assign(document.createElement('button'), { type: 'button', textContent: 'もう一度試す' })
      again.disabled = busy
      again.addEventListener('click', () => void perform(() => api('/api/setup')))
      box.append(again)
      content.append(box)
    }
    const later = Object.assign(document.createElement('button'), { type: 'button', className: 'text-button setup-later', textContent: 'あとで設定する' })
    later.addEventListener('click', () => dialog.close())
    content.append(later)
  }
  render()
  dialog.showModal()
  schedule()
}

// 機能ごとの一文。サーバーの title は名前だけなので、何をする機能かをここで言う。
const FEATURE_SENTENCES = {
  routing: 'ルームで、誰が返事をするかをAIが選びます。', callBridge: 'ほかのチームのメンバーと話せるようにします。',
  cloudflare: '外からこのBellTeamを開けるようにします。', diagnostics: '困った時の情報を、担当へ送れるようにします。',
  notifications: 'iPhoneアプリへ通知を送ります。', webPush: 'ブラウザーへ通知を送ります。', onePassword: '1Passwordの鍵やパスワードを使えるようにします。',
}
// 必須の欄が空のまま「使っています」と言わない。required が無い旧本体では判定しない。
export const missingRequired = setting => (setting.fields ?? []).some(field => field.required === true && !field.configured)
export function featureState(setting) {
  if (setting.error) return { key: 'failed', badge: 'エラー', tone: 'attention' }
  if (setting.status === 'enabled' && missingRequired(setting)) return { key: 'missing', badge: '設定が足りません', tone: 'attention' }
  return ({ enabled: { key: 'on', badge: '使っています', tone: 'ok' }, disabled: { key: 'off', badge: '使っていません', tone: 'muted' } })[setting.status] ?? { key: 'unset', badge: '未設定', tone: 'muted' }
}
// 1Password連携は接続の結果を、見出しのバッジ（連携中・未連携・失敗）で示す。
const onePasswordState = setting => setting.error ? 'failed' : setting.status === 'enabled' ? 'connected' : 'off'
function renderFeatureSummary(summary, setting) {
  const name = Object.assign(document.createElement('span'), { className: 'feature-name', textContent: setting.title })
  const sentence = Object.assign(document.createElement('span'), { className: 'feature-sentence', textContent: FEATURE_SENTENCES[setting.id] ?? '' })
  let badge
  if (setting.id === 'onePassword') {
    const state = onePasswordState(setting)
    badge = Object.assign(document.createElement('span'), { className: `feature-badge ${state}`, textContent: { connected: '連携中', off: '未連携', failed: '失敗' }[state] })
  } else {
    const state = featureState(setting)
    badge = Object.assign(document.createElement('span'), { className: `feature-badge tone-${state.tone}`, textContent: state.badge })
  }
  const action = Object.assign(document.createElement('span'), { className: 'feature-action', textContent: setting.status === 'unconfigured' && !setting.error ? '設定する' : '変更' })
  summary.replaceChildren(name, badge, sentence, action)
}
// 符号は閉じた「詳細」へ。文は平易な一文だけ見せる。
function setFailure(node, message, code) {
  node.replaceChildren(Object.assign(document.createElement('span'), { textContent: message }))
  if (code) {
    const more = document.createElement('details')
    more.append(Object.assign(document.createElement('summary'), { textContent: '詳細' }), Object.assign(document.createElement('code'), { textContent: code }))
    node.append(more)
  }
}
function onePasswordConnectionText(setting) {
  if (onePasswordState(setting) !== 'connected') return ''
  const connection = setting.connection
  if (!connection) return '1Passwordにつながっています。'
  const vaults = connection.vaults.length ? connection.vaults.join('、') : 'なし'
  return connection.sshKeys
    ? `読める保管庫：${vaults}　SSH鍵：${connection.sshKeys}件`
    : `読める保管庫：${vaults}　SSH鍵が見つかりません。読める保管庫にSSH鍵を入れるか、サービスアカウントに鍵のある保管庫を足してください。`
}
function updateOnePasswordView(details, setting) {
  const line = details.querySelector('.feature-connection'), guide = details.querySelector('.feature-guide-toggle')
  if (line) { line.textContent = onePasswordConnectionText(setting); line.hidden = !line.textContent }
  const connected = onePasswordState(setting) === 'connected'
  // 連携の状態が変わった時だけ開閉し、読んでいる途中の案内は閉じない。
  if (guide && guide.dataset.connected !== String(connected)) { guide.open = !connected; guide.dataset.connected = String(connected) }
}
// 「保存して連携を確かめる」の結果を、押したボタンのそばに言葉で返す。PATCH応答の項目だけで決める。
function onePasswordResultText(setting) {
  const state = onePasswordState(setting)
  if (state === 'failed') return `連携できませんでした。${setting.error.message}`
  if (state === 'connected') return `連携できました。${setting.connection ? onePasswordConnectionText(setting) : ''}`
  return '連携を解除しました。'
}
// The 1Password result line is the card's one place for its failure reason (no separate top alert).
function showOnePasswordResult(result, setting, { saved = false } = {}) {
  const state = onePasswordState(setting)
  if (!saved && state !== 'failed') { if (result.dataset.state === 'failed') result.hidden = true; return }
  Object.assign(result, { textContent: onePasswordResultText(setting), hidden: false })
  result.dataset.state = state
}

function renderFeatureGuide(guide) {
  const box = document.createElement('div')
  box.className = 'feature-guide'
  for (const step of guide.steps) box.append(Object.assign(document.createElement('p'), { textContent: step }))
  let url
  try { url = new URL(guide.link.url) } catch {}
  if (url?.protocol === 'https:') {
    const link = Object.assign(document.createElement('a'), { href: url.href, textContent: guide.link.label, target: '_blank', rel: 'noopener noreferrer' })
    link.referrerPolicy = 'no-referrer'
    box.append(link)
  }
  return box
}

// 設定変更の通知では入力中のフォームを保ち、状態とエラーだけを更新する。
export function refreshFeatureSettingsStatus(container, settings) {
  for (const setting of settings) {
    const details = [...container.children].find(item => item.dataset.featureId === setting.id)
    if (!details) continue
    renderFeatureSummary(details.children[0], setting)
    if (setting.id === 'onePassword') {
      updateOnePasswordView(details, setting)
      const result = details.querySelector('.feature-result')
      if (result && result.dataset.state !== 'checking') showOnePasswordResult(result, setting)
    }
    for (const field of setting.fields ?? []) {
      if (!field.secret) continue
      const input = [...details.querySelectorAll('input')].find(input => input.dataset.fieldKey === field.key)
      if (input) input.placeholder = field.configured ? '登録済み・変更するときだけ入力' : '未設定'
    }
    let failure = details.querySelector('.feature-application-error')
    if (setting.error && setting.id !== 'onePassword') {
      if (!failure) {
        failure = document.createElement('p')
        failure.className = 'form-error feature-application-error'
        failure.setAttribute('role', 'alert')
        details.append(failure)
      }
      setFailure(failure, setting.error.message, setting.error.code)
    } else failure?.remove()
  }
}

// 入力したまま保存していない機能があるか（設定を閉じる・ほかの項目へ移る時に聞く）。
export const featureFormsDirty = container => [...(container?.querySelectorAll?.('form[data-dirty]') ?? [])].length > 0
// 保存の応答を待っている機能があるか（閉じる時に「保存処理中です」と聞く）。
export const featureFormsSaving = container => [...(container?.querySelectorAll?.('form[data-saving]') ?? [])].length > 0

export function renderFeatureSettings(container, settings, { api, onChange }) {
  container.replaceChildren()
  for (const setting of settings) {
    const details = document.createElement('details')
    details.className = 'feature-setting'
    details.dataset.featureId = setting.id
    const summary = document.createElement('summary')
    renderFeatureSummary(summary, setting)
    const form = document.createElement('form')
    const toggle = document.createElement('label')
    toggle.className = 'feature-toggle'
    const enabled = document.createElement('input')
    enabled.type = 'checkbox'
    // 1Password連携は、トークンを貼って保存すれば連携する。解除はチェックを外して保存する。
    const onePassword = setting.id === 'onePassword'
    enabled.checked = setting.enabled || onePassword && setting.status === 'unconfigured'
    toggle.append(enabled, document.createTextNode(onePassword ? '1Passwordと連携する' : 'この機能を使う'))
    if (onePassword) form.append(Object.assign(document.createElement('p'), { className: 'feature-connection' }))
    if (setting.guide) {
      const guide = Object.assign(document.createElement('details'), { className: 'feature-guide-toggle' })
      guide.append(Object.assign(document.createElement('summary'), { textContent: '作り方を見る' }), renderFeatureGuide(setting.guide))
      form.append(guide)
    }
    form.append(toggle)
    const inputs = []
    for (const field of setting.fields) {
      const label = document.createElement('label')
      label.className = 'field'
      label.append(Object.assign(document.createElement('span'), { textContent: field.label }))
      const input = document.createElement('input')
      input.type = field.secret ? 'password' : 'text'
      input.dataset.fieldKey = field.key
      input.value = field.secret ? '' : field.value
      input.autocomplete = 'off'
      input.autocapitalize = 'none'
      input.spellcheck = false
      if (field.secret) input.placeholder = field.configured ? '登録済み・変更するときだけ入力' : '未設定'
      if (field.required === true) input.setAttribute('aria-required', 'true')
      if (onePassword) input.setAttribute('data-1p-ignore', '')
      inputs.push({ field, input })
      label.append(input)
      form.append(label)
    }
    const error = document.createElement('p')
    error.className = 'form-error'
    error.setAttribute('role', 'alert')
    const save = document.createElement('button')
    save.type = 'submit'
    save.textContent = onePassword ? '保存して連携を確かめる' : '保存'
    save.className = 'primary'
    const result = Object.assign(document.createElement('p'), { className: 'feature-result', hidden: true })
    // 送った後に打った入力は、保存の応答で消さない。版の番号で、送った時から変わったかを見る。
    let revision = 0
    form.addEventListener('input', () => { revision++; form.dataset.dirty = '1' })
    result?.setAttribute('role', 'status')
    form.append(error, result, save)
    form.addEventListener('submit', async event => {
      event.preventDefault()
      if (save.disabled) return
      save.disabled = true
      form.dataset.saving = '1'
      error.textContent = ''
      if (!onePassword) { save.textContent = '保存しています…'; result.hidden = true; result.dataset.state = '' }
      if (onePassword) {
        save.textContent = '連携を確かめています…'
        save.setAttribute('aria-busy', 'true')
        Object.assign(result, { textContent: '1Passwordにつないで確かめています…', hidden: false })
        result.dataset.state = 'checking'
      }
      const values = Object.fromEntries(inputs.filter(({ field, input }) => !field.secret || input.value).map(({ field, input }) => [field.key, input.value]))
      const submittedEnabled = enabled.checked
      const sentRevision = revision, sentValues = inputs.map(({ input }) => input.value)
      let saved = false
      try {
        const response = await api(`/api/settings/${encodeURIComponent(setting.id)}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: submittedEnabled, values }),
          redirect: 'error', cache: 'no-store', credentials: 'same-origin',
        })
        saved = true
        // 秘密の値は、保存できたと分かってから消す。失敗した時は貼り直させない。
        inputs.forEach(({ field, input }, index) => { if (field.secret && input.value === sentValues[index]) input.value = '' })
        if (revision === sentRevision) delete form.dataset.dirty
        if (onePassword && response?.setting) showOnePasswordResult(result, response.setting, { saved: true })
        else if (onePassword) { result.hidden = true; result.dataset.state = '' }
        else { Object.assign(result, { textContent: '保存しました。', hidden: false }); result.dataset.state = 'connected' }
        await onChange()
      } catch (cause) {
        if (setting.id === 'cloudflare' && submittedEnabled && (cause.status === 401 || cause.status === 403 || cause instanceof TypeError)) {
          error.textContent = '外部接続の保存後に認証が必要になった可能性があります。再読み込みしてログインしてください。'
          const login = document.createElement('button')
          login.type = 'button'
          login.textContent = '再読み込みしてログイン'
          login.addEventListener('click', () => location.reload())
          error.append(login)
        } else if (saved) error.textContent = '保存しました。表示を新しくできなかったので、設定を開き直すと確かめられます。'
        else setFailure(error, /^[A-Z0-9_]+$/u.test(cause.message ?? '') ? '保存できませんでした。入力を確かめて、もう一度保存してください。' : `保存できませんでした。${cause.message}`, /^[A-Z0-9_]+$/u.test(cause.message ?? '') ? cause.message : '')
        if (!saved) { result.hidden = true; result.dataset.state = '' }
      } finally {
        save.disabled = false
        delete form.dataset.saving
        if (onePassword) { save.textContent = '保存して連携を確かめる'; save.removeAttribute('aria-busy') } else save.textContent = '保存'
      }
    })
    details.append(summary)
    if (setting.error && !onePassword) {
      const failure = document.createElement('p')
      failure.className = 'form-error feature-application-error'
      failure.setAttribute('role', 'alert')
      setFailure(failure, setting.error.message, setting.error.code)
      details.append(failure)
    }
    details.append(form)
    if (onePassword) { updateOnePasswordView(details, setting); showOnePasswordResult(result, setting) }
    container.append(details)
  }
}
