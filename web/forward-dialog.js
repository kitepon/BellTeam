// 発言の転送（a282）。転送先（Bot か部屋）とコメントを選び、POST /api/bots|rooms/:id/messages に {forward} を付けて送る。
// 本文はサーバー（N102）が元の発言から組み立てる。ここは「どの発言か」の識別子しか送らない（forward.md）。
import { applyAvatar, escapeClass, initials } from './view-format.js?v=__ASSET_VERSION__'

// 送る本文。コメントは message、元の発言の文章は送らない。
export function forwardPayload({ source, messageId, comment = '', targets = null }) {
  return { message: comment, images: [], forward: { source: { kind: source.kind, id: source.id }, message_id: messageId }, ...(targets?.length ? { targets } : {}) }
}

// 失敗を、言葉で。サーバーの文言は出さない。
export function forwardError(cause) {
  if (cause?.status === 404) return '転送する発言が見つかりません。会話を読み直してから、もう一度お試しください。'
  if (cause?.status === 415) return '画像やファイルを含む発言は、まだ転送できません。'
  if (cause?.status === 400) return '転送できませんでした。内容を確かめてください。'
  return `転送できませんでした。少し待って、もう一度お試しください${cause?.message ? `（${cause.message}）` : ''}。`
}

// 転送先の一覧：Bot、そのあと部屋。検索語は名前に含まれるものだけ。
export function destinationsOf(bots, rooms, query = '') {
  const word = query.trim().toLowerCase()
  const named = (type, item) => ({ type, id: item.id, name: item.displayName ?? item.name ?? item.id, item })
  return [...bots.filter(bot => !bot.deleting).map(bot => named('bot', bot)), ...rooms.map(room => named('room', room))]
    .filter(entry => !word || entry.name.toLowerCase().includes(word))
}

export function createForwardDialog({ dialog, api, getBots, getRooms, routingEnabled = () => true, openConversation = () => {} }) {
  let open = false

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue
      if (key === 'text') node.textContent = value
      else if (key === 'class') node.className = value
      else if (key === 'value') node.value = value
      else if (key === 'on') for (const [type, fn] of Object.entries(value)) node.addEventListener(type, fn)
      else node.setAttribute(key, value === true ? '' : value)
    }
    node.append(...children.flat().filter(Boolean))
    return node
  }

  function show({ source, messageId, preview }) {
    const draft = { query: '', pick: null, comment: '', targets: new Set(), sending: false, error: '', sent: null }
    const body = el('div', { class: 'sheet-body forward-body' })
    const render = () => {
      body.replaceChildren(...(draft.sent ? sentView() : formView()).filter(Boolean)) // null を渡すと「null」という文字になる
    }
    const sentView = () => [
      el('p', { class: 'forward-done', role: 'status', text: `転送しました（${draft.sent.name}）。` }),
      el('div', { class: 'forward-actions' },
        el('button', { class: 'primary-button', type: 'button', text: `${draft.sent.name}の会話を開く`, on: { click: () => { dialog.close(); openConversation(draft.sent) } } }),
        el('button', { class: 'text-button', type: 'button', text: '閉じる', on: { click: () => dialog.close() } })),
    ]
    function formView() {
      const entries = destinationsOf(getBots(), getRooms(), draft.query)
      const needsTargets = draft.pick?.type === 'room' && !routingEnabled()
      const members = needsTargets ? (draft.pick.item.memberIds ?? []).map(id => getBots().find(bot => bot.id === id)).filter(Boolean) : []
      const ready = draft.pick && !draft.sending && (!needsTargets || draft.targets.size > 0)
      return [
        el('div', { class: 'forward-preview', 'aria-label': '転送する発言' }, el('strong', { text: preview.sender || '発言' }), el('span', { text: preview.text || '' })),
        el('span', { class: 'forward-label', text: '転送先' }),
        entries.length > 8 || draft.query ? el('input', { type: 'search', placeholder: '名前で探す', value: draft.query, 'aria-label': '転送先を探す', on: { input: event => { draft.query = event.target.value; render(); const box = body.querySelector('input[type="search"]'); box?.focus(); box?.setSelectionRange?.(draft.query.length, draft.query.length) } } }) : null,
        el('div', { class: 'forward-dests', role: 'group', 'aria-label': '転送先' }, ...entries.map(entry => {
          const avatar = el('span', { class: `mini-avatar ${escapeClass(entry.item.color)}`, 'aria-hidden': 'true', text: initials(entry.name) })
          if (entry.type === 'bot') applyAvatar(avatar, entry.item)
          const pressed = draft.pick?.type === entry.type && draft.pick.id === entry.id
          return el('button', { class: `forward-dest${pressed ? ' is-picked' : ''}`, type: 'button', 'aria-pressed': String(pressed), on: { click: () => { draft.pick = entry; draft.targets = new Set(); render() } } },
            avatar, el('span', { text: entry.name }), entry.type === 'room' ? el('small', { text: '部屋' }) : null)
        }), entries.length ? null : el('p', { class: 'field-help', text: '見つかりません。' })),
        needsTargets ? el('div', { class: 'forward-members', role: 'group', 'aria-label': '返信してほしいメンバー' }, el('small', { text: 'この部屋は返信者の自動選択がありません。返信してほしいメンバーを選んでください。' }),
          ...members.map(member => el('button', { class: `forward-dest${draft.targets.has(member.id) ? ' is-picked' : ''}`, type: 'button', 'aria-pressed': String(draft.targets.has(member.id)),
            on: { click: () => { draft.targets.has(member.id) ? draft.targets.delete(member.id) : draft.targets.add(member.id); render() } } }, el('span', { text: member.displayName ?? member.name })))) : null,
        el('label', { class: 'field' }, el('span', { text: 'コメント（なくても送れます）' }),
          el('textarea', { rows: '3', maxlength: '8000', value: draft.comment, placeholder: 'この発言についての依頼や一言', on: { input: event => { draft.comment = event.target.value } } })),
        draft.error ? el('p', { class: 'form-error', role: 'alert', text: draft.error }) : null,
        el('div', { class: 'forward-actions' },
          el('button', { class: 'primary-button', type: 'button', text: draft.sending ? '送っています…' : '転送する', disabled: !ready || undefined, on: { click: () => void send() } })),
      ]
    }
    async function send() {
      if (draft.sending || !draft.pick) return
      draft.sending = true; draft.error = ''; render()
      const kind = draft.pick.type === 'room' ? 'rooms' : 'bots'
      try {
        await api(`/api/${kind}/${draft.pick.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(forwardPayload({ source, messageId, comment: draft.comment.trim(), targets: draft.pick.type === 'room' && !routingEnabled() ? [...draft.targets] : null })) })
        draft.sent = { type: draft.pick.type, id: draft.pick.id, name: draft.pick.name }
      } catch (cause) { draft.error = forwardError(cause) }
      draft.sending = false
      if (open) render()
    }
    dialog.replaceChildren(el('div', {},
      el('header', { class: 'sheet-header' }, el('button', { class: 'text-button', type: 'button', text: '閉じる', on: { click: () => dialog.close() } }), el('h2', { text: '転送' }), el('span', { class: 'header-spacer' })), body))
    open = true; render()
    if (!dialog.open) dialog.showModal()
  }
  dialog.addEventListener('close', () => { open = false })
  return { open: show }
}
