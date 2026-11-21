// a485: the body's side of the login-billing home part. `call(name, params)` reaches the usage child's home-login
// (the usage facade in the server, the module itself in the dev server); everything else here is the body's own:
// the /api/home route, the stateless guard, the never-removed "enforced" marker, the sweep timer, the setup-code print and the console socket.
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname } from 'node:path'
import { guard } from './vendor/login-billing-home-guard.mjs'

export const HOME_PREFIX = '/api/home'
const MAX_BODY = 16 * 1024
const SETUP_REPRINT_MS = 9 * 60_000
const TICK_MS = 60_000
const json = (response, status, body, headers = {}) => {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
  response.end(JSON.stringify(body))
}
const unavailable = response => json(response, 503, { error: 'SESSION_STORE_UNAVAILABLE' })

export function createHomeFront({ call, enabled = true, markerPath, print = line => process.stderr.write(line), now = Date.now, setTimer = setInterval, clearTimer = clearInterval }) {
  let row = null // the last homeLogin row the child published; null = none yet (Legacy)
  let marker = false // durable: once enforced, never Legacy again
  let loaded = false
  let lastPrint = 0
  const used = new Set()
  const streams = new Map() // session id -> open /api/events responses: they count as use, and end with the session

  const readMarker = async () => {
    if (loaded) return
    marker = await readFile(markerPath).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
    loaded = true
  }
  const accept = async next => {
    if (!next) return
    const before = new Set(Object.values(row?.hashes ?? {}))
    row = next
    const after = new Set(Object.values(next.hashes))
    for (const id of before) if (!after.has(id)) for (const response of streams.get(id) ?? []) response.destroy() // an ended session's stream is closed
    if (next.enforced && !marker) {
      await mkdir(dirname(markerPath), { recursive: true, mode: 0o700 })
      await writeFile(markerPath, `${new Date(now()).toISOString()}\n`, { mode: 0o600 })
      marker = true
    }
  }

  /** 'legacy' (today's path), { sessionId }, 'none' (401) or 'unavailable' (503: cannot judge, never 401). */
  async function judge(headers) {
    await readMarker()
    if (!marker && !row?.enforced) return 'legacy'
    if (!row) return 'unavailable'
    const answer = await guard({ v: row.v, hashes: row.hashes }, headers)
    if (answer.cannotJudge) return 'unavailable'
    if (answer.none) return 'none'
    used.add(answer.sessionId)
    return { sessionId: answer.sessionId }
  }

  const bearerOf = headers => typeof headers.authorization === 'string' ? headers.authorization : undefined
  const peerOf = request => typeof request.headers['x-bellteam-peer'] === 'string' ? request.headers['x-bellteam-peer'] : request.socket.remoteAddress ?? ''

  /** Handles /api/home/* (before any owner check: the handler judges). Returns false when the path is not ours. */
  async function route(request, response, url) {
    if (url.pathname !== HOME_PREFIX && !url.pathname.startsWith(`${HOME_PREFIX}/`)) return false
    await readMarker()
    // Not configured on this server: the path does not exist (an app reads 404 as "an older server"). An Enforced marker keeps it 503 instead.
    if (!enabled && !marker) { json(response, 404, { error: 'NOT_FOUND' }); return true }
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > MAX_BODY) { json(response, 400, { error: 'LOGIN_INPUT_INVALID' }); return true }
      chunks.push(chunk)
    }
    try {
      const answer = await call('home.handle', { method: request.method, path: url.pathname.slice(HOME_PREFIX.length), bearer: bearerOf(request.headers), body: Buffer.concat(chunks).toString('utf8') || undefined, peer: peerOf(request) })
      await accept(answer.row)
      if (answer.setupNeeded) await showSetupCode().catch(() => {}) // before the answer: the host can read a new code by the time the app asks
      response.writeHead(answer.status, answer.headers)
      response.end(answer.body)
    } catch { if (!response.headersSent) unavailable(response) }
    return true
  }

  /** The setup code goes to the body's own log (docker logs), where only the host's user reads it; the child never prints. */
  async function showSetupCode() {
    const { code, expiresAt } = await call('home.setupCode', {})
    lastPrint = now()
    print(`BellTeam setup code: ${code} (valid until ${expiresAt}). Enter it in the app when it asks for the setup code.\n`)
  }

  /** The body's timer: marks use, sweeps, and while the server is unbound shows the setup code in the body's own log. */
  async function tick() {
    const ids = [...used]
    used.clear()
    try {
      if (!row) await accept((await call('home.publish', {})).row) // a restarted body: the child only sends a row when it changed
      const { row: next } = await call('home.sweep', { used: ids, streaming: [...streams.keys()] })
      await accept(next)
      if (row && !row.bound && now() - lastPrint >= SETUP_REPRINT_MS) await showSetupCode()
    } catch { ids.forEach(id => used.add(id)) }
  }

  let timer = null, closeConsole = null
  return {
    route, judge, tick, accept, get row() { return row },
    trackStream(sessionId, response) {
      const set = streams.get(sessionId) ?? new Set()
      set.add(response); streams.set(sessionId, set)
      response.once('close', () => { set.delete(response); if (!set.size && streams.get(sessionId) === set) streams.delete(sessionId) })
    },
    /** The entitlement state of a session from the published row; undefined when this server is not enforced. */
    stateOf: sessionId => sessionId !== undefined && (marker || row?.enforced) ? row?.states?.[sessionId] ?? 'none' : undefined,
    async start(consoleSocketPath) {
      await readMarker()
      if (consoleSocketPath && (enabled || marker)) closeConsole = await this.listenConsole(consoleSocketPath)
      if (enabled || marker) await tick() // a usage child that is not up yet leaves the row empty: Legacy, or 503 when the marker says Enforced; the timer tries again
      if (enabled || marker) { timer = setTimer(() => { void tick() }, TICK_MS); timer.unref?.() }
    },
    async stop() { if (timer) clearTimer(timer); timer = null; await closeConsole?.(); closeConsole = null },
    /** The host console: a unix socket (0600) that takes one JSON line {op, ...} and answers one JSON line. */
    async listenConsole(socketPath) {
      await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })
      await rm(socketPath, { force: true })
      const server = createServer(socket => {
        let text = ''
        socket.setEncoding('utf8')
        socket.on('data', chunk => {
          text += chunk
          if (text.length > MAX_BODY) return socket.destroy()
          if (!text.includes('\n')) return
          void (async () => {
            let reply
            try {
              const result = await call('home.console', JSON.parse(text.split('\n')[0]))
              await accept(result.row)
              const { row: _row, ...rest } = result
              reply = { ok: true, ...rest }
            } catch (error) { reply = { ok: false, error: error?.code ?? 'CONSOLE_FAILED' } }
            socket.end(`${JSON.stringify(reply)}\n`)
          })()
        })
        socket.on('error', () => {})
      })
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
      await chmod(socketPath, 0o600)
      return () => new Promise(resolve => server.close(() => resolve()))
    },
  }
}
