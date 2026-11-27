import { execFile } from 'node:child_process'

// One cache per child. A miss costs one `op item get` (the account limit is shared by every Bot).
export function createItemCache({ runOp, now = Date.now }) {
  const cache = new Map(), inflight = new Map()
  let epoch = 0
  // Requests for one item that arrive while its first read is running wait for that read (one `op item get`, not one per request).
  const read = async (name, vault, ttlSeconds) => {
    const mine = epoch
    let out
    try { out = await runOp(['item', 'get', name, '--vault', vault, '--reveal', '--format', 'json']) } catch { return null }
    const fields = Object.fromEntries((JSON.parse(out).fields ?? []).filter(f => f.value && f.purpose !== 'NOTES').map(f => [f.label, f.value]))
    if (mine === epoch) cache.set(name, { fields, until: now() + ttlSeconds * 1000 }) // a flush during the read drops its result
    return fields
  }
  return {
    async get(name, vault, ttlSeconds) {
      const hit = cache.get(name)
      if (hit && now() < hit.until) return { fields: hit.fields, hit: true }
      const waiting = inflight.get(name)
      if (waiting) { const fields = await waiting; return fields && { fields, hit: true } }
      const task = read(name, vault, ttlSeconds).finally(() => inflight.delete(name))
      inflight.set(name, task)
      const fields = await task
      return fields && { fields, hit: false }
    },
    flush: name => { epoch++; inflight.delete(name); name ? cache.delete(name) : cache.clear() },
  }
}

// Fixed executable, argument array, no shell; stderr is never forwarded. The token is in this one process's environment only.
export const opRunner = ({ exe, withToken }) => args => withToken(token => new Promise((resolve, reject) =>
  execFile(exe, args, { env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: token }, timeout: 30000, maxBuffer: 1 << 20 },
    (error, stdout) => error ? reject(new Error('AUTH_OP_FAILED')) : resolve(stdout))))
