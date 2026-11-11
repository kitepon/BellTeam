// Pure projection of one Lattice display read into a chart (docs/architecture/modules/lattice/README.md, Projection rules). No I/O.
const DISPLAY = ['verified', 'unverified', 'last_verified', 'unavailable']
const STATUS = ['pending', 'in-progress', 'blocked', 'done', 'retired']
const text = value => typeof value === 'string' && value !== '' ? value : null
const stamp = value => typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null
const later = (a, b) => !a ? b : !b ? a : Date.parse(b) > Date.parse(a) ? b : a
const list = value => Array.isArray(value) ? value : []
const ref = value => text(value?.plan_key) && text(value?.task_id) ? `${value.plan_key}/${value.task_id}` : null
const finished = card => card.state === 'done' || card.state === 'retired'

// Malformed fields drop only the task or edge they belong to. An unverified read has no journal, so producers fall back to the lane.
export function projectChart({ read, members = [], previous = null }) {
  const state = DISPLAY.includes(read?.state) ? read.state : 'unavailable'
  const raw = state === 'unverified'
  const live = members.filter(member => !member.deleting), bots = new Set(live.map(member => member.id))
  const named = new Map(live.map(member => [String(member.name).toLowerCase(), member.id]))
  // The authored lane names a member by Bot id or by name; anything else stays plain lane text for the screens.
  // `owner` is the reserved value for the Owner (指揮官), who has no Bot id.
  const assigned = lane => !lane ? null : bots.has(lane) ? lane : ['owner', '指揮官'].includes(lane.toLowerCase()) ? 'owner' : named.get(lane.toLowerCase()) ?? null
  const cards = new Map(), deps = [], cross = [], removed = new Set(), phases = [], parents = new Map()
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
      const lane = text(task.lane), start = starts.get(taskId)
      cards.set(`${key}/${taskId}`, { id: `${key}/${taskId}`, plan: key, taskId, title: text(task.title) ?? taskId,
        doneCondition: text(task.done_condition), designMemo: text(task.design_memo), state: status, lane,
        producer: (status === 'done' || status === 'retired') && lane ? assigned(lane) : start?.agent ?? assigned(lane), startedAt: start?.at ?? null, changedAt: changed.get(taskId) ?? null,
        blockedReason: status === 'blocked' ? text(entry.blocked_reason) : null, depth: 0,
        phase: phaseIds.has(task.phase_id) ? `${key}/${task.phase_id}` : null, parent: null,
        doneAt: status === 'done' ? stamp(entry?.done_at) ?? changed.get(taskId) ?? null : status === 'retired' ? changed.get(taskId) ?? null : null, archived: false })
      if (text(task.parent_task_id)) parents.set(`${key}/${taskId}`, `${key}/${task.parent_task_id}`)
    }
    for (const dep of list(plan.hard_dependencies)) deps.push([ref(dep?.from), ref(dep?.to)])
    for (const join of list(plan.joins)) for (const after of list(join?.after)) deps.push([ref(after), ref(join?.before)])
    for (const event of list(member.plan_scoped?.events)) {
      if (event?.kind === 'cross_plan_dependency') cross.push({ digest: event.event_digest, edge: [ref(event.payload?.from), ref(event.payload?.to)] })
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

  const next = new Map(), before = new Map(), edges = []
  const reaches = (from, to, seen = new Set()) => from === to || !seen.has(from) && seen.add(from) && (next.get(from) ?? []).some(id => reaches(id, to, seen))
  for (const [from, to] of deps) {
    if (!cards.has(from) || !cards.has(to) || from === to || next.get(from)?.includes(to) || reaches(to, from)) continue
    next.set(from, [...next.get(from) ?? [], to]); before.set(to, [...before.get(to) ?? [], from])
    edges.push({ from, to, waiting: !finished(cards.get(from)) && !finished(cards.get(to)) })
  }
  for (const card of cards.values()) {
    if (card.state === 'pending' && (before.get(card.id) ?? []).every(id => finished(cards.get(id)))) card.state = 'ready'
  }
  // Archived = finished and no next card is still unstarted (Owner 2026-11-12); the screens leave it to 過去ログ.
  for (const card of cards.values()) {
    card.archived = finished(card) && (next.get(card.id) ?? []).every(id => !['pending', 'ready'].includes(cards.get(id).state))
  }
  const open = new Map([...cards.keys()].map(id => [id, (before.get(id) ?? []).length]))
  for (const queue = [...open].filter(([, n]) => n === 0).map(([id]) => id); queue.length;) {
    const id = queue.shift()
    for (const to of next.get(id) ?? []) {
      cards.get(to).depth = Math.max(cards.get(to).depth, cards.get(id).depth + 1)
      open.set(to, open.get(to) - 1)
      if (open.get(to) === 0) queue.push(to)
    }
  }
  const waits = edges.filter(edge => edge.waiting).map(edge => {
    const waiter = cards.get(edge.to), maker = cards.get(edge.from)
    return { waiter: waiter.producer, waitingCard: waiter.id, forCard: maker.id, producer: maker.producer, producerState: maker.state,
      since: later(maker.changedAt, waiter.changedAt) }
  }).sort((a, b) => (a.since ? Date.parse(a.since) : Infinity) - (b.since ? Date.parse(b.since) : Infinity) || (a.waitingCard + a.forCard).localeCompare(b.waitingCard + b.forCard))
  const all = [...cards.values()], count = state => all.filter(card => card.state === state).length
  return { state, verifiedAt: stamp(read?.verified_at), cards: all, edges, waits, phases,
    memberIds: [...new Set([...all.map(card => card.producer), ...waits.map(wait => wait.waiter)].filter(id => id && id !== 'owner'))].sort(),
    counts: { total: all.length, done: count('done') + count('retired'), working: count('in-progress'), blocked: count('blocked'),
      waiting: new Set(edges.filter(edge => edge.waiting).map(edge => edge.to)).size },
    createdBy: first?.agent ?? previous?.createdBy ?? null, updatedAt: updatedAt ?? previous?.updatedAt ?? null }
}
