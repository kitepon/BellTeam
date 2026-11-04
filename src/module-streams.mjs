const CHUNK = 256 * 1024, CONTROL = 64 * 1024, WINDOW = 4, STREAMS = 8
const MAX_BODY = 96 * 1024 * 1024 + CONTROL
const lanes = new Set(['root', 'effect', 'callback', 'continuation', 'result', 'history'])
const reserved = lane => lane === 'callback' || lane === 'continuation'
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',')
const validId = value => Number.isSafeInteger(value) && value > 0
export const conversationStreamError = code => Object.assign(new Error(code), { code, outcome: 'unknown' })
const check = condition => { if (!condition) throw conversationStreamError('CONVERSATION_STREAM_INVALID') }

// Private conversation transport: the production channel supplies the closed method/authority validators.
export function createConversationStreams(endpoint, { onStream, onOpen = () => true, onControl, onFailure, idleMs = 60000, rpcFrames = false }) {
  const sending = new Map(), receiving = new Map(), slotWaiters = new Set()
  let nextId = 0, dead = null, controlBytes = 0, receivedControlBytes = 0
  const wakeSlots = () => { for (const wake of slotWaiters) wake(); slotWaiters.clear() }
  const failure = error => {
    if (dead) return
    dead = error
    for (const stream of [...sending.values(), ...receiving.values()]) {
      clearTimeout(stream.timer); stream.error = error
      if (stream.queue) stream.queue.length = 0
      stream.wake?.(); stream.reject?.(error)
    }
    receiving.clear()
    wakeSlots()
    try { onFailure?.(error) } catch {}
  }
  const send = frame => new Promise((resolve, reject) => {
    if (dead || !endpoint.connected) { reject(dead ?? conversationStreamError('CONVERSATION_IPC_DISCONNECTED')); return }
    try { endpoint.send(frame, error => error ? reject(error) : resolve()) } catch (error) { reject(error) }
  })
  const control = async frame => {
    const bytes = Buffer.byteLength(JSON.stringify(frame))
    check(bytes <= CONTROL && controlBytes + bytes <= 1024 * 1024)
    controlBytes += bytes
    try { await send(frame) } finally { controlBytes -= bytes }
  }
  const touch = stream => {
    clearTimeout(stream.timer)
    stream.timer = setTimeout(() => failure(conversationStreamError('CONVERSATION_STREAM_IDLE')), idleMs)
  }
  const canOpen = lane => sending.size < STREAMS && (reserved(lane)
    || [...sending.values()].filter(stream => !reserved(stream.lane)).length < 4)
  const openSlot = async (lane, id, stream) => {
    while (!canOpen(lane)) {
      if (!reserved(lane)) throw Object.assign(conversationStreamError('CONVERSATION_STREAM_BUSY'), { outcome: 'not_accepted' })
      await new Promise(resolve => slotWaiters.add(resolve))
      if (dead) throw dead
    }
    if (dead) throw dead
    sending.set(id, stream)
  }
  const write = async (chunks, { lane, operation, length = null }) => {
    check(lanes.has(lane) && validId(operation) && (length === null || Number.isSafeInteger(length) && length >= 0)
      && (lane === 'history' || length === null || length <= MAX_BODY))
    const id = ++nextId
    const stream = { lane, credit: 0, seq: 0, bytes: 0, error: null }
    await openSlot(lane, id, stream)
    const closed = new Promise((resolve, reject) => { stream.resolve = resolve; stream.reject = reject })
    closed.catch(() => {})
    touch(stream)
    try {
      await control({ type: 'open', stream: id, lane, operation, length })
      for await (const input of chunks) {
        check(Buffer.isBuffer(input))
        for (let start = 0; start < input.length; start += CHUNK) {
          while (!stream.credit && !stream.error) await new Promise(resolve => { stream.wake = resolve })
          if (stream.error) throw stream.error
          const data = input.subarray(start, start + CHUNK)
          stream.credit--; stream.bytes += data.length
          check(lane === 'history' || stream.bytes <= MAX_BODY)
          await send({ type: 'data', stream: id, seq: stream.seq++, data })
          touch(stream)
        }
      }
      check(length === null || stream.bytes === length)
      stream.sentEnd = true
      await control({ type: 'end', stream: id, seq: stream.seq, bytes: stream.bytes })
      touch(stream)
      await closed
    } catch (error) {
      if (!dead && (error.outcome !== 'not_accepted' || stream.bytes !== 0))
        await control({ type: 'abort', stream: id }).catch(() => {})
      if (error.outcome !== 'not_accepted' || stream.bytes !== 0) failure(error)
      throw error
    } finally { clearTimeout(stream.timer); sending.delete(id); wakeSlots() }
  }
  const read = async function* (id, stream) {
    let finished = false
    try {
      while (true) {
        while (!stream.queue.length && !stream.ended && !stream.error) await new Promise(resolve => { stream.wake = resolve })
        if (stream.error) throw stream.error
        if (!stream.queue.length && stream.ended) { finished = true; return }
        const data = stream.queue.shift()
        yield data
        // Credit follows consumer progress, not arrival or enqueueing.
        stream.credit++
        await control({ type: 'credit', stream: id, count: 1 }); touch(stream)
      }
    } finally {
      if (!finished && !dead) await control({ type: 'abort', stream: id }).catch(() => {})
      stream.queue.length = 0; clearTimeout(stream.timer); receiving.delete(id)
      if (!dead) await control({ type: 'closed', stream: id })
    }
  }
  const message = frame => {
    if (rpcFrames && ['call', 'accepted', 'result'].includes(frame?.type)) return
    if (dead) return
    try {
      if (frame?.type === 'control') {
        check(exact(frame, 'type,operation,seq,capability') && validId(frame.operation)
          && Number.isSafeInteger(frame.seq) && frame.seq >= 0 && typeof onControl === 'function')
        const bytes = Buffer.byteLength(JSON.stringify(frame))
        check(bytes <= CONTROL && receivedControlBytes + bytes <= 1024 * 1024)
        receivedControlBytes += bytes
        Promise.resolve().then(() => onControl(frame)).catch(failure).finally(() => { receivedControlBytes -= bytes })
        return
      }
      check(frame && validId(frame.stream))
      if (frame.type !== 'data') check(Buffer.byteLength(JSON.stringify(frame)) <= CONTROL)
      if (frame.type === 'open') {
        check(exact(frame, 'type,stream,lane,operation,length') && lanes.has(frame.lane) && validId(frame.operation)
          && (frame.length === null || Number.isSafeInteger(frame.length) && frame.length >= 0)
          && (frame.lane === 'history' || frame.length === null || frame.length <= MAX_BODY)
          && !receiving.has(frame.stream) && frame.stream > lastReceived)
        lastReceived = frame.stream
        check(receiving.size < STREAMS && (reserved(frame.lane)
          || [...receiving.values()].filter(stream => !reserved(stream.lane)).length < 4))
        if (!onOpen({ lane: frame.lane, operation: frame.operation, length: frame.length })) {
          void control({ type: 'rejected', stream: frame.stream }).catch(failure)
          return
        }
        const stream = { lane: frame.lane, length: frame.length, queue: [], credit: WINDOW, seq: 0, bytes: 0, ended: false, error: null }
        receiving.set(frame.stream, stream); touch(stream)
        const chunks = read(frame.stream, stream)
        Promise.resolve().then(async () => {
          await control({ type: 'credit', stream: frame.stream, count: WINDOW })
          await onStream({ lane: frame.lane, operation: frame.operation, length: frame.length }, chunks)
          // A handler may not silently leave unread data or an unclosed reader.
          if (receiving.has(frame.stream)) { await chunks.return(); throw conversationStreamError('CONVERSATION_STREAM_UNCONSUMED') }
        }).catch(failure)
      } else if (frame.type === 'data') {
        const stream = receiving.get(frame.stream)
        check(exact(frame, 'type,stream,seq,data') && stream && !stream.ended && frame.seq === stream.seq
          && Buffer.isBuffer(frame.data) && frame.data.length > 0 && frame.data.length <= CHUNK && stream.credit > 0)
        stream.seq++; stream.credit--; stream.bytes += frame.data.length
        check(stream.lane === 'history' || stream.bytes <= MAX_BODY)
        stream.queue.push(frame.data); stream.wake?.(); touch(stream)
      } else if (frame.type === 'rejected') {
        const stream = sending.get(frame.stream)
        check(exact(frame, 'type,stream') && stream && stream.bytes === 0 && stream.credit === 0)
        stream.error = Object.assign(conversationStreamError('CONVERSATION_STREAM_BUSY'), { outcome: 'not_accepted' })
        stream.reject(stream.error); stream.wake?.(); clearTimeout(stream.timer)
      } else if (frame.type === 'credit') {
        const stream = sending.get(frame.stream)
        check(exact(frame, 'type,stream,count') && stream && Number.isInteger(frame.count) && frame.count > 0
          && stream.credit + frame.count <= WINDOW)
        stream.credit += frame.count; stream.wake?.(); touch(stream)
      } else if (frame.type === 'end') {
        const stream = receiving.get(frame.stream)
        check(exact(frame, 'type,stream,seq,bytes') && stream && !stream.ended && frame.seq === stream.seq
          && frame.bytes === stream.bytes && (stream.length === null || stream.length === stream.bytes))
        stream.ended = true; stream.wake?.(); touch(stream)
      } else if (frame.type === 'closed') {
        const stream = sending.get(frame.stream)
        check(exact(frame, 'type,stream') && stream && stream.sentEnd && !stream.closed)
        stream.closed = true
        stream.resolve(); clearTimeout(stream.timer)
      } else if (frame.type === 'abort') {
        check(exact(frame, 'type,stream') && (sending.has(frame.stream) || receiving.has(frame.stream)))
        failure(conversationStreamError('CONVERSATION_STREAM_ABORTED'))
      } else throw conversationStreamError('CONVERSATION_STREAM_INVALID')
    } catch (error) { failure(error) }
  }
  let lastReceived = 0
  endpoint.on('message', message)
  const disconnected = () => failure(conversationStreamError('CONVERSATION_IPC_DISCONNECTED'))
  endpoint.on('disconnect', disconnected)
  return { write, control: frame => {
    check(exact(frame, 'type,operation,seq,capability') && frame.type === 'control' && validId(frame.operation)
      && Number.isSafeInteger(frame.seq) && frame.seq >= 0)
    return control(frame)
  }, close: () => {
    endpoint.off('message', message); endpoint.off('disconnect', disconnected); disconnected()
  }, snapshot: () => ({ sending: sending.size, receiving: receiving.size, controlBytes, receivedControlBytes,
    unconsumedBytes: [...receiving.values()].reduce((total, stream) => total + stream.queue.reduce((sum, data) => sum + data.length, 0), 0) }) }
}

// One snapshot, one incremental encoding; never stringify the whole history array.
// 小さな断片を1つずつ送ると、断片ごとに1枠と受領待ちが生じ、27MBの履歴で20秒を超える。枠の上限までまとめて渡す。
export async function* encodeConversationJson(value) {
  let parts = [], size = 0
  for await (const part of encodeJsonParts(value)) {
    parts.push(part); size += part.length
    if (size >= CHUNK) { yield Buffer.concat(parts, size); parts = []; size = 0 }
  }
  if (size) yield Buffer.concat(parts, size)
}
async function* encodeJsonParts(value) {
  if (value === null || typeof value !== 'object') {
    const text = JSON.stringify(value)
    if (text === undefined) throw conversationStreamError('CONVERSATION_JSON_INVALID')
    const bytes = Buffer.from(text)
    for (let offset = 0; offset < bytes.length; offset += CHUNK) yield bytes.subarray(offset, offset + CHUNK)
  } else if (Array.isArray(value) || value[Symbol.asyncIterator]) {
    yield Buffer.from('[')
    let comma = false
    for await (const item of value) {
      if (comma) yield Buffer.from(',')
      yield* encodeJsonParts(item); comma = true
    }
    yield Buffer.from(']')
  } else {
    yield Buffer.from('{')
    let comma = false
    for (const key of Object.keys(value)) {
      if (value[key] === undefined) continue
      if (comma) yield Buffer.from(',')
      yield Buffer.from(JSON.stringify(key) + ':')
      yield* encodeJsonParts(value[key]); comma = true
    }
    yield Buffer.from('}')
  }
}

export async function readConversationJson(chunks, maxBytes = MAX_BODY) {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let text = '', size = 0
  for await (const chunk of chunks) {
    size += chunk.length
    if (size > maxBytes) throw conversationStreamError('CONVERSATION_BODY_TOO_LARGE')
    text += decoder.decode(chunk, { stream: true })
  }
  text += decoder.decode()
  return JSON.parse(text)
}

export { createConversationStreams as createModuleStreams, encodeConversationJson as encodeModuleJson, readConversationJson as readModuleJson }
