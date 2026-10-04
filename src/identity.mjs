import { resolve } from 'node:path'

export function resolveBotId({ explicitId, cwd, bots }) {
  if (explicitId) return explicitId
  const project = resolve(cwd)
  for (const bot of bots.values()) {
    if (resolve(bot.project) === project) return bot.id
  }
  throw new Error(`BELLTEAM_BOT_ID_UNRESOLVED: ${project}`)
}
