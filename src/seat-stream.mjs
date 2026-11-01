import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { seatCommandSpec } from './seat-command.mjs'

const failure = (code, fields = {}) => Object.assign(new Error(code), { code, ...fields })

// A short-lived seat file reader. One JSON metadata line precedes binary
// stdout; the body stays a backpressured stream, without a whole-file buffer.
export function createSeatStreamRunner(project, { environment = 'base', spawnProcess = spawn } = {}) {
  seatCommandSpec('true', [], { project, environment })
  return async (command, args, input, { signal } = {}) => {
    if (signal?.aborted) throw failure('ABORT_ERR', { name: 'AbortError' })
    const spec = seatCommandSpec(command, args, { project, environment })
    const child = spawnProcess(spec.command, spec.args, { env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let closed = false, processError = null
    const completed = new Promise(resolve => {
      child.once('error', error => { processError = error })
      child.once('close', (code, exitSignal) => {
        closed = true; signal?.removeEventListener('abort', stop)
        resolve({ code, signal: exitSignal, error: processError })
      })
    })
    const stop = () => { if (!closed) child.kill('SIGTERM') }
    signal?.addEventListener('abort', stop, { once: true })
    if (signal?.aborted) stop()
    child.stdin.on('error', error => { processError ??= error; stop() })
    // Drain stderr; no private file contents or paths are reflected as output.
    child.stderr.resume()
    child.stdin.end(JSON.stringify(input))
    const iterator = child.stdout[Symbol.asyncIterator]()
    let buffered = Buffer.alloc(0), metadata, remainder
    try {
      while (true) {
        const { value, done } = await iterator.next()
        if (done) throw failure('SEAT_STREAM_METADATA_MISSING')
        buffered = Buffer.concat([buffered, value])
        const end = buffered.indexOf(10)
        if (end < 0 && buffered.length > 16384 || end > 16384) throw failure('SEAT_STREAM_METADATA_INVALID')
        if (end < 0) continue
        const header = JSON.parse(buffered.subarray(0, end).toString())
        if (header.error) throw Object.assign(new Error(header.error.message), header.error)
        metadata = header.result
        if (!metadata || !Number.isSafeInteger(metadata.size) || metadata.size < 0
          || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(metadata.mime))
          throw failure('SEAT_STREAM_METADATA_INVALID')
        remainder = buffered.subarray(end + 1)
        break
      }
    } catch (error) {
      stop(); child.stdout.resume(); await completed
      if (signal?.aborted) throw failure('ABORT_ERR', { name: 'AbortError' })
      throw error
    }
    const stream = Readable.from((async function* () {
      let bytes = 0, tail = Buffer.alloc(0)
      try {
        const chunks = (async function* () {
          if (remainder.length) yield remainder
          for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) yield chunk
        })()
        for await (const chunk of chunks) {
          if (!chunk.length) continue
          bytes += chunk.length
          if (bytes > metadata.size) throw failure('SEAT_STREAM_SIZE_CHANGED')
          // Hold the final byte until process success and exact length are
          // known, so Content-Length cannot declare a failed read complete.
          if (tail.length) yield tail
          if (chunk.length > 1) yield chunk.subarray(0, -1)
          tail = chunk.subarray(-1)
        }
        const result = await completed
        if (result.error || result.code !== 0 || result.signal) throw failure('SEAT_STREAM_PROCESS_FAILED')
        if (bytes !== metadata.size) throw failure('SEAT_STREAM_SIZE_CHANGED')
        if (tail.length) yield tail
      } finally { stop(); await completed }
    })(), { objectMode: false })
    stream.once('close', stop)
    return { ...metadata, stream }
  }
}
