// Parent side of the approval-box-extension child (docs/architecture/modules/runtime/approval-box-extension-child.md).
// Roots pass straight through. The engine loop sends root `refresh {since}` (~2 s while an app SSE client is connected, 30 s otherwise) so the link
// engine runs with no screen open, and fans the returned events out to subscribers.
const unavailable = () => Object.assign(new Error('APPROVALS_UNAVAILABLE'), { code: 'APPROVALS_UNAVAILABLE', status: 503 })
// Request errors the app can act on keep the child's code; anything else means the child is not serving.
const PASS = new Map([['APPROVALS_NOT_ENTITLED', 403], ['APPROVALS_NOT_CONNECTED', 409], ['APPROVALS_SUBSCRIPTION_EXPIRED', 402], ['APPROVALS_NOT_FOUND', 404],
  ['APPROVALS_RATE_LIMITED', 429], ['APPROVALS_VALIDATION_FAILED', 400]])
const ROOTS = ['summary', 'list', 'get', 'answer', 'hold', 'unhold', 'attachment', 'byTask', 'byDecision', 'connection', 'connect', 'cancelConnect', 'disconnect']

export function createApprovalsFacade({ controller, activeMs = 2000, idleMs = 30000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const subscribers = new Set()
  let seq = 0, timer = null, lastSummary = null, running = false, closed = false
  const send = (method, params) => Promise.resolve().then(() => controller.request(method, params)).catch(error => {
    throw PASS.has(error?.code) ? Object.assign(new Error(error.code), { code: error.code, status: PASS.get(error.code) }) : unavailable()
  })
  const publish = (event, data) => { for (const subscriber of subscribers) try { subscriber({ event, data }) } catch {} }
  const arm = ms => {
    if (closed) return
    clearTimer(timer)
    timer = setTimer(tick, ms)
    timer?.unref?.()
  }
  async function tick() {
    timer = null
    if (running || closed) return
    running = true
    try {
      const value = await send('refresh', { since: seq })
      seq = value.seq
      for (const event of value.events) publish(event.type, { id: event.id, version: event.version })
      const summary = JSON.stringify(value.summary)
      if (value.summary && (value.events.length || summary !== lastSummary)) publish('summary', value.summary)
      lastSummary = summary
    } catch {} finally { running = false; arm(subscribers.size ? activeMs : idleMs) }
  }
  return {
    ...Object.fromEntries(ROOTS.map(method => [method, (params = {}) => send(method, params)])),
    // The loop starts with the process and ends at close; a new subscriber only speeds the next tick up.
    start: () => { if (!timer && !running) arm(0) },
    close: () => { closed = true; clearTimer(timer); timer = null },
    subscribe(listener) {
      subscribers.add(listener)
      if (!running) arm(activeMs)
      return () => { subscribers.delete(listener) }
    },
  }
}
