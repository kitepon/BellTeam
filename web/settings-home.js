// 設定のホーム（項目の列）と、項目ごとのページの切り替え。Appleと同じ構造（user-paths.md 4.1, 4.2）。
// PC: 左に項目の列、右にページ。電話: 項目の列 → ページ（「戻る」で列へ）。
export const SETTINGS_ITEMS = [
  ['profile', 'プロフィール', 'profile'], ['rules', 'チームの決まり', 'rules'], ['ai', 'AIの認証', 'key'],
  ['summary', '仕事の要約を書くAI', 'summary'], ['stop', '全体停止', 'power'], ['terminals', '端末', 'terminal'],
  ['onePassword', '1Password', 'vault'], ['notifications', '通知', 'bell'], ['features', '追加機能', 'puzzle'],
  ['updates', 'アップデート', 'update'], ['connection', '接続', 'link'], ['display', '表示', 'display'], ['billing', '利用と購読', 'card'],
]

// 要対応の帯に出す項目。札の色が橙（attention）か、更新あり（accent）のもの。
export const attentionItems = states => SETTINGS_ITEMS.filter(([id]) => ['attention', 'accent'].includes(states.get(id)?.tone))

export function createSettingsHome(dialog, { canLeave = () => true, onShow = () => {} } = {}) {
  const items = dialog.querySelector('[data-settings-items]'), band = dialog.querySelector('[data-settings-attention]')
  // 「戻る」は見出しの左の場所を常に取り、見せるかどうかはCSS（電話のページ表示の時だけ）が決める。
  const title = dialog.querySelector('[data-settings-title]'), back = dialog.querySelector('[data-settings-back]')
  const states = new Map(), rows = new Map()
  let current = null
  const el = (tag, className, text) => Object.assign(document.createElement(tag), className ? { className } : {}, text === undefined ? {} : { textContent: text })
  for (const [id, name, icon] of SETTINGS_ITEMS) {
    const row = el('button', 'settings-item'), line = el('span', 'settings-item-line'), badge = el('span', 'settings-badge')
    row.type = 'button'; row.dataset.settingsItem = id; row.dataset.settingsIcon = icon
    const text = el('span', 'settings-item-text')
    text.append(el('span', 'settings-item-name', name), line)
    row.append(el('span', 'settings-item-icon'), text, badge)
    row.addEventListener('click', () => show(id))
    rows.set(id, { row, line, badge })
    items?.append(row)
  }
  back?.addEventListener('click', () => home())
  function paintBand() {
    if (!band) return
    const hits = attentionItems(states)
    band.hidden = !hits.length
    band.replaceChildren(...hits.map(([id, name]) => {
      const row = el('button', `settings-attention-row tone-${states.get(id).tone}`)
      row.type = 'button'
      row.append(el('span', 'settings-attention-name', name), el('span', 'settings-attention-line', states.get(id).line))
      row.addEventListener('click', () => show(id))
      return row
    }))
  }
  // 項目の「いまの状態」の一行と札。固定の説明文は置かない。
  function set(id, { line = '', badge = '', tone = '' } = {}) {
    const row = rows.get(id)
    if (!row) return
    states.set(id, { line, badge, tone })
    row.line.textContent = line
    row.badge.textContent = badge
    row.badge.className = `settings-badge tone-${tone || 'none'}`
    row.badge.hidden = !badge
    paintBand()
  }
  function show(id) {
    if (current && current !== id && !canLeave(current)) return false
    current = id
    for (const page of dialog.querySelectorAll('[data-settings-page]')) page.hidden = page.dataset.settingsPage !== id
    for (const [key, { row }] of rows) row.setAttribute('aria-current', key === id ? 'page' : 'false')
    dialog.dataset.settingsView = 'page'
    if (title) title.textContent = SETTINGS_ITEMS.find(([key]) => key === id)?.[1] ?? '設定'
    onShow(id)
    return true
  }
  function home() {
    if (current && !canLeave(current)) return false
    dialog.dataset.settingsView = 'home'
    if (title) title.textContent = '設定'
    return true
  }
  return { set, show, home, current: () => current, state: id => states.get(id), reset() { current = null; states.clear(); for (const id of rows.keys()) set(id) } }
}
