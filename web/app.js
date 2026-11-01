import { createOwnerEditor } from './owner-editor.js?v=__ASSET_VERSION__'
import { createBotEditor } from './bot-editor.js?v=__ASSET_VERSION__'
import { createRoomEditor } from './room-editor.js?v=__ASSET_VERSION__'
import { createMemoryView } from './memory-view.js?v=__ASSET_VERSION__'
import { createScreenView, createCharacterSheetView } from './bot-read-views.js?v=__ASSET_VERSION__'
import { createScheduleEditor } from './schedule-editor.js?v=__ASSET_VERSION__'
import { createConversationTimeline } from './conversation-timeline.js?v=__ASSET_VERSION__'
import { applyAvatar, initials, memberDisplay, formatTime, escapeClass, escapeHtml } from './view-format.js?v=__ASSET_VERSION__'
import { openOnboarding } from './onboarding.js?v=__ASSET_VERSION__'
import { claimSingleFlight, readApiError, readApiResponse, releaseSingleFlight } from './chat-input.js?v=__ASSET_VERSION__'
import { createMessageImageCache } from './message-images.js?v=__ASSET_VERSION__'
import { createConversationComposer } from './conversation-composer.js?v=__ASSET_VERSION__'
import { hasUnreadConversation, newestByRecent } from './activity-order.js?v=__ASSET_VERSION__'
import { requestMemberStop } from './member-stop.js?v=__ASSET_VERSION__'
import { goalsView } from './goals.js?v=__ASSET_VERSION__'

const READ_RECEIPTS_KEY = 'bellteam-read-receipts.v1'

const app = document.querySelector('#app')
const goals = goalsView(document.querySelector('#goals-dialog'), api, () => state.bots, document.querySelector('#chat-goal'))
document.querySelector('#goals-button').addEventListener('click', () => { void goals.open() })
const botList = document.querySelector('#bot-list')
const ownerProfileButton = document.querySelector('#owner-profile-button')
const ownerDialog = document.querySelector('#owner-dialog')
const chat = document.querySelector('#chat')
const timeline = document.querySelector('#timeline')
const latestButton = document.querySelector('#scroll-to-latest')
const chatName = document.querySelector('#chat-name')
const chatStatus = document.querySelector('#chat-status')
const screenButton = document.querySelector('#screen-button')
const screenPanel = document.querySelector('#screen-panel')
const screenStatus = document.querySelector('#screen-status')
const screenText = document.querySelector('#screen-text')
const headerAvatar = document.querySelector('#header-avatar')
const editBotButton = document.querySelector('#edit-bot-button')
const composer = document.querySelector('#composer')
const messageInput = document.querySelector('#message-input')
const composerError = document.querySelector('#composer-error')
const sendButton = document.querySelector('#send-button')
const stopButton = document.querySelector('#stop-button')
const stoppingMembers = new Set()
const attachmentButton = document.querySelector('#attachment-button')
const messageImage = document.querySelector('#message-image')
const attachmentPreview = document.querySelector('#attachment-preview')
const botDialog = document.querySelector('#bot-dialog')
const characterSheetDialog = document.querySelector('#character-sheet-dialog')
const characterSheetList = document.querySelector('#character-sheet-list')
const memoryDialog = document.querySelector('#memory-dialog')
const scheduleDialog = document.querySelector('#schedule-dialog')
const actionDialog = document.querySelector('#action-dialog')
const roomDialog = document.querySelector('#room-dialog')
const targetPicker = document.querySelector('#target-picker')
const targetButton = document.querySelector('#target-button')
const targetMenu = document.querySelector('#target-menu')

let catalogueRead = 0
const state = {
  setup: null,
  owner: null,
  settings: [],
  authMode: null,
  bots: [],
  rooms: [],
  selected: null,
  selectedType: null,
  streamAbort: null,
  readReceipts: loadReadReceipts(),
}

const messageImages = createMessageImageCache()
window.addEventListener('pagehide', event => { if (!event.persisted) messageImages.close() })

const conversationComposer = createConversationComposer({
  input: messageInput, attachments: attachmentPreview, error: composerError, sendButton,
  recovery: document.querySelector('#retained-inputs'), api, readImage,
  getTargets: target => target.type === 'room' ? selectedTargets(target.id) : null,
  setTargets: (target, targets) => {
    if (target.type !== 'room' || !targets) return
    state.roomTargets ??= new Map()
    state.roomTargets.set(target.id, new Set(targets))
    if (state.selectedType === 'room' && state.selected?.id === target.id) renderTargetPicker(state.selected)
  },
  findTarget: target => (target.type === 'room' ? state.rooms : state.bots).find(item => item.id === target.id),
  onSelect: target => {
    const item = (target.type === 'room' ? state.rooms : state.bots).find(item => item.id === target.id)
    if (item) return target.type === 'room' ? selectRoom(item) : selectBot(item)
  },
  onAccepted: async (target, result, previews) => {
    if (previews.length) messageImages.remember(result.delivery_id ?? result.id, previews)
    const results = await Promise.allSettled([loadBots(),
      state.selectedType === target.type && state.selected?.id === target.id ? loadMessages(false) : Promise.resolve()])
    if (results.some(result => result.status === 'rejected' || result.value === false)) throw new Error('DISPLAY_REFRESH_FAILED')
  },
})

const memoryView = createMemoryView(memoryDialog, { api })
const characterSheets = createCharacterSheetView(characterSheetDialog, characterSheetList, { api })
const screenView = createScreenView({ panel: screenPanel, status: screenStatus, text: screenText, header: document.querySelector('.chat-header'), api })

const scheduleEditor = createScheduleEditor(scheduleDialog, { api, getBot: id => state.bots.find(bot => bot.id === id) })

const roomEditor = createRoomEditor(roomDialog, { api, getBots: () => state.bots,
  onSaved: async (room, current) => {
    if (await loadBots() !== true) return
    const saved = state.rooms.find(item => item.id === room.id)
    if (current() && saved) await selectRoom(saved)
  },
  onDeleted: async room => {
    catalogueRead++
    state.rooms = state.rooms.filter(item => item.id !== room.id)
    if (state.selectedType === 'room' && state.selected?.id === room.id) clearSelection()
    renderBots()
    await loadBots()
  },
})

const botEditor = createBotEditor(botDialog, { api,
  onSaved: async (bot, current) => {
    if (await loadBots() !== true) return
    const saved = state.bots.find(item => item.id === bot.id)
    if (current() && saved) await selectBot(saved)
  },
  onDeleted: async bot => {
    catalogueRead++
    state.bots = state.bots.filter(item => item.id !== bot.id)
    if (state.selectedType === 'bot' && state.selected?.id === bot.id) clearSelection()
    renderBots()
    setTimeout(() => { void loadBots().catch(() => conversationComposer.showError('一覧を更新できませんでした。')) }, 500)
  },
  onRestarted: bot => setTimeout(async () => {
    try {
      if (await loadBots() !== true) return
      if (state.selectedType !== 'bot' || state.selected?.id !== bot.id) return
      const current = state.bots.find(item => item.id === bot.id)
      if (current) await selectBot(current)
    } catch { if (state.selected?.id === bot.id) conversationComposer.showError('再起動操作後の表示を更新できませんでした。') }
  }, 1000),
  onStatus: (bot, message) => { if (state.selectedType === 'bot' && state.selected?.id === bot.id) chatStatus.textContent = message },
  onMemory: bot => memoryView.open(bot), onSheets: bot => characterSheets.open(bot),
})

const ownerEditor = createOwnerEditor(ownerDialog, { api,
  onOwner: owner => { catalogueRead++; state.owner = owner; renderOwner() },
  onSettings: (settings, authMode) => {
    state.settings = settings
    state.authMode = authMode
    if (state.selectedType === 'room') renderTargetPicker(state.selected)
  },
})

targetButton.addEventListener('click', () => toggleTargetMenu())
document.addEventListener('click', event => {
  if (!targetMenu.hidden && !targetPicker.contains(event.target)) toggleTargetMenu(false)
})

document.querySelector('#back-button').addEventListener('click', () => app.classList.remove('chat-open'))
ownerProfileButton.addEventListener('click', openOwnerDialog)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && document.querySelector('#goals-dialog').open) void goals.refresh()
  else if (!document.hidden) void goals.refreshSelected()
})
document.querySelector('#add-button').addEventListener('click', () => actionDialog.showModal())
document.querySelector('#action-add-bot').addEventListener('click', () => { actionDialog.close(); openBotDialog() })
document.querySelector('#action-add-room').addEventListener('click', () => { actionDialog.close(); openRoomDialog() })
editBotButton.addEventListener('click', () => {
  if (state.selectedType === 'bot') openBotDialog(state.selected)
  if (state.selectedType === 'room') openRoomDialog(state.selected)
})
document.querySelector('#schedule-button').addEventListener('click', openScheduleDialog)
document.querySelector('#export-button').addEventListener('click', async event => {
  if (!state.selected) return
  const button = event.currentTarget
  const { id } = state.selected
  const kind = state.selectedType === 'room' ? 'rooms' : 'bots'
  button.disabled = true
  try {
    const exported = await api(`/api/${kind}/${id}/export`)
    const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `BellTeam-${id}.json`
    link.click()
    URL.revokeObjectURL(url)
  } catch (error) { conversationComposer.showError(`書き出せませんでした（${error.message}）`) }
  finally { button.disabled = false }
})

document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => document.querySelector(`#${button.dataset.closeDialog}`).close()))
screenButton.addEventListener('click', () => (screenPanel.hidden ? openScreen() : closeScreen()))
document.querySelector('#screen-close').addEventListener('click', closeScreen)

function openScreen() {
  if (state.selectedType === 'bot' && state.selected) return screenView.open(state.selected)
}
function closeScreen() { screenView.close() }

attachmentButton.addEventListener('click', () => messageImage.click())
messageImage.addEventListener('change', () => {
  conversationComposer.addImages([...messageImage.files])
  messageImage.value = ''
})
messageInput.addEventListener('paste', event => {
  const images = [...event.clipboardData.files].filter(file => file.type.startsWith('image/'))
  if (!images.length) return
  event.preventDefault()
  conversationComposer.addImages(images)
})
composer.addEventListener('submit', sendMessage)
stopButton.addEventListener('click', () => { if (state.selectedType === 'bot' && state.selected) void stopMember(state.selected.id) })
boot().catch(cause => {
  const error = document.createElement('p')
  error.className = 'form-error'
  error.textContent = `BellTeamに接続できません: ${cause.message}`
  app.prepend(error)
})

async function boot() {
  sendButton.disabled = true
  localStorage.removeItem('bellteam-token')
  const session = await api('/api/session')
  state.authMode = session.authMode
  if (!session.authenticated) {
    if (session.authMode === 'cloudflare') {
      const notice = document.createElement('p')
      notice.className = 'form-error'
      notice.textContent = 'Cloudflare Accessへログインしてください。'
      const login = document.createElement('a')
      login.href = location.origin
      login.textContent = '接続先を開いてログイン'
      notice.append(login)
      app.prepend(notice)
      return
    }
    throw new Error('接続先が認証を拒否しました。')
  }
  await loadFeatureSettings()
  const setup = await api('/api/setup')
  state.setup = setup
  if (setup.phase !== 'ready') {
    openOnboarding(setup, { api, onReady: startConversations })
    return
  }
  await startConversations(setup)
}

async function startConversations(setup) {
  state.setup = setup
  await loadBots()
  if (!setup.complete && setup.guideBotId) {
    const guide = state.bots.find(bot => bot.id === setup.guideBotId)
    if (!guide) throw new Error('案内役が見つかりません。')
    await selectBot(guide)
  }
  void connectEvents()
}

async function loadFeatureSettings() {
  state.settings = (await api('/api/settings')).settings
  if (state.selectedType === 'room') renderTargetPicker(state.selected)
}

async function loadBots() {
  const read = ++catalogueRead
  let botResult, roomResult, ownerResult
  try {
    [botResult, roomResult, ownerResult] = await Promise.all([api('/api/bots?avatar=omit'), api('/api/rooms'), api('/api/owner')])
  } catch (error) {
    if (read !== catalogueRead) return null
    throw error
  }
  if (read !== catalogueRead) return null
  state.bots = botResult.bots.map(bot => ({ ...bot, avatar: bot.avatarVersion ? `/api/bots/${encodeURIComponent(bot.id)}/avatar?v=${encodeURIComponent(bot.avatarVersion)}` : '' }))
  state.rooms = roomResult.rooms
  state.owner = ownerResult.owner
  if (state.selected) {
    const source = state.selectedType === 'room' ? state.rooms : state.bots
    const current = source.find(item => item.id === state.selected.id)
    if (current) {
      state.selected = current
      conversationTimeline.updateTarget({ type: state.selectedType, id: current.id, name: current.displayName ?? current.name })
      if (app.classList.contains('chat-open')) markConversationRead(state.selectedType, current)
    }
    else clearSelection()
  }
  renderOwner()
  renderBots()
  return true
}

function renderOwner() {
  const owner = state.owner
  ownerProfileButton.textContent = initials(owner?.name || 'O')
  applyAvatar(ownerProfileButton, owner ?? { avatar: '' })
}

function openOwnerDialog() { return ownerEditor.open(state.owner) }

function renderBots() {
  const botRows = newestByRecent(state.bots).map(bot => {
    const button = document.createElement('button')
    const unread = hasUnreadConversation(bot, 'bot', state.readReceipts[conversationKey('bot', bot.id)])
    button.className = `bot-row${state.selectedType === 'bot' && state.selected?.id === bot.id ? ' active' : ''}${unread ? ' unread' : ''}`
    button.dataset.conversation = conversationKey('bot', bot.id)
    button.type = 'button'
    button.addEventListener('click', () => selectBot(bot))
    const preview = bot.recent
      ? (bot.recent.kind === 'peer' ? '他のメンバーと連絡しました' : bot.recent.message || (bot.recent.image ? '画像を送信しました' : ''))
      : 'まだ会話はありません'
    button.innerHTML = `
      <span class="avatar ${escapeClass(bot.color)}" data-avatar>${initials(bot.name)}<i class="presence ${bot.online ? 'online' : ''}"></i></span>
      <span class="bot-copy"><span class="bot-name">${escapeHtml(bot.displayName)}</span><span class="bot-preview">${escapeHtml(preview)}</span></span>
      <span class="bot-meta"><time class="bot-time">${formatTime(bot.recent?.at)}</time>${unread ? '<i class="unread-dot" aria-label="未読"></i>' : ''}</span>`
    applyAvatar(button.querySelector('[data-avatar]'), bot)
    return button
  })
  const roomRows = newestByRecent(state.rooms).map(room => {
    const button = document.createElement('button')
    const unread = hasUnreadConversation(room, 'room', state.readReceipts[conversationKey('room', room.id)])
    button.className = `bot-row${state.selectedType === 'room' && state.selected?.id === room.id ? ' active' : ''}${unread ? ' unread' : ''}`
    button.dataset.conversation = conversationKey('room', room.id)
    button.type = 'button'
    button.addEventListener('click', () => selectRoom(room))
    const recent = room.recent
    const preview = recent ? `${memberDisplay(recent.sender)}: ${recent.message || (recent.image ? '画像' : '')}` : 'まだ会話はありません'
    button.innerHTML = `
      <span class="avatar room-avatar">${initials(room.name)}</span>
      <span class="bot-copy"><span class="bot-name">${escapeHtml(room.name)}</span><span class="bot-preview">${escapeHtml(preview)}</span></span>
      <span class="bot-meta"><time class="bot-time">${formatTime(recent?.at)}</time>${unread ? '<i class="unread-dot" aria-label="未読"></i>' : ''}</span>`
    applyAvatar(button.querySelector('.avatar'), room)
    return button
  })
  const roomHeading = document.createElement('p')
  roomHeading.className = 'list-heading'
  roomHeading.textContent = 'ルーム'
  botList.replaceChildren(...botRows, roomHeading, ...roomRows)
}

async function selectBot(bot) {
  state.selected = bot
  state.selectedType = 'bot'
  conversationComposer.select({ type: 'bot', id: bot.id, name: bot.displayName })
  void goals.select(bot.id)
  updateSendButton()
  targetPicker.hidden = true
  toggleTargetMenu(false)
  chat.classList.remove('empty')
  app.classList.add('chat-open')
  chatName.textContent = bot.displayName
  chatStatus.textContent = bot.online ? 'オンライン' : '待機中 · 送信時に起動'
  headerAvatar.className = `mini-avatar ${escapeClass(bot.color)}`
  headerAvatar.textContent = initials(bot.name)
  applyAvatar(headerAvatar, bot)
  editBotButton.disabled = false
  screenButton.hidden = false
  if (!screenPanel.hidden) void screenView.open(bot)
  markConversationRead('bot', bot)
  renderBots()
  await loadMessages(false)
  updateSendButton()
  messageInput.focus()
}

async function selectRoom(room) {
  void goals.select(null)
  closeScreen()
  screenButton.hidden = true
  state.selected = room
  state.selectedType = 'room'
  conversationComposer.select({ type: 'room', id: room.id, name: room.name })
  updateSendButton()
  chat.classList.remove('empty')
  app.classList.add('chat-open')
  chatName.textContent = room.name
  chatStatus.textContent = `${room.memberIds.length}人`
  headerAvatar.className = 'mini-avatar room-avatar'
  headerAvatar.textContent = initials(room.name)
  applyAvatar(headerAvatar, room)
  editBotButton.disabled = false
  renderTargetPicker(room)
  markConversationRead('room', room)
  renderBots()
  await loadMessages(false)
  updateSendButton()
  messageInput.focus()
}

function clearSelection() {
  conversationComposer.clear()
  conversationTimeline.close()
  void goals.select(null)
  closeScreen()
  screenButton.hidden = true
  state.selected = null
  state.selectedType = null
  chat.classList.add('empty')
  app.classList.remove('chat-open')
  chatName.textContent = 'メンバーを選択'
  chatStatus.textContent = 'BellTeam'
  headerAvatar.className = 'mini-avatar'
  headerAvatar.textContent = ''
  headerAvatar.style.backgroundImage = ''
  editBotButton.disabled = true
  stopButton.hidden = true
}

function openBotDialog(bot = null) { return botEditor.open(bot) }

function openRoomDialog(room = null) { roomEditor.open(room) }

function openScheduleDialog() {
  if (!state.selected) return
  return scheduleEditor.open({ ...state.selected, type: state.selectedType })
}

function routingEnabled() { return state.settings.some(setting => setting.id === 'routing' && setting.status === 'enabled') }

// 自動選択が有効な時だけ、返信者の未指定を認める。
// 選択はルームごとに画面内だけで覚える。
function selectedTargets(roomId) {
  const chosen = state.roomTargets?.get(roomId)
  return chosen && chosen.size > 0 ? [...chosen] : null
}

function renderTargetPicker(room) {
  targetPicker.hidden = false
  toggleTargetMenu(false)
  state.roomTargets ??= new Map()
  const chosen = state.roomTargets.get(room.id) ?? new Set()
  for (const id of [...chosen]) if (!room.memberIds.includes(id)) chosen.delete(id)
  state.roomTargets.set(room.id, chosen)
  const note = document.createElement('p')
  note.className = 'target-menu-note'
  note.textContent = routingEnabled() ? '未選択なら返信者を自動選択。発言は全員に届きます。' : '自動選択は未設定です。返信するメンバーを選んでください。発言は全員に届きます。'
  targetMenu.replaceChildren(note, ...room.memberIds.map(id => {
    const bot = state.bots.find(item => item.id === id)
    const label = document.createElement('label')
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.value = id
    input.checked = chosen.has(id)
    input.addEventListener('change', () => {
      if (input.checked) chosen.add(id); else chosen.delete(id)
      renderTargetButton(room)
    })
    const avatar = document.createElement('span')
    avatar.className = `mini-avatar ${escapeClass(bot?.color ?? '')}`
    avatar.textContent = initials(bot?.name ?? id)
    if (bot) applyAvatar(avatar, bot)
    const name = document.createElement('span')
    name.textContent = bot?.displayName ?? id
    label.append(input, avatar, name)
    return label
  }))
  renderTargetButton(room)
}

function renderTargetButton(room) {
  const chosen = [...(state.roomTargets?.get(room.id) ?? [])]
  const bots = chosen.map(id => state.bots.find(item => item.id === id)).filter(Boolean)
  targetButton.replaceChildren()
  if (bots.length === 0) {
    targetButton.append(Object.assign(document.createElement('span'), { textContent: routingEnabled() ? '自動選択' : '返信者を選択' }))
    return
  }
  const avatar = document.createElement('span')
  avatar.className = `mini-avatar ${escapeClass(bots[0].color)}`
  avatar.textContent = initials(bots[0].name)
  applyAvatar(avatar, bots[0])
  const text = document.createElement('span')
  text.textContent = bots.length === 1 ? bots[0].name : `${bots[0].name} 他${bots.length - 1}人`
  targetButton.append(avatar, text)
}

function toggleTargetMenu(open = targetMenu.hidden) {
  targetMenu.hidden = !open
  targetButton.setAttribute('aria-expanded', String(open))
}

const conversationTimeline = createConversationTimeline({ timeline, latestButton, api, messageImages,
  getBot: id => state.bots.find(bot => bot.id === id),
  isStopping: id => stoppingMembers.has(id), onStop: stopMember, onQueueChange: updateSendButton,
})

async function loadMessages(preserveScroll = true) {
  if (!state.selected) return true
  const target = { type: state.selectedType, id: state.selected.id, name: state.selected.displayName ?? state.selected.name }
  return preserveScroll ? conversationTimeline.refresh() : conversationTimeline.open(target)
}

async function sendMessage(event) {
  event.preventDefault()
  if (!state.selected) return
  if (state.selectedType === 'room' && !routingEnabled() && !selectedTargets(state.selected.id)) {
    conversationComposer.showError('返信者の自動選択は未設定です。返信するメンバーを選んでください。')
    toggleTargetMenu(true)
    targetButton.focus()
    return
  }
  await conversationComposer.send()
}

function updateSendButton() {
  conversationComposer.update()
  const stopping = state.selectedType === 'bot' && state.selected && stoppingMembers.has(state.selected.id)
  const busy = state.selectedType === 'bot' && state.selected && conversationTimeline.isBusy(state.selected.id)
  stopButton.hidden = !busy && !stopping
  stopButton.disabled = Boolean(stopping)
  sendButton.hidden = Boolean(busy || stopping)
  conversationTimeline.updateStops()
}

async function stopMember(botId) {
  if (!claimSingleFlight(stoppingMembers, botId)) return
  const selected = state.selected
  const selectedType = state.selectedType
  const sameConversation = () => state.selected?.id === selected?.id && state.selectedType === selectedType
  updateSendButton()
  try {
    await requestMemberStop(botId, api)
    if (sameConversation()) {
      conversationComposer.showError('')
      if (selectedType === 'bot') chatStatus.textContent = '停止操作を送りました。会話は続けられます'
    }
    try {
      await loadBots()
      if (sameConversation()) await loadMessages()
    } catch {
      if (sameConversation()) {
        conversationComposer.showError('停止操作を送りました。表示を更新できなかったので、会話を開き直してください。')
      }
    }
  } catch {
    if (sameConversation()) {
      conversationComposer.showError('停止結果を確認できませんでした。メンバーの状態を確認してください。')
    }
  } finally {
    releaseSingleFlight(stoppingMembers, botId)
    updateSendButton()
  }
}

function readImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      const match = String(reader.result).match(/^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/u)
      if (!match) return reject(new Error('IMAGE_INVALID'))
      resolve({ mime: match[1], data: match[2] })
    })
    reader.addEventListener('error', () => reject(reader.error))
    reader.readAsDataURL(file)
  })
}

function eventAffectsTimeline(payload, type, id) {
  if (!id) return false
  if (payload.all !== false || !Array.isArray(payload.topics) || !payload.topics.length
    || !Array.isArray(payload.botIds) || !Array.isArray(payload.roomIds)) return true
  const topics = ['timeline', 'queue', 'bots', 'rooms', 'owner', 'settings', 'requests', 'questions', 'ai-control', 'setup', 'schedules']
  if (payload.topics.some(topic => !topics.includes(topic))
    || [...payload.botIds, ...payload.roomIds].some(value => typeof value !== 'string' || !value)
    || !payload.botIds.length && !payload.roomIds.length) return true
  return (type === 'room' ? payload.roomIds : payload.botIds).includes(id)
}

async function refreshFromEvent(payload) {
  try {
    if (payload.type === 'ai-control' && ownerDialog.open) void ownerEditor.refreshAI()
    if (payload.type === 'settings') {
      await loadFeatureSettings()
      if (ownerDialog.open) ownerEditor.refreshFeatureStatus(state.settings)
    }
    if (payload.type === 'setup') state.setup = await api('/api/setup')
    if (state.selectedType === 'bot' && (payload.all || payload.botId === state.selected?.id || payload.botIds?.includes(state.selected?.id)))
      void goals.refreshOnEvent()
    await Promise.all([loadBots(), ...(eventAffectsTimeline(payload, state.selectedType, state.selected?.id) ? [loadMessages()] : [])])
  } catch {
    conversationComposer.showError('表示を更新できませんでした。会話を開き直して確認してください。')
  }
}

async function connectEvents() {
  state.streamAbort?.abort()
  const abort = new AbortController()
  state.streamAbort = abort
  try {
    const response = await fetch('/api/events', {
      signal: abort.signal,
    })
    if (!response.ok) { const error = new Error(`HTTP_${response.status}`); error.status = response.status; throw error }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      while (buffer.includes('\n\n')) {
        const boundary = buffer.indexOf('\n\n')
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5)).join('\n')
        if (!data) continue
        const payload = JSON.parse(data)
        await refreshFromEvent(payload)
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') return
    if (error instanceof TypeError || error.status === 429 || error.status >= 500) { setTimeout(connectEvents, 1500); return }
    conversationComposer.showError(`更新の接続が止まりました: ${error.message}。ページを再読み込みして確認してください。`)
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, options)
  if (!response.ok) { const error = new Error(await readApiError(response)); error.status = response.status; throw error }
  return readApiResponse(response)
}

function conversationKey(type, id) { return `${type}:${id}` }
function loadReadReceipts() {
  try {
    const value = JSON.parse(localStorage.getItem(READ_RECEIPTS_KEY) ?? '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}
function markConversationRead(type, item) {
  if (!item?.recent?.id) return
  state.readReceipts[conversationKey(type, item.id)] = item.recent.id
  try { localStorage.setItem(READ_RECEIPTS_KEY, JSON.stringify(state.readReceipts)) } catch {}
}
