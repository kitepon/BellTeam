export function createModuleExchangeMutex() {
  let busy = false
  return {
    async runExclusive(operation) {
      if (busy) throw Object.assign(new Error('MODULE_EXCHANGE_BUSY'), {
        code: 'MODULE_EXCHANGE_BUSY', status: 409, outcome: 'not_accepted', effect: 'not_started',
      })
      busy = true
      try { return await operation() }
      finally { busy = false }
    },
  }
}
