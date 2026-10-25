export function claimMessageSend(state, key, value, pendingImages = []) {
  const message = value.trim()
  if (state.sending.has(key) || (!message && !pendingImages.length)) return null
  state.sending.add(key)
  return { message, pendingImages: [...pendingImages] }
}

// Native input, restored drafts and line wrapping share the same measurement.
// Limit whole lines rather than a fixed pixel height that clips the last line.
export function installMessageInputSizing(input) {
  let measuredWidth = 0
  const resize = () => {
    if (input.clientWidth === 0) return
    const style = getComputedStyle(input)
    const line = parseFloat(style.lineHeight)
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)
    const previousScroll = input.scrollTop
    const typingAtEnd = document.activeElement === input && input.selectionEnd === input.value.length
    input.style.height = '0px'
    const content = input.scrollHeight + border
    const maximum = line * 5 + padding + border
    input.style.height = `${Math.min(Math.max(content, line + padding + border), maximum)}px`
    input.style.overflowY = content > maximum ? 'auto' : 'hidden'
    input.scrollTop = content <= maximum ? 0 : typingAtEnd ? input.scrollHeight : previousScroll
  }
  input.addEventListener('input', resize)
  const observer = new ResizeObserver(() => {
    const width = input.clientWidth
    if (width === measuredWidth) return
    measuredWidth = width
    resize()
  })
  observer.observe(input)
  document.fonts.ready.then(resize)
  resize()
  return resize
}

export function claimSingleFlight(inFlight, key) {
  if (inFlight.has(key)) return false
  inFlight.add(key)
  return true
}

export function releaseSingleFlight(inFlight, key) {
  inFlight.delete(key)
}

export async function readApiError(response) {
  try {
    const body = await response.json()
    return body.message || body.error || `HTTP_${response.status}`
  } catch {
    return `HTTP_${response.status}`
  }
}

// 送信が拒否された時に入力欄の上へ出す一行。本文は呼び出し側が入力欄へ戻す。
export function sendFailureText(code) {
  if (/^HTTP_5\d\d$/u.test(code)) return `送信できませんでした。サーバーが応答しませんでした（${code}）`
  return `送信できませんでした（${code}）`
}

export async function readApiResponse(response) {
  if (response.status === 204) return null
  return response.json()
}

// 本文をHTMLへ安全に変換し、http(s)のURLだけを別タブで開くリンクにする。
export function linkifyHtml(text = '') {
  const escape = value => String(value).replace(/[&<>'"]/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character])
  const parts = []
  const pattern = /https?:\/\/[^\s<>"'）」』】]+/gu
  let last = 0
  for (const match of String(text).matchAll(pattern)) {
    let url = match[0]
    let trailing = ''
    while (/[.,;:!?。、）)]$/u.test(url)) { trailing = url.at(-1) + trailing; url = url.slice(0, -1) }
    parts.push(escape(text.slice(last, match.index)))
    parts.push(`<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(url)}</a>${escape(trailing)}`)
    last = match.index + match[0].length
  }
  parts.push(escape(text.slice(last)))
  return parts.join('')
}
