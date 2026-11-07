// One native.pin() for an execution operation and the operations bound to its native values
// (docs/architecture/modules/execution/aiterm-generation-pin.md). The pin is released once, when the
// owner and every hold have ended. A client without pin() is used as is.
export function operationLease(client) {
  const pin = typeof client?.pin === 'function' ? client.pin() : null
  let holds = 1
  const drop = () => { if (--holds === 0) pin?.release() }
  const once = release => { let done = false; return () => { if (!done) { done = true; release() } } }
  return {
    client: pin ?? client,
    generation: pin ? pin.generation : undefined,
    hold() {
      if (holds === 0) throw Object.assign(new Error('AITERM_LEASE_RELEASED'), { code: 'AITERM_LEASE_RELEASED' })
      holds++
      return once(drop)
    },
    release: once(drop),
  }
}
