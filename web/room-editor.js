import { createAvatarEditor } from './avatar-editor.js?v=__ASSET_VERSION__'
import { applyAvatar, initials, escapeClass, escapeHtml } from './view-format.js?v=__ASSET_VERSION__'

export function createRoomEditor(dialog, { api, getBots, onSaved, onDeleted }) {
  let owner = null, saving = null, editRevision = 0
  const roomForm = dialog.querySelector('#room-form')
  const roomDialogTitle = dialog.querySelector('#room-dialog-title')
  const roomName = dialog.querySelector('#room-name')
  const roomPurpose = dialog.querySelector('#room-purpose')
  const roomMembers = dialog.querySelector('#room-members')
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
  const avatar = createAvatarEditor({ applyAvatar, initials, escapeClass,
    fileInput: roomAvatarFile, preview: roomAvatarPreview, cropEditor: roomCropEditor,
    canvas: roomAvatarCrop, zoom: roomAvatarZoom, nameInput: roomName, fallback: 'R', error: roomFormError, previewClass: 'avatar room-avatar' })
  roomForm.addEventListener('submit', saveRoom)
  roomForm.addEventListener('input', () => { editRevision++ })
  roomForm.addEventListener('change', () => { editRevision++ })
  roomMembers.addEventListener('change', () => renderRoomRepresentativeOptions())
  deleteRoomButton.addEventListener('click', remove)
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
    roomMembers.replaceChildren(...getBots().map(bot => {
      const label = document.createElement('label')
      label.innerHTML = `<input type="checkbox" value="${escapeHtml(bot.id)}" ${room?.memberIds.includes(bot.id) ? 'checked' : ''}><span>${escapeHtml(bot.displayName)}</span>`
      return label
    }))
    renderRoomRepresentativeOptions(room?.representativeId ?? '')
    if (!dialog.open) dialog.showModal()
  }

  function renderRoomRepresentativeOptions(preferred = roomRepresentative.value) {
    const selectedIds = [...roomMembers.querySelectorAll('input:checked')].map(input => input.value)
    roomRepresentative.replaceChildren(new Option('代表なし', ''), ...selectedIds.map(id => {
      const bot = getBots().find(item => item.id === id)
      return new Option(bot?.displayName ?? id, id)
    }))
    roomRepresentative.value = selectedIds.includes(preferred) ? preferred : ''
  }

  async function saveRoom(event) {
    event.preventDefault()
    if (!owner || saving === owner) return
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
    } catch {
      if (owner === opened) roomFormError.textContent = accepted ? '保存しました。表示を更新できませんでした。' : '保存できませんでした。名前とメンバーを確認してね。'
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
