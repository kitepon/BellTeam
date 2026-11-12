import { createWebApp } from './application.js?v=__ASSET_VERSION__'

// W1: a failed boot shows one card with 「もう一度つなぐ」, which runs boot again (no page reload needed).
const app = createWebApp()
function start() {
  document.querySelector('#boot-error')?.remove()
  app.start().catch(() => {
    const card = document.createElement('section')
    card.id = 'boot-error'
    card.className = 'boot-error'
    card.setAttribute('role', 'alert')
    const text = document.createElement('p')
    text.textContent = 'BellTeamにつながりませんでした。通信を確かめて、もう一度つないでください。'
    const again = document.createElement('button')
    again.type = 'button'
    again.className = 'primary-button'
    again.textContent = 'もう一度つなぐ'
    again.addEventListener('click', () => { again.disabled = true; again.textContent = 'つないでいます…'; start() })
    card.append(text, again)
    document.body.append(card)
  })
}
start()
