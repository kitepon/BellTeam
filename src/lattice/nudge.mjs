// Prompt sweep (README L13-L15; Owner 2026-11-12, the whole spec): every chart's cards from the memo projection (the screens' read,
// no `todo nudge`) -> ONE prompt per lane Bot that is not running and has an in-progress or a startable task. No other condition.
const LIMIT = 4000
const HEAD = 'Lattice: you are not running, and you have tasks in progress or tasks that can start (every prerequisite is done). Start at least one now.\n'
  // Owner settled 2026-11-13 20:0x JST (task a58): a member's work is a predecessor; a stop is the last resort, only for what no AI can operate.
  + 'If a task cannot move because it waits on a member\'s work, connect that work as its predecessor (`lattice todo dependency connect --from-plan <P> --from-task <that task> --to-plan <P> --to-task <T> --reason <why>`; when that task is on another chart, add `--from-project <its chart id>`), '
  + 'or, when that work is not on the chart yet, add it as a task in that member\'s lane (`lattice todo add --plan <P> --task <id> --title <what you wait for> --phase <phase of T> --lane <member Bot id> --before <T> --design-memo <what and why> --reason <why>`). '
  + 'Then return the task to unstarted if it is in progress (`lattice todo retract --plan <P> --task <T> --reason <why>`); a task waiting on prerequisites is not prompted. '
  + 'Only if it waits on something no AI can operate at all (an outside review such as Apple\'s), set a stop as the last resort, naming what it waits on (`lattice todo block --plan <P> --task <T> --reason <what it waits on>`); a stopped task is not prompted.'

const line = card => card.state === 'ready'
  ? `- ${card.plan}/${card.taskId} 「${card.title}」: can start -> \`lattice todo start --plan ${card.plan} --task ${card.taskId}\``
  : `- ${card.plan}/${card.taskId} 「${card.title}」: in progress`

// ONE message per Bot per tick (Owner; Epinel gate): the head once, then a header per chart and its task lines, within LIMIT.
// Lines that do not fit are left out and counted in the last line, so the Bot still gets exactly one prompt.
const more = n => `\n... and ${n} more of your tasks are in progress or can start: see \`lattice status\` on each chart.`
export function nudgeMessage(entries) {
  const room = LIMIT - more(entries.length).length
  let text = HEAD, chart = null, left = 0
  for (const { projectId, card } of entries) {
    // shortcut: a single task line over LIMIT is left out and counted; titles are short. Upgrade if titles ever grow past a few hundred chars.
    const part = `${projectId === chart ? '' : `\nChart ${projectId} (lattice tool, project ${projectId}):`}\n${line(card)}`
    if (left || text.length + part.length > room) { left++; continue }
    text += part
    chart = projectId
  }
  return left ? text + more(left) : text
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
    const value = await effect('messages.send', { from: 'scheduler', target: bot, message: nudgeMessage(entries) }).catch(() => null)
    if (['running', 'steered', 'queued', 'delivered', 'answered'].includes(value?.delivery)) out.prompted++
    else { out.failed++; log(`lattice-nudge-send ${bot} not accepted`) }
  }
  return out
}
