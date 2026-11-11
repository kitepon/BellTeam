import { escapeHtml } from './view-format.js?v=__ASSET_VERSION__'

const unknown = { state:'unknown', summary:null, summaryStatus:'missing', summaryUpdatedAt:null, observedAt:null, source:null }
const keys = Object.keys(unknown)
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/u.test(value) && Number.isFinite(Date.parse(value))
export function currentWork(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value,key))) return unknown
  const {state,summary,summaryStatus,summaryUpdatedAt,observedAt,source} = value
  if (state === 'unknown' ? observedAt !== null && !timestamp(observedAt) : !timestamp(observedAt)) return unknown
  const summarized = source === 'background_agent' && ['working','idle','unknown'].includes(state) || source === 'self_reported' && state === 'working'
  if (summarized && summaryStatus === 'current') {
    return typeof summary === 'string' && summary.length > 0 && summary === summary.trim()
      && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(summary) && timestamp(summaryUpdatedAt) ? value : unknown
  }
  if (summarized && summaryStatus === 'stale') return summary === null && timestamp(summaryUpdatedAt) ? value : unknown
  return ['working','idle','unknown'].includes(state) && summaryStatus === 'missing' && summary === null && summaryUpdatedAt === null && source === null ? value : unknown
}
export function participantWork(room, bots) {
  const input = room.currentWork?.scope === 'participants' && Array.isArray(room.currentWork.members) ? room.currentWork.members : []
  return room.memberIds.flatMap(id => {
    const bot = bots.find(item => item.id === id)
    if (!bot) return []
    const matches = input.filter(item => item?.botId === id)
    return [{ name:bot.name ?? bot.displayName, work:currentWork(matches.length === 1 ? matches[0].currentWork : null) }]
  })
}
// 「たった今」「5分前」「2時間前」「3日前」.
export function ago(value, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60_000))
  return minutes < 1 ? 'たった今' : minutes < 60 ? `${minutes}分前` : minutes < 1440 ? `${Math.floor(minutes / 60)}時間前` : `${Math.floor(minutes / 1440)}日前`
}
// Chat header line (user-paths.md 3.1 W22): only a current summary is shown; absent, stale or unknown shows nothing (P4).
export function renderCurrentWork(root, type, target, bots) {
  const members = !target ? [] : type === 'room' ? participantWork(target, bots) : [{ name: target.name ?? target.displayName, work: currentWork(target.currentWork) }]
  const shown = members.filter(member => member.work.summaryStatus === 'current')
  root.hidden = !shown.length
  if (!shown.length) { root.open = false; return }
  const [first] = shown
  root.querySelector('summary').textContent = type === 'room'
    ? `いまの仕事: ${first.name}${shown.length > 1 ? ` ほか${shown.length - 1}人` : ''}`
    : `いまの仕事: ${first.work.summary}（${ago(first.work.summaryUpdatedAt)}）`
  root.querySelector('[data-work-body]').innerHTML = shown.map(({ name, work }) =>
    `<section>${type === 'room' ? `<h3>${escapeHtml(name)}</h3>` : ''}<p>${escapeHtml(work.summary)}</p><p class="current-work-time">最終更新 ${ago(work.summaryUpdatedAt)}</p></section>`).join('')
}
