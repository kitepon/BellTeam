// a485-lb-web part 2: what a logged-in Web does with the server's app sessions (usage/app-sessions.md sections 7c, 7e).
// Three small views on one API: login requests (許可 / 拒否), 「アプリを追加」 (a one-time code), and the session list with revoke.
// Present only when the probe says the request is authenticated by a session (`sessionId`); a server without sessions shows none of it.

const KINDS = { web: 'Web', apple: 'iPhone・iPad・Mac', windows: 'Windows', linux: 'Linux', android: 'Android' }
const ORIGINS = { phone: 'スマホで承認', console: 'サーバーのコードで入った', added: '「アプリを追加」で入った' }
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const time = value => { const at = Date.parse(value ?? ''); return Number.isFinite(at) ? new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(at) : '' }

export const ADD_APP_TEXT = 'この画面のコードは1回だけ使えて、10分で切れます。購読していない人は、このコードでブラウザー版に入れます。このコードで入ったものは、このアプリが終わると一緒に終わります。'
export const REQUEST_WARNING = '自分で始めたログインだけ許可してください。'

export function sessionRow(session) {
  const kind = KINDS[session.kind] ?? session.kind
  return {
    id: session.id, current: session.current === true,
    title: session.current ? `${kind}（このブラウザー）` : kind,
    line: [ORIGINS[session.origin], time(session.lastUsedAt) ? `最後の利用 ${time(session.lastUsedAt)}` : ''].filter(Boolean).join(' · '),
    revoke: session.current ? 'ログアウト' : '取り消す',
  }
}

export function requestRow(request) {
  const where = request.networkClass === 'lan' ? '同じネットワークから' : '場所を確かめられません（外から届いた可能性があります）'
  return { id: request.loginId, title: `${KINDS[request.kind] ?? request.kind}からのログイン要求`, line: [where, time(request.requestedAt)].filter(Boolean).join(' · ') }
}

const addAppFailure = error => error?.status === 429 ? 'いま出せるコードの数をこえています。使うか、10分待ってからもう一度押してください。' : 'コードを出せませんでした。通信を確かめて、もう一度押してください。'

// `requestsRoot` is the card in the roster column, `sessionsRoot` the block in the 接続 page; onLost() runs when this browser's own session ended.
export function createAppSessions({ api, requestsRoot, sessionsRoot, onLost = () => {}, onRequests = () => {} }) {
  const el = (tag, props = {}, ...children) => { const node = Object.assign(document.createElement(tag), props); node.append(...children); return node }
  const row = (title, line, ...buttons) => el('div', { className: 'app-session-row' }, el('span', { className: 'app-session-text' }, el('strong', { textContent: title }), el('small', { textContent: line })), ...buttons)
  const button = (text, run, className = '') => el('button', { type: 'button', className, textContent: text, onclick: async event => { const node = event.currentTarget; node.disabled = true; try { await run() } finally { node.disabled = false } } })
  let current = null, code = null, codeError = ''

  async function refreshRequests() {
    let list = []
    try { list = (await api('/api/login/requests')).requests ?? [] } catch { list = [] }
    requestsRoot.hidden = !list.length
    onRequests(list.length)
    requestsRoot.replaceChildren(...list.map(request => {
      const view = requestRow(request)
      return el('div', { className: 'login-request' }, row(view.title, view.line,
        button('許可する', async () => { await api(`/api/login/${encodeURIComponent(view.id)}/approve`, post({})).catch(() => {}); await refreshRequests() }, 'primary'),
        button('拒否する', async () => { await api(`/api/login/${encodeURIComponent(view.id)}/deny`, post({})).catch(() => {}); await refreshRequests() })),
        el('small', { className: 'field-help', textContent: REQUEST_WARNING }))
    }))
  }

  async function refreshSessions() {
    let sessions = null
    try { sessions = (await api('/api/sessions')).sessions } catch (error) { if (error?.status === 401) return onLost() }
    const children = []
    children.push(el('h4', { textContent: 'このサーバーに入っているアプリ' }))
    if (!sessions) children.push(el('p', { className: 'field-help', textContent: '一覧を読み込めませんでした。' }))
    else for (const session of sessions) {
      const view = sessionRow(session)
      children.push(row(view.title, view.line, button(view.revoke, async () => {
        try { await api(`/api/sessions/${encodeURIComponent(view.id)}`, { method: 'DELETE' }) } catch (error) { if (error?.status !== 404) return }
        if (view.current) return onLost()
        await refreshSessions()
      })))
    }
    children.push(el('h4', { textContent: 'アプリを追加' }),
      button('アプリを追加するコードを出す', async () => {
        codeError = ''
        try { code = await api('/api/login/code', post({})) } catch (error) { code = null; codeError = addAppFailure(error) }
        await refreshSessions()
      }, 'primary'))
    if (code && Date.parse(code.expiresAt ?? '') < Date.now()) code = null
    if (code) children.push(el('p', { className: 'login-code', textContent: code.code }), el('p', { className: 'field-help', textContent: ADD_APP_TEXT }))
    if (codeError) children.push(el('p', { className: 'form-error', role: 'alert', textContent: codeError }))
    sessionsRoot.replaceChildren(...children)
  }

  return {
    refresh: () => Promise.all([refreshRequests(), refreshSessions()]),
    // login.requested / session.created / session.ended on the event stream; true when it was one of these (the caller then skips its list reload).
    async onEvent(payload) {
      if (typeof payload?.type !== 'string' || !/^(login|session)\./u.test(payload.type)) return false
      await Promise.all([refreshRequests(), refreshSessions()])
      return true
    },
    refreshRequests,
  }
}
