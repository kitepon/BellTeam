// Approval Box extension F3: the decision -> chart-task link rules L1-L10 (README) as a pure planner. It decides; an executor calls the Lattice
// facade (ownerTask / link / chart) and writes the link row. Nothing here reads or writes a store.
import { CHART_LABEL } from './origin-view.mjs'
import { isOwnerLane } from './owner-lane.mjs'

export const DECISION_PLAN = 'approval-box'
export const DECISION_LANE = 'approval-box' // the extension is the worker of a wait on the Owner; lane `owner` is no longer used (a188)
export const taskIdOf = decisionId => `dec-${decisionId.toLowerCase()}`
const ended = card => card?.state === 'done' || card?.state === 'retired'
export const jst = iso => { const t = new Date(Date.parse(iso) + 9 * 3_600_000); return `${t.getUTCMonth() + 1}月${t.getUTCDate()}日 ${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}` }
// The owner-task allowlist reads a value that starts with `--` as a missing value and refuses (documented shortcut there), so free text never starts with dashes.
export const safe = text => String(text ?? '').replace(/^[\s-]+/u, '') || '決裁'
export const owner = (projectId, args) => ({ op: 'ownerTask', projectId, args })
export const attachTarget = sessionLabel => { const m = CHART_LABEL.exec(sessionLabel ?? ''); return m ? { projectId: m[1], plan: m[2], taskId: m[3] } : null }

// Rule T: which chart a BellTeam decision's task goes on. charts: [{projectId, createdBy, coordinator}].
export function targetChart(d, charts) {
  const named = attachTarget(d.origin.sessionLabel)
  if (named && charts.some(chart => chart.projectId === named.projectId)) return named.projectId
  return (charts.find(chart => chart.createdBy && chart.createdBy === d.requester?.botId) ?? charts.find(chart => chart.coordinator))?.projectId ?? null
}

// d: ViewDecision; row: this decision's link row or null; rows: every link row; chart: {projectId, cards:[{id:'<plan>/<task>', plan, taskId, state, lane, title}], edges:[{from, to}]}.
// -> {actions: [{op:'link', projectId, plan, taskId} | {op:'ensurePlan', projectId} | {op:'ownerTask', projectId, args}], row: next link row or null}
export function planLink({ d, row, rows = [], chart }) {
  const live = d.status === 'pending' || d.status === 'held'
  const cardOf = r => chart.cards.find(card => card.id === `${r.plan}/${r.taskId}`)
  if (!row) {
    if (!live) return { actions: [], row: null }
    const named = attachTarget(d.origin.sessionLabel)
    if (!named && d.origin.kind !== 'bellteam') return { actions: [], row: null } // L9: outside BellTeam, no chart action at all
    const base = { decisionId: d.id, projectId: chart.projectId, sessionLabel: d.origin.sessionLabel, handledVersion: d.version }
    if (named) { // L8/L10: attach to the existing approval-box-lane task
      const card = chart.cards.find(c => c.id === `${named.plan}/${named.taskId}`)
      if (!card || !isOwnerLane(card.lane)) return { actions: [], row: null }
      return { actions: [{ op: 'link', projectId: chart.projectId, plan: named.plan, taskId: named.taskId }], row: { ...base, plan: named.plan, taskId: named.taskId, state: 'linked', attached: true } }
    }
    const taskId = taskIdOf(d.id)
    const actions = [{ op: 'link', projectId: chart.projectId, plan: DECISION_PLAN, taskId }] // link BEFORE add so the hand-over cannot take the card in between
    if (!chart.cards.some(card => card.plan === DECISION_PLAN)) actions.push({ op: 'ensurePlan', projectId: chart.projectId })
    // L7: a new decision of the same session, after a done decision task whose successors are not finished: insert after it, before them.
    const prev = d.origin.sessionLabel && rows.filter(r => r.projectId === chart.projectId && r.sessionLabel === d.origin.sessionLabel && r.state === 'answered').at(-1)
    const prevId = prev && `${prev.plan}/${prev.taskId}`
    const successors = prev ? chart.edges.filter(edge => edge.from === prevId).map(edge => chart.cards.find(c => c.id === edge.to)).filter(c => c && !ended(c)) : []
    const memo = `決裁箱の決裁「${safe(d.title)}」に指揮官が答えるまでの工程。決裁の内容は決裁箱にあり、ここへは写していない。`
    actions.push(owner(chart.projectId, ['todo', 'add', '--plan', DECISION_PLAN, '--task', taskId, '--title', safe(d.title), '--phase', 'decisions', '--lane', DECISION_LANE,
      ...(successors.length ? ['--after', prev.taskId] : []), '--design-memo', memo, '--reason', '決裁箱に申請が出たため']))
    for (const next of successors) {
      actions.push(owner(chart.projectId, ['todo', 'predecessor', 'add', '--plan', next.plan, '--task', next.taskId, '--after', `${DECISION_PLAN}/${taskId}`, '--reason', '決裁が先に要るため']))
      actions.push(owner(chart.projectId, ['todo', 'predecessor', 'remove', '--plan', next.plan, '--task', next.taskId, '--after', prevId, '--reason', '新しい決裁を間に差し込むため']))
    }
    return { actions, row: { ...base, plan: DECISION_PLAN, taskId, state: 'linked', attached: false } }
  }
  const card = cardOf(row)
  const to = (state, actions = [], extra = {}) => ({ actions, row: { ...row, state, handledVersion: Math.max(row.handledVersion, d.version), ...extra } })
  if (d.status === 'answered') { // L2
    if (row.state === 'answered') return { actions: [], row }
    const label = d.answer?.text ?? d.options.find(option => option.id === d.answer?.optionId)?.label ?? ''
    if (!card || ended(card)) return to('answered')
    return to('answered', [...(card.state === 'in-progress' ? [] : [owner(row.projectId, ['todo', 'start', '--plan', row.plan, '--task', row.taskId])]),
      owner(row.projectId, ['todo', 'done', '--plan', row.plan, '--task', row.taskId, '--message', safe(`指揮官の答え：${label}（${jst(d.answer.answeredAt)}）`)])])
  }
  if (d.status === 'cancelled') { // L3
    if (row.state === 'closed') return { actions: [], row }
    if (!card || ended(card)) return to('closed')
    return to('closed', [owner(row.projectId, ['todo', 'retire', '--plan', row.plan, '--task', row.taskId, '--reason', safe(d.cancelReason ?? '申請したAIが取り下げました')])])
  }
  if (ended(card) && row.state === 'linked') return to('diverged') // L6: closed by hand while the decision is pending; the decision is the AI's, so nothing is cancelled
  if (d.amended.is && d.version > row.handledVersion && row.state !== 'diverged') // L4
    return to(row.state, [owner(row.projectId, ['todo', 'note', '--plan', row.plan, '--task', row.taskId, '--message', `内容が直されました（${d.amended.fields.join('・') || '本文'}）`])])
  return d.version > row.handledVersion ? to(row.state) : { actions: [], row }
}
