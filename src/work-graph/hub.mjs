import { randomUUID } from 'node:crypto'
import { diffGraph, projectGraph } from './projection.mjs'

const fresh = () => ({ good: { members: [], turns: {}, queue: [] }, resp: new Map(), state: null })
const invalid = error => error?.code === 'EXECUTION_REQUEST_INVALID' || /EXECUTION_REQUEST_INVALID/u.test(error?.message ?? '')

export function createWorkGraphHub({ bots, rooms, transport, messagePage, now = () => Date.now(), coalesceMs = 100, leaveGraceMs = 4000,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  const epoch = randomUUID(), subscribers = new Set(), stops = []
  let version = 0, degraded = [], ctx = fresh(), ready = null, session = 0, timer = null, graceTimer = null, inflight = null, again = false

  // One pass over the providers. A failed source keeps its last good data in c.good and is reported in the returned list.
  async function compute(c) {
    const bad = new Set(), { good } = c
    try { good.members = await bots.listForClient() } catch { bad.add('members') }
    try { good.queue = await transport.queueItems({}) } catch { bad.add('queue') }
    const turns = {}
    await Promise.all(good.members.filter(member => !member.deleting).map(async ({ id }) => {
      try {
        if (typeof transport.currentTurn !== 'function') throw Object.assign(new Error('EXECUTION_REQUEST_INVALID'), { code: 'EXECUTION_REQUEST_INVALID' })
        turns[id] = await transport.currentTurn(id, { startedAt: true })
      } catch (error) {
        bad.add(invalid(error) ? 'turn-unsupported' : 'turn')
        if (!invalid(error) && good.turns[id]) turns[id] = good.turns[id]
      }
    }))
    good.turns = turns
    const rows = good.queue.filter(item => item.status === 'running' && item.context === 'room' && item.groupId && item.contextId)
    for (const id of c.resp.keys()) if (!rows.some(item => item.groupId === id)) c.resp.delete(id)
    const todo = new Map()
    for (const item of rows) if (!c.resp.get(item.groupId)?.final) todo.set(item.contextId, [...todo.get(item.contextId) ?? [], item.groupId])
    await Promise.all([...todo].map(async ([roomId, ids]) => {
      try {
        const page = await messagePage('rooms', roomId, new URL('http://work-graph.local/?limit=50'))
        for (const message of page?.items ?? []) {
          if (ids.includes(message.id) && Array.isArray(message.routing?.responders))
            c.resp.set(message.id, { responders: message.routing.responders, final: message.routing.status !== 'pending' })
        }
      } catch { bad.add('responders') }
    }))
    c.state = projectGraph({ members: good.members, turns, queue: good.queue, previous: c.state, now: now(), leaveGraceMs,
      responders: Object.fromEntries([...c.resp].map(([id, entry]) => [id, entry.responders])) })
    return [...bad].sort()
  }

  // Recomputes never overlap; a restart after stop() waits for the old pass so its baseline is not skipped.
  function run() {
    timer = null
    if (inflight) { again = true; return inflight }
    return inflight = pass().finally(() => { inflight = null; after() })
  }

  async function pass() {
    try {
      const c = ctx, prev = c.state, next = await compute(c)
      if (c !== ctx) return
      const changes = prev ? diffGraph(prev, c.state) : []
      // The first read is the baseline the snapshot reports, not a change.
      if (prev && (changes.length || next.join() !== degraded.join())) {
        degraded = next
        const batch = { epoch, version: ++version, at: new Date(now()).toISOString(), degraded, changes }
        for (const send of subscribers) try { send(batch) } catch {}
      } else degraded = next
    } catch {}
  }

  function after() {
    clearTimer(graceTimer); graceTimer = null
    if (subscribers.size && ctx.state?.nextAt != null) graceTimer = setTimer(() => { graceTimer = null; request(0) }, Math.max(0, ctx.state.nextAt - now()))
    if (again) { again = false; request() }
  }

  function request(ms = coalesceMs) {
    if (subscribers.size && !timer) timer = setTimer(run, ms)
  }

  async function start() {
    const mine = ++session, signal = () => request()
    // Watchers first, then the first read: no change can fall between them.
    await Promise.all([[transport, 'watchCurrentTurn'], [transport, 'watchQueue'], [bots, 'watch'], [rooms, 'watch']].map(async ([owner, name]) => {
      if (typeof owner?.[name] !== 'function') return
      try {
        const stop = await owner[name](signal)
        if (typeof stop !== 'function') return
        if (mine === session) stops.push(stop); else stop()
      } catch {}
    }))
    if (mine === session) { await inflight; await run() }
  }

  function stop() {
    session++
    for (const close of stops.splice(0)) try { close() } catch {}
    clearTimer(timer); clearTimer(graceTimer); timer = graceTimer = null
    ctx = fresh(); degraded = []; ready = null; again = false
  }

  return {
    epoch,
    async snapshot() {
      let c = ctx, listed = degraded
      if (subscribers.size) await ready
      else { c = fresh(); listed = await compute(c) }
      return { schema: 'bellteam.work-graph.v1', epoch, version, at: new Date(now()).toISOString(), degraded: c === ctx ? degraded : listed,
        nodes: c.state?.nodes ?? [], edges: c.state?.edges ?? [] }
    },
    subscribe(send) {
      subscribers.add(send)
      if (subscribers.size === 1) ready = start()
      return () => { if (subscribers.delete(send) && !subscribers.size) stop() }
    },
  }
}
