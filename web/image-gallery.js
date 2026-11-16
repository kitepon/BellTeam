// 2枚以上の画像は重ねたカードで枚数を見せ、押すと全画面の表示で1枚ずつ選んで見られるようにする。

const STACK_LAYERS = 3

// 一覧の端で止めずに一周させる。
export function stepIndex(index, delta, count) {
  if (count <= 0) return 0
  return ((index + delta) % count + count) % count
}

// 重ねて見せるのは先頭から最大3枚。配列は奥から手前の順に並べる。
export function stackLayers(urls) {
  return urls.slice(0, STACK_LAYERS).map((url, depth) => ({ url, depth })).reverse()
}

export function renderImageStack(urls, { alt, onOpen }) {
  const wrapper = document.createElement('div')
  wrapper.className = 'image-stack-wrapper'
  const stack = document.createElement('button')
  stack.type = 'button'
  stack.className = 'image-stack'
  stack.setAttribute('aria-label', `画像${urls.length}枚を開く`)
  for (const { url, depth } of stackLayers(urls)) {
    const card = document.createElement('span')
    card.className = 'image-stack-card'
    card.dataset.depth = String(depth)
    const image = document.createElement('img')
    image.src = url
    image.alt = depth === 0 ? alt : ''
    image.loading = 'lazy'
    card.append(image)
    stack.append(card)
  }
  stack.addEventListener('click', () => onOpen(0))
  const count = document.createElement('span')
  count.className = 'image-stack-count'
  count.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M8 2.5v11"/></svg>'
  count.append(`画像${urls.length}枚`)
  wrapper.append(stack, count)
  return wrapper
}

// ---- zoom / pan / share の純関数（a276）。view = {scale, x, y}：x,y は画像の中心からのずれ（px）。
const MIN_SCALE = 1, MAX_SCALE = 8
const clampScale = value => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))
// 画像が舞台より小さい間は中央に置き、大きい分だけ動かせる。
export function clampView(view, size) {
  const scale = clampScale(view.scale)
  const limit = (image, stage) => Math.max(0, (image * scale - stage) / 2)
  const [lx, ly] = [limit(size.width, size.stageWidth), limit(size.height, size.stageHeight)]
  return { scale, x: Math.min(lx, Math.max(-lx, view.x)) + 0, y: Math.min(ly, Math.max(-ly, view.y)) + 0 } // + 0: no -0
}
// 指（または印）の下の点を動かさずに拡大・縮小する。point は画像の中心からの位置。
export function zoomAt(view, scale, point) {
  const next = clampScale(scale), ratio = next / view.scale
  return { scale: next, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio }
}
// 2本指：間隔の比で拡大し、中心の動きだけ動かす。
export function pinchView(start, now) {
  const zoomed = zoomAt(start.view, start.view.scale * now.distance / start.distance, start.center)
  return { ...zoomed, x: zoomed.x + now.center.x - start.center.x, y: zoomed.y + now.center.y - start.center.y }
}
// 保存名は URL の最後の区間（契約：ASCII の {id}.{ext}）。blob: / data: には名前が無い。
export function fileNameOf(url) {
  const path = String(url ?? '').split(/[?#]/u)[0]
  if (/^(blob|data):/u.test(path)) return ''
  try { return decodeURIComponent(path.split('/').pop() ?? '') } catch { return '' }
}
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
// 名前に拡張子が無ければ、画像の種類から付ける。
export function nameWithType(name, type) {
  const base = name || 'image'
  return /\.[A-Za-z0-9]{2,5}$/u.test(base) || !EXTENSIONS[type] ? base : `${base}.${EXTENSIONS[type]}`
}
// 共有できるならOSの共有、できなければ画像のコピー、どちらも無ければ出さない。
export function shareKind(nav = globalThis.navigator, ClipboardItemType = globalThis.ClipboardItem) {
  try {
    if (typeof nav?.share === 'function' && typeof nav.canShare === 'function' && nav.canShare({ files: [new File([''], 'image.png', { type: 'image/png' })] })) return 'share'
  } catch { /* canShare が無い・拒む */ }
  return typeof nav?.clipboard?.write === 'function' && ClipboardItemType ? 'copy' : null
}
async function pngOf(blob) {
  if (blob.type === 'image/png') return blob
  const bitmap = await createImageBitmap(blob), canvas = document.createElement('canvas')
  canvas.width = bitmap.width; canvas.height = bitmap.height
  canvas.getContext('2d').drawImage(bitmap, 0, 0)
  return new Promise((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('PNG_FAILED')), 'image/png'))
}

let viewer = null

const ICONS = {
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14"/>',
  share: '<path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M5 13v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
  prev: '<path d="M15 5l-7 7 7 7"/>', next: '<path d="M9 5l7 7-7 7"/>',
}
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`

function buildViewer() {
  const dialog = document.createElement('dialog')
  dialog.className = 'image-viewer'
  dialog.setAttribute('aria-label', '画像')
  dialog.innerHTML = `
    <header class="image-viewer-bar">
      <button class="image-viewer-round" type="button" data-viewer="close" aria-label="閉じる">${icon('close')}</button>
      <span class="image-viewer-counter" data-viewer="counter"></span>
      <span class="image-viewer-tools">
        <button class="image-viewer-round" type="button" data-viewer="zoom-out" aria-label="縮小">${icon('minus')}</button>
        <button class="image-viewer-round" type="button" data-viewer="zoom-in" aria-label="拡大">${icon('plus')}</button>
        <a class="image-viewer-pill" data-viewer="download" aria-label="ダウンロード">${icon('download')}<span>ダウンロード</span></a>
        <button class="image-viewer-pill" type="button" data-viewer="share" aria-label="共有" hidden></button>
      </span>
    </header>
    <p class="image-viewer-note" data-viewer="note" role="status" hidden></p>
    <div class="image-viewer-stage" data-viewer="stage">
      <button class="image-viewer-step" type="button" data-viewer="prev" aria-label="前の画像">${icon('prev')}</button>
      <img class="image-viewer-image" data-viewer="image" alt="" draggable="false">
      <button class="image-viewer-step" type="button" data-viewer="next" aria-label="次の画像">${icon('next')}</button>
    </div>
    <div class="image-viewer-thumbs" data-viewer="thumbs"></div>`
  const part = name => dialog.querySelector(`[data-viewer="${name}"]`)
  const state = { urls: [], names: [], index: 0, alt: '', view: { scale: 1, x: 0, y: 0 }, kind: null }
  let noteTimer = null
  const note = text => {
    part('note').textContent = text; part('note').hidden = !text
    clearTimeout(noteTimer)
    if (text) noteTimer = setTimeout(() => { part('note').hidden = true }, 2000)
  }
  const size = () => ({ width: part('image').offsetWidth, height: part('image').offsetHeight, stageWidth: part('stage').clientWidth, stageHeight: part('stage').clientHeight })
  const apply = view => {
    state.view = clampView(view, size())
    part('image').style.transform = `translate(${state.view.x}px, ${state.view.y}px) scale(${state.view.scale})`
    dialog.classList.toggle('zoomed', state.view.scale > 1)
  }
  // 画像の中心（拡大前の位置）からの座標へ。
  const centreOf = () => { const box = part('stage').getBoundingClientRect(), image = part('image'); return { x: box.left + image.offsetLeft + image.offsetWidth / 2, y: box.top + image.offsetTop + image.offsetHeight / 2 } }
  const pointOf = event => { const centre = centreOf(); return { x: event.clientX - centre.x, y: event.clientY - centre.y } }
  const zoomBy = (factor, point = { x: 0, y: 0 }) => apply(zoomAt(state.view, state.view.scale * factor, point))
  const show = index => {
    state.index = stepIndex(index, 0, state.urls.length)
    const url = state.urls[state.index]
    part('image').src = url
    part('image').alt = `${state.alt}（${state.index + 1}/${state.urls.length}）`
    part('download').href = url
    part('download').download = nameWithType(state.names[state.index], '')
    if (!state.names[state.index]) void fetch(url).then(response => response.blob()).then(blob => { if (state.urls[state.index] === url) part('download').download = nameWithType('', blob.type) }).catch(() => {})
    part('counter').textContent = state.urls.length > 1 ? `${state.index + 1} / ${state.urls.length}` : ''
    part('thumbs').querySelectorAll('button').forEach((thumb, position) => thumb.setAttribute('aria-current', String(position === state.index)))
    part('thumbs').children[state.index]?.scrollIntoView({ block: 'nearest', inline: 'center' })
    note('')
    apply({ scale: 1, x: 0, y: 0 })
  }
  part('close').addEventListener('click', () => dialog.close())
  part('prev').addEventListener('click', () => show(stepIndex(state.index, -1, state.urls.length)))
  part('next').addEventListener('click', () => show(stepIndex(state.index, 1, state.urls.length)))
  part('zoom-in').addEventListener('click', () => zoomBy(1.5))
  part('zoom-out').addEventListener('click', () => zoomBy(1 / 1.5))
  part('share').addEventListener('click', () => {
    const url = state.urls[state.index], kind = state.kind, name = nameWithType(state.names[state.index], '')
    const bytes = fetch(url).then(response => response.blob())
    const done = kind === 'share'
      ? bytes.then(blob => navigator.share({ files: [new File([blob], nameWithType(name, blob.type), { type: blob.type })] })).then(() => note('共有しました'))
      : navigator.clipboard.write([new ClipboardItem({ 'image/png': bytes.then(pngOf) })]).then(() => note('コピーしました'))
    done.catch(error => { if (error?.name !== 'AbortError') note(kind === 'share' ? '共有できませんでした' : 'コピーできませんでした') })
  })
  dialog.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft') show(stepIndex(state.index, -1, state.urls.length))
    if (event.key === 'ArrowRight') show(stepIndex(state.index, 1, state.urls.length))
    if (event.key === '+' || event.key === '=') zoomBy(1.5)
    if (event.key === '-') zoomBy(1 / 1.5)
    if (event.key === '0') apply({ scale: 1, x: 0, y: 0 })
  })
  // 拡大：ホイール（ctrl+ホイールは細かく）。触る：2本指 / ダブルタップ。拡大中は1本指でドラッグして動かし、等倍の時だけ横に払って前後へ。
  const stage = part('stage')
  stage.addEventListener('wheel', event => { event.preventDefault(); zoomBy(Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015)), pointOf(event)) }, { passive: false })
  const pointers = new Map()
  let gesture = null, lastTap = null
  const distance = () => { const [a, b] = [...pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y) }
  const middle = () => { const [a, b] = [...pointers.values()], c = centreOf(); return { x: (a.x + b.x) / 2 - c.x, y: (a.y + b.y) / 2 - c.y } }
  stage.addEventListener('pointerdown', event => {
    if (event.target !== stage && event.target !== part('image')) return // 前後の矢印などは、それ自身の操作
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.size === 2) gesture = { kind: 'pinch', start: { view: state.view, distance: distance() || 1, center: middle() } }
    else if (pointers.size === 1) gesture = { kind: 'drag', x: event.clientX, y: event.clientY, view: state.view, target: event.target, moved: false }
  })
  stage.addEventListener('pointermove', event => {
    if (!pointers.has(event.pointerId)) return
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (gesture?.kind === 'pinch' && pointers.size === 2) apply(pinchView(gesture.start, { distance: distance() || 1, center: middle() }))
    else if (gesture?.kind === 'drag' && pointers.size === 1) {
      const [dx, dy] = [event.clientX - gesture.x, event.clientY - gesture.y]
      if (Math.hypot(dx, dy) > 5) gesture.moved = true
      if (state.view.scale > 1) apply({ ...gesture.view, x: gesture.view.x + dx, y: gesture.view.y + dy })
    }
  })
  const release = event => {
    if (!pointers.delete(event.pointerId)) return
    const ended = gesture
    if (pointers.size === 0) gesture = null
    else if (ended?.kind === 'pinch') gesture = null
    if (event.type === 'pointercancel' || ended?.kind !== 'drag') return
    const dx = event.clientX - ended.x
    if (ended.moved) { if (state.view.scale === 1 && Math.abs(dx) > 50) show(stepIndex(state.index, dx < 0 ? 1 : -1, state.urls.length)); return }
    // 動かなかった：黒い所なら閉じる、画像ならダブルタップで拡大 / 戻す。
    if (ended.target === stage) { dialog.close(); return }
    const now = Date.now()
    if (lastTap && now - lastTap.at < 320 && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 30) {
      lastTap = null
      state.view.scale > 1 ? apply({ scale: 1, x: 0, y: 0 }) : apply(zoomAt(state.view, 2.5, pointOf(event)))
    } else lastTap = { at: now, x: event.clientX, y: event.clientY }
  }
  stage.addEventListener('pointerup', release); stage.addEventListener('pointercancel', release)
  dialog.addEventListener('close', () => { part('image').removeAttribute('src'); pointers.clear(); gesture = null })
  document.body.append(dialog)
  return {
    open(urls, index, alt, { names = [] } = {}) {
      state.urls = urls
      state.names = names
      state.alt = alt
      state.kind = shareKind()
      part('share').hidden = !state.kind
      if (state.kind) part('share').innerHTML = `${icon(state.kind)}<span>${state.kind === 'share' ? '共有' : 'コピー'}</span>`
      part('share').setAttribute('aria-label', state.kind === 'share' ? '共有' : '画像をコピー')
      dialog.classList.toggle('single', urls.length < 2)
      part('thumbs').replaceChildren(...urls.map((url, position) => {
        const thumb = document.createElement('button')
        thumb.type = 'button'
        thumb.setAttribute('aria-label', `${position + 1}枚目`)
        const image = document.createElement('img')
        image.src = url
        image.alt = ''
        thumb.append(image)
        thumb.addEventListener('click', () => show(position))
        return thumb
      }))
      if (!dialog.open) dialog.showModal()
      show(index)
    },
  }
}

export function openImageViewer(urls, index = 0, alt = '画像', options = {}) {
  viewer ??= buildViewer()
  viewer.open(urls, index, alt, options)
}
