// Approval Box extension F9 (README section 5b). The module never writes an Approval Box card for a chart task (Owner 2026-11-28):
// the Bot that added an Owner-lane task is told to file it itself, until a request is linked. Pure helpers; the core reads the charts and writes the told record.
export const WITHDRAW_REASON = '作り直します' // the short reason the Owner reads on a machine-written card that is withdrawn
// The Owner lane as the chart spells it, matched case-insensitively as Lattice resolves it. The retired spellings `owner` / `指揮官` stay out: L8 never attached them (a188).
export const OWNER_LANES = Object.freeze(['approval-box', '決裁箱'])
export const isOwnerLane = lane => OWNER_LANES.includes(String(lane ?? '').trim().toLowerCase())
export const TELL_MS = 60 * 60_000, TELL_PER_SCAN = 5 // shortcut: fixed 60 min between tellings of one card, when the Owner wants another interval make it a setting
const STARTABLE = new Set(['ready', 'in-progress']) // Lattice's own word for a task that can start (a pending task behind an open predecessor is not told)
export const keyOf = (projectId, card) => `${projectId}/${card.plan}/${card.taskId}`
export const labelOf = (projectId, card) => `Lattice ${projectId} ${card.plan}/${card.taskId}`
const holds = row => row.state === 'linked' || row.state === 'deferred' || row.state === 'diverged'

// cards of one chart that must be told now: Owner lane, can start, no link row, not told within TELL_MS. told: {key: {toldAt}}.
export const cardsToTell = ({ projectId, cards, rows, told, now }) => cards.filter(card => isOwnerLane(card.lane) && STARTABLE.has(card.state)
  && !rows.some(row => row.projectId === projectId && row.plan === card.plan && row.taskId === card.taskId && holds(row))
  && !(told[keyOf(projectId, card)] && now - Date.parse(told[keyOf(projectId, card)].toldAt) < TELL_MS))

// Who is told: the Bot that added the task, else the chart's creator; only a Bot of the roster. -> Bot id | null
export const adderOf = ({ card, chart, roster }) => [card.addedBy, chart.createdBy].find(id => id && roster.has(id)) ?? null

// The message between Bots (English). count: how many times this card was told before.
export function tellMessage({ projectId, chartName, card, count }) {
  const ref = `${card.plan}/${card.taskId}`
  return [
    `Lattice: you added the task ${ref} 「${card.title}」 on the chart ${chartName ?? projectId} (lattice tool, project ${projectId}), and it is an Owner-lane (approval-box) task that can start now. No Approval Box request is linked to it yet.`,
    `File ONE Approval Box request for it yourself with request_decision (if you already did, check list_my_decisions and make sure its session_label is exactly \`${labelOf(projectId, card)}\`; file nothing twice).`,
    `Write it for the Owner, in the language the user rules give for everything the Owner reads (today Japanese), so that it reads like a request you wrote by hand: the title says in one sentence what he is to do; the background says where (which screen or device), why, and what waits on it; every option says what happens after he picks it. No chart text in another language and no task ids on the card; put on the card what he must see to decide.`,
    `The Approval Box extension closes the task when he answers. The module never writes this card for you. ${count > 0 ? `This is reminder ${count + 1}: it repeats every 60 minutes until a request with that label exists.` : 'If no request exists, it tells you again every 60 minutes.'}`,
  ].join('\n')
}
