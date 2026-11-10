// The remote seat listener's own port (remote-seat-ingress.md RS05). 4182 is the diagnostics admin port (0.0.0.0, host
// 18892); sharing it made the seat listener fail to bind and every remote seat MCP reach the admin server (401).
// Aiterm's serve forwards to the same env (BELLTEAM_REMOTE_SEAT_PORT ?? its own default), so terminals pass it explicitly.
export const remoteSeatPort = (environment = process.env) => Number(environment.BELLTEAM_REMOTE_SEAT_PORT ?? 4183)

// RS01/RS08 exit (remote-seat-ingress.md). The runtime binds its ensure (one bind at a time). A launch refused while the
// listener is down stays queued as not started (SEAT_FORWARD_UNAVAILABLE, remote-seats.mjs REACHABILITY). A non-AI bind retry
// runs only while such a terminal waits; the first successful bind republishes it as reachable on execution's terminals watch.
export function createRemoteSeatListener({ retryMs = 30_000, now = () => new Date().toISOString() } = {}) {
  let ensure = null, retry = null, closed = false
  const waiting = new Set(), watchers = new Set()
  const schedule = () => {
    if (closed || retry || !waiting.size) return
    retry = setTimeout(() => { retry = null; listener.ensure().catch(error => { if (error?.code !== 'STARTUP_INTERRUPTED') schedule() }) }, retryMs)
    retry.unref?.()
  }
  const listener = Object.freeze({
    bind: value => { ensure = value },
    async ensure() {
      const interrupted = () => Object.assign(new Error('STARTUP_INTERRUPTED'), { code: 'STARTUP_INTERRUPTED' })
      if (closed) throw interrupted()
      await ensure?.()
      if (closed) throw interrupted() // a bind that finished after close() hands out no seat and emits nothing
      const observedAt = now()
      for (const terminalId of [...waiting]) {
        waiting.delete(terminalId)
        for (const watcher of watchers) try { watcher({ terminalId, reachable: true, observedAt }) } catch {}
      }
    },
    // RS01: nothing is launched toward a dead MCP; the refusal names its exit (schedule + watch).
    async ensureFor(terminalId) {
      try { await listener.ensure() } catch (error) {
        if (!closed) { waiting.add(terminalId); schedule() }
        throw Object.assign(new Error('SEAT_FORWARD_UNAVAILABLE'), { code: 'SEAT_FORWARD_UNAVAILABLE', status: 503, effect: 'not_started', cause: error })
      }
    },
    watch: watcher => { watchers.add(watcher); return () => { watchers.delete(watcher) } },
    // Terminal state: no retry, no bind and no event after the body's close() or stop().
    close: () => { closed = true; clearTimeout(retry); retry = null; waiting.clear() },
  })
  return listener
}
