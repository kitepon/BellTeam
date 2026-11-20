import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { TimelineIndex } from './timeline-index.mjs'
import displayRules from './machine-display-rules.json' with { type: 'json' }

// A machine seat's stream-json as the chat log (conversation/machine-stream.md, a471).
// Every line is stored unchanged; the view and the show/fold display are derived at read time.
const fail = code => Object.assign(new Error(code), { code })
const ROW_TEXT_MAX = 20000 // the whole text of a result for the try; the raw line stays available by seq
const cut = (value, max) => { const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''; return text.length > max ? [text.slice(0, max), true] : [text, false] }
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

// raw line -> list of entry parts. Unknown or unreadable input becomes the 'unknown' view, never nothing.
export function project(line) {
  let value
  try { value = JSON.parse(line) } catch { return [{ type: 'not-json', subtype: null, view: 'unknown', title: 'not-json', text: line }] }
  if (!plain(value)) return [{ type: 'not-json', subtype: null, view: 'unknown', title: 'not-json', text: line }]
  const { type } = value, subtype = str(value.subtype) ?? str(value.request?.subtype)
  const part = fields => ({ type: str(type) ?? 'unknown', subtype, ...fields })
  const unknown = title => part({ view: 'unknown', title: title ?? str(type) ?? 'unknown', text: line })
  const blocks = content => typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
  switch (type) {
    case 'assistant': {
      const parts = blocks(value.message?.content).map(block => {
        if (block?.type === 'text') return part({ view: 'words', title: null, text: block.text ?? '', shown_elsewhere: true })
        if (block?.type === 'thinking') return part({ view: 'thinking', title: block.thinking?.trim() ? 'thinking' : 'thinking (no text)', text: block.thinking ?? '' })
        if (block?.type === 'tool_use') return part({ view: 'tool_use', title: block.name ?? 'tool', text: '', tool: { id: str(block.id), name: str(block.name), summary: cut(block.input ?? {}, 200)[0] } })
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
    case 'rate_limit_event': return [part({ view: 'rate_limit', title: `rate limit: ${value.rate_limit_info?.status ?? '?'}`, status: str(value.rate_limit_info?.status), text: JSON.stringify(value.rate_limit_info ?? {}) })]
    case 'control_request': {
      const request = value.request
      if (request?.subtype !== 'can_use_tool' || !str(value.request_id)) return [part({ view: 'control', title: subtype ?? 'control_request', text: '' })]
      const questions = request.tool_name === 'AskUserQuestion' ? questionsOf(request.input) : null
      if (request.tool_name === 'AskUserQuestion' && !questions) return [unknown('AskUserQuestion')]
      return [part({ view: questions ? 'question' : 'approval', title: request.tool_name ?? 'tool', text: questions ? questions[0].question : '',
        tool: { id: null, name: str(request.tool_name), summary: cut(request.input ?? {}, 200)[0] }, request_id: value.request_id, questions, input: request.input ?? {} })]
    }
    case 'control_cancel_request': case 'control_response': case 'stream_event':
      return [part({ view: 'control', title: str(type), text: '', request_id: str(value.request_id) ?? str(value.response?.request_id) })]
    default: return [unknown()]
  }
}

export function displayOf(part, rules = displayRules) {
  if (part.view === 'question' || part.view === 'approval') return 'show'
  const refined = rules.refine?.find(r => r.view === part.view && (r.empty === undefined || r.empty === !part.text.trim())
    && (r.is_error === undefined || r.is_error === (part.is_error === true)) && (r.title === undefined || r.title === part.title)
    && (r.status === undefined || r.status === part.status))
  // 'hide' does not exist (Owner 2026-11-20 21:0x JST: fold is fine, removing is not): anything but 'fold' shows.
  return (refined?.display ?? rules[part.view]) === 'fold' ? 'fold' : 'show'
}

export class MachineStream {
  constructor({ root, bots, streamSend, onRequest = () => {}, now = () => new Date().toISOString(), rules = displayRules }) {
    this.directory = join(root, 'state/machine-stream')
    this.bots = bots; this.streamSend = streamSend; this.onRequest = onRequest; this.now = now; this.rules = rules
    this.state = new Map() // botId -> { seq, cursor, records, requests, all, visible, chain }
    this.busy = new Set()
    this.events = new EventEmitter()
  }

  async initialize({ readOnly = false } = {}) {
    if (!readOnly) await mkdir(this.directory, { recursive: true, mode: 0o700 })
    for (const file of await readdir(this.directory)) {
      if (!file.endsWith('.jsonl')) continue
      const botId = file.slice(0, -6), records = []
      for (const row of (await readFile(join(this.directory, file), 'utf8')).split('\n')) {
        if (!row) continue
        try { records.push(JSON.parse(row)) } catch { break } // a torn last line ends the log
      }
      // A trailing batch without its cursor was torn: cut it so the cursor and the events never disagree.
      while (records.length && records.at(-1).type === 'line' && records.at(-1).cursor_after === null) records.pop()
      const bot = this.bot(botId)
      for (const record of records) this.apply(bot, botId, record, false)
    }
  }

  bot(botId) {
    if (!this.state.has(botId)) this.state.set(botId, { seq: 0, cursor: null, records: new Map(), requests: new Map(), rows: new TimelineIndex(), shown: new TimelineIndex(), chain: Promise.resolve() })
    return this.state.get(botId)
  }

  cursor(botId) { return structuredClone(this.state.get(botId)?.cursor ?? null) }

  // One record into memory: cursor, requests and the entries. Used at load and after every write.
  apply(bot, botId, record, live) {
    bot.seq = Math.max(bot.seq, record.seq)
    if (record.type === 'line' || record.type === 'cursor') {
      if (record.cursor_after !== null) bot.cursor = { session: record.session, launch_id: record.launch_id, cursor: record.cursor_after }
    }
    const changed = []
    if (record.type === 'line') {
      bot.records.set(record.seq, record)
      const parts = project(record.line)
      parts.forEach((part, n) => {
        if (part.request_id && part.view === 'control' && part.type === 'control_cancel_request') this.setRequest(bot, part.request_id, 'expired', record.at, null, changed)
        if (part.request_id && (part.view === 'question' || part.view === 'approval') && !bot.requests.has(part.request_id)) {
          bot.requests.set(part.request_id, { id: part.request_id, botId, seq: record.seq, part: n, tool: part.tool.name, input: part.input, questions: part.questions,
            status: 'pending', answers: null, decision: null, at: record.at, answeredAt: null, expiredAt: null })
          if (live) this.onRequest({ id: part.request_id, botId })
        }
        changed.push(this.setRow(bot, botId, record, n, part))
      })
    } else if (record.type === 'local') this.setRequest(bot, record.request_id, record.local, record.at, record, changed)
    return changed
  }

  setRequest(bot, id, status, at, record, changed) {
    const request = bot.requests.get(id)
    if (!request || request.status !== 'pending') return
    Object.assign(request, status === 'answered' ? { status, answers: record?.answers ?? null, decision: record?.decision ?? null, answeredAt: at } : { status: 'expired', expiredAt: at })
    const source = bot.records.get(request.seq)
    if (source) changed.push(this.setRow(bot, request.botId, source, request.part, project(source.line)[request.part]))
  }

  row(bot, botId, record, n, part) {
    const request = part.request_id ? bot.requests.get(part.request_id) : null
    const shown = part.shown_elsewhere === true
    const display = displayOf(part, this.rules)
    const [body, truncated] = cut(part.text, ROW_TEXT_MAX)
    const sender = { id: botId, name: this.bots.get(botId)?.name ?? botId }
    const entry = { seq: record.seq, part: n, launch_id: record.launch_id, type: part.type, subtype: part.subtype, view: part.view, display,
      title: part.title, text: body, truncated, ...(display === 'fold' ? { fold_group: part.view } : {}), ...(shown ? { shown_elsewhere: true } : {}), ...(part.tool ? { tool: part.tool } : {}),
      ...(request && (part.view === 'question' || part.view === 'approval') ? { request: { request_id: request.id, status: request.status,
        ...(request.questions ? { questions: request.questions } : {}), ...(request.answers ? { answers: request.answers } : {}), ...(request.decision ? { decision: request.decision } : {}) } } : {}) }
    const line = body.split('\n')[0].slice(0, 120)
    return { id: `me-${record.seq}-${n}`, kind: 'machine_event', direction: 'incoming', at: record.at, sender,
      message: part.title ? `${part.title}${line ? `: ${line}` : ''}` : line, machine_event: entry }
  }

  setRow(bot, botId, record, n, part) {
    const item = this.row(bot, botId, record, n, part)
    bot.rows.set(item.id, item)
    if (item.machine_event.display === 'show') bot.shown.set(item.id, item) // the Bot list preview follows what the chat draws open
    return item
  }

  notify(botIds) { this.events.emit('change', { all: false, topics: ['timeline'], botIds: [...new Set(botIds)], roomIds: [] }) }
  watch(listener) { this.events.on('change', listener); return () => this.events.off('change', listener) }

  async write(botId, records) {
    await appendFile(join(this.directory, `${botId}.jsonl`), records.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 })
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
    for (const record of [...records, ...locals]) changed.push(...this.apply(bot, botId, record, true))
    if (changed.length || records.length) this.notify([botId])
    // A request this envelope opened but state.pending no longer lists is already over.
    if (state && Array.isArray(state.pending)) {
      const pending = new Set(state.pending.map(p => p?.request_id))
      const late = [...fresh].filter(id => bot.requests.get(id)?.status === 'pending' && (state.state === 'exited' || !pending.has(id)))
      if (late.length) await this.expire(bot, botId, late)
    }
    return { status: 'stored', cursor: cursor_after }
  }

  async expire(bot, botId, ids) {
    const at = this.now(), locals = ids.map(id => ({ seq: bot.seq + 1 + ids.indexOf(id), type: 'local', at, local: 'expired', request_id: id }))
    await this.write(botId, locals)
    for (const record of locals) this.apply(bot, botId, record, true)
    this.notify([botId])
  }

  timeline(target) { return target.roomId ? [] : this.state.get(target.botId)?.rows.snapshot() ?? [] }
  timelineView(target, { recent = false } = {}) { return target.roomId ? new TimelineIndex() : this.state.get(target.botId)?.[recent ? 'shown' : 'rows'] ?? new TimelineIndex() }

  // Quote / forward of one drawn row (reply.md, forward.md): the same {sender, at, text} the saved rows give.
  rowSource(botId, rowId) {
    const rows = this.state.get(botId)?.rows
    const item = rows && rows.indexOfId(rowId) >= 0 ? rows.at(rows.indexOfId(rowId)) : null
    return item ? { sender: { id: botId, ...(this.bots.get(botId)?.name ? { name: this.bots.get(botId).name } : {}) }, at: item.at, text: item.machine_event.text } : null
  }

  line(botId, seq) {
    const record = this.state.get(botId)?.records.get(Number(seq))
    if (!record) throw fail('MACHINE_EVENT_NOT_FOUND')
    return { seq: record.seq, line: record.line }
  }

  find(requestId) {
    for (const [botId, bot] of this.state) if (bot.requests.has(requestId)) return { botId, bot, request: bot.requests.get(requestId) }
    throw fail('SEAT_REQUEST_NOT_FOUND')
  }

  get(requestId) { return structuredClone(this.find(requestId).request) }

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
        this.apply(bot, botId, record, true)
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
