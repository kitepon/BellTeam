import { createNotificationNavigation } from './notification-navigation.js?v=__ASSET_VERSION__'
import { renderCurrentWork } from './current-work.js?v=__ASSET_VERSION__'
import { memberRow, memberState, roomRow, rowTime } from './roster-view.js?v=__ASSET_VERSION__'
import { animateConversation } from './view-preferences.js?v=__ASSET_VERSION__'
import { createSchedulesOverview } from './schedules-overview.js?v=__ASSET_VERSION__'
import { matchesMemberQuery, matchesRoomQuery, matchesRosterQuery } from './roster-search.js?v=__ASSET_VERSION__'
import { requestEditorClose } from './editor-close.js?v=__ASSET_VERSION__'
import { createOwnerEditor } from './owner-editor.js?v=__ASSET_VERSION__'
import { createBotEditor } from './bot-editor.js?v=__ASSET_VERSION__'
import { createRoomEditor } from './room-editor.js?v=__ASSET_VERSION__'
import { createMemoryView } from './memory-view.js?v=__ASSET_VERSION__'
import { createScreenView, createCharacterSheetView } from './bot-read-views.js?v=__ASSET_VERSION__'
import { createScheduleEditor } from './schedule-editor.js?v=__ASSET_VERSION__'
import { createWorkGraphView } from './work-graph.js?v=__ASSET_VERSION__'
import { createLatticeChart } from './lattice-chart.js?v=__ASSET_VERSION__'
import { bannerTexts } from './harness-accounts.js?v=__ASSET_VERSION__'
import { createConversationTimeline } from './conversation-timeline.js?v=__ASSET_VERSION__'
import { applyAvatar, initials, escapeClass, escapeHtml } from './view-format.js?v=__ASSET_VERSION__'
import { openOnboarding } from './onboarding.js?v=__ASSET_VERSION__'
import { claimSingleFlight, releaseSingleFlight } from './chat-input.js?v=__ASSET_VERSION__'
import { createMessageImageCache } from './message-images.js?v=__ASSET_VERSION__'
import { createConversationComposer } from './conversation-composer.js?v=__ASSET_VERSION__'
import { hasUnreadConversation, newestByRecent } from './activity-order.js?v=__ASSET_VERSION__'
import { requestMemberStop } from './member-stop.js?v=__ASSET_VERSION__'
import { createWebClient } from './client.js?v=__ASSET_VERSION__'
import { goalsView } from './goals.js?v=__ASSET_VERSION__'
import { createTerminalsView, seatLaunchText } from './terminals.js?v=__ASSET_VERSION__'
import { createUpdateCenter } from './update-center.js?v=__ASSET_VERSION__'

export function createWebApp({ client = createWebClient() } = {}) {
  const { api, fetchImage, watchEvents } = client
  const READ_RECEIPTS_KEY = 'bellteam-read-receipts.v1'

  const app = document.querySelector('#app')
  let updatesChanged = () => {}
  const updateCenter = createUpdateCenter({ root: document.querySelector('#update-center'), api,
    buttons: [document.querySelector('#update-open')], onSummary: () => updatesChanged() })
  const goals = goalsView(document.querySelector('#goals-dialog'), api, () => state.bots, document.querySelector('#chat-goal'))
  document.querySelector('#goals-button').addEventListener('click', () => { void goals.open() })
  const terminals = createTerminalsView(document.querySelector('#terminals-dialog'), { api })
  document.querySelector('#terminals-open').addEventListener('click', () => { void terminals.open() })
  const botList = document.querySelector('#bot-list')
  const rosterNotice = document.querySelector('#roster-notice')
  const rosterError = document.querySelector('#roster-error')
  const rosterRetry = document.querySelector('#roster-retry')
  rosterRetry.addEventListener('click', () => loadBots().catch(() => {}))
  let rosterLoaded = false
  const setupNotice = document.querySelector('#setup-notice')
  document.querySelector('#setup-resume').addEventListener('click', () => void resumeSetup())
  let conversationsStarted = false
  const rosterSearch = document.querySelector('#roster-search')
  rosterSearch.addEventListener('input', renderBots)
  const ownerProfileButton = document.querySelector('#owner-profile-button')
  const ownerDialog = document.querySelector('#owner-dialog')
  const chat = document.querySelector('#chat')
  const timeline = document.querySelector('#timeline')
  const latestButton = document.querySelector('#scroll-to-latest')
  const chatName = document.querySelector('#chat-name')
  const chatStatus = document.querySelector('#chat-status')
  const chatSeatLaunch = document.querySelector('#chat-seat-launch')
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

  let catalogueRead = 0, ownerReads = 0, ownerApplied = 0
  const state = {
    setup: null,
    owner: null,
    settings: [],
    authMode: null,
    bots: [],
    rooms: [],
    selected: null,
    selectedType: null,
    stopEvents: null,
    readReceipts: loadReadReceipts(),
  }

  const messageImages = createMessageImageCache(fetchImage)
  window.addEventListener('pagehide', event => {
    if (!event.persisted) { state.stopEvents?.(); messageImages.close(); updateCenter.close(); notifications.close() }
  })

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
  const characterSheets = createCharacterSheetView(characterSheetDialog, characterSheetList, { api, fetchImage })
  const screenView = createScreenView({ panel: screenPanel, status: screenStatus, text: screenText, input: document.querySelector('#screen-input'), header: document.querySelector('.chat-header'), api })

  const scheduleEditor = createScheduleEditor(scheduleDialog, { api, getBot: id => state.bots.find(bot => bot.id === id) })

  const allSchedules = createSchedulesOverview(document.querySelector('#all-schedules-dialog'), { api,
    getTargets: () => [...state.bots.filter(bot => !bot.deleting).map(bot => ({ ...bot, type:'bot' })), ...state.rooms.map(room => ({ ...room,type:'room' }))],
    onManage: target => scheduleEditor.open(target),
  })
  document.querySelector('#all-schedules-button').addEventListener('click', () => { void allSchedules.open() })
  const workGraphDialog = document.querySelector('#work-graph-dialog')
  const workGraph = createWorkGraphView(workGraphDialog, { fetch: fetchImage, onOpenMember: async botId => {
    // 相関図の顔タップは、通知と同じ経路でその子の会話を開く。全画面なら先に抜け、相関図を閉じてから。
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {})
    workGraphDialog.close()
    await notifications.open({ kind: 'member', messageId: null, requestId: null, botId, roomId: null })
  } })
  document.querySelector('#work-graph-button').addEventListener('click', () => workGraph.open())
  workGraphDialog.addEventListener('close', () => workGraph.close())
  // Lattice工程表：会話を開くは相関図と同じ経路（通知の member route）。
  const latticeDialog = document.querySelector('#lattice-dialog')
  const lattice = createLatticeChart(latticeDialog, { api, fetchImage,
    getMember: id => { const bot = state.bots.find(item => item.id === id); return bot ? { botId: id, name: bot.displayName ?? bot.name, color: bot.color, avatar: bot.avatar, known: true } : null },
    getOwner: () => state.owner,
    openChat: async botId => {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {})
      latticeDialog.close()
      await notifications.open({ kind: 'member', messageId: null, requestId: null, botId, roomId: null })
    } })
  document.querySelector('#lattice-button').addEventListener('click', () => lattice.open())
  latticeDialog.addEventListener('close', () => lattice.close())

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
    onDeleted: async (bot, verify = false) => {
      catalogueRead++
      state.pendingDeletionIds ??= new Set()
      if (!verify) state.pendingDeletionIds.add(bot.id)
      state.bots = state.bots.map(item => item.id === bot.id && state.pendingDeletionIds.has(bot.id) ? { ...item, deletionRequested:true } : item)
      if (state.selectedType === 'bot' && state.selected?.id === bot.id) state.selected = state.bots.find(item => item.id === bot.id) ?? state.selected
      renderBots()
      updateSendButton()
      if (verify) {
        if (await loadBots() !== true) throw Error('DELETION_READ_SUPERSEDED')
        return state.bots.some(item => item.id === bot.id)
      }
      setTimeout(() => { void loadBots().catch(() => conversationComposer.showError('削除結果の一覧を取得できませんでした。開き直して確認してください。')) }, 500)
      return true
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
    onOpenUpdates: button => updateCenter.open(button), updateSummary: () => updateCenter.summary(),
    onOwner: owner => { catalogueRead++; applyOwner(owner, ++ownerReads) },
    onSettings: (settings, authMode) => {
      state.settings = settings
      state.authMode = authMode
      if (state.selectedType === 'room') renderTargetPicker(state.selected)
    },
  })
  updatesChanged = () => ownerEditor.refreshUpdates()

  const notificationNotice = document.querySelector('#notification-route-notice')
  const notifications = createNotificationNavigation({
    onRoot: () => app.classList.remove('chat-open'),
    onNotice: message => { notificationNotice.hidden = !message; notificationNotice.querySelector('[data-notification-notice]').textContent = message },
    onRoute: async route => {
      if (document.querySelector('dialog[open]')) throw Error('EDITOR_OPEN')
      if (route.kind === 'update') { await updateCenter.open(); return }
      const type = route.roomId ? 'room' : 'bot', id = route.roomId ?? route.botId
      const response = await api(`/api/${type === 'room' ? 'rooms' : 'bots'}/${encodeURIComponent(id)}`)
      const observed = response[type]
      if (!observed || observed.id !== id) throw Error('TARGET_UNAVAILABLE')
      const listed = (type === 'room' ? state.rooms : state.bots).find(item => item.id === id)
      const selected = { ...listed, ...observed }
      if (!listed) { if (type === 'room') state.rooms.push(selected); else state.bots.push(selected); renderBots() }
      if (state.selectedType !== type || state.selected?.id !== id) await (type === 'room' ? selectRoom(selected) : selectBot(selected))
      else app.classList.add('chat-open')
      if (state.selectedType !== type || state.selected?.id !== id) throw Error('SELECTION_CHANGED')
      if (route.requestId) await conversationTimeline.revealRequest(route.requestId, route.kind)
    },
  })
  document.querySelector('#notification-route-retry').addEventListener('click', () => { void notifications.retry() })
  document.querySelector('#notification-route-dismiss').addEventListener('click', () => { notificationNotice.hidden = true })

  targetButton.addEventListener('click', () => toggleTargetMenu())
  document.addEventListener('click', event => {
    if (!targetMenu.hidden && !targetPicker.contains(event.target)) toggleTargetMenu(false)
  })

  // Leaving the conversation on a phone also stops the 1 s screen reads (W28).
  document.querySelector('#back-button').addEventListener('click', () => { closeScreen(); app.classList.remove('chat-open') })
  ownerProfileButton.addEventListener('click', openOwnerDialog)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void updateCenter.refresh()
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
  // 「…」 menu (W24): closes after a choice, on an outside click and on Esc.
  const chatMore = document.querySelector('#chat-more')
  chatMore.addEventListener('click', event => { if (event.target.closest('.chat-more-menu button')) chatMore.open = false })
  document.addEventListener('click', event => { if (chatMore.open && !chatMore.contains(event.target)) chatMore.open = false })
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && chatMore.open) chatMore.open = false })
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

  document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => requestEditorClose(document.querySelector(`#${button.dataset.closeDialog}`))))
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
  document.querySelector('#composer-error-close').addEventListener('click', () => conversationComposer.showError(''))
  stopButton.addEventListener('click', () => { if (state.selectedType === 'bot' && state.selected) void stopMember(state.selected.id) })

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
        login.href = location.href
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
      showOnboarding(setup)
      return
    }
    await startConversations(setup)
  }

  // 初回設定は守るものが無いので閉じられる。閉じたら一覧/Updateへ進み、案内から再開できる。
  function showOnboarding(setup) {
    setupNotice.hidden = true
    openOnboarding(setup, { api, onReady: startConversations,
      onLater: next => startConversations(next).catch(error => conversationComposer.showError(error.message)) })
  }

  async function resumeSetup() {
    const setup = await api('/api/setup').catch(error => { conversationComposer.showError(error.message); return null })
    if (!setup) return
    if (setup.phase === 'ready') await startConversations(setup)
    else showOnboarding(setup)
  }

  async function startConversations(setup) {
    state.setup = setup
    setupNotice.hidden = setup.phase === 'ready'
    const first = !conversationsStarted
    conversationsStarted = true
    if (first) void updateCenter.start()
    const loaded = await loadBots().catch(error => { if (error.status !== 503) throw error; return false })
    if (loaded && setup.phase === 'ready' && !setup.complete && setup.guideBotId) {
      const guide = state.bots.find(bot => bot.id === setup.guideBotId)
      if (!guide) throw new Error('案内役が見つかりません。')
      await selectBot(guide)
    }
    if (!first) return
    void connectEvents()
    await notifications.ready()
  }

  async function loadFeatureSettings() {
    state.settings = (await api('/api/settings')).settings
    if (state.selectedType === 'room') renderTargetPicker(state.selected)
    void loadAccountsBanner()
  }

  // Claudeの1st/2ndが両方とも上限中の時だけ、一覧の上に知らせる。旧本体（/api/accountsなし）や読めない時は出さない。
  async function loadAccountsBanner() {
    const banner = document.querySelector('#accounts-banner')
    if (!banner) return
    const texts = bannerTexts(await api('/api/accounts').catch(() => null))
    banner.hidden = !texts.length
    banner.textContent = texts.join(' / ')
  }

  // The owner value from the read that STARTED last wins, whatever order the reads finish in (list read, Settings read, saved profile).
  function applyOwner(owner, started) { if (started > ownerApplied) { ownerApplied = started; state.owner = owner } }

  async function loadBots() {
    const read = ++catalogueRead, ownerStarted = ++ownerReads
    rosterRetry.disabled = true
    rosterRetry.textContent = '読み込んでいます…'
    let botResult, roomResult, ownerResult
    try {
      [botResult, roomResult, ownerResult] = await Promise.all([api('/api/bots?avatar=omit'), api('/api/rooms'), api('/api/owner')])
    } catch (error) {
      if (read !== catalogueRead) return null
      rosterRetry.disabled = false
      rosterRetry.textContent = '再読み込み'
      // Old rows stay under a thin line (RStale); with nothing read yet the list itself is the error card (RError).
      if (rosterLoaded) { rosterError.textContent = '最新の一覧を読み込めませんでした'; rosterNotice.hidden = false }
      else renderRosterError(error.message === 'MEMBERS_NOT_ACCEPTED'
        ? 'メンバー機能がいま応答できません。少し待ってから、もう一度読み込んでください。'
        : 'メンバー一覧を読み込めませんでした。通信を確かめて、もう一度読み込んでください。')
      throw error
    }
    if (read !== catalogueRead) return null
    rosterLoaded = true
    rosterRetry.disabled = false
    rosterRetry.textContent = '再読み込み'
    rosterNotice.hidden = true
    const listedIds = new Set(botResult.bots.map(bot => bot.id))
    for (const id of state.pendingDeletionIds ?? []) if (!listedIds.has(id)) state.pendingDeletionIds.delete(id)
    state.bots = botResult.bots.map(bot => ({ ...bot, deletionRequested:state.pendingDeletionIds?.has(bot.id) ?? false, avatar: bot.avatarVersion ? `/api/bots/${encodeURIComponent(bot.id)}/avatar?v=${encodeURIComponent(bot.avatarVersion)}` : '' }))
    state.rooms = roomResult.rooms
    applyOwner(ownerResult.owner, ownerStarted)
    const conversationKeys = new Set([...state.bots.map(bot => conversationKey('bot', bot.id)), ...state.rooms.map(room => conversationKey('room', room.id))])
    const obsoleteReceipts = Object.keys(state.readReceipts).filter(key => !conversationKeys.has(key))
    if (obsoleteReceipts.length) {
      for (const key of obsoleteReceipts) delete state.readReceipts[key]
      try { localStorage.setItem(READ_RECEIPTS_KEY, JSON.stringify(state.readReceipts)) } catch {}
    }
    if (state.selected) {
      const source = state.selectedType === 'room' ? state.rooms : state.bots
      const current = source.find(item => item.id === state.selected.id)
      if (current) {
        state.selected = current
        conversationTimeline.updateTarget({ type: state.selectedType, id: current.id, name: current.displayName ?? current.name })
        if (app.classList.contains('chat-open')) markConversationRead(state.selectedType, current)
        renderSeatLaunch()
      }
      else clearSelection()
    }
    renderChatStatus()
    renderBots()
    renderCurrentWork(document.querySelector('#current-work-detail'), state.selectedType, state.selected, state.bots)
    updateSendButton()
    return true
  }

  function renderSeatLaunch() {
    const text = state.selectedType === 'bot' ? seatLaunchText(state.selected?.seatLaunch) : null
    chatSeatLaunch.textContent = text ?? ''
    chatSeatLaunch.hidden = !text
  }

  // Settings always opens: the owner is read here when the list has not brought it yet.
  async function openOwnerDialog() {
    let owner = state.owner
    if (!owner) {
      const started = ++ownerReads
      ownerProfileButton.disabled = true
      try { owner = (await api('/api/owner')).owner ?? null } catch {}
      finally { ownerProfileButton.disabled = false }
      // A list read or profile save that started later wins; an older list read finishing later never overwrites this one.
      if (owner) applyOwner(owner, started)
      owner = state.owner ?? owner
    }
    if (owner) return ownerEditor.open(owner)
    rosterError.textContent = '設定を開けませんでした。通信を確かめて、もう一度押してください。'
    rosterNotice.hidden = false
  }

  function renderRosterError(message) {
    const card = document.createElement('div')
    card.className = 'roster-card is-error'
    card.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17h.01"/></svg><p></p><button type="button" class="primary-button">再読み込み</button>'
    card.querySelector('p').textContent = message
    const retry = card.querySelector('button')
    retry.addEventListener('click', () => {
      retry.disabled = true
      retry.textContent = '読み込んでいます…'
      loadBots().catch(() => {})
    })
    botList.replaceChildren(card)
  }

  // Chat header line 2 (W21): the role and the same state badge as the roster row; a room shows its head count.
  function renderChatStatus() {
    if (!state.selected) { chatStatus.replaceChildren(); return }
    if (state.selectedType === 'room') { chatStatus.textContent = `${state.selected.memberIds.length}人`; return }
    const badge = memberState(state.selected)
    chatStatus.replaceChildren(...(badge ? [stateBadge(badge)] : []), state.selected.position ?? '')
  }

  function stateBadge({ text, tone, reason }) {
    const badge = document.createElement('span')
    badge.className = `state-badge is-${tone}`
    badge.textContent = text
    if (reason) badge.title = reason
    return badge
  }

  function renderBots() {
    const query = rosterSearch.value
    const botRows = newestByRecent(state.bots).filter(bot => matchesMemberQuery(bot, query)).map(bot => {
      const row = memberRow(bot)
      const button = rosterButton('bot', bot, () => selectBot(bot))
      button.innerHTML = `
        <span class="avatar ${escapeClass(bot.color)}" data-avatar>${initials(bot.name)}</span>
        <span class="bot-copy"><span class="bot-name">${escapeHtml(row.name)}</span><span class="bot-preview">${escapeHtml(row.line)}</span></span>
        <span class="bot-meta"><time class="bot-time">${rowTime(bot.recent?.at)}</time>${button.classList.contains('unread') ? '<i class="unread-dot" title="未読" aria-label="未読"></i>' : ''}</span>`
      if (row.state) button.querySelector('[data-avatar]').append(stateBadge(row.state))
      applyAvatar(button.querySelector('[data-avatar]'), bot)
      return button
    })
    const roomRows = newestByRecent(state.rooms).filter(room => matchesRoomQuery(room, state.bots, query)).map(room => {
      const row = roomRow(room, state.bots, query)
      const button = rosterButton('room', room, () => selectRoom(room))
      button.innerHTML = `
        <span class="avatar room-avatar">${initials(room.name)}</span>
        <span class="bot-copy"><span class="bot-name">${escapeHtml(row.name)}</span><span class="bot-preview">${escapeHtml(row.line)}</span></span>
        <span class="bot-meta"><time class="bot-time">${rowTime(room.recent?.at)}</time>${button.classList.contains('unread') ? '<i class="unread-dot" title="未読" aria-label="未読"></i>' : ''}</span>`
      if (row.working.length) {
        const stack = document.createElement('span')
        stack.className = 'working-stack'
        stack.title = `作業中: ${row.working.map(bot => bot.name).join('、')}`
        for (const bot of row.working.slice(0, 3)) {
          const face = document.createElement('span')
          face.className = `mini-face ${escapeClass(bot.color)}`
          face.textContent = bot.name.slice(0, 1)
          applyAvatar(face, bot)
          stack.append(face)
        }
        if (row.working.length > 3) stack.append(Object.assign(document.createElement('span'), { className: 'working-more', textContent: `+${row.working.length - 3}` }))
        button.querySelector('.bot-copy').append(stack)
      }
      applyAvatar(button.querySelector('.avatar'), room)
      return button
    })
    const rows = [...botRows]
    if (roomRows.length) rows.push(Object.assign(document.createElement('p'), { className: 'list-heading', textContent: 'ルーム' }), ...roomRows)
    botList.replaceChildren(...(rows.length ? rows : [query.trim() ? rosterNoHit() : rosterEmpty()]))
  }

  function rosterButton(type, item, onSelect) {
    const button = document.createElement('button')
    const key = conversationKey(type, item.id)
    const unread = hasUnreadConversation(item, type, state.readReceipts[key])
    button.className = `bot-row${state.selectedType === type && state.selected?.id === item.id ? ' active' : ''}${unread ? ' unread' : ''}`
    button.dataset.conversation = key
    button.type = 'button'
    button.addEventListener('click', onSelect)
    return button
  }

  function rosterNoHit() {
    const card = document.createElement('div')
    card.className = 'roster-card'
    card.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg><p>見つかりませんでした。名前や役職を変えて探してください。</p>'
    return card
  }

  function rosterEmpty() {
    const card = document.createElement('div')
    card.className = 'roster-card'
    card.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="8" r="4"/><path d="M3 20a7 7 0 0 1 14 0M19 8v6M16 11h6"/></svg><p>まだメンバーがいません。</p><button type="button" class="primary-button">メンバーを追加</button>'
    card.querySelector('button').addEventListener('click', () => openBotDialog())
    if (state.setup && state.setup.phase !== 'ready') {
      const resume = Object.assign(document.createElement('button'), { type: 'button', className: 'text-button', textContent: '初回設定を続ける' })
      resume.addEventListener('click', () => void resumeSetup())
      card.append(resume)
    }
    return card
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
    renderCurrentWork(document.querySelector('#current-work-detail'), 'bot', bot, state.bots)
    chatName.textContent = bot.name ?? bot.displayName
    renderChatStatus()
    renderSeatLaunch()
    headerAvatar.className = `mini-avatar ${escapeClass(bot.color)}`
    headerAvatar.textContent = initials(bot.name)
    applyAvatar(headerAvatar, bot)
    editBotButton.disabled = false
    screenButton.hidden = false
    if (!screenPanel.hidden) void screenView.open(bot)
    markConversationRead('bot', bot)
    renderBots()
    await loadMessages(false)
    if (state.selected?.id === bot.id && state.selectedType === 'bot') animateConversation(timeline)
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
    renderCurrentWork(document.querySelector('#current-work-detail'), 'room', room, state.bots)
    chatName.textContent = room.name
    renderChatStatus()
    renderSeatLaunch()
    headerAvatar.className = 'mini-avatar room-avatar'
    headerAvatar.textContent = initials(room.name)
    applyAvatar(headerAvatar, room)
    editBotButton.disabled = false
    renderTargetPicker(room)
    markConversationRead('room', room)
    renderBots()
    await loadMessages(false)
    if (state.selected?.id === room.id && state.selectedType === 'room') animateConversation(timeline)
    updateSendButton()
    messageInput.focus()
  }

  function clearSelection() {
    renderCurrentWork(document.querySelector('#current-work-detail'), null, null, state.bots)
    conversationComposer.clear()
    conversationTimeline.close()
    void goals.select(null)
    closeScreen()
    screenButton.hidden = true
    state.selected = null
    state.selectedType = null
    chat.classList.add('empty')
    app.classList.remove('chat-open')
    chatName.textContent = ''
    renderChatStatus()
    renderSeatLaunch()
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

  // W35: 「返信する人」 popover (bottom sheet on a phone): 自動で選ぶ on top, avatar rows with a check, search over 8, 決定, Esc.
  function renderTargetPicker(room) {
    targetPicker.hidden = false
    toggleTargetMenu(false)
    state.roomTargets ??= new Map()
    const chosen = state.roomTargets.get(room.id) ?? new Set()
    for (const id of [...chosen]) if (!room.memberIds.includes(id)) chosen.delete(id)
    state.roomTargets.set(room.id, chosen)
    const title = Object.assign(document.createElement('h3'), { className: 'target-menu-title', textContent: '返信する人' })
    const note = document.createElement('p')
    note.className = 'target-menu-note'
    note.textContent = routingEnabled() ? '選ばなければ、返信する人を自動で選びます。発言は全員に届きます。' : '返信する人を選んでください。発言は全員に届きます。'
    const rows = []
    const row = (label, avatar, checked, onChange) => {
      const item = document.createElement('label')
      item.className = 'target-row'
      const input = Object.assign(document.createElement('input'), { type: 'checkbox', checked })
      input.addEventListener('change', () => onChange(input.checked))
      item.append(input, ...(avatar ? [avatar] : []), Object.assign(document.createElement('span'), { textContent: label }), Object.assign(document.createElement('i'), { className: 'target-check' }))
      return { item, input }
    }
    const auto = routingEnabled() ? row('自動で選ぶ', null, chosen.size === 0, checked => {
      if (checked) { chosen.clear(); for (const entry of rows) entry.input.checked = false }
      else auto.input.checked = chosen.size === 0
      renderTargetButton(room)
    }) : null
    for (const id of room.memberIds) {
      const bot = state.bots.find(item => item.id === id)
      const avatar = document.createElement('span')
      avatar.className = `mini-avatar ${escapeClass(bot?.color ?? '')}`
      avatar.textContent = initials(bot?.name ?? id)
      if (bot) applyAvatar(avatar, bot)
      const entry = row(bot?.name ?? id, avatar, chosen.has(id), checked => {
        if (checked) chosen.add(id); else chosen.delete(id)
        if (auto) auto.input.checked = chosen.size === 0
        renderTargetButton(room)
      })
      entry.item.dataset.name = bot?.name ?? id
      rows.push(entry)
    }
    const search = Object.assign(document.createElement('input'), { type: 'search', className: 'target-search', placeholder: '名前で探す' })
    search.setAttribute('aria-label', '返信する人を名前で探す')
    search.hidden = room.memberIds.length <= 8
    search.addEventListener('input', () => { for (const entry of rows) entry.item.hidden = !matchesRosterQuery(search.value, entry.item.dataset.name) })
    const done = Object.assign(document.createElement('button'), { type: 'button', className: 'primary-button target-done', textContent: '決定' })
    done.addEventListener('click', () => { toggleTargetMenu(false); targetButton.focus() })
    const list = document.createElement('div')
    list.className = 'target-list'
    list.append(...(auto ? [auto.item] : []), ...rows.map(entry => entry.item))
    targetMenu.replaceChildren(title, note, search, list, done)
    renderTargetButton(room)
  }

  function renderTargetButton(room) {
    const chosen = [...(state.roomTargets?.get(room.id) ?? [])]
    const bots = chosen.map(id => state.bots.find(item => item.id === id)).filter(Boolean)
    targetButton.replaceChildren()
    if (bots.length === 0) {
      targetButton.append(Object.assign(document.createElement('span'), { textContent: routingEnabled() ? '返信: 自動' : '返信する人を選ぶ' }))
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
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !targetMenu.hidden) { toggleTargetMenu(false); targetButton.focus() } })

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
    const deleting = state.selectedType === 'bot' && (state.selected?.deleting || state.selected?.deletionRequested)
    const busy = state.selectedType === 'bot' && state.selected && conversationTimeline.isBusy(state.selected.id)
    stopButton.hidden = deleting || !busy && !stopping
    stopButton.disabled = Boolean(stopping)
    sendButton.hidden = !deleting && Boolean(stopping)
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
    if (payload.all || payload.type === 'ready' || payload.type === 'updates') void updateCenter.refresh(payload)
    // 更新ジョブの知らせは更新画面だけの用事。会話や一覧を読み直さない。
    if (payload.type === 'updates') return
    try {
      if (payload.type === 'ai-control' && ownerDialog.open) void ownerEditor.refreshAI()
      if (payload.type === 'settings') {
        await loadFeatureSettings()
        if (ownerDialog.open) ownerEditor.refreshFeatureStatus(state.settings)
      }
      if (payload.type === 'setup') { state.setup = await api('/api/setup'); if (state.setup.phase === 'ready') setupNotice.hidden = true }
      if (state.selectedType === 'bot' && (payload.all || payload.botId === state.selected?.id || payload.botIds?.includes(state.selected?.id)))
        void goals.refreshOnEvent()
      await Promise.all([loadBots(), ...(eventAffectsTimeline(payload, state.selectedType, state.selected?.id) ? [loadMessages()] : [])])
      if (payload.all || ['ready','schedules','bots','rooms'].includes(payload.type) || payload.topics?.includes('schedules')) {
        void allSchedules.refresh(); void scheduleEditor.refresh()
      }
    } catch {
      conversationComposer.showError('表示を更新できませんでした。会話を開き直して確認してください。')
    }
  }

  async function connectEvents() {
    state.stopEvents?.()
    state.stopEvents = watchEvents(refreshFromEvent, error => {
      conversationComposer.showError(`更新の接続が止まりました: ${error.message}。ページを再読み込みして確認してください。`)
    }, payload => { void updateCenter.refresh(payload) })
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

  return { start: boot }
}
