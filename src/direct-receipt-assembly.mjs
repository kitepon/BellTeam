import { DurableMessageReceipts } from './durable-message-receipts.mjs'
import { directEnvelope, userEnvelope } from './messenger.mjs'
import { normalInputPending } from './conversation-channel.mjs'

// Durable receive is independent of AI admission; only saved new IDs reach execution.
export function createDirectReceiptAssembly({ root, bots, assets, legacy, conversation, transport, aiControl,
  exchangeMutex, executionReady = () => true, onMessage, onTurnEnd, onError = error => console.error(error) }) {
  let started = false, closed = false, requested = false, draining = null
  const completions = new Set()
  const report = error => { try { Promise.resolve(onError(error)).catch(console.error) } catch (failure) { console.error(failure) } }
  const ready = () => !closed && !aiControl.paused && executionReady()
  const requestDrain = () => {
    if (closed) return
    requested = true
    if (!started || draining) return
    draining = Promise.resolve().then(async () => {
      await exchangeMutex.waitForIdle()
      requested = false
      if (ready()) await receipts.drain()
    }).catch(report).finally(() => { draining = null; if (requested) requestDrain() })
  }
  const dispatch = async ({ record, images, queue, callbacks, executionSource }) => {
    let invoked = false
    try {
      return await transport.membersAdmission.withLease(async membersLease => {
        const check = aiControl.admit()
        if (typeof bots.readMember === 'function') await bots.readMember(record.target, { membersLease })
        else await bots.refresh?.({ membersLease })
        const bot = bots.get(record.target)
        if (!bot) throw Object.assign(new Error('BOT_NOT_FOUND'), { code: 'BOT_NOT_FOUND', status: 404 })
        check()
        const { onUserComplete, ...notificationCallbacks } = callbacks
        const options = { images, queue, ...notificationCallbacks, membersLease, admissionCheck: check,
          ...(executionSource ? { executionSource } : {}) }
        if (record.from === 'user') {
          invoked = true
          const completion = transport.turn(bot, userEnvelope(record.from_identity ?? record.from, record.message), options)
          const saved = Promise.resolve(completion).then(onUserComplete)
          completions.add(saved)
          saved.then(() => completions.delete(saved), error => { completions.delete(saved); report(error) })
          if (!completion?.accepted) throw Object.assign(new Error('DISPATCH_ACCEPTANCE_UNAVAILABLE'), { code: 'DISPATCH_ACCEPTANCE_UNAVAILABLE' })
          return await completion.accepted
        }
        let envelope = directEnvelope(record.from_identity ?? record.from, record.message)
        if (record.session_id) {
          const identity = record.from_identity, party = record.call_event === 'session.reply' ? 'local' : 'member'
          const hint = record.call_reply_required === false ? ''
            : `\n\n返信する時は call-bridge MCP の call_send に session_id=${record.session_id}、from_party=${party} を指定して。`
          envelope = `「${identity.name}」（${identity.position}:${record.from.split(':').slice(2).join(':')}）から通話が届いています。session_id=${record.session_id}${record.call_seq == null ? '' : ` seq=${record.call_seq}`}\n\n${record.message}${hint}`
        }
        invoked = true
        return await transport.notify(bot, envelope, options)
      })
    } catch (error) {
      if (invoked) {
        const pending = normalInputPending(error)
        if (pending?.deliveryId === record.delivery_id && pending.botId === record.target) throw error
        throw Object.assign(new Error(error.message, { cause: error }), error, { effect: 'unknown' })
      }
      throw Object.assign(new Error(error.message, { cause: error }), { code: error.code, status: error.status, effect: 'not_started' })
    }
  }
  const receipts = new DurableMessageReceipts({ root, bots, assets, dispatch, onMessage, onTurnEnd,
    onPending: requestDrain, onError: report })
  const capture = (method, input) => conversation?.captureReceipt(method, input)
  const messenger = Object.assign(Object.create(legacy), {
    sendmessage(input, options) {
      const source = capture(input.from === 'user' ? 'user.post' : 'direct.post', input)
      const { executionSource: _untrusted, ...message } = input
      return receipts.sendmessage({ ...message, ...(source ? { executionSource: source } : {}) }, options)
    },
    enqueueUserTurn(input, options) {
      if (input.recordUser === false) return legacy.enqueueUserTurn(input, options)
      const source = capture('user.post', input)
      return receipts.enqueueUserTurn({ ...input, ...(source ? { executionSource: source } : {}) }, options)
    },
    async receiveCallBridge(input) {
      capture('call.receive', input)
      const { from: _from, ...result } = await receipts.receiveCallBridge(input)
      return result
    },
  })
  if (!conversation) {
    const onLegacyMessage = legacy.onMessage
    legacy.append = async record => { await receipts.appendFromChild(record); await onLegacyMessage(record) }
  }
  const unwatch = aiControl.watch(state => { if (!state.paused && state.state === 'enabled') requestDrain() })
  return { receipts, messenger, requestDrain,
    start() { if (!started && !closed) { started = true; requestDrain() } },
    async close() { closed = true; unwatch(); await draining; await Promise.allSettled([...completions]); await receipts.appendQueue },
  }
}
