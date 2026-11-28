// Approval Box extension F9: every open Owner-lane card on any chart has exactly one Approval Box request (README section 5b, rules O1-O5; Owner 2026-11-28).
// Pure planners. The core reads the charts and the link rows, calls the parent effects decisions.file / read / cancel (P1) and the Lattice facade, and writes the rows.
import { owner, safe, jst } from './link-plan.mjs'

// The Owner lane as the chart spells it: `approval-box` and the retired spellings Lattice resolves to the Owner (projection.mjs laneResolver).
export const OWNER_LANES = Object.freeze(['approval-box', '決裁箱', 'owner', '指揮官'])
export const OWNER_OPTIONS = Object.freeze([{ id: 'done', label: '済んだ' }, { id: 'not-yet', label: 'まだ（理由を書く）' }]) // the pair Lattice's hand-over already used
export const DEFERRED_MS = 24 * 3_600_000 // shortcut: fixed 24 h before a "not yet" card is asked again; when the Owner wants another interval, make it a setting.
export const FILE_PER_SCAN = 3, READ_PER_SCAN = 10
const ended = card => card?.state === 'done' || card?.state === 'retired'
export const isOwnerCard = card => !ended(card) && OWNER_LANES.includes(String(card?.lane ?? '').trim().toLowerCase())
export const labelOf = (projectId, card) => `Lattice ${projectId} ${card.plan}/${card.taskId}`
// A row means "this card has its request" while it is linked, deferred (asked again later) or diverged; an answered or closed row with an open card is a reopened task.
const holds = row => row.state === 'linked' || row.state === 'deferred' || row.state === 'diverged'

// O1: the open Owner cards of one chart that have no request. rows: every link row.
export const cardsToFile = ({ projectId, cards, rows }) => cards.filter(card => isOwnerCard(card)
  && !rows.some(row => row.projectId === projectId && row.plan === card.plan && row.taskId === card.taskId && holds(row)))

// The request the Owner reads (plain Japanese; the title says what he should do, the background where it comes from).
export function requestOf({ projectId, chartName, card, requester }) {
  return {
    title: String(card.title).slice(0, 120),
    context: `工程表「${chartName ?? projectId}」の工程「${card.title}」（${card.plan}/${card.taskId}）は、指揮官の作業を待っています。\n済んだら「済んだ」を、まだなら「まだ」を選んで理由を書いてください。工程表には、この答えが書き込まれます。`,
    options: OWNER_OPTIONS.map(option => ({ ...option })),
    requester: requester || '工程表',
    sessionLabel: labelOf(projectId, card),
  }
}
export const filedRow = ({ projectId, card, decisionId, at }) =>
  ({ decisionId, projectId, plan: card.plan, taskId: card.taskId, state: 'linked', attached: true, filed: true, sessionLabel: labelOf(projectId, card), handledVersion: 1, updatedAt: at })

// O2/O3: what a filed row does with the request it reads. read: {status: pending|held|answered|cancelled|gone, answer?: {optionId?, text?}}; card: the chart's card or undefined.
// -> {actions: ownerTask actions, cancel?: reason, row: next row | null (removed)}
export function planFiled({ row, card, read, now }) {
  const at = new Date(now).toISOString(), to = (state, extra = {}) => ({ ...row, state, updatedAt: at, ...extra })
  if (read.status === 'gone' || read.status === 'cancelled') return { actions: [], row: null } // nobody can answer it any more: O1 asks again while the card is open
  if (read.status === 'answered') {
    if (!card || ended(card)) return { actions: [], row: to('answered') }
    const given = read.answer?.optionId, text = read.answer?.text
    if (given === 'done') return { actions: [...(card.state === 'in-progress' ? [] : [owner(row.projectId, ['todo', 'start', '--plan', row.plan, '--task', row.taskId])]),
      owner(row.projectId, ['todo', 'done', '--plan', row.plan, '--task', row.taskId, '--message', safe(`指揮官の答え：済んだ（${jst(at)}）`)])], row: to('answered') }
    return { actions: [owner(row.projectId, ['todo', 'note', '--plan', row.plan, '--task', row.taskId, '--message', safe(`指揮官の答え：まだ（${text ?? '理由なし'}）`)])], row: to('deferred', { deferredUntil: new Date(now + DEFERRED_MS).toISOString() }) }
  }
  if (ended(card)) return { actions: [], cancel: 'この工程は工程表で済み（または取り下げ）になったため、申請を取り下げました。', row: to('closed') } // O3
  return { actions: [], row }
}
