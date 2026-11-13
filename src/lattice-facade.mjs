// Parent side of the lattice child (docs/architecture/modules/runtime/lattice-child.md).
// Every root call runs on one serialized chain; while any chart has subscribers, one timer drives a root 'refresh'.
const unavailable = () => Object.assign(new Error('LATTICE_UNAVAILABLE'), { code: 'LATTICE_UNAVAILABLE', status: 503 })
// Request errors the caller can act on keep their code; anything else means the child is not serving.
const PASS = new Set(['LATTICE_CHART_NOT_FOUND', 'LATTICE_PROJECT_INVALID', 'LATTICE_INPUT_CONFLICT', 'LATTICE_COMMAND_NOT_SEAT_SURFACE', 'LATTICE_INVALID', 'LATTICE_NAME_INVALID'])
const SLICE = 50
// Owner 2026-11-12: 「では、1分で。」 (README L13).
export const NUDGE_MS = 60_000

export function createLatticeFacade({ controller, retryMs = 2000, nudgeMs = NUDGE_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const subscribers = new Map()
  let chain = Promise.resolve(), session = 0, timer = null

  const call = (method, params) => {
    const result = chain.then(() => controller.request(method, params)).catch(error => {
      if (PASS.has(error?.code)) throw Object.assign(new Error(error.code), { code: error.code, status: error.status ?? 400 })
      throw unavailable()
    })
    chain = result.catch(() => {})
    return result
  }

  const publish = snapshots => {
    for (const snapshot of snapshots ?? []) for (const send of subscribers.get(snapshot.projectId) ?? []) try { send(snapshot) } catch {}
  }

  const arm = (mine, ms) => {
    if (mine !== session || !subscribers.size) return
    clearTimer(timer)
    timer = setTimer(() => { timer = null; void refresh(mine) }, Math.max(0, ms))
  }

  async function refresh(mine) {
    const ids = [...subscribers.keys()].sort()
    let next = retryMs
    try {
      for (let i = 0; i < ids.length; i += SLICE) {
        const value = await call('refresh', { projectIds: ids.slice(i, i + SLICE) })
        if (mine !== session) return
        publish(value?.snapshots)
        if (Number.isInteger(value?.nextRefreshMs)) next = value.nextRefreshMs
      }
    } catch {}
    arm(mine, next)
  }

  // One nudge timer for the facade's life, re-armed after each call; unref'd so it never holds the process open.
  const nudge = () => call('nudge', {}).catch(() => null)
  const armNudge = () => { setTimer(() => { void nudge().then(armNudge) }, nudgeMs)?.unref?.() }
  armNudge()

  return {
    charts: () => call('charts', {}),
    nudge,
    blockers: () => call('blockers', {}),
    async unblock({ projectId, stopId }) {
      const value = await call('unblock', { projectId, stopId })
      if (subscribers.has(projectId)) void call('refresh', { projectIds: [projectId] }).then(result => publish(result?.snapshots), () => {})
      return value
    },
    // Once per child generation (onGeneration; held until the child is ready). An old child refuses the method: swallowed, like refresh errors.
    deliver: () => call('deliver', {}).catch(() => null),
    chart: projectId => call('chart', { projectId }),
    async run({ from, projectId, args, input = null, name }) {
      const value = await call('run', { from, projectId, args, input, ...(name !== undefined && { name }) })
      // The run may have written the chart; its subscribers get the new snapshot now, not at the next tick.
      if (subscribers.has(projectId)) void call('refresh', { projectIds: [projectId] }).then(result => publish(result?.snapshots), () => {})
      return value
    },
    subscribe(projectId, send) {
      const first = !subscribers.size
      if (!subscribers.has(projectId)) subscribers.set(projectId, new Set())
      subscribers.get(projectId).add(send)
      if (first) void refresh(++session)
      return () => {
        const set = subscribers.get(projectId)
        if (!set?.delete(send) || set.size) return
        subscribers.delete(projectId)
        if (!subscribers.size) { session++; clearTimer(timer); timer = null }
      }
    },
  }
}

// Refusals that repeat for the same notice whatever happens later (deleted Bot, bad text): the child acks them instead of retrying forever.
const PERMANENT = /^(SENDER_NOT_FOUND|BOT_NOT_FOUND|MESSAGE_REQUIRED)\b/u

// The effects the child may call, inside a root call. Rows carry exactly the agreed keys and types.
// runAs(actor, send): the conversation actor scope for a send; deliver and the nudge timer run outside any request scope.
// decisions: createLatticeDecisions (lattice-approval.mjs, README L18-L19); absent -> LATTICE_DECISIONS_UNAVAILABLE, the child retries next tick.
export function createLatticeEffects({ bots, messenger, transport, decisions = null, runAs = (actor, send) => send() }) {
  const text = value => value == null ? '' : String(value)
  return async (method, params) => {
    // Startable notices go through the public send path, the same as the sendmessage tool (Trony 2026-11-12).
    if (method === 'messages.send') {
      // 'user' would make the messenger an Owner turn (from) or an Owner-screen post (target); a notice is neither.
      if (params.from === 'user' || params.target === 'user') return { delivery: 'refused', deliveryId: null, code: 'LATTICE_SEND_USER_NOT_ALLOWED' }
      try {
        const actor = params.from === 'scheduler' ? { kind: 'scheduler' } : { kind: 'bot', botId: params.from }
        const value = await runAs(actor, () => messenger.sendmessage({ from: params.from, target: params.target, message: params.message }))
        return { delivery: text(value?.delivery) || 'delivered', deliveryId: value?.delivery_id ?? null }
      } catch (error) {
        const code = PERMANENT.exec(error?.message ?? '')?.[1]
        if (code) return { delivery: 'refused', deliveryId: null, code }
        throw error
      }
    }
    if (method === 'members.list') return { members: (await bots.listForClient()).map(item => ({ id: text(item.id), name: text(item.name),
      color: text(item.color), avatarVersion: text(item.avatarVersion), deleting: item.deleting === true })) }
    // Nudge (README L15): only 'working' means running; anything else, or no turn port, reads 'unknown'.
    // runningState also counts a script/CI wait (execution current-work.md 2026-11-12); older bodies fall back to currentTurn.
    if (method === 'turns.read') return { turns: Object.fromEntries(await Promise.all(params.botIds.map(async id => {
      const state = await Promise.resolve().then(() => transport?.runningState ? transport.runningState(id)
        : Promise.resolve(transport?.currentTurn?.(id)).then(turn => turn?.state)).then(state => state, () => null)
      return [id, ['working', 'idle'].includes(state) ? state : 'unknown']
    }))) }
    if (method === 'decisions.file' || method === 'decisions.read' || method === 'decisions.cancel') {
      if (!decisions) throw Object.assign(new Error('LATTICE_DECISIONS_UNAVAILABLE'), { code: 'LATTICE_DECISIONS_UNAVAILABLE', status: 503 })
      return decisions[method.slice('decisions.'.length)](params)
    }
    throw Object.assign(new Error('LATTICE_EFFECT_INVALID'), { code: 'LATTICE_EFFECT_INVALID', status: 400 })
  }
}
