import { readFile } from 'node:fs/promises'

export async function loadBots(path) {
  const parsed = JSON.parse(await readFile(path, 'utf8'))
  if (parsed?.schema !== 'bellteam.bots.v1' || !Array.isArray(parsed.bots))
    throw new Error('BOT_CONFIG_INVALID')

  const bots = new Map()
  for (const bot of parsed.bots) {
    if (!bot || typeof bot.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(bot.id))
      throw new Error('BOT_ID_INVALID')
    if (!['claude', 'codex', 'grok', 'cursor'].includes(bot.harness))
      throw new Error(`BOT_HARNESS_INVALID: ${bot.id}`)
    if (typeof bot.session !== 'string' || typeof bot.project !== 'string')
      throw new Error(`BOT_DEFINITION_INVALID: ${bot.id}`)
    if (bots.has(bot.id)) throw new Error(`BOT_DUPLICATE: ${bot.id}`)
    bots.set(bot.id, Object.freeze({ ...bot }))
  }
  return bots
}
