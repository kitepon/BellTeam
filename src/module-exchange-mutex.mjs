export function createModuleExchangeMutex() {
  let busy = false
  const waiters = new Set()
  const reserve = () => {
    if (busy) throw Object.assign(new Error('MODULE_EXCHANGE_BUSY'), {
      code: 'MODULE_EXCHANGE_BUSY', status: 409, outcome: 'not_accepted', effect: 'not_started',
    })
    busy = true
    let released = false
    return () => { if (!released) { released = true; busy = false; for (const resolve of waiters) resolve(); waiters.clear() } }
  }
  return {
    reserve,
    waitForIdle: () => busy ? new Promise(resolve => waiters.add(resolve)) : Promise.resolve(),
    async runExclusive(operation) {
      const release = reserve()
      try { return await operation() } finally { release() }
    },
  }
}
