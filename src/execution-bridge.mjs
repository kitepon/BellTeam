// Execution references: the ids a delivery, a room message or a call carries as its request identity (read by messenger and the
// conversation execution effects). a532b2 stage 1: the ExecutionBridge adapter for Aiterm's agent_execution store is gone;
// production never used it (executionBridge was always null).
const session = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(value)
const failure = (code, effect) => Object.assign(new Error(code), { code, effect, follow_up: 'status_only' })

export function deliveryExecutionRef(deliveryId, targetSession) {
  if (typeof deliveryId !== 'string' || !deliveryId.length || !session(targetSession)) throw failure('EXECUTION_INVALID', 'not_started')
  return { kind: 'delivery', delivery_id: deliveryId, target_session_id: targetSession }
}
export function roomExecutionRef(messageId, targetSession) {
  deliveryExecutionRef(messageId, targetSession)
  return { kind: 'room', message_id: messageId, target_session_id: targetSession }
}
export function callExecutionRef({ sessionId, event, seq, deliveryId }, targetSession) {
  if (typeof sessionId === 'string' && sessionId && ['session.message', 'session.reply'].includes(event)
    && Number.isSafeInteger(seq) && seq >= 0 && session(targetSession))
    return { kind: 'call', call_session_id: sessionId, event, seq, target_session_id: targetSession }
  return deliveryExecutionRef(deliveryId, targetSession)
}
