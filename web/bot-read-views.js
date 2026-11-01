export function createScreenView({ panel, status, text, header, api }) {
  let owner = null, timer = null, request = 0
  function close() {
    owner = null
    request++
    clearInterval(timer)
    timer = null
    panel.hidden = true
  }
  async function refresh() {
    if (!owner) return
    const bot = owner, reading = ++request
    try {
      const result = await api(`/api/bots/${bot.id}/screen`)
      if (owner !== bot || reading !== request) return
      status.textContent = result.online ? `${bot.displayName} の画面 · 2秒ごとに更新` : `${bot.displayName} は停止中（次のメッセージで起動）`
      const stick = text.scrollHeight - text.scrollTop - text.clientHeight < 24
      text.textContent = result.screen.replace(/\s+$/u, '')
      fit(result.screen)
      if (stick) text.scrollTop = text.scrollHeight
    } catch { if (owner === bot && reading === request) status.textContent = '画面を読めませんでした' }
  }
  async function open(bot) {
    close()
    owner = { ...bot }
    const opened = owner
    panel.style.top = `${header.offsetHeight}px`
    panel.hidden = false
    await refresh()
    if (owner === opened) timer = setInterval(() => { void refresh() }, 2000)
  }
  // The native screen has 80 columns; measure wide glyphs before fitting the panel.
  function fit(screen) {
    const columns = Math.min(80, Math.max(40, ...screen.split('\n').map(line => [...line].reduce((n, c) => n + (/[\u3000-\u9fff\uff00-\uffef]/u.test(c) ? 2 : 1), 0))))
    const probe = document.createElement('span')
    probe.textContent = '0'.repeat(columns)
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:12px/1 ui-monospace,SFMono-Regular,Menlo,monospace'
    document.body.append(probe)
    const width = probe.getBoundingClientRect().width
    probe.remove()
    const available = text.clientWidth - 28
    if (width > 0 && available > 0) text.style.fontSize = `${Math.min(12, 12 * available / width).toFixed(2)}px`
  }
  window.addEventListener('resize', () => { if (!panel.hidden) fit(text.textContent) })
  return { open, close }
}

export function createCharacterSheetView(dialog, list, { api, fetchImage = fetch }) {
  let owner = null
  const urls = new Set()
  function release() { for (const url of urls) URL.revokeObjectURL(url); urls.clear() }
  dialog.addEventListener('close', () => { if (!dialog.open) { owner = null; release() } })
  async function open(bot) {
    owner = { ...bot }
    const opened = owner
    release()
    list.replaceChildren()
    if (!dialog.open) dialog.showModal()
    try {
      const { sheets } = await api(`/api/bots/${bot.id}/character-sheet`)
      if (owner !== opened) return
      if (!sheets.length) {
        const empty = document.createElement('p')
        empty.className = 'character-sheet-note'
        empty.textContent = 'まだ置かれていない。'
        list.replaceChildren(empty)
      }
      for (const sheet of sheets) {
        if (owner !== opened) return
        const figure = document.createElement('figure'), image = document.createElement('img'), caption = document.createElement('figcaption')
        image.alt = sheet.file
        caption.textContent = `${sheet.file}（${new Date(sheet.updatedAt).toLocaleString('ja-JP')}）`
        figure.append(image, caption)
        list.append(figure)
        const response = await fetchImage(sheet.url)
        if (!response.ok) throw new Error(`HTTP_${response.status}`)
        const blob = await response.blob()
        if (owner !== opened) return
        const url = URL.createObjectURL(blob)
        urls.add(url)
        image.src = url
      }
    } catch (error) {
      if (owner !== opened) return
      release()
      list.replaceChildren()
      const failed = document.createElement('p')
      failed.className = 'form-error'
      failed.textContent = `キャラクターシートを読めませんでした（${error.message}）`
      list.append(failed)
    }
  }
  return { open }
}
