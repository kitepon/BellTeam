// BellTeam's Approval Box door on a terminal host (terminals README "Approval Box door on terminals", a532b1).
// Runs only as `node approval-box-door.mjs serve|register`, on the host, as the seat's user. Node built-ins only: this whole
// text travels to the host inside the launch's post_launch hook (approval-door.mjs), so it imports nothing of BellTeam.
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ENDPOINT = '/api/seat-mcp/approval-box/local'
// The body accepts exactly `Bearer ` + 43 of these; anything else is refused there, so it is never registered here.
const BEARER = /^Bearer [A-Za-z0-9_-]{43}$/
const TOKEN = /^[A-Za-z0-9_-]{43}$/
// The daemon's own line cap is 32 MiB; this process must never cap below it.
const LINE_MAX = 64 * 1024 * 1024
const SWEEP_MS = 30_000
// A client that has not finished its request line in this time is closed (Windows: Everyone may open a pipe read-only).
const IDLE_MS = 30_000
const CONTROL = '{"bellteam_door":'
// What the detached door keeps of the hook's environment: never the seat's private values.
const KEEP_ENV = ['HOME', 'USERPROFILE', 'USER', 'USERNAME', 'LOGNAME', 'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']

export const doorAddress = (platform = process.platform, home = os.homedir(), user = os.userInfo().username) =>
  platform === 'win32' ? `\\\\.\\pipe\\bellteam-approval-box-door-${user.replace(/[^A-Za-z0-9_.-]/g, '_')}` : path.posix.join(home, '.bellteam', 'approval-box-door.sock')

const errorLine = (status, code, message) => JSON.stringify({ ok: false, status, code, message, body: {} })
const bodyCode = text => { try { const code = JSON.parse(text).error; return typeof code === 'string' ? code : null } catch { return null } }
const validAlive = alive => Array.isArray(alive) && alive.length >= 1 && alive.length <= 8 && alive.every(item => typeof item === 'string' && item && !item.includes('\0'))

// Exit 0 = the native session exists, 1 = confirmed absent, anything else = cannot tell (aiterm-session-alive).
export const runAlive = alive => new Promise(resolve => {
  try { execFile(alive[0], alive.slice(1), { timeout: 5000, windowsHide: true }, error => resolve(error === null ? 0 : typeof error.code === 'number' ? error.code : 2)) } catch { resolve(2) }
})

export class Door {
  seats = new Map()
  constructor(check = runAlive, send = fetch) { this.check = check; this.send = send }

  // A new registration replaces the session's old bearer at once (one token per session name, RS02); the newest is tried first.
  register(session, port, bearer, alive) {
    this.seats.delete(session)
    this.seats.set(session, { port, bearer, alive, misses: 0 })
  }
  get size() { return this.seats.size }

  // Drops a seat whose native session was confirmed absent in two sweeps in a row (one failed check is not proof; "cannot tell" breaks the run, so a live seat is never dropped on a flapping check).
  async sweep() {
    for (const [session, seat] of [...this.seats]) {
      const code = await this.check(seat.alive)
      if (code !== 1) seat.misses = 0
      else if (++seat.misses >= 2) this.seats.delete(session)
    }
    return this.seats.size
  }

  // One connector line -> one reply line (no newline). Never throws: the connector always gets a typed answer.
  async forward(line) {
    let unreachable = false
    for (const [session, seat] of [...this.seats].reverse()) {
      let response, text
      try {
        response = await this.send(`http://127.0.0.1:${seat.port}${ENDPOINT}`, { method: 'POST', headers: { authorization: seat.bearer, 'content-type': 'application/json' }, body: line })
        text = await response.text()
      } catch { unreachable = true; continue }
      if (response.status === 200) return text.replace(/\r?\n$/, '') // the daemon's own reply, a down daemon included
      const code = bodyCode(text)
      if (response.status === 400 && code === 'BELLTEAM_SEAT_UNRESOLVED') { this.seats.delete(session); continue } // replaced or revoked: dead
      if (response.status === 403 && code === 'APPROVAL_BOX_DOOR_NOT_ALLOWED') continue // a fork seat's bearer
      return errorLine(response.status, code ?? 'APPROVAL_DOOR_HTTP_ERROR', `the body answered HTTP ${response.status}`)
    }
    // The connector's own code for a door that cannot reach the body.
    return errorLine(503, 'door_unavailable', unreachable ? 'the seat route to the body is not reachable' : 'no live seat on this computer can reach the body')
  }

  // The first-line control message of a launch or resume; any other line is the connector's.
  async handle(line) {
    if (!line.startsWith(CONTROL)) return this.forward(line)
    const invalid = () => errorLine(400, 'APPROVAL_DOOR_REGISTER_INVALID', 'not a valid registration')
    try {
      const message = JSON.parse(line)
      if (message.bellteam_door !== 'register' || typeof message.session !== 'string' || !message.session || message.session.length > 128
        || !Number.isInteger(message.port) || message.port < 1 || message.port > 65535
        || typeof message.authorization !== 'string' || !BEARER.test(message.authorization) || !validAlive(message.alive)) return invalid()
      this.register(message.session, message.port, message.authorization, message.alive)
      return JSON.stringify({ ok: true })
    } catch { return invalid() }
  }
}

// One request per connection (the connector's wire): read the first line, answer it, end. The client may half-close after writing.
function serveConnection(door, socket, idleMs) {
  let buffer = '', taken = false
  socket.setEncoding('utf8')
  socket.setTimeout(idleMs, () => socket.destroy())
  socket.on('error', () => socket.destroy())
  socket.on('data', chunk => {
    if (taken) return
    buffer += chunk
    const at = buffer.indexOf('\n')
    if (at < 0) {
      if (buffer.length > LINE_MAX) { taken = true; socket.end(`${errorLine(413, 'APPROVAL_DOOR_TOO_LARGE', 'the line is larger than the door accepts')}\n`) }
      return
    }
    taken = true
    socket.setTimeout(0) // the body's answer may take longer than the idle limit
    void door.handle(buffer.slice(0, at).replace(/\r$/, '')).then(reply => { if (!socket.destroyed) socket.end(`${reply}\n`) })
  })
}

function listen(server, address) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    const before = process.platform === 'win32' ? null : process.umask(0o177) // the socket is created 0600
    try { server.listen(address, () => { server.off('error', reject); resolve() }) }
    finally { if (before !== null) process.umask(before) }
  })
}

// Whether something already answers at the address (another door, or a stale file when it does not).
const answers = address => new Promise(resolve => {
  const probe = net.connect(address)
  probe.once('connect', () => { probe.destroy(); resolve(true) })
  probe.once('error', () => resolve(false))
})

// Starts serving; resolves to null when another door already holds the address. Closes and calls onEmpty when no seat counts.
export async function serveDoor(door, address = doorAddress(), onEmpty = () => {}, sweepMs = SWEEP_MS, idleMs = IDLE_MS) {
  if (process.platform !== 'win32') fs.mkdirSync(path.dirname(address), { recursive: true, mode: 0o700 })
  const server = net.createServer({ allowHalfOpen: true }, socket => serveConnection(door, socket, idleMs))
  try { await listen(server, address) } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error
    if (await answers(address)) return null
    if (process.platform !== 'win32') fs.rmSync(address, { force: true }) // a stale file from a door that died
    await listen(server, address)
  }
  // The listening server keeps the door process alive; the sweep must not keep a test process alive.
  const timer = setInterval(async () => {
    if (await door.sweep() !== 0) return
    clearInterval(timer); server.close()
    if (process.platform !== 'win32') fs.rmSync(address, { force: true })
    onEmpty()
  }, sweepMs)
  timer.unref()
  return server
}

const cleanEnv = env => Object.fromEntries(KEEP_ENV.filter(name => typeof env[name] === 'string').map(name => [name, env[name]]))

function startDoor() {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], { detached: true, stdio: 'ignore', env: cleanEnv(process.env), windowsHide: true })
  child.on('error', () => { /* the next attempt of the registration loop reports it */ })
  child.unref()
}

function sendControl(address, line) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(address)
    let reply = ''
    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.once('connect', () => socket.write(`${line}\n`))
    socket.on('data', chunk => {
      reply += chunk
      if (!reply.includes('\n')) return
      socket.destroy()
      let ok = false
      try { ok = JSON.parse(reply).ok === true } catch {}
      ok ? resolve() : reject(new Error(`door refused: ${reply.trim()}`))
    })
  })
}

// The seat's bearer from the hook's environment, never argv: a private header value, or the seat token the header names.
export function bearerOf(env) {
  const header = Object.entries(env).find(([name, value]) => name.startsWith('AITERM_MCP_HEADER_') && BEARER.test(value ?? ''))
  if (header) return header[1]
  return TOKEN.test(env.BELLTEAM_MCP_TOKEN ?? '') ? `Bearer ${env.BELLTEAM_MCP_TOKEN}` : null
}

// The post_launch hook of a launch or resume. A seat with no bearer, no forward port or no alive check has no door and still works,
// so this reports and never throws (Aiterm never fails a launch for the hook either).
export async function registerFromEnv(env = process.env, address = doorAddress(), tries = 24) {
  const port = Number(env.AITERM_SEAT_FORWARD_PORT)
  let alive = null
  try { alive = JSON.parse(env.AITERM_SESSION_ALIVE ?? 'null') } catch {}
  const bearer = bearerOf(env)
  if (!env.AITERM_SESSION_ID || !Number.isInteger(port) || !bearer || !validAlive(alive)) return false
  const line = JSON.stringify({ bellteam_door: 'register', session: env.AITERM_SESSION_ID, port, authorization: bearer, alive })
  let started = false, last = null
  for (let attempt = 0; attempt < tries; attempt++) {
    try { await sendControl(address, line); return true } catch (error) {
      last = error
      if (!started) { startDoor(); started = true }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  process.stderr.write(`bellteam approval door: registration failed: ${last instanceof Error ? last.message : String(last)}\n`)
  return false
}

const here = fileURLToPath(import.meta.url)
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(here)) {
  if (process.argv[2] === 'serve') {
    serveDoor(new Door(), doorAddress(), () => process.exit(0)).then(server => { if (!server) process.exit(0) }, error => {
      process.stderr.write(`bellteam approval door: ${error instanceof Error ? error.message : String(error)}\n`); process.exit(1)
    })
  } else if (process.argv[2] === 'register') {
    registerFromEnv().then(() => process.exit(0))
  }
}
