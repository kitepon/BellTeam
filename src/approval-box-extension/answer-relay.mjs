// Approval Box extension (Delta), F8 answer relay (README section 13). Pure: who gets the message, whether it is due, and the words.
// The ledger holds ids and delivery words only, never answer text.
export const RELAY_MAX_AGE_MS = 24 * 3_600_000
export const RELAY_ROW_KEEP_MS = 30 * 86_400_000
// The day the relay first shipped (Z220 module row, 2026-11-27 20:13 JST): the earliest a ledger may start.
export const RELAY_FEATURE_START = '2026-11-27T11:13:00.000Z'
// The messenger's delivery words that mean the seat's queue took it (the same list lattice/owner-decisions.mjs uses).
const ACCEPTED = ['running', 'steered', 'queued', 'delivered', 'answered']
export const relayAccepted = delivery => ACCEPTED.includes(delivery)
const jst = iso => new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')
const cut = (value, max) => (value.length > max ? `${value.slice(0, max)} ... (cut)` : value)

// d: the ViewDecision of an answered decision. book: {since: ISO, rows: [{decisionId, ...}]}. Returns null or {target, message}.
export function planRelay(d, book, now) {
  if (d.status !== 'answered' || !d.answer || d.origin?.kind !== 'bellteam' || !d.requester?.botId) return null
  if (book.rows.some(row => row.decisionId === d.id)) return null
  const at = Date.parse(d.answer.answeredAt)
  if (!(at >= Date.parse(book.since)) || now - at > RELAY_MAX_AGE_MS) return null // answered before the ledger began, or too old: never replayed
  return { target: d.requester.botId, message: relayMessage(d) }
}

export function relayMessage(d) {
  const { optionId, text, attachments } = d.answer
  const option = d.options.find(item => item.id === optionId)
  const chosen = option ? option.label : optionId ?? '(no option)'
  return [
    `Approval Box: the Owner answered your request 「${cut(d.title, 200)}」 (${d.id}).`,
    `Owner's answer (${jst(d.answer.answeredAt)} JST): ${cut(chosen, 500)}${text ? ` / ${cut(text, 8000)}` : ''}`,
    ...(attachments.length ? [`The answer carries ${attachments.length} attachment(s): read them with get_attachment.`] : []),
    'Continue the work that waited for this answer. Approval Box may also have delivered the same answer to your session: if you already received it, ignore this copy.',
  ].join('\n')
}
