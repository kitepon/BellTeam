// Claudeの「1stアカウント」「2ndアカウント」。表示文と時刻はexecutionの契約どおり。枠の選択・上限の判定はサーバーが持つ。
export const slotTitle = slot => ({ '1st': '1stアカウント', '2nd': '2ndアカウント' })[slot] ?? null

const jst = (iso, part) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', ...part }).format(new Date(iso))

// JSTの時刻。今日（JST）でなければ日付も付ける。
export function resetTime(iso, now = Date.now()) {
  if (!iso || Number.isNaN(Date.parse(iso))) return null
  const time = jst(iso, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const day = { month: 'numeric', day: 'numeric' }
  return jst(iso, day) === jst(now, day) ? time : `${jst(iso, day)} ${time}`
}

// 'all' → 上限中 (HH:MMに解除)、系統 → Fableのみ上限中 (HH:MMに解除)、解除時刻が無い → 解除時刻不明
export function limitText(scope, resetAt, now = Date.now()) {
  const time = resetTime(resetAt, now)
  const family = typeof scope === 'string' && scope !== 'all' && scope ? `${scope[0].toUpperCase()}${scope.slice(1)}のみ` : ''
  return `${family}上限中 (${time ? `${time}に解除` : '解除時刻不明'})`
}

export function claudeAccounts(list) {
  return Array.isArray(list?.harnesses) ? list.harnesses.find(item => item?.harness === 'claude' && Array.isArray(item.slots)) ?? null : null
}

export function bannerTexts(list, now = Date.now()) {
  const allLimited = claudeAccounts(list)?.allLimited
  return Array.isArray(allLimited) ? allLimited.map(item => `両方のアカウントで${limitText(item?.scope, item?.earliestResetAt, now)}`) : []
}

// 1枠分の表示。欠けた値は推測せず「未確認」にする。
export function slotView(slot, now = Date.now()) {
  const limits = Array.isArray(slot?.limits) ? slot.limits : []
  const login = slot?.loggedIn === true ? (slot.label || 'ログイン済み') : slot?.loggedIn === false ? '未ログイン' : 'ログイン状態は未確認'
  return {
    slot: slot?.slot,
    title: slotTitle(slot?.slot),
    login,
    state: limits.length ? limits.map(item => limitText(item?.scope, item?.resetAt, now)).join('・') : slot?.loggedIn === true ? '利用できます' : '',
    limited: limits.length > 0,
    seats: Array.isArray(slot?.seats) ? slot.seats.length : null,
    separate: slot?.history === 'separate',
  }
}

// 一覧の行に出す、席が今使っている枠。旧本体（項目なし）とnullは何も出さない。
export function seatBadge(account) {
  const title = account?.harness === 'claude' ? slotTitle(account.slot) : null
  return title ? { text: title, title: `${title}で動作中` } : null
}

// 設定のClaude欄。renderSlotAuthは既存のharness-auth行（slot付き）を作る関数で、harness-auth.jsが渡す。
export function renderClaudeAccounts(harness, list, { api, renderSlotAuth, now = () => Date.now() }) {
  const section = document.createElement('section')
  section.className = 'feature-setting harness-auth harness-accounts'
  section.dataset.harnessId = 'claude'
  const heading = document.createElement('h4')
  const banner = document.createElement('p')
  banner.className = 'accounts-banner'
  banner.setAttribute('role', 'status')
  const rows = document.createElement('div')
  rows.className = 'account-slots'
  section.append(heading, banner, rows)
  const stops = []
  const slotRows = new Map()
  let current = list
  let stopped = false

  function paint() {
    heading.textContent = harness.members > 0 ? `${harness.name} · ${harness.members}人が使用` : `${harness.name} · 使用していません`
    const texts = bannerTexts(current, now())
    banner.hidden = !texts.length
    banner.textContent = texts.join(' / ')
    for (const slot of claudeAccounts(current)?.slots ?? []) {
      const view = slotView(slot, now())
      if (!view.title) continue
      let row = slotRows.get(view.slot)
      if (!row) {
        row = { element: document.createElement('div'), info: document.createElement('dl') }
        row.element.className = 'account-slot'
        row.element.dataset.slot = view.slot
        const title = Object.assign(document.createElement('h5'), { textContent: view.title })
        const auth = renderSlotAuth(harness, { slot: view.slot, onAuthenticated: () => void refresh() })
        stops.push(auth.stop)
        row.element.append(title, row.info, auth.element)
        rows.append(row.element)
        slotRows.set(view.slot, row)
      }
      row.element.classList.toggle('limited', view.limited)
      const items = [['アカウント', view.login], ['状態', view.state || '—'], ['使用中', view.seats === null ? '未確認' : `${view.seats}人`]]
      if (view.separate) items.push(['会話の履歴', '1stアカウントと分かれています'])
      row.info.replaceChildren(...items.flatMap(([term, value]) => [
        Object.assign(document.createElement('dt'), { textContent: term }),
        Object.assign(document.createElement('dd'), { textContent: value, className: term === '状態' && view.limited ? 'limited' : '' }),
      ]))
    }
  }
  async function refresh() {
    try { const next = await api('/api/accounts'); if (!stopped && claudeAccounts(next)) { current = next; paint() } } catch { /* 前の表示を残す。読めない時に状態を作らない */ }
  }
  paint()
  return { element: section, refresh, stop() { stopped = true; for (const stop of stops) stop() } }
}
