import { validateConversationEffect, validateConversationEffectResult } from './effects.mjs'

export class ConversationBackground {
  #pending = new Set()
  #starting = new Set()

  constructor({ effect, trackBackground }) {
    if (typeof effect !== 'function' || typeof trackBackground !== 'function') throw new Error('CONVERSATION_BACKGROUND_ADAPTER_REQUIRED')
    this.effect = effect
    this.trackBackground = trackBackground
  }

  start(source, context, operation) {
    const started = Promise.withResolvers()
    started.promise.catch(() => {})
    const registration = { context, promise: started.promise }
    this.#starting.add(registration)
    const completion = Promise.resolve().then(async () => {
      const params = await source()
      validateConversationEffect('execution.background.begin', params, context)
      const result = await this.effect('execution.background.begin', params, context)
      validateConversationEffectResult('execution.background.begin', result, params)
      const end = { backgroundId: result.backgroundId }, release = Promise.withResolvers()
      const actual = (async () => {
        let failure, value
        try { await release.promise; value = await operation() }
        catch (error) { failure = error }
        try {
          const response = await this.effect('execution.background.end', end, context)
          validateConversationEffectResult('execution.background.end', response, end)
        } catch (error) {
          if (failure) throw new AggregateError([failure, error], 'CONVERSATION_BACKGROUND_AND_END_FAILED')
          throw error
        }
        if (failure) throw failure
        return value
      })()
      try {
        this.trackBackground(result.backgroundId, context, actual)
        started.resolve()
        release.resolve()
      } catch (error) {
        started.reject(error)
        release.reject(error)
      }
      return actual
    })
    this.#pending.add(completion)
    const clear = () => { this.#pending.delete(completion) }
    completion.then(clear, clear)
    completion.catch(started.reject)
    // A fast failed begin must still be seen when the root reaches its final ACK.
    started.promise.then(() => this.#starting.delete(registration), () => {})
    completion.started = started.promise
    return completion
  }

  async awaitStarted(context) {
    const same = entry => entry.context.generation === context.generation && entry.context.operationId === context.operationId
    while ([...this.#starting].some(same)) {
      const batch = [...this.#starting].filter(same)
      try { await Promise.all(batch.map(entry => entry.promise)) }
      finally { for (const entry of batch) this.#starting.delete(entry) }
    }
  }

  async drain() {
    const failures = []
    const admissions = await Promise.allSettled([...this.#starting].map(entry => entry.promise))
    failures.push(...admissions.filter(result => result.status === 'rejected').map(result => result.reason))
    while (this.#pending.size) {
      const results = await Promise.allSettled([...this.#pending])
      failures.push(...results.filter(result => result.status === 'rejected').map(result => result.reason))
    }
    if (failures.length) throw new AggregateError(failures, 'CONVERSATION_BACKGROUND_FAILED')
  }

  snapshot() { return { pending: this.#pending.size, starting: this.#starting.size } }
}
