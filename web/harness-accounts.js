// Claudeの「1つ目のアカウント」「2つ目のアカウント」（Appleと同じ名前）。時刻はexecutionの契約どおり。枠の選択・上限の判定はサーバーが持つ。
export const slotTitle = slot => ({ '1st': '1つ目のアカウント', '2nd': '2つ目のアカウント' })[slot] ?? null

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

// 上限の一行（Appleと同じ文）。「上限中・11/13 17:00 に戻ります（いまは2つ目で動いています）」。
// 括弧は、この枠だけが上限でもう一方が使える時だけ。どちらへ動くかはサーバーが決めるので、使える方を言うだけにする。
export function slotLimitLines(slot, other, now = Date.now()) {
  const limits = Array.isArray(slot?.limits) ? slot.limits : []
  const otherFree = other && other.loggedIn === true && !(Array.isArray(other.limits) && other.limits.length)
  const moved = otherFree ? `（いまは${other.slot === '2nd' ? '2つ目' : '1つ目'}で動いています）` : ''
  return limits.map(item => {
    const scope = item?.scope, time = resetTime(item?.resetAt, now)
    const family = typeof scope === 'string' && scope !== 'all' && scope ? `${scope[0].toUpperCase()}${scope.slice(1)}が` : ''
    return `${family}上限中・${time ? `${time} に戻ります` : '戻る時刻は分かりません'}${moved}`
  })
}

// 設定のClaude欄。renderSlotAuthは既存のharness-auth行（slot付き）を作る関数で、harness-auth.jsが渡す。
// アカウントのメールアドレスは、どのアカウントでログインするかを見分けるため、この画面でだけ枠の名前の下に出す（トロニー裁定 2026-11-11）。
export function renderClaudeAccounts(harness, list, { api, renderSlotAuth, now = () => Date.now() }) {
  const section = document.createElement('section')
  section.className = 'feature-setting harness-auth harness-accounts'
  section.dataset.harnessId = 'claude'
  const heading = document.createElement('h4')
  const rows = document.createElement('div')
  rows.className = 'account-slots'
  section.append(heading, rows)
  const stops = [], renders = []
  const slotRows = new Map()
  let current = list
  let stopped = false
  const slots = () => claudeAccounts(current)?.slots ?? []

  function paint() {
    heading.textContent = harness.members > 0 ? `${harness.name} · ${harness.members}人が使用` : `${harness.name} · 使用していません`
    for (const slot of slots()) {
      const title = slotTitle(slot?.slot)
      if (!title) continue
      let row = slotRows.get(slot.slot)
      if (!row) {
        row = { element: document.createElement('div'), limit: document.createElement('p') }
        row.element.className = 'account-slot'
        row.element.dataset.slot = slot.slot
        row.limit.className = 'account-limit'
        const auth = renderSlotAuth(harness, { slot: slot.slot, title, label: slot.label || null,
          signedOutAt: () => slots().find(item => item?.slot === slot.slot)?.signedOutAt ?? null, onAuthenticated: () => void refresh() })
        stops.push(auth.stop)
        if (auth.render) renders.push(auth.render)
        row.element.append(auth.element, row.limit)
        rows.append(row.element)
        slotRows.set(slot.slot, row)
      }
      const lines = slotLimitLines(slot, slots().find(item => item?.slot && item.slot !== slot.slot), now())
      row.element.classList.toggle('limited', lines.length > 0)
      row.limit.textContent = lines.join('\n')
      row.limit.hidden = !lines.length
    }
  }
  async function refresh() {
    try { const next = await api('/api/accounts'); if (!stopped && claudeAccounts(next)) { current = next; paint(); for (const render of renders) render() } } catch { /* 前の表示を残す。読めない時に状態を作らない */ }
  }
  paint()
  return { element: section, refresh, stop() { stopped = true; for (const stop of stops) stop() } }
}
