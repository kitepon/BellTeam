// Home roster rows and the chat header state (user-paths.md 2.2, 3.1 W21): pure, so the rules are tested without a DOM.
import { currentWork } from './current-work.js?v=__ASSET_VERSION__'
import { matchesMemberQuery, matchesRosterQuery } from './roster-search.js?v=__ASSET_VERSION__'

const DAY = 86_400_000
const dayKey = time => new Date(time).toDateString()

// 「12:10」 today, 「昨日」, 「11/9」 older; nothing without a valid time.
export function rowTime(value, now = Date.now()) {
  const at = Date.parse(value ?? '')
  if (!Number.isFinite(at)) return ''
  if (dayKey(at) === dayKey(now)) return new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' }).format(at)
  if (dayKey(at) === dayKey(now - DAY)) return '昨日'
  return new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric' }).format(at)
}

// One state badge: 要対応 (with its reason) beats 作業中; idle shows nothing.
export function memberState(bot) {
  const attention = bot.deleting || bot.deletionRequested ? '削除の結果待ち' : bot.seatLaunch && typeof bot.seatLaunch === 'object' ? '端末で起動できません' : ''
  if (attention) return { text: '要対応', tone: 'attention', reason: attention }
  return currentWork(bot.currentWork).state === 'working' ? { text: '作業中', tone: 'working', reason: '' } : null
}

export function memberRow(bot) {
  const work = currentWork(bot.currentWork), state = memberState(bot)
  return { name: bot.name ?? bot.displayName ?? '', line: state?.reason || (work.summaryStatus === 'current' ? work.summary : bot.position || ''), state }
}

export function roomRow(room, bots, query = '') {
  const members = room.memberIds.flatMap(id => bots.filter(bot => bot.id === id))
  const words = query.trim()
  const byMember = words && !matchesRosterQuery(words, room.name) ? members.filter(bot => matchesMemberQuery(bot, words)) : []
  const recent = room.recent
  const text = typeof recent?.message === 'string' && recent.message.trim() ? recent.message.trim().replace(/\s+/gu, ' ')
    : recent && (recent.image || recent.images?.length) ? '画像' : ''
  const sender = recent?.sender?.id === 'user' ? 'あなた' : recent?.sender?.name
  const line = byMember.length ? `参加者: ${byMember.map(bot => bot.name).join('、')}`
    : text ? (sender ? `${sender}: ${text}` : text) : room.purpose ?? ''
  return { name: room.name, line, working: members.filter(bot => currentWork(bot.currentWork).state === 'working') }
}
