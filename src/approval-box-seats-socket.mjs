import { createConnection, createServer } from 'node:net'
import { chmod, mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

// The seats' door to the hosted Approval Box daemon (docs/architecture/modules/runtime/approval-box-daemon.md, a514m).
// The daemon runs as the body's uid with a 0700 state directory; the seats (uid 1000) cannot open its socket. This relay listens where they can
// and passes each request line to the daemon's socket and the one reply line back. It reads nothing and keeps nothing: the daemon's own
// socket protocol (one NDJSON line, one reply, 32 MiB cap) and its answers are unchanged.
const MAX_CONNECTIONS = 64, IDLE_MS = 30000
const reply = (code, message) => JSON.stringify({ ok: false, status: 503, code, message }) + '\n'

export function createSeatsSocket({ path, target, available = () => true, connect = createConnection }) {
  let server = null
  const open = new Set()
  const relay = seat => {
    open.add(seat)
    const end = () => { open.delete(seat); seat.destroy() }
    seat.setTimeout(IDLE_MS, end)
    seat.on('error', end); seat.on('close', () => open.delete(seat))
    const daemon = connect(target)
    // The daemon is down or restarting: the seat gets the same error shape the daemon answers, so its tool names the cause.
    daemon.on('error', () => { daemon.destroy(); if (!seat.destroyed) seat.end(reply('APPROVAL_BOX_DAEMON_UNAVAILABLE', 'The body\'s Approval Box daemon is not running.')) })
    seat.on('close', () => daemon.destroy()) // the daemon's end reaches the seat through the pipe; its socket ends after one reply
    seat.pipe(daemon); daemon.pipe(seat)
  }
  return {
    path,
    // Never waits for the daemon (a500). No package in the image (dev, tests): no socket.
    async start() {
      if (server || !available()) return
      await mkdir(dirname(path), { recursive: true, mode: 0o711 })
      await rm(path, { force: true }) // our own stale socket from the last run
      const next = createServer(relay)
      next.maxConnections = MAX_CONNECTIONS
      await new Promise((resolve, reject) => { next.once('error', reject); next.listen(path, resolve) })
      // Open to every user of this container on purpose: all seats are uid 1000 with sudo and already share one connector identity (a124 residual); only this socket is open, never the daemon's directory.
      await chmod(path, 0o666)
      server = next
    },
    async close() {
      const current = server; server = null
      for (const seat of open) seat.destroy()
      if (current) await new Promise(resolve => current.close(resolve))
      await rm(path, { force: true })
    },
  }
}
