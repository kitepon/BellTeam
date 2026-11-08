// Pure projection of the work graph (docs/architecture/modules/work-graph/README.md). No I/O, no clock besides `now`.
const iso = ms => new Date(ms).toISOString()
const stamp = value => typeof value === 'number' ? iso(value)
  : typeof value === 'string' && /^\d{4}-\d\d-\d\dT/u.test(value) && !Number.isNaN(Date.parse(value)) ? value : null

// Plain Japanese for the Owner: the once-per-request summary of the request (Owner 2026-11-08), never the raw body.
export function edgeLabel(item) {
  return (typeof item?.requestSummary === 'string' ? item.requestSummary.trim() : '') || '依頼を処理中'
}

export function projectGraph({ members, turns = {}, queue, responders = {}, previous = null, now, leaveGraceMs = 4000 }) {
  const known = new Map(members.filter(member => !member.deleting).map(member => [member.id, member]))
  const before = new Map((previous?.nodes ?? []).map(node => [node.botId, node]))
  const oldEdges = new Map((previous?.edges ?? []).map(edge => [edge.id, edge]))
  const edges = new Map()
  for (const item of queue) {
    if (item.status !== 'running' || item.from === item.target || !known.has(item.from) || !known.has(item.target)) continue
    // A silent room delivery is not a request; unreadable or pending routing is not an edge yet.
    if (item.context === 'room' ? !responders[item.groupId]?.includes(item.target) : item.context !== 'direct') continue
    const id = `${item.groupId}:${item.target}`
    edges.set(id, { id, requestId: item.groupId, from: item.from, to: item.target, context: item.context,
      roomId: item.context === 'room' ? item.contextId : null, label: edgeLabel(item),
      state: item.steered ? 'steered' : 'running', startedAt: stamp(item.startedAt) ?? oldEdges.get(id)?.startedAt ?? iso(now) })
  }
  const linked = new Set([...edges.values()].flatMap(edge => [edge.from, edge.to]))
  const nodes = [], absent = {}
  let nextAt = null
  for (const id of new Set([...known.keys(), ...before.keys()])) {
    const member = known.get(id), old = before.get(id), turn = turns[id]
    const held = old?.state === 'working' && turn?.state !== 'working' && turn?.state !== 'idle'
    if (member && (turn?.state === 'working' || held || linked.has(id))) {
      const working = turn?.state === 'working' || held
      // A linked member that starts working begins a new active span.
      const keep = old && (old.state === 'working' || !working)
      nodes.push({ botId: id, name: member.name ?? id, color: member.color || 'violet', avatarVersion: member.avatarVersion || '',
        state: working ? 'working' : 'linked', activeSince: keep ? old.activeSince : (working && stamp(turn?.startedAt)) || iso(now) })
    } else if (old) {
      const since = previous.absent?.[id] ?? now
      if (now - since >= leaveGraceMs) continue
      absent[id] = since
      nodes.push(old)
      nextAt = Math.min(nextAt ?? Infinity, since + leaveGraceMs)
    }
  }
  return { nodes, edges: [...edges.values()], absent, nextAt }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

export function diffGraph(prev, next) {
  const nodes = new Map(prev.nodes.map(node => [node.botId, node])), edges = new Map(prev.edges.map(edge => [edge.id, edge]))
  const live = new Set(next.nodes.map(node => node.botId)), liveEdges = new Set(next.edges.map(edge => edge.id))
  return [
    ...next.nodes.filter(node => !nodes.has(node.botId)).map(node => ({ type: 'member-enter', node })),
    ...next.nodes.filter(node => nodes.has(node.botId) && !same(nodes.get(node.botId), node)).map(node => ({ type: 'member-update', node })),
    ...next.edges.filter(edge => !edges.has(edge.id)).map(edge => ({ type: 'edge-start', edge })),
    ...next.edges.filter(edge => edges.has(edge.id) && !same(edges.get(edge.id), edge)).map(edge => ({ type: 'edge-update', edge })),
    ...prev.edges.filter(edge => !liveEdges.has(edge.id)).map(edge => ({ type: 'edge-end', edgeId: edge.id })),
    ...prev.nodes.filter(node => !live.has(node.botId)).map(node => ({ type: 'member-leave', botId: node.botId })),
  ]
}
