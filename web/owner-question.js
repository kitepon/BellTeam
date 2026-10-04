// Botがオーナーへ選択を求めるカード。押した答えは通常のオーナーからのメッセージとしてBotへ届く。
export function renderOwnerQuestion(question, { api, sender, onAnswered }) {
  const card = document.createElement('section')
  card.className = 'owner-question'
  const heading = document.createElement('strong')
  heading.textContent = `${sender} · 選んでほしいこと`
  const message = document.createElement('p')
  message.textContent = question.question
  card.append(heading, message)
  if (question.status === 'answered') {
    const answer = document.createElement('p')
    answer.className = 'owner-question-answer'
    answer.textContent = `回答: ${question.answer}`
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
      error.textContent = `送れませんでした（${failure.message}）`
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
