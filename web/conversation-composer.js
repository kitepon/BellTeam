import { claimMessageSend, installMessageInputSizing, sendFailureText } from './chat-input.js?v=__ASSET_VERSION__'

// 他のアプリからのドロップ（a282）：文章・URL・画像を、共有の中身へ。画像以外のファイルは断る（forward.md「Files」）。
export function shareFromTransfer(transfer) {
  const files = [...(transfer?.files ?? [])]
  const images = files.filter(file => file.type?.startsWith('image/'))
  const valid = url => /^https?:\/\//iu.test(url) && url.length <= 2000
  const listed = (transfer?.getData?.('text/uri-list') ?? '').split(/\r?\n/u).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
  let text = (transfer?.getData?.('text/plain') ?? '').trim(), urls = listed.filter(valid)
  if (!urls.length && valid(text) && !/\s/u.test(text)) { urls = [text]; text = '' } // 文章が URL 一つだけ
  else if (text && urls.includes(text)) text = '' // リンクのドラッグは text/plain に同じ URL が入る
  return { text: text.slice(0, 20000), urls: [...new Set(urls)].slice(0, 20), images, refused: files.length > images.length }
}

// 開いている会話の面（panel）への、文章・URL・画像のドロップを共有にする。入力欄への貼り付けは今までどおり。
export function installShareDrop(panel, { enabled, composer }) {
  const transferable = event => [...(event.dataTransfer?.types ?? [])].some(type => ['Files', 'text/plain', 'text/uri-list'].includes(type))
  panel.addEventListener('dragover', event => { if (!enabled() || !transferable(event)) return; event.preventDefault(); panel.classList.add('is-dropping') })
  panel.addEventListener('dragleave', event => { if (!panel.contains(event.relatedTarget)) panel.classList.remove('is-dropping') })
  panel.addEventListener('drop', event => {
    panel.classList.remove('is-dropping')
    if (!enabled() || !transferable(event)) return
    event.preventDefault()
    const shared = shareFromTransfer(event.dataTransfer)
    if (shared.refused) composer.showError('画像以外のファイルは、まだ送れません。画像・文章・URLは共有できます。')
    if (!shared.text && !shared.urls.length && !shared.images.length) return
    composer.setShare({ ...(shared.text ? { text: shared.text } : {}), ...(shared.urls.length ? { urls: shared.urls } : {}) })
    if (shared.images.length) composer.addImages(shared.images)
  })
}

export function createConversationComposer({ input, attachments, error, sendButton, recovery,
  api, readImage, getTargets, setTargets, findTarget, onSelect, onAccepted, onSending = () => null, replyBar = null }) {
  const drafts = new Map()
  const sending = new Set()
  const retained = []
  const resize = installMessageInputSizing(input)
  let target = null
  const key = value => `${value.type}:${value.id}`
  const empty = () => ({ message: '', pendingImages: [], targets: null, error: '', reply: null, share: null })
  const draftFor = value => {
    if (!drafts.has(key(value))) drafts.set(key(value), empty())
    return drafts.get(key(value))
  }
  const hasInput = draft => Boolean(draft.message.trim() || draft.pendingImages.length || draft.share)
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
    paintReply(draft)
    update()
  }
  // 返信先（a269）：その会話の下書きが持つ。送ると下書きごと空になる。
  function paintReply(draft) {
    if (!replyBar) return
    replyBar.hidden = !(draft.reply || draft.share)
    if (!draft.reply && !draft.share) { replyBar.replaceChildren(); return }
    const label = document.createElement('strong')
    label.textContent = draft.share ? '共有する内容' : draft.reply.quote ? `${draft.reply.sender || '発言'}の一部への返信` : `${draft.reply.sender || '発言'}への返信`
    const text = document.createElement('span')
    text.textContent = draft.share ? shareSummary(draft.share, draft.pendingImages.length) : draft.reply.text
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.textContent = '×'
    cancel.setAttribute('aria-label', draft.share ? '共有をやめる' : '返信をやめる')
    cancel.addEventListener('click', () => { draft.reply = null; draft.share = null; paint(); input.focus?.() })
    replyBar.replaceChildren(label, text, cancel)
  }
  // 共有の中身を一行で。
  const shareSummary = (share, images) => [share.text?.split('\n')[0], share.urls?.length ? `${share.urls[0]}${share.urls.length > 1 ? ` ほか${share.urls.length - 1}件` : ''}` : '', images ? `画像${images}枚` : ''].filter(Boolean).join(' / ')
  // 共有は返信と一緒にしない（forward.md）：どちらか一つ。
  function setShare(share) {
    if (!target) return
    capture()
    const draft = draftFor(target)
    draft.share = share; draft.reply = null
    paint()
    input.focus?.()
  }
  function setReply(reply) {
    if (!target) return
    capture()
    draftFor(target).reply = reply; draftFor(target).share = null
    paint()
    input.focus?.()
  }
  const deleting = value => value?.type === 'bot' && (findTarget?.(value)?.deleting || findTarget?.(value)?.deletionRequested)
  function update() {
    capture()
    sendButton.disabled = !target || deleting(target) || sending.has(key(target)) || !hasInput(draftFor(target))
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
    if (deleting(target)) { showError(target, '削除操作の結果が未確認のため送信できません。入力は残しています。'); return }
    capture()
    const destination = { ...target }
    const current = draftFor(destination)
    // 共有の中身だけ（コメントも画像も無し）でも送れる。
    const claimed = claimMessageSend({ sending }, key(destination), current.message, current.pendingImages) ?? (current.share && !sending.has(key(destination)) ? (sending.add(key(destination)), { message: '', pendingImages: [] }) : null)
    if (!claimed) return
    const snapshot = { ...claimed, targets: current.targets ? [...current.targets] : null, error: '', reply: current.reply, share: current.share }
    drafts.set(key(destination), empty())
    paint()
    // The Owner's own bubble shows at once at the newest position (a471-open-newest-web); a failed send takes it back.
    const pending = onSending(destination, snapshot.message, snapshot.pendingImages.length)
    let images, result
    let issued = false
    try {
      images = await Promise.all(snapshot.pendingImages.map(item => readImage(item.file)))
      issued = true
      const kind = destination.type === 'room' ? 'rooms' : 'bots'
      result = await api(`/api/${kind}/${destination.id}/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: snapshot.message, images, ...(snapshot.targets ? { targets: snapshot.targets } : {}), ...(snapshot.share ? { share: snapshot.share } : {}), ...(snapshot.reply ? { reply_to: snapshot.reply.id, ...(snapshot.reply.quote ? { reply_quote: snapshot.reply.quote } : {}) } : {}) }),
      })
    } catch (cause) {
      pending?.remove()
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
    pending?.accept()
    try {
      await onAccepted(destination, result, images.map(image => `data:${image.mime};base64,${image.data}`))
    } catch {
      showError(destination, '送信を受け付けました。表示を更新できなかったので、会話を開き直してください。')
    }
  }
  input.addEventListener('input', update)
  return { select, clear: () => select(null), addImages, send, update, setReply, setShare,
    showError: message => { if (target) showError(target, message) } }
}
