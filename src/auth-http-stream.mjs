import { connect } from 'node:net'
import { Readable } from 'node:stream'

// The BellTeam body's own caller socket of the auth-mediation module (restricted: 0660, group of the body; seats cannot open it).
export const AUTH_BODY_SOCKET = '/srv/bellteam/shared/tools/auth-mediation/callers/bellteam-body/bellteam-body.sock'
const REFUSED = new Set(['denied', 'unknown-caller', 'not-registered'])
const fail = code => Object.assign(new Error(code), { code })

// One request to the module's http-stream (F23): the module adds the item's credential, the relay never holds it.
// Line out: {op:'http-stream', name, method, path, headers?, body? (base64)}. Line in: {outcome}. Then frames [tag][length, 4 bytes big-endian][data]:
// tag 5 {status, headers}, tag 1 body bytes, tag 4 heartbeat, tag 3 end. Resolves {status, headers, body (Readable), abort()} at the status frame.
// Rejects CALL_BRIDGE_AUTH_FAILED when the module refuses this caller, CALL_BRIDGE_UNREACHABLE for everything else before the status frame.
// After the status frame a cut connection destroys body with CALL_BRIDGE_UNREACHABLE (the caller tears its own response down so the client reconnects).
export function authHttpStream({ socket = process.env.BELLTEAM_AUTH_BODY_SOCKET ?? AUTH_BODY_SOCKET, name, answerMs = 15000 } = {}) {
  return ({ method, path, headers = {}, body = Buffer.alloc(0) }) => new Promise((resolve, reject) => {
    const connection = connect(socket)
    const stream = new Readable({ read() { connection.resume() } })
    let pending = Buffer.alloc(0), answered = false, headed = false, ended = false
    const finish = code => {
      clearTimeout(timer)
      if (headed) { if (!ended) stream.destroy(fail(code)) } else reject(fail(code))
      connection.destroy()
    }
    const timer = setTimeout(() => finish('CALL_BRIDGE_UNREACHABLE'), answerMs)
    connection.on('error', () => finish('CALL_BRIDGE_UNREACHABLE'))
    connection.on('close', () => finish('CALL_BRIDGE_UNREACHABLE'))
    connection.on('connect', () => connection.write(JSON.stringify({ op: 'http-stream', name, method, path, headers,
      ...(body.length ? { body: Buffer.from(body).toString('base64') } : {}) }) + '\n'))
    stream.on('close', () => connection.destroy())
    connection.on('data', chunk => {
      pending = Buffer.concat([pending, chunk])
      if (!answered) {
        const end = pending.indexOf(10)
        if (end < 0) return pending.length > 65536 ? finish('CALL_BRIDGE_UNREACHABLE') : undefined
        let line
        try { line = JSON.parse(pending.subarray(0, end).toString('utf8')) } catch { return finish('CALL_BRIDGE_UNREACHABLE') }
        pending = pending.subarray(end + 1)
        if (line?.outcome !== 'granted') return finish(REFUSED.has(line?.outcome) ? 'CALL_BRIDGE_AUTH_FAILED' : 'CALL_BRIDGE_UNREACHABLE')
        answered = true
      }
      while (pending.length >= 5) {
        const tag = pending[0], length = pending.readUInt32BE(1)
        if (pending.length < 5 + length) break
        const data = pending.subarray(5, 5 + length)
        pending = pending.subarray(5 + length)
        if (tag === 5 && !headed) {
          let info
          try { info = JSON.parse(data.toString('utf8')) } catch { return finish('CALL_BRIDGE_UNREACHABLE') }
          if (!Number.isInteger(info?.status) || info.status < 100 || info.status > 599) return finish('CALL_BRIDGE_UNREACHABLE')
          headed = true
          clearTimeout(timer)
          resolve({ status: info.status, headers: info.headers ?? {}, body: stream, abort: () => { connection.destroy(); stream.destroy() } })
        } else if (tag === 1 && headed) { if (!stream.push(Buffer.from(data))) connection.pause() }
        else if (tag === 3) { ended = true; stream.push(null); connection.end(); return }
      }
    })
  })
}
