// Parent side of the work-graph child (docs/architecture/modules/runtime/work-graph-child.md).
// Provider invalidations become one serialized root 'refresh'; batches go to the body's SSE subscribers.
const unavailable = () => Object.assign(new Error('WORK_GRAPH_UNAVAILABLE'), { code: 'WORK_GRAPH_UNAVAILABLE', status: 503 })

export function createWorkGraphFacade({ controller, bots, rooms, transport, coalesceMs = 100, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const subscribers = new Set(), stops = []
  let chain = Promise.resolve(), session = 0, timer = null, nextTimer = null

  const call = (method, params) => {
    const result = chain.then(() => controller.request(method, params)).catch(() => { throw unavailable() })
    chain = result.catch(() => {})
    return result
  }

  const refresh = mine => call('refresh', {}).then(value => {
    if (mine !== session) return
    if (value?.batch) for (const send of subscribers) try { send(value.batch) } catch {}
    clearTimer(nextTimer); nextTimer = null
    if (value?.nextRefreshMs != null) nextTimer = setTimer(() => { nextTimer = null; request() }, Math.max(0, value.nextRefreshMs))
  }, () => {})

  function request() {
    if (!subscribers.size || timer) return
    const mine = session
    timer = setTimer(() => { timer = null; void refresh(mine) }, coalesceMs)
  }

  function start() {
    const mine = ++session
    for (const [owner, name] of [[transport, 'watchCurrentTurn'], [transport, 'watchQueue'], [bots, 'watch'], [rooms, 'watch']]) {
      if (typeof owner?.[name] !== 'function') continue
      void Promise.resolve().then(() => owner[name](() => request())).then(stop => {
        if (typeof stop !== 'function') return
        if (mine === session) stops.push(stop); else stop()
      }, () => {})
    }
    // Baseline before the subscriber's snapshot: both run on the same chain.
    void refresh(mine)
  }

  function stop() {
    session++
    for (const close of stops.splice(0)) try { close() } catch {}
    clearTimer(timer); clearTimer(nextTimer); timer = nextTimer = null
  }

  return {
    snapshot: () => call('snapshot', {}),
    subscribe(send) {
      subscribers.add(send)
      if (subscribers.size === 1) start()
      return () => { if (subscribers.delete(send) && !subscribers.size) stop() }
    },
  }
}

// Effects the child may call, inside a root call, over existing public ports. Only the listed fields leave the parent.
export function createWorkGraphEffects({ bots, transport, messagePage }) {
  const pick = (value, names) => Object.fromEntries(names.filter(name => value?.[name] !== undefined).map(name => [name, value[name]]))
  return async (method, params) => {
    if (method === 'members.list') return { members: (await bots.listForClient()).map(item => pick(item, ['id', 'name', 'color', 'avatarVersion', 'deleting'])) }
    if (method === 'queue.read') return { items: (await transport.queueItems({})).map(item => pick(item, ['status', 'context', 'contextId', 'groupId', 'from', 'target', 'message', 'image', 'steered', 'startedAt'])) }
    if (method === 'room.messages') {
      const page = await messagePage('rooms', params.roomId, new URL('http://work-graph.local/?limit=50'))
      return { items: (page?.items ?? []).map(item => ({ id: item.id, routing: pick(item.routing, ['responders', 'status']) })) }
    }
    if (method === 'turns.read') {
      if (typeof transport.currentTurn !== 'function') return { unsupported: true }
      try {
        const rows = await Promise.all(params.botIds.map(async id => [id, pick(await transport.currentTurn(id, { startedAt: true }), ['state', 'turnId', 'startedAt'])]))
        return { turns: Object.fromEntries(rows) }
      } catch (error) {
        if (error?.code === 'EXECUTION_REQUEST_INVALID' || /EXECUTION_REQUEST_INVALID/u.test(error?.message ?? '')) return { unsupported: true }
        throw error
      }
    }
    throw Object.assign(new Error('WORK_GRAPH_EFFECT_INVALID'), { code: 'WORK_GRAPH_EFFECT_INVALID', status: 400 })
  }
}
