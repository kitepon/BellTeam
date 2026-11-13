// 設定。ホームの項目の列と、項目ごとのページ（docs/architecture/modules/web/user-paths.md 4）。
// 値を変えるカードは、それぞれのカードの下の保存だけで保存する。上の見出しに保存は無い。
import { createWebPushSettings } from './web-push.js?v=__ASSET_VERSION__'
import { serverDestination } from './server-origin.js?v=__ASSET_VERSION__'
import { readConversationMotion, conversationMotionKey } from './view-preferences.js?v=__ASSET_VERSION__'
import { guardEditorClose } from './editor-close.js?v=__ASSET_VERSION__'
import { createAvatarEditor } from './avatar-editor.js?v=__ASSET_VERSION__'
import { applyAvatar, initials, escapeClass, escapeHtml } from './view-format.js?v=__ASSET_VERSION__'
import { renderFeatureSettings, refreshFeatureSettingsStatus, featureFormsDirty, featureFormsSaving, featureState } from './onboarding.js?v=__ASSET_VERSION__'
import { renderHarnessAuth, authSummary } from './harness-auth.js?v=__ASSET_VERSION__'
import { aiControlView } from './ai-control.js?v=__ASSET_VERSION__'
import { createBackgroundAgentSettings } from './background-agent-settings.js?v=__ASSET_VERSION__'
import { createSettingsHome } from './settings-home.js?v=__ASSET_VERSION__'
import { runningExclusionsView } from './running-exclusions.js?v=__ASSET_VERSION__'
import { renderRules, ruleCount, parseRules } from './user-rules-view.js?v=__ASSET_VERSION__'

// 読めなかった時の一枚。平易な一文と、その場の「もう一度読み込む」。符号は閉じた「詳細」の中だけ。
function showFailure(node, lead, failure, retry) {
  const more = document.createElement('details'), summary = document.createElement('summary'), code = document.createElement('code')
  summary.textContent = '詳細'; code.textContent = failure?.message ?? ''
  more.append(summary, code)
  const parts = [Object.assign(document.createElement('span'), { textContent: `${lead}通信を確かめて、もう一度読み込んでください。` })]
  if (retry) {
    const again = Object.assign(document.createElement('button'), { type: 'button', textContent: 'もう一度読み込む', className: 'retry-button' })
    again.addEventListener('click', () => { node.textContent = ''; void retry() })
    parts.push(again)
  }
  node.replaceChildren(...parts, more)
}

const UPDATE_TONES = { ok: 'ok', accent: 'accent', danger: 'attention', info: 'info', muted: '' }
export function updateItem(summary) {
  if (!summary?.title) return { line: '確認しています', badge: '', tone: '' }
  const tone = UPDATE_TONES[summary.tone] ?? ''
  return { line: summary.title, badge: { ok: '最新', accent: '更新あり', attention: '要対応', info: '更新中' }[tone] ?? '', tone }
}
export function terminalsItem(result) {
  if (result === 'unsupported') return { line: '本体を更新すると使えます', badge: '', tone: '' }
  if (!Array.isArray(result)) return { line: '確認できません', badge: '確認できません', tone: 'attention' }
  if (!result.length) return { line: 'Mac・Windows・Linux', badge: '', tone: '' }
  const down = result.filter(item => item?.lastCheck?.reachable === false).length
  return down ? { line: `${result.length}台・${down}台つながりません`, badge: 'つながりません', tone: 'attention' } : { line: `${result.length}台`, badge: '', tone: '' }
}
export function featuresItem(settings) {
  const list = settings.filter(item => item.id !== 'onePassword')
  const bad = list.find(item => ['failed', 'missing'].includes(featureState(item).key))
  if (bad) return { line: `${bad.title}: ${featureState(bad).badge}`, badge: featureState(bad).badge, tone: 'attention' }
  const on = list.filter(item => featureState(item).key === 'on').length
  return { line: on ? `${on}つ使っています` : 'まだ使っていません', badge: '', tone: '' }
}
export function onePasswordItem(setting) {
  if (!setting) return { line: 'この本体では使えません', badge: '', tone: '' }
  if (setting.error) return { line: '連携できていません', badge: '失敗', tone: 'attention' }
  return setting.status === 'enabled' ? { line: '連携中', badge: '連携中', tone: 'ok' } : { line: '未連携', badge: '', tone: '' }
}

export function createOwnerEditor(dialog, { api, onOwner, onSettings, onOpenUpdates = () => {}, updateSummary = () => null, memberName = () => null }) {
  const find = id => dialog.querySelector(`#${id}`)
  const form = find('owner-form'), name = find('owner-name'), description = find('owner-description')
  const xUrl = find('owner-x-url'), githubUrl = find('owner-github-url'), ownerLinks = find('owner-links')
  const error = find('owner-form-error'), profileStatus = find('owner-form-status'), saveButton = find('owner-save')
  const rulesForm = find('rules-form'), rulesInput = find('user-rules'), rulesView = find('rules-view'), rulesEdit = find('rules-edit')
  const rulesError = find('rules-error'), rulesStatus = find('rules-status'), rulesSave = find('rules-save')
  let owner = null, saving = null, editRevision = 0, rulesRevision = 0, harnessAuthSection = null
  const home = createSettingsHome(dialog, { canLeave: page => !pageDirty(page) || confirm('入力した内容はまだ保存していません。ほかの項目へ移りますか？'), onShow: page => {
    if (page === 'updates') home.set('updates', updateItem(updateSummary()))
    if (page === 'exclusions') void exclusions.refresh()
  } })
  const webPush = createWebPushSettings(find('web-push-settings'), api, globalThis, { onChange: value => home.set('notifications', value) })
  const aiControl = aiControlView(find('ai-control'), api, { onChange: value => home.set('stop', value) })
  const exclusions = runningExclusionsView(find('running-exclusions'), api, { nameOf: memberName, onChange: value => home.set('exclusions', value) })
  const backgroundAgent = createBackgroundAgentSettings(find('background-agent-form'), api, { onChange: line => home.set('summary', { line }) })
  const avatar = createAvatarEditor({ onChange: () => { editRevision++ }, applyAvatar, initials, escapeClass,
    fileInput: find('owner-avatar-file'), preview: find('owner-avatar-preview'), cropEditor: find('owner-crop-editor'),
    canvas: find('owner-avatar-crop'), zoom: find('owner-avatar-zoom'), nameInput: name, fallback: 'O', error })
  const profileDirty = () => Boolean(owner && (editRevision !== owner.initialRevision || avatar.changed()))
  const rulesDirty = () => Boolean(owner && owner.rulesEditing && rulesRevision !== owner.rulesRevision)
  const featuresDirty = () => featureFormsDirty(find('feature-settings')) || featureFormsDirty(find('onepassword-settings'))
  const featuresSaving = () => featureFormsSaving(find('feature-settings')) || featureFormsSaving(find('onepassword-settings'))
  function pageDirty(page) {
    return page === 'profile' ? profileDirty() : page === 'rules' ? rulesDirty() : page === 'summary' ? backgroundAgent.dirty()
      : ['features', 'onePassword'].includes(page) ? featuresDirty() : false
  }
  guardEditorClose(dialog, () => Boolean(owner && (profileDirty() || rulesDirty() || backgroundAgent.dirty() || featuresDirty())), () => Boolean(owner && (saving === owner || backgroundAgent.busy() || featuresSaving())))

  find('conversation-motion').addEventListener('change', () => {
    try { localStorage.setItem(conversationMotionKey, find('conversation-motion').value); find('motion-status').textContent = 'このブラウザーに保存しました。会話を開き直すと反映します。' }
    catch { find('motion-status').textContent = 'このブラウザーに設定を保存できませんでした。' }
    paintDisplay()
  })
  find('server-open').addEventListener('click', () => {
    try {
      const destination = serverDestination(find('server-address').value)
      window.open(destination, '_blank', 'noopener,noreferrer')
      find('server-error').textContent = '別のサーバーを開きます。開かない場合はブラウザーのポップアップ設定を確認してください。'
    } catch { find('server-error').textContent = 'HTTPS、またはローカル接続のURLを入力してください。ユーザー名やパスワードは含めないでください。' }
  })
  find('updates-open').addEventListener('click', () => onOpenUpdates(find('updates-open')))
  find('auth-recheck').addEventListener('click', () => harnessAuthSection?.recheck())
  for (const button of dialog.querySelectorAll('[data-open-feature]')) button.addEventListener('click', () => openFeature(button.dataset.openFeature))
  function openFeature(id) {
    if (!home.show('features')) return
    const card = [...(find('feature-settings')?.querySelectorAll?.('[data-feature-id]') ?? [])].find(item => item.dataset.featureId === id)
    if (card) { card.open = true; card.scrollIntoView?.({ block: 'start' }) }
  }
  function paintDisplay() {
    const select = find('conversation-motion')
    home.set('display', { line: `会話は${select.selectedOptions?.[0]?.textContent ?? '下から浮き上がる'}` })
  }

  async function refreshAppleNotification() {
    const opened = owner
    if (!opened || !dialog.open) return
    const read = opened.notificationRead = (opened.notificationRead ?? 0) + 1
    const status = find('notification-status')
    status.textContent = '確かめています…'
    try {
      const result = await api('/api/notifications')
      if (owner !== opened || opened.notificationRead !== read) return
      if (typeof result.configured !== 'boolean' || !Array.isArray(result.environments)) throw Error('INVALID_NOTIFICATION_STATUS')
      status.textContent = result.error ? 'iPhoneアプリへの通知: エラーが起きています' : result.configured ? 'iPhoneアプリへの通知: 設定済み' : 'iPhoneアプリへの通知: 未設定'
      find('apple-notification-setup').hidden = result.configured && !result.error
    } catch { if (owner === opened && opened.notificationRead === read) status.textContent = 'iPhoneアプリへの通知: 確認できません' }
  }

  form.addEventListener('submit', save)
  form.addEventListener('input', () => { editRevision++; profileStatus.textContent = '' })
  form.addEventListener('change', () => { editRevision++ })
  find('add-owner-link').addEventListener('click', () => addOwnerLinkRow())
  rulesForm.addEventListener('submit', saveRules)
  rulesForm.addEventListener('input', () => { rulesRevision++; rulesStatus.textContent = '' })
  rulesEdit.addEventListener('click', () => setRulesEditing(true))
  find('rules-cancel').addEventListener('click', () => {
    if (rulesDirty() && !confirm('書き換えた内容を捨てますか？')) return
    rulesInput.value = owner?.rulesText ?? ''
    setRulesEditing(false)
  })
  function setRulesEditing(editing) {
    if (!owner) return
    owner.rulesEditing = editing
    owner.rulesRevision = rulesRevision
    rulesForm.hidden = !editing
    rulesView.hidden = editing
    rulesEdit.hidden = editing || !owner.rulesLoaded
    if (editing) rulesInput.focus?.()
  }
  function paintRules(text) {
    const parsed = renderRules(rulesView, text)
    const count = ruleCount(parsed)
    home.set('rules', { line: count ? `${count}個の決まり` : text.trim() ? '文章の決まり' : 'まだありません' })
  }

  function clearSettingSecrets() {
    for (const input of dialog.querySelectorAll('#feature-settings input[type="password"], #onepassword-settings input[type="password"]')) input.value = ''
  }
  dialog.addEventListener('close', () => {
    if (dialog.open) return
    owner = null
    webPush.close()
    backgroundAgent.close()
    clearSettingSecrets()
    avatar.cancelRead()
    harnessAuthSection?.stop()
    harnessAuthSection = null
  })
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearSettingSecrets()
    else if (dialog.open) { void aiControl.refresh(); void webPush.refresh() }
  })

  function paintFeatures(settings) {
    home.set('features', featuresItem(settings))
    home.set('onePassword', onePasswordItem(settings.find(item => item.id === 'onePassword')))
  }
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
    const cloudflare = session.authMode === 'cloudflare'
    find('access-logout').hidden = !cloudflare
    find('connection-mode').textContent = cloudflare ? 'Cloudflare Accessでログインしています。' : 'このサーバーにつながっています。'
    home.set('connection', { line: cloudflare ? 'Cloudflare Accessでログイン中' : 'このサーバー' })
    paintFeatures(settings)
    const onePassword = settings.filter(item => item.id === 'onePassword'), others = settings.filter(item => item.id !== 'onePassword')
    if (opened.featuresRendered) {
      refreshFeatureSettingsStatus(opened.features, settings)
      refreshFeatureSettingsStatus(opened.onePassword, settings)
      void webPush.refresh()
    } else {
      renderFeatureSettings(opened.features, others, { api, onChange: () => refreshFeatures(opened) })
      renderFeatureSettings(opened.onePassword, onePassword, { api, onChange: () => refreshFeatures(opened) })
      for (const card of opened.onePassword.children ?? []) card.open = true
      find('onepassword-empty').hidden = onePassword.length > 0
      opened.featuresRendered = true
    }
  }
  async function loadFeatures(opened) {
    try {
      find('feature-settings-error').textContent = ''
      await refreshFeatures(opened)
    } catch (failure) {
      if (opened !== owner) return
      showFailure(find('feature-settings-error'), '追加機能の状態を読み込めませんでした。', failure, () => loadFeatures(opened))
      home.set('features', { line: '確認できません', badge: '確認できません', tone: 'attention' })
      home.set('onePassword', { line: '確認できません', badge: '確認できません', tone: 'attention' })
    }
  }
  async function loadRules(opened) {
    rulesError.textContent = ''
    find('rules-load-error').textContent = ''
    rulesView.replaceChildren(Object.assign(document.createElement('p'), { className: 'settings-loading', textContent: '読み込んでいます…' }))
    try {
      const result = await api('/api/user-rules')
      if (opened !== owner) return
      opened.rulesText = result.text ?? ''
      if (!opened.rulesEditing) rulesInput.value = opened.rulesText
      opened.rulesLoaded = true
      rulesInput.disabled = false
      rulesSave.disabled = false
      rulesEdit.hidden = Boolean(opened.rulesEditing)
      paintRules(opened.rulesText)
    } catch (failure) {
      if (opened !== owner) return
      rulesView.replaceChildren()
      showFailure(find('rules-load-error'), 'チームの決まりを読み込めませんでした。', failure, () => loadRules(opened))
      home.set('rules', { line: '確認できません', badge: '確認できません', tone: 'attention' })
    }
  }
  async function loadAuth(opened) {
    try {
      find('harness-auth-error').textContent = ''
      home.set('ai', authSummary([]))
      const section = await renderHarnessAuth(opened.auth, { api, onSummary: list => { if (opened === owner) home.set('ai', authSummary(list)) } })
      if (opened !== owner) { section.stop(); return }
      harnessAuthSection = section
    } catch (failure) {
      if (opened !== owner) return
      showFailure(find('harness-auth-error'), 'AIの認証の状態を読み込めませんでした。', failure, () => loadAuth(opened))
      home.set('ai', { line: '確認できません', badge: '確認できません', tone: 'attention' })
    }
  }
  async function loadTerminals(opened) {
    let result
    try { result = (await api('/api/terminals')).terminals } catch (failure) { result = failure?.status === 404 || failure?.status === 405 ? 'unsupported' : null }
    if (opened === owner) home.set('terminals', terminalsItem(result))
  }

  async function open(profile) {
    if (!profile) return
    owner = { profile, rulesLoaded: false, rulesEditing: false, rulesText: '', featureRead: 0 }
    const opened = owner
    opened.features = document.createElement('div')
    opened.onePassword = document.createElement('div')
    opened.auth = document.createElement('div')
    find('feature-settings').replaceChildren(opened.features)
    find('onepassword-settings').replaceChildren(opened.onePassword)
    find('harness-auth').replaceChildren(opened.auth)
    harnessAuthSection?.stop()
    harnessAuthSection = null
    home.reset()
    home.set('profile', { line: profile.name })
    home.set('billing', { line: 'Web版は無料' })
    home.set('updates', updateItem(updateSummary()))
    void aiControl.refresh()
    void exclusions.refresh()
    void backgroundAgent.open()
    form.reset()
    find('conversation-motion').value = readConversationMotion()
    paintDisplay()
    find('motion-status').textContent = 'このブラウザーだけに使います。端末の「視覚効果を減らす」設定が優先です。'
    find('server-address').value = ''
    find('server-error').textContent = ''
    find('access-logout').hidden = true
    error.textContent = ''
    profileStatus.textContent = ''
    rulesStatus.textContent = ''
    rulesInput.value = ''
    rulesInput.disabled = true
    rulesSave.disabled = true
    setRulesEditing(false)
    name.value = profile.name
    description.value = profile.profile ?? ''
    xUrl.value = profile.xUrl ?? ''
    githubUrl.value = profile.githubUrl ?? ''
    renderOwnerLinkRows(profile.links ?? [])
    avatar.reset(profile.avatar)
    owner.initialRevision = editRevision
    // 電話は項目の列から、PCは最初の項目のページから始める。
    const phone = globalThis.matchMedia?.('(max-width: 780px)').matches
    if (phone) home.home(); else home.show('profile')
    if (!dialog.open) dialog.showModal()
    void refreshAppleNotification()
    void webPush.open()
    void loadTerminals(opened)
    // 項目ごとに別々に読む。ひとつが遅くても、ほかの項目は待たない。
    await Promise.all([loadRules(opened), loadFeatures(opened), loadAuth(opened)])
  }

  async function save(event) {
    event.preventDefault()
    if (!owner || saving === owner) return
    if (avatar.pending()) { error.textContent = '写真を読み込んでいます。表示を確認してから保存してください。'; return }
    const opened = owner, revision = editRevision
    const profile = {
      name: name.value.trim(), profile: description.value, avatar: avatar.value(), xUrl: xUrl.value.trim(), githubUrl: githubUrl.value.trim(),
      links: [...ownerLinks.querySelectorAll('.owner-link-row')].map(row => ({ label: row.querySelector('[data-owner-link-label]').value.trim(), url: row.querySelector('[data-owner-link-url]').value.trim() })),
    }
    saving = opened
    saveButton.disabled = true
    saveButton.textContent = '保存しています…'
    error.textContent = ''
    profileStatus.textContent = ''
    try {
      const result = await api('/api/owner', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(profile) })
      onOwner(result.owner)
      if (owner === opened) {
        home.set('profile', { line: result.owner?.name ?? profile.name })
        if (revision === editRevision) { opened.initialRevision = editRevision; avatar.reset?.(result.owner?.avatar ?? profile.avatar) }
        profileStatus.textContent = revision === editRevision ? '保存しました。' : '保存しました。あとから書いた内容は入力欄に残しています。'
      }
    } catch (failure) {
      if (owner === opened) error.textContent = /^[A-Z0-9_]+$/u.test(failure.message ?? '') ? '保存できませんでした。入力を確かめて、もう一度保存してください。' : `保存できませんでした。${failure.message}`
    } finally {
      if (saving === opened) saving = null
      if (owner === opened) { saveButton.disabled = false; saveButton.textContent = '保存' }
    }
  }
  async function saveRules(event) {
    event.preventDefault()
    if (!owner || !owner.rulesLoaded || saving === owner) return
    const opened = owner, revision = rulesRevision, text = rulesInput.value
    saving = opened
    rulesSave.disabled = true
    rulesSave.textContent = '保存しています…'
    rulesError.textContent = ''
    try {
      await api('/api/user-rules', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
      if (owner === opened) {
        opened.rulesText = text
        paintRules(text)
        if (revision === rulesRevision) { setRulesEditing(false); rulesStatus.textContent = '保存しました。' }
        else { opened.rulesRevision = revision; rulesStatus.textContent = '保存しました。あとから書いた内容は入力欄に残しています。' }
      }
    } catch (failure) {
      if (owner === opened) rulesError.textContent = /^[A-Z0-9_]+$/u.test(failure.message ?? '') ? '保存できませんでした。もう一度保存してください。書いた内容は残しています。' : `保存できませんでした。${failure.message}`
    } finally {
      if (saving === opened) saving = null
      if (owner === opened) { rulesSave.disabled = false; rulesSave.textContent = '保存' }
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

  return {
    open, show: id => home.show(id), refreshAI: () => aiControl.refresh(),
    refreshFeatureStatus(settings) {
      if (!dialog.open || !owner) return
      refreshFeatureSettingsStatus(owner.features, settings); refreshFeatureSettingsStatus(owner.onePassword, settings); paintFeatures(settings)
      void webPush.refresh(); void backgroundAgent.refresh(); harnessAuthSection?.refresh()
    },
    refreshUpdates() { if (dialog.open && owner) home.set('updates', updateItem(updateSummary())) },
    parseRules,
  }
}
