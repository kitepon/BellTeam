// Parent side of the approval-box-extension child (docs/architecture/modules/runtime/approval-box-extension-child.md).
// Roots pass straight through. The engine loop sends root `refresh {since}` every 30 s so the link engine runs with no screen open (a490h2: no content routes, no SSE fan-out any more).
const unavailable = () => Object.assign(new Error('APPROVALS_UNAVAILABLE'), { code: 'APPROVALS_UNAVAILABLE', status: 503 })
// Request errors the app can act on keep the child's code; anything else means the child is not serving.
const PASS = new Map([['APPROVALS_NOT_ENTITLED', 403], ['APPROVALS_NOT_CONNECTED', 409], ['APPROVALS_SUBSCRIPTION_EXPIRED', 402], ['APPROVALS_NOT_FOUND', 404],
  ['APPROVALS_RATE_LIMITED', 429], ['APPROVALS_VALIDATION_FAILED', 400]])
const ROOTS = ['byTask', 'byDecision', 'connection', 'connect', 'cancelConnect', 'disconnect']

export function createApprovalsFacade({ controller, idleMs = 30000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let seq = 0, timer = null, running = false, closed = false
  const send = (method, params) => Promise.resolve().then(() => controller.request(method, params)).catch(error => {
    throw PASS.has(error?.code) ? Object.assign(new Error(error.code), { code: error.code, status: PASS.get(error.code) }) : unavailable()
  })
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
    try { seq = (await send('refresh', { since: seq })).seq } catch {} finally { running = false; arm(idleMs) }
  }
  return {
    ...Object.fromEntries(ROOTS.map(method => [method, (params = {}) => send(method, params)])),
    // The loop starts with the process and ends at close.
    start: () => { if (!timer && !running) arm(0) },
    close: () => { closed = true; clearTimer(timer); timer = null },
  }
}
