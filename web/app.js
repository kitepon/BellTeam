import { openOnboarding, renderFeatureSettings, refreshFeatureSettingsStatus } from './onboarding.js?v=__ASSET_VERSION__'
import { renderSecretRequest } from './secret-input.js?v=__ASSET_VERSION__'
import { renderOwnerQuestion } from './owner-question.js?v=__ASSET_VERSION__'
import { sendFailureText, claimMessageSend, claimSingleFlight, readApiError, readApiResponse, releaseSingleFlight } from './chat-input.js?v=__ASSET_VERSION__'
import { richTextHtml } from './rich-text.js?v=__ASSET_VERSION__'
import { hasUnreadConversation, newestByRecent } from './activity-order.js?v=__ASSET_VERSION__'
import { openImageViewer, renderImageStack } from './image-gallery.js?v=__ASSET_VERSION__'

const READ_RECEIPTS_KEY = 'bellteam-read-receipts.v1'

const app = document.querySelector('#app')
const botList = document.querySelector('#bot-list')
const ownerProfileButton = document.querySelector('#owner-profile-button')
const ownerDialog = document.querySelector('#owner-dialog')
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
const scheduleList = document.querySelector('#schedule-list')
const scheduleForm = document.querySelector('#schedule-form')
const scheduleKind = document.querySelector('#schedule-kind')
const scheduleFields = document.querySelector('#schedule-fields')
const scheduleFormError = document.querySelector('#schedule-form-error')
const scheduleAction = document.querySelector('#schedule-action')
const scheduleActionField = document.querySelector('#schedule-action-field')
const schedulePromptField = document.querySelector('#schedule-prompt-field')
const scheduleCommandField = document.querySelector('#schedule-command-field')
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
const scheduleTargetsField = document.querySelector('#schedule-targets-field')
const scheduleTargets = document.querySelector('#schedule-targets')
const scheduleFormTitle = document.querySelector('#schedule-form-title')
const scheduleSubmit = document.querySelector('#schedule-submit')
const scheduleCancel = document.querySelector('#schedule-cancel')

const state = {
  setup: null,
  owner: null,
  settings: [],
  authMode: null,
  bots: [],
  rooms: [],
  models: {},
  editingSchedule: null,
  screenTimer: null,
  avatarColors: new Map(),
  timelineMap: new Map(),
  timelineQueue: [],
  timelineHasMore: false,
  timelineOldestId: null,
  timelineLoadingOlder: false,
  timelineToken: 0,
  stickToBottom: true,
  selected: null,
  selectedType: null,
  streamAbort: null,
  editingBot: null,
  editingRoom: null,
  pendingImages: [],
  // 会話の項目IDごとの画像URLの並び。
  imagePreviews: new Map(),
  imageFailures: new Set(),
  sending: new Set(),
  inFlight: new Set(),
  readReceipts: loadReadReceipts(),
}

const botAvatarEditor = createAvatarEditor({
  fileInput: botAvatarFile, preview: botAvatarPreview, cropEditor, canvas: avatarCrop, zoom: avatarZoom,
  nameInput: botName, colorInput: botColor, fallback: 'B', error: botFormError,
})
const ownerAvatarEditor = createAvatarEditor({
  fileInput: ownerAvatarFile, preview: ownerAvatarPreview, cropEditor: ownerCropEditor,
  canvas: ownerAvatarCrop, zoom: ownerAvatarZoom, nameInput: ownerName, fallback: 'O', error: ownerFormError,
})
const roomAvatarEditor = createAvatarEditor({
  fileInput: roomAvatarFile, preview: roomAvatarPreview, cropEditor: roomCropEditor,
  canvas: roomAvatarCrop, zoom: roomAvatarZoom, nameInput: roomName, fallback: 'R', error: roomFormError,
  previewClass: 'avatar room-avatar',
})
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
document.addEventListener('visibilitychange', () => { if (document.hidden) clearSettingSecrets() })
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
  } catch (error) { composerError.textContent = `書き出せませんでした（${error.message}）` }
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
scheduleKind.addEventListener('change', renderScheduleFields)
scheduleAction.addEventListener('change', renderScheduleAction)
scheduleForm.addEventListener('submit', saveSchedule)
scheduleCancel.addEventListener('click', resetScheduleForm)
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
  addPendingImages([...messageImage.files])
  messageImage.value = ''
})
messageInput.addEventListener('input', () => {
  messageInput.style.height = 'auto'
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 120)}px`
  updateSendButton()
})
messageInput.addEventListener('paste', event => {
  const images = [...event.clipboardData.files].filter(file => file.type.startsWith('image/'))
  if (!images.length) return
  event.preventDefault()
  addPendingImages(images)
})
composer.addEventListener('submit', sendMessage)
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
  const [botResult, roomResult, ownerResult] = await Promise.all([api('/api/bots'), api('/api/rooms'), api('/api/owner')])
  state.bots = botResult.bots
  state.rooms = roomResult.rooms
  state.owner = ownerResult.owner
  if (state.selected) {
    const source = state.selectedType === 'room' ? state.rooms : state.bots
    const current = source.find(item => item.id === state.selected.id)
    if (current) {
      state.selected = current
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
  closeScreen()
  screenButton.hidden = true
  state.selected = room
  state.selectedType = 'room'
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
}

async function openBotDialog(bot = null) {
  modelLoad?.abort()
  const controller = new AbortController()
  modelLoad = controller
  state.models = {}
  state.editingBot = bot
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
      avatar: botAvatarEditor.value(),
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

async function openScheduleDialog() {
  if (!state.selected) return
  resetScheduleForm()
  await loadSchedules()
  scheduleDialog.showModal()
}

function resetScheduleForm() {
  state.editingSchedule = null
  scheduleForm.reset()
  scheduleFormError.textContent = ''
  scheduleFormTitle.textContent = '予定を追加'
  scheduleSubmit.textContent = '予定を追加'
  scheduleCancel.hidden = true
  renderScheduleFields()
  renderScheduleAction()
  renderScheduleTargets()
}

// コマンド予定はBot専用。ルームではAIへの指示だけ。
function renderScheduleAction() {
  const command = state.selectedType !== 'room' && scheduleAction.value === 'command'
  scheduleActionField.hidden = state.selectedType === 'room'
  schedulePromptField.hidden = command
  scheduleCommandField.hidden = !command
  document.querySelector('#schedule-prompt').required = !command
  document.querySelector('#schedule-command').required = command
}

function editSchedule(schedule) {
  resetScheduleForm()
  state.editingSchedule = schedule
  scheduleFormTitle.textContent = '予定を編集'
  scheduleSubmit.textContent = '予定を更新'
  scheduleCancel.hidden = false
  document.querySelector('#schedule-name').value = schedule.name ?? ''
  document.querySelector('#schedule-prompt').value = schedule.prompt ?? ''
  document.querySelector('#schedule-command').value = schedule.command ?? ''
  scheduleAction.value = schedule.command ? 'command' : 'prompt'
  renderScheduleAction()
  const form = scheduleFormValues(schedule)
  scheduleKind.value = form.type
  renderScheduleFields()
  if (form.type === 'once') document.querySelector('#schedule-once').value = form.at
  if (form.type === 'hourly') document.querySelector('#schedule-minute').value = form.minute
  if (form.type === 'daily' || form.type === 'weekly') document.querySelector('#schedule-time').value = form.time
  if (form.type === 'interval_days') {
    document.querySelector('#schedule-interval-days').value = form.intervalDays
    document.querySelector('#schedule-start-date').value = form.startDate
    document.querySelector('#schedule-time').value = form.time
  }
  if (form.type === 'interval_hours') {
    document.querySelector('#schedule-interval-hours').value = form.intervalHours
    document.querySelector('#schedule-start-hour').value = form.startHour
    document.querySelector('#schedule-end-hour').value = form.endHour
    document.querySelector('#schedule-minute').value = form.minute
  }
  if (form.type === 'weekly') {
    for (const input of document.querySelectorAll('input[name="weekday"]')) input.checked = form.weekdays.includes(input.value)
  }
  if (form.type === 'cron') document.querySelector('#schedule-cron').value = schedule.expression
  if (state.selectedType === 'room' && Array.isArray(schedule.targets)) {
    for (const input of scheduleTargets.querySelectorAll('input')) input.checked = schedule.targets.includes(input.value)
  }
  scheduleForm.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// 保存済みの予定を入力欄の形へ戻す。cron式が毎時・毎日・曜日指定の形なら同じ選択肢で開き、それ以外はcron式のまま開く。
function scheduleFormValues(schedule) {
  if (schedule.kind === 'once') return { type: 'once', at: localDateTimeValue(schedule.at) }
  if (schedule.kind === 'interval_days' || schedule.kind === 'interval_hours') return { ...schedule, type: schedule.kind }
  const [minute, hour, dayOfMonth, month, weekday] = String(schedule.expression ?? '').trim().split(/\s+/)
  const pad = value => String(value).padStart(2, '0')
  const plainTime = /^\d+$/.test(minute) && /^\d+$/.test(hour)
  if (dayOfMonth === '*' && month === '*' && weekday === '*') {
    if (hour === '*' && /^\d+$/.test(minute)) return { type: 'hourly', minute }
    if (plainTime) return { type: 'daily', time: `${pad(hour)}:${pad(minute)}` }
  }
  if (dayOfMonth === '*' && month === '*' && plainTime && /^[0-6](,[0-6])*$/.test(weekday ?? '')) {
    return { type: 'weekly', time: `${pad(hour)}:${pad(minute)}`, weekdays: weekday.split(',') }
  }
  return { type: 'cron' }
}

function localDateTimeValue(iso) {
  const date = new Date(iso)
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

async function loadSchedules() {
  const result = await api(schedulePath())
  const schedules = result.schedules.filter(schedule =>
    !(schedule.kind === 'once' && schedule.lastRunAt && !schedule.enabled && !schedule.nextRunAt))
  if (schedules.length === 0) {
    scheduleList.innerHTML = '<p class="empty-schedules">予定はありません。</p>'
    return
  }
  scheduleList.replaceChildren(...schedules.map(schedule => {
    const row = document.createElement('div')
    row.className = 'schedule-row'
    const action = schedule.command ? `コマンド（AIを起こさない）: ${schedule.command}` : schedule.prompt
    row.innerHTML = `<div><strong>${escapeHtml(schedule.name || schedule.command || schedule.prompt)}</strong><span>${escapeHtml(scheduleDescription(schedule))}</span><span class="prompt">${escapeHtml(action)}</span><small>次回 ${escapeHtml(formatDateTime(schedule.nextRunAt))}</small></div><div class="schedule-actions"><button class="run" type="button" aria-label="今すぐ実行">今すぐ実行</button><button class="edit" type="button" aria-label="予定を編集">編集</button><button class="remove" type="button" aria-label="予定を削除">削除</button></div>`
    const runButton = row.querySelector('button.run')
    runButton.addEventListener('click', async () => {
      runButton.disabled = true
      try {
        await api(`${schedulePath()}/${encodeURIComponent(schedule.id)}/run`, { method: 'POST' })
        runButton.textContent = '送信した'
      } catch {
        runButton.textContent = '失敗'
      }
      setTimeout(() => { runButton.textContent = '今すぐ実行'; runButton.disabled = false }, 2500)
    })
    row.querySelector('button.edit').addEventListener('click', () => editSchedule(schedule))
    row.querySelector('button.remove').addEventListener('click', async () => {
      await api(`${schedulePath()}/${encodeURIComponent(schedule.id)}`, { method: 'DELETE' })
      if (state.editingSchedule?.id === schedule.id) resetScheduleForm()
      await loadSchedules()
    })
    return row
  }))
}

function renderScheduleTargets() {
  scheduleTargetsField.hidden = state.selectedType !== 'room'
  if (state.selectedType !== 'room') return scheduleTargets.replaceChildren()
  scheduleTargets.replaceChildren(...state.selected.memberIds.map(id => {
    const bot = state.bots.find(item => item.id === id)
    const label = document.createElement('label')
    label.innerHTML = `<input type="checkbox" value="${escapeHtml(id)}"><span>${escapeHtml(bot?.displayName ?? id)}</span>`
    return label
  }))
}

function schedulePath() {
  return state.selectedType === 'room'
    ? `/api/rooms/${state.selected.id}/schedules`
    : `/api/bots/${state.selected.id}/schedules`
}

function renderScheduleFields() {
  const type = scheduleKind.value
  if (type === 'once') scheduleFields.innerHTML = '<label class="field"><span>実行日時</span><input id="schedule-once" type="datetime-local" required></label>'
  if (type === 'hourly') scheduleFields.innerHTML = '<label class="field"><span>毎時の何分</span><input id="schedule-minute" type="number" min="0" max="59" value="0" required></label>'
  if (type === 'daily') scheduleFields.innerHTML = '<label class="field"><span>時刻</span><input id="schedule-time" type="time" value="09:00" required></label>'
  if (type === 'interval_days') scheduleFields.innerHTML = `<label class="field"><span>何日おき</span><input id="schedule-interval-days" type="number" min="1" step="1" value="2" required></label><label class="field"><span>開始日</span><input id="schedule-start-date" type="date" value="${localDateTimeValue(new Date()).slice(0, 10)}" required></label><label class="field"><span>時刻</span><input id="schedule-time" type="time" value="09:00" required></label><small>開始日から数えます。2日おきなら、開始日・2日後・4日後に実行します。</small>`
  if (type === 'interval_hours') scheduleFields.innerHTML = '<label class="field"><span>何時間おき</span><input id="schedule-interval-hours" type="number" min="1" max="24" step="1" value="3" required></label><div class="field-row"><label class="field"><span>開始（時）</span><input id="schedule-start-hour" type="number" min="0" max="23" step="1" value="9" required></label><label class="field"><span>終了（時）</span><input id="schedule-end-hour" type="number" min="0" max="23" step="1" value="18" required></label></div><label class="field"><span>実行する分</span><input id="schedule-minute" type="number" min="0" max="59" step="1" value="0" required></label><small>9時〜18時・3時間おきなら9・12・15・18時に実行します。終了が開始より早ければ翌日まで、同じならその時刻に一回実行します。</small>'
  if (type === 'weekly') scheduleFields.innerHTML = '<label class="field"><span>曜日</span><span class="weekday-picker">日 月 火 水 木 金 土</span><span class="weekday-checks">' + ['日','月','火','水','木','金','土'].map((day, index) => `<label><input type="checkbox" name="weekday" value="${index}" ${index === 1 ? 'checked' : ''}><b>${day}</b></label>`).join('') + '</span></label><label class="field"><span>時刻</span><input id="schedule-time" type="time" value="09:00" required></label>'
  if (type === 'cron') scheduleFields.innerHTML = '<label class="field"><span>cron式</span><input id="schedule-cron" value="0 9 * * 1-5" required placeholder="0 9 * * 1-5"></label>'
}

async function saveSchedule(event) {
  event.preventDefault()
  scheduleFormError.textContent = ''
  try {
    const body = scheduleRequest()
    const editing = state.editingSchedule
    await api(editing ? `${schedulePath()}/${encodeURIComponent(editing.id)}` : schedulePath(), {
      method: editing ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    resetScheduleForm()
    await loadSchedules()
  } catch {
    scheduleFormError.textContent = '予定を保存できませんでした。日時と実行内容を確認してね。'
  }
}

function scheduleRequest() {
  const type = scheduleKind.value
  const command = state.selectedType !== 'room' && scheduleAction.value === 'command'
  const base = {
    name: document.querySelector('#schedule-name').value.trim(),
    ...(command
      ? { command: document.querySelector('#schedule-command').value.trim() }
      : { prompt: document.querySelector('#schedule-prompt').value.trim() }),
    enabled: true,
  }
  if (state.selectedType === 'room') {
    const targets = [...scheduleTargets.querySelectorAll('input:checked')].map(input => input.value)
    base.targets = targets.length ? targets : null
  }
  if (type === 'once') return { ...base, kind: 'once', at: new Date(document.querySelector('#schedule-once').value).toISOString() }
  const timezone = state.editingSchedule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'Asia/Tokyo'
  if (type === 'interval_days') return {
    ...base, kind: type, timezone,
    intervalDays: Number(document.querySelector('#schedule-interval-days').value),
    startDate: document.querySelector('#schedule-start-date').value,
    time: document.querySelector('#schedule-time').value,
  }
  if (type === 'interval_hours') return {
    ...base, kind: type, timezone,
    intervalHours: Number(document.querySelector('#schedule-interval-hours').value),
    startHour: Number(document.querySelector('#schedule-start-hour').value),
    endHour: Number(document.querySelector('#schedule-end-hour').value),
    minute: Number(document.querySelector('#schedule-minute').value),
  }
  const [hour, minute] = (document.querySelector('#schedule-time')?.value ?? '0:0').split(':').map(Number)
  let expression
  if (type === 'hourly') expression = `${Number(document.querySelector('#schedule-minute').value)} * * * *`
  if (type === 'daily') expression = `${minute} ${hour} * * *`
  if (type === 'weekly') {
    const weekdays = [...document.querySelectorAll('input[name="weekday"]:checked')].map(input => input.value)
    if (weekdays.length === 0) throw new Error('WEEKDAY_REQUIRED')
    expression = `${minute} ${hour} * * ${weekdays.join(',')}`
  }
  if (type === 'cron') expression = document.querySelector('#schedule-cron').value.trim()
  return { ...base, kind: 'cron', expression, timezone }
}

function scheduleDescription(schedule) {
  if (schedule.kind === 'once') return formatDateTime(schedule.at)
  if (schedule.kind === 'interval_days') return `${schedule.intervalDays}日おき · ${schedule.startDate}から ${schedule.time} · ${schedule.timezone}`
  if (schedule.kind === 'interval_hours') return `${schedule.intervalHours}時間おき · ${schedule.startHour}時〜${schedule.endHour < schedule.startHour ? '翌' : ''}${schedule.endHour}時（${schedule.minute}分） · ${schedule.timezone}`
  return `${schedule.expression} · ${schedule.timezone}`
}

function createAvatarEditor({ fileInput, preview, cropEditor, canvas, zoom, nameInput, colorInput = null, fallback, error, previewClass = 'avatar owner-avatar' }) {
  const context = canvas.getContext('2d')
  let avatarData = ''
  let crop = null
  let drag = null

  fileInput.addEventListener('change', readFile)
  zoom.addEventListener('input', zoomImage)
  zoom.addEventListener('change', syncPreview)
  canvas.addEventListener('pointerdown', startDrag)
  canvas.addEventListener('pointermove', moveImage)
  canvas.addEventListener('pointerup', endDrag)
  canvas.addEventListener('pointercancel', endDrag)
  nameInput.addEventListener('input', updatePreview)
  colorInput?.addEventListener('change', updatePreview)

  return {
    reset(value = '') {
      avatarData = value?.startsWith('data:image/') ? value : ''
      crop = null
      drag = null
      fileInput.value = ''
      cropEditor.hidden = true
      updatePreview()
    },
    value() { return avatarData },
  }

  async function readFile() {
    const [file] = fileInput.files
    if (!file) return
    const source = URL.createObjectURL(file)
    const image = new Image()
    image.src = source
    try {
      await image.decode()
      const scale = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight)
      crop = {
        image,
        minimumScale: scale,
        scale,
        x: (canvas.width - image.naturalWidth * scale) / 2,
        y: (canvas.height - image.naturalHeight * scale) / 2,
      }
      zoom.value = '1'
      cropEditor.hidden = false
      draw()
      syncPreview()
    } catch {
      error.textContent = 'この画像は読み込めませんでした。'
    } finally {
      URL.revokeObjectURL(source)
    }
  }

  function updatePreview() {
    preview.className = colorInput ? `avatar ${escapeClass(colorInput.value)}` : previewClass
    preview.textContent = initials(nameInput.value || fallback)
    applyAvatar(preview, { avatar: avatarData })
  }

  function zoomImage() {
    if (!crop) return
    const nextScale = crop.minimumScale * Number(zoom.value)
    const ratio = nextScale / crop.scale
    crop.x = canvas.width / 2 - (canvas.width / 2 - crop.x) * ratio
    crop.y = canvas.height / 2 - (canvas.height / 2 - crop.y) * ratio
    crop.scale = nextScale
    clamp()
    draw()
  }

  function startDrag(event) {
    if (!crop) return
    canvas.setPointerCapture(event.pointerId)
    drag = { x: event.clientX, y: event.clientY }
  }

  function moveImage(event) {
    if (!crop || !drag) return
    const ratio = canvas.width / canvas.getBoundingClientRect().width
    crop.x += (event.clientX - drag.x) * ratio
    crop.y += (event.clientY - drag.y) * ratio
    drag = { x: event.clientX, y: event.clientY }
    clamp()
    draw()
  }

  function endDrag() {
    if (!drag) return
    drag = null
    syncPreview()
  }

  function clamp() {
    crop.x = Math.min(0, Math.max(canvas.width - crop.image.naturalWidth * crop.scale, crop.x))
    crop.y = Math.min(0, Math.max(canvas.height - crop.image.naturalHeight * crop.scale, crop.y))
  }

  function draw() {
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.drawImage(crop.image, crop.x, crop.y, crop.image.naturalWidth * crop.scale, crop.image.naturalHeight * crop.scale)
  }

  function syncPreview() {
    if (!crop) return avatarData
    draw()
    avatarData = canvas.toDataURL('image/jpeg', .9)
    updatePreview()
    return avatarData
  }
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

function applyAvatar(element, bot) {
  element.style.backgroundImage = bot.avatar ? `url(${JSON.stringify(bot.avatar)})` : ''
  element.classList.toggle('has-image', Boolean(bot.avatar))
}

const TIMELINE_FIRST_PAGE = 10
const TIMELINE_MORE_PAGE = 20
const timelineItems = document.createElement('div')
timelineItems.className = 'timeline-items'
const timelineTail = document.createElement('div')
timelineTail.className = 'timeline-tail'
timeline.replaceChildren(timelineItems, timelineTail)

function messagesPath() {
  return state.selectedType === 'room' ? `/api/rooms/${state.selected.id}/messages` : `/api/bots/${state.selected.id}/messages`
}
function queuePath() {
  return state.selectedType === 'room' ? `/api/rooms/${state.selected.id}/queue` : `/api/bots/${state.selected.id}/queue`
}
function normalizeItems(items) {
  return state.selectedType === 'room' ? items.map(roomTimelineItem) : items
}
function queuedFor(item) {
  return state.timelineQueue.filter(entry => entry.groupId === item.id)
}
function scrollToBottom() {
  timeline.scrollTo({ top: timeline.scrollHeight, behavior: 'instant' })
}
function rememberItems(items) {
  for (const item of items) state.timelineMap.set(item.id, item)
}

// 開幕は最新10件だけを即描画し、画像は後から差し替える。以後は末尾に貼り付く。
async function loadMessages(preserveScroll = true) {
  if (!state.selected) return
  if (!preserveScroll) return openTimeline()
  return refreshTimeline()
}

async function openTimeline() {
  const token = ++state.timelineToken
  state.timelineMap = new Map()
  state.timelineHasMore = false
  state.timelineOldestId = null
  state.timelineLoadingOlder = false
  state.stickToBottom = true
  const [result, queueResult] = await Promise.all([api(`${messagesPath()}?limit=${TIMELINE_FIRST_PAGE}`), api(queuePath())])
  if (token !== state.timelineToken) return
  state.timelineQueue = queueResult.items
  const items = normalizeItems(result.items)
  rememberItems(items)
  state.timelineHasMore = result.has_more
  state.timelineOldestId = items[0]?.id ?? null
  timelineItems.replaceChildren(dayLabel(), ...items.map(item => renderItem(item, queuedFor(item))))
  renderTail(items)
  scrollToBottom()
  loadStoredMessageImages(items, item => rerenderItem(item.id, token))
}

async function refreshTimeline() {
  const token = state.timelineToken
  const ids = [...state.timelineMap.keys()]
  const lastId = ids.at(-1) ?? null
  const [latest, after, queueResult] = await Promise.all([
    api(`${messagesPath()}?limit=${TIMELINE_FIRST_PAGE}`),
    lastId ? api(`${messagesPath()}?after=${encodeURIComponent(lastId)}`) : Promise.resolve({ items: [] }),
    api(queuePath()),
  ])
  if (token !== state.timelineToken) return
  state.timelineQueue = queueResult.items
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
    state.timelineLoadingOlder = false
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
  if (state.selectedType === 'bot' && state.timelineQueue.some(entry => entry.status === 'running')) tail.push(renderThinking(state.selected.id))
  timelineTail.replaceChildren(...tail)
}

timeline.addEventListener('scroll', () => {
  state.stickToBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 40
  if (timeline.scrollTop < 240) loadOlderMessages()
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
      api, sender: state.bots.find(bot => bot.id === request.botId)?.name ?? request.botId,
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
      api, sender: state.bots.find(bot => bot.id === question.botId)?.name ?? question.botId,
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
  const senderBot = item.direction === 'incoming' && state.selectedType === 'room' && item.senderId
    ? state.bots.find(bot => bot.id === item.senderId) : null
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
    const previews = state.imagePreviews.get(item.id)
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
      label.textContent = state.imageFailures.has(item.id) ? '画像を読み込めませんでした' : imageLabel(item)
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
        : 'delivered'
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
    ['queued', '送信待ち'], ['running', '処理中'], ['delivered', '配達済み'], ['failed', '配達失敗'],
  ]).get(delivery) ?? ''
}

// 画像は描画を止めずに後から取り、取れた項目だけ差し替える。
async function loadStoredMessageImages(items, onLoaded = () => {}) {
  const missing = items.filter(item => item.image_url && !state.imagePreviews.has(item.id) && !state.imageFailures.has(item.id))
  await Promise.all(missing.map(async item => {
    try {
      const urls = item.image_urls?.length ? item.image_urls : [item.image_url]
      const previews = await Promise.all(urls.map(async url => {
        const response = await fetch(url)
        if (!response.ok) { const error = new Error(`HTTP_${response.status}`); error.status = response.status; throw error }
        const blob = await response.blob()
        if (!blob.type.startsWith('image/')) throw new Error('IMAGE_RESPONSE_INVALID')
        return URL.createObjectURL(blob)
      }))
      state.imagePreviews.set(item.id, previews)
    } catch {
      state.imageFailures.add(item.id)
    }
    onLoaded(item)
  }))
}

function renderThinking(botId) {
  const wrapper = document.createElement('div')
  wrapper.className = 'message incoming thinking-message'
  wrapper.dataset.botId = botId
  wrapper.setAttribute('role', 'status')
  wrapper.setAttribute('aria-label', `${state.selected?.displayName ?? 'Bot'}が回答を作成中`)
  const bubble = document.createElement('div')
  bubble.className = 'message-bubble thinking-bubble'
  bubble.innerHTML = '<i></i><i></i><i></i>'
  wrapper.append(bubble)
  return wrapper
}

async function sendMessage(event) {
  event.preventDefault()
  if (!state.selected) return
  if (state.selectedType === 'room' && !routingEnabled() && !selectedTargets(state.selected.id)) {
    composerError.textContent = '返信者の自動選択は未設定です。返信するメンバーを選んでください。'
    composerError.hidden = false
    toggleTargetMenu(true)
    targetButton.focus()
    return
  }
  const targetType = state.selectedType
  const targetId = state.selected.id
  const sendKey = `${targetType}:${targetId}`
  const draft = claimMessageSend(state, sendKey, messageInput.value, state.pendingImages)
  if (!draft) return
  const { message, pendingImages } = draft
  const files = pendingImages.map(item => item.file)
  messageInput.value = ''
  messageInput.style.height = 'auto'
  clearPendingImages()
  try {
    const images = await Promise.all(files.map(readImage))
    const path = targetType === 'room'
      ? `/api/rooms/${targetId}/messages`
      : `/api/bots/${targetId}/messages`
    const targets = targetType === 'room' ? selectedTargets(targetId) : null
    const result = await api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, images, ...(targets ? { targets } : {}) }),
    })
    if (images.length) state.imagePreviews.set(result.delivery_id ?? result.id, images.map(image => `data:${image.mime};base64,${image.data}`))
    composerError.hidden = true
    await loadBots()
    if (state.selectedType === targetType && state.selected?.id === targetId) await loadMessages(false)
  } catch (error) {
    // 拒否を黙って飲まない。本文と画像を入力欄へ戻し、理由を一行で出す（実被弾 2026-09-04: 秘書室で発言が消えた）。
    messageInput.value = message
    addPendingImages(files)
    composerError.textContent = sendFailureText(error.message)
    composerError.hidden = false
  } finally {
    state.sending.delete(sendKey)
    updateSendButton()
  }
}

function addPendingImages(files) {
  const images = files.filter(file => ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type))
  state.pendingImages.push(...images.map(file => ({ file, url: URL.createObjectURL(file) })))
  renderPendingImages()
}

function removePendingImage(target) {
  URL.revokeObjectURL(target.url)
  state.pendingImages = state.pendingImages.filter(item => item !== target)
  renderPendingImages()
}

function clearPendingImages() {
  for (const item of state.pendingImages) URL.revokeObjectURL(item.url)
  state.pendingImages = []
  renderPendingImages()
}

function renderPendingImages() {
  attachmentPreview.replaceChildren(...state.pendingImages.map((item, index) => {
    const preview = document.createElement('div')
    preview.className = 'attachment-preview'
    const image = document.createElement('img')
    image.src = item.url
    image.alt = `添付画像${index + 1}`
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.textContent = '×'
    remove.setAttribute('aria-label', `添付画像${index + 1}を外す`)
    remove.addEventListener('click', () => removePendingImage(item))
    preview.append(image, remove)
    return preview
  }))
  attachmentPreview.hidden = state.pendingImages.length === 0
  updateSendButton()
}

function imageLabel(item) {
  return item.image_count > 1 ? `画像${item.image_count}枚` : '画像'
}

function updateSendButton() {
  const key = state.selected ? `${state.selectedType}:${state.selected.id}` : ''
  sendButton.disabled = state.sending.has(key) || (messageInput.value.trim().length === 0 && !state.pendingImages.length)
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
        if (payload.type === 'settings') {
          await loadFeatureSettings()
          if (ownerDialog.open) refreshFeatureSettingsStatus(document.querySelector('#feature-settings'), state.settings)
        }
        if (payload.type === 'setup') state.setup = await api('/api/setup')
        await Promise.all([loadBots(), loadMessages()])
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') return
    if (error instanceof TypeError || error.status === 429 || error.status >= 500) { setTimeout(connectEvents, 1500); return }
    composerError.textContent = `更新の接続が止まりました: ${error.message}。ページを再読み込みして確認してください。`
    composerError.hidden = false
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, options)
  if (!response.ok) { const error = new Error(await readApiError(response)); error.status = response.status; throw error }
  return readApiResponse(response)
}

function dayLabel() {
  const label = document.createElement('div')
  label.className = 'day-label'
  label.textContent = 'BellTeamでの会話'
  return label
}

function initials(name) {
  return escapeHtml(name.slice(0, 1).toUpperCase())
}
function memberDisplay(member) {
  if (!member) return ''
  return member.position ? `${member.name} ${member.position}` : member.name
}
function formatTime(value) {
  if (!value) return ''
  return new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}
function formatDateTime(value) {
  if (!value) return ''
  return new Intl.DateTimeFormat('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
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
function escapeClass(value) { return ['rose', 'indigo', 'violet'].includes(value) ? value : 'violet' }
function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character])
}
