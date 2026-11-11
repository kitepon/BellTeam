// Parent side of the lattice child (docs/architecture/modules/runtime/lattice-child.md).
// Every root call runs on one serialized chain; while any chart has subscribers, one timer drives a root 'refresh'.
const unavailable = () => Object.assign(new Error('LATTICE_UNAVAILABLE'), { code: 'LATTICE_UNAVAILABLE', status: 503 })
// Request errors the caller can act on keep their code; anything else means the child is not serving.
const PASS = new Set(['LATTICE_CHART_NOT_FOUND', 'LATTICE_PROJECT_INVALID', 'LATTICE_INPUT_CONFLICT', 'LATTICE_COMMAND_NOT_SEAT_SURFACE', 'LATTICE_INVALID', 'LATTICE_NAME_INVALID'])
const SLICE = 50

export function createLatticeFacade({ controller, retryMs = 2000, setTimer = setTimeout, clearTimer = clearTimeout }) {
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

  return {
    charts: () => call('charts', {}),
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

// The only effect the child may call, inside a root call. Rows carry exactly the agreed keys and types.
export function createLatticeEffects({ bots }) {
  const text = value => value == null ? '' : String(value)
  return async method => {
    if (method === 'members.list') return { members: (await bots.listForClient()).map(item => ({ id: text(item.id), name: text(item.name),
      color: text(item.color), avatarVersion: text(item.avatarVersion), deleting: item.deleting === true })) }
    throw Object.assign(new Error('LATTICE_EFFECT_INVALID'), { code: 'LATTICE_EFFECT_INVALID', status: 400 })
  }
}
