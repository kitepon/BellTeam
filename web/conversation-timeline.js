import { renderSecretRequest } from './secret-input.js?v=__ASSET_VERSION__'
import { renderOwnerQuestion } from './owner-question.js?v=__ASSET_VERSION__'
import { renderMachineEvent, arrangeMachineRows } from './machine-event.js?v=__ASSET_VERSION__'
import { richTextHtml } from './rich-text.js?v=__ASSET_VERSION__'
import { fileNameOf, openImageViewer, renderImageStack } from './image-gallery.js?v=__ASSET_VERSION__'
import { applyAvatar, dayLabel, initials, memberDisplay, formatTime, formatDateTime, escapeClass, escapeHtml } from './view-format.js?v=__ASSET_VERSION__'

const deliveryFailureMessages = new Map([
  ['BOT_OBSERVATION_FAILED', '席の状態を確認できず、送信できませんでした。席を再起動してください。'],
  ['BOT_CONFIGURATION_FAILED', '席の設定を反映できず、送信できませんでした。設定を確認してください。'],
  ['BOT_LAUNCH_FAILED', '席を起動できず、送信できませんでした。席を再起動してください。'],
  ['BOT_SEND_FAILED', '席への送信に失敗しました。送信結果を確認してください。'],
  ['BOT_DELIVERY_FAILED', '送信に失敗しました。会話を確認してください。'],
  ['BOT_SESSION_UNCONFIRMED', '席の状態を確認できず、送信できませんでした。席を再起動してください。'],
])

// 引用した部分（reply.md「Quoting a selected part」）を、画面に出ている本文の text node から探す。
// from 以降の最初の一致、なければ最初の一致。見つからなければ null（行の強調だけで済ませる）。
export function locateQuotePart(nodes, text, from = 0) {
  if (!text) return null
  const hay = nodes.map(node => node.textContent).join('')
  let at = hay.indexOf(text, from)
  if (at < 0) at = hay.indexOf(text)
  if (at < 0) return null
  const end = at + text.length
  let used = 0, startNode, startOffset, endNode, endOffset
  for (const node of nodes) {
    const length = node.textContent.length
    if (startNode === undefined && at < used + length) { startNode = node; startOffset = at - used }
    if (startNode !== undefined && end > used && end <= used + length) { endNode = node; endOffset = end - used; break }
    used += length
  }
  return startNode && endNode ? { startNode, startOffset, endNode, endOffset } : null
}

// 転送・共有の行（forward.md）：message = コメント + 空行 + 内容。content_start は Unicode のコードポイントで数える。
export function splitOrigin(message = '', start = null) {
  if (!Number.isInteger(start) || start < 0) return { comment: message, content: '' }
  if (start === 0) return { comment: '', content: message }
  const chars = [...message]
  return { comment: chars.slice(0, start).join('').trim(), content: chars.slice(start).join('') }
}

// 吹き出しの下の三つの操作（a302）。固定の線画だけ。画面のデータは入れない。
const icon = path => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`
const ACTION_ICONS = {
  reply: icon('<path d="M10 7L4.5 12l5.5 5"/><path d="M4.5 12H14a5.5 5.5 0 0 1 5.5 5.5V19"/>'),
  // 転送：箱から真上へ出る矢印（返信の矢印と向きが似ないように。a308）
  forward: icon('<path d="M12 15V3.5"/><path d="M8 7.5l4-4 4 4"/><path d="M8.5 10.5H7a2 2 0 0 0-2 2V19a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6.5a2 2 0 0 0-2-2h-1.5"/>'),
  copy: icon('<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>'),
  done: icon('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
}

export function createConversationTimeline({ timeline, latestButton, api, messageImages, getBot, isStopping, onStop, onQueueChange, onReply = () => {}, onForward = () => {} }) {
  let target = null
  const avatarColors = new Map()
  const cardSnapshots = new WeakMap()
  // What the Owner opened in the fold view; the app's own state, never stored (machine-stream.md).
  const foldOpen = new Set()
  const state = { timelineMap: new Map(), timelineQueue: [], timelineQueueRequest: 0,
    timelineQueueError: '', timelineHasMore: false, timelineOldestId: null,
    timelineLoadingOlder: false, timelineToken: 0, historyRequest: 0, historyError: '', historyRetry: null, stickToBottom: true, opening: false }
  async function readHistory(read) {
    const pending = read()
    const token = state.timelineToken
    const request = state.historyRequest
    try {
      await pending
      // The read that failed (open, newest page or an older page) succeeded again, by 「もう一度読み込む」 or by scrolling: its error goes.
      // A newest-page read also settles a failed open or newest-page read; only the older page's own read settles its failure.
      if (token === state.timelineToken && state.historyRetry && (state.historyRetry === read || read !== loadOlderMessages && state.historyRetry !== loadOlderMessages)) {
        state.historyRetry = null; state.historyError = ''
        renderTail([...state.timelineMap.values()])
      }
      return true
    }
    catch {
      if (token === state.timelineToken && request === state.historyRequest) {
        state.historyError = '会話を読み込めませんでした。通信を確かめて、もう一度読み込んでください。'
        state.historyRetry = read // the retry repeats this same read (e.g. the older page with its cursor)
        state.opening = false
        timelineItems.replaceChildren()
        if (state.timelineMap.size) timelineItems.append(dayLabel(), ...[...state.timelineMap.values()].map(item => renderItem(item, queuedFor(item))))
        arrangeMachineRows(timelineItems, foldOpen)
        renderTail([...state.timelineMap.values()])
      }
      return false
    }
  }
  function close() {
    state.timelineToken++
    target = null
    state.timelineMap.clear()
    foldOpen.clear()
    state.timelineQueue = []
    state.timelineLoadingOlder = false
    timelineItems.replaceChildren()
    timelineTail.replaceChildren()
    latestButton.hidden = true
    onQueueChange()
  }
  const TIMELINE_FIRST_PAGE = 10
  const TIMELINE_MORE_PAGE = 20
  const timelineItems = document.createElement('div')
  timelineItems.className = 'timeline-items'
  const timelineTail = document.createElement('div')
  timelineTail.className = 'timeline-tail'
  timeline.replaceChildren(timelineItems, timelineTail)

  function messagesPath() {
    return target?.type === 'room' ? `/api/rooms/${target.id}/messages` : `/api/bots/${target.id}/messages`
  }
  function queuePath() {
    return target?.type === 'room' ? `/api/rooms/${target.id}/queue` : `/api/bots/${target.id}/queue`
  }
  function normalizeItems(items) {
    return target?.type === 'room' ? items.map(roomTimelineItem) : items
  }
  function queuedFor(item) {
    return state.timelineQueue.filter(entry => entry.groupId === item.id)
  }
  function scrollToBottom() {
    timeline.scrollTo({ top: timeline.scrollHeight, behavior: 'instant' })
  }
  latestButton.addEventListener('click', () => {
    state.stickToBottom = true
    scrollToBottom()
    latestButton.hidden = true
  })
  function rememberItems(items) {
    for (const item of items) state.timelineMap.set(item.id, item)
  }

  async function openTimeline() {
    const token = ++state.timelineToken
    const request = ++state.historyRequest
    state.timelineMap = new Map()
    foldOpen.clear()
    state.timelineHasMore = false
    state.timelineOldestId = null
    state.timelineLoadingOlder = false
    state.stickToBottom = true
    latestButton.hidden = true
    state.timelineQueue = []
    state.timelineQueueError = ''
    state.historyError = ''
    state.historyRetry = null
    state.opening = true
    timelineItems.replaceChildren(loadingBubbles())
    timelineTail.replaceChildren()
    void refreshTimelineQueue(token)
    const result = await api(`${messagesPath()}?limit=${TIMELINE_FIRST_PAGE}`)
    if (token !== state.timelineToken || request !== state.historyRequest) return
    state.opening = false
    const items = normalizeItems(result.items)
    rememberItems(items)
    state.timelineHasMore = result.has_more
    state.timelineOldestId = items[0]?.id ?? null
    timelineItems.replaceChildren(dayLabel(), ...items.map(item => renderItem(item, queuedFor(item))))
    state.historyError = ''
    arrangeMachineRows(timelineItems, foldOpen)
    renderTail(items)
    scrollToBottom()
    loadStoredMessageImages(items, item => rerenderItem(item.id, token))
  }

  async function refreshTimelineQueue(token) {
    const request = ++state.timelineQueueRequest
    try {
      const result = await api(queuePath())
      if (token !== state.timelineToken || request !== state.timelineQueueRequest) return
      state.timelineQueue = result.items
      state.timelineQueueError = ''
      for (const id of state.timelineMap.keys()) rerenderItem(id, token)
    } catch {
      if (token !== state.timelineToken || request !== state.timelineQueueRequest) return
      state.timelineQueueError = '送信待ちの状態を読み込めませんでした。'
    }
    renderTail([...state.timelineMap.values()])
  }

  async function refreshTimeline() {
    const token = state.timelineToken
    const request = ++state.historyRequest
    const ids = [...state.timelineMap.keys()]
    const lastId = ids.at(-1) ?? null
    void refreshTimelineQueue(token)
    const [latest, after] = await Promise.all([
      api(`${messagesPath()}?limit=${TIMELINE_FIRST_PAGE}`),
      lastId ? api(`${messagesPath()}?after=${encodeURIComponent(lastId)}`) : Promise.resolve({ items: [] }),
    ])
    if (token !== state.timelineToken || request !== state.historyRequest) return
    const latestItems = normalizeItems(latest.items)
    const newItems = normalizeItems(after.items).filter(item => !state.timelineMap.has(item.id))
    // 既に出ている直近の項目は、配送状態などが変わっていれば差し替える
    for (const item of latestItems) {
      if (!state.timelineMap.has(item.id)) continue
      state.timelineMap.set(item.id, item)
      rerenderItem(item.id, token)
    }
    if (!lastId && latestItems.length) {
      rememberItems(latestItems)
      state.timelineHasMore = latest.has_more
      state.timelineOldestId = latestItems[0]?.id ?? null
      timelineItems.replaceChildren(dayLabel(), ...latestItems.map(item => renderItem(item, queuedFor(item))))
    } else {
      rememberItems(newItems)
      timelineItems.append(...newItems.map(item => renderItem(item, queuedFor(item))))
    }
    arrangeMachineRows(timelineItems, foldOpen)
    renderTail([...state.timelineMap.values()])
    if (state.stickToBottom) scrollToBottom()
    loadStoredMessageImages([...latestItems, ...newItems], item => rerenderItem(item.id, token))
  }

  // 上へ遡ったら前のページを先頭に足し、見ている位置は動かさない。
  async function loadOlderMessages() {
    if (!state.timelineHasMore || state.timelineLoadingOlder || !state.timelineOldestId) return
    state.timelineLoadingOlder = true
    const token = state.timelineToken
    const spinner = Object.assign(document.createElement('p'), { className: 'timeline-older', textContent: '前の会話を読み込んでいます…' })
    timelineItems.firstChild?.after(spinner)
    try {
      const result = await api(`${messagesPath()}?limit=${TIMELINE_MORE_PAGE}&before=${encodeURIComponent(state.timelineOldestId)}`)
      if (token !== state.timelineToken) return
      const items = normalizeItems(result.items).filter(item => !state.timelineMap.has(item.id))
      const ordered = new Map([...items.map(item => [item.id, item]), ...state.timelineMap])
      state.timelineMap = ordered
      state.timelineHasMore = result.has_more
      state.timelineOldestId = items[0]?.id ?? state.timelineOldestId
      const before = timeline.scrollHeight
      timelineItems.firstChild.after(...items.map(item => renderItem(item, queuedFor(item))))
      arrangeMachineRows(timelineItems, foldOpen)
      timeline.scrollTo({ top: timeline.scrollTop + (timeline.scrollHeight - before), behavior: 'instant' })
      loadStoredMessageImages(items, item => rerenderItem(item.id, token))
    } finally {
      // The flag is released first, so nothing in the clean-up can leave the older page unreadable.
      if (token === state.timelineToken) state.timelineLoadingOlder = false
      spinner.remove?.()
    }
  }

  async function revealRequest(id, kind) {
    const token = state.timelineToken
    if (!target) throw Error('NO_CONVERSATION')
    if (!state.timelineMap.has(id) && !await readHistory(refreshTimeline)) throw Error('HISTORY_UNAVAILABLE')
    while (token === state.timelineToken && !state.timelineMap.has(id) && state.timelineHasMore) {
      if (state.timelineLoadingOlder) throw Error('HISTORY_BUSY')
      const oldest = state.timelineOldestId
      await loadOlderMessages()
      if (oldest === state.timelineOldestId) break
    }
    if (token !== state.timelineToken) throw Error('CONVERSATION_CHANGED')
    const item = state.timelineMap.get(id)
    if (!item || !['secret_request','owner_question'].includes(kind) || item[kind]?.id !== id) throw Error('REQUEST_NOT_FOUND')
    const card = timelineItems.querySelector(`[data-id="${CSS.escape(id)}"]`)
    if (!card) throw Error('REQUEST_NOT_RENDERED')
    state.stickToBottom = false
    card.tabIndex = -1
    card.classList.add('notification-highlight')
    card.scrollIntoView({ block:'center' })
    card.focus({ preventScroll:true })
  }

  function rerenderItem(id, token) {
    if (token !== state.timelineToken) return
    const item = state.timelineMap.get(id)
    const element = timelineItems.querySelector(`[data-id="${CSS.escape(id)}"]`)
    const card = item?.secret_request ?? item?.owner_question ?? item?.machine_event
    if (card && element && cardSnapshots.get(element) === JSON.stringify(card)) return
    if (item && element) { element.replaceWith(renderItem(item, queuedFor(item))); arrangeMachineRows(timelineItems, foldOpen) }
  }

  function renderTail(items) {
    const renderedIds = new Set(items.map(item => item.id))
    const tail = state.timelineQueue.filter(entry => !renderedIds.has(entry.groupId)).map(renderQueuedItem)
    if (target?.type === 'bot' && state.timelineQueue.some(entry => entry.status === 'running')) tail.push(renderThinking(target.id))
    timelineTail.replaceChildren(...tail)
    if (!state.opening && !state.historyError && !state.timelineMap.size && !tail.length) timelineTail.append(Object.assign(document.createElement('p'), { className: 'timeline-empty', textContent: 'まだ会話がありません。メッセージを送ってみてください。' }))
    // A failed read says so in place, with its own retry (user-paths.md 3.1 CError).
    const token = state.timelineToken
    if (state.historyError) timelineTail.append(inlineError(state.historyError, () => readHistory(state.historyRetry ?? (state.timelineMap.size ? refreshTimeline : openTimeline))))
    else if (state.timelineQueueError) timelineTail.append(inlineError(state.timelineQueueError, () => refreshTimelineQueue(token)))
    onQueueChange()
  }

  function inlineError(message, retry) {
    const box = document.createElement('div')
    box.className = 'inline-error'
    box.setAttribute('role', 'alert')
    const text = document.createElement('p')
    text.textContent = message
    const again = document.createElement('button')
    again.type = 'button'
    again.textContent = 'もう一度読み込む'
    again.addEventListener('click', () => {
      again.disabled = true
      again.textContent = '読み込んでいます…'
      state.historyError = ''
      void retry()
    })
    box.append(text, again)
    return box
  }
  function loadingBubbles() {
    const box = document.createElement('div')
    box.className = 'timeline-loading'
    box.setAttribute('role', 'status')
    box.innerHTML = '<span class="skeleton-bubble"></span><span class="skeleton-bubble is-right"></span><span class="skeleton-bubble"></span><p>会話を読み込んでいます</p>'
    return box
  }

  timeline.addEventListener('scroll', () => {
    state.stickToBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 40
    latestButton.hidden = !target || state.stickToBottom
    if (selectionPick) onSelectionChange() // 選択は残る：位置だけ追う（タッチでは下に固定）
    if (timeline.scrollTop < 240) void readHistory(loadOlderMessages)
  })
  new ResizeObserver(() => { if (state.stickToBottom) scrollToBottom() }).observe(timelineItems)
  new ResizeObserver(() => { if (state.stickToBottom) scrollToBottom() }).observe(timelineTail)

  function renderItem(item, queued = []) {
    const element = renderItemElement(item, queued)
    element.dataset.id = item.id
    const card = item.secret_request ?? item.owner_question ?? item.machine_event
    if (card) cardSnapshots.set(element, JSON.stringify(card))
    return element
  }

  function renderItemElement(item, queued = []) {
    if (item.secret_request) {
      const request = item.secret_request
      const token = state.timelineToken
      return renderSecretRequest(request, {
        api, sender: getBot(request.botId)?.name ?? request.botId,
        onComplete: updated => {
          if (token !== state.timelineToken) return
          state.timelineMap.set(item.id, { ...item, secret_request: updated })
          rerenderItem(item.id, token)
        },
      })
    }
    if (item.owner_question) {
      const question = item.owner_question
      const token = state.timelineToken
      return renderOwnerQuestion(question, {
        api, sender: getBot(question.botId)?.name ?? question.botId,
        onAnswered: updated => {
          if (token !== state.timelineToken) return
          state.timelineMap.set(item.id, { ...item, owner_question: updated })
          rerenderItem(item.id, token)
        },
      })
    }
    if (item.kind === 'machine_event' && item.machine_event) {
      const token = state.timelineToken
      return renderMachineEvent(item, {
        api, sender: item.sender?.name ?? getBot(item.sender?.id)?.name ?? '',
        open: foldOpen.has(item.id), onOpen: open => { if (open) foldOpen.add(item.id); else foldOpen.delete(item.id) },
        readRaw: async () => (await api(`/api/bots/${encodeURIComponent(item.sender?.id ?? target?.id)}/machine-events/${item.machine_event.seq}`)).line,
        onChanged: request => {
          if (token !== state.timelineToken) return
          state.timelineMap.set(item.id, { ...item, machine_event: { ...item.machine_event, request } })
          rerenderItem(item.id, token)
        },
      })
    }
    if (item.kind === 'peer') {
      const details = document.createElement('details')
      details.className = 'peer-event'
      const verb = item.direction === 'sent' ? 'へメッセージを送りました' : 'からメッセージを受け取りました'
      const peer = item.peerPosition ? `${item.peerName} ${item.peerPosition}` : item.peerName
      details.innerHTML = `<summary>${seatLabel(item) ? '<span class="seat-label">分身</span>' : ''}${escapeHtml(peer)}${verb}</summary><div class="peer-detail"><strong>${formatDateTime(item.at)}</strong>${richTextHtml(item.message)}</div>`
      if (item.id) details.querySelector?.('.peer-detail')?.append(forwardButton(item))
      const failed = item.delivery === 'failed' && !trackingCompletionUnknown(item)
      if (!queued.length && !failed) return details
      const wrapper = document.createElement('div')
      wrapper.className = 'queued-peer'
      wrapper.append(details)
      if (queued.length) wrapper.append(renderQueueStatus(queued))
      else {
        const reason = document.createElement('p')
        reason.className = 'form-error'
        reason.textContent = deliveryLabel(item)
        wrapper.append(reason)
      }
      return wrapper
    }
    const wrapper = document.createElement('div')
    wrapper.className = `message ${item.direction}`
    const column = document.createElement('div')
    column.className = 'message-column'
    const bubble = document.createElement('div')
    bubble.className = 'message-bubble'
    // ルームでは発言者のアバターを左に出し、アバターから導いた色を吹き出しの枠に付ける。
    const senderBot = item.direction === 'incoming' && target?.type === 'room' && item.senderId
      ? getBot(item.senderId) : null
    if (senderBot) {
      wrapper.classList.add('with-avatar')
      const avatar = document.createElement('span')
      avatar.className = `mini-avatar message-avatar ${escapeClass(senderBot.color)}`
      avatar.textContent = initials(senderBot.name)
      applyAvatar(avatar, senderBot)
      wrapper.append(avatar)
      avatarColor(senderBot).then(color => {
        if (!color) return
        bubble.style.borderColor = color
        avatar.style.boxShadow = `0 0 0 2px ${color}`
      })
    }
    if (item.sender && item.direction === 'incoming') {
      const sender = document.createElement('strong')
      sender.className = 'message-sender'
      sender.textContent = item.sender
      bubble.append(sender)
    }
    const fork = seatLabel(item)
    if (fork) bubble.append(fork)
    if (item.audience) {
      const audience = document.createElement('small')
      audience.className = `message-audience${item.audienceTone ? ` is-${item.audienceTone}` : ''}`
      audience.textContent = item.audience
      bubble.append(audience)
    }
    const quote = renderReplyQuote(item.reply_to)
    if (quote) bubble.append(quote)
    const origin = originMark(item.origin)
    if (origin) bubble.append(origin)
    // 2枚以上の束は吹き出しの外に置き、枠に囲まずに見せる。
    let imageStack = null
    if (item.image) {
      const previews = messageImages.get(item.id)
      if (previews) {
        const alt = item.direction === 'incoming' ? 'Botが提示した画像' : '送信した画像'
        const names = (item.image_urls?.length ? item.image_urls : [item.image_url]).map(fileNameOf) // 保存名（image-original.md）：ダウンロード・共有の名前
        const open = index => openImageViewer(previews, index, alt, { names })
        if (previews.length > 1) {
          imageStack = renderImageStack(previews, { alt, onOpen: open })
        } else {
          const image = document.createElement('img')
          image.className = 'message-image'
          image.src = previews[0]
          image.alt = alt
          image.loading = 'lazy'
          const button = document.createElement('button')
          button.type = 'button'
          button.className = 'message-image-link'
          button.setAttribute('aria-label', '画像を開く')
          button.addEventListener('click', () => open(0))
          button.append(image)
          bubble.append(button)
        }
      } else {
        const label = document.createElement('span')
        label.className = 'message-image-label'
        label.textContent = messageImages.failed(item.id) ? '画像を読み込めませんでした' : imageLabel(item)
        bubble.append(label)
      }
    }
    // 転送・共有：コメントは本人の言葉、内容は引用の枠。ない行は今までどおり。
    const { comment, content } = item.origin ? splitOrigin(item.message, item.origin.content_start) : { comment: item.message, content: '' }
    if (comment?.trim()) {
      const text = document.createElement('span')
      text.className = 'message-text'
      text.innerHTML = richTextHtml(comment)
      bubble.append(text)
    }
    if (content?.trim()) {
      const block = document.createElement('div')
      block.className = `origin-content is-${item.origin.kind}`
      block.innerHTML = richTextHtml(content)
      bubble.append(block)
    }
    const time = document.createElement('div')
    time.className = 'message-time'
    const delivery = !queued.length && item.direction === 'outgoing' ? deliveryLabel(item) : ''
    time.textContent = [formatTime(item.at), delivery].filter(Boolean).join(' · ')
    if (item.delivery === 'failed' && !trackingCompletionUnknown(item)) time.classList.add('failed')
    if (imageStack) column.append(imageStack)
    if (!imageStack || bubble.childElementCount) column.append(bubble)
    column.append(time)
    if (queued.length) column.append(renderQueueStatus(queued))
    if (item.id) {
      const actions = document.createElement('div')
      actions.className = 'message-actions'
      actions.append(replyButton(item), forwardButton(item), ...(item.message?.trim() ? [copyButton(item)] : []))
      column.append(actions)
    }
    wrapper.append(column)
    return wrapper
  }

  // 返信（a269）。引用は保存された item.reply_to だけから描く。読み込んだ行から組み立てない。
  function renderReplyQuote(reply) {
    if (!reply?.id) return null
    const excerpt = reply.text ? `${reply.text}${reply.truncated ? '…' : ''}` : reply.image ? '（画像）' : ''
    if (!reply.available) {
      const gone = Object.assign(document.createElement('div'), { className: 'reply-quote is-gone' })
      // 部分の引用は、選んだ文章（本人の選択）を残して、元が無いことを固定の一行で言う。
      if (reply.part && reply.text) gone.append(Object.assign(document.createElement('span'), { className: 'reply-quote-excerpt', textContent: excerpt }), Object.assign(document.createElement('small'), { textContent: '元のメッセージを表示できません' }))
      else gone.textContent = '元のメッセージを表示できません'
      return gone
    }
    const who = reply.sender?.id === 'user' ? 'あなた' : reply.sender?.name ?? ''
    const quote = document.createElement('button')
    quote.type = 'button'
    quote.className = 'reply-quote'
    quote.setAttribute('aria-label', `${who || '元'}のメッセージへ移動`)
    const sender = Object.assign(document.createElement('strong'), { textContent: who })
    const text = Object.assign(document.createElement('span'), { textContent: excerpt })
    quote.append(sender, text)
    quote.addEventListener('click', () => { void jumpToMessage(reply.id, quote, reply.part ? { text: reply.text, from: reply.range?.start ?? 0 } : null) })
    return quote
  }
  // 転送・共有の印（origin）。画面に出すのは種類・元の発言者・時刻・共有元のアプリだけ。
  function originMark(origin) {
    if (!origin?.kind) return null
    const label = origin.kind === 'forward' ? ['転送', origin.from?.name, origin.at ? formatDateTime(origin.at) : ''] : ['共有', origin.app]
    return Object.assign(document.createElement('small'), { className: `origin-mark is-${origin.kind}`, textContent: label.filter(Boolean).join(' · ') })
  }
  function forwardButton(item) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'message-reply message-forward'
    button.innerHTML = ACTION_ICONS.forward
    button.setAttribute('aria-label', 'このメッセージを転送')
    button.addEventListener('click', () => onForward({
      source: { kind: target?.type === 'room' ? 'room' : 'bot', id: target?.id }, messageId: item.id,
      preview: { sender: item.direction === 'outgoing' ? 'あなた' : item.sender || target?.name || '', text: item.message?.trim().split('\n')[0] || (item.image ? '（画像）' : '') },
    }))
    return button
  }
  function replyButton(item) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'message-reply'
    button.innerHTML = ACTION_ICONS.reply
    button.setAttribute('aria-label', 'このメッセージに返信')
    button.addEventListener('click', () => onReply({ ...replySender(item), text: item.message?.trim().split('\n')[0] || (item.image ? '（画像）' : '') }))
    return button
  }
  // コピー：本文（転送・共有はコメントと内容をそのまま）。押すと一瞬だけチェックに替わる。書き込めない時は替えない。
  // shortcut: navigator.clipboard だけ（https / localhost）。古い環境の代替は付けない。
  function copyButton(item) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'message-reply message-copy'
    button.innerHTML = ACTION_ICONS.copy
    button.setAttribute('aria-label', 'このメッセージをコピー')
    button.addEventListener('click', async () => {
      try { await globalThis.navigator.clipboard.writeText(item.message) } catch { return }
      button.innerHTML = ACTION_ICONS.done; button.setAttribute('aria-label', 'コピーしました')
      setTimeout(() => { button.innerHTML = ACTION_ICONS.copy; button.setAttribute('aria-label', 'このメッセージをコピー') }, 1500)
    })
    return button
  }
  const replySender = item => ({ id: item.id, sender: item.direction === 'outgoing' ? 'あなた' : item.sender || target?.name || '' })

  // 選んだ文章への返信（a269r）。同じ吹き出しの .message-text の中だけ。ボタンは選択の下に出し、押しても選択を外さない。
  let selectionPick = null
  const selectionButton = document.createElement('button')
  selectionButton.type = 'button'
  selectionButton.className = 'reply-selection'
  selectionButton.textContent = '引用して返信'
  selectionButton.hidden = true
  selectionButton.addEventListener('mousedown', event => event.preventDefault())
  // 触って押す時、ブラウザは押した瞬間に選択を外すことがある。押している間は消さず、選んだ文章は selectionPick が持つ。
  let pressing = false
  selectionButton.addEventListener('pointerdown', () => { pressing = true })
  for (const name of ['pointerup', 'pointercancel']) selectionButton.addEventListener(name, () => { setTimeout(() => { pressing = false }, 400) })
  selectionButton.addEventListener('click', () => {
    const picked = selectionPick
    pressing = false
    selectionButton.hidden = true; selectionPick = null
    globalThis.getSelection?.()?.removeAllRanges()
    if (picked) onReply(picked)
  })
  const holderOf = node => (node?.nodeType === 3 ? node.parentElement : node)?.closest?.('.message-text') ?? null
  function quoteOfSelection(selection) {
    const range = selection.getRangeAt(0), holder = holderOf(range.startContainer)
    if (!holder || holder !== holderOf(range.endContainer) || !timelineItems.contains(holder)) return null
    const item = state.timelineMap.get(holder.closest('[data-id]')?.dataset.id)
    const text = selection.toString().trim().slice(0, 10000) // reply.md: 1..10000 characters; start is omitted (the bubble shows rendered markup)
    if (!item || !text.trim()) return null
    return { ...replySender(item), text: text.replace(/\s+/gu, ' ').trim(), quote: { text } }
  }
  function onSelectionChange() {
    if (pressing) return
    const selection = globalThis.getSelection?.()
    selectionPick = selection && !selection.isCollapsed ? quoteOfSelection(selection) : null
    selectionButton.hidden = !selectionPick
    if (!selectionPick) return
    const box = selection.getRangeAt(0).getBoundingClientRect()
    selectionButton.style.left = `${Math.max(8, Math.min(box.left, (globalThis.innerWidth ?? 9999) - 140))}px`
    selectionButton.style.top = `${box.bottom + 6}px`
  }
  if (document.body) { document.body.append(selectionButton); document.addEventListener('selectionchange', onSelectionChange) }
  // 引用を押す：読み込み済みの行へ、なければ before で遡って（has_more が尽きるまで）移る。無ければ動かず、その旨を引用の下に出す。
  async function jumpToMessage(id, quote, part = null) {
    const token = state.timelineToken
    while (token === state.timelineToken && !state.timelineMap.has(id) && state.timelineHasMore) {
      if (state.timelineLoadingOlder) { await new Promise(resolve => setTimeout(resolve, 50)); continue }
      const oldest = state.timelineOldestId
      if (!await readHistory(loadOlderMessages)) return // 読めない時は末尾の「もう一度読み込む」が出口
      if (oldest === state.timelineOldestId) break
    }
    if (token !== state.timelineToken) return
    const row = state.timelineMap.has(id) ? timelineItems.querySelector(`[data-id="${CSS.escape(id)}"]`) : null
    if (!row) {
      if (!quote.dataset.missing) { quote.dataset.missing = '1'; quote.after(Object.assign(document.createElement('small'), { className: 'reply-quote-note', textContent: '元のメッセージは見つかりません' })) }
      return
    }
    state.stickToBottom = false
    row.scrollIntoView({ block: 'center' })
    row.classList.add('reply-jumped')
    setTimeout(() => row.classList.remove('reply-jumped'), 2000)
    if (part) highlightPart(row, part)
  }
  // 部分の強調：本文の text node から探し、CSS Custom Highlight で 2.5 秒。見つからない、APIが無い時は行の強調だけ。
  function highlightPart(row, part) {
    const holder = row.querySelector?.('.message-text')
    if (!holder || !globalThis.Highlight || !globalThis.CSS?.highlights) return
    const nodes = [], walker = document.createTreeWalker(holder, 4)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node)
    const hit = locateQuotePart(nodes, part.text, part.from)
    if (!hit) return
    const range = new Range()
    range.setStart(hit.startNode, hit.startOffset); range.setEnd(hit.endNode, hit.endOffset)
    CSS.highlights.set('reply-part', new Highlight(range))
    setTimeout(() => globalThis.CSS?.highlights?.delete('reply-part'), 2500)
  }

  // 読み取り専用の分身の行（fork inquiry "Records and display"）。seat の無い行は本体。
  function seatLabel(item) {
    if (item.seat?.kind !== 'fork') return null
    const label = document.createElement('small')
    label.className = 'seat-label'
    label.textContent = '分身'
    return label
  }

  function renderQueuedItem(item) {
    const wrapper = document.createElement('div')
    wrapper.className = 'queued-card'
    const text = document.createElement('span')
    text.textContent = item.message || (item.image ? imageLabel(item) : '')
    wrapper.append(text, renderQueueStatus([item]))
    return wrapper
  }

  function renderQueueStatus(items) {
    const list = document.createElement('div')
    list.className = 'queue-status'
    for (const item of items) {
      const row = document.createElement('div')
      const label = document.createElement('span')
      const failed = item.status === 'failed'
      // W34: one plain line per member; a working one is animated and has a labelled 停止.
      label.textContent = failed ? `${item.botName}に届きませんでした` : item.status === 'queued' ? `${item.botName}への送信待ち` : `${item.botName}が作業中`
      if (!failed && item.status !== 'queued') label.className = 'queue-working'
      row.append(label)
      if (failed) {
        label.className = 'form-error'
        const message = deliveryFailureMessages.get(item.errorCode)
        if (message) {
          const reason = document.createElement('span')
          reason.textContent = message
          row.append(reason)
        }
        list.append(row)
        continue
      }
      const stop = document.createElement('button')
      stop.type = 'button'
      stop.className = 'queue-stop'
      stop.textContent = '停止'
      stop.title = `${item.botName}の動作を停止`
      stop.setAttribute('aria-label', stop.title)
      stop.dataset.stopBotId = item.botId
      stop.disabled = isStopping(item.botId)
      stop.addEventListener('click', () => { void onStop(item.botId) })
      row.append(stop)
      list.append(row)
    }
    return list
  }

  function roomTimelineItem(record) {
    if (record.secret_request) return record
    const routing = record.routing
    const responderNames = routing?.responders?.map(id => (record.room.members.find(member => member.id === id) ?? { name: id }).name) ?? []
    const deliveries = record.deliveries ?? []
    // W33: no delivery word until a delivery exists.
    const delivery = routing?.status === 'failed' || deliveries.some(item => item.delivery === 'failed') ? 'failed'
      : deliveries.some(item => item.delivery === 'running') ? 'running'
        : deliveries.some(item => item.delivery === 'queued') ? 'queued'
          : deliveries.some(item => item.delivery === 'stopped') ? 'stopped' : deliveries.length ? 'delivered' : ''
    const failures = deliveries.filter(item => item.delivery === 'failed')
    const tracking = routing?.status !== 'failed' && failures.length && failures.every(trackingCompletionUnknown)
      ? failures[0].deliveryTracking : undefined
    return {
      id: record.id,
      kind: 'message',
      direction: record.sender.id === 'user' ? 'outgoing' : 'incoming',
      senderId: record.sender.id,
      sender: memberDisplay(record.sender),
      // W32: a responder chip only when there are responders.
      audience: routing?.status === 'ready' ? responderNames.length ? `↩ ${responderNames.join('、')}` : ''
        : routing?.status === 'pending' ? '返信者を判定中'
          : routing?.status === 'failed' ? '返信者の判定に失敗'
            : '',
      audienceTone: routing?.status === 'pending' ? 'pending' : routing?.status === 'failed' ? 'failed' : '',
      at: record.at,
      message: record.message,
      reply_to: record.reply_to,
      origin: record.origin,
      image: record.image,
      image_count: record.image_count,
      image_url: record.image_url,
      image_urls: record.image_urls,
      delivery,
      deliveryTracking: tracking,
      delivery_error: routing?.status !== 'failed' ? failures.find(item => failedDeliveryReason(item))?.delivery_error : undefined,
    }
  }

  function trackingCompletionUnknown(item) {
    return item.delivery === 'failed' && item.deliveryTracking?.schema === 'bellteam.delivery-tracking.v1'
      && item.deliveryTracking.admission === 'accepted' && item.deliveryTracking.completion === 'unknown'
  }

  function deliveryLabel(item) {
    if (trackingCompletionUnknown(item)) return target?.type === 'room' ? '完了未確認の宛先あり' : '受付済み・完了未確認'
    const reason = failedDeliveryReason(item)
    if (reason) return reason
    return new Map([
      ['queued', '送信待ち'], ['running', '処理中'], ['delivered', '配達済み'], ['failed', '配達失敗'], ['stopped', '停止'],
    ]).get(item.delivery) ?? ''
  }

  function failedDeliveryReason(item) {
    return item.delivery === 'failed' && !trackingCompletionUnknown(item) ? deliveryFailureMessages.get(item.delivery_error?.code) : undefined
  }

  // 画像の取得とURLはcacheが所有し、履歴へ完了した項目だけ返す。
  function loadStoredMessageImages(items, onLoaded) {
    return messageImages.load(items, onLoaded)
  }

  function renderThinking(botId) {
    const wrapper = document.createElement('div')
    wrapper.className = 'message incoming thinking-message'
    wrapper.dataset.botId = botId
    wrapper.setAttribute('role', 'status')
    wrapper.setAttribute('aria-label', `${target?.name ?? 'Bot'}が回答を作成中`)
    const bubble = document.createElement('div')
    bubble.className = 'message-bubble thinking-bubble'
    bubble.innerHTML = '<i></i><i></i><i></i>'
    wrapper.append(bubble)
    return wrapper
  }


  function imageLabel(item) {
    return item.image_count > 1 ? `画像${item.image_count}枚` : '画像'
  }
  // アバター画像から代表色を導く。白・黒・透明に近い画素を除き、彩度の高い画素を重く見た平均色を、
  // 枠線として見える明るさと彩度へ寄せる。Botごとに一度だけ計算する。
  function avatarColor(bot) {
    if (!bot.avatar) return Promise.resolve('')
    if (!avatarColors.has(bot.id)) {
      avatarColors.set(bot.id, new Promise(resolve => {
        const image = new Image()
        image.onload = () => {
          try {
            const size = 24
            const canvas = document.createElement('canvas')
            canvas.width = size
            canvas.height = size
            const context = canvas.getContext('2d')
            context.drawImage(image, 0, 0, size, size)
            const { data } = context.getImageData(0, 0, size, size)
            let r = 0, g = 0, b = 0, weight = 0
            for (let i = 0; i < data.length; i += 4) {
              const [pr, pg, pb, pa] = [data[i], data[i + 1], data[i + 2], data[i + 3]]
              if (pa < 128) continue
              const max = Math.max(pr, pg, pb), min = Math.min(pr, pg, pb)
              if (max > 235 && min > 200) continue
              if (max < 40) continue
              const saturation = max === 0 ? 0 : (max - min) / max
              const w = 0.15 + saturation
              r += pr * w; g += pg * w; b += pb * w; weight += w
            }
            if (weight === 0) return resolve('')
            const [h, s, l] = rgbToHsl(r / weight, g / weight, b / weight)
            resolve(`hsl(${Math.round(h)} ${Math.round(Math.max(45, Math.min(85, s * 100)))}% ${Math.round(Math.max(48, Math.min(62, l * 100)))}%)`)
          } catch {
            resolve('')
          }
        }
        image.onerror = () => resolve('')
        image.src = bot.avatar
      }))
    }
    return avatarColors.get(bot.id)
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255
    const max = Math.max(r, g, b), min = Math.min(r, g, b)
    const l = (max + min) / 2
    if (max === min) return [0, 0, l]
    const d = max - min
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    return [h * 60, s, l]
  }

  return { revealRequest, open(value) { target = { ...value }; return readHistory(openTimeline) },
    refresh() { return target ? readHistory(refreshTimeline) : Promise.resolve(true) }, close,
    updateTarget(value) { if (target?.type === value.type && target.id === value.id) target = { ...value } },
    isBusy(id) { return state.timelineQueue.some(item => item.botId === id && item.status !== 'failed') },
    updateStops() { for (const button of timeline.querySelectorAll('[data-stop-bot-id]')) button.disabled = isStopping(button.dataset.stopBotId) },
  }
}
