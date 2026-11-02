import { createWebApp } from './application.js?v=__ASSET_VERSION__'

createWebApp().start().catch(cause => {
  const error = document.createElement('p')
  error.className = 'form-error'
  error.textContent = `BellTeamに接続できません: ${cause.message}`
  document.querySelector('#app').prepend(error)
})
