// a505b (docs/architecture/modules/execution/memory-budget.md): how full the container's memory is, read from the cgroup (anon, not the cache).
import { readFile } from 'node:fs/promises'

// Share of the cgroup limit: seats whose turn ended sleep at once above SOFT; cold launches wait above HOLD.
export const SOFT = 0.55
export const HOLD = 0.70
// About what one live seat costs (claude + host + MCP helpers; measured 2026-11-22). shortcut: a constant, not read per seat; re-measure when seat tooling changes.
export const SEAT_BYTES = 0.75 * 2 ** 30

export function memoryPressure({ root = '/sys/fs/cgroup', read = file => readFile(file, 'utf8'), now = Date.now, ttlMs = 2000 } = {}) {
  let cached = null
  return async () => {
    if (cached && now() - cached.at < ttlMs) return cached.value
    let value = null
    try {
      const max = (await read(`${root}/memory.max`)).trim()
      const anon = Number(/^anon (\d+)$/m.exec(await read(`${root}/memory.stat`))?.[1])
      // "max" (no limit) or an unreadable file is no reading: unknown is not danger, nothing waits or sleeps early.
      if (/^\d+$/u.test(max) && Number(max) > 0 && Number.isFinite(anon)) value = { anon, max: Number(max), ratio: anon / Number(max) }
    } catch { /* no reading */ }
    cached = { at: now(), value }
    return value
  }
}
