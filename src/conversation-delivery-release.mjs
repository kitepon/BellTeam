import { isDeepStrictEqual } from 'node:util'

const failure = () => Object.assign(new Error('CONVERSATION_DELIVERY_RELEASE_UNCONFIRMED'), {
  code: 'CONVERSATION_DELIVERY_RELEASE_UNCONFIRMED', outcome: 'unknown', status: 503,
})
const check = value => { if (!value) throw failure() }
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === fields.split(',').sort().join(',')
const bindingValid = value => exact(value, 'generation,operationId,deliveryId,target')
  && Object.values(value).every(id => typeof id === 'string' && id.length > 0 && id.length <= 128 && !/[\s\0]/u.test(id))
const key = value => JSON.stringify([value.operationId, value.deliveryId, value.target])

export function createConversationDeliveryReleaseParent({ generation, admission, send, onFailure = () => {} }) {
  const pending = new Map()
  let failed = false
  const fail = () => { if (!failed) { failed = true; onFailure(failure()) } }
  return {
    register(operation, delivery, { deliveryId, target }) {
      admission.assertLease(operation, { generation })
      admission.assertDelivery(delivery, { deliveryId, target })
      const binding = Object.freeze({ generation, operationId: operation.correlation, deliveryId, target })
      check(!failed && bindingValid(binding) && delivery.generation === generation && delivery.correlation === operation.correlation
        && !pending.has(key(binding)))
      const terminal = admission.deliveryCompletion(delivery), completion = Promise.withResolvers()
      completion.promise.catch(() => {})
      const record = { binding, completion, sent: false }
      pending.set(key(binding), record)
      // Register before native launch. Putting this ACK into delivery.pending would wait for itself.
      admission.trackCompletion(operation, completion.promise)
      void terminal.then(async () => {
        check(!failed)
        record.sent = true
        await send({ type: 'delivery-release', binding })
      }).catch(fail)
      return completion.promise
    },
    receive(frame) {
      try {
        check(exact(frame, 'type,binding') && frame.type === 'delivery-release-ack' && bindingValid(frame.binding))
        const record = pending.get(key(frame.binding))
        check(!failed && record?.sent && isDeepStrictEqual(record.binding, frame.binding))
        pending.delete(key(frame.binding)); record.completion.resolve()
      } catch (cause) { fail(); throw cause }
    },
    // IPC loss does not settle pending references. Only the full OS/effect barrier can do that.
    reaped() {
      failed = true
      for (const record of pending.values()) record.completion.reject(failure())
      pending.clear()
    },
    snapshot: () => ({ pending: pending.size, unconfirmed: failed }),
  }
}

export function createConversationDeliveryReleaseChild({ generation, releaseDelivery, send }) {
  const closing = new Set()
  return async frame => {
    check(exact(frame, 'type,binding') && frame.type === 'delivery-release' && bindingValid(frame.binding)
      && frame.binding.generation === generation && !closing.has(key(frame.binding)))
    closing.add(key(frame.binding))
    try {
      // The dispatcher verifies its captured registry and callback terminal; delivered/answer is not a proof.
      await releaseDelivery(frame.binding)
      await send({ type: 'delivery-release-ack', binding: frame.binding })
    } finally { closing.delete(key(frame.binding)) }
  }
}
