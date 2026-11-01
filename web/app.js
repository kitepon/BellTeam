import { createScheduleEditor } from './schedule-editor.js?v=__ASSET_VERSION__'
import { createConversationTimeline } from './conversation-timeline.js?v=__ASSET_VERSION__'
import { applyAvatar, initials, memberDisplay, formatTime, formatDateTime, escapeClass, escapeHtml } from './view-format.js?v=__ASSET_VERSION__'
import { openOnboarding, renderFeatureSettings, refreshFeatureSettingsStatus } from './onboarding.js?v=__ASSET_VERSION__'
import { renderHarnessAuth } from './harness-auth.js?v=__ASSET_VERSION__'
import { claimSingleFlight, readApiError, readApiResponse, releaseSingleFlight } from './chat-input.js?v=__ASSET_VERSION__'
import { createMessageImageCache } from './message-images.js?v=__ASSET_VERSION__'
import { createAvatarEditor } from './avatar-editor.js?v=__ASSET_VERSION__'
import { createConversationComposer } from './conversation-composer.js?v=__ASSET_VERSION__'
import { hasUnreadConversation, newestByRecent } from './activity-order.js?v=__ASSET_VERSION__'
import { openImageViewer } from './image-gallery.js?v=__ASSET_VERSION__'
import { requestMemberStop } from './member-stop.js?v=__ASSET_VERSION__'
import { aiControlView } from './ai-control.js?v=__ASSET_VERSION__'
import { goalsView } from './goals.js?v=__ASSET_VERSION__'

const READ_RECEIPTS_KEY = 'bellteam-read-receipts.v1'

const app = document.querySelector('#app')
const goals = goalsView(document.querySelector('#goals-dialog'), api, () => state.bots, document.querySelector('#chat-goal'))
document.querySelector('#goals-button').addEventListener('click', () => { void goals.open() })
const botList = document.querySelector('#bot-list')
const ownerProfileButton = document.querySelector('#owner-profile-button')
const ownerDialog = document.querySelector('#owner-dialog')
const aiControl = aiControlView(document.querySelector('#ai-control'), api)
document.addEventListener('visibilitychange', () => { if (!document.hidden && ownerDialog.open) void aiControl.refresh() })
const ownerForm = document.querySelector('#owner-form')
const ownerName = document.querySelector('#owner-name')
const ownerDescription = document.querySelector('#owner-description')
const ownerXUrl = document.querySelector('#owner-x-url')
const ownerGithubUrl = document.querySelector('#owner-github-url')
const ownerAvatarFile = document.querySelector('#owner-avatar-file')
const ownerAvatarPreview = document.querySelector('#owner-avatar-preview')
const ownerCropEditor = document.querySelector('#owner-crop-editor')
const ownerAvatarCrop = document.querySelector('#owner-avatar-crop')
const ownerAvatarZoom = document.querySelector('#owner-avatar-zoom')
const ownerLinks = document.querySelector('#owner-links')
const addOwnerLink = document.querySelector('#add-owner-link')
const ownerFormError = document.querySelector('#owner-form-error')
const userRulesInput = document.querySelector('#user-rules')
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
const restartSessionButton = document.querySelector('#restart-session-button')
const deleteBotButton = document.querySelector('#delete-bot-button')
const botManagementActions = document.querySelector('#bot-management-actions')
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
const botForm = document.querySelector('#bot-form')
const botDialogTitle = document.querySelector('#bot-dialog-title')
const botName = document.querySelector('#bot-name')
const botHarness = document.querySelector('#bot-harness')
const botModel = document.querySelector('#bot-model')
const botModelCustom = document.querySelector('#bot-model-custom')
const botModelCustomField = document.querySelector('#bot-model-custom-field')
const botReasoningEffort = document.querySelector('#bot-reasoning-effort')
const botProfileText = document.querySelector('#bot-profile-text')
const botPersonality = document.querySelector('#bot-personality')
const botSpeechStyle = document.querySelector('#bot-speech-style')
const botPosition = document.querySelector('#bot-position')
const botRole = document.querySelector('#bot-role')
const botAvatarFile = document.querySelector('#bot-avatar-file')
const botAvatarPreview = document.querySelector('#bot-avatar-preview')
const cropEditor = document.querySelector('#crop-editor')
const avatarCrop = document.querySelector('#avatar-crop')
const avatarZoom = document.querySelector('#avatar-zoom')
const botColor = document.querySelector('#bot-color')
const botFormError = document.querySelector('#bot-form-error')
const botModelStatus = document.querySelector('#bot-model-status')
const botConfigurationStatus = document.querySelector('#bot-configuration-status')
let modelLoad = null
const saveBotButton = document.querySelector('#save-bot-button')
const characterSheetButton = document.querySelector('#character-sheet-button')
const characterSheetDialog = document.querySelector('#character-sheet-dialog')
const characterSheetList = document.querySelector('#character-sheet-list')
const memoryButton = document.querySelector('#memory-button')
const memoryDialog = document.querySelector('#memory-dialog')
const memoryDialogTitle = document.querySelector('#memory-dialog-title')
const rememberForm = document.querySelector('#remember-form')
const recallForm = document.querySelector('#recall-form')
const knowledgeForm = document.querySelector('#knowledge-form')
const knowledgeSearchForm = document.querySelector('#knowledge-search-form')
const memoryResults = document.querySelector('#memory-results')
const knowledgeResults = document.querySelector('#knowledge-results')
const memoryFormError = document.querySelector('#memory-form-error')
const scheduleDialog = document.querySelector('#schedule-dialog')
const actionDialog = document.querySelector('#action-dialog')
const roomDialog = document.querySelector('#room-dialog')
const roomForm = document.querySelector('#room-form')
const roomDialogTitle = document.querySelector('#room-dialog-title')
const roomName = document.querySelector('#room-name')
const roomPurpose = document.querySelector('#room-purpose')
const roomMembers = document.querySelector('#room-members')
const roomRepresentative = document.querySelector('#room-representative')
const roomFormError = document.querySelector('#room-form-error')
const roomAvatarFile = document.querySelector('#room-avatar-file')
const roomAvatarPreview = document.querySelector('#room-avatar-preview')
const roomCropEditor = document.querySelector('#room-crop-editor')
const roomAvatarCrop = document.querySelector('#room-avatar-crop')
const roomAvatarZoom = document.querySelector('#room-avatar-zoom')
const targetPicker = document.querySelector('#target-picker')
const targetButton = document.querySelector('#target-button')
const targetMenu = document.querySelector('#target-menu')
const deleteRoomButton = document.querySelector('#delete-room-button')
const roomManagementActions = document.querySelector('#room-management-actions')

const state = {
  setup: null,
  owner: null,
  settings: [],
  authMode: null,
  bots: [],
  rooms: [],
  models: {},
  screenTimer: null,
  avatarColors: new Map(),
  selected: null,
  selectedType: null,
  streamAbort: null,
  editingBot: null,
  editingRoom: null,
  inFlight: new Set(),
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

const scheduleEditor = createScheduleEditor(scheduleDialog, { api, getBot: id => state.bots.find(bot => bot.id === id) })

const botAvatarEditor = createAvatarEditor({
  applyAvatar, initials, escapeClass,
  fileInput: botAvatarFile, preview: botAvatarPreview, cropEditor, canvas: avatarCrop, zoom: avatarZoom,
  nameInput: botName, colorInput: botColor, fallback: 'B', error: botFormError,
})
const ownerAvatarEditor = createAvatarEditor({
  applyAvatar, initials, escapeClass,
  fileInput: ownerAvatarFile, preview: ownerAvatarPreview, cropEditor: ownerCropEditor,
  canvas: ownerAvatarCrop, zoom: ownerAvatarZoom, nameInput: ownerName, fallback: 'O', error: ownerFormError,
})
const roomAvatarEditor = createAvatarEditor({
  applyAvatar, initials, escapeClass,
  fileInput: roomAvatarFile, preview: roomAvatarPreview, cropEditor: roomCropEditor,
  canvas: roomAvatarCrop, zoom: roomAvatarZoom, nameInput: roomName, fallback: 'R', error: roomFormError,
  previewClass: 'avatar room-avatar',
})
for (const [dialog, editor] of [[botDialog, botAvatarEditor], [ownerDialog, ownerAvatarEditor], [roomDialog, roomAvatarEditor]]) {
  dialog.addEventListener('close', () => editor.cancelRead())
}

targetButton.addEventListener('click', () => toggleTargetMenu())
document.addEventListener('click', event => {
  if (!targetMenu.hidden && !targetPicker.contains(event.target)) toggleTargetMenu(false)
})

document.querySelector('#back-button').addEventListener('click', () => app.classList.remove('chat-open'))
ownerProfileButton.addEventListener('click', openOwnerDialog)
ownerForm.addEventListener('submit', saveOwner)
function clearSettingSecrets() {
  for (const input of ownerDialog.querySelectorAll('#feature-settings input[type="password"]')) input.value = ''
}
ownerDialog.addEventListener('close', clearSettingSecrets)
// 設定を閉じたら、AIの認証の確認を止める。進行中の公式認証そのものは止めない（公式サイトで続けられる）。
let harnessAuthSection = null
ownerDialog.addEventListener('close', () => { harnessAuthSection?.stop(); harnessAuthSection = null })
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearSettingSecrets()
  else if (document.querySelector('#goals-dialog').open) void goals.refresh()
  else void goals.refreshSelected()
})
addOwnerLink.addEventListener('click', () => addOwnerLinkRow())
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
characterSheetButton.addEventListener('click', openCharacterSheetDialog)

// キャラクターシートは編集中のBotのプロジェクトから読む。画像は認証付きで取ってblob URLで表示する。
async function openCharacterSheetDialog() {
  const bot = state.editingBot
  if (!bot) return
  characterSheetList.replaceChildren()
  characterSheetDialog.showModal()
  try {
    const { sheets } = await api(`/api/bots/${bot.id}/character-sheet`)
    if (sheets.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'character-sheet-note'
      empty.textContent = 'まだ置かれていない。'
      return characterSheetList.replaceChildren(empty)
    }
    for (const sheet of sheets) {
      const figure = document.createElement('figure')
      const image = document.createElement('img')
      image.alt = sheet.file
      const caption = document.createElement('figcaption')
      caption.textContent = `${sheet.file}（${new Date(sheet.updatedAt).toLocaleString('ja-JP')}）`
      figure.append(image, caption)
      characterSheetList.append(figure)
      const response = await fetch(sheet.url)
      if (!response.ok) { const error = new Error(`HTTP_${response.status}`); error.status = response.status; throw error }
      image.src = URL.createObjectURL(await response.blob())
    }
  } catch (error) {
    const failed = document.createElement('p')
    failed.className = 'form-error'
    failed.textContent = `キャラクターシートを読めませんでした（${error.message}）`
    characterSheetList.append(failed)
  }
}

restartSessionButton.addEventListener('click', restartSelectedSession)
deleteBotButton.addEventListener('click', deleteSelectedBot)
deleteRoomButton.addEventListener('click', deleteSelectedRoom)
memoryButton.addEventListener('click', openMemoryDialog)
document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => document.querySelector(`#${button.dataset.closeDialog}`).close()))
botForm.addEventListener('submit', saveBot)
rememberForm.addEventListener('submit', remember)
recallForm.addEventListener('submit', recallMemory)
knowledgeForm.addEventListener('submit', recordKnowledge)
knowledgeSearchForm.addEventListener('submit', searchKnowledge)
roomForm.addEventListener('submit', saveRoom)
roomMembers.addEventListener('change', () => renderRoomRepresentativeOptions())
screenButton.addEventListener('click', () => (screenPanel.hidden ? openScreen() : closeScreen()))
document.querySelector('#screen-close').addEventListener('click', closeScreen)

// Botの画面をそのまま見せる。動いているか止まっているかを人が判断するための面で、開いている間だけ2秒ごとに読む。
async function openScreen() {
  if (state.selectedType !== 'bot' || !state.selected) return
  screenPanel.style.top = `${document.querySelector('.chat-header').offsetHeight}px`
  screenPanel.hidden = false
  await refreshScreen()
  state.screenTimer = setInterval(refreshScreen, 2000)
}
// 端末は80桁固定なので、80桁がパネル幅に収まる文字サイズへ縮める（折り返さない）。
const SCREEN_COLUMNS = 80
function fitScreenFont(screen) {
  const columns = Math.min(SCREEN_COLUMNS, Math.max(40, ...screen.split('\n').map(line => [...line].reduce((n, c) => n + (/[\u3000-\u9fff\uff00-\uffef]/u.test(c) ? 2 : 1), 0))))
  const probe = document.createElement('span')
  probe.textContent = '0'.repeat(columns)
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:12px/1 ui-monospace,SFMono-Regular,Menlo,monospace'
  document.body.append(probe)
  const probeWidth = probe.getBoundingClientRect().width
  probe.remove()
  const available = screenText.clientWidth - 28
  if (probeWidth > 0 && available > 0) screenText.style.fontSize = `${Math.min(12, 12 * available / probeWidth).toFixed(2)}px`
}
window.addEventListener('resize', () => { if (!screenPanel.hidden) fitScreenFont(screenText.textContent) })

function closeScreen() {
  clearInterval(state.screenTimer)
  state.screenTimer = null
  screenPanel.hidden = true
}
async function refreshScreen() {
  const bot = state.selected
  if (!bot || state.selectedType !== 'bot') return closeScreen()
  try {
    const result = await api(`/api/bots/${bot.id}/screen`)
    screenStatus.textContent = result.online ? `${bot.displayName} の画面 · 2秒ごとに更新` : `${bot.displayName} は停止中（次のメッセージで起動）`
    const stick = screenText.scrollHeight - screenText.scrollTop - screenText.clientHeight < 24
    screenText.textContent = result.screen.replace(/\s+$/u, '')
    fitScreenFont(result.screen)
    if (stick) screenText.scrollTop = screenText.scrollHeight
  } catch {
    screenStatus.textContent = '画面を読めませんでした'
  }
}
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

async function refreshFeatureSettingsForm() {
  await loadFeatureSettings()
  const session = await api('/api/session')
  state.authMode = session.authMode
  document.querySelector('#connection-mode').textContent = session.authMode === 'cloudflare' ? 'Cloudflare Accessで認証済み' : 'ローカル接続'
  renderFeatureSettings(document.querySelector('#feature-settings'), state.settings, { api, onChange: refreshFeatureSettingsForm })
}

async function loadBots() {
  const [botResult, roomResult, ownerResult] = await Promise.all([api('/api/bots?avatar=omit'), api('/api/rooms'), api('/api/owner')])
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
}

function renderOwner() {
  const owner = state.owner
  ownerProfileButton.textContent = initials(owner?.name || 'O')
  applyAvatar(ownerProfileButton, owner ?? { avatar: '' })
}

async function openOwnerDialog() {
  if (!state.owner) return
  void aiControl.refresh()
  ownerForm.reset()
  ownerFormError.textContent = ''
  try {
    userRulesInput.value = (await api('/api/user-rules')).text
  } catch (error) {
    ownerFormError.textContent = `ユーザー規範を読めませんでした（${error.message}）`
  }
  ownerName.value = state.owner.name
  ownerDescription.value = state.owner.profile ?? ''
  ownerXUrl.value = state.owner.xUrl ?? ''
  ownerGithubUrl.value = state.owner.githubUrl ?? ''
  renderOwnerLinkRows(state.owner.links ?? [])
  ownerAvatarEditor.reset(state.owner.avatar)
  try {
    document.querySelector('#feature-settings-error').textContent = ''
    await refreshFeatureSettingsForm()
  } catch (error) { document.querySelector('#feature-settings-error').textContent = error.message }
  harnessAuthSection?.stop()
  harnessAuthSection = null
  try {
    document.querySelector('#harness-auth-error').textContent = ''
    harnessAuthSection = await renderHarnessAuth(document.querySelector('#harness-auth'), { api })
  } catch (error) { document.querySelector('#harness-auth-error').textContent = error.message }
  ownerDialog.showModal()
}

async function saveOwner(event) {
  event.preventDefault()
  ownerFormError.textContent = ''
  const links = [...ownerLinks.querySelectorAll('.owner-link-row')].map(row => ({
    label: row.querySelector('[data-owner-link-label]').value.trim(),
    url: row.querySelector('[data-owner-link-url]').value.trim(),
  }))
  try {
    const result = await api('/api/owner', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: ownerName.value.trim(), profile: ownerDescription.value, avatar: ownerAvatarEditor.value(),
        xUrl: ownerXUrl.value.trim(), githubUrl: ownerGithubUrl.value.trim(), links,
      }),
    })
    state.owner = result.owner
    await api('/api/user-rules', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: userRulesInput.value }),
    })
    renderOwner()
    ownerDialog.close()
  } catch (error) {
    ownerFormError.textContent = `保存できませんでした（${error.message}）`
  }
}

function renderOwnerLinkRows(links) {
  ownerLinks.replaceChildren()
  links.forEach(link => addOwnerLinkRow(link, false))
}

function addOwnerLinkRow(link = { label: '', url: '' }, focus = true) {
  const row = document.createElement('div')
  row.className = 'owner-link-row'
  row.innerHTML = `<input data-owner-link-label required maxlength="100" aria-label="情報源の名前" placeholder="ブログ" value="${escapeHtml(link.label)}"><input data-owner-link-url required type="url" maxlength="2048" inputmode="url" aria-label="情報源のURL" placeholder="https://example.com" value="${escapeHtml(link.url)}"><button type="button" aria-label="情報源を削除">×</button>`
  row.querySelector('button').addEventListener('click', () => row.remove())
  ownerLinks.append(row)
  if (focus) row.querySelector('input').focus()
}

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
  if (!screenPanel.hidden) refreshScreen()
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

async function restartSelectedSession() {
  if (!state.editingBot) return
  const id = state.editingBot.id
  restartSessionButton.disabled = true
  chatStatus.textContent = '再起動中'
  try {
    await api(`/api/bots/${id}/restart`, { method: 'POST' })
    botDialog.close()
    setTimeout(async () => {
      await loadBots()
      if (state.selectedType !== 'bot' || state.selected.id !== id) return
      const bot = state.bots.find(item => item.id === id)
      if (bot) await selectBot(bot)
    }, 1000)
  } catch {
    chatStatus.textContent = '再起動できませんでした'
  } finally {
    restartSessionButton.disabled = false
  }
}

async function deleteSelectedBot() {
  const bot = state.editingBot
  if (!bot || !window.confirm(`${bot.displayName}を削除しますか？`)) return
  deleteBotButton.disabled = true
  try {
    await api(`/api/bots/${bot.id}`, { method: 'DELETE' })
    botDialog.close()
    state.bots = state.bots.filter(item => item.id !== bot.id)
    clearSelection()
    renderBots()
    setTimeout(loadBots, 500)
  } catch {
    botFormError.textContent = '削除できませんでした。'
  } finally {
    deleteBotButton.disabled = false
  }
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

function renderBotConfigurationStatus(bot) {
  const application = bot?.configurationApplication
  botConfigurationStatus.textContent = !bot ? ''
    : application?.state === 'pending' ? '現在の作業が終わった後に設定を反映します。適用はまだ確認できていません。'
    : application?.state === 'failed' ? application.message
    : application?.state === 'accepted' ? 'CLIが設定変更を受け付けました。'
    : bot.online ? '保存した希望設定です。稼働中のCLIへの適用は未確認です。'
    : '次回の起動に使う希望設定です。'
}

async function openBotDialog(bot = null) {
  modelLoad?.abort()
  const controller = new AbortController()
  modelLoad = controller
  state.models = {}
  state.editingBot = bot
  renderBotConfigurationStatus(bot)
  botForm.reset()
  botFormError.textContent = ''
  botDialogTitle.textContent = bot ? 'Botを編集' : 'Botを追加'
  botHarness.disabled = true
  botModel.disabled = true
  botReasoningEffort.disabled = true
  saveBotButton.disabled = true
  botManagementActions.hidden = !bot
  characterSheetButton.hidden = !bot
  if (bot) {
    botName.value = bot.name
    botHarness.value = bot.harness
    botProfileText.value = bot.profileText ?? ''
    botPersonality.value = bot.personality ?? ''
    botSpeechStyle.value = bot.speechStyle ?? ''
    botPosition.value = bot.position ?? ''
    botRole.value = bot.role ?? ''
    botColor.value = bot.color ?? 'violet'
  }
  renderModelOptions(botHarness.value, bot?.model ?? '', bot?.reasoningEffort ?? '')
  botModelStatus.textContent = 'モデル一覧を読み込んでいます…'
  botAvatarEditor.reset(bot?.avatar)
  botDialog.showModal()
  try {
    const result = await api('/api/models', { signal: controller.signal })
    if (controller.signal.aborted) return
    state.models = result.models
    renderModelOptions(botHarness.value, bot?.model ?? '', bot?.reasoningEffort ?? '')
    if (bot) {
      try {
        const current = await api(`/api/bots/${bot.id}`, { signal: controller.signal })
        if (!controller.signal.aborted) renderBotConfigurationStatus({ ...bot, ...current.bot })
      } catch {
        if (!controller.signal.aborted) botConfigurationStatus.textContent = '現在の適用状態を取得できません。'
      }
    }
  } catch (error) {
    if (controller.signal.aborted) return
    botModelStatus.textContent = `モデル一覧を取得できません（${error.message}）`
  } finally {
    if (!controller.signal.aborted) {
      botHarness.disabled = false
      saveBotButton.disabled = false
    }
  }
}
botDialog.addEventListener('close', () => { if (!botDialog.open) modelLoad?.abort() })

const CUSTOM_MODEL = '__custom__'
function selectOptions(select, options) {
  select.replaceChildren(...options.map(([value, label]) => {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    return option
  }))
}
function renderModelOptions(harness, current, effort) {
  const entry = state.models[harness]
  botModel.disabled = !entry || Boolean(entry.error)
  botReasoningEffort.disabled = botModel.disabled
  botModelStatus.textContent = entry?.error?.message ?? ''
  const candidates = (state.models[harness]?.models ?? []).map(model => model.id)
  selectOptions(botModel, [['', 'CLIの既定'], ...candidates.map(model => [model, model]), [CUSTOM_MODEL, 'その他（手入力）']])
  const listed = current === '' || candidates.includes(current)
  botModel.value = listed ? current : CUSTOM_MODEL
  botModelCustom.value = listed ? '' : current
  botModelCustomField.hidden = botModel.value !== CUSTOM_MODEL
  renderEffortOptions(effort)
}
// 一覧のモデルはそのモデルが受け付けるエフォート、既定と手入力はCLI全体の範囲を出す。
// CursorはモデルIDとエフォートを連結して起動するので、モデル未指定ではエフォートを選べない。
function selectableEfforts() {
  const catalog = state.models[botHarness.value]
  if (!catalog) return []
  const listed = catalog.models.find(model => model.id === botModel.value)
  if (listed) return listed.efforts
  if (botHarness.value === 'cursor' && botModel.value === '') return []
  return catalog.efforts
}
function renderEffortOptions(current) {
  const efforts = selectableEfforts()
  const options = [['', 'CLIの既定'], ...efforts.map(effort => [effort, effort])]
  // 保存済みの値が候補から外れても黙って変えない。選び直すまで残す。
  if (current && !efforts.includes(current)) options.push([current, `${current}（このモデルでは未対応）`])
  selectOptions(botReasoningEffort, options)
  botReasoningEffort.value = current
}
function selectedModel() {
  return botModel.value === CUSTOM_MODEL ? botModelCustom.value.trim() : botModel.value
}
botHarness.addEventListener('change', () => renderModelOptions(botHarness.value, '', ''))
botModel.addEventListener('change', () => {
  botModelCustomField.hidden = botModel.value !== CUSTOM_MODEL
  // 選び直したモデルが今のエフォートを受け付けなければ、CLIの既定へ戻す。
  renderEffortOptions(selectableEfforts().includes(botReasoningEffort.value) ? botReasoningEffort.value : '')
})

async function saveBot(event) {
  event.preventDefault()
  if (!claimSingleFlight(state.inFlight, 'bot-save')) return
  botFormError.textContent = ''
  saveBotButton.disabled = true
  saveBotButton.textContent = state.editingBot ? '保存中…' : '作成中…'
  try {
    const profile = {
      name: botName.value.trim(),
      profileText: botProfileText.value,
      personality: botPersonality.value,
      speechStyle: botSpeechStyle.value,
      position: botPosition.value.trim(),
      role: botRole.value,
      ...(!state.editingBot || botAvatarEditor.changed() ? { avatar: botAvatarEditor.value() } : {}),
      color: botColor.value,
      harness: botHarness.value,
      model: selectedModel(),
      reasoningEffort: botReasoningEffort.value,
    }
    let result
    if (state.editingBot) {
      result = await api(`/api/bots/${state.editingBot.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(profile),
      })
    } else {
      result = await api('/api/bots', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(profile),
      })
    }
    botDialog.close()
    await loadBots()
    const saved = state.bots.find(bot => bot.id === result.bot.id)
    if (saved) await selectBot(saved)
  } catch (error) {
    botFormError.textContent = `保存できませんでした（${error.message}）`
  } finally {
    releaseSingleFlight(state.inFlight, 'bot-save')
    saveBotButton.disabled = false
    saveBotButton.textContent = '保存'
  }
}

function openMemoryDialog() {
  const bot = state.editingBot
  if (!bot) return
  botDialog.close()
  rememberForm.reset()
  recallForm.reset()
  knowledgeForm.reset()
  knowledgeSearchForm.reset()
  memoryResults.replaceChildren()
  knowledgeResults.replaceChildren()
  memoryFormError.textContent = ''
  memoryDialogTitle.textContent = `${bot.displayName}の記憶と知識`
  memoryDialog.showModal()
}

async function remember(event) {
  event.preventDefault()
  memoryFormError.textContent = ''
  try {
    await api(`/api/bots/${state.editingBot.id}/memory`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: document.querySelector('#remember-kind').value,
        scope: document.querySelector('#remember-scope').value,
        content: document.querySelector('#remember-content').value,
      }),
    })
    document.querySelector('#remember-content').value = ''
    memoryResults.textContent = '記憶しました。'
  } catch (error) {
    memoryFormError.textContent = `記憶できませんでした（${error.message}）`
  }
}

async function recallMemory(event) {
  event.preventDefault()
  memoryFormError.textContent = ''
  try {
    const query = document.querySelector('#recall-query').value
    const scope = document.querySelector('#recall-scope').value
    const result = await api(`/api/bots/${state.editingBot.id}/memory?query=${encodeURIComponent(query)}&scope=${scope}`)
    renderMemoryResults(memoryResults, result.items, item => `[${item.kind}] ${item.content}`)
  } catch (error) {
    memoryFormError.textContent = `検索できませんでした（${error.message}）`
  }
}

async function recordKnowledge(event) {
  event.preventDefault()
  memoryFormError.textContent = ''
  try {
    await api(`/api/bots/${state.editingBot.id}/knowledge`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: document.querySelector('#knowledge-scope').value,
        title: document.querySelector('#knowledge-title').value,
        content: document.querySelector('#knowledge-content').value,
      }),
    })
    knowledgeForm.reset()
    knowledgeResults.textContent = '知識を保存しました。'
  } catch (error) {
    memoryFormError.textContent = `保存できませんでした（${error.message}）`
  }
}

async function searchKnowledge(event) {
  event.preventDefault()
  memoryFormError.textContent = ''
  try {
    const query = document.querySelector('#knowledge-query').value
    const scope = document.querySelector('#knowledge-search-scope').value
    const result = await api(`/api/bots/${state.editingBot.id}/knowledge?query=${encodeURIComponent(query)}&scope=${scope}`)
    renderMemoryResults(knowledgeResults, result.items, item => `${item.title}\n${item.excerpt}`)
  } catch (error) {
    memoryFormError.textContent = `検索できませんでした（${error.message}）`
  }
}

function renderMemoryResults(container, items, format) {
  if (items.length === 0) {
    container.textContent = '見つかりませんでした。'
    return
  }
  container.replaceChildren(...items.map(item => {
    const row = document.createElement('article')
    row.textContent = format(item)
    return row
  }))
}

function openRoomDialog(room = null) {
  state.editingRoom = room
  roomForm.reset()
  roomFormError.textContent = ''
  roomDialogTitle.textContent = room ? 'ルームを編集' : 'ルームを作る'
  roomManagementActions.hidden = !room
  roomName.value = room?.name ?? ''
  roomPurpose.value = room?.purpose ?? ''
  roomAvatarEditor.reset(room?.avatar ?? '')
  roomMembers.replaceChildren(...state.bots.map(bot => {
    const label = document.createElement('label')
    label.innerHTML = `<input type="checkbox" value="${escapeHtml(bot.id)}" ${room?.memberIds.includes(bot.id) ? 'checked' : ''}><span>${escapeHtml(bot.displayName)}</span>`
    return label
  }))
  renderRoomRepresentativeOptions(room?.representativeId ?? '')
  roomDialog.showModal()
}

function renderRoomRepresentativeOptions(preferred = roomRepresentative.value) {
  const selectedIds = [...roomMembers.querySelectorAll('input:checked')].map(input => input.value)
  roomRepresentative.replaceChildren(new Option('代表なし', ''), ...selectedIds.map(id => {
    const bot = state.bots.find(item => item.id === id)
    return new Option(bot?.displayName ?? id, id)
  }))
  roomRepresentative.value = selectedIds.includes(preferred) ? preferred : ''
}

async function saveRoom(event) {
  event.preventDefault()
  roomFormError.textContent = ''
  const body = {
    name: roomName.value.trim(),
    purpose: roomPurpose.value,
    memberIds: [...roomMembers.querySelectorAll('input:checked')].map(input => input.value),
    representativeId: roomRepresentative.value || null,
    avatar: roomAvatarEditor.value(),
  }
  try {
    const result = state.editingRoom
      ? await api(`/api/rooms/${state.editingRoom.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      : await api('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    roomDialog.close()
    await loadBots()
    const saved = state.rooms.find(room => room.id === result.room.id)
    if (saved) await selectRoom(saved)
  } catch {
    roomFormError.textContent = '保存できませんでした。名前とメンバーを確認してね。'
  }
}

async function deleteSelectedRoom() {
  const room = state.editingRoom
  if (!room || !window.confirm(`${room.name}を削除しますか？\n会話履歴と予定も削除されます。`)) return
  deleteRoomButton.disabled = true
  try {
    await api(`/api/rooms/${room.id}`, { method: 'DELETE' })
    roomDialog.close()
    state.rooms = state.rooms.filter(item => item.id !== room.id)
    clearSelection()
    renderBots()
    await loadBots()
  } catch {
    roomFormError.textContent = '削除できませんでした。'
  } finally {
    deleteRoomButton.disabled = false
  }
}

function openScheduleDialog() {
  if (!state.selected) return
  return scheduleEditor.open({ ...state.selected, type: state.selectedType })
}

// アバター画像から代表色を導く。白・黒・透明に近い画素を除き、彩度の高い画素を重く見た平均色を、
// 枠線として見える明るさと彩度へ寄せる。Botごとに一度だけ計算する。
function avatarColor(bot) {
  if (!bot.avatar) return Promise.resolve('')
  if (!state.avatarColors.has(bot.id)) {
    state.avatarColors.set(bot.id, new Promise(resolve => {
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
  return state.avatarColors.get(bot.id)
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
  getBot: id => state.bots.find(bot => bot.id === id), avatarColor,
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
    if (payload.type === 'ai-control' && ownerDialog.open) void aiControl.refresh()
    if (payload.type === 'settings') {
      await loadFeatureSettings()
      if (ownerDialog.open) refreshFeatureSettingsStatus(document.querySelector('#feature-settings'), state.settings)
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
