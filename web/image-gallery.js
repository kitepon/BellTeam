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

let viewer = null

function buildViewer() {
  const dialog = document.createElement('dialog')
  dialog.className = 'image-viewer'
  dialog.setAttribute('aria-label', '画像')
  dialog.innerHTML = `
    <header class="image-viewer-bar">
      <button class="image-viewer-round" type="button" data-viewer="close" aria-label="閉じる"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      <span class="image-viewer-counter" data-viewer="counter"></span>
      <a class="image-viewer-round" data-viewer="original" target="_blank" rel="noopener" aria-label="元の画像を開く"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg></a>
    </header>
    <div class="image-viewer-stage" data-viewer="stage">
      <button class="image-viewer-step" type="button" data-viewer="prev" aria-label="前の画像"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button>
      <img class="image-viewer-image" data-viewer="image" alt="">
      <button class="image-viewer-step" type="button" data-viewer="next" aria-label="次の画像"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></button>
    </div>
    <div class="image-viewer-thumbs" data-viewer="thumbs"></div>`
  const part = name => dialog.querySelector(`[data-viewer="${name}"]`)
  const state = { urls: [], index: 0, alt: '' }
  const show = index => {
    state.index = stepIndex(index, 0, state.urls.length)
    const url = state.urls[state.index]
    part('image').src = url
    part('image').alt = `${state.alt}（${state.index + 1}/${state.urls.length}）`
    part('original').href = url
    part('counter').textContent = state.urls.length > 1 ? `${state.index + 1} / ${state.urls.length}` : ''
    part('thumbs').querySelectorAll('button').forEach((thumb, position) => thumb.setAttribute('aria-current', String(position === state.index)))
    part('thumbs').children[state.index]?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }
  part('close').addEventListener('click', () => dialog.close())
  part('prev').addEventListener('click', () => show(stepIndex(state.index, -1, state.urls.length)))
  part('next').addEventListener('click', () => show(stepIndex(state.index, 1, state.urls.length)))
  dialog.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft') show(stepIndex(state.index, -1, state.urls.length))
    if (event.key === 'ArrowRight') show(stepIndex(state.index, 1, state.urls.length))
  })
  // 画像の外側（黒い所）を押したら閉じる。
  part('stage').addEventListener('click', event => { if (event.target === part('stage')) dialog.close() })
  let swipeStart = null
  part('stage').addEventListener('pointerdown', event => { swipeStart = event.clientX })
  part('stage').addEventListener('pointerup', event => {
    if (swipeStart === null) return
    const distance = event.clientX - swipeStart
    swipeStart = null
    if (Math.abs(distance) > 50) show(stepIndex(state.index, distance < 0 ? 1 : -1, state.urls.length))
  })
  dialog.addEventListener('close', () => { part('image').removeAttribute('src') })
  document.body.append(dialog)
  return {
    open(urls, index, alt) {
      state.urls = urls
      state.alt = alt
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

export function openImageViewer(urls, index = 0, alt = '画像') {
  viewer ??= buildViewer()
  viewer.open(urls, index, alt)
}
