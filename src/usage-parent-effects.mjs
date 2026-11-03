import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import guide from '../config/setup-guide.json' with { type: 'json' }
import { HARNESS, GUIDE_BOT_ID } from './onboarding.mjs'
import { runtimeEnvironment } from './runtime-home.mjs'
import { usageError } from './usage/process-schema.mjs'
import { usageEffectResultValid } from './usage/channel-protocol.mjs'

const metadata = ({ id, name, harness }) => ({ id, name, harness: harness ?? null })
const complete = async attempt => {
  try { const value = await attempt; await attempt?.completion; return value }
  catch (error) { await Promise.allSettled([attempt?.completion]); throw error }
}
const unavailable = () => { throw usageError('USAGE_EFFECT_UNAVAILABLE') }

// The caller owns validated channel context, actor authority and callback lifetime.
export function createUsageParentEffects({ getServices, getFeatures, seatRuntime }) {
  const readMember = async (bots, id, context) => {
    if (bots.readMember) return complete(bots.readMember(id, context))
    await complete(bots.refresh(context))
    const bot = bots.get(id)
    if (!bot) throw usageError('BOT_NOT_FOUND', 404)
    return bot
  }
  return async (method, params, context) => {
    const services = getServices()
    if (!services) unavailable()
    const { bots, rooms, transport, notifications, messenger } = services
    let result = null
    switch (method) {
      case 'settings.changed': {
        const features = getFeatures()
        if (typeof features?.onChange !== 'function') unavailable()
        await complete(features.onChange(params.id, params.configuration, { epoch: params.epoch }))
        break
      }
      case 'auth.call': {
        const keys = ['harness', 'action', 'session_id', 'relogin', 'expected_binding', 'expected_prompt_digest', 'response']
        const harness = Object.keys(HARNESS).find(key => HARNESS[key] === params.harness)
        if (!harness || Object.keys(params).some(key => !keys.includes(key))) throw usageError('USAGE_EFFECT_INVALID')
        let bot
        if (context.method.startsWith('onboarding.')) bot = await readMember(bots, GUIDE_BOT_ID, context)
        else {
          await complete(bots.refresh(context))
          bot = [...bots.values()].find(value => value.harness === harness)
          if (bot) bot = await readMember(bots, bot.id, context)
        }
        const cwd = bot ? bots.projectPath?.(bot.id) ?? bot.project : undefined
        if (bot && !cwd) unavailable()
        const client = transport?.client
        if (!client?.call) unavailable()
        const value = await complete(client.call('agent_auth', { ...params, ...(cwd ? { cwd } : {}) }, client.authOptions?.() ?? { env: runtimeEnvironment() }))
        result = { structuredContent: value?.structuredContent, ...(Object.hasOwn(value ?? {}, 'isError') ? { isError: value.isError } : {}) }
        break
      }
      case 'members.read':
        await complete(bots.refresh(context))
        result = [...bots.values()].map(metadata)
        break
      case 'rooms.read':
        await complete(rooms.refresh(context))
        result = [...rooms.values()].map(({ id, memberIds }) => ({ id, memberIds: [...memberIds] }))
        break
      case 'onboarding.ensureGuide': {
        if (!Object.hasOwn(HARNESS, params.harness)) throw usageError('USAGE_EFFECT_INVALID')
        await complete(bots.refresh(context))
        const bot = bots.has(GUIDE_BOT_ID)
          ? await complete(bots.update(GUIDE_BOT_ID, { harness: params.harness }, context))
          : await complete(bots.create({ ...guide, harness: params.harness }, { ...context, id: GUIDE_BOT_ID }))
        result = metadata(bot)
        break
      }
      case 'onboarding.prepareStartup': {
        if (params.botId !== GUIDE_BOT_ID) throw usageError('USAGE_EFFECT_INVALID')
        const bot = await readMember(bots, params.botId, context)
        if (seatRuntime?.membersProject) await complete(seatRuntime.membersProject('project.appendInstructions', { botId: bot.id, text: params.text }))
        else if (seatRuntime?.projectFiles) await complete(seatRuntime.projectFiles.appendInstructions(bot, params.text, context))
        else {
          const project = bots.projectPath?.(bot.id) ?? bot.project
          if (!project) unavailable()
          await appendFile(join(project, 'AGENTS.md'), params.text)
        }
        break
      }
      case 'onboarding.startConversation':
        if (params.botId !== GUIDE_BOT_ID) throw usageError('USAGE_EFFECT_INVALID')
        await complete(messenger.enqueueUserTurn({ target: GUIDE_BOT_ID, message: params.message, recordUser: false }))
        break
      case 'secret.created': await complete(notifications.secret(params.item)); break
      case 'question.created': await complete(notifications.question(params.item)); break
      case 'secret.completed': case 'question.answered':
        await complete(messenger.enqueueUserTurn({ target: params.botId, message: params.message }))
        break
      case 'subscription.setupTest': {
        const bot = await readMember(bots, params.botId, context)
        if (!transport.isIdle(bot.id)) throw usageError('SETUP_BOT_BUSY', 409)
        result = await complete(transport.setupTest(bot))
        break
      }
      default: throw usageError('USAGE_EFFECT_UNSUPPORTED')
    }
    if (!usageEffectResultValid(method, result)) throw usageError('USAGE_EFFECT_RESULT_INVALID', 502)
    return result
  }
}
