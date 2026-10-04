export function memberIdentity(bots, id) {
  if (id === 'user') return { id: 'user', name: 'ユーザー', position: '', role: 'オーナー' }
  if (id === 'scheduler') return { id: 'scheduler', name: '自動実行', position: '', role: 'BellTeam' }
  const bot = bots.get(id)
  if (!bot) throw new Error(`BOT_NOT_FOUND: ${id}`)
  return { id: bot.id, name: bot.name, position: bot.position ?? '', role: bot.role ?? '' }
}

export function memberLabel(member) {
  return member.position ? `${member.name} ${member.position}` : member.name
}
