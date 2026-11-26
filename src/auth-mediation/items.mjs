import { execFile } from 'node:child_process'

// One cache per child. A miss costs one `op item get` (the account limit is shared by every Bot).
export function createItemCache({ runOp, now = Date.now }) {
  const cache = new Map()
  return {
    async get(name, vault, ttlSeconds) {
      const hit = cache.get(name)
      if (hit && now() < hit.until) return { fields: hit.fields, hit: true }
      let out
      try { out = await runOp(['item', 'get', name, '--vault', vault, '--reveal', '--format', 'json']) } catch { return null }
      const fields = Object.fromEntries((JSON.parse(out).fields ?? []).filter(f => f.value && f.purpose !== 'NOTES').map(f => [f.label, f.value]))
      cache.set(name, { fields, until: now() + ttlSeconds * 1000 })
      return { fields, hit: false }
    },
    flush: name => name ? cache.delete(name) : cache.clear(),
  }
}

// Fixed executable, argument array, no shell; stderr is never forwarded. The token is in this one process's environment only.
export const opRunner = ({ exe, withToken }) => args => withToken(token => new Promise((resolve, reject) =>
  execFile(exe, args, { env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: token }, timeout: 30000, maxBuffer: 1 << 20 },
    (error, stdout) => error ? reject(new Error('AUTH_OP_FAILED')) : resolve(stdout))))
