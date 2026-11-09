// 相関図の画面。データは GET /api/work-graph/events、見た目と動きは behavior-spec.md のとおり。
import { accent, backoffMs, blinkOpacity, createGraphModel, createTap, edgeText, flowDots, nodeAt, nodeText, pointAt } from './work-graph-model.js?v=__ASSET_VERSION__'

const INK = '#21293D', MUTED = '#787D91', LINE = '#E6E3F0', CHIP = 'rgba(248, 248, 251, 0.92)'
const NAME_FONT = '700 15px -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif'
const LABEL_FONT = '12px -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif'
export const PILLS = { drop: '再接続中…', degraded: '一部の情報を取得できていません', unreadable: 'データを読み込めませんでした。再接続中…' }

// SSEの塊を { event, data } に分ける。コメント（: hb）は event:null。
export function parseFrames(buffer) {
  const frames = []
  let index
  while ((index = buffer.indexOf('\n\n')) >= 0) {
    const block = buffer.slice(0, index)
    buffer = buffer.slice(index + 2)
    let event = 'message', data = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /u, ''))
    }
    frames.push(data.length ? { event, data: data.join('\n') } : { event: null, data: null })
  }
  return { frames, rest: buffer }
}

// 接続を保ち続ける。開いている間は決してあきらめない（閉じた時だけ終わる）。
export function createGraphStream({ fetch = globalThis.fetch, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout, random = Math.random, onSnapshot, onChange, onStatus }) {
  let abort = null, timer = null, silence = null, attempt = 0, running = false
  const schedule = () => { clearTimeout(timer); if (running) timer = setTimeout(connect, backoffMs(attempt++, random)) }
  function fail(kind) {
    clearTimeout(silence)
    const current = abort
    abort = null
    current?.abort()
    if (!running) return
    onStatus(kind)
    schedule()
  }
  async function connect() {
    if (!running) return
    const controller = abort = new AbortController()
    const arm = () => { clearTimeout(silence); silence = setTimeout(() => { if (abort === controller) fail('drop') }, 35000) }
    try {
      arm()
      const response = await fetch('/api/work-graph/events', { signal: controller.signal, cache: 'no-store' })
      if (response.status === 404) return fail('missing')
      if (!response.ok) return fail('unreadable')
      const reader = response.body.getReader(), decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (abort !== controller) return
        if (done) return fail('drop')
        arm()
        const parsed = parseFrames(buffer + decoder.decode(value, { stream: true }))
        buffer = parsed.rest
        for (const frame of parsed.frames) {
          if (!frame.event) continue
          let data
          try { data = JSON.parse(frame.data) } catch { return fail('unreadable') }
          if (frame.event === 'snapshot') { try { onSnapshot(data) } catch { return fail('unreadable') } attempt = 0; onStatus('live') }
          else if (frame.event === 'change' && !onChange(data)) return fail('drop')
        }
      }
    } catch (error) {
      if (abort !== controller || !running) return
      fail('drop')
    }
  }
  return {
    start() { if (running) return; running = true; attempt = 0; void connect() },
    stop() { running = false; clearTimeout(timer); clearTimeout(silence); abort?.abort(); abort = null },
  }
}

export function createWorkGraphView(dialog, { fetch = globalThis.fetch, onOpenMember = () => {} } = {}) {
  const stage = dialog.querySelector('[data-work-graph-stage]')
  const canvas = dialog.querySelector('canvas')
  const pill = dialog.querySelector('[data-work-graph-pill]')
  const empty = dialog.querySelector('[data-work-graph-empty]')
  const emptyText = empty.querySelector('p')
  const list = dialog.querySelector('[data-work-graph-a11y]')
  const hint = dialog.querySelector('[data-work-graph-hint]')
  const reduceMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  let model = createGraphModel({ reduceMotion }), frameId = 0, last = 0, status = 'connecting', hover = null, open = false
  const images = new Map(), measures = new Map()
  const context = canvas.getContext('2d')
  const now = () => Date.now()
  const rectOf = () => {
    const box = stage.getBoundingClientRect()
    return { x: 24, y: 24, w: Math.max(1, box.width - 48), h: Math.max(1, box.height - 48), width: box.width, height: box.height }
  }
  const wide = () => (globalThis.innerWidth ?? 0) >= 1024
  function measure(font) {
    return text => {
      const key = font + '\n' + text
      if (!measures.has(key)) { context.font = font; measures.set(key, context.measureText(text).width) }
      return measures.get(key)
    }
  }
  function image(node) {
    if (!node.avatarVersion) return null
    const key = `${node.botId}\n${node.avatarVersion}`
    if (!images.has(key)) {
      const item = new Image()
      item.src = `/api/bots/${encodeURIComponent(node.botId)}/avatar?v=${encodeURIComponent(node.avatarVersion)}`
      images.set(key, item)
    }
    const item = images.get(key)
    return item.complete && item.naturalWidth ? item : null
  }
  function showStatus(kind) {
    status = kind
    const text = kind === 'live' ? (model.degraded.length ? PILLS.degraded : '') : PILLS[kind] ?? ''
    pill.hidden = !text
    pill.textContent = text
    paintEmpty()
  }
  function paintEmpty() {
    const missing = status === 'missing' && !model.nodes.size
    // 一度も一枚目を読めていない間は、誰も動いていないとは言わない。
    const none = !missing && model.epoch !== null && ![...model.nodes.values()].some(node => !node.leaveAt)
    const text = missing ? '相関図はこのサーバーではまだ使えません' : 'いま動いているメンバーはいません'
    if (emptyText.textContent !== text) emptyText.textContent = text
    if (empty.classList.contains('visible') !== (missing || none)) empty.classList.toggle('visible', missing || none)
    if (missing) pill.hidden = true
  }
  function describe() {
    const names = new Map([...model.nodes.values()].map(node => [node.botId, node.name]))
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.botId : null
    const button = node => {
      const item = Object.assign(document.createElement('button'), { type: 'button', textContent: nodeText(node, now()) })
      item.dataset.botId = node.botId
      item.setAttribute('aria-describedby', hint.id)
      item.addEventListener('click', () => onOpenMember(node.botId))
      return item
    }
    const nodes = [...model.nodes.values()].filter(node => !node.leaveAt).map(button)
    const edges = [...model.edges.values()].filter(edge => !edge.endAt).map(edge => edgeText(edge, names))
    list.replaceChildren(...nodes.map(item => { const li = document.createElement('li'); li.append(item); return li }), ...edges.map(text => Object.assign(document.createElement('li'), { textContent: text })))
    // 一覧を描き直してもキーボードの位置を失わない。
    if (focused) nodes.find(item => item.dataset.botId === focused)?.focus()
  }
  const stream = createGraphStream({
    fetch,
    onSnapshot(data) { model.snapshot(data, now(), rectOf()); describe() },
    onChange(batch) { const applied = model.change(batch, now(), rectOf()); if (applied) { describe(); showStatus('live') } return applied },
    onStatus: showStatus,
  })
  function roundRect(x, y, w, h, r) { context.beginPath(); context.roundRect ? context.roundRect(x, y, w, h, r) : context.rect(x, y, w, h) }
  function chips(items) {
    context.font = LABEL_FONT; context.textAlign = 'center'; context.textBaseline = 'middle'
    for (const { box, alpha, lines } of items) {
      context.globalAlpha = alpha
      context.fillStyle = CHIP; roundRect(box.x, box.y, box.w, box.h, 8); context.fill()
      context.fillStyle = MUTED
      lines.forEach((line, i) => context.fillText(line, box.x + box.w / 2, box.y + 3 + 8 + i * 16))
    }
  }
  function draw(time) {
    frameId = 0
    if (!open) return
    const dt = last ? (time - last) / 1000 : 0
    last = time
    const rect = rectOf(), ratio = globalThis.devicePixelRatio || 1, t = now()
    if (canvas.width !== Math.round(rect.width * ratio) || canvas.height !== Math.round(rect.height * ratio)) {
      canvas.width = Math.round(rect.width * ratio); canvas.height = Math.round(rect.height * ratio); model.heat()
    }
    model.step(dt, rect, t, wide())
    const frame = model.frame(t, rect, { wide: wide(), hover, measure: measure(LABEL_FONT) })
    const stale = status !== 'live'
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, rect.width, rect.height)
    context.filter = stale && 'filter' in context ? 'saturate(40%)' : 'none'
    for (const line of frame.lines) {
      const end = pointAt(line, line.grow)
      context.globalAlpha = line.opacity
      context.lineWidth = 2
      context.strokeStyle = LINE
      const stroke = color => {
        context.strokeStyle = color
        context.beginPath(); context.moveTo(line.p0.x, line.p0.y)
        if (line.control && line.grow >= 1) context.quadraticCurveTo(line.control.x, line.control.y, line.p2.x, line.p2.y)
        else for (let i = 1; i <= 16; i++) { const p = pointAt(line, line.grow * i / 16); context.lineTo(p.x, p.y) }
        context.stroke()
      }
      stroke(LINE)
      if (line.edge.state === 'steered') { context.globalAlpha = line.opacity * 0.35; stroke(line.color); context.globalAlpha = line.opacity }
      if (line.grow >= 1) {
        const back = pointAt(line, Math.max(0, 1 - 10 / Math.max(line.length, 10))), angle = Math.atan2(end.y - back.y, end.x - back.x)
        context.fillStyle = line.color
        context.beginPath(); context.moveTo(end.x, end.y)
        context.lineTo(end.x - 10 * Math.cos(angle - 0.45), end.y - 10 * Math.sin(angle - 0.45))
        context.lineTo(end.x - 10 * Math.cos(angle + 0.45), end.y - 10 * Math.sin(angle + 0.45))
        context.closePath(); context.fill()
        if (!stale && !reduceMotion) for (const dot of flowDots(line, t)) {
          context.globalAlpha = line.opacity * dot.alpha * (line.edge.state === 'steered' ? 0.75 : 1)
          context.beginPath(); context.arc(dot.x, dot.y, 3.5, 0, Math.PI * 2); context.fill()
        }
      }
    }
    // blocked の札だけは線のすぐ上、顔・名前・ほかの札の下。
    chips(frame.blocked)
    for (const item of frame.nodes) {
      const { node, x, y, side } = item, color = accent(node.color), linked = node.state !== 'working'
      context.globalAlpha = item.opacity * (linked ? 0.55 : 1)
      if (!linked && !stale) {
        const ring = reduceMotion ? 0.8 : blinkOpacity(t, node.activeSince), r = side / 2 + 5
        context.save(); context.globalAlpha = item.opacity * ring * 0.5; context.filter = 'blur(6px)'; context.strokeStyle = color; context.lineWidth = 3
        roundRect(x - r, y - r, r * 2, r * 2, r * 0.62); context.stroke(); context.restore()
        context.globalAlpha = item.opacity * ring; context.strokeStyle = color; context.lineWidth = 3
        roundRect(x - r, y - r, r * 2, r * 2, r * 0.62); context.stroke()
        context.globalAlpha = item.opacity
      }
      const avatar = image(node)
      context.save(); roundRect(x - side / 2, y - side / 2, side, side, side * 0.31); context.clip()
      if (avatar) context.drawImage(avatar, x - side / 2, y - side / 2, side, side)
      else {
        const gradient = context.createLinearGradient(x - side / 2, y - side / 2, x + side / 2, y + side / 2)
        gradient.addColorStop(0, color); gradient.addColorStop(1, color + 'cc')
        context.fillStyle = gradient; context.fillRect(x - side / 2, y - side / 2, side, side)
        context.fillStyle = '#fff'; context.font = `700 ${Math.round(side * 0.42)}px sans-serif`; context.textAlign = 'center'; context.textBaseline = 'middle'
        context.fillText([...node.name][0] ?? '', x, y + 1)
      }
      context.restore()
    }
    context.textAlign = 'center'; context.textBaseline = 'top'; context.font = NAME_FONT
    for (const { item, box, maxWidth } of frame.names) {
      context.globalAlpha = item.opacity
      context.fillStyle = item.node.state === 'working' ? INK : MUTED
      context.fillText(truncate(item.node.name, maxWidth, measure(NAME_FONT)), item.x, box.y)
    }
    chips(frame.labels)
    context.globalAlpha = 1; context.filter = 'none'
    if (model.firstSeen) paintEmpty()
    frameId = requestAnimationFrame(draw)
  }
  // 隠れた名前はポインターを近づけた時だけ出す。指した札は一番上に描く。
  const tap = createTap(botId => onOpenMember(botId))
  const hit = event => {
    const box = canvas.getBoundingClientRect(), x = event.clientX - box.left, y = event.clientY - box.top
    const frame = model.frame(now(), rectOf(), { wide: wide(), hover, measure: measure(LABEL_FONT) })
    return { frame, x, y, botId: nodeAt(frame, x, y) }
  }
  const hoverAt = ({ frame, x, y, botId: node }) => {
    const inside = ({ box }) => x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h
    let edgeId = node ? null : (frame.labels.findLast(inside) ?? frame.blocked.findLast(inside))?.edge.id ?? null
    if (!node && !edgeId) for (const line of frame.lines) {
      for (let i = 0; i <= 20; i++) { const p = pointAt(line, i / 20); if (Math.hypot(p.x - x, p.y - y) < 10) { edgeId = line.edge.id; break } }
      if (edgeId) break
    }
    return node ? { botId: node } : edgeId ? { edgeId } : null
  }
  // マウスは指している間だけ。指は線をタップすると、次にほかをタップするまで出す（behavior-spec #800、タップの決まりは createTap）。
  canvas.addEventListener('pointermove', event => {
    tap.move(event.pointerId, event.clientX, event.clientY)
    if (event.pointerType === 'touch') return
    const point = hit(event)
    canvas.style.cursor = point.botId ? 'pointer' : ''
    hover = hoverAt(point)
  })
  canvas.addEventListener('pointerleave', event => { if (event.pointerType !== 'touch') hover = null })
  // タップの決まりは createTap（押した時の相手で開く）。
  canvas.addEventListener('pointerdown', event => { const primary = event.isPrimary && event.button === 0; tap.down(event.pointerId, event.clientX, event.clientY, event.timeStamp, primary, primary ? hit(event).botId : null) })
  canvas.addEventListener('pointerup', event => {
    // 指の札の表示（peek）は、タップと認めた時だけ変える。
    if (tap.up(event.pointerId, event.clientX, event.clientY, event.timeStamp) && event.pointerType === 'touch') hover = hoverAt(hit(event))
  })
  canvas.addEventListener('pointercancel', () => tap.cancel())
  const visibility = () => { if (!open) return; if (document.hidden) stream.stop(); else stream.start() }
  const resize = () => model.heat()
  return {
    open() {
      if (open) return
      open = true; status = 'connecting'; last = 0
      model = createGraphModel({ reduceMotion })
      pill.hidden = true; empty.classList.remove('visible')
      document.addEventListener('visibilitychange', visibility)
      globalThis.addEventListener?.('resize', resize)
      if (!dialog.open) dialog.showModal()
      stream.start()
      frameId = requestAnimationFrame(draw)
    },
    close() {
      if (!open) return
      open = false
      stream.stop()
      if (frameId) cancelAnimationFrame(frameId)
      frameId = 0
      document.removeEventListener('visibilitychange', visibility)
      globalThis.removeEventListener?.('resize', resize)
    },
  }
}

function truncate(text, width, measure) {
  if (measure(text) <= width) return text
  const chars = [...text]
  while (chars.length && measure(chars.join('') + '…') > width) chars.pop()
  return chars.join('') + '…'
}
