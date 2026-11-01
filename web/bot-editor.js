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
  const saveBotButton = dialog.querySelector('#save-bot-button')
  const restartSessionButton = dialog.querySelector('#restart-session-button')
  const deleteBotButton = dialog.querySelector('#delete-bot-button')
  const botManagementActions = dialog.querySelector('#bot-management-actions')
  const characterSheetButton = dialog.querySelector('#character-sheet-button')
  const memoryButton = dialog.querySelector('#memory-button')
  const avatar = createAvatarEditor({ applyAvatar, initials, escapeClass,
    fileInput: botAvatarFile, preview: botAvatarPreview, cropEditor, canvas: avatarCrop, zoom: avatarZoom,
    nameInput: botName, colorInput: botColor, fallback: 'B', error: botFormError })
  botForm.addEventListener('submit', saveBot)
  botForm.addEventListener('input', () => { editRevision++ })
  botForm.addEventListener('change', () => { editRevision++ })
  restartSessionButton.addEventListener('click', restart)
  deleteBotButton.addEventListener('click', remove)
  memoryButton.addEventListener('click', () => { const bot = owner?.bot; if (bot) { dialog.close(); onMemory(bot) } })
  characterSheetButton.addEventListener('click', () => { if (owner?.bot) onSheets(owner.bot) })
  function renderBotConfigurationStatus(bot) {
    const application = bot?.configurationApplication
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
    avatar.reset(bot?.avatar)
    if (!dialog.open) dialog.showModal()
    try {
      const result = await api('/api/models', { signal: controller.signal })
      if (controller.signal.aborted) return
      models = result.models
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
  dialog.addEventListener('close', () => { if (!dialog.open) { modelLoad?.abort(); owner = null; avatar.cancelRead() } })

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
    if (!owner || saving === owner) return
    const opened = owner, revision = editRevision
    const current = () => owner === opened && revision === editRevision
    saving = opened
    botFormError.textContent = ''
    saveBotButton.disabled = true
    saveBotButton.textContent = opened.bot ? '保存中…' : '作成中…'
    const profile = {
      name: botName.value.trim(), profileText: botProfileText.value, personality: botPersonality.value,
      speechStyle: botSpeechStyle.value, position: botPosition.value.trim(), role: botRole.value,
      ...(!opened.bot || avatar.changed() ? { avatar: avatar.value() } : {}),
      color: botColor.value, harness: botHarness.value, model: selectedModel(), reasoningEffort: botReasoningEffort.value,
    }
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
      if (owner === opened) botFormError.textContent = accepted ? '保存しました。表示を更新できませんでした。' : `保存できませんでした（${error.message}）`
    } finally {
      if (saving === opened) saving = null
      if (owner === opened) { saveBotButton.disabled = false; saveBotButton.textContent = '保存' }
    }
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
