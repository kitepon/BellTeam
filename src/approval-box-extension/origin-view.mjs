// Approval Box extension (Delta): Decision (Approval Box api v0.38) -> ViewDecision (contract/approvals-contract.md). Pure; nothing is stored.
// Visibility never depends on origin.kind: an external or unknown decision is mapped like any other (Owner 2026-11-15).
const TOOLS = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', grok: 'Grok', 'claude.ai': 'Claude', chatgpt: 'ChatGPT', other: 'その他' }
export const CHART_LABEL = /Lattice\s+([a-z0-9][a-z0-9-]{0,62})\s+([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)/u

// roster: [{id, name}] of BellTeam members. Returns {origin, requester}.
export function classifyOrigin(source = {}, roster = []) {
  const client = Object.hasOwn(TOOLS, source.client) ? source.client : 'other'
  const base = { client, sessionLabel: source.session_label ?? '', workLabel: source.work_label ?? '', connectionLabel: source.connection_label ?? '', via: source.via === 'remote' ? 'remote' : 'connector' }
  const byId = source.requester_bot_id && roster.find(member => member.id === source.requester_bot_id)
  if (byId) return { origin: { kind: 'bellteam', basis: 'botId', tool: TOOLS[client], ...base }, requester: { botId: byId.id, name: byId.name } }
  // shortcut: before the connector release that sends requester_bot_id, an exact roster-name match stands in (display and chart link only); drop it once the id is universal.
  const byName = source.requester && roster.find(member => member.name === source.requester)
  if (byName) return { origin: { kind: 'bellteam', basis: 'name', tool: TOOLS[client], ...base }, requester: { botId: byName.id, name: byName.name } }
  if (source.client || source.session_label) return { origin: { kind: 'external', basis: 'none', tool: TOOLS[client], ...base }, requester: null }
  return { origin: { kind: 'unknown', basis: 'none', tool: '出どころ不明', ...base, client: 'other' }, requester: null }
}

const view = list => list.map(item => ({ id: item.id, name: item.name, contentType: item.content_type, size: item.size, sha256: item.sha256 }))
// link: the ViewDecision.link object (read by the caller from the facade and the link record) or null.
// relayed: the answer relay (F8) handed the answer to BellTeam's delivery; it then stands in for a delivery word Approval Box has not confirmed.
export function toViewDecision(decision, { roster = [], link = null, relayed = false } = {}) {
  const { origin, requester } = classifyOrigin(decision.source, roster)
  const amended = [...(decision.history ?? [])].reverse().find(entry => entry.kind === 'amended')
  const answer = decision.answer && { optionId: decision.answer.option_id ?? null, text: decision.answer.text ?? null, attachments: view(decision.answer.attachments ?? []), answeredAt: decision.answer.answered_at }
  return {
    id: decision.id, title: decision.title, context: decision.context,
    options: decision.options.map(option => ({ id: option.id, label: option.label, recommended: option.id === decision.recommendation })),
    urgency: decision.urgency, deadline: decision.deadline ?? null, status: decision.status, answer: answer ?? null, delivery: relayed && !['delivered', 'fetched'].includes(decision.delivery) ? 'delivered' : decision.delivery ?? null,
    resumePhrase: decision.resume_phrase, version: decision.version, createdAt: decision.created_at, updatedAt: decision.updated_at, cancelReason: decision.cancel_reason ?? null,
    amended: { is: Boolean(amended), fields: amended?.fields ?? [], note: amended?.note ?? null, at: amended?.at ?? null },
    history: (decision.history ?? []).map(({ at, kind, by, note, fields }) => ({ at, kind, by, ...(note ? { note } : {}), ...(fields ? { fields } : {}) })),
    requestAttachments: view(decision.request_attachments ?? []), origin, requester, link,
  }
}

// summary counts include every origin (the badge never depends on a filter).
export function summarize(decisions, { roster = [], today = () => false } = {}) {
  const pending = decisions.filter(decision => decision.status === 'pending')
  const bellteam = pending.filter(decision => classifyOrigin(decision.source, roster).origin.kind === 'bellteam').length
  return {
    schema: 'bellteam.approvals-summary.v1', pending: pending.length, urgent: pending.filter(decision => decision.urgency === 'high').length,
    held: decisions.filter(decision => decision.status === 'held').length,
    answeredToday: decisions.filter(decision => decision.status === 'answered' && today(decision.answer?.answered_at)).length,
    filedToday: decisions.filter(decision => today(decision.created_at)).length,
    byOrigin: { bellteam, external: pending.length - bellteam },
  }
}
