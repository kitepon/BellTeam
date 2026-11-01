export function createMessageImageCache(fetchImage = fetch) {
  const previews = new Map(), failures = new Set(), loading = new Map(), owned = new Set()
  let closed = false
  const release = urls => { for (const url of urls) { if (owned.delete(url)) URL.revokeObjectURL(url) } }
  function remember(id, urls) {
    if (closed) return
    // The viewer may still use replaced URLs; release owned images on page exit.
    previews.set(id, urls)
    failures.delete(id)
  }
  async function read(item) {
    const created = []
    try {
      const urls = item.image_urls?.length ? item.image_urls : [item.image_url]
      const results = await Promise.allSettled(urls.map(async url => {
        const response = await fetchImage(url)
        if (!response.ok) throw new Error(`HTTP_${response.status}`)
        const blob = await response.blob()
        if (!blob.type.startsWith('image/')) throw new Error('IMAGE_RESPONSE_INVALID')
        const preview = URL.createObjectURL(blob)
        created.push(preview)
        owned.add(preview)
        return preview
      }))
      if (closed || previews.has(item.id) || results.some(result => result.status === 'rejected')) {
        release(created)
        if (!closed && !previews.has(item.id)) failures.add(item.id)
      } else previews.set(item.id, results.map(result => result.value))
    } catch {
      release(created)
      if (!closed && !previews.has(item.id)) failures.add(item.id)
    }
  }
  async function load(items, onLoaded = () => {}) {
    if (closed) return
    const missing = items.filter(item => item.image_url && !previews.has(item.id) && !failures.has(item.id))
    await Promise.all(missing.map(async item => {
      if (!loading.has(item.id)) loading.set(item.id, read(item).finally(() => loading.delete(item.id)))
      await loading.get(item.id)
      if (!closed) onLoaded(item)
    }))
  }
  return { remember, load, get: id => previews.get(id), failed: id => failures.has(id),
    close() { closed = true; release([...owned]); previews.clear(); failures.clear() } }
}
