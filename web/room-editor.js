import { matchesMemberQuery } from './roster-search.js?v=__ASSET_VERSION__'
import { guardEditorClose } from './editor-close.js?v=__ASSET_VERSION__'
import { createAvatarEditor } from './avatar-editor.js?v=__ASSET_VERSION__'
import { applyAvatar, initials, escapeClass, escapeHtml } from './view-format.js?v=__ASSET_VERSION__'

const roomReasons = {
  ROOM_NAME_INVALID: 'ルーム名を入れてください（100文字まで）。',
  ROOM_PURPOSE_INVALID: '目的が長すぎます（8000文字まで）。',
  ROOM_MEMBERS_INVALID: 'いないメンバーが含まれています。一覧を読み込み直してから選び直してください。',
  ROOM_REPRESENTATIVE_INVALID: '代表は参加メンバーから選んでください。',
}
export const roomSaveError = error => roomReasons[error?.code] ?? roomReasons[error?.message] ?? '保存できませんでした。通信を確かめて、もう一度保存してください。'

export function createRoomEditor(dialog, { api, getBots, onSaved, onDeleted }) {
  let owner = null, saving = null, editRevision = 0
  const roomForm = dialog.querySelector('#room-form')
  const roomDialogTitle = dialog.querySelector('#room-dialog-title')
  const roomName = dialog.querySelector('#room-name')
  const roomPurpose = dialog.querySelector('#room-purpose')
  const memberSearch = dialog.querySelector('#room-member-search')
  const memberCount = dialog.querySelector('#room-member-count')
  const roomMembers = dialog.querySelector('#room-members')
  const memberChips = dialog.querySelector('#room-member-chips')
  const roomRepresentative = dialog.querySelector('#room-representative')
  const roomFormError = dialog.querySelector('#room-form-error')
  const roomAvatarFile = dialog.querySelector('#room-avatar-file')
  const roomAvatarPreview = dialog.querySelector('#room-avatar-preview')
  const roomCropEditor = dialog.querySelector('#room-crop-editor')
  const roomAvatarCrop = dialog.querySelector('#room-avatar-crop')
  const roomAvatarZoom = dialog.querySelector('#room-avatar-zoom')
  const deleteRoomButton = dialog.querySelector('#delete-room-button')
  const roomManagementActions = dialog.querySelector('#room-management-actions')
  const roomSubmit = roomForm.querySelector('button[type="submit"]')
  const avatar = createAvatarEditor({ onChange: () => { editRevision++ }, applyAvatar, initials, escapeClass,
    fileInput: roomAvatarFile, preview: roomAvatarPreview, cropEditor: roomCropEditor,
    canvas: roomAvatarCrop, zoom: roomAvatarZoom, nameInput: roomName, fallback: 'R', error: roomFormError, previewClass: 'avatar room-avatar' })
  roomForm.addEventListener('submit', saveRoom)
  roomForm.addEventListener('input', event => { if (event?.target !== memberSearch) editRevision++ })
  roomForm.addEventListener('change', event => { if (event?.target !== memberSearch) editRevision++ })
  roomMembers.addEventListener('change', () => { renderRoomRepresentativeOptions(); renderChips() })
  deleteRoomButton.addEventListener('click', remove)
  memberSearch.addEventListener('input', filterMembers)
  guardEditorClose(dialog, () => Boolean(owner && (editRevision !== owner.initialRevision || avatar.changed())), () => Boolean(owner && saving === owner))
  dialog.addEventListener('close', () => { if (!dialog.open) { owner = null; avatar.cancelRead() } })
  function open(room = null) {
    owner = { room }
    roomSubmit.disabled = false
    deleteRoomButton.disabled = false
    roomForm.reset()
    roomFormError.textContent = ''
    roomDialogTitle.textContent = room ? 'ルームを編集' : 'ルームを作る'
    roomManagementActions.hidden = !room
    roomName.value = room?.name ?? ''
    roomPurpose.value = room?.purpose ?? ''
    avatar.reset(room?.avatar ?? '')
    memberSearch.value = ''
    // W78: name once (role small beside it), a check like the 返信する人 picker.
    roomMembers.replaceChildren(...getBots().map(bot => {
      const label = document.createElement('label')
      label.className = 'target-row'
      label.dataset.memberId = bot.id
      label.innerHTML = `<input type="checkbox" value="${escapeHtml(bot.id)}" ${room?.memberIds.includes(bot.id) ? 'checked' : ''}><span>${escapeHtml(bot.name ?? bot.displayName)}${bot.position ? `<small>${escapeHtml(bot.position)}</small>` : ''}</span><i class="target-check"></i>`
      return label
    }))
    renderRoomRepresentativeOptions(room?.representativeId ?? '')
    renderChips()
    filterMembers()
    owner.initialRevision = editRevision
    if (!dialog.open) dialog.showModal()
  }

  // W78: without a search only the first 30 unchosen members are listed; chosen ones are the chips above.
  const LIST_LIMIT = 30
  function filterMembers() {
    const query = memberSearch.value.trim()
    let shown = 0, matching = 0
    for (const label of roomMembers.children) {
      const bot = getBots().find(item => item.id === label.dataset.memberId)
      const match = Boolean(bot) && matchesMemberQuery(bot, query)
      if (match) matching++
      label.hidden = !match || (!query && shown >= LIST_LIMIT)
      if (!label.hidden) shown++
    }
    const chosen = roomMembers.querySelectorAll('input:checked').length
    memberCount.textContent = `${chosen}人を選択中` + (shown < matching ? ` · ${matching}人のうち${shown}人を表示。名前で探すと絞り込めます。` : '')
  }

  function renderChips() {
    memberChips.replaceChildren(...[...roomMembers.querySelectorAll('input:checked')].map(input => {
      const bot = getBots().find(item => item.id === input.value)
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'member-chip'
      chip.setAttribute('aria-label', `${bot?.name ?? input.value}を外す`)
      chip.innerHTML = `<span class="mini-face ${escapeClass(bot?.color)}">${escapeHtml((bot?.name ?? '?').slice(0, 1))}</span>${escapeHtml(bot?.name ?? input.value)}<i aria-hidden="true">×</i>`
      if (bot) applyAvatar(chip.querySelector('.mini-face'), bot)
      chip.addEventListener('click', () => { input.checked = false; editRevision++; renderRoomRepresentativeOptions(); renderChips() })
      return chip
    }))
  }

  function renderRoomRepresentativeOptions(preferred = roomRepresentative.value) {
    const selectedIds = [...roomMembers.querySelectorAll('input:checked')].map(input => input.value)
    roomRepresentative.replaceChildren(new Option('代表なし', ''), ...selectedIds.map(id => {
      const bot = getBots().find(item => item.id === id)
      return new Option(bot?.name ?? bot?.displayName ?? id, id)
    }))
    roomRepresentative.value = selectedIds.includes(preferred) ? preferred : ''
    filterMembers()
  }

  async function saveRoom(event) {
    event.preventDefault()
    if (!owner || saving === owner) return
    if (avatar.pending()) { roomFormError.textContent = '写真を読み込んでいます。表示を確認してから保存してください。'; return }
    const opened = owner, revision = editRevision
    const current = () => owner === opened && revision === editRevision
    saving = opened
    roomSubmit.disabled = true
    roomFormError.textContent = ''
    const body = {
      name: roomName.value.trim(), purpose: roomPurpose.value,
      memberIds: [...roomMembers.querySelectorAll('input:checked')].map(input => input.value),
      representativeId: roomRepresentative.value || null, avatar: avatar.value(),
    }
    let accepted = false
    try {
      const result = opened.room
        ? await api(`/api/rooms/${opened.room.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        : await api('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      accepted = true
      opened.room = result.room
      await onSaved(result.room, current)
      if (current()) dialog.close()
    } catch (error) {
      // W79: the server's reason in plain words, next to 保存.
      if (owner === opened) roomFormError.textContent = accepted ? '保存しました。表示を更新できませんでした。' : roomSaveError(error)
    } finally {
      if (saving === opened) saving = null
      if (owner === opened) roomSubmit.disabled = false
    }
  }
  async function remove() {
    const opened = owner, room = opened?.room
    if (!room || deleteRoomButton.disabled || !window.confirm(`${room.name}を削除しますか？\n会話履歴と予定も削除されます。`)) return
    deleteRoomButton.disabled = true
    let accepted = false
    try {
      await api(`/api/rooms/${room.id}`, { method: 'DELETE' })
      accepted = true
      await onDeleted(room)
      if (owner === opened) dialog.close()
    } catch { if (owner === opened) roomFormError.textContent = accepted ? '削除しました。表示を更新できませんでした。' : '削除できませんでした。' }
    finally { if (owner === opened) deleteRoomButton.disabled = false }
  }

  return { open }
}
