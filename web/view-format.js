export function applyAvatar(element, bot) {
  element.style.backgroundImage = bot.avatar ? `url(${JSON.stringify(bot.avatar)})` : ''
  element.classList.toggle('has-image', Boolean(bot.avatar))
}

export function dayLabel() {
  const label = document.createElement('div')
  label.className = 'day-label'
  label.textContent = 'BellTeamでの会話'
  return label
}

export function initials(name) {
  return escapeHtml(name.slice(0, 1).toUpperCase())
}
export function memberDisplay(member) {
  if (!member) return ''
  return member.position ? `${member.name} ${member.position}` : member.name
}
export function formatTime(value) {
  if (!value) return ''
  return new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}
export function formatDateTime(value) {
  if (!value) return ''
  return new Intl.DateTimeFormat('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

export function escapeClass(value) { return ['rose', 'indigo', 'violet'].includes(value) ? value : 'violet' }
export function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character])
}
