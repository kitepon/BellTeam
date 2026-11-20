// A machine seat's chat-log entries (conversation machine-stream.md): the AskUserQuestion and approval cards, and every other kind as one quiet line.
// The card is drawn from the entry's data only; the answer goes back as data to POST /api/seat-requests/:request_id/answer.
const node = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el }
const closedMessage = 'この質問は、もう答えを待っていません。'
const failures = {
  SEAT_REQUEST_CLOSED: closedMessage, REQUEST_NOT_PENDING: closedMessage, SEAT_REQUEST_NOT_FOUND: closedMessage,
  SEAT_REQUEST_ANSWER_INVALID: '答えが質問に合いませんでした。選び直してください。',
  SEAT_REQUEST_UNAVAILABLE: 'このサーバーはまだ答えを受け取れません。',
}

function heading(title, pending) {
  const box = node('div', 'card-heading')
  const icon = node('span', 'card-icon', '?'); icon.setAttribute('aria-hidden', 'true')
  box.append(icon, node('strong', '', title))
  if (pending) box.append(node('span', 'state-badge is-attention', '要対応'))
  return box
}

// The label a finished answer shows: option labels by index, then the free text.
function answerText(question, answer) {
  const labels = (answer?.indexes ?? []).map(index => question.options.find(option => option.index === index)?.label).filter(Boolean)
  return [...labels, ...(answer?.other ? [answer.other] : [])].join('、')
}

// One request: sends once at a time, shows the failure in plain words and keeps the choices for another try.
function sender(request, { api, onChanged }, card, controls) {
  const error = node('p', 'owner-question-error'); error.setAttribute('role', 'alert'); error.hidden = true
  card.append(error)
  let sending = false
  return async body => {
    if (sending) return
    sending = true; error.hidden = true
    controls().forEach(control => { control.disabled = true })
    try {
      const result = await api(`/api/seat-requests/${encodeURIComponent(request.request_id)}/answer`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      onChanged(result.request)
    } catch (failure) {
      error.textContent = failures[failure?.code] ?? '答えを送れませんでした。もう一度選んでください。'
      error.hidden = false
      sending = false
      // A closed request stays disabled: the next read of the page redraws it as expired.
      if (!closedMessage.includes(error.textContent)) controls().forEach(control => { control.disabled = false })
    }
  }
}

function questionCard(event, context) {
  const request = event.request, pending = request.status === 'pending'
  const card = node('section', `owner-question machine-card${pending ? '' : ' is-done'}`)
  card.append(heading(`${context.sender}からの質問`, pending))
  if (!pending) {
    request.questions.forEach((question, index) => {
      const block = node('div', 'machine-question')
      if (question.header) block.append(node('span', 'machine-question-header', question.header))
      block.append(node('p', '', question.question))
      block.append(node('p', 'owner-question-answer card-done', request.status === 'answered' && request.answers?.[index]
        ? `「${answerText(question, request.answers[index])}」と答えました` : closedMessage))
      card.append(block)
    })
    return card
  }
  const controls = []
  const send = sender(request, context, card, () => controls)
  const direct = request.questions.length === 1 && !request.questions[0].multiSelect
  const picks = request.questions.map(() => ({ indexes: new Set(), other: '' }))
  const submit = node('button', 'machine-send', '送る'); submit.type = 'button'
  const body = () => ({ answers: picks.map(pick => ({ indexes: [...pick.indexes], other: pick.other.trim() || null })) })
  const ready = () => picks.every(pick => pick.indexes.size || pick.other.trim())
  const refresh = () => { submit.disabled = !ready() }
  request.questions.forEach((question, qi) => {
    const block = node('div', 'machine-question'), options = node('div', 'owner-question-options machine-options')
    if (question.header) block.append(node('span', 'machine-question-header', question.header))
    block.append(node('p', '', question.question))
    const buttons = []
    const input = node('input'); input.placeholder = 'その他（文章で答える）'; input.maxLength = 4000; input.setAttribute('aria-label', 'その他の答え')
    for (const option of question.options) {
      const button = node('button', 'machine-option'); button.type = 'button'; button.setAttribute('aria-pressed', 'false')
      button.append(node('span', 'machine-option-label', option.label))
      if (option.description) button.append(node('small', 'machine-option-description', option.description))
      button.addEventListener('click', () => {
        const pick = picks[qi]
        if (direct) { void send({ answers: [{ indexes: [option.index], other: null }] }); return }
        if (pick.indexes.has(option.index)) pick.indexes.delete(option.index)
        else { if (!question.multiSelect) { pick.indexes.clear(); pick.other = ''; input.value = '' } pick.indexes.add(option.index) }
        buttons.forEach(([index, el]) => el.setAttribute('aria-pressed', String(pick.indexes.has(index))))
        refresh()
      })
      buttons.push([option.index, button]); controls.push(button); options.append(button)
    }
    input.addEventListener('input', () => {
      const pick = picks[qi]
      pick.other = input.value
      if (!question.multiSelect && input.value.trim()) { pick.indexes.clear(); buttons.forEach(([, el]) => el.setAttribute('aria-pressed', 'false')) }
      refresh()
    })
    const other = node('form', 'owner-question-other')
    other.addEventListener('submit', event => { event.preventDefault(); if (direct && input.value.trim()) void send({ answers: [{ indexes: [], other: input.value.trim() }] }) })
    controls.push(input); other.append(input)
    if (direct) { const go = node('button', '', '送る'); go.type = 'submit'; controls.push(go); other.append(go) }
    block.append(options, other); card.append(block)
  })
  if (!direct) {
    submit.addEventListener('click', () => { if (ready()) void send(body()) })
    controls.push(submit); card.append(submit); refresh()
  }
  return card
}

function approvalCard(event, context) {
  const request = event.request, pending = request.status === 'pending'
  const card = node('section', `owner-question machine-card${pending ? '' : ' is-done'}`)
  card.append(heading(`${context.sender}の許可待ち`, pending))
  card.append(node('p', '', `${event.tool?.name ?? event.title}${event.tool?.summary ? `: ${event.tool.summary}` : ''}`))
  if (!pending) {
    card.append(node('p', 'owner-question-answer card-done', request.status === 'answered'
      ? (request.decision === 'allow' ? '許可しました' : '断りました') : closedMessage))
    return card
  }
  const options = node('div', 'owner-question-options'), controls = []
  const send = sender(request, context, card, () => controls)
  for (const [decision, label] of [['allow', '許可する'], ['deny', '断る']]) {
    const button = node('button', 'machine-option', label); button.type = 'button'
    button.addEventListener('click', () => { void send({ decision }) })
    controls.push(button); options.append(button)
  }
  card.insertBefore(options, card.querySelector('.owner-question-error'))
  return card
}

// Folded kinds are never removed (Owner 2026-11-20: 「畳むのはオッケー。消すのはダメ」): display is 'fold' or anything else = shown.
const groupNames = { hook: 'hooks', tool_result: 'tool results', system: 'system', rate_limit: 'rate limits', result: 'results', control: 'control', words: 'input', thinking: 'thinking', unknown: 'unknown' }

// One collapsed line that opens to the cut text; a cut row offers the whole stored line.
function foldLine(item, event, context) {
  const line = node('details', `machine-line machine-fold view-${event.view}`)
  line.open = context.open === true
  line.addEventListener('toggle', () => context.onOpen?.(line.open))
  line.append(node('summary', '', item.message))
  const body = node('pre', '', event.text || event.tool?.summary || '')
  line.append(body)
  if (event.truncated) {
    const more = node('button', 'machine-more', '全文を読む'); more.type = 'button'
    const note = node('p', 'owner-question-error'); note.hidden = true
    more.addEventListener('click', async () => {
      more.disabled = true; note.hidden = true
      try { body.textContent = await context.readRaw(event.seq); more.hidden = true } catch { note.textContent = '全文を読めませんでした。もう一度押してください。'; note.hidden = false; more.disabled = false }
    })
    line.append(more, note)
  }
  return line
}

// context: { api, sender (the Bot's name), onChanged(request), open, onOpen(open), readRaw(seq) }
export function renderMachineEvent(item, context) {
  const event = item.machine_event
  let element
  if (event.view === 'question' && event.request?.questions) element = questionCard(event, context)
  else if (event.view === 'approval' && event.request) element = approvalCard(event, context)
  else if (event.display === 'fold') element = foldLine(item, event, context)
  else if (event.view === 'thinking') element = node('p', 'machine-thinking', event.text)
  else if (event.view === 'tool_use') {
    element = node('div', 'machine-use')
    element.append(node('strong', '', event.tool?.name ?? event.title), node('code', '', event.tool?.summary ?? ''))
  } else {
    element = node('div', `machine-show view-${event.view}`)
    if (event.title && event.title !== 'input') element.append(node('strong', '', event.title))
    element.append(node('p', '', event.text || item.message))
  }
  // arrangeMachineRows reads these.
  element.dataset.machineView = event.view
  if (event.tool?.id) element.dataset.toolId = event.tool.id
  if (event.display === 'fold') element.dataset.fold = event.fold_group ?? event.view
  return element
}

// Lays the machine rows of one timeline container out as the fold view (machine-stream.md):
// a tool_result's line sits directly under its tool_use line, and consecutive folded rows of one fold_group share one line.
// Idempotent: groups are taken apart and rebuilt, so rows added or replaced later land correctly. `openKeys` keeps what the Owner opened.
export function arrangeMachineRows(container, openKeys) {
  const rows = () => [...container.children]
  for (const group of rows().filter(child => child.dataset?.machineGroup)) {
    for (const member of [...group.children].filter(child => child.dataset?.machineView !== undefined)) container.insertBefore(member, group)
    group.remove()
  }
  for (const result of rows().filter(child => child.dataset?.machineView === 'tool_result' && child.dataset.toolId)) {
    const list = rows(), use = list.find(child => child.dataset?.machineView === 'tool_use' && child.dataset.toolId === result.dataset.toolId)
    delete result.dataset.attached
    if (!use) continue
    result.dataset.attached = '1'
    const next = list[list.indexOf(use) + 1]
    if (next !== result) container.insertBefore(result, next ?? null)
  }
  let run = []
  const flush = () => {
    if (run.length > 1) {
      const key = `group:${run[0].dataset.id}`, name = run[0].dataset.fold
      const group = node('details', 'machine-line machine-group')
      group.dataset.machineGroup = key
      group.append(node('summary', '', `${groupNames[name] ?? name} ×${run.length}`))
      container.insertBefore(group, run[0])
      const members = run
      group.open = openKeys.has(key)
      group.addEventListener('toggle', () => { if (group.open) { openKeys.add(key); members.forEach(member => { member.open = true }) } else openKeys.delete(key) })
      for (const member of run) group.append(member)
      if (group.open) run.forEach(member => { member.open = true })
    }
    run = []
  }
  for (const child of rows()) {
    const name = child.dataset?.fold
    if (!name || child.dataset.attached) { flush(); continue }
    if (run.length && run[0].dataset.fold !== name) flush()
    run.push(child)
  }
  flush()
}
