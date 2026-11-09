// Owner HTTP for the terminals registry (remote-seat-ingress.md RS09). Results are the core's nonsecret projections as-is.
import { json } from './http-response.mjs'

export const TERMINALS_UNAVAILABLE = () => Object.assign(new Error('TERMINALS_UNAVAILABLE'), { code: 'TERMINALS_UNAVAILABLE', status: 503 })

async function readJson(request, empty) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > 64 * 1024) throw Object.assign(new Error('REQUEST_TOO_LARGE'), { code: 'REQUEST_TOO_LARGE', status: 413 })
    chunks.push(chunk)
  }
  if (!bytes && empty !== undefined) return empty
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw Object.assign(new Error('INVALID_JSON'), { code: 'INVALID_JSON', status: 400 }) }
}

export function createTerminalsApi({ terminals, internal }) {
  return async (request, response, url) => {
    const match = /^\/api\/terminals(?:\/([a-z0-9][a-z0-9-]{0,63})(\/check|\/trust|\/folder|\/keys\/([a-z]+)(\/authorize)?)?)?$/u.exec(url.pathname)
    if (!match) return false
    if (internal) return json(response, 403, { error: 'TERMINALS_OWNER_REQUIRED' })
    const core = terminals()
    if (!core) throw TERMINALS_UNAVAILABLE()
    const [, id, sub, keyKind, authorize] = match
    const check = sub === '/check'
    const method = request.method
    if (sub === '/folder') {
      if (method !== 'POST') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
      const body = await readJson(request, {})
      if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'path' && key !== 'create'))
        return json(response, 400, { error: 'INVALID_PATH', message: 'Send {path, create?} with an absolute folder path on that terminal' })
      return json(response, 200, await core.folder({ terminalId: id, path: body.path, create: body.create ?? false }))
    }
    if (sub === '/trust') {
      if (method !== 'POST') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
      const body = await readJson(request, {})
      if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join() !== 'fingerprint')
        return json(response, 400, { error: 'INVALID_TERMINAL', message: 'Send only {fingerprint: "SHA256:..."} read on that Mac' })
      return json(response, 200, await core.trust.attest(id, body.fingerprint))
    }
    // Key setting (Trony ruling): the key is entered only in Mika's secret card; this route carries no key or reference.
    if (keyKind !== undefined) {
      if (authorize && (method !== 'POST' || keyKind !== 'ssh')) return json(response, method !== 'POST' ? 405 : 400, { error: method !== 'POST' ? 'METHOD_NOT_ALLOWED' : 'INVALID_KEY_KIND' })
      if (method === 'POST') {
        const body = await readJson(request, {})
        if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)
          return json(response, 400, { error: 'KEY_IN_REQUEST_REFUSED', message: 'Send no key, password or reference here; open the returned secret request and enter it there' })
        return json(response, 200, await (authorize ? core.keys.authorize(id) : core.keys.request(id, keyKind)))
      }
      if (method === 'DELETE') return json(response, 200, { terminal: await core.keys.remove(id, keyKind) })
      return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
    }
    if (!id && method === 'GET') return json(response, 200, { terminals: await core.registry.list() })
    if (id && check && method === 'POST') return json(response, 200, await core.reachability.check(id))
    if (id && !sub && method === 'GET') {
      const terminal = await core.registry.get(id)
      return terminal ? json(response, 200, terminal) : json(response, 404, { error: 'TERMINAL_NOT_FOUND' })
    }
    if (id && !sub && method === 'PUT') return json(response, 200, await core.registry.put({ ...await readJson(request), terminalId: id }))
    if (id && !sub && method === 'DELETE') return json(response, 200, await core.registry.remove(id))
    return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
  }
}
