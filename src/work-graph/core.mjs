import { randomUUID } from 'node:crypto'
import { diffGraph, projectGraph } from './projection.mjs'

const fresh = () => ({ good: { members: [], turns: {}, queue: [] }, resp: new Map(), state: null })
const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size))

// Graph state of one child generation. Providers are read only through the `effect` function of the current root call.
export function createWorkGraphCore({ now = () => Date.now(), leaveGraceMs = 4000 } = {}) {
  const epoch = randomUUID()
  let version = 0, degraded = [], ctx = fresh(), tail = Promise.resolve()

  // One pass over the providers. A failed source keeps its last good data in c.good and is reported in the returned list.
  async function compute(c, effect) {
    const bad = new Set(), { good } = c
    try { good.members = (await effect('members.list', {})).members } catch { bad.add('members') }
    try { good.queue = (await effect('queue.read', {})).items } catch { bad.add('queue') }
    const turns = {}
    const ids = good.members.filter(member => !member.deleting).map(member => member.id)
    await Promise.all(chunks(ids, 200).map(async botIds => {
      try {
        const read = await effect('turns.read', { botIds })
        if (read.unsupported) bad.add('turn-unsupported')
        else for (const id of botIds) if (Object.hasOwn(read.turns, id)) turns[id] = read.turns[id]
      } catch {
        bad.add('turn')
        for (const id of botIds) if (good.turns[id]) turns[id] = good.turns[id]
      }
    }))
    good.turns = turns
    const rows = good.queue.filter(item => item.status === 'running' && item.context === 'room' && item.groupId && item.contextId)
    for (const id of c.resp.keys()) if (!rows.some(item => item.groupId === id)) c.resp.delete(id)
    const todo = new Map()
    for (const item of rows) if (!c.resp.get(item.groupId)?.final) todo.set(item.contextId, [...todo.get(item.contextId) ?? [], item.groupId])
    // 8 rooms at a time keeps the effect lane well under the channel's call limit.
    for (const batch of chunks([...todo], 8)) await Promise.all(batch.map(async ([roomId, wanted]) => {
      try {
        for (const message of (await effect('room.messages', { roomId })).items) {
          if (wanted.includes(message.id) && message.routing)
            c.resp.set(message.id, { responders: message.routing.responders, final: message.routing.status !== 'pending' })
        }
      } catch { bad.add('responders') }
    }))
    c.state = projectGraph({ members: good.members, turns, queue: good.queue, previous: c.state, now: now(), leaveGraceMs,
      responders: Object.fromEntries([...c.resp].map(([id, entry]) => [id, entry.responders])) })
    return [...bad].sort()
  }

  // Calls never overlap, so a snapshot cannot interleave with a refresh.
  const serial = task => {
    const run = tail.then(task)
    tail = run.catch(() => {})
    return run
  }
  const nextRefreshMs = () => ctx.state?.nextAt == null ? null : Math.max(0, Math.ceil(ctx.state.nextAt - now()))

  return {
    epoch,
    refresh: effect => serial(async () => {
      const prev = ctx.state, next = await compute(ctx, effect)
      let batch = null
      // The first read is the baseline the snapshot reports, not a change.
      if (prev) {
        const changes = diffGraph(prev, ctx.state)
        if (changes.length || next.join() !== degraded.join()) batch = { epoch, version: ++version, at: new Date(now()).toISOString(), degraded: next, changes }
      }
      degraded = next
      return { batch, nextRefreshMs: nextRefreshMs() }
    }),
    snapshot: effect => serial(async () => {
      if (!ctx.state) degraded = await compute(ctx, effect)
      return { schema: 'bellteam.work-graph.v1', epoch, version, at: new Date(now()).toISOString(), degraded,
        nodes: ctx.state.nodes, edges: ctx.state.edges }
    }),
  }
}
