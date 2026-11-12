// Prompt sweep (README L13-L15; Owner 2026-11-12, the whole spec): every chart's cards from the memo projection (the screens' read,
// no `todo nudge`) -> ONE prompt per lane Bot that is not running and has an in-progress or a startable task. No other condition.
const LIMIT = 4000
const HEAD = 'Lattice: you are not running, and you have tasks in progress or tasks that can start (every prerequisite is done). Start at least one now.\n'
  + 'If a task can only start after another task is done, connect that task as its prerequisite (`lattice todo dependency connect --from-plan <P> --from-task <that task> --to-plan <P> --to-task <T> --reason <why>`) and return this task to unstarted (`lattice todo retract --plan <P> --task <T> --reason <why>`).\n'
  + 'If it cannot start for any other reason, set a stop (`lattice todo block --plan <P> --task <T> --reason <why>`); a stopped task is not prompted.'

const line = card => card.state === 'ready'
  ? `- ${card.plan}/${card.taskId} 「${card.title}」: can start -> \`lattice todo start --plan ${card.plan} --task ${card.taskId}\``
  : `- ${card.plan}/${card.taskId} 「${card.title}」: in progress`

// One message per Bot: the head once, then a header per chart and its task lines; split at line boundaries to stay within LIMIT.
export function nudgeMessages(entries) {
  const out = []
  let text = HEAD, chart = null
  for (const { projectId, card } of entries) {
    const header = `\nChart ${projectId} (lattice tool, project ${projectId}):`
    let part = `${projectId === chart ? '' : header}\n${line(card)}`
    if (text.length + part.length > LIMIT) { out.push(text); text = 'Lattice (continued):'; part = `${header}\n${line(card)}` }
    // shortcut: a single task line over LIMIT is cut; titles are short. Upgrade if titles ever grow past a few hundred chars.
    text = (text + part).slice(0, LIMIT)
    chart = projectId
  }
  out.push(text)
  return out
}

// charts: [{projectId, cards}] from the memo (cards as projection.mjs makes them); laneOf(lane) -> roster Bot id | 'owner' | null.
export async function nudgeSweep(charts, { laneOf, log, effect }) {
  const lanes = new Map(), out = { charts: charts.length, prompted: 0, skipped: 0, failed: 0 }
  for (const { projectId, cards } of charts) for (const card of cards) {
    if (card.state !== 'in-progress' && card.state !== 'ready') continue
    const bot = laneOf(card.lane)
    if (bot && bot !== 'owner') lanes.set(bot, [...lanes.get(bot) ?? [], { projectId, card }])
  }
  if (!lanes.size) return out
  // Only 'working' proves the Bot is running (script/CI waits included, bellteam-running); unknown or a failed read is prompted.
  const turns = await effect('turns.read', { botIds: [...lanes.keys()] }).then(value => value.turns, () => ({}))
  for (const [bot, entries] of lanes) {
    if (turns[bot] === 'working') { out.skipped++; continue }
    let sent = true
    for (const message of nudgeMessages(entries)) {
      const value = await effect('messages.send', { from: 'scheduler', target: bot, message }).catch(() => null)
      if (!['running', 'steered', 'queued', 'delivered', 'answered'].includes(value?.delivery)) sent = false
    }
    if (sent) out.prompted++
    else { out.failed++; log(`lattice-nudge-send ${bot} not accepted`) }
  }
  return out
}
