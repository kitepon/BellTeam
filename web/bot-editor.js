import { openImageViewer } from './image-gallery.js?v=__ASSET_VERSION__'
import { guardEditorClose, requestEditorClose } from './editor-close.js?v=__ASSET_VERSION__'
import { createAvatarEditor } from './avatar-editor.js?v=__ASSET_VERSION__'
import { applyAvatar, initials, escapeClass, modelChoices } from './view-format.js?v=__ASSET_VERSION__'
import { FOLDER_UNCHECKED, folderRefusal, memberFolder, readTerminals, remoteBindingBody } from './terminals.js?v=__ASSET_VERSION__'

// Plain reason for a definite save refusal; an unknown code gets the generic sentence, never the code alone.
const SAVE_REFUSALS = {
  MEMBERS_INPUT_INVALID: '本体がこの入力にまだ対応していないか、入力の形が違います。本体を「Update」で更新してから、もう一度保存してください。',
  BOT_NAME_INVALID: '名前を確かめてください。',
  BOT_DUPLICATE: '同じメンバーがもういます。名前を変えてください。',
  BOT_PROJECT_EXISTS: '同じ名前の場所がもうあります。名前を変えてください。',
  BOT_NOT_FOUND: 'このメンバーはもういません。一覧を更新してください。',
  BOT_UPDATE_CONFLICT: 'ほかの画面で先に変更されました。開き直してから入力してください。',
  BOT_HARNESS_INVALID: 'AIの設定（CLI・モデル・エフォート）を選び直してください。',
  BOT_MODEL_INVALID: 'AIの設定（CLI・モデル・エフォート）を選び直してください。',
  BOT_REASONING_EFFORT_INVALID: 'AIの設定（CLI・モデル・エフォート）を選び直してください。',
  BOT_TERMINAL_ID_INVALID: '端末とフォルダを確かめてください。',
  BOT_PROJECT_ROOT_INVALID: '端末とフォルダを確かめてください。',
  BOT_REMOTE_BINDING_INVALID: '端末とフォルダを確かめてください。',
}
export const memberSaveRefusal = (error, folder) => folderRefusal(error, folder) ?? SAVE_REFUSALS[error?.code] ?? 'サーバーが入力を受け付けませんでした。入力を見直してから、もう一度保存してください。'

export function createBotEditor(dialog, { api, onSaved, onDeleted, onRestarted, onStatus, onMemory, onSheets }) {
  let owner = null, models = {}, modelLoad = null, saving = null, editRevision = 0
  const botForm = dialog.querySelector('#bot-form')
  const botDialogTitle = dialog.querySelector('#bot-dialog-title')
  const botName = dialog.querySelector('#bot-name')
  const botHarness = dialog.querySelector('#bot-harness')
  const botModel = dialog.querySelector('#bot-model')
  const botModelCustom = dialog.querySelector('#bot-model-custom')
  const botModelCustomField = dialog.querySelector('#bot-model-custom-field')
  const botFastMode = dialog.querySelector('#bot-fast-mode')
  const botFastStatus = dialog.querySelector('#bot-fast-status')
  const botReasoningEffort = dialog.querySelector('#bot-reasoning-effort')
  const botProfileText = dialog.querySelector('#bot-profile-text')
  const botPersonality = dialog.querySelector('#bot-personality')
  const botSpeechStyle = dialog.querySelector('#bot-speech-style')
  const botPosition = dialog.querySelector('#bot-position')
  const botRole = dialog.querySelector('#bot-role')
  const botAvatarFile = dialog.querySelector('#bot-avatar-file')
  const botAvatarPreview = dialog.querySelector('#bot-avatar-preview')
  const cropEditor = dialog.querySelector('#crop-editor')
  const avatarCrop = dialog.querySelector('#avatar-crop')
  const avatarZoom = dialog.querySelector('#avatar-zoom')
  const botColor = dialog.querySelector('#bot-color')
  const botFormError = dialog.querySelector('#bot-form-error')
  const botModelStatus = dialog.querySelector('#bot-model-status')
  const botConfigurationStatus = dialog.querySelector('#bot-configuration-status')
  const verifySaveButton = dialog.querySelector('#verify-bot-save')
  const saveBotButton = dialog.querySelector('#save-bot-button')
  const restartSessionButton = dialog.querySelector('#restart-session-button')
  const verifyDeletionButton = dialog.querySelector('#verify-bot-deletion')
  const deletionStatus = dialog.querySelector('#bot-deletion-status')
  const deleteBotButton = dialog.querySelector('#delete-bot-button')
  const botManagementActions = dialog.querySelector('#bot-management-actions')
  const characterSheetButton = dialog.querySelector('#character-sheet-button')
  const memoryButton = dialog.querySelector('#memory-button')
  const botRemote = dialog.querySelector('#bot-remote')
  const botTerminal = dialog.querySelector('#bot-terminal')
  const botProjectRoot = dialog.querySelector('#bot-project-root')
  const botProjectRootField = dialog.querySelector('#bot-project-root-field')
  const botRemoteStatus = dialog.querySelector('#bot-remote-status')
  const botCreateFolder = dialog.querySelector('#bot-create-folder')
  // Prefill an empty folder, or one still holding our own prefill; typed text is never replaced.
  const prefillFolder = () => {
    const user = owner?.terminals?.find(item => item.terminalId === botTerminal.value)?.user
    if (!user || (botProjectRoot.value && botProjectRoot.value !== owner.prefill)) return
    botProjectRoot.value = owner.prefill = memberFolder(user, botName.value)
  }
  botTerminal.addEventListener('change', () => { botProjectRootField.hidden = !botTerminal.value; botCreateFolder.hidden = true; prefillFolder() })
  botName.addEventListener('input', () => { if (owner?.remote && botTerminal.value) prefillFolder() })
  botCreateFolder.addEventListener('click', event => { void saveBot(event, { createFolder: true }) })
  const avatar = createAvatarEditor({ onChange: () => { editRevision++ }, retainSource:true, applyAvatar, initials, escapeClass,
    fileInput: botAvatarFile, preview: botAvatarPreview, cropEditor, canvas: avatarCrop, zoom: avatarZoom,
    nameInput: botName, colorInput: botColor, fallback: 'B', error: botFormError })
  const largeFile = dialog.querySelector('#bot-large-file')
  const largeRecrop = dialog.querySelector('#bot-large-recrop')
  const smallRecrop = dialog.querySelector('#bot-small-recrop')
  const appearanceStatus = dialog.querySelector('#bot-appearance-status')
  const largeAvatar = createAvatarEditor({ onChange: () => { editRevision++ }, retainSource:true, applyAvatar, initials, escapeClass,
    fileInput:largeFile, preview:dialog.querySelector('#bot-large-preview'),cropEditor:dialog.querySelector('#bot-large-editor'),
    canvas:dialog.querySelector('#bot-large-crop'),zoom:dialog.querySelector('#bot-large-zoom'),nameInput:botName,colorInput:botColor,fallback:'B',error:botFormError })
  dialog.querySelector('#bot-large-view').addEventListener('click', () => { if (largeAvatar.value()) openImageViewer([largeAvatar.value()], 0, 'プロフィール用の大画像') })
  smallRecrop.addEventListener('click', () => { void avatar.recrop() })
  largeRecrop.addEventListener('click', () => { void largeAvatar.recrop() })
  guardEditorClose(dialog, () => Boolean(owner && (editRevision !== owner.initialRevision || avatar.changed() || largeAvatar.changed())), () => Boolean(owner && saving === owner))
  botForm.addEventListener('submit', saveBot)
  botForm.addEventListener('input', () => { editRevision++ })
  botForm.addEventListener('change', () => { editRevision++ })
  restartSessionButton.addEventListener('click', restart)
  deleteBotButton.addEventListener('click', remove)
  verifyDeletionButton.addEventListener('click', verifyDeletion)
  verifySaveButton.addEventListener('click', verifySave)
  memoryButton.addEventListener('click', () => { const bot = owner?.bot; if (bot) { requestEditorClose(dialog); if (!dialog.open) onMemory(bot) } })
  characterSheetButton.addEventListener('click', () => { if (owner?.bot) onSheets(owner.bot) })
  function renderBotConfigurationStatus(bot) {
    const application = bot?.configurationApplication
    botConfigurationStatus.setAttribute('data-state', application?.state === 'failed' ? 'error' : 'notice')
    botConfigurationStatus.textContent = !bot ? ''
      : application?.state === 'pending' ? '現在の作業が終わった後に設定を反映します。適用はまだ確認できていません。'
      : application?.state === 'failed' ? application.message
      : application?.state === 'accepted' ? 'CLIが設定変更を受け付けました。'
      : bot.online ? '保存した希望設定です。稼働中のCLIへの適用は未確認です。'
      : '次回の起動に使う希望設定です。'
  }

  async function open(bot = null) {
    modelLoad?.abort()
    const controller = new AbortController()
    modelLoad = controller
    models = null
    owner = { bot }
    deleteBotButton.disabled = false
    restartSessionButton.disabled = false
    saveBotButton.textContent = '保存'
    verifySaveButton.hidden = true
    verifySaveButton.disabled = false
    renderBotConfigurationStatus(bot)
    botForm.reset()
    for (const input of botForm.querySelectorAll('input,textarea,select')) input.disabled = false
    deletionStatus.textContent = ''
    verifyDeletionButton.disabled = false
    verifyDeletionButton.hidden = true
    botFormError.textContent = ''
    botFastMode.checked = bot?.fastMode === true
    botDialogTitle.textContent = bot ? 'メンバーを編集' : 'メンバーを追加'
    botHarness.disabled = true
    botModel.disabled = true
    botReasoningEffort.disabled = true
    saveBotButton.disabled = true
    botManagementActions.hidden = !bot
    characterSheetButton.hidden = !bot
    characterSheetButton.disabled = false
    memoryButton.disabled = false
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
    avatar.reset(bot?.avatar)
    largeAvatar.reset(bot?.avatarLarge || (bot?.avatarLargeVersion ? `/api/bots/${bot.id}/avatar-large?v=${encodeURIComponent(bot.avatarLargeVersion)}` : ''))
    botAvatarFile.disabled = Boolean(bot)
    largeFile.disabled = Boolean(bot)
    smallRecrop.disabled = true
    largeRecrop.disabled = true
    appearanceStatus.textContent = bot ? '保存済みの写真を読み込んでいます…' : '一覧用の小画像とプロフィール用の大画像を別々に保存できます。'
    owner.initialRevision = editRevision
    renderDeletionState()
    botRemote.hidden = true
    if (!dialog.open) dialog.showModal()
    void loadRemote(owner, controller.signal)
    try {
      const result = await api('/api/models', { signal: controller.signal })
      if (controller.signal.aborted) return
      models = result.models
      renderModelOptions(botHarness.value, bot?.model ?? '', bot?.reasoningEffort ?? '')
      if (bot && !deletionPending()) {
        try {
          const current = await api(`/api/bots/${bot.id}`, { signal: controller.signal })
          if (!controller.signal.aborted) {
            renderBotConfigurationStatus({ ...bot, ...current.bot })
            avatar.reset(current.bot.avatar, {source:current.bot.avatarSource,rect:current.bot.avatarCrop})
            largeAvatar.reset(current.bot.avatarLarge, {source:current.bot.avatarLargeSource,rect:current.bot.avatarLargeCrop})
            botAvatarFile.disabled = false
            largeFile.disabled = !Object.hasOwn(current.bot, 'avatarLarge')
            smallRecrop.disabled = !current.bot.avatarSource
            largeRecrop.disabled = !current.bot.avatarLargeSource
            appearanceStatus.textContent = largeFile.disabled ? 'この本体は大画像の独立編集に対応していません。' : '小画像と大画像は独立して保存します。変更しない画像は保持します。'
          }
        } catch {
          if (!controller.signal.aborted) { botConfigurationStatus.textContent = '現在の適用状態を取得できません。'; appearanceStatus.textContent = '保存済みの写真を取得できません。写真の編集は開き直して確認してください。' }
        }
      }
    } catch (error) {
      if (controller.signal.aborted) return
      models = {}
      renderModelOptions(botHarness.value, bot?.model ?? '', bot?.reasoningEffort ?? '')
      botModelStatus.textContent = `モデル一覧を取得できません（${error.message}）`
    } finally {
      if (!controller.signal.aborted) {
        botHarness.disabled = false
        saveBotButton.disabled = false
        renderDeletionState()
      }
    }
  }
  dialog.addEventListener('close', () => { if (!dialog.open) { modelLoad?.abort(); owner = null; avatar.cancelRead(); largeAvatar.cancelRead() } })

  // 動かす場所: shown only when this body serves /api/terminals, so older bodies never see the two fields.
  async function loadRemote(opened, signal) {
    let result
    try { result = await readTerminals(api, { signal }) } catch { return }
    if (owner !== opened || signal.aborted || result.error) return
    const savedId = opened.bot?.terminalId ?? ''
    const options = [['', 'BellTeamの中（通常の席）'], ...result.terminals.map(item => [item.terminalId, `${item.terminalId}（${item.user}@${item.host}）`])]
    // A saved binding whose terminal is gone stays visible instead of being silently replaced.
    if (savedId && !result.terminals.some(item => item.terminalId === savedId)) options.push([savedId, `${savedId}（登録がありません）`])
    selectOptions(botTerminal, options)
    botTerminal.value = savedId
    botProjectRoot.value = opened.bot?.projectRoot ?? ''
    botProjectRootField.hidden = !savedId
    botRemoteStatus.textContent = result.terminals.length ? '' : '端末はまだ登録されていません。設定の「端末」から登録できます。'
    botCreateFolder.hidden = true
    opened.terminals = result.terminals
    opened.remote = true
    if (savedId) prefillFolder()
    botRemote.hidden = false
  }

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
    const entry = models?.[harness]
    botModel.disabled = !entry || Boolean(entry.error)
    botReasoningEffort.disabled = botModel.disabled
    botModelStatus.setAttribute('data-state', models ? 'error' : 'notice')
    if (!models) {
      // Before /api/models answers, show only the saved values and say so; nothing is judged yet.
      botModelStatus.textContent = 'モデル一覧を読み込んでいます…'
      selectOptions(botModel, [[current, `${current || 'CLIの既定'}（読み込み中…）`]])
      selectOptions(botReasoningEffort, [[effort, `${effort || 'CLIの既定'}（読み込み中…）`]])
      botModel.value = current
      botReasoningEffort.value = effort
      botModelCustomField.hidden = true
      renderFastMode()
      return
    }
    botModelStatus.textContent = entry?.error?.message ?? ''
    const choices = modelChoices(entry?.models ?? [])
    selectOptions(botModel, [['', 'CLIの既定'], ...choices, [CUSTOM_MODEL, 'その他（手入力）']])
    const listed = current === '' || choices.some(([id]) => id === current)
    botModel.value = listed ? current : CUSTOM_MODEL
    botModelCustom.value = listed ? '' : current
    botModelCustomField.hidden = botModel.value !== CUSTOM_MODEL
    renderEffortOptions(effort)
  }
  // 一覧のモデルはそのモデルが受け付けるエフォート、既定と手入力はCLI全体の範囲を出す。
  // CursorはモデルIDとエフォートを連結して起動するので、モデル未指定ではエフォートを選べない。
  function selectableEfforts() {
    const catalog = models?.[botHarness.value]
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
    if (current && !efforts.includes(current)) options.push([current, models?.[botHarness.value] ? `${current}（このモデルでは未対応）` : current])
    selectOptions(botReasoningEffort, options)
    botReasoningEffort.value = current
    renderFastMode()
  }
  function renderFastMode() {
    const catalog = models?.[botHarness.value]
    const model = selectedModel()
    const choice = catalog?.models.find(item => item.id === (model || catalog.defaultModel))
    const reason = !catalog ? 'モデルの対応をまだ確認できません。'
      : catalog.error?.message || catalog.fastUnavailable?.message
      || (!model && !choice ? '既定モデルの対応を確認できません。' : '')
      || (botModel.value === CUSTOM_MODEL && !model ? 'モデルIDを入力してください。' : '')
      || (choice && choice.fast !== true ? 'このモデルはファストモードに対応していません。' : '')
    botFastMode.disabled = !botFastMode.checked && Boolean(reason)
    botFastStatus.textContent = reason || '対応可否の最終判定は保存時に行います。'
  }
  botFastMode.addEventListener('change', renderFastMode)
  botModelCustom.addEventListener('input', renderFastMode)
  function selectedModel() {
    return botModel.value === CUSTOM_MODEL ? botModelCustom.value.trim() : botModel.value
  }
  botHarness.addEventListener('change', () => renderModelOptions(botHarness.value, '', ''))
  botModel.addEventListener('change', () => {
    botModelCustomField.hidden = botModel.value !== CUSTOM_MODEL
    // 選び直したモデルが今のエフォートを受け付けなければ、CLIの既定へ戻す。
    renderEffortOptions(selectableEfforts().includes(botReasoningEffort.value) ? botReasoningEffort.value : '')
  })

  async function saveBot(event, { createFolder = false } = {}) {
    event.preventDefault()
    if (!owner || saving === owner || deletionPending()) return
    if (avatar.pending() || largeAvatar.pending()) { botFormError.textContent = '写真を読み込んでいます。表示を確認してから保存してください。'; return }
    const remote = owner.remote ? remoteBindingBody(owner.bot, botTerminal.value, botProjectRoot.value) : { body: {} }
    if (remote.error) { botFormError.textContent = remote.error; return }
    const opened = owner, revision = editRevision
    const current = () => owner === opened && revision === editRevision
    saving = opened
    botFormError.textContent = ''
    botCreateFolder.hidden = true
    verifySaveButton.hidden = true
    saveBotButton.disabled = true
    saveBotButton.textContent = opened.bot ? '保存中…' : '作成中…'
    const profile = {
      name: botName.value.trim(), profileText: botProfileText.value, personality: botPersonality.value,
      speechStyle: botSpeechStyle.value, position: botPosition.value.trim(), role: botRole.value,
      ...(avatar.changed() ? { avatar: avatar.value(), avatarSource:avatar.source(), avatarCrop:avatar.rectangle() } : {}),
      ...(largeAvatar.changed() ? { avatarLarge:largeAvatar.value(), avatarLargeSource:largeAvatar.source(), avatarLargeCrop:largeAvatar.rectangle() } : {}),
      ...((opened.bot?.fastMode === true) !== botFastMode.checked ? { fastMode: botFastMode.checked } : {}),
      color: botColor.value, harness: botHarness.value, model: selectedModel(), reasoningEffort: botReasoningEffort.value,
      ...remote.body,
    }
    opened.submission = { profile, revision }
    let accepted = false
    try {
      // createFolder is a request-only flag (members S5): never saved, so it stays out of the verify snapshot.
      const result = await api(opened.bot ? `/api/bots/${opened.bot.id}` : '/api/bots', {
        method: opened.bot ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(createFolder ? { ...profile, createFolder } : profile),
      })
      accepted = true
      opened.bot = result.bot
      await onSaved(result.bot, current)
      // Saved without reaching the Mac: keep the dialog open so the quiet note is read.
      if (result.bot?.folderCheck?.checked === false) { if (owner === opened) botRemoteStatus.textContent = FOLDER_UNCHECKED }
      else if (current()) dialog.close()
    } catch (error) {
      // 4xx (not 408) is a definite refusal: nothing was saved, so there is nothing to verify.
      const refused = !accepted && error?.status >= 400 && error.status < 500 && error.status !== 408
      if (owner === opened && refused) {
        botFormError.textContent = `保存できませんでした。${memberSaveRefusal(error, profile.projectRoot ?? botProjectRoot.value.trim())}`
        botCreateFolder.hidden = error.code !== 'FOLDER_MISSING'
      } else if (owner === opened) {
        botFormError.textContent = accepted ? '保存しました。表示を更新できませんでした。' : '保存結果を確認できませんでした。サーバーから確かな返事が届きませんでした。入力は残しています。'
        verifySaveButton.hidden = !opened.bot
      }
    } finally {
      if (saving === opened) saving = null
      if (owner === opened) { saveBotButton.disabled = false; saveBotButton.textContent = '保存' }
    }
  }
  async function verifySave() {
    const opened = owner, submitted = opened?.submission
    if (!opened?.bot || !submitted || verifySaveButton.disabled) return
    verifySaveButton.disabled = true
    try {
      const { bot } = await api(`/api/bots/${opened.bot.id}`)
      if (owner !== opened || opened.submission !== submitted) return
      const matches = Object.entries(submitted.profile).every(([key,value]) => JSON.stringify(bot[key] ?? (typeof value === 'string' ? '' : null)) === JSON.stringify(value))
      if (!matches) { botFormError.textContent = '保存済みの内容は送信した内容と異なります。入力を確認してから保存してください。'; return }
      const current = () => owner === opened && submitted.revision === editRevision
      await onSaved(bot, current)
      if (current()) dialog.close()
      else botFormError.textContent = '送信した内容の保存を確認しました。後から変更した入力は残しています。'
    } catch { if (owner === opened) botFormError.textContent = '保存結果を取得できませんでした。入力を残しています。再確認してください。' }
    finally { if (owner === opened) verifySaveButton.disabled = false }
  }
  async function restart() {
    const opened = owner, bot = opened?.bot
    if (!bot || restartSessionButton.disabled || deletionPending()) return
    restartSessionButton.disabled = true
    onStatus(bot, '再起動中')
    try {
      await api(`/api/bots/${bot.id}/restart`, { method: 'POST' })
      if (owner === opened) dialog.close()
      onRestarted(bot)
    } catch { onStatus(bot, '再起動できませんでした') }
    finally { if (owner === opened) restartSessionButton.disabled = false }
  }
  function deletionPending() { return Boolean(owner?.deletionRequested || owner?.deletionUnconfirmed || owner?.bot?.deleting || owner?.bot?.deletionRequested) }
  function renderDeletionState() {
    const pending = deletionPending()
    verifyDeletionButton.hidden = !pending
    if (!pending) return
    saveBotButton.disabled = true
    restartSessionButton.disabled = true
    deleteBotButton.disabled = true
    appearanceStatus.textContent = '削除結果が未確認のため写真の編集はできません。'
    memoryButton.disabled = true
    characterSheetButton.disabled = true
    for (const input of botForm.querySelectorAll('input,textarea,select')) input.disabled = true
    deletionStatus.textContent = owner.deletionUnconfirmed ? '削除結果はまだ確認できません。一覧を確認するまで編集はできません。' : '削除操作を受け付けました。完了はまだ確認できていません。'
  }
  async function verifyDeletion() {
    const opened = owner, bot = opened?.bot
    if (!bot || verifyDeletionButton.disabled) return
    verifyDeletionButton.disabled = true
    try {
      const present = await onDeleted(bot, true)
      if (owner !== opened) return
      if (present === false) dialog.close()
      else deletionStatus.textContent = '一覧に残っています。削除の完了は未確認です。入力と履歴を保持しています。'
    } catch { if (owner === opened) deletionStatus.textContent = '削除結果を取得できませんでした。再確認してください。削除は再送していません。' }
    finally { if (owner === opened) verifyDeletionButton.disabled = false }
  }
  async function remove() {
    const opened = owner, bot = opened?.bot
    if (!bot || deleteBotButton.disabled || deletionPending() || !window.confirm(`${bot.displayName}を削除しますか？`)) return
    deleteBotButton.disabled = true
    let accepted = false
    try {
      await api(`/api/bots/${bot.id}`, { method: 'DELETE' })
      accepted = true
      opened.deletionRequested = true
      if (owner === opened) renderDeletionState()
      const present = await onDeleted(bot)
      if (owner === opened && present === false) dialog.close()
    } catch {
      if (owner === opened) {
        if (!accepted) opened.deletionUnconfirmed = true
        renderDeletionState()
        botFormError.textContent = accepted ? '削除操作を受け付けました。表示を更新できませんでした。' : '削除結果を確認できませんでした。削除は自動で再送しません。'
      }
    } finally { if (owner === opened) deleteBotButton.disabled = deletionPending() }
  }

  return { open }
}
