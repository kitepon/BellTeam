const normalize = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase()

export function matchesRosterQuery(query, ...fields) {
  const haystack = normalize(fields.join(' '))
  return normalize(query).trim().split(/\s+/u).every(word => haystack.includes(word))
}

export function matchesMemberQuery(bot, query) {
  return matchesRosterQuery(query, bot.name, bot.displayName, bot.position)
}

export function matchesRoomQuery(room, bots, query) {
  return matchesRosterQuery(query, room.name, ...bots.filter(bot => room.memberIds.includes(bot.id))
    .flatMap(bot => [bot.name, bot.displayName, bot.position]))
}
