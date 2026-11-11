// Botがオーナーへ選択を求めるカード。押した答えは通常のオーナーからのメッセージとしてBotへ届く。
export function renderOwnerQuestion(question, { api, sender, onAnswered }) {
  const card = document.createElement('section')
  const answered = question.status === 'answered'
  // W29: pending = question icon + amber 要対応; answered = muted card with a green check.
  card.className = `owner-question${answered ? ' is-done' : ''}`
  const heading = document.createElement('div')
  heading.className = 'card-heading'
  const icon = Object.assign(document.createElement('span'), { className: 'card-icon', textContent: '?' })
  icon.setAttribute('aria-hidden', 'true')
  heading.append(icon, Object.assign(document.createElement('strong'), { textContent: `${sender}からの質問` }))
  if (!answered) heading.append(Object.assign(document.createElement('span'), { className: 'state-badge is-attention', textContent: '要対応' }))
  const message = document.createElement('p')
  message.textContent = question.question
  card.append(heading, message)
  if (answered) {
    const answer = document.createElement('p')
    answer.className = 'owner-question-answer card-done'
    answer.textContent = `「${question.answer}」と答えました`
    card.append(answer)
    return card
  }
  const error = document.createElement('p')
  error.className = 'owner-question-error'
  error.setAttribute('role', 'alert')
  error.hidden = true
  const options = document.createElement('div')
  options.className = 'owner-question-options'
  const controls = []
  let sending = false
  async function send(body) {
    if (sending) return
    sending = true
    controls.forEach(control => { control.disabled = true })
    error.hidden = true
    try {
      const result = await api(`/api/owner-questions/${encodeURIComponent(question.id)}/answer`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      onAnswered(result.question)
    } catch (failure) {
      error.textContent = '答えを送れませんでした。もう一度選んでください。'
      error.hidden = false
      sending = false
      controls.forEach(control => { control.disabled = false })
    }
  }
  for (const option of question.options) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = option
    button.addEventListener('click', () => send({ choice: option }))
    controls.push(button)
    options.append(button)
  }
  card.append(options)
  if (question.allowOther) {
    const form = document.createElement('form')
    form.className = 'owner-question-other'
    const input = document.createElement('input')
    input.placeholder = 'その他（文章で答える）'
    input.setAttribute('aria-label', 'その他の答え')
    input.maxLength = 4000
    const submit = document.createElement('button')
    submit.type = 'submit'
    submit.textContent = '送る'
    form.addEventListener('submit', event => {
      event.preventDefault()
      if (input.value.trim()) send({ text: input.value })
    })
    controls.push(input, submit)
    form.append(input, submit)
    card.append(form)
  }
  card.append(error)
  return card
}
