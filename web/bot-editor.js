import { openImageViewer } from './image-gallery.js?v=__ASSET_VERSION__'
import { guardEditorClose, requestEditorClose } from './editor-close.js?v=__ASSET_VERSION__'
import { createAvatarEditor } from './avatar-editor.js?v=__ASSET_VERSION__'
import { applyAvatar, initials, escapeClass } from './view-format.js?v=__ASSET_VERSION__'

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
  const deleteBotButton = dialog.querySelector('#delete-bot-button')
  const botManagementActions = dialog.querySelector('#bot-management-actions')
  const characterSheetButton = dialog.querySelector('#character-sheet-button')
  const memoryButton = dialog.querySelector('#memory-button')
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
    models = {}
    owner = { bot }
    deleteBotButton.disabled = false
    restartSessionButton.disabled = false
    saveBotButton.textContent = '保存'
    verifySaveButton.hidden = true
    verifySaveButton.disabled = false
    renderBotConfigurationStatus(bot)
    botForm.reset()
    botFormError.textContent = ''
    botFastMode.checked = bot?.fastMode === true
    botDialogTitle.textContent = bot ? 'メンバーを編集' : 'メンバーを追加'
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
    avatar.reset(bot?.avatar)
    largeAvatar.reset(bot?.avatarLarge || (bot?.avatarLargeVersion ? `/api/bots/${bot.id}/avatar-large?v=${encodeURIComponent(bot.avatarLargeVersion)}` : ''))
    botAvatarFile.disabled = Boolean(bot)
    largeFile.disabled = Boolean(bot)
    smallRecrop.disabled = true
    largeRecrop.disabled = true
    appearanceStatus.textContent = bot ? '保存済みの写真を読み込んでいます…' : '一覧用の小画像とプロフィール用の大画像を別々に保存できます。'
    owner.initialRevision = editRevision
    if (!dialog.open) dialog.showModal()
    try {
      const result = await api('/api/models', { signal: controller.signal })
      if (controller.signal.aborted) return
      models = result.models
      renderModelOptions(botHarness.value, bot?.model ?? '', bot?.reasoningEffort ?? '')
      if (bot) {
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
      botModelStatus.textContent = `モデル一覧を取得できません（${error.message}）`
    } finally {
      if (!controller.signal.aborted) {
        botHarness.disabled = false
        saveBotButton.disabled = false
      }
    }
  }
  dialog.addEventListener('close', () => { if (!dialog.open) { modelLoad?.abort(); owner = null; avatar.cancelRead(); largeAvatar.cancelRead() } })

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
    const entry = models[harness]
    botModel.disabled = !entry || Boolean(entry.error)
    botReasoningEffort.disabled = botModel.disabled
    botModelStatus.textContent = entry?.error?.message ?? ''
    const candidates = (models[harness]?.models ?? []).map(model => model.id)
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
    const catalog = models[botHarness.value]
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
    renderFastMode()
  }
  function renderFastMode() {
    const catalog = models[botHarness.value]
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

  async function saveBot(event) {
    event.preventDefault()
    if (!owner || saving === owner) return
    if (avatar.pending() || largeAvatar.pending()) { botFormError.textContent = '写真を読み込んでいます。表示を確認してから保存してください。'; return }
    const opened = owner, revision = editRevision
    const current = () => owner === opened && revision === editRevision
    saving = opened
    botFormError.textContent = ''
    saveBotButton.disabled = true
    saveBotButton.textContent = opened.bot ? '保存中…' : '作成中…'
    const profile = {
      name: botName.value.trim(), profileText: botProfileText.value, personality: botPersonality.value,
      speechStyle: botSpeechStyle.value, position: botPosition.value.trim(), role: botRole.value,
      ...(avatar.changed() ? { avatar: avatar.value(), avatarSource:avatar.source(), avatarCrop:avatar.rectangle() } : {}),
      ...(largeAvatar.changed() ? { avatarLarge:largeAvatar.value(), avatarLargeSource:largeAvatar.source(), avatarLargeCrop:largeAvatar.rectangle() } : {}),
      ...((opened.bot?.fastMode === true) !== botFastMode.checked ? { fastMode: botFastMode.checked } : {}),
      color: botColor.value, harness: botHarness.value, model: selectedModel(), reasoningEffort: botReasoningEffort.value,
    }
    opened.submission = { profile, revision }
    let accepted = false
    try {
      const result = await api(opened.bot ? `/api/bots/${opened.bot.id}` : '/api/bots', {
        method: opened.bot ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(profile),
      })
      accepted = true
      opened.bot = result.bot
      await onSaved(result.bot, current)
      if (current()) dialog.close()
    } catch (error) {
      if (owner === opened) {
        botFormError.textContent = accepted ? '保存しました。表示を更新できませんでした。' : `保存結果を確認できませんでした（${error.message}）。入力は残しています。`
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
    if (!bot || restartSessionButton.disabled) return
    restartSessionButton.disabled = true
    onStatus(bot, '再起動中')
    try {
      await api(`/api/bots/${bot.id}/restart`, { method: 'POST' })
      if (owner === opened) dialog.close()
      onRestarted(bot)
    } catch { onStatus(bot, '再起動できませんでした') }
    finally { if (owner === opened) restartSessionButton.disabled = false }
  }
  async function remove() {
    const opened = owner, bot = opened?.bot
    if (!bot || deleteBotButton.disabled || !window.confirm(`${bot.displayName}を削除しますか？`)) return
    deleteBotButton.disabled = true
    let accepted = false
    try {
      await api(`/api/bots/${bot.id}`, { method: 'DELETE' })
      accepted = true
      await onDeleted(bot)
      if (owner === opened) dialog.close()
    } catch { if (owner === opened) botFormError.textContent = accepted ? '削除操作を受け付けました。表示を更新できませんでした。' : '削除できませんでした。' }
    finally { if (owner === opened) deleteBotButton.disabled = false }
  }

  return { open }
}
