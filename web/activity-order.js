export function newestByRecent(items) {
  return items.map((item, index) => ({ item, index, time: recentTime(item) }))
    .sort((left, right) => right.time - left.time || left.index - right.index)
    .map(entry => entry.item)
}

export function hasUnreadConversation(item, type, lastReadId) {
  const recent = item?.recent
  if (!recent?.id || recent.id === lastReadId) return false
  // Bot同士のやりとり（peer）は未読にしない。未読はBotからユーザーへの返答だけ。
  if (type === 'bot') return recent.kind === 'message' && recent.direction === 'incoming'
  if (type === 'room') return recent.sender?.id !== 'user'
  return false
}

function recentTime(item) {
  if (!item?.recent?.at) return Number.NEGATIVE_INFINITY
  const value = Date.parse(item.recent.at)
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY
}
