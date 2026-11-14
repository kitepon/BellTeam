import { json } from '../http-response.mjs'

export const deleteBotTool = {
  name: 'delete_bot',
  description: '自分のAIセッションを終了し、プロジェクトフォルダと登録を削除する。消せるのは自分だけで、botIdは省略するか自分のIDにする。他のBotの削除はオーナーがWebかアプリで行う。返却は受付であり、一覧から消えるまで削除は未完。',
  inputSchema: { type: 'object', properties: { botId: { type: 'string', minLength: 1 } }, required: [], additionalProperties: false },
}

export async function requireRemovalTarget(bots, botId, options = {}) {
  const bot = bots.get(botId)
  if (!bot && !await bots.hasPendingRemoval?.(botId, options))
    throw Object.assign(new Error(`BOT_NOT_FOUND: ${botId}`), { code: 'BOT_NOT_FOUND', status: 404 })
  return bot
}

const SELF_ONLY_MESSAGE = 'Botが消せるのは自分だけ。他のBotの削除はオーナーがWebかアプリで行う。'
const selfOnly = () => Object.assign(new Error(`BOT_DELETE_SELF_ONLY: ${SELF_ONLY_MESSAGE}`), { code: 'BOT_DELETE_SELF_ONLY', status: 403 })

// Audit M3: a Bot deletes only itself; another Bot's deletion is the Owner's, on the public listener.
export async function runDeleteBotTool({ registry, from, arguments: args = {}, remove }) {
  const botId = args.botId ?? from
  if (botId !== from) throw selfOnly()
  await requireRemovalTarget(registry, botId)
  return remove(botId)
}

// resolveSeat is given only on the internal listener, whose callers are Bot seats, never the Owner.
export function createMemberDeletionApi({ administration, resolveSeat = null }) {
  return async (request, response, url) => {
    const match = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)$/u)
    if (request.method !== 'DELETE' || !match) return false
    if (resolveSeat) {
      const seat = await resolveSeat(request)
      if (seat.fork || seat.botId !== match[1]) return json(response, 403, { error: 'BOT_DELETE_SELF_ONLY', message: SELF_ONLY_MESSAGE })
    }
    return json(response, 202, await administration.remove(match[1]))
  }
}

// Pending targets have already retired; never start or close another native session to resume cleanup.
export async function startMemberRemoval(botId, { bots, rooms, transport, writeLog, onRemoved, trackCompletion = () => {}, moduleOperations = null }) {
  const admission = transport.membersAdmission
  const lease = moduleOperations ? null : admission?.enter()
  const options = moduleOperations ? moduleOperations.reserve() : lease ? { membersLease: lease } : {}
  const finish = () => { if (moduleOperations) moduleOperations.finish(options); else if (lease) admission.finish(lease) }
  let bot
  try {
    await bots.refresh?.(options)
    bot = await requireRemovalTarget(bots, botId, options)
  } catch (error) {
    finish()
    throw error
  }
  const reportSync = result => {
    if (result?.configurationSync) writeLog(`BellTeam CLI configuration sync error after delete: ${botId}: ${JSON.stringify(result.configurationSync)}\n`)
  }
  const completion = (async () => {
    if (bot) {
      await transport.stop(bot, undefined, { ...options, allSessions: true })
      await rooms.removeBot(botId, options)
    }
    const result = await bots.remove(botId, options)
    onRemoved(botId)
    reportSync(result)
  })().catch(error => {
    reportSync(error)
    writeLog(`BellTeam delete error: ${botId}: ${error.stack ?? error.message}\n`)
  }).finally(finish)
  trackCompletion(completion)
  return { deleting: botId }
}
