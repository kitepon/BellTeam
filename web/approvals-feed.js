// 決裁箱の読み手（入口のバッジと画面が一つを共有する）。GET /api/approvals/summary を読み、GET /api/approvals/events（SSE）を保つ。
// 読める間はタイマーで読まない。読めない時（503・通信・35秒の無音）だけ 1, 2, 4 … 30 秒で読み直し続ける。
// 404 / 402 / 403 / 409 は待っても変わらないので、タイマーを持たず止まる。読み直す・画面を開く・前面に戻る、のどれかで抜ける。
import { parseFrames } from './work-graph.js?v=__ASSET_VERSION__'
import { SUMMARY_SCHEMA, backoffMs, failureOf } from './approvals-model.js?v=__ASSET_VERSION__'

const TERMINAL = { old: 'old', notEntitled: 'notEntitled', expired: 'expired', noCredential: 'noCredential' }
const json = async response => { try { return await response.json() } catch { return null } }

export function createApprovalsFeed({ fetch, setTimeout: later = globalThis.setTimeout, clearTimeout: clear = globalThis.clearTimeout, random = Math.random, doc = globalThis.document } = {}) {
  const listeners = new Set()
  let summary = null, status = 'connecting', abort = null, timer = null, silence = null, attempt = 0, running = false, token = 0, resynced = false
  const emit = event => { for (const fn of [...listeners]) fn(event) }
  const setStatus = next => { if (next !== status) { status = next; emit({ type: 'status', status }) } }
  const release = () => { clear(silence); const current = abort; abort = null; current?.abort() }
  const retryLater = () => { clear(timer); if (running && !doc?.hidden) timer = later(() => void refresh(), backoffMs(attempt++, random)) }
  function drop() { release(); if (!running) return; setStatus('drop'); retryLater() }

  async function refresh() {
    if (!running) return
    clear(timer); release()
    const mine = ++token
    let response, body
    try { response = await fetch('/api/approvals/summary', { cache: 'no-store' }); body = await json(response) } catch { return mine === token ? drop() : undefined }
    if (mine !== token || !running) return
    if (!response?.ok) {
      const terminal = TERMINAL[failureOf(response?.status, body)]
      if (terminal) { summary = terminal === 'old' ? null : summary; setStatus(terminal); return }
      return drop()
    }
    if (body?.schema !== SUMMARY_SCHEMA) return drop()
    attempt = 0; summary = body; emit({ type: 'summary', summary }); setStatus('live')
    if (resynced) emit({ type: 'resync' })
    resynced = true
    void stream(mine)
  }

  async function stream(mine) {
    const controller = abort = new AbortController()
    const arm = () => { clear(silence); silence = later(() => { if (abort === controller) drop() }, 35000) }
    try {
      arm()
      const response = await fetch('/api/approvals/events', { signal: controller.signal, cache: 'no-store' })
      if (abort !== controller) return
      if (!response.ok) { const terminal = TERMINAL[failureOf(response.status, await json(response))]; if (!terminal) return drop(); release(); return setStatus(terminal) }
      const reader = response.body.getReader(), decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (abort !== controller) return
        if (done) return drop()
        arm()
        const parsed = parseFrames(buffer + decoder.decode(value, { stream: true }))
        buffer = parsed.rest
        for (const frame of parsed.frames) {
          if (!frame.event) continue
          let data
          try { data = JSON.parse(frame.data) } catch { return drop() }
          if (frame.event === 'summary' && data?.schema === SUMMARY_SCHEMA) { summary = data; emit({ type: 'summary', summary }) }
          else if (/^decision\.(created|updated|deleted)$/u.test(frame.event) && typeof data?.id === 'string') emit({ type: 'decision', event: frame.event.slice(9), id: data.id, version: data.version })
        }
      }
    } catch { if (abort === controller && running && mine === token) drop() }
  }

  const visibility = () => { if (!running) return; if (doc.hidden) { clear(timer); release() } else void refresh() }
  return {
    get summary() { return summary }, get status() { return status },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    start() { if (running) return; running = true; doc?.addEventListener?.('visibilitychange', visibility); void refresh() },
    stop() { running = false; token++; clear(timer); release(); doc?.removeEventListener?.('visibilitychange', visibility) },
    refresh,
  }
}
