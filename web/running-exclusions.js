// 設定「稼働中に数えない処理」(user-paths.md 4.10, execution current-work.md "Owner read and remove (a62)").
// The Web only reads the list and sends the Owner's own removal; adding is only through Approval Box.
import { formatDateTime } from './view-format.js?v=__ASSET_VERSION__'

const HARNESS_NAMES = { 'claude-code': 'Claude Code', 'codex-cli': 'Codex', 'grok-cli': 'Grok', 'cursor-cli': 'Cursor', 'antigravity-cli': 'Antigravity' }

// The same words the work card's reason shows: a process reads as "<exe> <args>".
export function exclusionWords(entry) {
  if (entry?.kind === 'process') return [entry.exe, ...(entry.args ?? [])].join(' ')
  const name = HARNESS_NAMES[entry?.harness] ?? entry?.harness ?? ''
  return `${name} の子の席${entry?.session ? `「${entry.session}」` : '（どの席でも）'}`
}
export const scopeWords = (scope, nameOf) => scope === 'all' ? '全員' : (Array.isArray(scope) ? scope : []).map(id => nameOf(id) ?? id).join('、')

const text = value => typeof value === 'string' && value.length > 0
const validEntry = entry => entry && text(entry.id) && (entry.kind === 'process' ? text(entry.exe) && Array.isArray(entry.args) : entry.kind === 'child' && text(entry.harness))
  && (entry.scope === 'all' || Array.isArray(entry.scope))
export function validExclusions(value) {
  return Boolean(value && Array.isArray(value.entries) && value.entries.every(validEntry) && Array.isArray(value.pending)
    && value.pending.every(item => item && (item.action === 'add' ? validEntry({ id: 'pending', ...item.entry }) : item.action === 'remove' && text(item.id))))
}

// 設定のホームの一行と札。答え待ちは Approval Box が知らせるので、札の色は付けない。
export function exclusionsItem(result) {
  if (result === 'unsupported') return { line: '本体を更新すると使えます', badge: '', tone: '' }
  if (!validExclusions(result)) return { line: '確認できません', badge: '確認できません', tone: 'attention' }
  const count = result.entries.length, waiting = result.pending.length
  const line = count ? `${count}件` : 'なし'
  return { line: waiting ? `${line}・答え待ち${waiting}件` : line, badge: '', tone: '' }
}

export function removalFailure(error) {
  if (error?.code === 'RUNNING_EXCLUSION_NOT_FOUND' || error?.status === 404) return 'もう一覧にありませんでした。'
  if (error?.code === 'RUNNING_EXCLUSIONS_UNAVAILABLE' || error?.status === 503) return '一覧を読めないため、外せませんでした。'
  return '外せませんでした。もう一度お試しください。'
}

export function runningExclusionsView(root, api, { nameOf = () => null, onChange = () => {}, confirm = globalThis.confirm } = {}) {
  let read = 0, busy = null
  const el = (tag, className, value) => Object.assign(document.createElement(tag), className ? { className } : {}, value === undefined ? {} : { textContent: value })
  const line = (label, value) => { const row = el('p', 'exclusion-line'); row.append(el('span', 'exclusion-label', label), el('span', '', value)); return row }
  const name = id => nameOf(id) ?? id
  function card(entry, kind, lines, action) {
    const node = el('div', 'settings-card exclusion-card'), head = el('div', 'exclusion-head'), icon = el('span', 'settings-item-icon')
    icon.dataset.settingsIcon = kind === 'process' ? 'terminal' : 'profile'
    head.append(icon, el('h4', kind === 'process' ? 'exclusion-what is-command' : 'exclusion-what', exclusionWords(entry)))
    node.append(head, ...lines)
    if (action) node.append(action)
    return node
  }
  function render(result, notice = '') {
    const parts = notice ? [el('p', 'form-error', notice)] : []
    if (result === 'unsupported') return root.replaceChildren(el('p', 'settings-empty', 'この本体では使えません。本体を「アップデート」で新しくすると使えます。'))
    if (!validExclusions(result)) {
      const again = el('button', 'retry-button', 'もう一度読み込む')
      again.type = 'button'
      again.addEventListener('click', () => { void refresh() })
      return root.replaceChildren(...parts, el('p', 'form-error', '一覧を読めませんでした。通信を確かめて、もう一度読み込んでください。'), again)
    }
    if (!result.entries.length && !result.pending.length) return root.replaceChildren(...parts, el('p', 'settings-empty', 'いまは何もありません。メンバーの処理は、すべて作業中に数えます。'))
    if (result.entries.length) {
      parts.push(el('h4', 'exclusion-section', '数えないもの'))
      for (const entry of result.entries) {
        const remove = el('button', '', busy === entry.id ? '外しています…' : '一覧から外す')
        remove.type = 'button'; remove.disabled = Boolean(busy)
        remove.addEventListener('click', () => { void removeEntry(entry) })
        parts.push(card(entry, entry.kind, [
          line('対象', scopeWords(entry.scope, nameOf)),
          ...(entry.approvedAt ? [line('承認', formatDateTime(entry.approvedAt))] : []),
          ...(entry.reason ? [line('理由', entry.reason)] : []),
          ...(entry.from ? [line('提案', name(entry.from))] : []),
        ], remove))
      }
    }
    if (result.pending.length) {
      parts.push(el('h4', 'exclusion-section', 'あなたの答えを待っている提案'))
      for (const item of result.pending) {
        const entry = item.action === 'add' ? item.entry : result.entries.find(listed => listed.id === item.id) ?? { kind: 'process', exe: '（一覧にない処理）', args: [] }
        parts.push(card(entry, entry.kind, [
          el('p', 'exclusion-kind', item.action === 'add' ? '追加の提案' : '外す提案'),
          ...(item.action === 'add' ? [line('対象', scopeWords(entry.scope, nameOf))] : []),
          ...(item.from ? [line('提案', name(item.from))] : []),
          ...(item.filedAt ? [line('出した日時', formatDateTime(item.filedAt))] : []),
          el('p', 'settings-current', item.approved ? '承認済み。一覧に空きができたら載ります。' : 'Approval Boxで、あなたの答えを待っています。'),
        ]))
      }
    }
    root.replaceChildren(...parts)
  }
  let last = null
  async function refresh(notice = '') {
    const token = ++read
    let result
    try { result = await api('/api/running-exclusions') } catch (error) { result = error?.status === 404 || error?.status === 405 ? 'unsupported' : null }
    if (token !== read) return
    last = result
    render(result, notice)
    onChange(exclusionsItem(result))
  }
  async function removeEntry(entry) {
    if (busy || !confirm(`「${exclusionWords(entry)}」を一覧から外しますか？外すと、この処理が動いている間はまた作業中に数えます。`)) return
    busy = entry.id
    render(last)
    let notice = ''
    try { await api(`/api/running-exclusions/${encodeURIComponent(entry.id)}`, { method: 'DELETE' }) } catch (error) { notice = removalFailure(error) }
    busy = null
    await refresh(notice)
  }
  return { refresh }
}
