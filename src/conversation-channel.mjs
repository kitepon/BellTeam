import { createConversationStreams, encodeConversationJson, readConversationJson } from './conversation-streams.mjs'
import { createConversationInputBudget } from './conversation-input.mjs'
import { MODULE_CONCURRENCY } from './module-ipc.mjs'

export const conversationChannelError = (code, outcome = 'unknown', status = 503) => Object.assign(new Error(code), { code, outcome, status })
export const channelCheck = value => { if (!value) throw conversationChannelError('CONVERSATION_IPC_INVALID') }
export const exactChannelKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',')
const deferred = () => { const d = Promise.withResolvers(); d.promise.catch(() => {}); return d }
const kinds = new Set(['root', 'effect', 'callback', 'event', 'diagnostic', 'control'])
const code = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/u.test(value)
const safeError = error => {
  const candidate = error?.code ?? error?.message?.split(':')[0]
  return { code: code(candidate) ? candidate : 'CONVERSATION_OPERATION_FAILED',
    outcome: error?.outcome === 'not_accepted' ? 'not_accepted' : 'unknown',
    status: Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 503 }
}
const historyMethods = ['history.listMessages', 'history.listRoomMessages', 'history.page', 'history.recentBatch']
const streamLane = kind => ['control', 'effect', 'event', 'diagnostic'].includes(kind) ? 'continuation' : kind
async function encodedLength(value) {
  let size = 0
  for await (const chunk of encodeConversationJson(value)) size += chunk.length
  return size
}

// Only conversation envelopes live here; byte/credit/UTF8 handling is Epi's shared stream implementation.
export function createConversationPeer(endpoint, { side, accept, validateResult, onControl, onDisconnect, afterResponse = async () => {} }) {
  let sequence = side === 'parent' ? -1 : 0, sent = 0, received = 0, incoming = 0, dead = false, ordinaryStreams = 0
  const pending = new Map(), running = new Map(), counts = Object.fromEntries([...kinds].map(kind => [kind, 0]))
  const inbound = { ...counts }, waiters = new Set(), budget = createConversationInputBudget(), incomingWork = new Set()
  let streams
  const trackIncoming = run => {
    const work = (async () => run())()
    incomingWork.add(work)
    void work.finally(() => incomingWork.delete(work)).catch(() => {})
    return work
  }
  const wake = () => { for (const resolve of waiters) resolve(); waiters.clear() }
  const release = (record, outbound) => {
    if (record.released) return
    record.released = true; (outbound ? counts : inbound)[record.kind]--; wake()
  }
  const finishEntry = entry => {
    if (entry.finished) return
    entry.finished = true; running.delete(entry.id); release(entry, false); entry.finish?.()
  }
  const fail = cause => {
    if (dead) return
    dead = true
    const error = cause ?? conversationChannelError('CONVERSATION_IPC_DISCONNECTED')
    for (const task of pending.values()) { clearTimeout(task.ack); clearTimeout(task.timer); task.result.reject(error); task.admitted.reject(error); task.acknowledgement.reject(error) }
    for (const entry of running.values()) if (!entry.bodyStarted && !entry.executing) finishEntry(entry)
    for (const entry of running.values()) entry.replyReady?.reject(error)
    streams?.close()
    if (endpoint.connected) endpoint.disconnect()
    wake(); onDisconnect?.(error)
  }
  const control = (operation, capability) => streams.control({ type: 'control', operation, seq: sent++, capability })
  const write = async (chunks, meta) => {
    const ordinary = !['callback', 'continuation'].includes(meta.lane)
    if (ordinary) {
      while (ordinaryStreams >= 4 || streams.snapshot().sending >= 8) { await new Promise(resolve => waiters.add(resolve)); channelCheck(!dead) }
      ordinaryStreams++
    }
    try { return await streams.write(chunks, meta) }
    finally { if (ordinary) ordinaryStreams--; wake() }
  }
  const touch = task => {
    clearTimeout(task.timer)
    if (task.nativeWait) return
    if (task.timeout > 0) {
      task.timer = setTimeout(() => {
        let continuation
        if (side === 'parent' && task.kind === 'root' && task.method === 'user.turn' && task.admittedSeen) {
          try { continuation = task.getNativeContinuation?.() } catch {}
        }
        if (!(continuation instanceof Promise)) { task.result.reject(conversationChannelError('CONVERSATION_IPC_TIMEOUT')); return }
        task.nativeWait = continuation
        const settled = () => {
          task.nativeWait = null
          if (!dead && pending.get(task.id) === task) touch(task)
        }
        continuation.then(settled, settled)
      }, task.timeout)
      task.timer.unref?.()
    }
  }
  const finish = async (task, error, value) => {
    try { await task.body.promise } catch (cause) { if (cause.outcome !== 'not_accepted') { fail(cause); return }; error ??= cause }
    if (dead) return
    pending.delete(task.id); release(task, true)
    clearTimeout(task.ack); clearTimeout(task.timer)
    if (error) { task.result.reject(error); task.admitted.reject(error); task.completion.reject(error) }
    else { task.result.resolve(value); task.completion.resolve(value) }
  }
  const reply = async (entry, value) => {
    if (entry.kind === 'control') return control(entry.id, { type: 'control-result', value })
    entry.replyReady = deferred()
    const acknowledged = async metadata => {
      await control(entry.id, metadata)
      const timer = setTimeout(() => entry.replyReady.reject(conversationChannelError('CONVERSATION_IPC_ACK_TIMEOUT')), 5000)
      timer.unref?.()
      try { await entry.replyReady.promise } finally { clearTimeout(timer) }
    }
    if (historyMethods.includes(entry.method)) {
      channelCheck(value?.[Symbol.asyncIterator])
      await acknowledged({ type: 'result', kind: entry.kind, stream: 'history', length: null })
      await write(encodeConversationJson(value), { lane: 'history', operation: entry.id })
    } else {
      const lane = entry.kind === 'root' ? 'result' : 'continuation', length = await encodedLength(value)
      await acknowledged({ type: 'result', kind: entry.kind, stream: lane, length })
      await write(encodeConversationJson(value), { lane, operation: entry.id, length })
    }
  }
  const execute = async (entry, params) => {
    entry.executing = true
    try {
      const result = entry.run(params)
      if (entry.kind === 'root' && entry.method === 'user.turn') {
        channelCheck(result?.accepted instanceof Promise)
        void result.accepted.then(async value => {
          validateResult('accepted', entry.method, value)
          await control(entry.id, { type: 'admitted', value }); release(entry, false)
        }, () => {}).catch(error => fail(error))
      }
      const value = await result
      await reply(entry, value)
      await afterResponse(entry, value)
    } catch (error) {
      if (!dead) await control(entry.id, { type: 'error', kind: entry.kind, error: safeError(error) }).catch(fail)
    } finally { finishEntry(entry) }
  }
  streams = createConversationStreams(endpoint, {
    onFailure: fail,
    onControl: frame => trackIncoming(async () => {
      channelCheck(!dead)
      channelCheck(frame.seq === received++)
      const value = frame.capability, id = frame.operation
      if (value?.type === 'call') {
        channelCheck(exactChannelKeys(value, value.stream ? 'type,kind,method,context,source,stream,length' : 'type,kind,method,context,source,stream,params')
          && kinds.has(value.kind) && typeof value.method === 'string' && value.method.length <= 128 && id > incoming)
        incoming = id
        if (inbound[value.kind] >= (['root', 'effect', 'callback', 'event'].includes(value.kind) ? MODULE_CONCURRENCY : 16)) {
          await control(id, { type: 'error', kind: value.kind, error: safeError(conversationChannelError('CONVERSATION_IPC_CAPACITY', 'not_accepted')) }); return
        }
        const entry = { ...value, id, released: false }
        let operation
        try { operation = accept(entry) }
        catch (error) { await control(id, { type: 'error', kind: value.kind, error: { ...safeError(error), outcome: 'not_accepted' } }); return }
        entry.run = operation; entry.finish = operation.finish
        inbound[entry.kind]++; running.set(id, entry)
        await control(id, { type: 'accepted', kind: entry.kind })
        if (!entry.stream && !dead) void trackIncoming(() => execute(entry, entry.params)).catch(fail)
      } else if (value?.type === 'accepted') {
        channelCheck(exactChannelKeys(value, 'type,kind'))
        const task = pending.get(id); channelCheck(task && task.kind === value.kind && !task.acknowledged)
        task.acknowledged = true; task.acknowledgement.resolve(); clearTimeout(task.ack); touch(task)
      } else if (value?.type === 'admitted') {
        channelCheck(exactChannelKeys(value, 'type,value'))
        const task = pending.get(id); channelCheck(task?.kind === 'root' && task.method === 'user.turn' && task.acknowledged && !task.admittedSeen)
        validateResult('accepted', task.method, value.value)
        task.admittedSeen = true; task.admitted.resolve(value.value); release(task, true); touch(task)
      } else if (value?.type === 'control-result') {
        channelCheck(exactChannelKeys(value, 'type,value'))
        const task = pending.get(id); channelCheck(task?.kind === 'control' && task.acknowledged && !task.reply)
        validateResult(task.kind, task.method, value.value, task); task.reply = value
        void finish(task, null, value.value)
      } else if (value?.type === 'result') {
        channelCheck(exactChannelKeys(value, 'type,kind,stream,length'))
        const task = pending.get(id); channelCheck(task && task.kind === value.kind && task.acknowledged && !task.reply)
        channelCheck(value.stream === (task.kind === 'root' ? historyMethods.includes(task.method) ? 'history' : 'result' : 'continuation'))
        task.reply = value; touch(task)
        await control(id, { type: 'result-ready', kind: task.kind })
      } else if (value?.type === 'result-ready') {
        channelCheck(exactChannelKeys(value, 'type,kind'))
        const entry = running.get(id)
        channelCheck(entry?.kind === value.kind && entry.replyReady && !entry.replyAcknowledged)
        entry.replyAcknowledged = true; entry.replyReady.resolve()
      } else if (value?.type === 'error') {
        channelCheck(exactChannelKeys(value, 'type,kind,error') && exactChannelKeys(value.error, 'code,outcome,status')
          && code(value.error.code) && ['unknown', 'not_accepted'].includes(value.error.outcome)
          && Number.isInteger(value.error.status) && value.error.status >= 400 && value.error.status <= 599)
        const task = pending.get(id); channelCheck(task && task.kind === value.kind && !task.reply)
        task.reply = value
        const error = Object.assign(new Error(value.error.code), value.error)
        if (!task.acknowledged) task.acknowledgement.reject(error)
        void finish(task, error)
      } else await onControl?.(value)
    }),
    onOpen: meta => {
      const entry = running.get(meta.operation)
      if (entry && entry.stream === meta.lane && entry.length === meta.length && !entry.bodyStarted) {
        if (!budget.claim(meta)) {
          finishEntry(entry)
          void control(entry.id, { type: 'error', kind: entry.kind, error: safeError(conversationChannelError('CONVERSATION_INPUT_BUSY', 'not_accepted')) }).catch(fail)
          return false
        }
        entry.bodyStarted = true; return true
      }
      const task = pending.get(meta.operation)
      if (task?.reply?.stream === meta.lane && task.reply.length === meta.length && !task.bodyStarted) { task.bodyStarted = true; return true }
      return false
    },
    onStream: (meta, chunks) => trackIncoming(async () => {
      const entry = running.get(meta.operation)
      if (entry && entry.stream === meta.lane) {
        try { await execute(entry, await (meta.lane === 'root' ? budget.read(meta, chunks) : readConversationJson(chunks))) }
        finally { budget.release(meta); finishEntry(entry) }
      } else {
        const task = pending.get(meta.operation); channelCheck(task?.bodyStarted)
        let value
        if (meta.lane === 'history') {
          channelCheck(typeof task.onChunk === 'function')
          for await (const chunk of chunks) { await task.onChunk(chunk); touch(task) }
          value = { streamed: true }
        } else { value = await readConversationJson(chunks); validateResult(task.kind, task.method, value, task) }
        void finish(task, null, value)
      }
    }),
  })
  endpoint.on('error', fail)
  function call(kind, method, params, { context = null, source = null, beforeSend, onChunk, getNativeContinuation, timeout = 60000 } = {}) {
    const task = { id: sequence += 2, kind, method, params, context, source, timeout, onChunk, getNativeContinuation,
      result: deferred(), completion: deferred(), admitted: deferred(), body: deferred(), acknowledgement: deferred(), released: false }
    const result = task.result.promise
    result.completion = task.completion.promise
    if (kind === 'root' && method === 'user.turn') result.accepted = task.admitted.promise
    try {
      channelCheck(!dead && endpoint.connected && kinds.has(kind))
      if (counts[kind] >= (['root', 'effect', 'callback', 'event'].includes(kind) ? MODULE_CONCURRENCY : 16))
        throw conversationChannelError('CONVERSATION_IPC_CAPACITY', 'not_accepted')
      if (typeof context === 'function') task.context = context(task.id)
      beforeSend?.(task.completion.promise, task.context, task.id)
      pending.set(task.id, task)
      void (async () => {
        counts[kind]++
        const inline = ['event', 'diagnostic'].includes(kind) || kind === 'control' && method !== 'initialize'
        const lane = inline ? null : streamLane(kind), length = inline ? null : await encodedLength(params)
        task.ack = setTimeout(() => task.acknowledgement.reject(conversationChannelError('CONVERSATION_IPC_ACK_TIMEOUT')), 5000); task.ack.unref?.()
        touch(task)
        await control(task.id, { type: 'call', kind, method, context: task.context, source, stream: lane,
          ...(inline ? { params } : { length }) })
        await task.acknowledgement.promise
        if (lane) await write(encodeConversationJson(params), { lane, operation: task.id, length })
        task.body.resolve()
      })().catch(error => {
        task.body.reject(error)
        const reported = task.reply?.type === 'error' ? Object.assign(new Error(task.reply.error.code), task.reply.error) : error
        task.result.reject(reported); task.admitted.reject(reported)
        if (error.outcome !== 'not_accepted') fail(error)
        else if (!task.acknowledged) void finish(task, error)
      })
    } catch (error) { task.body.reject(error); task.result.reject(error); task.admitted.reject(error); task.completion.reject(error) }
    return result
  }
  return { call, control: capability => control(1, capability), pending, running,
    async drainIncoming() { while (incomingWork.size) await Promise.allSettled([...incomingWork]) },
    progress: id => { const task = pending.get(id); if (task) touch(task) },
    reaped() { fail(); for (const task of pending.values()) task.completion.reject(conversationChannelError('CONVERSATION_CHILD_EXITED')); pending.clear() },
    close() { streams.close(); if (endpoint.connected) endpoint.disconnect() },
    fail, snapshot: () => ({ ...counts, inbound: { ...inbound }, pending: pending.size, running: running.size, ...streams.snapshot() }),
  }
}
