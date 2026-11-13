import { readCurrentWork } from './current-work-contract.mjs'
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
  }

  function stop() {
    session++
    for (const close of stops.splice(0)) try { close() } catch {}
    clearTimer(timer); clearTimer(nextTimer); timer = nextTimer = null
  }

  return {
    // The child's snapshot returns stored state, so a refresh (published to current subscribers) runs first on the same chain.
    snapshot: () => { void refresh(session); return call('snapshot', {}) },
    subscribe(send) {
      subscribers.add(send)
      if (subscribers.size === 1) start()
      return () => { if (subscribers.delete(send) && !subscribers.size) stop() }
    },
  }
}

// Effects the child may call, inside a root call, over existing public ports. Only the listed fields leave the parent.
export function createWorkGraphEffects({ bots, transport, messagePage }) {
  // Rows carry exactly the agreed keys and types; the child's channel rejects anything else.
  const text = value => value == null ? '' : String(value)
  const textOrNull = value => value == null ? null : String(value)
  const time = value => typeof value === 'number' ? new Date(value).toISOString() : textOrNull(value)
  const turn = value => ({ state: ['working', 'idle'].includes(value?.state) ? value.state : 'unknown', turnId: textOrNull(value?.turnId), startedAt: time(value?.startedAt) })
  return async (method, params) => {
    if (method === 'members.list') return { members: (await bots.listForClient()).map(item => ({ id: text(item.id), name: text(item.name),
      color: text(item.color), avatarVersion: text(item.avatarVersion), deleting: item.deleting === true })) }
    if (method === 'queue.read') return { items: (await transport.queueItems({})).map(item => ({ status: text(item.status), context: text(item.context),
      contextId: textOrNull(item.contextId), groupId: textOrNull(item.groupId), from: textOrNull(item.from), target: textOrNull(item.target),
      // Kiro's once-per-request Japanese summary; the raw body never leaves the parent.
      requestSummary: textOrNull(item.requestSummary), image: Boolean(item.image), steered: item.steered === true, startedAt: item.startedAt ?? null,
      // Execution's label for a running read-only fork (work-graph W4); absent = main seat.
      ...(item.seat ? { seat: { kind: text(item.seat.kind), forkId: textOrNull(item.seat.forkId) } } : {}) })) }
    if (method === 'room.messages') {
      const page = await messagePage('rooms', params.roomId, new URL('http://work-graph.local/?limit=50'))
      return { items: (page?.items ?? []).map(item => ({ id: text(item.id), routing: item.routing && Array.isArray(item.routing.responders)
        ? { responders: item.routing.responders.map(String), status: text(item.routing.status) } : null })) }
    }
    if (method === 'turns.read') {
      if (typeof transport.currentTurn !== 'function') return { unsupported: true }
      try {
        const rows = await Promise.all(params.botIds.map(async id => {
          // The edge label is the receiver's Japanese work summary (GET /api/bots currentWork), never a message body.
          const work = readCurrentWork(transport, bots.get?.(id) ?? null)
          const native = turn(await transport.currentTurn(id, { startedAt: true }))
          // a54 (Owner 2026-11-13): "working" is lattice's nudge judgement, runningState (counts a notify=result command wait).
          const running = typeof transport.runningState === 'function' ? await transport.runningState(id) : null
          return [id, { ...native, state: ['working', 'idle'].includes(running) ? running : native.state, summary: work.summary, summaryStatus: work.summaryStatus }]
        }))
        return { turns: Object.fromEntries(rows) }
      } catch (error) {
        if (error?.code === 'EXECUTION_REQUEST_INVALID' || /EXECUTION_REQUEST_INVALID/u.test(error?.message ?? '')) return { unsupported: true }
        throw error
      }
    }
    throw Object.assign(new Error('WORK_GRAPH_EFFECT_INVALID'), { code: 'WORK_GRAPH_EFFECT_INVALID', status: 400 })
  }
}
