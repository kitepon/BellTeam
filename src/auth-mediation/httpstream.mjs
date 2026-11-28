// The streaming http op (README F23): same item, grant, path rules and credential as 'http', but the response is piped to the caller as frames on the relay's per-run stream socket
// (tag 5 = {status, headers} first, tag 1 = body bytes as they come, tag 4 = heartbeat, tag 3 = end code). Every secret is replaced in the stream too (a secret split across two chunks is caught by a carry-over).
import { connect as netConnect } from 'node:net'

const frame = (tag, data) => { const head = Buffer.alloc(5); head[0] = tag; head.writeUInt32BE(data.length, 1); return Buffer.concat([head, data]) }
export const HTTP_STREAM_MAX_SECONDS = 3600

export function makeScrubber(secrets) {
  const needles = secrets.filter(s => typeof s === 'string' && s.length >= 6).flatMap(s => [s, Buffer.from(s).toString('base64')]).map(s => Buffer.from(s, 'latin1'))
  const most = Math.max(0, ...needles.map(n => n.length)) - 1
  // Only the tail of the data that could still grow into a secret is held back (the longest suffix that is a proper prefix of a needle), so a plain event is never delayed.
  const held = all => { for (let k = Math.min(most, all.length); k > 0; k--) { const tail = all.subarray(all.length - k); if (needles.some(n => n.length > k && n.compare(tail, 0, k, 0, k) === 0)) return k } return 0 }
  let carry = Buffer.alloc(0)
  const clean = buf => needles.reduce((out, n) => { let at; while ((at = out.indexOf(n)) >= 0) out = Buffer.concat([out.subarray(0, at), Buffer.from('[redacted]'), out.subarray(at + n.length)]); return out }, buf)
  return {
    push(chunk) { const all = clean(Buffer.concat([carry, chunk])); const cut = all.length - held(all); carry = all.subarray(cut); return all.subarray(0, cut) },
    end() { const out = clean(carry); carry = Buffer.alloc(0); return out },
  }
}

// result: callHttp's streaming answer {status, headers, response, secrets}; controller: its AbortController (aborted when the caller hangs up).
export async function pipeHttpStream(result, { stream, controller, connect = netConnect, heartbeatMs = 15000 }) {
  const socket = await new Promise((resolve, reject) => { const s = connect({ path: stream, allowHalfOpen: true }); s.once('connect', () => resolve(s)); s.once('error', () => reject(new Error('The caller is gone.'))) })
  socket.on('error', () => controller.abort()); socket.on('close', () => controller.abort()); socket.on('data', () => {})
  const beat = setInterval(() => { try { socket.write(frame(4, Buffer.alloc(0))) } catch {} }, heartbeatMs)
  const scrubber = makeScrubber(result.secrets); let code = '0'
  try {
    socket.write(frame(5, Buffer.from(JSON.stringify({ status: result.status, headers: result.headers }))))
    if (result.response.body) for await (const chunk of result.response.body) {
      const out = scrubber.push(Buffer.from(chunk))
      if (out.length && !socket.write(frame(1, out))) {
        await new Promise((resolve, reject) => {
          const done = () => { socket.off('drain', onDrain); socket.off('close', onEnd); socket.off('error', onEnd) }
          const onDrain = () => { done(); resolve() }
          const onEnd = () => { done(); reject(new Error('The caller is gone.')) }
          if (socket.destroyed || socket.writableEnded) return onEnd()
          socket.once('drain', onDrain); socket.once('close', onEnd); socket.once('error', onEnd)
        })
      }
    }
    const tail = scrubber.end(); if (tail.length) socket.write(frame(1, tail))
  } catch { code = '2'; try { const tail = scrubber.end(); if (tail.length) socket.write(frame(1, tail)) } catch {} } finally { clearInterval(beat); try { socket.write(frame(3, Buffer.from(code))); socket.end() } catch {} }
}
