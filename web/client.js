import { readApiError, readApiResponse } from './chat-input.js?v=__ASSET_VERSION__'

export function createWebClient({ fetch = globalThis.fetch, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout } = {}) {
  async function api(path, options = {}) {
    const response = await fetch(path, options)
    if (!response.ok) {
      const detail = await readApiError(response, { details: true })
      throw Object.assign(new Error(detail.message), detail, { status: response.status })
    }
    return readApiResponse(response)
  }

  function watchEvents(onEvent, onError, onUpdates) {
    const abort = new AbortController()
    let timer = null, notifications = Promise.resolve()
    async function connect() {
      if (abort.signal.aborted) return
      let reader
      try {
        const response = await fetch('/api/events', { signal: abort.signal })
        if (!response.ok) { const error = new Error(`HTTP_${response.status}`); error.status = response.status; throw error }
        reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (!abort.signal.aborted) {
          const { done, value } = await reader.read()
          if (done || abort.signal.aborted) break
          buffer += decoder.decode(value, { stream: true })
          while (buffer.includes('\n\n') && !abort.signal.aborted) {
            const boundary = buffer.indexOf('\n\n')
            const block = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5)).join('\n')
            if (data) {
              const payload = JSON.parse(data)
              if (!onUpdates) await onEvent(payload)
              else if (payload.type === 'updates') await onUpdates(payload)
              else {
                // Keep ordinary notifications ordered without holding up update invalidations.
                notifications = notifications.then(() => { if (!abort.signal.aborted) return onEvent(payload) })
                void notifications.catch(error => { if (!abort.signal.aborted) { abort.abort(); onError(error) } })
              }
            }
          }
        }
      } catch (error) {
        if (abort.signal.aborted || error.name === 'AbortError') return
        if (error instanceof TypeError || error.status === 429 || error.status >= 500) { timer = setTimeout(connect, 1500); return }
        onError(error)
      } finally { reader?.releaseLock() }
    }
    void connect()
    return () => { abort.abort(); clearTimeout(timer) }
  }

  return { api, fetchImage: fetch, watchEvents }
}
