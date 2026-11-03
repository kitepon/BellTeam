import { createWebPushSettings } from './web-push.js?v=__ASSET_VERSION__'
import { serverDestination } from './server-origin.js?v=__ASSET_VERSION__'
import { readConversationMotion, conversationMotionKey } from './view-preferences.js?v=__ASSET_VERSION__'
import { guardEditorClose } from './editor-close.js?v=__ASSET_VERSION__'
import { createAvatarEditor } from './avatar-editor.js?v=__ASSET_VERSION__'
import { applyAvatar, initials, escapeClass, escapeHtml } from './view-format.js?v=__ASSET_VERSION__'
import { renderFeatureSettings, refreshFeatureSettingsStatus } from './onboarding.js?v=__ASSET_VERSION__'
import { renderHarnessAuth } from './harness-auth.js?v=__ASSET_VERSION__'
import { aiControlView } from './ai-control.js?v=__ASSET_VERSION__'

export function createOwnerEditor(dialog, { api, onOwner, onSettings }) {
  const find = id => dialog.querySelector(`#${id}`)
  const form = find('owner-form'), name = find('owner-name'), description = find('owner-description')
  const xUrl = find('owner-x-url'), githubUrl = find('owner-github-url'), ownerLinks = find('owner-links')
  const error = find('owner-form-error'), rulesInput = find('user-rules'), saveButton = dialog.querySelector('button[form="owner-form"]')
  const webPush = createWebPushSettings(find('web-push-settings'), api)
  const aiControl = aiControlView(find('ai-control'), api)
  const avatar = createAvatarEditor({ onChange: () => { editRevision++ }, applyAvatar, initials, escapeClass,
    fileInput: find('owner-avatar-file'), preview: find('owner-avatar-preview'), cropEditor: find('owner-crop-editor'),
    canvas: find('owner-avatar-crop'), zoom: find('owner-avatar-zoom'), nameInput: name, fallback: 'O', error })
  for (const button of dialog.querySelectorAll('[data-settings-section]')) button.addEventListener('click', () => {
    find(button.dataset.settingsSection).scrollIntoView({ behavior:'smooth', block:'start' })
  })
  find('conversation-motion').addEventListener('change', () => {
    try { localStorage.setItem(conversationMotionKey, find('conversation-motion').value); find('motion-status').textContent = 'このブラウザーに保存しました。会話を開き直すと反映します。' }
    catch { find('motion-status').textContent = 'このブラウザーに設定を保存できませんでした。' }
  })
  find('server-open').addEventListener('click', () => {
    try {
      const destination = serverDestination(find('server-address').value)
      window.open(destination, '_blank', 'noopener,noreferrer')
      find('server-error').textContent = '別のサーバーを開きます。開かない場合はブラウザーのポップアップ設定を確認してください。'
    } catch { find('server-error').textContent = 'HTTPS、またはローカル接続のURLを入力してください。ユーザー名やパスワードは含めないでください。' }
  })
  find('notification-refresh').addEventListener('click', () => { void refreshNotification() })
  async function refreshNotification() {
    const opened = owner
    if (!opened || !dialog.open) return
    const read = opened.notificationRead = (opened.notificationRead ?? 0) + 1
    const status = find('notification-status')
    status.textContent = '通知の設定を確認しています…'
    try {
      const result = await api('/api/notifications')
      if (owner !== opened || opened.notificationRead !== read) return
      if (typeof result.configured !== 'boolean' || !Array.isArray(result.environments)) throw Error('INVALID_NOTIFICATION_STATUS')
      status.textContent = result.configured ? 'Appleアプリ向けの通知が設定されています。' : 'Appleアプリ向けの通知は未設定です。'
      if (result.error) status.textContent += ' 通知サーバーでエラーが発生しています。'
    } catch { if (owner === opened && opened.notificationRead === read) status.textContent = '通知の設定を取得できませんでした。更新して確認してください。' }
  }
  let owner = null, saving = null, editRevision = 0, harnessAuthSection = null
  guardEditorClose(dialog, () => Boolean(owner && (editRevision !== owner.initialRevision || avatar.changed())), () => Boolean(owner && saving === owner))
  form.addEventListener('submit', save)
  form.addEventListener('input', () => { editRevision++ })
  form.addEventListener('change', () => { editRevision++ })
  find('add-owner-link').addEventListener('click', () => addOwnerLinkRow())
  function clearSettingSecrets() {
    for (const input of dialog.querySelectorAll('#feature-settings input[type="password"]')) input.value = ''
  }
  dialog.addEventListener('close', () => {
    if (dialog.open) return
    owner = null
    webPush.close()
    clearSettingSecrets()
    avatar.cancelRead()
    harnessAuthSection?.stop()
    harnessAuthSection = null
  })
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearSettingSecrets()
    else if (dialog.open) { void aiControl.refresh(); void webPush.refresh() }
  })
  async function refreshFeatures(opened = owner) {
    if (!opened || opened !== owner) return
    const read = ++opened.featureRead
    let settings, session
    try {
      settings = (await api('/api/settings')).settings
      if (opened !== owner || read !== opened.featureRead) return
      session = await api('/api/session')
    } catch (failure) {
      if (opened !== owner || read !== opened.featureRead) return
      throw failure
    }
    if (opened !== owner || read !== opened.featureRead) return
    onSettings(settings, session.authMode)
    find('access-logout').hidden = session.authMode !== 'cloudflare'
    find('connection-mode').textContent = session.authMode === 'cloudflare' ? 'Cloudflare Accessで認証済み' : 'ローカル接続'
    if (opened.featuresRendered) { refreshFeatureSettingsStatus(opened.features, settings); void webPush.refresh() }
    else {
      renderFeatureSettings(opened.features, settings, { api, onChange: () => refreshFeatures(opened) })
      opened.featuresRendered = true
    }
  }
  async function open(profile) {
    if (!profile) return
    owner = { profile, rulesLoaded: false, featureRead: 0 }
    const opened = owner
    opened.features = document.createElement('div')
    opened.auth = document.createElement('div')
    find('feature-settings').replaceChildren(opened.features)
    find('harness-auth').replaceChildren(opened.auth)
    harnessAuthSection?.stop()
    harnessAuthSection = null
    void aiControl.refresh()
    form.reset()
    find('conversation-motion').value = readConversationMotion()
    find('motion-status').textContent = 'このブラウザーだけに適用します。端末の視覚効果を減らす設定を優先します。'
    find('server-address').value = globalThis.location?.origin ?? ''
    find('server-error').textContent = ''
    find('access-logout').hidden = true
    saveButton.disabled = true
    rulesInput.disabled = true
    error.textContent = ''
    name.value = profile.name
    description.value = profile.profile ?? ''
    xUrl.value = profile.xUrl ?? ''
    githubUrl.value = profile.githubUrl ?? ''
    renderOwnerLinkRows(profile.links ?? [])
    avatar.reset(profile.avatar)
    owner.initialRevision = editRevision
    if (!dialog.open) dialog.showModal()
    void refreshNotification()
    void webPush.open()
    const initialRules = rulesInput.value
    try {
      const result = await api('/api/user-rules')
      if (opened !== owner) return
      if (rulesInput.value === initialRules) rulesInput.value = result.text
      opened.rulesLoaded = true
      rulesInput.disabled = false
      saveButton.disabled = false
    } catch (failure) { if (opened === owner) error.textContent = `ユーザー規範を読めませんでした（${failure.message}）` }
    if (opened !== owner) return
    try {
      find('feature-settings-error').textContent = ''
      await refreshFeatures(opened)
    } catch (failure) { if (opened === owner) find('feature-settings-error').textContent = failure.message }
    if (opened !== owner) return
    try {
      find('harness-auth-error').textContent = ''
      const section = await renderHarnessAuth(opened.auth, { api })
      if (opened !== owner) { section.stop(); return }
      harnessAuthSection = section
    } catch (failure) { if (opened === owner) find('harness-auth-error').textContent = failure.message }
  }
  async function save(event) {
    event.preventDefault()
    if (!owner || !owner.rulesLoaded || saving === owner) return
    if (avatar.pending()) { error.textContent = '写真を読み込んでいます。表示を確認してから保存してください。'; return }
    const opened = owner, revision = editRevision
    const profile = {
      name: name.value.trim(), profile: description.value, avatar: avatar.value(), xUrl: xUrl.value.trim(), githubUrl: githubUrl.value.trim(),
      links: [...ownerLinks.querySelectorAll('.owner-link-row')].map(row => ({ label: row.querySelector('[data-owner-link-label]').value.trim(), url: row.querySelector('[data-owner-link-url]').value.trim() })),
    }
    const rules = rulesInput.value
    saving = opened
    saveButton.disabled = true
    error.textContent = ''
    let profileSaved = false
    try {
      const result = await api('/api/owner', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(profile) })
      profileSaved = true
      onOwner(result.owner)
      await api('/api/user-rules', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: rules }) })
      if (owner === opened) {
        if (revision === editRevision) dialog.close()
        else error.textContent = '保存しました。新しく書いた内容は入力欄に残しています。'
      }
    } catch (failure) {
      if (owner === opened) error.textContent = profileSaved ? `プロフィールは保存しました。ユーザー規範を保存できませんでした（${failure.message}）` : `保存できませんでした（${failure.message}）`
    } finally {
      if (saving === opened) saving = null
      if (owner === opened) saveButton.disabled = false
    }
  }
  function renderOwnerLinkRows(links) {
    ownerLinks.replaceChildren()
    links.forEach(link => addOwnerLinkRow(link, false))
  }

  function addOwnerLinkRow(link = { label: '', url: '' }, focus = true) {
    editRevision++
    const row = document.createElement('div')
    row.className = 'owner-link-row'
    row.innerHTML = `<input data-owner-link-label required maxlength="100" aria-label="情報源の名前" placeholder="ブログ" value="${escapeHtml(link.label)}"><input data-owner-link-url required type="url" maxlength="2048" inputmode="url" aria-label="情報源のURL" placeholder="https://example.com" value="${escapeHtml(link.url)}"><button type="button" aria-label="情報源を削除">×</button>`
    row.querySelector('button').addEventListener('click', () => { editRevision++; row.remove() })
    ownerLinks.append(row)
    if (focus) row.querySelector('input').focus()
  }


  return { open, refreshAI: () => aiControl.refresh(), refreshFeatureStatus(settings) { if (dialog.open && owner) { refreshFeatureSettingsStatus(owner.features, settings); void webPush.refresh() } } }
}
