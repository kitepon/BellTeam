import { escapeHtml } from './view-format.js?v=__ASSET_VERSION__'

const unknown = { state:'unknown', summary:null, summaryStatus:'missing', summaryUpdatedAt:null, observedAt:null, source:null }
const keys = Object.keys(unknown)
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/u.test(value) && Number.isFinite(Date.parse(value))
export function currentWork(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value,key))) return unknown
  const {state,summary,summaryStatus,summaryUpdatedAt,observedAt,source} = value
  if (state === 'unknown' ? observedAt !== null && !timestamp(observedAt) : !timestamp(observedAt)) return unknown
  if (state === 'working' && summaryStatus === 'current') {
    return typeof summary === 'string' && summary.length > 0 && [...summary].length <= 160 && summary === summary.trim()
      && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(summary) && timestamp(summaryUpdatedAt) && source === 'self_reported' ? value : unknown
  }
  if (state === 'working' && summaryStatus === 'stale') return summary === null && timestamp(summaryUpdatedAt) && source === 'self_reported' ? value : unknown
  return ['working','idle','unknown'].includes(state) && summaryStatus === 'missing' && summary === null && summaryUpdatedAt === null && source === null ? value : unknown
}
export function workLabel(value) {
  const work = currentWork(value)
  return work.state === 'working' ? work.summary ?? (work.summaryStatus === 'stale' ? '作業中・要約期限切れ' : '作業中・要約未設定')
    : work.state === 'idle' ? '待機中' : '仕事状況を未取得'
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
export function roomWorkPreview(room, bots) {
  const members = participantWork(room,bots), available = members.filter(member => member.work.summaryStatus === 'current')
  const shown = available.slice(0,2)
  return `<span class="work-scope">参加者の現在の仕事</span>${shown.length
    ? shown.map(member => `<span class="work-preview-line">${escapeHtml(member.name)}: ${escapeHtml(member.work.summary)}</span>`).join('') + (members.length > shown.length ? `<span class="work-more">ほか${members.length-shown.length}人</span>` : '')
    : '<span class="work-preview-line">参加者の仕事要約を未取得</span>'}`
}
const time = value => value ? new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(value))+' JST' : '未取得'
export function renderCurrentWork(root, type, target, bots) {
  root.hidden = !target
  if (!target) return
  const summary = root.querySelector('summary'), body = root.querySelector('[data-work-body]')
  summary.textContent = type === 'room' ? '参加者の現在の仕事' : `現在の仕事 · ${workLabel(target.currentWork)}`
  const members = type === 'room' ? participantWork(target,bots) : [{name:target.name ?? target.displayName,work:currentWork(target.currentWork)}]
  body.innerHTML = `<p class="field-help">${type === 'room' ? '参加者それぞれの仕事です。このルームで行っている仕事への帰属は示しません。' : '仕事内容は本人が記載した要約です。作業の成功や完了を示す情報ではありません。'}</p>` + members.map(({name,work}) => `<section><h3>${escapeHtml(name)}</h3><p>${escapeHtml(workLabel(work))}</p><dl><dt>最終観測</dt><dd>${escapeHtml(time(work.observedAt))}</dd><dt>要約の更新</dt><dd>${escapeHtml(time(work.summaryUpdatedAt))}</dd></dl></section>`).join('')
  if (!members.length) body.insertAdjacentHTML('beforeend','<p>参加者の仕事要約を未取得</p>')
}
