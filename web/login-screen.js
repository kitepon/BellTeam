// a485-lb-web: the "show this code and wait" login of a server that issues its own sessions (usage/app-sessions.md sections 2, 2a, 4).
// The server sets the HttpOnly cookie `bellteam_session` itself; this page never sees a token and holds no pass.
// Wire facts: usage/app-sessions.md section 7 (kind web, carrier cookie: the body never has a token).

const POLL_MS = 3000
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const WEB = { kind: 'web', carrier: 'cookie' }
// phone.qrSvg is a ready SVG string from the server. It goes only into an <img> as a data URL (an image cannot run script), never inline; anything that is not an <svg> document is dropped.
const svgDataUrl = value => typeof value === 'string' && value.length < 200_000 && /^\s*(<\?xml[^>]*\?>\s*)?<svg[\s>]/u.test(value) ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(value)}` : ''

// An older server has no `login` key in /api/session: the Web keeps today's path (Cloudflare Access / local).
export const loginNeeded = session => session?.authenticated === false && session.login != null && typeof session.login === 'object'

// 7a: a server that cannot judge a session right now (restart, rollback) answers 503 SESSION_STORE_UNAVAILABLE: that is not a logout.
// Say it is getting ready and ask again (1, 2, 4 ... 30 s) until it answers; only a definite 401 means log in again, and it is not retried here.
export async function readSession(api, { onWaiting = () => {}, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let delay = 1000; ; delay = Math.min(delay * 2, 30000)) {
    try { return await api('/api/session') } catch (error) {
      if (error?.code !== 'SESSION_STORE_UNAVAILABLE') throw error
      onWaiting()
      await wait(delay)
    }
  }
}

const refusedText = reason => reason === 'not_owner_account' ? 'このサーバーのオーナーのアカウントではないため、入れませんでした。'
  : reason === 'phone_denied' ? '携帯で拒否されました。' : '許可されませんでした。'
const EXPIRED = 'ログインの時間が切れました。もう一度お試しください。'

// Pure: what the screen says for one state. Never shows anything but the text, the code and the check number the server gave.
export function loginView(state) {
  if (state.phase === 'ended') return { heading: '接続できませんでした', notes: [state.message], code: '', check: '', qr: '', until: '', again: true, cancel: false }
  if (state.phase === 'second_hand') return {
    heading: '承認を待っています',
    notes: ['すでにログインしているアプリか、サーバーのコンソールで、このログインを許可してください。', '自分で始めたログインだけ許可してください。'],
    code: '', check: '', qr: '', until: '', again: false, cancel: true,
  }
  if (state.phase === 'phone') return {
    heading: 'このコードを、BellTeamアプリで承認してください',
    notes: ['iPhone・Macなどの BellTeam アプリで、このサーバーのログインを承認します。アプリに下のコードを入力し、照合番号が同じか確かめてください。'],
    code: state.code, check: state.check, qr: svgDataUrl(state.qr), until: state.expiresAt ? untilText(state.expiresAt) : '', again: false, cancel: true,
  }
  return { heading: 'つないでいます…', notes: [], code: '', check: '', qr: '', until: '', again: false, cancel: false }
}

function untilText(expiresAt) {
  const at = Date.parse(expiresAt)
  return Number.isFinite(at) ? `${new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' }).format(at)} まで有効` : ''
}

const startFailure = error => error?.status === 429 ? '今はログインを始められません。少し待って、もう一度押してください。'
  : error?.code === 'LOGIN_OPERATOR_UNREACHABLE' ? '携帯での承認を始められませんでした。サーバーのコンソールで発行したコードなら、下に入力して入れます。'
  : 'ログインを始められませんでした。通信を確かめて、もう一度押してください。'

// The login loop, with the page kept out: show(state) draws, onApproved() boots the app again (the cookie is already set by the server).
// A transient poll failure keeps waiting; the login ends only by what the server says (approved, refused, expired/unknown) or by 「やめる」.
export function createLogin({ api, show, onApproved, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let generation = 0, loginId = null
  const end = message => show({ phase: 'ended', message })

  async function start() {
    const mine = ++generation
    show({ phase: 'starting' })
    let login
    try { login = await api('/api/login/start', post(WEB)) } catch (error) { if (mine === generation) end(startFailure(error)); return }
    loginId = login.loginId
    while (mine === generation) {
      if (login.status === 'approved' || login.status === 'delivered') return onApproved()
      if (login.status === 'refused') return end(refusedText(login.reason))
      if (login.status === 'expired') return end(EXPIRED)
      if (login.status === 'cancelled') return end('取り消しました。')
      if (login.status === 'waiting_phone' && login.phone) show({ phase: 'phone', code: login.phone.shortCode ?? '', check: login.phone.checkNumber ?? '', qr: login.phone.qrSvg, expiresAt: login.expiresAt })
      else show({ phase: 'second_hand' })
      const delay = Number.isFinite(login.pollAfterMs) && login.pollAfterMs >= 2000 ? login.pollAfterMs : POLL_MS
      await wait(delay)
      if (mine !== generation) return
      try { login = await api(`/api/login/${encodeURIComponent(loginId)}`) } catch (error) {
        if (error.status === 404) return end(EXPIRED)
        // transient (or 429 LOGIN_RATE_LIMITED): the server may still approve; ask again, a little slower
        login = { ...login, pollAfterMs: Math.min(delay * 2, 30000) }
      }
    }
  }

  async function cancel() {
    generation++
    const id = loginId
    loginId = null
    if (id) await api(`/api/login/${encodeURIComponent(id)}/cancel`, post({})).catch(() => {})
    end('やめました。')
  }

  // The code the owner printed on the server console (POST /api/login/console); success sets the cookie like an approval.
  async function useConsoleCode(code) {
    try { await api('/api/login/console', post({ code, ...WEB })) } catch (error) {
      return error?.status === 429 ? 'しばらくしてから、もう一度お試しください。'
        : error?.status >= 400 && error.status < 500 ? 'コードが違うか、期限が切れています。' : '確かめられませんでした。通信を確かめて、もう一度お試しください。'
    }
    generation++
    onApproved()
    return ''
  }

  return { start, cancel, useConsoleCode }
}

// Draws loginView(state) and the console-code field into `root`. Written with createElement/textContent only (the server text is not HTML).
export function mountLoginScreen(root, { api, onApproved }) {
  const el = (tag, props = {}, ...children) => { const node = Object.assign(document.createElement(tag), props); node.append(...children); return node }
  let login
  // The console form is built once: the screen is redrawn on every poll and must not clear what the owner is typing.
  const consoleError = el('p', { className: 'form-error', role: 'alert' })
  const input = el('input', { type: 'text', autocomplete: 'off', spellcheck: false, placeholder: 'XXXX-XXXX-XXXXX', maxLength: 32, className: 'login-console-input' })
  const use = el('button', { type: 'submit', className: 'primary-button', textContent: 'このコードを使う' })
  const form = el('form', { className: 'login-console' }, el('p', { className: 'field-help', textContent: 'サーバーのコンソールで出したコード、または「アプリを追加」で出したコードを入力します。' }), input, use, consoleError)
  form.addEventListener('submit', async event => {
    event.preventDefault()
    if (!input.value.trim()) return
    use.disabled = true
    consoleError.textContent = await login.useConsoleCode(input.value.trim())
    use.disabled = false
  })
  let codeWay = true
  // app-sessions.md 7e (Owner fact: the browser version is the free way): this line goes under the code field, in the same words in the docs and every app's Web version.
  const FREE_WEB = 'ブラウザー版は購読なしで使えます。サーバーのコンソールで出したコード、またはすでに入っているアプリの「アプリを追加」で出したコードで入れます。'
  function show(state) {
    const view = loginView(state)
    const phone = el('section', { className: 'login-way' }, el('h3', { textContent: 'スマホで承認する' }), el('p', { className: 'login-status', textContent: view.heading }), ...view.notes.map(text => el('p', { textContent: text })))
    if (view.qr) phone.append(el('img', { className: 'login-qr', src: view.qr, alt: 'BellTeamアプリで読み取るQRコード' }))
    if (view.code) phone.append(el('p', { className: 'login-code', textContent: view.code }), el('p', { className: 'login-check', textContent: `照合番号 ${view.check}` }))
    if (view.until) phone.append(el('p', { className: 'field-help', textContent: view.until }))
    if (view.cancel) phone.append(el('button', { type: 'button', className: 'text-button', textContent: 'やめる', onclick: () => void login.cancel() }))
    if (view.again) phone.append(el('button', { type: 'button', className: 'primary-button', textContent: 'もう一度', onclick: () => void login.start() }))
    const card = el('section', { className: 'login-card' }, el('h2', { textContent: 'このサーバーにログインします' }), phone)
    if (codeWay) card.append(el('section', { className: 'login-way' }, el('h3', { textContent: 'サーバーのコードで入る' }), form, el('p', { className: 'field-help', textContent: FREE_WEB })))
    root.replaceChildren(card)
  }
  login = createLogin({ api, show, onApproved: () => { root.hidden = true; onApproved() } })
  // `info` is the probe's `login` object: the code way is shown whenever the server answers capability true (the contract is unknown to the app).
  return { open(info) { codeWay = info?.capability !== false; root.hidden = false; return login.start() } }
}
