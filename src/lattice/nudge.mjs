// Nudge sweep (README L13-L15; Owner 2026-11-12, the whole spec): every chart's ready set from `todo nudge` (Lattice decides the chart side),
// and each ready task's prompt, as Lattice wrote it, to its lane Bot when that Bot is not running. No other condition.
const LIMIT = 4000

// One message per lane: a header per chart, then its prompts; split at prompt boundaries to stay within LIMIT.
export function nudgeMessages(entries) {
  const out = []
  let text = '', chart = null
  for (const { projectId, prompt } of entries) {
    const header = projectId === chart ? '' : `Lattice nudge, chart ${projectId} (lattice tool, project ${projectId}):\n`
    const part = `${header}${prompt}`
    if (text && text.length + 2 + part.length > LIMIT) { out.push(text); text = `Lattice nudge, chart ${projectId} (lattice tool, project ${projectId}):\n${prompt}` }
    else text = text ? `${text}\n\n${part}` : part
    chart = projectId
    // shortcut: a single prompt over LIMIT is cut; Lattice prompts are a few hundred chars. Upgrade if Lattice ever sends longer ones.
    if (text.length > LIMIT) { out.push(text.slice(0, LIMIT)); text = ''; chart = null }
  }
  if (text) out.push(text)
  return out
}

// run(id, args) -> parsed Lattice JSON, throws on a failed CLI run.
export async function nudgeSweep(ids, { run, log, roster, effect, lock = (id, fn) => fn() }) {
  const bots = new Set(roster.filter(member => !member.deleting).map(member => member.id))
  const lanes = new Map(), out = { charts: 0, prompted: 0, skipped: 0, failed: 0 }
  for (const id of ids) {
    let value
    try { value = await lock(id, () => run(id, ['todo', 'nudge', '--json'])) } catch (error) {
      out.failed++
      log(`lattice-nudge ${id} ${error?.code ?? 'LATTICE_CLI_FAILED'}`)
      continue
    }
    out.charts++
    for (const lane of Array.isArray(value?.lanes) ? value.lanes : []) {
      // A lane that is no roster Bot (e.g. owner) has no seat to deliver to.
      if (!bots.has(lane?.lane)) continue
      for (const task of Array.isArray(lane.tasks) ? lane.tasks : []) if (typeof task?.prompt === 'string' && task.prompt)
        lanes.set(lane.lane, [...lanes.get(lane.lane) ?? [], { projectId: id, prompt: task.prompt }])
    }
  }
  if (!lanes.size) return out
  // Only 'working' proves the Bot is running; unknown or a failed read is prompted.
  const turns = await effect('turns.read', { botIds: [...lanes.keys()] }).then(value => value.turns, () => ({}))
  for (const [lane, entries] of lanes) {
    if (turns[lane] === 'working') { out.skipped += entries.length; continue }
    let sent = true
    for (const message of nudgeMessages(entries)) {
      const value = await effect('messages.send', { from: 'scheduler', target: lane, message }).catch(() => null)
      if (!['running', 'steered', 'queued', 'delivered', 'answered'].includes(value?.delivery)) sent = false
    }
    if (sent) out.prompted += entries.length
    else { out.failed++; log(`lattice-nudge-send ${lane} not accepted`) }
  }
  return out
}
