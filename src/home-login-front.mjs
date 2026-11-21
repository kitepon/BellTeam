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

export function createHomeFront({ call, markerPath, print = line => process.stderr.write(line), now = Date.now, setTimer = setInterval, clearTimer = clearInterval }) {
  let row = null // the last homeLogin row the child published; null = none yet (Legacy)
  let marker = false // durable: once enforced, never Legacy again
  let loaded = false
  let lastPrint = 0
  const used = new Set()

  const readMarker = async () => {
    if (loaded) return
    marker = await readFile(markerPath).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
    loaded = true
  }
  const accept = async next => {
    if (!next) return
    row = next
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
      const { row: next } = await call('home.sweep', { used: ids, streaming: [] })
      await accept(next)
      if (row && !row.bound && now() - lastPrint >= SETUP_REPRINT_MS) await showSetupCode()
    } catch { ids.forEach(id => used.add(id)) }
  }

  let timer = null
  return {
    route, judge, tick, accept, get row() { return row },
    /** The entitlement state of a session from the published row; undefined when this server is not enforced. */
    stateOf: sessionId => marker || row?.enforced ? row?.states?.[sessionId] ?? 'none' : undefined,
    async start() {
      await readMarker()
      const first = await call('home.publish', {})
      await accept(first.row)
      await tick()
      timer = setTimer(() => { void tick() }, TICK_MS)
      timer.unref?.()
    },
    stop() { if (timer) clearTimer(timer); timer = null },
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
