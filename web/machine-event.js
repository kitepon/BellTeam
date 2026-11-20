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

// context: { api, sender (the Bot's name), onChanged(request) }
export function renderMachineEvent(item, context) {
  const event = item.machine_event
  if (event.display === 'hide') { const gone = node('div'); gone.hidden = true; return gone }
  if (event.view === 'question' && event.request?.questions) return questionCard(event, context)
  if (event.view === 'approval' && event.request) return approvalCard(event, context)
  if (event.view === 'thinking') return node('p', 'machine-thinking', event.text)
  // Everything else is one line; the details open to the cut text (the full line is GET /api/bots/:id/machine-events/:seq).
  const line = node('details', `machine-line view-${event.view}`)
  line.append(node('summary', '', item.message))
  if (event.text || event.tool?.summary) line.append(node('pre', '', event.text || event.tool.summary))
  if (event.display === 'show') line.open = true
  return line
}
