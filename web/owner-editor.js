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
  const aiControl = aiControlView(find('ai-control'), api)
  const avatar = createAvatarEditor({ applyAvatar, initials, escapeClass,
    fileInput: find('owner-avatar-file'), preview: find('owner-avatar-preview'), cropEditor: find('owner-crop-editor'),
    canvas: find('owner-avatar-crop'), zoom: find('owner-avatar-zoom'), nameInput: name, fallback: 'O', error })
  let owner = null, saving = null, editRevision = 0, harnessAuthSection = null
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
    clearSettingSecrets()
    avatar.cancelRead()
    harnessAuthSection?.stop()
    harnessAuthSection = null
  })
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearSettingSecrets()
    else if (dialog.open) void aiControl.refresh()
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
    find('connection-mode').textContent = session.authMode === 'cloudflare' ? 'Cloudflare Accessで認証済み' : 'ローカル接続'
    if (opened.featuresRendered) refreshFeatureSettingsStatus(opened.features, settings)
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
    saveButton.disabled = true
    rulesInput.disabled = true
    error.textContent = ''
    name.value = profile.name
    description.value = profile.profile ?? ''
    xUrl.value = profile.xUrl ?? ''
    githubUrl.value = profile.githubUrl ?? ''
    renderOwnerLinkRows(profile.links ?? [])
    avatar.reset(profile.avatar)
    if (!dialog.open) dialog.showModal()
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


  return { open, refreshAI: () => aiControl.refresh(), refreshFeatureStatus(settings) { if (dialog.open && owner) refreshFeatureSettingsStatus(owner.features, settings) } }
}
