import { isDeepStrictEqual } from 'node:util'
import { validateConversationEffect } from './conversation/effects.mjs'

const error = () => Object.assign(new Error('CONVERSATION_BACKGROUND_UNCONFIRMED'), {
  code: 'CONVERSATION_BACKGROUND_UNCONFIRMED', outcome: 'unknown', status: 503,
})
const check = value => { if (!value) throw error() }
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === fields.split(',').sort().join(',')
const deferred = () => { const value = Promise.withResolvers(); value.promise.catch(() => {}); return value }
function captured(backgroundId, context, generation) {
  validateConversationEffect('execution.background.end', { backgroundId }, context)
  check(context.generation === generation)
  return structuredClone(context)
}

// These fixed capabilities use the independent control lane, never the root/data credits.
export function createConversationBackgroundParent({ generation, assertContext, send, onFailure = () => {} }) {
  const records = new Map()
  let failed = false
  const fail = () => {
    if (failed) return
    failed = true
    for (const record of records.values()) record.done.reject(error())
    onFailure(error())
  }
  const lookup = (id, context) => {
    captured(id, context, generation); assertContext(context)
    const record = records.get(id)
    check(!failed && record && isDeepStrictEqual(record.context, context))
    return record
  }
  return {
    register(backgroundId, context, { complete, waitEffects }) {
      const wire = captured(backgroundId, context, generation); assertContext(context)
      check(!failed && !records.has(backgroundId) && typeof complete === 'function' && typeof waitEffects === 'function')
      records.set(backgroundId, { context: wire, complete, waitEffects, requested: false, state: 'working', done: deferred() })
    },
    endRequested(backgroundId, context) {
      const record = lookup(backgroundId, context)
      check(record.state === 'working' && !record.requested)
      record.requested = true
    },
    async receive(frame) {
      try {
        check(exact(frame, 'type,backgroundId,context,ok') && frame.type === 'background-complete' && typeof frame.ok === 'boolean')
        const record = lookup(frame.backgroundId, frame.context)
        check(record.requested && record.state === 'working')
        record.state = 'completing'
        // Only direct reverse effects belong here; waiting the background's own lifetime would make an ACK cycle.
        await record.waitEffects()
        assertContext(record.context)
        check(!failed)
        check(record.complete(frame.ok ? null : error()) === undefined)
        record.settled = true
        await send({ type: 'background-ack', backgroundId: frame.backgroundId, context: record.context })
        record.state = 'closed'; record.done.resolve(); records.delete(frame.backgroundId)
      } catch (cause) { fail(); throw cause }
    },
    async drain() {
      while ([...records.values()].some(record => record.state !== 'closed')) {
        check(!failed)
        await Promise.all([...records.values()].filter(record => record.state !== 'closed').map(record => record.done.promise))
      }
      check(!failed)
    },
    // Called only after OS exit, disconnected IPC, every owned pipe and parent effects have really closed.
    async reaped() {
      failed = true
      for (const record of records.values()) {
        await record.waitEffects()
        if (!record.settled) { record.complete(error()); record.settled = true }
        record.done.reject(error())
      }
    },
    snapshot: () => ({ pending: [...records.values()].filter(record => record.state !== 'closed').length, unconfirmed: failed }),
  }
}

export function createConversationBackgroundChild({ generation, assertContext, send, onFailure = () => {} }) {
  const records = new Map()
  let failed = false
  const fail = () => {
    if (failed) return
    failed = true
    for (const record of records.values()) record.done.reject(error())
    onFailure(error())
  }
  const lookup = (id, context) => {
    captured(id, context, generation); assertContext(context)
    const record = records.get(id)
    check(!failed && record && record.original === context)
    return record
  }
  return {
    // The validated begin response is the only issuer. A child cannot invent an ID in trackBackground.
    issued(backgroundId, context) {
      const wire = captured(backgroundId, context, generation); assertContext(context)
      check(!failed && !records.has(backgroundId))
      records.set(backgroundId, { original: context, context: wire, state: 'issued', ended: false, done: deferred() })
    },
    endAcknowledged(backgroundId, context) {
      const record = lookup(backgroundId, context)
      check(!record.ended && ['issued', 'working'].includes(record.state))
      record.ended = true
    },
    trackBackground(backgroundId, context, actualPromise) {
      const record = lookup(backgroundId, context)
      check(record.state === 'issued' && actualPromise instanceof Promise)
      record.state = 'working'
      const complete = async ok => {
        check(!failed && record.ended && record.state === 'working')
        record.state = 'sent'
        await send({ type: 'background-complete', backgroundId, context: record.context, ok })
        await record.done.promise
      }
      // Caller deadlines never settle this promise. Only the actual child work supplies its outcome.
      void actualPromise.then(() => complete(true), () => complete(false)).catch(fail)
    },
    receive(frame) {
      try {
        check(exact(frame, 'type,backgroundId,context') && frame.type === 'background-ack')
        captured(frame.backgroundId, frame.context, generation)
        const record = records.get(frame.backgroundId)
        check(!failed && record?.state === 'sent' && isDeepStrictEqual(record.context, frame.context))
        assertContext(record.original)
        record.state = 'closed'; record.done.resolve(); records.delete(frame.backgroundId)
      } catch (cause) { fail(); throw cause }
    },
    async drain() { await Promise.all([...records.values()].map(record => record.done.promise)); check(!failed) },
    reaped: fail,
    snapshot: () => ({ pending: [...records.values()].filter(record => record.state !== 'closed').length, unconfirmed: failed }),
  }
}
