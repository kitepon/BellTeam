import { spawn as nodeSpawn } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir } from 'node:fs/promises'
import { connect as netConnect, createConnection } from 'node:net'
import { join } from 'node:path'
import { createSeatsSocket } from './approval-box-seats-socket.mjs'
import { createSeatEntryPublisher } from './approval-box-entries.mjs'
import { createChildStderrLog, createModuleChildRestart } from './module-child-restart.mjs'

// Hosted Approval Box connector daemon (docs/architecture/modules/runtime/approval-box-daemon.md, a490h).
export const DAEMON_ENTRY = '/app/distribution/approval-box/runtime-home/runtime/0.2.0-pc.4/cli.mjs'
export const SEATS_SOCKET = 'approval-box-hosted.sock'
export const APPROVAL_BOX_SERVER = 'https://approval-box.kitepon.dev'
const READY_MS = 15000, STATUS_MS = 2000, PAIR_LINE_MS = 20000, PAIR_GRACE_MS = 5 * 60 * 1000, STOP_MS = 5000, EGRESS_MS = 3000
const PAIR_MAX_MS = 7 * 24 * 60 * 60 * 1000 + PAIR_GRACE_MS
// Egress targets (Nayuta c8h): UDP for the relay (STUN/TURN), TCP 443 for the Approval Box server.
export const EGRESS_TARGETS = Object.freeze([
  { kind: 'udp', host: 'stun.cloudflare.com', port: 3478 },
  { kind: 'udp', host: 'turn.cloudflare.com', port: 3478 },
  { kind: 'udp', host: 'turn.cloudflare.com', port: 443 },
  { kind: 'tcp', host: 'approval-box.kitepon.dev', port: 443 },
])
const failure = (code, status = 503) => Object.assign(new Error(code), { code, status })
const timeoutError = () => failure('APPROVAL_BOX_DAEMON_TIMEOUT')

// One NDJSON request over the daemon's unix socket: {method,path,body} -> {ok,result|status,code,message}.
export function localCall(socketPath, method, path, body, { timeoutMs = STATUS_MS, connect = createConnection, maxReply = 1e6 } = {}) {
  return new Promise((resolve, reject) => {
    let text = '', settled = false
    const socket = connect(socketPath)
    const done = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); fn(value) }
    const timer = setTimeout(() => done(reject, timeoutError()), timeoutMs)
    socket.setEncoding?.('utf8')
    socket.on('connect', () => socket.write(JSON.stringify({ method, path, ...(body === undefined ? {} : { body }) }) + '\n'))
    socket.on('data', chunk => { text += chunk; if (text.length > maxReply) done(reject, failure('APPROVAL_BOX_DAEMON_REPLY_INVALID')) })
    socket.on('end', () => { try { done(resolve, JSON.parse(text)) } catch { done(reject, failure('APPROVAL_BOX_DAEMON_REPLY_INVALID')) } })
    socket.on('error', () => done(reject, failure('APPROVAL_BOX_DAEMON_UNREACHABLE')))
  })
}

// STUN Binding request (RFC 5389): a reply with the same transaction id proves UDP both ways; TURN servers answer it too.
export function stunProbe(host, port, { dgram = createSocket, timeoutMs = EGRESS_MS, random = randomBytes } = {}) {
  return new Promise(resolve => {
    const transaction = random(12)
    const request = Buffer.concat([Buffer.from([0, 1, 0, 0, 0x21, 0x12, 0xa4, 0x42]), transaction])
    const socket = dgram('udp4')
    let settled = false
    const done = result => { if (settled) return; settled = true; clearTimeout(timer); try { socket.close() } catch {} resolve(result) }
    const timer = setTimeout(() => done('timeout'), timeoutMs)
    socket.on('error', error => done(`error:${String(error?.code ?? 'UNKNOWN').replace(/[^A-Z0-9_]/g, '').slice(0, 24) || 'UNKNOWN'}`))
    socket.on('message', message => {
      if (message.length >= 20 && message[0] === 1 && message[1] === 1 && message.subarray(4, 8).equals(Buffer.from([0x21, 0x12, 0xa4, 0x42]))
        && message.subarray(8, 20).equals(transaction)) done('ok')
    })
    socket.send(request, port, host, error => { if (error) done(`error:${String(error?.code ?? 'SEND').replace(/[^A-Z0-9_]/g, '').slice(0, 24) || 'SEND'}`) })
  })
}

function tcpProbe(host, port, { connect = netConnect, timeoutMs = EGRESS_MS } = {}) {
  return new Promise(resolve => {
    let settled = false
    const socket = connect({ host, port, family: 4 })
    const done = result => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(result) }
    const timer = setTimeout(() => done('timeout'), timeoutMs)
    socket.once('connect', () => done('ok'))
    socket.once('error', error => done(`error:${String(error?.code ?? 'UNKNOWN').replace(/[^A-Z0-9_]/g, '').slice(0, 24) || 'UNKNOWN'}`))
  })
}

export async function egressCheck(options = {}) {
  const rows = await Promise.all(EGRESS_TARGETS.map(async target => ({
    kind: target.kind, host: target.host, port: target.port,
    result: await (target.kind === 'udp' ? stunProbe(target.host, target.port, options.udp) : tcpProbe(target.host, target.port, options.tcp)),
  })))
  return { allOk: rows.every(row => row.result === 'ok'), targets: rows }
}

const closedStatus = value => ({
  mode: typeof value?.mode === 'string' ? value.mode.slice(0, 32) : null,
  paired: typeof value?.paired === 'boolean' ? value.paired : null,
  reason: typeof value?.reason === 'string' ? value.reason.slice(0, 64) : null,
  version: typeof value?.version === 'string' ? value.version.slice(0, 32) : null,
  ...(typeof value?.connection_id === 'string' ? { connectionId: value.connection_id.slice(0, 64) } : {}),
})

// Only these fields of a pair line leave the parent; the secrets (code, typed_secret, qr_text) only inside the waiting line.
const safeLine = line => {
  const out = { type: String(line?.type ?? line?.event ?? line?.state ?? 'line').slice(0, 24) }
  for (const key of ['expires_at', 'claimed_at', 'connection_id', 'paired', 'error', 'schema']) if (line?.[key] !== undefined) out[key] = typeof line[key] === 'string' ? line[key].slice(0, 80) : line[key]
  return out
}
const isWaiting = line => (line?.type ?? line?.event ?? line?.state) === 'waiting'

export function createApprovalBoxDaemon({ root, entry = DAEMON_ENTRY, node = process.execPath, server = APPROVAL_BOX_SERVER, spawn = nodeSpawn,
  connect = createConnection, onModuleRestartLimit, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, exists = existsSync, egress = egressCheck, entries = null, seatRun = null } = {}) {
  const home = join(root, 'state', 'approval-box-daemon')
  const socketPath = join(home, 'state', 'pc', 'daemon.sock')
  // a514m: the seats' door (a relay; the daemon's own directory stays 0700). `seatsReady` is shown in status so a failed listen is visible before the sitting.
  let seatsReady = false
  // P5 (approval-box-entries.mjs): the seat entry file the body's registration reads; started and closed with the connector. Its own folder (0755, made by this parent-side code):
  // the module child's folder state/approval-box-extension is 0700 (links.json), and Molly's E2 pass reads as the seat user (uid 1000).
  // Without a seat runner (dev, tests) nothing is published: the body cannot run the seats' binary itself (uid 1001 against the seat user's 0700 home).
  const seatEntries = entries ?? (seatRun ? createSeatEntryPublisher({ file: join(root, 'state', 'approval-box-entries', 'harness-entries.json'), run: seatRun }) : { start() {}, close() {}, publish: async () => ({ ok: false, changed: false, reason: 'no_runner' }) })
  const seats = createSeatsSocket({ path: join(root, 'state', SEATS_SOCKET), target: socketPath, available: () => exists(entry) })
  const stderrLog = createChildStderrLog(join(root, 'state', 'approval-box-daemon-stderr.jsonl'))
  const env = () => ({ PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: home, APPROVAL_BOX_HOME: home, APPROVAL_BOX_SERVER: server })
  let child = null, closed = false, started = false, run = null
  const wait = ms => new Promise(resolve => { const timer = setTimer(resolve, ms); timer?.unref?.() })

  const lines = (stream, onLine) => {
    let pending = ''
    stream.setEncoding?.('utf8')
    stream.on('data', chunk => {
      pending += chunk
      for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) { const line = pending.slice(0, end); pending = pending.slice(end + 1); if (line) onLine(line) }
      if (pending.length > 65536) pending = ''
    })
  }
  const stopChild = target => new Promise(resolve => {
    if (!target || target.exitCode !== null || target.signalCode !== null) return resolve()
    const timer = setTimer(() => { try { target.kill('SIGKILL') } catch {} }, STOP_MS); timer?.unref?.()
    target.once('exit', () => { clearTimer(timer); resolve() })
    try { target.kill('SIGTERM') } catch { clearTimer(timer); resolve() }
  })

  const statusOnce = () => localCall(socketPath, 'GET', '/status', undefined, { connect })
  const recovery = createModuleChildRestart(() => launch(), 'approval-box-daemon', onModuleRestartLimit)
  async function launch() {
    if (closed) return
    await mkdir(home, { recursive: true, mode: 0o700 }); await chmod(home, 0o700)
    recovery.restarting()
    const target = spawn(node, [entry, 'daemon', '--hosted'], { env: env(), cwd: home, stdio: ['ignore', 'ignore', 'pipe'] })
    child = target
    lines(target.stderr, line => stderrLog.append('approval-box-daemon', line))
    target.once('exit', (code, signal) => {
      if (child === target) child = null
      if (closed) return
      recovery.exited({ code, signal }); recovery.lost()
    })
    target.once('error', () => { if (child === target) child = null })
    const deadline = now() + READY_MS
    for (;;) {
      if (closed || child !== target) throw failure('APPROVAL_BOX_DAEMON_EXITED')
      try { const reply = await statusOnce(); if (reply?.ok === true) break } catch {}
      if (now() >= deadline) { await stopChild(target); throw Object.assign(failure('APPROVAL_BOX_DAEMON_NOT_READY'), { code: 'READY_TIMEOUT' }) }
      await wait(250)
    }
    recovery.running()
  }

  // A failed line's own code names the cause (e.g. server_flag_off: the server shows no peer-channel, 11/27); only a plain slug passes, never the connector's free text.
  const reasonOf = line => { const text = `${line?.code ?? ''} ${line?.error ?? ''} ${line?.reason ?? ''}`.toLowerCase(); return text.includes('reject') ? 'rejected' : text.includes('expire') ? 'expired'
    : (line?.state === 'failed' || line?.type === 'failed') && /^[a-z][a-z0-9_]{0,39}$/u.test(line?.code ?? '') ? line.code : null }

  const controller = {
    home, socketPath,
    available: () => exists(entry),
    // Never waits for the daemon: a failed first start only registers the recovery (a500: an optional child must not hold the body).
    start() {
      if (started || closed || !exists(entry)) return
      started = true
      seats.start().then(() => { seatsReady = !closed }, () => {})
      seatEntries.start()
      launch().catch(() => { if (!closed) recovery.lost() })
    },
    async status({ withEgress = false } = {}) {
      const available = exists(entry)
      if (!available) return { available: false, running: false, daemon: null }
      let daemon = null, reachable = false
      try { const reply = await statusOnce(); reachable = reply?.ok === true; if (reachable) daemon = closedStatus(reply.result) } catch {}
      return { available: true, running: child !== null, reachable, daemon, seats: { path: seats.path, listening: seatsReady },
        pairing: run ? { state: run.state, startedAt: run.startedAt, lines: run.lines.map(safeLine) } : null,
        ...(withEgress ? { egress: await egress() } : {}) }
    },
    // Forward one local-API route to the daemon (the same decision routes as /connector/v1); the readers' base change comes later.
    async route(method, path, body) {
      if (!child) throw failure('APPROVAL_BOX_DAEMON_UNAVAILABLE')
      const reply = await localCall(socketPath, method, path, body, { timeoutMs: 10000, connect })
      // body: the box's structured error ({check_token, decisions} of confirm_required, {existing} of duplicate_suspected); the readers need it to file (a490f).
      if (reply?.ok !== true) throw Object.assign(failure(String(reply?.code ?? 'APPROVAL_BOX_DAEMON_REFUSED').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'APPROVAL_BOX_DAEMON_REFUSED', Number.isInteger(reply?.status) ? reply.status : 502),
        reply?.body && typeof reply.body === 'object' && !Array.isArray(reply.body) ? { body: reply.body } : {})
      return reply.result
    },
    // a516m: the daemon's reply as it is, for the seat door route on the remote seat listener (docs runtime/approval-box-daemon.md). Never throws: a daemon that is down or answers badly
    // is the same {ok:false,status:503} line the daemon itself would send. The reply bound is larger than route()'s because an attachment reply is base64 (up to 20 MiB of file).
    async call(method, path, body) {
      if (!child) return { ok: false, status: 503, code: 'APPROVAL_BOX_DAEMON_UNAVAILABLE', message: 'The body\'s Approval Box daemon is not running.' }
      try { return await localCall(socketPath, method, path, body, { timeoutMs: 30000, connect, maxReply: 64 * 1024 * 1024 }) }
      catch (error) { return { ok: false, status: 503, code: String(error?.code ?? 'APPROVAL_BOX_DAEMON_UNREACHABLE').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'APPROVAL_BOX_DAEMON_UNREACHABLE', message: 'The body\'s Approval Box daemon did not answer.' } }
    },
    // One `pair --json` run at a time. Returns the waiting line (with the secrets) to the caller only; nothing of it is logged.
    async pair({ rebind = false } = {}) {
      if (closed || !exists(entry)) throw failure('APPROVAL_BOX_DAEMON_UNAVAILABLE')
      if (run && ['starting', 'waiting', 'claimed'].includes(run.state)) {
        if (run.waiting) return run.waiting
        return run.first
      }
      await mkdir(home, { recursive: true, mode: 0o700 })
      const target = spawn(node, [entry, 'pair', '--json', ...(rebind ? ['--rebind'] : [])], { env: env(), cwd: home, stdio: ['ignore', 'pipe', 'ignore'] })
      const current = run = { state: 'starting', startedAt: new Date(now()).toISOString(), lines: [], waiting: null, first: null, process: target, timer: null }
      let resolveFirst, rejectFirst
      current.first = new Promise((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject })
      current.first.catch(() => {})
      const finish = state => { if (current.state === 'bound') return; current.state = state; clearTimer(current.timer) }
      lines(target.stdout, text => {
        let line
        try { line = JSON.parse(text) } catch { return }
        if (!line || typeof line !== 'object') return
        current.lines.push(line)
        const type = line?.type ?? line?.event ?? line?.state
        if (isWaiting(line) && !current.waiting) { current.waiting = line; current.state = 'waiting'; resolveFirst(line) }
        else if (type === 'claimed' && current.state !== 'bound') current.state = 'claimed'
        else if (type === 'bound' || (type === 'paired' && line.paired === true)) { current.state = 'bound'; clearTimer(current.timer) }
      })
      target.once('exit', code => {
        if (current.state !== 'bound') finish(current.state === 'starting' ? 'failed' : 'ended')
        if (!current.waiting) rejectFirst(failure(code === 0 ? 'PAIR_NO_WAITING_LINE' : 'PAIR_FAILED'))
      })
      target.once('error', () => { finish('failed'); rejectFirst(failure('PAIR_FAILED')) })
      current.timer = setTimer(() => { void stopChild(target) }, PAIR_MAX_MS); current.timer?.unref?.()
      const firstTimer = setTimer(() => { if (!current.waiting) { void stopChild(target); rejectFirst(failure('PAIR_NO_WAITING_LINE')) } }, PAIR_LINE_MS); firstTimer?.unref?.()
      try { return await current.first } finally { clearTimer(firstTimer) }
    },
    pairStatus() {
      if (!run) return { state: 'none', lines: [] }
      return { state: run.state, startedAt: run.startedAt, lines: run.lines.map(safeLine) }
    },
    async close() {
      if (closed) return
      closed = true
      recovery.close()
      seatEntries.close()
      seatsReady = false
      clearTimer(run?.timer)
      await Promise.all([stopChild(child), stopChild(run?.process), seats.close()])
      await stderrLog.flush()
    },
  }
  // P3 Pairing port (docs/architecture/modules/approval-box-extension/seats-on-hosted-daemon.md): the one pairing of the hosted connector, over the same `pair --json` run as pair().
  // none / waiting / linked / failed / removed. linked = the daemon says paired (mode 'pc'; the run's own 'bound' counts only while the daemon cannot be asked).
  // The waiting view carries the Owner's secrets and leaves only through the Owner's route. Nayuta 2026-11-26 (iOS claimPairing): the app wants both, in order: code (8 characters, shown ABCD-EFGH) in 接続 > AIをつなぐ > コードを確認, then typed_secret (16 characters) in the confirm sheet's field; without typed_secret there is no key binding and the daemon never reaches pc. The QR (qr_text) does both at once when it is on another screen.
  let wasLinked = false
  const pairingReason = () => { for (const line of run?.lines ?? []) { const reason = reasonOf(line); if (reason) return reason } return null }
  async function pairingView() {
    const reply = await statusOnce().catch(() => null)
    const linked = reply?.ok === true ? closedStatus(reply.result).mode === 'pc' : run?.state === 'bound'
    if (linked) { wasLinked = true; return { state: 'linked' } }
    if (run && ['starting', 'waiting', 'claimed'].includes(run.state)) {
      const line = run.waiting
      return line ? { state: 'waiting', code: String(line.code ?? '').slice(0, 64), typedSecret: String(line.typed_secret ?? '').slice(0, 64), qrText: String(line.qr_text ?? '').slice(0, 512),
        expiresAt: typeof line.expires_at === 'string' ? line.expires_at.slice(0, 40) : null } : { state: 'none' }
    }
    if (run?.stopped) return { state: 'none' }
    if (run && ['failed', 'ended'].includes(run.state)) return { state: 'failed', reason: pairingReason() ?? (run.state === 'failed' ? 'unavailable' : 'ended') }
    return wasLinked ? { state: 'removed' } : { state: 'none' }
  }
  controller.entries = seatEntries
  controller.pairing = {
    get: pairingView,
    async start() {
      const view = await pairingView()
      if (view.state === 'linked' || view.state === 'waiting') return view
      try { await controller.pair({ rebind: view.state === 'removed' }) }
      catch (error) { return { state: 'failed', reason: error?.code === 'PAIR_NO_WAITING_LINE' ? 'no_waiting_line' : pairingReason() ?? 'unavailable' } }
      return pairingView()
    },
    async stop() {
      if (run && ['starting', 'waiting'].includes(run.state)) { run.stopped = true; await stopChild(run.process) }
      return pairingView()
    },
  }
  return controller
}
