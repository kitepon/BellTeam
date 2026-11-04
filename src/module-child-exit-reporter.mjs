import { moduleChildExitReport } from './diagnostics.mjs'

// The diagnostics facade remains the only writer; these latest values are volatile.
export function createModuleChildExitReporter() {
  const pending = new Map(), active = new Map()
  let diagnostics = null, available = false, closed = false
  const flush = () => {
    if (closed || !available || !diagnostics) return
    for (const [component, entry] of pending) {
      if (entry.phase !== 'pending' || active.has(component)) continue
      entry.phase = 'issued'
      const task = Promise.resolve().then(() => diagnostics.record(entry.report)).then(() => {
        if (pending.get(component) === entry) pending.delete(component)
      }, error => { entry.phase = error?.outcome === 'not_accepted' ? 'pending' : 'unknown' }).finally(() => {
        active.delete(component)
        if (pending.get(component) !== entry) flush()
      })
      active.set(component, task)
    }
  }
  return {
    observe(dto) {
      if (closed) return
      const report = moduleChildExitReport(dto)
      pending.set(dto.component, { report, phase: 'pending' })
      flush()
    },
    attach(writer, ready) { diagnostics = writer; available = ready; flush() },
    ready(value) { const wasAvailable = available; available = value; if (value && !wasAvailable) flush() },
    async close() { closed = true; await Promise.allSettled([...active.values()]) },
  }
}
