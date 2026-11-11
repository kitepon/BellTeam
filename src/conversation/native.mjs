import { validateConversationCallback, validateConversationCallbackResult } from './callbacks.mjs'
import { validateConversationCallbackContext } from './requests.mjs'

const failure = () => Object.assign(new Error('CONVERSATION_DELIVERY_PROTOCOL_INVALID'), {
  code: 'CONVERSATION_DELIVERY_PROTOCOL_INVALID', outcome: 'unknown',
})
const key = value => JSON.stringify([value.generation, value.operationId, value.deliveryId, value.target])
const callbackNames = { 'delivery.status': 'onStatus', 'delivery.words': 'onInterim',
  'delivery.answer': 'onAnswer', 'turn.end': 'onTurnEnd' }

// Child closures stay here; the parent owns native jobs, opaque leases and terminal proof.
export class ConversationNative {
  #deliveries = new Map()

  constructor({ invoke, current, run, awaitStarted }) {
    this.invoke = invoke
    this.current = current
    this.run = run
    this.awaitStarted = awaitStarted
  }

  #register(bot, message, options, kind, reason) {
    const state = this.current(), queue = options.queue
    const binding = { generation: state.context.generation, operationId: state.context.operationId,
      deliveryId: queue.groupId, target: bot.id }
    const kinds = Object.entries(callbackNames).filter(([, name]) => typeof options[name] === 'function').map(([kind]) => kind)
    if (kind === 'turn') kinds.push('user.complete')
    const entry = { binding, options, kinds, state, active: 0, closed: Promise.withResolvers(),
      reply: kind === 'turn' ? Promise.withResolvers() : null }
    if (this.#deliveries.has(key(binding))) throw failure()
    this.#deliveries.set(key(binding), entry)
    const params = { deliveryId: binding.deliveryId, target: binding.target, message, queue, kinds,
      ...(kind === 'report' ? { sourceDeliveryId: state.source?.deliveryId, reason }
        : kind === 'fork' ? { forkId: options.forkId } : { images: options.images ?? [] }),
      ...(options.recoveredExecution ? { recoveryId: options.recoveredExecution.recoveryId } : {}),
    }
    const accepted = this.invoke(`execution.${kind}`, params, state.context)
    return { entry, accepted }
  }

  notify(bot, message, options) { return this.#register(bot, message, options, 'notify').accepted }
  report(bot, message, options, reason) { return this.#register(bot, message, options, 'report', reason).accepted }
  forkInquiry(bot, message, options) { return this.#register(bot, message, options, 'fork').accepted }

  turn(bot, message, options) {
    const { entry, accepted } = this.#register(bot, message, options, 'turn')
    entry.state.source = { deliveryId: entry.binding.deliveryId, target: entry.binding.target }
    accepted.catch(entry.reply.reject)
    entry.reply.promise.accepted = accepted
    return entry.reply.promise
  }

  reconcileLaunch(bot, request, target) {
    return this.invoke('execution.reconcile', { botId: bot.id, deliveryId: request.delivery_id, target }, this.current().context)
  }

  closeLaunch(bot, request, target) {
    return this.invoke('execution.closeLaunch', { botId: bot.id, deliveryId: request.delivery_id, target }, this.current().context)
  }

  async dispatchCallback(method, params, context) {
    validateConversationCallback(method, params)
    validateConversationCallbackContext(method, context)
    const entry = this.#deliveries.get(key(context))
    if (!entry || !entry.kinds.includes(method)) throw failure()
    entry.active++
    try {
      return await this.run({ ...entry.state, context,
        source: { deliveryId: context.deliveryId, target: context.target }, inlineReport: method === 'turn.end' }, async () => {
        if (method === 'user.complete') {
          if (entry.replied || !entry.reply || !entry.state.userSaved) throw failure()
          entry.replied = true
          entry.reply.resolve(params.reply)
          await entry.state.userSaved
          await this.awaitStarted(context)
        } else if (method === 'delivery.status') await entry.options.onStatus(params.delivery, params.error, params.tracking, ...(params.steered ? [{ steered: true }] : []))
        else if (method === 'delivery.words') await entry.options.onInterim(params.words)
        else if (method === 'delivery.answer') await entry.options.onAnswer(params.text)
        else if (method === 'turn.end') await entry.options.onTurnEnd(params)
        const result = { applied: true }
        validateConversationCallbackResult(method, result)
        return result
      })
    } finally { entry.active-- }
  }

  releaseDelivery(binding) {
    const names = ['generation', 'operationId', 'deliveryId', 'target']
    if (!binding || Object.keys(binding).length !== names.length || names.some(name => !Object.hasOwn(binding, name))) throw failure()
    const entry = this.#deliveries.get(key(binding))
    if (!entry || entry.active) throw failure()
    this.#deliveries.delete(key(binding))
    entry.closed.resolve()
    return { released: true }
  }

  async drain() {
    while (this.#deliveries.size) await Promise.all([...this.#deliveries.values()].map(entry => entry.closed.promise))
  }

  disconnect(error) { for (const entry of this.#deliveries.values()) entry.reply?.reject(error) }
  snapshot() { return { deliveries: this.#deliveries.size,
    callbacks: [...this.#deliveries.values()].reduce((sum, entry) => sum + entry.active, 0) } }
}
