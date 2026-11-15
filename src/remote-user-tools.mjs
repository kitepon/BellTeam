// U3 (remote-user-tools.md): MCP Streamable HTTP from a terminal seat <-> one U2 host (stdio JSON-RPC) per (seat, tool).
// A host lives for its seat launch: it ends on DELETE, on credential issue/revoke for that seat (launch replaced or
// closed) and with the body. An unknown session id under a valid seat bearer is adopted: a new host is started and
// initialized here, so a call after a body restart works without the CLI re-initializing (a135 change 3).
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

const LATEST = '2025-06-18'
const json = (response, status, body, headers = {}) => {
  response.writeHead(status, { 'content-type': 'application/json', ...headers })
  response.end(body === undefined ? '' : JSON.stringify(body))
}
const rpcError = (id, message) => ({ jsonrpc: '2.0', id, error: { code: -32603, message } })
const readBody = async request => { const chunks = []; for await (const chunk of request) chunks.push(chunk); return Buffer.concat(chunks).toString('utf8') }

export function createUserToolRelay({ spawnHost, log = message => process.stderr.write(`${message}\n`) }) {
  const hosts = new Map() // `${sessionName}\0${name}` -> host
  const adopting = new Map() // same key -> in-flight adopt, shared by concurrent requests (parallel calls after a restart)
  let seq = 0

  const start = (binding, name) => {
    const child = spawnHost(binding, name)
    const host = { child, session: null, pending: new Map(), exited: false, sessionName: binding.sessionName, name }
    child.stdin.on('error', () => {})
    createInterface({ input: child.stdout }).on('line', line => {
      let message
      try { message = JSON.parse(line) } catch { return }
      const key = message?.id === undefined ? null : JSON.stringify(message.id)
      if (key !== null && !message.method && host.pending.has(key)) { const resolve = host.pending.get(key); host.pending.delete(key); return resolve(message) }
      // A server-to-client request has no client here to answer it; tell the server instead of leaving it waiting.
      if (key !== null && message.method) child.stdin.write(`${JSON.stringify(rpcError(message.id, 'USER_TOOL_CLIENT_REQUEST_UNSUPPORTED'))}\n`)
    })
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-2000) })
    child.on('exit', () => {
      host.exited = true
      for (const [id, resolve] of host.pending) resolve(rpcError(JSON.parse(id), `USER_TOOL_EXITED${stderr.trim() ? `: ${stderr.trim().split('\n').at(-1)}` : ''}`))
      host.pending.clear()
      if (hosts.get(key(binding.sessionName, name)) === host) hosts.delete(key(binding.sessionName, name))
      if (stderr.trim()) log(`BellTeam user tool ${binding.sessionName}/${name} exited: ${stderr.trim().split('\n').at(-1)}`)
    })
    child.on('error', () => {})
    return host
  }
  const key = (sessionName, name) => `${sessionName}\0${name}`
  const stop = host => { if (!host.exited) { host.child.stdin.end(); host.child.kill('SIGTERM') } }
  const call = (host, message) => {
    if (message.id === undefined) { host.child.stdin.write(`${JSON.stringify(message)}\n`); return Promise.resolve(null) }
    return new Promise(resolve => {
      if (host.exited) return resolve(rpcError(message.id, 'USER_TOOL_EXITED'))
      host.pending.set(JSON.stringify(message.id), resolve)
      host.child.stdin.write(`${JSON.stringify(message)}\n`)
    })
  }
  const fresh = (binding, name) => {
    const previous = hosts.get(key(binding.sessionName, name))
    if (previous) stop(previous)
    const host = start(binding, name)
    hosts.set(key(binding.sessionName, name), host)
    return host
  }
  // Adopt: initialize a new host ourselves for a session the client already holds.
  const adopt = async (binding, name, sessionId, version) => {
    const host = fresh(binding, name)
    const init = await call(host, { jsonrpc: '2.0', id: `bellteam-relay-init-${++seq}`, method: 'initialize',
      params: { protocolVersion: version || LATEST, capabilities: {}, clientInfo: { name: 'bellteam-user-tool-relay', version: '1' } } })
    if (init?.error) return { host, error: init.error.message }
    await call(host, { jsonrpc: '2.0', method: 'notifications/initialized' })
    host.session = sessionId
    return { host }
  }

  return {
    async handle(request, response, binding, name) {
      const sessionId = request.headers['mcp-session-id']
      if (request.method === 'DELETE') {
        const host = hosts.get(key(binding.sessionName, name))
        if (host && (!sessionId || host.session === sessionId)) { hosts.delete(key(binding.sessionName, name)); stop(host) }
        return json(response, 200)
      }
      if (request.method !== 'POST') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' }, { allow: 'POST, DELETE' })
      let body
      try { body = JSON.parse(await readBody(request)) } catch { return json(response, 400, rpcError(null, 'PARSE_ERROR')) }
      const messages = Array.isArray(body) ? body : [body]
      const initialize = messages.find(message => message?.method === 'initialize')
      let host = hosts.get(key(binding.sessionName, name))
      let session = sessionId
      if (initialize) {
        host = fresh(binding, name)
        session = host.session = randomUUID()
      } else if (!host || !sessionId || host.session !== sessionId) {
        const entry = key(binding.sessionName, name)
        let pending = adopting.get(entry)
        // Join an adopt already starting this host for the same session; only a different session replaces it.
        if (!pending || (sessionId && pending.sessionId !== sessionId)) {
          const id = sessionId || randomUUID()
          pending = { sessionId: id, promise: adopt(binding, name, id, request.headers['mcp-protocol-version']) }
          adopting.set(entry, pending)
          pending.promise.finally(() => { if (adopting.get(entry) === pending) adopting.delete(entry) })
        }
        const adopted = await pending.promise
        host = adopted.host; session = host.session
        if (adopted.error) return json(response, 502, rpcError(messages.find(message => message?.id !== undefined)?.id ?? null, adopted.error))
      }
      const replies = (await Promise.all(messages.map(message => call(host, message)))).filter(Boolean)
      if (initialize && replies.some(reply => reply.id === initialize.id && reply.error)) { hosts.delete(key(binding.sessionName, name)); stop(host) }
      const headers = session ? { 'mcp-session-id': session } : {}
      if (!replies.length) return json(response, 202, undefined, headers)
      return json(response, 200, Array.isArray(body) ? replies : replies[0], headers)
    },
    // Launch replaced (credential issue) or seat closed (revoke): its hosts end with it.
    closeSeat(sessionName) {
      for (const [entry, host] of hosts) if (host.sessionName === sessionName) { hosts.delete(entry); stop(host) }
    },
    size: () => hosts.size,
  }
}
