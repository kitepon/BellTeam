// Prompt sweep (README L13-L15; Owner 2026-11-12, the whole spec): every chart's cards from the memo projection (the screens' read,
// no `todo nudge`) -> ONE prompt per lane Bot that is not running and has an in-progress or a startable task. No other condition.
// A card whose lane is no Bot and not the Owner goes to the chart's creator Bot instead, asking it to reassign the card (a145).
const LIMIT = 4000
const HEAD = 'Lattice: you are not running, and you have tasks in progress or tasks that can start (every prerequisite is done). Start at least one now.\n'
  // Owner-approved 2026-11-28 (Tronie): the CLI how-to lived here and repeated common rules SECTION waiting; two lines point there.
  + 'If a task cannot move, link what it waits on as common rules SECTION waiting says (前工程, 他条件に接続, ブロック only as the last resort); never leave it stalled.\n'

// Task a145 (Owner 2026-11-15 「こんなに工程があるのに、動いてるやつが少ない…催促で動くんじゃないんだっけ」): Lattice takes any lane id,
// so a card whose lane is no roster Bot and not the Owner reaches nobody; the chart's creator is asked to give it to a member.
const REASSIGN = 'Lattice: on charts you created, these tasks are in progress or can start, but their lane is not a BellTeam Bot or the Owner, so nobody is prompted to do them. '
  + 'Give each one to the member who does it (a Bot id) or to `owner`: `lattice plan show <P> --json`, change the task\'s lane, and send the whole plan back with `lattice plan revise --plan <P> --input <file>`; '
  + 'or retire it (`lattice todo retire --plan <P> --task <T> --reason <why>`) and add it again in the right lane (`lattice todo add ... --lane <Bot id or approval-box>`).\n'

// Connection news (README L26, Tronie 2026-11-28): what changed about the thing a task is connected to, from Lattice's own state and content digest; one line, information only.
const NEWS = 'Lattice: something a task of yours is connected to has changed.\n'
const STATE_TEXT = item => item.state === 'open' ? (item.kind === 'schedule' ? 'the schedule waits again' : 'the target was reopened: the task waits again')
  : item.state === 'settled' ? (item.kind === 'schedule' ? 'the schedule ran' : 'the target is done')
    : item.reason === 'target_retired' ? 'the target was retired' : item.reason === 'schedule_removed' ? 'the schedule was removed' : 'the target no longer exists'
const newsLine = ({ card, news: { item, stateChanged, contentChanged } }) => {
  const what = [stateChanged && STATE_TEXT(item), contentChanged && (stateChanged ? 'its content also changed' : "the target's content changed (title, done condition, lane or split)")].filter(Boolean).join('; ')
  return `- ${card.plan}/${card.taskId} 「${card.title}」 is connected to ${item.ref}${item.targetTitle ? ` 「${item.targetTitle}」` : ''}${item.chartName ? ` (${item.chartName})` : ''}: ${what}`
    + (card.state === 'ready' ? ` -> it can start now: \`lattice todo start --plan ${card.plan} --task ${card.taskId}\`` : '')
}

const line = card => card.state === 'ready'
  ? `- ${card.plan}/${card.taskId} 「${card.title}」: can start -> \`lattice todo start --plan ${card.plan} --task ${card.taskId}\``
  : `- ${card.plan}/${card.taskId} 「${card.title}」: in progress`
const lineOf = (card, reassign, entry) => entry?.news ? newsLine(entry) : reassign ? `- ${card.plan}/${card.taskId} 「${card.title}」: lane ${card.lane ? `"${card.lane}" is not a Bot` : 'is empty'}` : line(card)

// ONE message per Bot per tick (Owner; Epinel gate): each part's head once, then a header per chart and its task lines, within LIMIT.
// Lines that do not fit are left out and counted in the last line, so the Bot still gets exactly one prompt.
const more = n => `\n... and ${n} more of your tasks are in progress or can start: see \`lattice status\` on each chart.`
export function nudgeMessage(entries) {
  const room = LIMIT - more(entries.length).length
  const own = entries.filter(entry => !entry.reassign && !entry.news), other = entries.filter(entry => entry.reassign), told = entries.filter(entry => entry.news)
  let text = '', left = 0
  for (const [head, part] of [[HEAD, own], [REASSIGN, other], [NEWS, told]]) {
    if (!part.length) continue
    text += (text ? '\n\n' : '') + head
    let chart = null
    for (const entry of part) {
      const { projectId, card, reassign } = entry
      // shortcut: a single task line over LIMIT is left out and counted; titles are short. Upgrade if titles ever grow past a few hundred chars.
      const piece = `${projectId === chart ? '' : `\nChart ${projectId} (lattice tool, project ${projectId}):`}\n${lineOf(card, reassign, entry)}`
      if (left || text.length + piece.length > room) { left++; continue }
      text += piece
      chart = projectId
    }
  }
  return left ? text + more(left) : text
}

// charts: [{projectId, createdBy, cards}] from the memo (cards as projection.mjs makes them); laneOf(lane) -> roster Bot id | 'owner' | null.
// `warned`: the reassign warnings already delivered (key = chart/plan/task/lane/state -> creator), so one task's warning reaches its creator once
// and again only when the task changes (b25, Shiratsuru: three warnings in minutes, each delivery starting a turn). The in-prompt tasks repeat by
// design (the Owner's nudge); only the creator warning is once. shortcut: kept in memory per child generation, so a child restart warns once more; upgrade if restarts get frequent.
// `promptedAt`: when each Bot was last prompted (fairness among Claude seats under the cap; shortcut: per child generation, a restart forgets it).
// `again`: per Bot {sig, count, at} of its last accepted prompt; unchanged cards are re-prompted after 1, 5, 15 min (Owner-approved 2026-11-28; shortcut: per child generation).
export const AGAIN_MIN = [1, 5, 15]
export async function nudgeSweep(charts, { laneOf, log, effect, warned = new Map(), news = null, promptedAt = new Map(), again = new Map(), clock = Date.now }) {
  const lanes = new Map(), orphans = new Set(), current = new Set(), out = { charts: charts.length, prompted: 0, skipped: 0, failed: 0 }
  const record = await news?.read().catch(error => (log(`lattice-news-record ${error?.code ?? 'FAILED'}`), null)) ?? null, seen = new Set()
  let recordDirty = false
  const flush = async () => { if (recordDirty) { recordDirty = false; await news.write(record).catch(error => log(`lattice-news-record ${error?.code ?? 'FAILED'}`)) } }
  for (const { projectId, createdBy, cards } of charts) for (const card of cards) {
    if (card.state !== 'in-progress' && card.state !== 'ready') continue
    const bot = laneOf(card.lane)
    if (bot === 'owner') continue
    // A lane that is no Bot goes to the chart's creator (a roster Bot), in its one message (a145).
    const target = bot ?? laneOf(createdBy)
    if (!target || target === 'owner') { orphans.add(projectId); continue }
    const key = bot ? null : `${projectId}\0${card.plan}\0${card.taskId}\0${card.lane ?? ''}\0${card.state}`
    if (key) { current.add(key); if (warned.get(key) === target) continue }
    lanes.set(target, [...lanes.get(target) ?? [], { projectId, card, reassign: !bot, key }])
  }
  // Connection news (README L26): first sight is recorded silently; a different state or content digest is one line in the lane's one message; the record advances only on an accepted send or an Owner lane.
  for (const { projectId, createdBy, cards, news: items = [], verified } of record ? charts : []) {
    for (const item of items) {
      const card = cards.find(entry => entry.id === item.cardId)
      if (!card) continue
      const key = `${projectId}/${item.cardId}/${item.ref}`, was = record[key], next = { state: item.state, content: item.content ?? was?.content ?? null }
      seen.add(key)
      const stateChanged = !!was && was.state !== item.state, contentChanged = !!was?.content && !!item.content && was.content !== item.content
      if (!stateChanged && !contentChanged) { if (!was || was.content !== next.content) { record[key] = next; recordDirty = true } continue }
      const bot = laneOf(card.lane)
      if (bot === 'owner') { record[key] = next; recordDirty = true; continue }
      const target = bot ?? laneOf(createdBy)
      if (!target || target === 'owner') { log(`lattice-news ${projectId} no-creator`); continue }
      lanes.set(target, [...lanes.get(target) ?? [], { projectId, card, news: { item, stateChanged, contentChanged }, newsKey: key, next }])
    }
    // A key whose entry left a verified read of its chart is deleted (the record stays as small as the open connections).
    if (verified) for (const key of Object.keys(record)) if (key.startsWith(`${projectId}/`) && !seen.has(key)) { delete record[key]; recordDirty = true }
  }
  for (const key of warned.keys()) if (!current.has(key)) warned.delete(key)
  for (const projectId of orphans) log(`lattice-nudge-lane ${projectId} no-creator`)
  for (const bot of again.keys()) if (!lanes.has(bot)) again.delete(bot) // nothing to prompt it with: forgotten, so a new card starts at 1 min
  if (!lanes.size) { await flush(); return out }
  // Only 'working' proves the Bot is running (script/CI waits included, bellteam-running); unknown or a failed read is prompted.
  const turns = await effect('turns.read', { botIds: [...lanes.keys()] }).then(value => value.turns, () => ({}))
  // Claude cap (README L15, Owner 2026-11-28 rate-limit order): a Claude seat is started only while fewer than `cap` Claude seats work; a failed read means no cap.
  const read = await effect('claude.load', {}).catch(() => null)
  const load = Array.isArray(read?.claude) && Array.isArray(read.working) && read.cap >= 1 ? read : null // an old body or a failed read: no cap
  const claude = new Set(load?.claude ?? [])
  let places = load ? load.cap - load.working.length : Infinity
  // Fairest first: the Bot prompted longest ago (never prompted first); the order only matters under the cap.
  const order = [...lanes].sort(([a], [b]) => (promptedAt.get(a) ?? 0) - (promptedAt.get(b) ?? 0))
  let capped = 0
  for (const [bot, entries] of order) {
    if (turns[bot] === 'working') { out.skipped++; continue }
    const sig = entries.map(entry => `${entry.projectId}/${entry.card.plan}/${entry.card.taskId}/${entry.card.state}/${entry.newsKey ?? ''}/${entry.reassign ? 'r' : ''}`).sort().join('\n'), last = again.get(bot)
    if (last?.sig === sig && clock() - last.at < AGAIN_MIN[Math.min(last.count - 1, AGAIN_MIN.length - 1)] * 60_000 - 5000) { out.skipped++; continue }
    if (claude.has(bot) && places <= 0) { out.skipped++; capped++; continue }
    // The sends run one by one (a wake can take long), so the batch read above can be stale: a Bot that started a turn since then reads again just before its own send (a481, Mint 2026-11-21).
    const now = await effect('turns.read', { botIds: [bot] }).then(value => value.turns[bot], () => turns[bot])
    if (now === 'working') { out.skipped++; continue }
    const value = await effect('messages.send', { from: 'scheduler', target: bot, message: nudgeMessage(entries) }).catch(() => null)
    if (['running', 'steered', 'queued', 'delivered', 'answered'].includes(value?.delivery)) {
      out.prompted++
      promptedAt.set(bot, clock())
      again.set(bot, { sig, count: last?.sig === sig ? last.count + 1 : 1, at: clock() })
      if (claude.has(bot)) places--
      for (const entry of entries) { if (entry.key) warned.set(entry.key, bot); if (entry.newsKey) { record[entry.newsKey] = entry.next; recordDirty = true } }
      await flush()
    }
    else { out.failed++; log(`lattice-nudge-send ${bot} not accepted`) }
  }
  if (capped) log(`lattice-nudge-cap ${load.working.length}/${load.cap}`)
  await flush()
  return out
}
