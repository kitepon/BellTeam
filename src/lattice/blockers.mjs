// Stops (README Public contract, Stops; data flow L16-L17): every chart's `todo blockers` as one Owner list, and the Owner's unblock by stopId.
import { createHash } from 'node:crypto'

const text = value => typeof value === 'string' ? value : null
// Stable per stop: the same task blocked again later (new blocked_at) is a new stop, so an old id never removes a newer stop.
export const stopIdOf = (projectId, entry) => createHash('sha256')
  .update(JSON.stringify([projectId, entry.plan_key, entry.task_id, entry.blocked_at ?? null])).digest('hex').slice(0, 24)

// lattice.todo_blockers_result.v1 (Lattice 0.96.0) -> rows of bellteam.lattice-blockers.v1. meta = the chart's K1 row {name, createdBy}.
export function stopsOf(projectId, value, meta = {}) {
  return (Array.isArray(value?.blockers) ? value.blockers : []).filter(entry => text(entry?.plan_key) && text(entry?.task_id)).map(entry => ({
    stopId: stopIdOf(projectId, entry), projectId, chartName: text(meta.name), chartCreatedBy: text(meta.createdBy),
    plan: entry.plan_key, taskId: entry.task_id, cardId: `${entry.plan_key}/${entry.task_id}`, title: text(entry.title), lane: text(entry.lane),
    reason: text(entry.reason), blockedAt: text(entry.blocked_at), blockedBy: text(entry.blocked_by?.agent),
  }))
}

// Lattice codes meaning the stop cannot exist any more: the app drops the row as for a removed stop.
const GONE = new Set(['TASK_NOT_FOUND', 'PLAN_NOT_FOUND'])
// One CLI run result of `todo unblock` -> outcome. stdout/stderr already parsed (undefined = not JSON).
export function unblockOutcome({ exitCode, out, err }) {
  if (exitCode === 0) return { outcome: out?.unchanged === true ? 'already-gone' : 'removed' }
  const error = err ?? out
  const code = text(error?.code) || 'LATTICE_CLI_FAILED'
  if (GONE.has(code)) return { outcome: 'already-gone' }
  const reason = text(error?.detail?.next_action) || text(error?.message) || code
  return { outcome: 'refused', code: code.slice(0, 128), reason: reason.slice(0, 500) }
}
