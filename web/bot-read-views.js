// Closed key set from the execution screen-input contract; labels are what the Owner sees.
const screenKeys = [['Escape', 'Esc'], ['Tab', 'Tab'], ['Up', '↑'], ['Down', '↓'], ['Left', '←'], ['Right', '→'], ['Enter', 'Enter']]
const digitKeys = [...'1234567890']
const keyNames = { Escape: 'Esc', Up: '↑', Down: '↓', Left: '←', Right: '→', 'C-c': '中断（Ctrl+C）' }
const inputErrors = {
  SCREEN_SEAT_ABSENT: '席が起動していません。次のメッセージで起動します。',
  SCREEN_INPUT_FAILED: '届いたか確認できませんでした。画面を見てから、必要ならもう一度押してください。',
  SCREEN_KEY_INVALID: 'このキーは送れません。',
  SCREEN_APPROVAL_INVALID: '確認への答えを送れませんでした。画面を見てから、もう一度選んでください。',
  SCREEN_APPROVAL_CHANGED: '確認の内容が変わりました。最新の内容を表示します。',
  SCREEN_APPROVAL_UNSUPPORTED: 'このAIの確認には、下のキーで答えてください。',
}
const unavailableError = error => error?.code === 'SCREEN_INPUT_UNAVAILABLE' || error?.status === 503
const approvalValue = value => value?.status === 'approval_required' && typeof value.promptDigest === 'string' && Array.isArray(value.choices)
  && value.choices.some(choice => ['approve_once', 'deny'].includes(choice?.decision) && typeof choice.label === 'string' && choice.label) ? value : null

export function createScreenView({ panel, status, text, header, api, input = null }) {
  let owner = null, timer = null, request = 0
  // Per opened panel: the latest approval read, a hidden bar after 503, the key being sent and the last message.
  let approval = null, unavailable = false, unsupported = false, busy = null, message = ''
  const make = (tag, className, value) => { const node = document.createElement(tag); node.className = className; if (value !== undefined) node.textContent = value; return node }
  const card = input && make('section', 'screen-approval'), keys = input && make('div', 'screen-keys'), note = input && make('p', 'screen-input-note')
  const keyButtons = []
  if (input) {
    note.setAttribute('role', 'status'); note.setAttribute('aria-live', 'polite')
    const addKey = (parent, key, label, className = 'screen-key') => {
      const button = make('button', className, label); button.type = 'button'; button.dataset.screenKey = key
      button.setAttribute('aria-label', `${keyNames[key] ?? key} キーを送る`)
      button.addEventListener('click', () => { void sendKey(key) }); parent.append(button); keyButtons.push(button)
    }
    // 中断 sits in its own group, away from Enter, so it is not hit by accident.
    const moves = make('div', 'screen-key-group screen-key-moves'), digits = make('div', 'screen-key-group screen-key-digits'), stop = make('div', 'screen-key-group screen-key-stop')
    for (const [key, label] of screenKeys) addKey(moves, key, label, key === 'Enter' ? 'screen-key screen-key-enter' : 'screen-key')
    for (const key of digitKeys) addKey(digits, key, key)
    addKey(stop, 'C-c', '中断', 'screen-key screen-key-interrupt')
    keys.append(moves, digits, stop)
    input.replaceChildren(card, keys, note)
  }
  function renderInput() {
    if (!input) return
    input.hidden = !owner || unavailable
    for (const button of keyButtons) button.disabled = Boolean(busy)
    note.textContent = message
    card.hidden = !approval
    card.replaceChildren()
    if (!approval) return
    const copy = make('div', 'screen-approval-copy')
    copy.append(make('strong', '', '確認を求めています'), make('span', '', '内容は上の画面で確かめてから答えてください。'))
    const actions = make('div', 'screen-approval-actions')
    for (const choice of approval.choices.filter(item => ['approve_once', 'deny'].includes(item?.decision))) {
      const button = make('button', choice.decision === 'approve_once' ? 'screen-approve' : 'screen-deny', choice.label); button.type = 'button'
      button.dataset.screenDecision = choice.decision; button.disabled = Boolean(busy)
      button.addEventListener('click', () => { void answer(choice.decision) }); actions.append(button)
    }
    card.append(copy, actions)
  }
  function fail(error) {
    if (unavailableError(error)) { unavailable = true; approval = null; message = ''; return }
    if (error?.code === 'SCREEN_APPROVAL_UNSUPPORTED') { unsupported = true; approval = null }
    message = inputErrors[error?.code] ?? '送れませんでした。画面を見てから、必要ならもう一度押してください。'
  }
  async function readApproval(bot) {
    if (!input || unavailable || unsupported) return
    try {
      const value = await api(`/api/bots/${bot.id}/screen/approval`)
      if (owner === bot) approval = approvalValue(value)
    } catch (error) { if (owner === bot) { approval = null; if (unavailableError(error)) unavailable = true } }
    if (owner === bot) renderInput()
  }
  // One tap is one request; errors are shown, never retried automatically.
  async function send(path, body, done) {
    if (!owner || busy) return
    const bot = owner
    busy = body.key ?? body.decision; message = ''; renderInput()
    try {
      await api(path(bot), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (owner === bot) done()
    } catch (error) { if (owner === bot) fail(error) }
    if (owner !== bot) return
    busy = null; renderInput(); void refresh()
  }
  const sendKey = key => send(bot => `/api/bots/${bot.id}/screen/key`, { key }, () => { message = `${keyNames[key] ?? key} を送りました` })
  const answer = decision => approval && send(bot => `/api/bots/${bot.id}/screen/approval`, { decision, promptDigest: approval.promptDigest },
    () => { approval = null; message = decision === 'approve_once' ? '今回だけ許可しました' : '拒否しました' })
  function close() {
    owner = null
    request++
    clearInterval(timer)
    timer = null
    panel.hidden = true
    approval = null; busy = null; message = ''
    renderInput()
  }
  async function refresh() {
    if (!owner) return
    const bot = owner, reading = ++request
    const asked = readApproval(bot)
    try {
      const result = await api(`/api/bots/${bot.id}/screen`)
      if (owner !== bot || reading !== request) return
      status.textContent = result.online ? `${bot.displayName} の画面 · 2秒ごとに更新` : `${bot.displayName} は停止中（次のメッセージで起動）`
      const stick = text.scrollHeight - text.scrollTop - text.clientHeight < 24
      text.textContent = result.screen.replace(/\s+$/u, '')
      fit(result.screen)
      if (stick) text.scrollTop = text.scrollHeight
    } catch { if (owner === bot && reading === request) status.textContent = '画面を読めませんでした' }
    await asked
  }
  async function open(bot) {
    close()
    owner = { ...bot }
    unavailable = false; unsupported = false
    const opened = owner
    panel.style.top = `${header.offsetHeight}px`
    panel.hidden = false
    renderInput()
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
