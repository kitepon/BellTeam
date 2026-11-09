// Parent-owned recovery helper for usage secret credentials (usage secret-credentials.md "Event transport and lifecycle").
// The usage child has no timer; while any binding is unavailable, one cancellable timer calls system-only refresh.
export function createCredentialRefresh({ refresh, watch, intervalMs = 60_000, report = () => {} }) {
  const unavailable = new Set()
  let timer = null, running = null, stopped = false
  const run = () => {
    if (stopped || running) return running
    running = Promise.resolve().then(refresh).catch(error => report(error)).finally(() => { running = null })
    return running
  }
  const arm = () => {
    if (stopped) return
    if (unavailable.size && !timer) { timer = setInterval(run, intervalMs); timer.unref?.() }
    if (!unavailable.size && timer) { clearInterval(timer); timer = null }
  }
  const unwatch = watch(event => {
    if (typeof event?.handle !== 'string') return
    if (event.available === false) unavailable.add(event.handle)
    else unavailable.delete(event.handle)
    arm()
  })
  return Object.freeze({
    // Called on provider/terminal availability; a refresh already in flight is reused.
    refreshNow: run,
    get pending() { return unavailable.size },
    stop() { stopped = true; if (timer) clearInterval(timer); timer = null; unwatch?.() },
  })
}
