// Parent-owned recovery helper for usage secret credentials (usage secret-credentials.md "Event transport and lifecycle").
// The usage child has no timer; while any binding is unavailable or usage reports recoveryNeeded, one cancellable
// timer calls system-only refresh.
export function createCredentialRefresh({ refresh, watch, watchRecovery = null, intervalMs = 60_000, report = () => {} }) {
  const unavailable = new Set()
  let recoveryNeeded = false, timer = null, running = null, stopped = false
  const arm = () => {
    if (stopped) return
    const needed = unavailable.size > 0 || recoveryNeeded
    if (needed && !timer) { timer = setInterval(run, intervalMs); timer.unref?.() }
    if (!needed && timer) { clearInterval(timer); timer = null }
  }
  // Source-free DTO {recoveryNeeded}; anything else leaves the flag as it was.
  const recovery = value => {
    if (typeof value?.recoveryNeeded !== 'boolean') return
    recoveryNeeded = value.recoveryNeeded
    arm()
  }
  function run() {
    if (stopped || running) return running
    // Settles, never rejects: a failing report sink must not become an unhandled rejection.
    running = Promise.resolve().then(refresh).then(recovery)
      .catch(error => Promise.resolve().then(() => report(error)).catch(() => {}))
      .finally(() => { running = null })
    return running
  }
  const unwatch = watch(event => {
    if (typeof event?.handle !== 'string') return
    if (event.available === false) unavailable.add(event.handle)
    else unavailable.delete(event.handle)
    arm()
  })
  const unwatchRecovery = watchRecovery?.(recovery)
  return Object.freeze({
    // Called on provider/terminal availability; a refresh already in flight is reused.
    refreshNow: run,
    get pending() { return unavailable.size + (recoveryNeeded ? 1 : 0) },
    // Resolves after any in-flight refresh settles, so callers can close providers afterwards.
    stop() {
      stopped = true
      if (timer) clearInterval(timer)
      timer = null
      unwatch?.()
      unwatchRecovery?.()
      return running ?? Promise.resolve()
    },
  })
}
