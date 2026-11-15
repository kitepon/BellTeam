// Approval Box extension F7: the connect flow as a pure state machine (bellteam-client.md: pairing, long poll, scoped session).
// states: not_connected | waiting | denied | connected | expired. Every state leaves by the next event or a new start.
const POLL = { waiting: 'waiting', claimed: 'connected', delivered: 'not_connected', rejected: 'denied', expired: 'not_connected' }

// event: {type:'start'} | {type:'poll', status} | {type:'cancel'} | {type:'unauthorized'} | {type:'remove'} | {type:'ended'} (sliding 90 days passed)
// -> {state, again}  again: poll again right away (long poll: no interval) | startNew: delivered/expired -> open a new request
export function nextConnect(state, event) {
  switch (event.type) {
    case 'start': return { state: 'waiting', again: true }
    case 'poll': {
      if (state !== 'waiting' || !Object.hasOwn(POLL, event.status)) return { state, again: false }
      const next = POLL[event.status]
      return { state: next, again: next === 'waiting', startNew: event.status === 'delivered' || event.status === 'expired' }
    }
    case 'cancel': return { state: state === 'waiting' ? 'not_connected' : state, again: false }
    case 'unauthorized': return { state: state === 'connected' ? 'expired' : state, again: false }
    case 'ended': return { state: 'expired', again: false }
    case 'remove': return { state: 'not_connected', again: false }
    default: return { state, again: false }
  }
}
