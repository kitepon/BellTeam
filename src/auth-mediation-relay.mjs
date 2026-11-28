import { spawn as nodeSpawn } from 'node:child_process'
import { createServer } from 'node:net'
import { chmod, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createModuleChildRestart } from './module-child-restart.mjs'
import { seatCommandSpec } from './seat-command.mjs'

// Body side of the auth-mediation socket relay (docs/architecture/modules/runtime/auth-mediation-child.md, "The sockets").
// The relay (scripts/auth-mediation/relay.py, Rai) runs as the seat uid, because only that uid owns host.sock for the main-server user and can read a seat's cwd.
// It frames one client line per connection, adds the peer's identity and asks this endpoint over ONE unix socket the body owns; the reply line is the child's answer, unchanged.
export const RELAY_SOCKET = 'auth-mediation-relay.sock'
export const RELAY_SCRIPT = '/app/scripts/auth-mediation/relay.py'
export const SEAT_UID = 1000
const MAX_FRAME = 13 * 1024 * 1024, // an http line may carry a 9 MiB body as base64
   FRAME_MS = 5000, ANSWER_MS = 40000, READY_MS = 15000, STOP_MS = 5000
const bad = () => ({ outcome: 'error', error: 'Bad request.' })
const words = value => Array.isArray(value) && value.length >= 1 && value.length <= 64 && value.every(word => typeof word === 'string' && word.length >= 1 && word.length <= 1024 && !word.includes('\0'))
const absolute = value => typeof value === 'string' && value.startsWith('/') && value.length <= 4096 && !value.includes('\0')
// The client's http line -> the child's http params (the transport fills who is calling).
// The client's run line -> the child's run params: the stream socket is the relay's own doing (frame.stream), never the client's.
const runParams = (request, frame) => ({ name: request.name, stream: frame.stream })
const httpParams = request => ({ name: request.name, method: request.method, path: request.path, ...(request.headers === undefined ? {} : { headers: request.headers }),
  ...(request.body === undefined ? {} : { body: request.body }), ...(request.timeout_sec === undefined ? {} : { timeoutSec: request.timeout_sec }) })
// The client's key-use line -> the child's keyuse params (the transport fills who is calling).
const KEY_OPS = ['wrap', 'unwrap', 'sign', 'sign-digest', 'ssh-identity', 'ssh-sign']
const keyParams = request => ({ action: request.op, name: request.name, ...(request.data === undefined ? {} : { data: request.data }), ...(request.aad === undefined ? {} : { aad: request.aad }), ...(request.flags === undefined ? {} : { flags: request.flags }) })
// The client's mail line -> the child's mail params (the transport fills who is calling). mail-send sends; mail-read reads (read-only on the server).
const MAIL_OPS = ['mail-send', 'mail-read', 'mail-sort', 'mail-check']
const readParams = request => ({ action: 'read', name: request.name, ...Object.fromEntries(['mailbox', 'search', 'order', 'limit', 'fetch', 'uid', 'folders'].filter(k => request[k] !== undefined).map(k => [k, request[k]])) })
const sortParams = request => ({ action: 'sort', name: request.name, uid: request.uid, uidvalidity: request.uidvalidity, ...(request.add === undefined ? {} : { add: request.add }), ...(request.archive === undefined ? {} : { archive: request.archive }) })
const checkParams = request => ({ action: 'check', name: request.name, protocol: request.protocol })
const mailParams = request => request.op === 'mail-read' ? readParams(request) : request.op === 'mail-sort' ? sortParams(request) : request.op === 'mail-check' ? checkParams(request) : ({ action: 'send', name: request.name, to: request.to, subject: request.subject, text: request.text, ...(request.html === undefined ? {} : { html: request.html }),
  ...(request.from_name === undefined ? {} : { from_name: request.from_name }), ...(request.reply_to === undefined ? {} : { reply_to: request.reply_to }) })
// The client's gmail line -> the child's gmail params (the transport fills who is calling).
const GMAIL_OPS = ['gmail-list', 'gmail-get', 'gmail-modify']
const gmailParams = request => ({ action: request.op.slice(6), name: request.name, ...Object.fromEntries(['q', 'max_results', 'page_token', 'id', 'format', 'add_labels', 'remove_labels'].filter(k => request[k] !== undefined).map(k => [k, request[k]])) })
const program = value => value === undefined || value === null || (typeof value === 'object' && absolute(value.path) && /^[a-f0-9]{64}$/u.test(value.sha256) && typeof value.sealed === 'boolean')

// One relay frame -> one answer. Pure over the facade, so the mapping is testable without sockets.
export async function relayAnswer(frame, facade) {
  if (!frame || typeof frame !== 'object' || !['container-socket', 'host-socket', 'caller-socket'].includes(frame.via)) return bad()
  const { request, peer } = frame
  if (!request || typeof request !== 'object' || Array.isArray(request)) return bad()
  if (frame.via === 'caller-socket') {
    // A container product's own socket: its path is its identity (named by the relay, never by the client's line). Key use only; no exec, no admin.
    if (!absolute(frame.unit) || (peer !== null && peer !== undefined) || ![...KEY_OPS, 'http', 'http-stream', 'run', ...MAIL_OPS, ...GMAIL_OPS].includes(request.op)) return bad()
    if (request.op === 'http-stream') return facade.http({ ...httpParams(request), stream: frame.stream, via: 'caller-socket', unit: frame.unit })
    if (request.op === 'run') return facade.run({ ...runParams(request, frame), via: 'caller-socket', unit: frame.unit })
    if (GMAIL_OPS.includes(request.op)) return facade.gmail({ ...gmailParams(request), via: 'caller-socket', unit: frame.unit })
    if (MAIL_OPS.includes(request.op)) return facade.mail({ ...mailParams(request), via: 'caller-socket', unit: frame.unit })
    if (request.op === 'http') return facade.http({ ...httpParams(request), via: 'caller-socket', unit: frame.unit })
    return facade.keyuse({ ...keyParams(request), via: 'caller-socket', unit: frame.unit })
  }
  const container = frame.via === 'container-socket'
  if (container) {
    // The relay refuses a foreign uid itself; this is the second look, because the endpoint socket is open to the seat uid.
    if (!peer || typeof peer !== 'object' || peer.uid !== SEAT_UID || !absolute(peer.cwd)) return { outcome: 'unknown-caller', error: 'The caller is not registered.' }
    if (!program(peer.program)) return bad()
  } else if (peer !== null && peer !== undefined) return bad()
  if (request.op === 'exec') {
    if (!words(request.command)) return bad()
    if (container) return facade.containerSocket({ command: request.command, cwd: peer.cwd })
    if (!absolute(request.cwd)) return bad()
    return facade.hostSocket({ command: request.command, cwd: request.cwd, unit: request.cwd })
  }
  if (KEY_OPS.includes(request.op)) {
    if (container) return facade.keyuse({ ...keyParams(request), via: 'container-socket', cwd: peer.cwd })
    if (!absolute(request.cwd)) return bad()
    return facade.keyuse({ ...keyParams(request), via: 'host-socket', cwd: request.cwd, unit: request.cwd })
  }
  if (GMAIL_OPS.includes(request.op)) {
    if (container) return facade.gmail({ ...gmailParams(request), via: 'container-socket', cwd: peer.cwd })
    if (!absolute(request.cwd)) return bad()
    return facade.gmail({ ...gmailParams(request), via: 'host-socket', cwd: request.cwd, unit: request.cwd })
  }
  if (MAIL_OPS.includes(request.op)) {
    if (container) return facade.mail({ ...mailParams(request), via: 'container-socket', cwd: peer.cwd })
    if (!absolute(request.cwd)) return bad()
    return facade.mail({ ...mailParams(request), via: 'host-socket', cwd: request.cwd, unit: request.cwd })
  }
  if (request.op === 'http-stream') {
    if (container) return facade.http({ ...httpParams(request), stream: frame.stream, via: 'container-socket', cwd: peer.cwd })
    if (!absolute(request.cwd)) return bad()
    return facade.http({ ...httpParams(request), stream: frame.stream, via: 'host-socket', cwd: request.cwd, unit: request.cwd })
  }
  if (request.op === 'run') {
    if (container) return facade.run({ ...runParams(request, frame), via: 'container-socket', cwd: peer.cwd })
    if (!absolute(request.cwd)) return bad()
    return facade.run({ ...runParams(request, frame), via: 'host-socket', cwd: request.cwd, unit: request.cwd })
  }
  if (request.op === 'http') {
    if (container) return facade.http({ ...httpParams(request), via: 'container-socket', cwd: peer.cwd })
    if (!absolute(request.cwd)) return bad()
    return facade.http({ ...httpParams(request), via: 'host-socket', cwd: request.cwd, unit: request.cwd })
  }
  if (request.op === 'admin') {
    if (!container) return { outcome: 'error', error: 'Admin is only on the container socket.' }
    const { verb, args } = request
    if (typeof verb !== 'string' || !/^[a-z.]{2,32}$/u.test(verb) || (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args)))) return bad()
    return facade.admin({ cwd: peer.cwd, verb, args, ...(peer.program ? { program: peer.program } : {}) }) // the relay read it from the peer process; the client's own line cannot set it
  }
  return bad()
}

export function createAuthMediationRelay({ root, facade, relayScript = RELAY_SCRIPT, spawn = nodeSpawn, specFor = seatCommandSpec, onModuleRestartLimit,
  setTimer = setTimeout, clearTimer = clearTimeout, answerMs = ANSWER_MS }) {
  const path = join(root, 'state', RELAY_SOCKET)
  let server = null, child = null, closed = false, started = false
  const open = new Set()

  const serve = connection => {
    open.add(connection)
    let data = Buffer.alloc(0), answered = false
    const done = () => { open.delete(connection); connection.destroy() }
    const timer = setTimer(done, FRAME_MS); timer?.unref?.()
    connection.on('error', done); connection.on('close', () => { clearTimer(timer); open.delete(connection) })
    connection.on('data', async chunk => {
      if (answered) return
      data = Buffer.concat([data, chunk])
      const end = data.indexOf(10)
      if (end < 0 && data.length <= MAX_FRAME) return
      answered = true; clearTimer(timer)
      let reply
      try {
        if (end < 0 || end > MAX_FRAME) reply = bad()
        else {
          const frame = JSON.parse(data.subarray(0, end).toString('utf8'))
          let guard
          const slow = new Promise(resolve => { guard = setTimer(() => resolve({ outcome: 'error', error: 'Timed out.' }), answerMs); guard?.unref?.() })
          reply = await Promise.race([relayAnswer(frame, facade), slow]).finally(() => clearTimer(guard))
        }
      } catch { reply = bad() }
      if (!connection.destroyed) connection.end(JSON.stringify(reply) + '\n')
    })
  }

  const stopChild = target => new Promise(resolve => {
    if (!target || target.exitCode !== null || target.signalCode !== null) return resolve()
    const timer = setTimer(() => { try { target.kill('SIGKILL') } catch {} }, STOP_MS); timer?.unref?.()
    target.once('exit', () => { clearTimer(timer); resolve() })
    try { target.kill('SIGTERM') } catch { clearTimer(timer); resolve() }
  })

  // The relay runs as the seat uid through the privileged entry (sudo, fixed wrapper); a lost relay is restarted with the shared 1-30 s backoff, no attempt limit.
  const recovery = createModuleChildRestart(() => launch(), 'auth-mediation-relay', onModuleRestartLimit)
  async function launch() {
    if (closed) return
    recovery.restarting()
    const spec = specFor('/usr/bin/python3', [relayScript], { project: root, environment: 'base' })
    const target = spawn(spec.command, spec.args, { env: spec.env, stdio: ['ignore', 'pipe', 'ignore'] })
    child = target
    let readyTimer
    const ready = new Promise((resolve, reject) => {
      let text = ''
      target.stdout.setEncoding?.('utf8')
      target.stdout.on('data', chunk => { text += chunk; if (text.includes('auth-mediation relay ready')) resolve() })
      target.once('exit', () => reject(Object.assign(new Error('AUTH_MEDIATION_RELAY_EXITED'), { code: 'AUTH_MEDIATION_RELAY_EXITED' })))
      target.once('error', reject)
      const timer = setTimer(() => reject(Object.assign(new Error('AUTH_MEDIATION_RELAY_NOT_READY'), { code: 'READY_TIMEOUT' })), READY_MS); timer?.unref?.()
      readyTimer = timer
    })
    target.once('exit', (code, signal) => {
      if (child === target) child = null
      if (closed) return
      recovery.exited({ code, signal }); recovery.lost()
    })
    try { await ready } catch (error) { clearTimer(readyTimer); await stopChild(target); throw error }
    clearTimer(readyTimer)
    recovery.running()
  }

  return {
    path,
    // Never waits (a500: an optional child must not hold the body start). A failed first start only registers the recovery.
    async start() {
      if (started || closed) return
      started = true
      await mkdir(dirname(path), { recursive: true })
      await rm(path, { force: true })
      const next = createServer(serve)
      next.maxConnections = 64
      await new Promise((resolve, reject) => { next.once('error', reject); next.listen(path, resolve) })
      // The relay is the seat uid and must write to this socket; the body's 0711 state folder keeps the rest of the folder closed.
      await chmod(path, 0o666)
      server = next
      launch().catch(() => { if (!closed) recovery.lost() })
    },
    status: () => ({ listening: server !== null, relay: child !== null }),
    async close() {
      closed = true
      for (const connection of open) connection.destroy()
      const current = server; server = null
      if (current) await new Promise(resolve => current.close(resolve))
      await rm(path, { force: true })
      await stopChild(child)
    },
  }
}
