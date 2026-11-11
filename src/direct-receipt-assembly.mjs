import { DurableMessageReceipts } from './durable-message-receipts.mjs'
import { directEnvelope, userEnvelope } from './messenger.mjs'
import { normalInputPending } from './conversation-channel.mjs'
import { diagnosticCauseCodes } from './diagnostic-report-context.mjs'
import { mcpRequestContext } from './mcp-request-context.mjs'
import { returnedExecutionError } from './execution-error.mjs'

const directFailureCodes = new Set([...diagnosticCauseCodes,
  'BOT_SESSION_UNCONFIRMED', 'BOT_INPUT_NOT_READY', 'BOT_SEND_OUTCOME_UNKNOWN', 'AGENT_SESSION_REQUIRED',
  'BOT_LAUNCH_FAILED', 'BOT_SEND_FAILED', 'BOT_DELIVERY_FAILED',
  'BOT_NOT_FOUND', 'AI_GLOBAL_PAUSED', 'MEMBERS_NOT_ACCEPTED', 'CONVERSATION_NOT_ACCEPTED',
  'CONVERSATION_RECOVERY_UNAVAILABLE', 'DISPATCH_ACCEPTANCE_UNAVAILABLE', 'CONTINUATION_SUPERSEDED',
  'CONFIGURATION_UNAVAILABLE', 'CONFIGURATION_PREPARATION_UNCONFIRMED', 'CONFIGURATION_NOT_APPLIED',
  'EXECUTION_UNCONFIRMED', 'AGENT_RESUME_UNAVAILABLE', -32602, -32601, -32603,
])
const safeCode = value => directFailureCodes.has(value) ? value : null

export function directFailureReport(error, context) {
  const request = mcpRequestContext(error)
  const pending = normalInputPending(error)
  const execution = returnedExecutionError(error?.executionError)
  const boundPending = pending && context && pending.deliveryId === context.delivery_id && pending.botId === context.target
  return { code: 'SERVER_TURN_TRACKING_FAILED', module: 'conversation', diagnostic_log: JSON.stringify({
    delivery_id: /^[a-f0-9-]{36}$/u.test(context?.delivery_id ?? '') ? context.delivery_id : null,
    target: /^bot-[a-z0-9_-]{1,64}$/u.test(context?.target ?? '') ? context.target : null,
    stage: ['status', 'preflight', 'acceptance', 'completion'].includes(context?.stage) ? context.stage : null,
    code: safeCode(error?.code), cause_code: safeCode(error?.cause?.code),
    returned: typeof error?.aitermResponseReturned === 'boolean' ? error.aitermResponseReturned : null,
    tool: request?.tool ?? null, request_phase: request?.phase ?? null,
    effect: boundPending ? 'not_started' : execution?.effect ?? null,
    outcome: request?.outcome ?? null,
  }) }
}

// Durable receive is independent of AI admission; only saved new IDs reach execution.
export function createDirectReceiptAssembly({ root, bots, assets, legacy, conversation, transport, aiControl,
  exchangeMutex, executionReady = () => true, onMessage, onTurnEnd, onError = error => console.error(error) }) {
  let started = false, closed = false, requested = false, draining = null, unwatchQueue = null
  const completions = new Set(), drains = new Set()
  const report = (error, context) => { try { Promise.resolve(onError(error, context)).catch(console.error) } catch (failure) { console.error(failure) } }
  const ready = () => !closed && !aiControl.paused && executionReady()
  const requestDrain = () => {
    if (closed) return
    requested = true
    if (!started || draining) return
    draining = Promise.resolve().then(async () => {
      await exchangeMutex.waitForIdle()
      requested = false
      if (!ready()) return
      // The request cycle ends once the lanes are kicked off: a lane waiting on one target's acceptance never
      // delays the next request, which drains another target at once. Lanes stay tracked for close.
      const lanes = receipts.drain().catch(report)
      drains.add(lanes)
      lanes.finally(() => drains.delete(lanes))
    }).catch(report).finally(() => { draining = null; if (requested) requestDrain() })
  }
  const queueChanged = change => {
    if (closed || !Array.isArray(change?.botIds)) return
    for (const botId of change.botIds) {
      try {
        if (transport.isIdle(botId)) { requestDrain(); return }
      } catch (error) {
        if (error?.code !== 'EXECUTION_NOT_ACCEPTING') report(error)
      }
    }
  }
  const dispatch = async ({ record, images, queue, callbacks, executionSource }) => {
    let invoked = false, reported = false
    const reportOnce = (error, stage) => {
      if (reported) return
      reported = true
      // The harness ended a turn the transport followed to its end (wait-contract "Turn-end failure"): not a tracking failure.
      if (error?.turnCompleted === true) return
      report(error, { delivery_id: record.delivery_id, target: record.target, stage })
    }
    try {
      return await transport.membersAdmission.withLease(async membersLease => {
        const check = aiControl.admit()
        if (typeof bots.readMember === 'function') await bots.readMember(record.target, { membersLease })
        else await bots.refresh?.({ membersLease })
        const bot = bots.get(record.target)
        if (!bot) throw Object.assign(new Error('BOT_NOT_FOUND'), { code: 'BOT_NOT_FOUND', status: 404 })
        check()
        const { onUserComplete, ...notificationCallbacks } = callbacks
        // Work summaries (message-receipt.md): who sent it, never a lease; a bridge call is not a summary root.
        const actor = record.from === 'user' ? { kind: 'owner' } : record.from === 'scheduler' ? { kind: 'scheduler' } : { kind: 'bot', botId: record.from }
        const summaryAuthority = record.session_id ? null
          : { context: Object.freeze({ actor: Object.freeze(actor), rootMethod: record.from === 'user' ? 'user.post' : 'direct.post' }), assertCurrent: () => true }
        const options = { images, queue, summaryAuthority, ...notificationCallbacks,
          onStatus(status, error, tracking, mark) {
            if (status === 'failed' && error) reportOnce(error, 'status')
            return notificationCallbacks.onStatus(status, error, tracking, mark)
          }, membersLease, admissionCheck: check,
          ...(executionSource ? { executionSource } : {}) }
        if (record.from === 'user') {
          invoked = true
          const completion = transport.turn(bot, userEnvelope(record.from_identity ?? record.from, record.message), options)
          const saved = Promise.resolve(completion).then(onUserComplete)
          completions.add(saved)
          saved.then(() => completions.delete(saved), error => { completions.delete(saved); reportOnce(error, 'completion') })
          if (!completion?.accepted) throw Object.assign(new Error('DISPATCH_ACCEPTANCE_UNAVAILABLE'), { code: 'DISPATCH_ACCEPTANCE_UNAVAILABLE' })
          return await completion.accepted
        }
        let envelope = directEnvelope(record.from_identity ?? record.from, record.message, { fork: record.from_seat?.kind === 'fork' })
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
      reportOnce(error, invoked ? 'acceptance' : 'preflight')
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
    start() { if (!started && !closed) { started = true; unwatchQueue = transport.watchQueue(queueChanged); requestDrain() } },
    async close() {
      closed = true
      unwatch()
      try { unwatchQueue?.() } catch (error) { report(error) }
      await draining; await Promise.allSettled([...drains]); await Promise.allSettled([...completions]); await receipts.appendQueue
    },
  }
}
