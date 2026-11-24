import { appendFile, mkdir, readdir, stat } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { TimelineIndex, cardWindow, pageLimit } from './timeline-index.mjs'
import { backward, forward, head, parseRecord } from './machine-stream-file.mjs'
import displayRules from './machine-display-rules.json' with { type: 'json' }

// A machine seat's stream-json as the chat log (conversation/machine-stream.md, a471).
// Every line is stored unchanged; the view and the show/fold display are derived at read time.
const fail = code => Object.assign(new Error(code), { code })
const NO_REQUESTS = new Map()
const ROW_TEXT_MAX = 20000 // the whole text of a result for the try; the raw line stays available by seq
const cut = (value, max) => { const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''; return text.length > max ? [text.slice(0, max), true] : [text, false] }
// a471-auto-approval-noise: the one plain line a tool's input stands for (the command or the file, never the raw JSON) in a tool_use and an approval card.
const SUMMARY_KEYS = ['command', 'file_path', 'notebook_path', 'pattern', 'path', 'url', 'query', 'skill', 'description', 'prompt', 'plan']
export function toolSummary(input, max = 200) {
  if (!plain(input)) return cut(input ?? '', max)[0]
  const first = SUMMARY_KEYS.find(key => str(input[key]))
  if (!first) return cut(input, max)[0]
  // a search names where it looks: "pattern in path"
  const where = first === 'pattern' && str(input.path) ? ` in ${input.path}` : ''
  return cut(`${input[first].trim()}${where}`, max)[0]
}
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const str = value => typeof value === 'string' && value.length > 0 ? value : null
const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null

function questionsOf(input) {
  const raw = Array.isArray(input?.questions) ? input.questions : []
  if (raw.length < 1 || raw.length > 4) return null
  const questions = raw.map(entry => {
    const options = Array.isArray(entry?.options) ? entry.options.map((option, i) => ({ index: i + 1, label: text(option?.label, 500), description: text(option?.description, 2000) })) : []
    const question = text(entry?.question, 2000)
    return question && options.length >= 1 && options.length <= 12 && options.every(o => o.label)
      ? { header: text(entry?.header, 200), question, multiSelect: entry?.multiSelect === true, allowOther: true, options } : null
  })
  return questions.every(Boolean) ? questions : null
}

const resultText = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(block => block?.type === 'text' ? block.text : JSON.stringify(block)).join('\n') : JSON.stringify(content) ?? ''

// a471-auto-approval-noise: a request the seat answered itself is one folded line (the tool and its plain summary), not an approval card.
// The request table knows it while the record is in the window; a record read from the file carries it in `auto`.
const isCard = part => part.request_id && (part.view === 'approval' || part.view === 'question')
const autoPart = (requests, record, part) => {
  if (!isCard(part)) return part
  const request = requests.get(part.request_id)
  return (request ? request.status === 'auto' : Boolean(record.auto?.includes(part.request_id)))
    ? { type: part.type, subtype: part.subtype, view: 'control', title: `${part.tool?.name ?? 'tool'} allowed automatically`, text: part.tool?.summary ?? '' } : part
}

// project() of a stored record, once.
const parts = new WeakMap()
const partsOf = record => { if (!parts.has(record)) parts.set(record, project(record.line)); return parts.get(record) }

// raw line -> list of entry parts. Unknown or unreadable input becomes the 'unknown' view, never nothing.
export function project(line) {
  let value
  try { value = JSON.parse(line) } catch { return [{ type: 'not-json', subtype: null, view: 'unknown', title: 'not-json', text: line }] }
  if (!plain(value)) return [{ type: 'not-json', subtype: null, view: 'unknown', title: 'not-json', text: line }]
  const { type } = value, subtype = str(value.subtype) ?? str(value.request?.subtype)
  const part = fields => ({ type: str(type) ?? 'unknown', subtype, ...fields })
  // summary: a short plain word for the one-line label, so the label never carries the raw JSON (it stays in text, opened, and by seq)
  const unknown = title => part({ view: 'unknown', title: title ?? str(type) ?? 'unknown', text: line, summary: str(value.state) ?? str(value.phase) ?? subtype ?? '' })
  const blocks = content => typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
  switch (type) {
    case 'assistant': {
      const parts = blocks(value.message?.content).map(block => {
        if (block?.type === 'text') return part({ view: 'words', title: null, text: block.text ?? '', shown_elsewhere: true })
        if (block?.type === 'thinking') return part({ view: 'thinking', title: block.thinking?.trim() ? 'thinking' : 'thinking (no text)', text: block.thinking ?? '' })
        if (block?.type === 'tool_use') return part({ view: 'tool_use', title: block.name ?? 'tool', text: '', tool: { id: str(block.id), name: str(block.name), summary: toolSummary(block.input) } })
        return unknown(str(block?.type) ?? 'assistant')
      })
      return parts.length ? parts : [unknown('assistant')]
    }
    case 'user': {
      const parts = blocks(value.message?.content).map(block => block?.type === 'tool_result'
        ? part({ view: 'tool_result', title: 'tool_result', text: resultText(block.content), tool: { id: str(block.tool_use_id), name: null, summary: '' }, is_error: block.is_error === true })
        : block?.type === 'text' ? part({ view: 'words', title: 'input', text: block.text ?? '', shown_elsewhere: true }) : unknown('user'))
      return parts.length ? parts : [unknown('user')]
    }
    case 'system':
      if (/^hook_/u.test(subtype ?? '')) return [part({ view: 'hook', title: subtype, text: str(value.hook_name) ?? '' })]
      if (subtype === 'init') return [part({ view: 'system', title: `start: ${value.model ?? '?'}, ${Array.isArray(value.tools) ? value.tools.length : '?'} tools`, text: '' })]
      return [part({ view: 'system', title: subtype ?? 'system', text: str(value.message) ?? str(value.error) ?? '', is_error: Boolean(value.error) || /error|auth/iu.test(subtype ?? '') })]
    case 'result': {
      const normal = (subtype ?? 'success') === 'success' && value.is_error !== true && !/^aborted/u.test(value.terminal_reason ?? '')
      return [part({ view: 'result', title: normal ? `done: ${Number.isFinite(value.duration_ms) ? `${(value.duration_ms / 1000).toFixed(1)}s` : ''}`.trim() : (subtype ?? 'result'),
        text: `turns=${value.num_turns ?? ''} cost=${value.total_cost_usd ?? ''}${value.terminal_reason ? ` ${value.terminal_reason}` : ''}`, is_error: !normal })]
    }
    case 'rate_limit_event': return [part({ view: 'rate_limit', title: `rate limit: ${value.rate_limit_info?.status ?? '?'}`, status: str(value.rate_limit_info?.status), text: JSON.stringify(value.rate_limit_info ?? {}), summary: '' })]
    case 'control_request': {
      const request = value.request
      if (request?.subtype !== 'can_use_tool' || !str(value.request_id)) return [part({ view: 'control', title: subtype ?? 'control_request', text: '' })]
      const questions = request.tool_name === 'AskUserQuestion' ? questionsOf(request.input) : null
      if (request.tool_name === 'AskUserQuestion' && !questions) return [unknown('AskUserQuestion')]
      return [part({ view: questions ? 'question' : 'approval', title: request.tool_name ?? 'tool', text: questions ? questions[0].question : '',
        tool: { id: null, name: str(request.tool_name), summary: toolSummary(request.input) }, request_id: value.request_id, questions, input: request.input ?? {},
        // seat-approvals.md: Claude Code's own reason for asking (a measured prompt: "Dangerous rm operation on working directory or its ancestor: …").
        decision_reason: str(request.decision_reason) })]
    }
    case 'control_cancel_request': case 'control_response': case 'stream_event':
      return [part({ view: 'control', title: str(type), text: '', request_id: str(value.request_id) ?? str(value.response?.request_id) })]
    default: return [unknown()]
  }
}

const ruleMatches = (r, part) => r.view === part.view && (r.empty === undefined || r.empty === !part.text.trim())
  && (r.is_error === undefined || r.is_error === (part.is_error === true)) && (r.title === undefined || r.title === part.title)
  && (r.status === undefined || r.status === part.status)

export function displayOf(part, rules = displayRules) {
  if (part.view === 'question' || part.view === 'approval') return 'show'
  const refined = rules.refine?.find(r => ruleMatches(r, part))
  // display is show or fold: anything but 'fold' shows.
  return (refined?.display ?? rules[part.view]) === 'fold' ? 'fold' : 'show'
}

// a481-hide-background-input: a part the table leaves out of the page (stored lines never change).
export const omittedOf = (part, rules = displayRules) => !(part.view === 'question' || part.view === 'approval')
  && Boolean(rules.omit?.some(r => ruleMatches(r, part))) && !rules.omit_except?.some(r => ruleMatches(r, part))

// heap-oom-n102-machine-stream-window: the file is the log; memory holds the newest WINDOW_RECORDS records of a Bot (twice that before a trim).
export const WINDOW_RECORDS = 2000
const CHECKPOINT_EVERY = 512 // one (seq, offset, at) per this many records of the file index
const LOOKBACK_MAX = 20000 // shortcut: a run of tool lines with no shown line or result this long is read as starting at its first record, when a window needs the run state before it
const seqOfId = id => Number(id.split('-')[1])
const newBot = () => ({ seq: 0, cursor: null, requests: new Map(), sources: new Map(), floor: 0, initFloor: 0, history: null, rows: new TimelineIndex(), shown: new TimelineIndex(), quiet: new TimelineIndex(), shownQuiet: new TimelineIndex(), toolRun: false, folds: new Map(), chain: Promise.resolve() })

export class MachineStream {
  constructor({ root, bots, streamSend, onRequest = () => {}, now = () => new Date().toISOString(), rules = displayRules, showThinking = () => true, window = WINDOW_RECORDS }) { // no setting wired (a test, a lone service) hides nothing; the body wires the Owner's setting
    this.directory = join(root, 'state/machine-stream')
    this.bots = bots; this.streamSend = streamSend; this.onRequest = onRequest; this.now = now; this.rules = rules; this.showThinking = showThinking; this.window = window
    this.state = new Map() // botId -> { seq, cursor, requests, sources, floor, rows, shown, quiet, shownQuiet, folds, history, chain }
    this.busy = new Set()
    this.events = new EventEmitter()
  }

  path(botId) { return join(this.directory, `${botId}.jsonl`) }

  async initialize({ readOnly = false } = {}) {
    if (!readOnly) await mkdir(this.directory, { recursive: true, mode: 0o700 })
    for (const file of await readdir(this.directory)) {
      if (!file.endsWith('.jsonl')) continue
      const botId = file.slice(0, -6), path = join(this.directory, file)
      // Only the newest records are read (the file is never read whole); a torn last line is dropped by parseRecord.
      const { records, toolRun, floor } = await this.back(path, (await stat(path)).size, () => 1, this.window)
      // A trailing batch without its cursor was torn: cut it so the cursor and the events never disagree.
      while (records.length && records.at(-1).type === 'line' && records.at(-1).cursor_after === null) records.pop()
      const bot = this.bot(botId)
      bot.floor = bot.initFloor = floor; bot.seq = floor; bot.toolRun = toolRun
      for (const record of records) this.apply(bot, botId, record)
    }
  }

  // The newest records of a file that end before byte `end`: the fewest that weigh at least `want` (weigh(record) = records, or rows) and are
  // started by a reset record (one that ends a tool run), so the tool run state after it is all a later row's fold needs. `floor` = the seq of
  // that record (the records of the result are the ones after it; 0 = the file start was reached, nothing is older).
  async back(path, end, weigh, want) {
    const batches = []
    let total = 0
    for await (const lines of backward(path, end)) {
      batches.unshift(lines.map(parseRecord).filter(Boolean)); total += batches[0].length
      const found = batches.flat()
      let after = 0
      for (let at = found.length - 1; at >= 0; at--) {
        if (after >= want && this.resets(found[at])) return { records: found.slice(at + 1), toolRun: this.toolRunAfter(found[at]), floor: found[at].seq }
        after += weigh(found[at])
      }
      if (total > LOOKBACK_MAX && after >= want) return { records: found, toolRun: false, floor: found[0].seq - 1 }
    }
    return { records: batches.flat(), toolRun: false, floor: 0 }
  }

  // The rows a record gives the index a page reads (quiet = the one without thinking).
  rowsOf(record, quiet) { return record.type === 'line' ? partsOf(record).filter(part => !omittedOf(autoPart(NO_REQUESTS, record, part), this.rules) && !(quiet && part.view === 'thinking')).length : 0 }
  resets(record) { return record.type === 'line' && partsOf(record).some(part => { const own = autoPart(NO_REQUESTS, record, part); return own.view === 'result' || displayOf(own, this.rules) !== 'fold' }) }
  toolRunAfter(record) {
    const run = { requests: NO_REQUESTS, folds: new Map(), toolRun: false }
    partsOf(record).forEach((part, n) => this.openOrCloseToolRun(run, record, n, autoPart(NO_REQUESTS, record, part)))
    return run.toolRun
  }

  bot(botId) {
    if (!this.state.has(botId)) this.state.set(botId, newBot())
    return this.state.get(botId)
  }

  cursor(botId) { return structuredClone(this.state.get(botId)?.cursor ?? null) }

  // One record into memory: cursor, requests and the entries. Used at load and after every write.
  apply(bot, botId, record) {
    bot.seq = Math.max(bot.seq, record.seq)
    if (record.type === 'line' || record.type === 'cursor') {
      if (record.cursor_after !== null) bot.cursor = { session: record.session, launch_id: record.launch_id, cursor: record.cursor_after }
    }
    const changed = []
    if (record.type === 'line') {
      partsOf(record).forEach((part, n) => {
        this.track(bot, botId, record, n, part, changed)
        this.render(bot, botId, record, n, part, changed)
      })
    } else if (record.type === 'local') this.setRequest(bot, record.request_id, record.local, record.at, record, changed)
    return changed
  }

  // The requests a part opens or closes.
  track(bot, botId, record, n, part, changed) {
    if (part.request_id && part.view === 'control' && part.type === 'control_cancel_request') this.setRequest(bot, part.request_id, 'expired', record.at, null, changed)
    if (isCard(part) && !bot.requests.has(part.request_id)) {
      bot.requests.set(part.request_id, { id: part.request_id, botId, seq: record.seq, part: n, tool: part.tool.name, input: part.input, reason: part.decision_reason ?? null, questions: part.questions,
        status: record.auto?.includes(part.request_id) ? 'auto' : 'pending', answers: null, decision: null, at: record.at, answeredAt: null, expiredAt: null })
      bot.sources.set(part.request_id, record) // the line of an open request: its row is drawn again when the status changes
    }
  }

  // The entry of one part (tool run state, then the row).
  render(bot, botId, record, n, part, changed) {
    this.openOrCloseToolRun(bot, record, n, autoPart(bot.requests, record, part))
    changed.push(this.setRow(bot, botId, record, n, part))
  }

  setRequest(bot, id, status, at, record, changed) {
    const request = bot.requests.get(id)
    // a471-auto-approval-noise: 'auto' = the seat answered it itself (the supplier does not list it as waiting); 'listed' = the supplier lists it after all, so it waits for the Owner.
    if (status === 'listed') { if (!request || request.status !== 'auto') return; request.status = 'pending' }
    else if (!request || request.status !== 'pending') return
    else Object.assign(request, status === 'answered' ? { status, answers: record?.answers ?? null, decision: record?.decision ?? null, answeredAt: at } : status === 'auto' ? { status } : { status: 'expired', expiredAt: at })
    const source = bot.sources.get(id)
    if (source && request.seq > bot.floor) changed.push(this.setRow(bot, request.botId, source, request.part, partsOf(source)[request.part]))
    if (request.status === 'answered' || request.status === 'expired') bot.sources.delete(id)
  }

  row(bot, botId, record, n, original) {
    const part = autoPart(bot.requests, record, original)
    const request = part.request_id ? bot.requests.get(part.request_id) : null
    const shown = part.shown_elsewhere === true
    const display = displayOf(part, this.rules)
    const [body, truncated] = cut(part.text, ROW_TEXT_MAX)
    const sender = { id: botId, name: this.bots.get(botId)?.name ?? botId }
    const entry = { seq: record.seq, part: n, launch_id: record.launch_id, type: part.type, subtype: part.subtype, view: part.view, display,
      title: part.title, text: body, truncated, ...(display === 'fold' ? (bot.folds.get(`me-${record.seq}-${n}`) ?? { fold_group: this.rules.fold_group?.[part.view] ?? part.view }) : {}), ...(shown ? { shown_elsewhere: true } : {}), ...(part.view === 'words' && part.title !== 'input' && part.text.trim() ? { bubble: true } : {}), ...(part.tool ? { tool: part.tool } : {}),
      ...(request && (part.view === 'question' || part.view === 'approval') ? { request: { request_id: request.id, status: request.status,
        ...(request.questions ? { questions: request.questions } : {}), ...(request.answers ? { answers: request.answers } : {}), ...(request.decision ? { decision: request.decision } : {}) } } : {}) }
    // a479-interim-bubble: every words entry of the seat is a bubble from the moment it is stored; nothing is marked later.
    const line = part.summary !== undefined ? part.summary : body.split('\n')[0].slice(0, 120)
    return { id: `me-${record.seq}-${n}`, kind: 'machine_event', direction: 'incoming', at: record.at, sender,
      message: part.title ? `${part.title}${line ? `: ${line}` : ''}` : line, machine_event: entry }
  }

  // a471-tune-tools: a folded tool_use opens a tool run; every folded entry after it joins the run (fold_group tools, fold_count 0)
  // until a shown entry or the turn's result closes it. Only earlier entries decide, so a later entry never changes an earlier one.
  openOrCloseToolRun(bot, record, n, part) {
    const id = `me-${record.seq}-${n}`
    if (bot.folds.has(id)) return
    if (displayOf(part, this.rules) !== 'fold') { bot.toolRun = false; return }
    if (part.view === 'tool_use') bot.toolRun = true
    if (bot.toolRun) bot.folds.set(id, { fold_group: this.rules.fold_group?.tool_use ?? 'tool_use', fold_count: part.view === 'tool_use' ? 1 : 0 })
    if (part.view === 'result') bot.toolRun = false
  }

  setRow(bot, botId, record, n, part) {
    const item = this.row(bot, botId, record, n, part)
    // a481-hide-background-input: an omitted row is in no index. Tool runs and bubbles were decided from every line before this, so nothing else moves.
    if (omittedOf(autoPart(bot.requests, record, part), this.rules)) return item
    // a479-thinking-setting: quiet / shownQuiet are the same rows without thinking, read while the Owner's setting hides it.
    const thinking = item.machine_event.view === 'thinking'
    bot.rows.set(item.id, item)
    if (!thinking) bot.quiet.set(item.id, item)
    if (item.machine_event.display === 'show') { bot.shown.set(item.id, item); if (!thinking) bot.shownQuiet.set(item.id, item) } // the Bot list preview follows what the chat draws open
    return item
  }

  notify(botIds) { this.events.emit('change', { all: false, topics: ['timeline'], botIds: [...new Set(botIds)], roomIds: [] }) }
  watch(listener) { this.events.on('change', listener); return () => this.events.off('change', listener) }

  async write(botId, records) {
    await appendFile(this.path(botId), records.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 })
  }

  // Every write to one Bot's log goes through this chain: seq and the cursor stay in one order.
  chained(bot, work) {
    const run = bot.chain.then(work)
    bot.chain = run.catch(() => {})
    return run
  }

  // execution -> conversation. Serialised per Bot so the cursor chain never forks.
  ingest(envelope) {
    const { botId } = envelope ?? {}
    const check = typeof botId === 'string' && this.bots.has(botId) && typeof envelope.session === 'string' && typeof envelope.launch_id === 'string'
      && (envelope.cursor_from === null || typeof envelope.cursor_from === 'string') && typeof envelope.cursor_after === 'string'
      && Array.isArray(envelope.lines) && envelope.lines.length <= 1000 && envelope.lines.every(line => typeof line === 'string')
    if (!check) return Promise.reject(fail('MACHINE_STREAM_INVALID'))
    const bot = this.bot(botId)
    return this.chained(bot, () => this.ingestOne(bot, envelope))
  }

  async ingestOne(bot, { botId, session, launch_id, cursor_from, cursor_after, lines, state }) {
    const stored = bot.cursor
    const next = stored === null ? cursor_from === null
      : cursor_from === null ? stored.launch_id !== launch_id : cursor_from === stored.cursor && launch_id === stored.launch_id
    if (!next) return { status: 'resync', cursor: stored?.cursor ?? null }
    const at = this.now(), records = []
    let seq = bot.seq
    lines.forEach((line, i) => records.push({ seq: ++seq, type: 'line', at, session, launch_id, cursor_after: i === lines.length - 1 ? cursor_after : null, line }))
    if (!lines.length && stored?.cursor !== cursor_after) records.push({ seq: ++seq, type: 'cursor', at, session, launch_id, cursor_after })
    // a471-auto-approval-noise: only a request the supplier lists as waiting reaches the Owner (push and card). A request line of this envelope that
    // state.pending does not list was answered by the seat itself (or the seat is gone): the line record carries `auto`, and it stays a folded line.
    // A later state that does list it (the state file can trail the stream line) turns it back into a waiting request (local `listed`).
    // No state in the envelope: it waits, as before.
    const waiting = state && Array.isArray(state.pending) ? new Set(state.pending.map(p => p?.request_id)) : null
    if (waiting && state.state !== 'exited') for (const record of records) if (record.type === 'line') {
      const ids = project(record.line).filter(p => p.request_id && (p.view === 'question' || p.view === 'approval')).map(p => p.request_id).filter(id => !waiting.has(id))
      if (ids.length) record.auto = ids
    }
    const closing = []
    if (state && Array.isArray(state.pending)) {
      const pending = new Set(state.pending.map(p => p?.request_id))
      // Requests this envelope itself opens are checked after it is applied. One whose answer is in flight is left to answer(): the seat stops listing it once it took the answer.
      for (const request of bot.requests.values()) if (request.status === 'pending' && !this.busy.has(request.id) && (state.state === 'exited' || !pending.has(request.id))) closing.push(request.id)
    }
    const fresh = new Set(lines.flatMap(line => project(line).map(p => p.request_id).filter(Boolean)))
    const locals = closing.filter(id => !fresh.has(id)).map(id => ({ seq: ++seq, type: 'local', at, local: 'expired', request_id: id }))
    if (records.length + locals.length) await this.write(botId, [...records, ...locals])
    const changed = []
    for (const record of [...records, ...locals]) changed.push(...this.apply(bot, botId, record))
    this.trim(bot)
    if (changed.length || records.length) this.notify([botId])
    const relist = waiting ? [...bot.requests.keys()].filter(id => bot.requests.get(id).status === 'auto' && waiting.has(id)) : []
    if (state?.state !== 'exited') for (const id of fresh) if (bot.requests.get(id)?.status === 'pending') this.onRequest({ id, botId })
    if (relist.length) { await this.expire(bot, botId, relist, 'listed'); for (const id of relist) this.onRequest({ id, botId }) }
    // A request this envelope opened but state.pending no longer lists (the seat exited) is already over.
    const late = state?.state === 'exited' ? [...fresh].filter(id => bot.requests.get(id)?.status === 'pending') : []
    if (late.length) await this.expire(bot, botId, late)
    return { status: 'stored', cursor: cursor_after }
  }

  async expire(bot, botId, ids, local = 'expired') {
    const at = this.now(), locals = ids.map(id => ({ seq: bot.seq + 1 + ids.indexOf(id), type: 'local', at, local, request_id: id }))
    await this.write(botId, locals)
    for (const record of locals) this.apply(bot, botId, record)
    this.trim(bot)
    this.notify([botId])
  }

  // a479-thinking-setting: the Owner's switch; a wired setting that is missing or fails to read is hidden (the default).
  thinkingShown() { try { return this.showThinking() === true } catch { return false } }
  displayChanged() { this.notify([...this.state.keys()]) }
  timeline(target) { return target.roomId ? [] : this.timelineView(target).snapshot() }
  timelineView(target, { recent = false } = {}) {
    if (target.roomId) return new TimelineIndex()
    const bot = this.state.get(target.botId), quiet = !this.thinkingShown()
    return bot?.[recent ? (quiet ? 'shownQuiet' : 'shown') : (quiet ? 'quiet' : 'rows')] ?? new TimelineIndex()
  }

  // Quote / forward of one drawn row (reply.md, forward.md): the same {sender, at, text} the saved rows give.
  async rowSource(botId, rowId) {
    const bot = this.state.get(botId)
    if (!bot) return null
    let item = bot.rows.indexOfId(rowId) >= 0 ? bot.rows.at(bot.rows.indexOfId(rowId)) : null
    if (!item && /^me-\d+-\d+$/u.test(rowId) && seqOfId(rowId) <= bot.floor) { // below the window: read it from the file
      const { scratch } = await this.older(bot, botId, seqOfId(rowId), 1)
      item = scratch.rows.indexOfId(rowId) >= 0 ? scratch.rows.at(scratch.rows.indexOfId(rowId)) : null
    }
    return item ? { sender: { id: botId, ...(this.bots.get(botId)?.name ? { name: this.bots.get(botId).name } : {}) }, at: item.at, text: item.machine_event.text } : null
  }

  // The stored raw line of one seq, read from the file.
  async line(botId, seq) {
    const bot = this.state.get(botId), wanted = Number(seq)
    if (!bot) throw fail('MACHINE_EVENT_NOT_FOUND')
    const index = await this.history(bot, botId), offset = await this.offsetOf(botId, index, wanted)
    for await (const { line } of forward(this.path(botId), offset, index.offset)) {
      const record = parseRecord(line)
      if (record?.seq === wanted && record.type === 'line') return { seq: record.seq, line: record.line }
      break
    }
    throw fail('MACHINE_EVENT_NOT_FOUND')
  }

  // The machine rows of one page and how many stored records lie older than them ({rows, skipped} as cardWindow gives for a list held whole).
  // Memory holds the window; a request that reaches below it is read from the file (conversation/machine-stream.md, "Pages").
  async page(botId, { limit, before, after, hint }) {
    const bot = this.state.get(botId)
    if (!bot) return { rows: [], skipped: 0 }
    const kind = this.thinkingShown() ? 'rows' : 'quiet', size = Math.ceil(pageLimit(limit)), memory = bot[kind].snapshot()
    const slice = cardWindow(memory, { limit, before, after, hint })
    if (!bot.floor || after) return { rows: slice.rows, skipped: slice.skipped + bot.floor }
    const machine = /^me-\d+-\d+$/u.test(before ?? '')
    // The cursor is older than the window: the page is read from the file, up to the cursor's own record.
    let cut = null
    if (machine && seqOfId(before) <= bot.floor) cut = seqOfId(before)
    else if (before && typeof hint === 'string' && hint && (!memory.length || hint < memory[0].at)) cut = Math.min(bot.floor, await this.lastSeqAtOrBefore(botId, await this.history(bot, botId), hint))
    if (cut !== null) return this.fromFile(bot, botId, cut, size, kind)
    if (slice.skipped > 0) return { rows: slice.rows, skipped: slice.skipped + bot.floor }
    // The slice starts at the window's first row: more rows older than it are filled in.
    const older = await this.fromFile(bot, botId, bot.floor, size, kind)
    return { rows: [...older.rows, ...slice.rows], skipped: older.skipped }
  }

  async fromFile(bot, botId, cut, want, kind) {
    const { scratch, floor } = await this.older(bot, botId, cut, want, kind === 'quiet')
    return { rows: scratch[kind].snapshot(), skipped: floor }
  }

  // Rows of the records with seq <= cut, read from the file backwards until `want` rows are in hand.
  async older(bot, botId, cut, want, quiet = false) {
    const index = await this.history(bot, botId), end = await this.offsetOf(botId, index, cut + 1)
    // `want` rows must lie before the cut record: the cursor's own record does not count, or a page could hold the cursor and nothing older.
    const { records, toolRun, floor } = await this.back(this.path(botId), end, record => record.seq < cut ? this.rowsOf(record, quiet) : 0, want)
    const scratch = { ...newBot(), requests: bot.requests, toolRun }
    for (const record of records) if (record.type === 'line') partsOf(record).forEach((part, n) => this.render(scratch, botId, record, n, part, []))
    return { scratch, floor }
  }

  // The file index, built once per Bot and process on the first read below the window and extended to the end of the file at each later one:
  // a checkpoint every CHECKPOINT_EVERY records (seq, offset, at), and the requests (cards) of the records older than the window at load.
  history(bot, botId) {
    const index = bot.history ??= { offset: 0, count: 0, checkpoints: [], prefix: bot.initFloor > 0 ? new Map() : null, work: Promise.resolve() }
    const run = index.work.then(() => this.extend(bot, botId, index))
    index.work = run.catch(() => {})
    return run.then(() => index)
  }

  async extend(bot, botId, index) {
    const path = this.path(botId), { size: end, ino } = await stat(path)
    // The file was replaced or cut under us (history put back, mstream-archive-20261124): the offsets are those of another file, start again.
    if ((index.ino !== undefined && index.ino !== ino) || end < index.offset) Object.assign(index, { offset: 0, count: 0, checkpoints: [], prefix: bot.initFloor > 0 ? new Map() : null })
    index.ino = ino
    if (end <= index.offset) return
    for await (const { offset, line } of forward(path, index.offset, end)) {
      index.offset = offset + line.length + 1
      const found = head(line)
      if (!found) continue
      if (index.count++ % CHECKPOINT_EVERY === 0) index.checkpoints.push({ seq: found.seq, offset, at: found.at })
      if (index.prefix && (found.type === 'local' || line.includes('control_'))) this.trackOlder(bot, botId, index.prefix, parseRecord(line))
    }
    if (!index.prefix) return
    // A card still pending below the window was closed by the seat leaving it: the live one is re-listed by state, the rest expire at once.
    for (const [id, request] of index.prefix) {
      if (request.status === 'pending') Object.assign(request, { status: 'expired', expiredAt: null })
      delete request.input
      if (!bot.requests.has(id)) bot.requests.set(id, request)
    }
    index.prefix = null
  }

  // The cards of a record older than the window (opened there, closed there or after): the request table for the rows read from the file.
  trackOlder(bot, botId, requests, record) {
    if (!record) return
    const own = { requests, sources: new Map(), floor: 0 }
    if (record.type === 'local') return this.setRequest(own, record.request_id, record.local, record.at, record, [])
    if (record.type !== 'line') return
    partsOf(record).forEach((part, n) => {
      if (record.seq <= bot.initFloor && !record.auto?.includes(part.request_id)) this.track(own, botId, record, n, part, [])
      else if (part.request_id && part.view === 'control' && part.type === 'control_cancel_request') this.setRequest(own, part.request_id, 'expired', record.at, null, [])
    })
  }

  // The byte offset of the first record with seq >= target (the end of the scanned file when there is none).
  async offsetOf(botId, index, target) {
    let from = 0
    for (const checkpoint of index.checkpoints) { if (checkpoint.seq >= target) break; from = checkpoint.offset }
    for await (const { offset, line } of forward(this.path(botId), from, index.offset)) if ((head(line)?.seq ?? 0) >= target) return offset
    return index.offset
  }

  // The seq of the last record stored at or before `at` (0 = none).
  async lastSeqAtOrBefore(botId, index, at) {
    let from = 0, seq = 0
    for (const checkpoint of index.checkpoints) { if (checkpoint.at > at) break; from = checkpoint.offset }
    for await (const { line } of forward(this.path(botId), from, index.offset)) {
      const found = head(line)
      if (!found) continue
      if (found.at > at) break
      seq = found.seq
    }
    return seq
  }

  // Records below bot.seq - window leave memory once twice the window is held (the file keeps them; floor says where memory starts).
  trim(bot) {
    if (bot.seq - bot.floor <= 2 * this.window) return
    const floor = bot.seq - this.window, keep = item => item.machine_event.seq > floor
    for (const rows of [bot.rows, bot.shown, bot.quiet, bot.shownQuiet]) rows.retain(keep)
    for (const id of bot.folds.keys()) if (seqOfId(id) <= floor) bot.folds.delete(id)
    for (const [id, request] of bot.requests) {
      if (request.seq > floor) continue
      if (request.status === 'auto') { bot.requests.delete(id); bot.sources.delete(id) } // its row is in no page
      else if (request.status !== 'pending') delete request.input // a closed card keeps what its row shows
    }
    bot.floor = floor
  }

  find(requestId) {
    for (const [botId, bot] of this.state) if (bot.requests.has(requestId)) return { botId, bot, request: bot.requests.get(requestId) }
    throw fail('SEAT_REQUEST_NOT_FOUND')
  }

  get(requestId) { return structuredClone(this.find(requestId).request) }

  // seat-approvals.md: a machine seat's open tool approvals, oldest first (Aiterm's claude_approval answers the first one). Read only.
  pendingApprovals(botId) {
    return [...this.state.get(botId)?.requests.values() ?? []].filter(request => request.status === 'pending' && request.tool !== 'AskUserQuestion')
      .sort((a, b) => a.seq - b.seq || a.part - b.part)
      .map(request => ({ id: request.id, tool: request.tool, command: toolSummary(request.input, 2000), reason: request.reason ?? null }))
  }

  // Owner -> conversation -> execution -> Aiterm. 'answered' only after Aiterm took the line.
  async answer(requestId, body = {}) {
    const { botId, bot, request } = this.find(requestId)
    if (request.status !== 'pending' || this.busy.has(requestId)) throw fail('SEAT_REQUEST_CLOSED')
    const line = request.questions ? answerLine(request, body) : decisionLine(request, body)
    this.busy.add(requestId)
    try {
      let result
      try { result = await this.streamSend(botId, { lines: [line.line] }) }
      catch (error) {
        if (error?.code === 'STREAM_REQUEST_NOT_PENDING') { await this.chained(bot, () => this.expire(bot, botId, [requestId])); throw fail('REQUEST_NOT_PENDING') }
        throw error
      }
      if (result?.accepted === false) throw fail('SEAT_REQUEST_ANSWER_FAILED')
      await this.chained(bot, async () => {
        const record = { seq: bot.seq + 1, type: 'local', at: this.now(), local: 'answered', request_id: requestId, ...(line.answers ? { answers: line.answers } : { decision: line.decision }) }
        await this.write(botId, [record])
        this.apply(bot, botId, record)
        this.trim(bot)
        this.notify([botId])
      })
      return this.get(requestId)
    } finally { this.busy.delete(requestId) }
  }
}

function envelope(request, response) {
  return { type: 'control_response', response: { subtype: 'success', request_id: request.id, response } }
}

// The answer must fit the request: one entry per question, known indexes, several only for multiSelect, free text as Other.
function answerLine(request, { answers } = {}) {
  if (!Array.isArray(answers) || answers.length !== request.questions.length) throw fail('SEAT_REQUEST_ANSWER_INVALID')
  const checked = answers.map((answer, i) => {
    const q = request.questions[i]
    const indexes = Array.isArray(answer?.indexes) ? answer.indexes : []
    const other = answer?.other == null ? null : text(answer.other, 4000)
    if (answer?.other != null && !other) throw fail('SEAT_REQUEST_ANSWER_INVALID')
    const total = indexes.length + (other ? 1 : 0)
    if (!indexes.every(n => q.options.some(o => o.index === n)) || new Set(indexes).size !== indexes.length || total < 1 || (!q.multiSelect && total > 1)) throw fail('SEAT_REQUEST_ANSWER_INVALID')
    return { indexes, other }
  })
  const map = Object.fromEntries(checked.map((a, i) => [request.questions[i].question,
    [...a.indexes.map(n => request.questions[i].options.find(o => o.index === n).label), ...(a.other ? [a.other] : [])].join(', ')]))
  return { answers: checked, line: envelope(request, { behavior: 'allow', updatedInput: { ...request.input, answers: map } }) }
}

function decisionLine(request, { decision } = {}) {
  if (!['allow', 'deny'].includes(decision)) throw fail('SEAT_REQUEST_ANSWER_INVALID')
  return { decision, line: envelope(request, decision === 'allow' ? { behavior: 'allow', updatedInput: request.input } : { behavior: 'deny', message: 'Denied by the Owner' }) }
}
