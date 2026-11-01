import { claimMessageSend, installMessageInputSizing, sendFailureText } from './chat-input.js?v=__ASSET_VERSION__'

export function createConversationComposer({ input, attachments, error, sendButton, recovery,
  api, readImage, getTargets, setTargets, findTarget, onSelect, onAccepted }) {
  const drafts = new Map()
  const sending = new Set()
  const retained = []
  const resize = installMessageInputSizing(input)
  let target = null
  const key = value => `${value.type}:${value.id}`
  const empty = () => ({ message: '', pendingImages: [], targets: null, error: '' })
  const draftFor = value => {
    if (!drafts.has(key(value))) drafts.set(key(value), empty())
    return drafts.get(key(value))
  }
  const hasInput = draft => Boolean(draft.message.trim() || draft.pendingImages.length)
  const selected = value => target && key(target) === key(value)
  const release = draft => { for (const image of draft.pendingImages) URL.revokeObjectURL(image.url) }
  function capture() {
    if (!target) return
    const draft = draftFor(target)
    draft.message = input.value
    draft.targets = getTargets(target)
  }
  function showError(value, message) {
    draftFor(value).error = message
    if (selected(value)) { error.textContent = message; error.hidden = !message }
  }
  function paint() {
    const draft = target ? draftFor(target) : empty()
    input.value = draft.message
    resize()
    error.textContent = draft.error
    error.hidden = !draft.error
    attachments.replaceChildren(...draft.pendingImages.map((item, index) => {
      const preview = document.createElement('div')
      preview.className = 'attachment-preview'
      const image = document.createElement('img')
      image.src = item.url
      image.alt = `添付画像${index + 1}`
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.textContent = '×'
      remove.setAttribute('aria-label', `添付画像${index + 1}を外す`)
      remove.addEventListener('click', () => {
        URL.revokeObjectURL(item.url)
        draft.pendingImages = draft.pendingImages.filter(value => value !== item)
        paint()
      })
      preview.append(image, remove)
      return preview
    }))
    attachments.hidden = !draft.pendingImages.length
    update()
  }
  function update() {
    capture()
    sendButton.disabled = !target || sending.has(key(target)) || !hasInput(draftFor(target))
    renderRecovery()
  }
  function select(value) {
    capture()
    target = value ? { type: value.type, id: value.id, name: value.name } : null
    if (target) setTargets(target, draftFor(target).targets)
    paint()
  }
  function addImages(files) {
    if (!target) return
    capture()
    const images = files.filter(file => ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type))
    draftFor(target).pendingImages.push(...images.map(file => ({ file, url: URL.createObjectURL(file) })))
    paint()
  }
  function renderRecovery() {
    recovery.hidden = !retained.length
    const summary = document.createElement('summary')
    summary.textContent = `保持した入力（${retained.length}）`
    recovery.replaceChildren(summary, ...retained.map(entry => {
      const row = document.createElement('section')
      const title = document.createElement('strong')
      title.textContent = entry.target.name
      const text = document.createElement('textarea')
      text.readOnly = true
      text.value = entry.draft.message
      text.setAttribute('aria-label', `${entry.target.name}の保持した入力`)
      const reason = document.createElement('p')
      reason.textContent = entry.draft.error
      const restore = document.createElement('button')
      restore.type = 'button'
      restore.textContent = '入力欄に戻す'
      restore.disabled = !findTarget(entry.target)
      restore.addEventListener('click', () => {
        capture()
        if (!findTarget(entry.target)) return
        if (hasInput(draftFor(entry.target))) {
          reason.textContent = 'この会話の入力を先に送信するか、取り除いてください。'
          return
        }
        drafts.set(key(entry.target), entry.draft)
        retained.splice(retained.indexOf(entry), 1)
        if (selected(entry.target)) { setTargets(target, entry.draft.targets); paint() }
        Promise.resolve(onSelect(entry.target)).catch(() => showError(entry.target, '入力は保持しています。会話を開き直してください。'))
        renderRecovery()
      })
      const discard = document.createElement('button')
      discard.type = 'button'
      discard.textContent = '破棄'
      discard.addEventListener('click', () => {
        release(entry.draft)
        retained.splice(retained.indexOf(entry), 1)
        renderRecovery()
      })
      row.append(title, text)
      for (const item of entry.draft.pendingImages) {
        const image = document.createElement('img')
        image.src = item.url
        image.alt = '保持した添付画像'
        row.append(image)
      }
      row.append(reason, restore, discard)
      return row
    }))
  }
  async function send() {
    if (!target) return
    capture()
    const destination = { ...target }
    const current = draftFor(destination)
    const claimed = claimMessageSend({ sending }, key(destination), current.message, current.pendingImages)
    if (!claimed) return
    const snapshot = { ...claimed, targets: current.targets ? [...current.targets] : null, error: '' }
    drafts.set(key(destination), empty())
    paint()
    let images, result
    let issued = false
    try {
      images = await Promise.all(snapshot.pendingImages.map(item => readImage(item.file)))
      issued = true
      const kind = destination.type === 'room' ? 'rooms' : 'bots'
      result = await api(`/api/${kind}/${destination.id}/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: snapshot.message, images, ...(snapshot.targets ? { targets: snapshot.targets } : {}) }),
      })
    } catch (cause) {
      capture()
      snapshot.error = issued && !cause.status
        ? '送信結果を確認できませんでした。再送する前に会話を確認してください。'
        : sendFailureText(cause.message)
      if (hasInput(draftFor(destination)) || !findTarget(destination)) retained.push({ target: destination, draft: snapshot })
      else drafts.set(key(destination), snapshot)
      if (selected(destination)) { setTargets(target, draftFor(target).targets); paint() }
      return
    } finally {
      sending.delete(key(destination))
      update()
    }
    release(snapshot)
    try {
      await onAccepted(destination, result, images.map(image => `data:${image.mime};base64,${image.data}`))
    } catch {
      showError(destination, '送信を受け付けました。表示を更新できなかったので、会話を開き直してください。')
    }
  }
  input.addEventListener('input', update)
  return { select, clear: () => select(null), addImages, send, update,
    showError: message => { if (target) showError(target, message) } }
}
