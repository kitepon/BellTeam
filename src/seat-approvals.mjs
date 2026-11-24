import { EventEmitter } from 'node:events'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeAtomic } from './json-file.mjs'

// seat-approval-to-abx (execution/seat-approvals.md): a seat blocked on a tool-approval prompt reaches the Owner, as an Approval Box card
// when the hosted daemon is paired, and always as an entry inside BellTeam. One record per prompt occurrence; every front answers through
// the same Aiterm respond with the digest stored here, so the first answer wins.
export const SEAT_APPROVALS_SCHEMA = 'bellteam.seat-approvals.v1'
const HARNESSES = new Set(['claude', 'codex'])
const CHOICES = Object.freeze([{ decision: 'approve_once', label: '1回だけ許可する' }, { decision: 'deny', label: '許可しない' }])
const OPTIONS = Object.freeze(CHOICES.map(({ decision, label }) => ({ id: decision, label })))
const CUT = 2000, KEEP_CLOSED = 50
const REASON = { claude: 'Claude Code は、この操作を自動では許可しません（権限の確認）。', codex: 'Codex が、この操作の許可を求めています。' }
const failure = (code, status) => Object.assign(new Error(code), { code, status })

// shortcut: a pattern list, not a parser; extend when a real token shape leaks, the card is stored by Approval Box.
const SECRET = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu, '[秘密鍵を伏せました]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu, '$1 ***'],
  [/\b(?:sk|pk|ghp|gho|ghs|github_pat|xox[abprs]|AKIA|AIza)[A-Za-z0-9_-]{10,}/gu, '***'],
  [/\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL)[A-Za-z0-9_]*)(\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)/giu, '$1$2***'],
  [/(--?(?:password|passwd|token|secret|api-?key)[= ])(?:"[^"]*"|'[^']*'|\S+)/giu, '$1***'],
]
export const maskSecrets = text => SECRET.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), String(text ?? ''))
const cut = text => text.length > CUT ? `${text.slice(0, CUT)}（以下省略）` : text
const jst = ms => new Date(ms + 9 * 3600_000).toISOString().replace('T', ' ').slice(0, 16)

const cardText = (record, name) => ({
  title: `${name}が、「${record.facts.tool ?? '権限の確認'}」を1回だけ実行してよいか、決めてください`,
  context: [`Bot: ${name}`, `ハーネス: ${record.harness}`, record.facts.command ? `内容:\n${record.facts.command}` : '内容: この席の画面で確かめてください。',
    `理由: ${record.facts.reason}`, `出た時刻: ${jst(record.firstSeen)} JST`].join('\n'),
})
const labelOf = record => `Seat ${record.botId} ${record.digest.slice(7, 23)} ${Math.floor(record.firstSeen / 1000)}`
const view = (record, name) => ({ id: record.id, botId: record.botId, botName: name, harness: record.harness, tool: record.facts.tool, command: record.facts.command,
  reason: record.facts.reason, since: new Date(record.firstSeen).toISOString(), choices: CHOICES, card: record.decisionId ? 'filed' : 'none' })

// bots: the Bot Map; transport: screenApproval + currentWork; machineStream.pendingApprovals(botId); decisions: createApprovalDecisions();
// daemon: the hosted daemon ({status()}); push.seatApproval(item); tick every intervalMs once start()ed.
export function createSeatApprovals({ path, bots, transport, machineStream = null, decisions = null, daemon = null, push = null, now = Date.now, intervalMs = 10_000 }) {
  const events = new EventEmitter()
  let records = null, queue = Promise.resolve(), timer = null, ticking = null
  const serial = work => { const next = queue.then(work); queue = next.catch(() => {}); return next }
  const nameOf = botId => bots.get(botId)?.name ?? botId

  async function load() {
    if (records) return records
    try {
      const value = JSON.parse(await readFile(path, 'utf8'))
      records = value?.schema === SEAT_APPROVALS_SCHEMA && Array.isArray(value.records) ? value.records : []
    } catch { records = [] }
    return records
  }
  async function save() {
    const closed = records.filter(record => record.status !== 'open').slice(-KEEP_CLOSED)
    records = [...records.filter(record => record.status === 'open'), ...closed]
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeAtomic(path, { schema: SEAT_APPROVALS_SCHEMA, records })
  }
  const changed = botId => events.emit('change', { all: false, topics: ['seat_approvals'], botIds: [botId], roomIds: [] })
  const paired = async () => !!daemon && await Promise.resolve(daemon.status()).then(status => status?.daemon?.mode === 'pc', () => false)

  // The card is withdrawn when the prompt ended another way; an answered card answers 4xx, which is not a problem.
  const withdraw = (record, reason) => record.decisionId && decisions
    ? decisions.cancel({ decisionId: record.decisionId, reason }).catch(() => {}) : Promise.resolve()

  async function close(record, status, answeredBy, reason) {
    Object.assign(record, { status, ...(answeredBy ? { answeredBy } : {}) })
    await save()
    if (answeredBy !== 'card') await withdraw(record, reason)
    changed(record.botId)
  }

  // The facts of the prompt: a machine seat's first pending approval row, Codex's prompt text, nothing for a TUI Claude (Aiterm gives none).
  function factsOf(bot, inspected) {
    const reason = REASON[bot.harness]
    if (bot.harness === 'claude') {
      const [row] = machineStream?.pendingApprovals?.(bot.id) ?? []
      if (row) return { tool: row.tool ?? null, command: row.command ? cut(maskSecrets(row.command)) : null, reason: row.reason ? `${reason}\nClaude Code の理由: ${cut(maskSecrets(row.reason))}` : reason }
    }
    const command = typeof inspected.prompt === 'string' && inspected.prompt ? cut(maskSecrets(inspected.prompt)) : null
    return { tool: typeof inspected.kind === 'string' ? inspected.kind : null, command, reason }
  }

  async function open(bot, inspected) {
    const firstSeen = now()
    const record = { id: `sa-${bot.id}-${inspected.promptDigest.slice(7, 23)}-${Math.floor(firstSeen / 1000)}`, botId: bot.id, harness: bot.harness,
      digest: inspected.promptDigest, firstSeen, facts: factsOf(bot, inspected), status: 'open', decisionId: null }
    records.push(record)
    await save()
    changed(bot.id)
    // No card (daemon unpaired or file() failed): the Owner is told by a push; with a card the card brings its own.
    if (!await fileCard(record, bot)) push?.seatApproval?.({ id: record.id, botId: bot.id, tool: record.facts.tool })
  }

  async function fileCard(record, bot) {
    if (record.decisionId) return true
    if (!decisions || !await paired()) return false
    try {
      const filed = await decisions.file({ ...cardText(record, bot.name ?? record.botId), options: OPTIONS, requester: bot.name ?? record.botId, session_label: labelOf(record) })
      record.decisionId = filed.decisionId
      await save()
      changed(record.botId)
      return true
    } catch { return false }
  }

  // The prompt as Aiterm shows it now: the open record keeps its digest, a new digest is a new occurrence.
  async function watchBot(bot) {
    const current = records.find(record => record.botId === bot.id && record.status === 'open')
    const inspected = await transport.screenApproval(bot, { action: 'inspect' }).catch(() => null)
    if (!inspected) return // Aiterm did not answer: the record stays as it is, the next tick looks again
    if (inspected.status !== 'approval_required') return current && close(current, 'gone', null, '席の権限の確認が、もうありません。')
    if (current?.digest === inspected.promptDigest) return fileCard(current, bot).then(() => readCard(current))
    if (current) await close(current, 'gone', null, '席の権限の確認が、別のものに替わりました。')
    return open(bot, inspected)
  }

  // The Owner answered the card: apply it to the same prompt, with the digest stored at filing.
  async function readCard(record) {
    if (record.status !== 'open' || !record.decisionId || !decisions) return
    const card = await decisions.read({ decisionId: record.decisionId }).catch(() => null)
    if (card?.status === 'cancelled') { record.decisionId = null; return save() }
    if (card?.status !== 'answered') return
    const decision = CHOICES.some(choice => choice.decision === card.answer?.optionId) ? card.answer.optionId : 'deny' // free text counts as deny
    await respond(record, decision, 'card').catch(() => {})
  }

  async function respond(record, decision, by) {
    const bot = bots.get(record.botId)
    if (!bot) { await close(record, 'gone', null, 'Botが見つかりません。'); throw failure('SEAT_APPROVAL_CLOSED', 409) }
    try { await transport.screenApproval(bot, { action: 'respond', decision, promptDigest: record.digest }) } catch (error) {
      if (error?.code === 'SCREEN_APPROVAL_CHANGED' || error?.code === 'SCREEN_SEAT_ABSENT') { await close(record, 'gone', null, '席の権限の確認が、もうありません。'); throw failure('SEAT_APPROVAL_CLOSED', 409) }
      throw error
    }
    record.decision = decision
    await close(record, 'answered', by, 'BellTeamの画面で答えられました。')
    return { id: record.id, status: 'answered', decision }
  }

  async function tick() {
    await load()
    const candidates = [...bots.values()].filter(bot => HARNESSES.has(bot.harness) && transport.currentWork?.(bot)?.state === 'working')
    // A Bot no longer working keeps no open record (its seat stopped): close it so the card is withdrawn.
    for (const record of records) if (record.status === 'open' && !candidates.some(bot => bot.id === record.botId)) await close(record, 'gone', null, '席が止まりました。')
    for (const bot of candidates) await watchBot(bot).catch(() => {})
  }

  return {
    watch(listener) { events.on('change', listener); return () => events.off('change', listener) },
    async list() { await load(); return records.filter(record => record.status === 'open').sort((a, b) => a.firstSeen - b.firstSeen).map(record => view(record, nameOf(record.botId))) },
    // A tick joins the one that is queued or running: a slow Aiterm never piles ticks up in front of the Owner's answer.
    tick: () => (ticking ??= serial(tick).finally(() => { ticking = null })),
    answer: (id, decision) => serial(async () => {
      await load()
      if (!CHOICES.some(choice => choice.decision === decision)) throw failure('SEAT_APPROVAL_INVALID', 400)
      const record = records.find(item => item.id === id)
      if (!record) throw failure('SEAT_APPROVAL_NOT_FOUND', 404)
      if (record.status !== 'open') throw failure('SEAT_APPROVAL_CLOSED', 409)
      return respond(record, decision, 'app')
    }),
    start() { if (!timer) { timer = setInterval(() => { void this.tick().catch(() => {}) }, intervalMs); timer.unref?.() } },
    stop() { clearInterval(timer); timer = null },
  }
}
