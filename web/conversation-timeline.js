import { renderSecretRequest } from './secret-input.js?v=__ASSET_VERSION__'
import { renderOwnerQuestion } from './owner-question.js?v=__ASSET_VERSION__'
import { richTextHtml } from './rich-text.js?v=__ASSET_VERSION__'
import { openImageViewer, renderImageStack } from './image-gallery.js?v=__ASSET_VERSION__'
import { applyAvatar, dayLabel, initials, memberDisplay, formatTime, formatDateTime, escapeClass, escapeHtml } from './view-format.js?v=__ASSET_VERSION__'

export function createConversationTimeline({ timeline, latestButton, api, messageImages, getBot, isStopping, onStop, onQueueChange }) {
  let target = null
  const avatarColors = new Map()
  const state = { timelineMap: new Map(), timelineQueue: [], timelineQueueRequest: 0,
    timelineQueueError: '', timelineHasMore: false, timelineOldestId: null,
    timelineLoadingOlder: false, timelineToken: 0, historyRequest: 0, historyError: '', stickToBottom: true }
  async function readHistory(read) {
    const pending = read()
    const token = state.timelineToken
    const request = state.historyRequest
    try { await pending; return true }
    catch {
      if (token === state.timelineToken && request === state.historyRequest) {
        state.historyError = '会話を読み込めませんでした。開き直して確認してください。'
        renderTail([...state.timelineMap.values()])
      }
      return false
    }
  }
  function close() {
    state.timelineToken++
    target = null
    state.timelineMap.clear()
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
    state.timelineHasMore = false
    state.timelineOldestId = null
    state.timelineLoadingOlder = false
    state.stickToBottom = true
    latestButton.hidden = true
    state.timelineQueue = []
    state.timelineQueueError = ''
    state.historyError = ''
    timelineItems.replaceChildren()
    timelineTail.replaceChildren()
    void refreshTimelineQueue(token)
    const result = await api(`${messagesPath()}?limit=${TIMELINE_FIRST_PAGE}`)
    if (token !== state.timelineToken || request !== state.historyRequest) return
    const items = normalizeItems(result.items)
    rememberItems(items)
    state.timelineHasMore = result.has_more
    state.timelineOldestId = items[0]?.id ?? null
    timelineItems.replaceChildren(dayLabel(), ...items.map(item => renderItem(item, queuedFor(item))))
    state.historyError = ''
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
      state.timelineQueueError = '送信待ちの状態を取得できませんでした。更新して確認してください。'
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
    state.historyError = ''
    renderTail([...state.timelineMap.values()])
    if (state.stickToBottom) scrollToBottom()
    loadStoredMessageImages([...latestItems, ...newItems], item => rerenderItem(item.id, token))
  }

  // 上へ遡ったら前のページを先頭に足し、見ている位置は動かさない。
  async function loadOlderMessages() {
    if (!state.timelineHasMore || state.timelineLoadingOlder || !state.timelineOldestId) return
    state.timelineLoadingOlder = true
    const token = state.timelineToken
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
      timeline.scrollTo({ top: timeline.scrollTop + (timeline.scrollHeight - before), behavior: 'instant' })
      loadStoredMessageImages(items, item => rerenderItem(item.id, token))
    } finally {
      if (token === state.timelineToken) state.timelineLoadingOlder = false
    }
  }

  function rerenderItem(id, token) {
    if (token !== state.timelineToken) return
    const item = state.timelineMap.get(id)
    const element = timelineItems.querySelector(`[data-id="${CSS.escape(id)}"]`)
    if (item && element) element.replaceWith(renderItem(item, queuedFor(item)))
  }

  function renderTail(items) {
    const renderedIds = new Set(items.map(item => item.id))
    const tail = state.timelineQueue.filter(entry => !renderedIds.has(entry.groupId)).map(renderQueuedItem)
    if (target?.type === 'bot' && state.timelineQueue.some(entry => entry.status === 'running')) tail.push(renderThinking(target.id))
    timelineTail.replaceChildren(...tail)
    for (const message of [state.timelineQueueError, state.historyError].filter(Boolean)) {
      const note = document.createElement('p')
      note.className = 'form-error'
      note.textContent = message
      timelineTail.append(note)
    }
    onQueueChange()
  }

  timeline.addEventListener('scroll', () => {
    state.stickToBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 40
    latestButton.hidden = !target || state.stickToBottom
    if (timeline.scrollTop < 240) void readHistory(loadOlderMessages)
  })
  new ResizeObserver(() => { if (state.stickToBottom) scrollToBottom() }).observe(timelineItems)
  new ResizeObserver(() => { if (state.stickToBottom) scrollToBottom() }).observe(timelineTail)

  function renderItem(item, queued = []) {
    const element = renderItemElement(item, queued)
    element.dataset.id = item.id
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
    if (item.kind === 'peer') {
      const details = document.createElement('details')
      details.className = 'peer-event'
      const verb = item.direction === 'sent' ? 'へメッセージを送りました' : 'からメッセージを受け取りました'
      const peer = item.peerPosition ? `${item.peerName} ${item.peerPosition}` : item.peerName
      details.innerHTML = `<summary>${escapeHtml(peer)}${verb}</summary><div class="peer-detail"><strong>${formatDateTime(item.at)}</strong>${richTextHtml(item.message)}</div>`
      if (!queued.length) return details
      const wrapper = document.createElement('div')
      wrapper.className = 'queued-peer'
      wrapper.append(details, renderQueueStatus(queued))
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
    if (item.audience) {
      const audience = document.createElement('small')
      audience.className = 'message-audience'
      audience.textContent = item.audience
      bubble.append(audience)
    }
    // 2枚以上の束は吹き出しの外に置き、枠に囲まずに見せる。
    let imageStack = null
    if (item.image) {
      const previews = messageImages.get(item.id)
      if (previews) {
        const alt = item.direction === 'incoming' ? 'Botが提示した画像' : '送信した画像'
        const open = index => openImageViewer(previews, index, alt)
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
    if (item.message?.trim()) {
      const text = document.createElement('span')
      text.className = 'message-text'
      text.innerHTML = richTextHtml(item.message)
      bubble.append(text)
    }
    const time = document.createElement('div')
    time.className = 'message-time'
    const delivery = !queued.length && item.direction === 'outgoing' ? deliveryLabel(item.delivery) : ''
    time.textContent = [formatTime(item.at), delivery].filter(Boolean).join(' · ')
    if (item.delivery === 'failed') time.classList.add('failed')
    if (imageStack) column.append(imageStack)
    if (!imageStack || bubble.childElementCount) column.append(bubble)
    column.append(time)
    if (queued.length) column.append(renderQueueStatus(queued))
    wrapper.append(column)
    return wrapper
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
      label.textContent = `${item.botName} · ${item.status === 'queued' ? '送信待ち' : '処理中'}`
      row.append(label)
      const stop = document.createElement('button')
      stop.type = 'button'
      stop.textContent = '■'
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
    const responderNames = routing?.responders?.map(id => memberDisplay(record.room.members.find(member => member.id === id) ?? { id, name: id })) ?? []
    const deliveries = record.deliveries ?? []
    const delivery = routing?.status === 'failed' || deliveries.some(item => item.delivery === 'failed') ? 'failed'
      : deliveries.some(item => item.delivery === 'running') ? 'running'
        : deliveries.some(item => item.delivery === 'queued') ? 'queued'
          : deliveries.some(item => item.delivery === 'stopped') ? 'stopped' : 'delivered'
    return {
      id: record.id,
      kind: 'message',
      direction: record.sender.id === 'user' ? 'outgoing' : 'incoming',
      senderId: record.sender.id,
      sender: memberDisplay(record.sender),
      audience: routing?.status === 'ready' ? `返信: ${responderNames.join('、') || 'なし'}`
        : routing?.status === 'pending' ? '返信者を判定中'
          : routing?.status === 'failed' ? '返信者の判定に失敗'
            : '',
      at: record.at,
      message: record.message,
      image: record.image,
      image_count: record.image_count,
      image_url: record.image_url,
      image_urls: record.image_urls,
      delivery,
    }
  }

  function deliveryLabel(delivery) {
    return new Map([
      ['queued', '送信待ち'], ['running', '処理中'], ['delivered', '配達済み'], ['failed', '配達失敗'], ['stopped', '停止'],
    ]).get(delivery) ?? ''
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

  return { open(value) { target = { ...value }; return readHistory(openTimeline) },
    refresh() { return target ? readHistory(refreshTimeline) : Promise.resolve(true) }, close,
    updateTarget(value) { if (target?.type === value.type && target.id === value.id) target = { ...value } },
    isBusy(id) { return state.timelineQueue.some(item => item.botId === id) },
    updateStops() { for (const button of timeline.querySelectorAll('[data-stop-bot-id]')) button.disabled = isStopping(button.dataset.stopBotId) },
  }
}
