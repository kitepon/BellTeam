// Pure projection of one Lattice display read into a chart (docs/architecture/modules/lattice/README.md, Projection rules). No I/O.
const DISPLAY = ['verified', 'unverified', 'last_verified', 'unavailable']
const STATUS = ['pending', 'in-progress', 'blocked', 'done', 'retired']
const text = value => typeof value === 'string' && value !== '' ? value : null
const stamp = value => typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null
const later = (a, b) => !a ? b : !b ? a : Date.parse(b) > Date.parse(a) ? b : a
const list = value => Array.isArray(value) ? value : []
const ref = value => text(value?.plan_key) && text(value?.task_id) ? `${value.plan_key}/${value.task_id}` : null
const finished = card => card.state === 'done' || card.state === 'retired'

// The authored lane names a member by Bot id or by name; anything else stays plain lane text for the screens.
// `owner` is the reserved value for the Owner (指揮官), who has no Bot id. Shared with the prompt sweep (nudge.mjs).
export function laneResolver(members) {
  const live = members.filter(member => !member.deleting), bots = new Set(live.map(member => member.id))
  const named = new Map(live.map(member => [String(member.name).toLowerCase(), member.id]))
  return lane => !lane ? null : bots.has(lane) ? lane : ['owner', '指揮官'].includes(lane.toLowerCase()) ? 'owner' : named.get(lane.toLowerCase()) ?? null
}

// Malformed fields drop only the task or edge they belong to. An unverified read has no journal, so producers fall back to the lane.
// elsewhere(projectId, cardId) -> {chartName, title, producer} | null: the other chart's memo, if the child holds one (core.mjs).
export function projectChart({ read, members = [], previous = null, elsewhere = () => null }) {
  const state = DISPLAY.includes(read?.state) ? read.state : 'unavailable'
  const raw = state === 'unverified'
  const assigned = laneResolver(members)
  const cards = new Map(), deps = [], cross = [], removed = new Set(), phases = [], parents = new Map()
  // Predecessors on another chart (Lattice 0.99.0, task a60): facts from external_tasks, keyed `<project>:<plan>/<task>`.
  const outside = new Map(list(read?.external_tasks).filter(item => text(item?.project_id) && ref(item)).map(item => [`${item.project_id}:${ref(item)}`, item]))
  let first = null, updatedAt = null
  for (const member of list(read?.store?.members)) {
    const plan = member?.plan, key = text(plan?.plan_key)
    if (!key) continue
    const phaseIds = new Set()
    for (const phase of list(plan.phases)) {
      const id = text(phase?.phase_id)
      if (id && !phaseIds.has(id)) { phaseIds.add(id); phases.push({ id: `${key}/${id}`, title: text(phase.title) }) }
    }
    const states = new Map(list((raw ? member.snapshot : member)?.tasks).map(task => [task?.task_id, task]))
    const starts = new Map(), changed = new Map()
    for (const event of raw ? [] : list(member.journal?.events)) {
      const at = stamp(event?.recorded_at), agent = text(event?.actor?.agent), id = text(event?.task_id)
      if (at && (!first || Date.parse(at) < Date.parse(first.at))) first = { at, agent }
      updatedAt = later(updatedAt, at)
      if (!id) continue
      changed.set(id, later(changed.get(id) ?? null, at))
      if (event.kind === 'start' && agent) starts.set(id, { agent, at })
    }
    for (const task of list(plan.tasks)) {
      const taskId = text(task?.task_id), entry = states.get(taskId)
      const status = entry === undefined ? 'pending' : String(entry?.status).replace('_', '-')
      if (!taskId || !STATUS.includes(status)) continue
      const lane = task.lane === 'main' ? null : text(task.lane), start = starts.get(taskId) // `main` is Lattice's default lane, not an owner
      cards.set(`${key}/${taskId}`, { id: `${key}/${taskId}`, plan: key, taskId, title: text(task.title) ?? taskId,
        doneCondition: text(task.done_condition), designMemo: text(task.design_memo), state: status, lane,
        producer: (status === 'done' || status === 'retired') && lane ? assigned(lane) : start?.agent ?? assigned(lane), startedAt: start?.at ?? null, changedAt: changed.get(taskId) ?? null,
        blockedReason: status === 'blocked' ? text(entry.blocked_reason) : null, depth: 0,
        phase: phaseIds.has(task.phase_id) ? `${key}/${task.phase_id}` : null, parent: null,
        doneAt: status === 'done' ? stamp(entry?.done_at) ?? changed.get(taskId) ?? null : status === 'retired' ? changed.get(taskId) ?? null : null, archived: false, counted: true })
      if (text(task.parent_task_id)) parents.set(`${key}/${taskId}`, `${key}/${task.parent_task_id}`)
    }
    for (const dep of list(plan.hard_dependencies)) deps.push([ref(dep?.from), ref(dep?.to)])
    for (const join of list(plan.joins)) for (const after of list(join?.after)) deps.push([ref(after), ref(join?.before)])
    for (const event of list(member.plan_scoped?.events)) {
      const from = event?.payload?.from, to = event?.payload?.to
      const other = text(from?.project_id) && text(to?.project_id) && from.project_id !== to.project_id ? `${from.project_id}:` : ''
      if (other && !/^[a-z0-9][a-z0-9-]{0,62}:$/u.test(other)) continue // a malformed project id drops only this edge
      if (event?.kind === 'cross_plan_dependency') cross.push({ digest: event.event_digest, edge: [ref(from) && other + ref(from), ref(to)] })
      else if (event?.kind === 'cross_plan_dependency_removed' && text(event.payload?.target_event_digest)) removed.add(event.payload.target_event_digest)
    }
  }
  // A parent must exist, differ from the card and not close a cycle; otherwise the card hangs from its phase.
  for (const [id, parent] of parents) {
    let up = parent
    while (up && up !== id && cards.has(up)) up = cards.get(up).parent
    if (cards.has(parent) && up !== id) cards.get(id).parent = parent
  }
  deps.push(...cross.filter(item => !removed.has(item.digest)).map(item => item.edge))

  const externals = new Map(), next = new Map(), before = new Map(), edges = []
  const reaches = (from, to, seen = new Set()) => from === to || !seen.has(from) && seen.add(from) && (next.get(from) ?? []).some(id => reaches(id, to, seen))
  for (const [from, to] of deps) {
    if (from?.includes(':')) {
      // The other chart is not walked, so an external edge never closes a local cycle.
      if (!cards.has(to) || edges.some(edge => edge.from === from && edge.to === to)) continue
      const item = outside.get(from), [projectId] = from.split(':', 1)
      const cardId = from.slice(projectId.length + 1), known = elsewhere(projectId, cardId)
      if (!externals.has(from)) externals.set(from, { id: from, projectId, cardId, chartName: known?.chartName ?? null, title: known?.title ?? null,
        state: STATUS.includes(String(item?.status).replace('_', '-')) && !text(item?.reason) ? String(item.status).replace('_', '-') : null, finished: item?.finished === true, producer: known?.producer ?? null })
      before.set(to, [...before.get(to) ?? [], from])
      edges.push({ from, to, waiting: !externals.get(from).finished && !finished(cards.get(to)), external: true })
      continue
    }
    if (!cards.has(from) || !cards.has(to) || from === to || next.get(from)?.includes(to) || reaches(to, from)) continue
    next.set(from, [...next.get(from) ?? [], to]); before.set(to, [...before.get(to) ?? [], from])
    edges.push({ from, to, waiting: !finished(cards.get(from)) && !finished(cards.get(to)) })
  }
  for (const card of cards.values()) {
    if (card.state === 'pending' && (before.get(card.id) ?? []).every(id => externals.get(id)?.finished ?? finished(cards.get(id)))) card.state = 'ready'
  }
  // Trees come from Lattice (display read `trees`, 0.100.0; Owner: BellTeam computes no trees). A card in no tree is a tree of one.
  const treeOf = new Map((read?.store ? read.trees ?? [] : []).flatMap(tree => (tree?.tasks ?? []).map(task => [`${task?.plan_key}/${task?.task_id}`, tree])))
  const treeDone = card => { const tree = treeOf.get(card.id); return tree ? Number(tree.finished) >= Number(tree.total) : finished(card) }
  // Owner 2026-11-14 (README Projection rules): a finished card leaves once all its next cards are finished; one with no next card leaves
  // with its finished tree. Every task of a tree not fully finished is counted, hidden ones included.
  for (const card of cards.values()) {
    const after = next.get(card.id) ?? []
    card.archived = finished(card) && (after.length ? after.every(id => finished(cards.get(id))) : treeDone(card))
    card.counted = !treeDone(card)
  }
  const open = new Map([...cards.keys()].map(id => [id, (before.get(id) ?? []).filter(from => cards.has(from)).length]))
  for (const queue = [...open].filter(([, n]) => n === 0).map(([id]) => id); queue.length;) {
    const id = queue.shift()
    for (const to of next.get(id) ?? []) {
      // An archived card adds no column: the leftmost shown card is column 0 (Owner 2026-11-14, a108).
      cards.get(to).depth = Math.max(cards.get(to).depth, cards.get(id).archived ? 0 : cards.get(id).depth + 1)
      open.set(to, open.get(to) - 1)
      if (open.get(to) === 0) queue.push(to)
    }
  }
  const waits = edges.filter(edge => edge.waiting).map(edge => {
    const waiter = cards.get(edge.to), maker = cards.get(edge.from) ?? { ...externals.get(edge.from), changedAt: null }
    return { waiter: waiter.producer, waitingCard: waiter.id, forCard: maker.id, producer: maker.producer, producerState: maker.state,
      since: later(maker.changedAt, waiter.changedAt) }
  }).sort((a, b) => (a.since ? Date.parse(a.since) : Infinity) - (b.since ? Date.parse(b.since) : Infinity) || (a.waitingCard + a.forCard).localeCompare(b.waitingCard + b.forCard))
  // Fractions count only what the tree shows: the archived flag above, no second rule (Owner 2026-11-14, task a96).
  const all = [...cards.values()], counted = all.filter(card => card.counted), count = state => counted.filter(card => card.state === state).length
  return { state, verifiedAt: stamp(read?.verified_at), cards: all, edges, waits, phases, externals: [...externals.values()],
    memberIds: [...new Set([...all.map(card => card.producer), ...waits.map(wait => wait.waiter), ...[...externals.values()].map(item => item.producer)].filter(id => id && id !== 'owner'))].sort(),
    counts: { total: counted.length, done: count('done') + count('retired'), working: count('in-progress'), blocked: count('blocked'),
      waiting: new Set(edges.filter(edge => edge.waiting).map(edge => edge.to)).size },
    createdBy: first?.agent ?? previous?.createdBy ?? null, updatedAt: updatedAt ?? previous?.updatedAt ?? null }
}
