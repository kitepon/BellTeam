import { TimelineIndex, timelinePage, fullTimeline } from './timeline-index.mjs'

export function createMessageViews({ rooms, store, secretRequests, ownerQuestions }) {
  const sources = async (kind, id, prepared = null) => {
    const base = prepared ?? (kind === 'rooms'
      ? rooms.messageView ? await rooms.messageView(id) : new TimelineIndex(await rooms.messages(id))
      : store.timelineView ? await store.timelineView(id) : new TimelineIndex(await store.timeline(id)))
    const target = kind === 'rooms' ? { roomId: id } : { botId: id }
    const extra = service => service?.timelineView?.(target) ?? new TimelineIndex(service?.timeline(target) ?? [])
    return [base, extra(secretRequests), ...(kind === 'bots' ? [extra(ownerQuestions)] : [])]
  }
  const timeline = async (kind, id) => fullTimeline(await sources(kind, id))
  const messagePage = async (kind, id, url) => {
    const page = timelinePage(await sources(kind, id), url)
    return { ...page, items: page.items.map(webMessage) }
  }

  return { sources, timeline, messagePage }
}

// 会話は最新から読む。limit=最新からの件数、before=そのIDより前、after=そのIDより後（差分）。
export function pageItems(items, url) {
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 10))
  const before = url.searchParams.get('before')
  const after = url.searchParams.get('after')
  if (after) {
    const index = items.findIndex(item => item.id === after)
    return { items: index < 0 ? items.slice(-limit) : items.slice(index + 1), has_more: false }
  }
  let end = items.length
  if (before) {
    const index = items.findIndex(item => item.id === before)
    if (index >= 0) end = index
  }
  const start = Math.max(0, end - limit)
  return { items: items.slice(start, end), has_more: start > 0, remaining_before: Math.trunc(start) }
}

// 画像の保存先は記録に残し、画面へは取得用のURLだけを渡す。`image_url` は1枚しか読まない古いアプリ向けに1枚目を入れる。
export function webMessage(item) {
  const imageAsset = item.imageAsset ?? item.image_asset ?? null
  const { imageAsset: _camelAsset, image_asset: _snakeAsset, imageAssets: camelAssets, image_assets: snakeAssets, ...visible } = item
  const imageAssets = camelAssets ?? snakeAssets ?? []
  const assets = imageAssets.length ? imageAssets : imageAsset ? [imageAsset] : []
  if (!assets.length) return visible
  const urls = assets.map(asset => `/api/message-images/${encodeURIComponent(asset.owner)}/${encodeURIComponent(asset.file)}`)
  return { ...visible, image: true, image_url: urls[0], image_urls: urls }
}

// 画像を何枚も付けた送信を受ける。Cloudflareの無料プランが受ける本文の上限（100MB）に収める。
export const MESSAGE_MAX_BYTES = 96 * 1024 * 1024

// 送信の画像は `images`（複数）で受ける。1枚の `image` しか送らない古いアプリの送信も受ける。
export function messageImages(body) {
  if (Array.isArray(body.images)) {
    if (body.images.some(image => !image || typeof image !== 'object')) throw new Error('IMAGE_INVALID')
    return body.images
  }
  if (body.images !== undefined) throw new Error('IMAGE_INVALID')
  return body.image ? [body.image] : []
}
