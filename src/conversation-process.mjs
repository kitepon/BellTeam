import { createModuleProcess } from './module-process.mjs'
import { prepareModuleRelease } from './module-release.mjs'
import { createConversationParentChannel } from './conversation-ipc.mjs'
import { validateConversationBotSnapshot } from './conversation/requests.mjs'
import { assertConversationStateCompatibility } from './conversation/state-compatibility.mjs'

export function createConversationProcess({ root, admission, readBots, authorizeActor, onEffect, onEvent, onDiagnostic,
  onGeneration, onState, prepareRelease = (versionId, options) => prepareModuleRelease('conversation', versionId, options), spawnProcess } = {}) {
  if (!admission || [readBots, authorizeActor, onEffect].some(value => typeof value !== 'function'))
    throw Object.assign(new Error('CONVERSATION_PORTS_INVALID'), { code: 'CONVERSATION_PORTS_INVALID' })
  const controller = createModuleProcess({ component: 'conversation', root, admission, onGeneration, onState, prepareRelease, spawnProcess,
    createChannel: (child, { generation }) => createConversationParentChannel(child, { generation, admission, authorizeActor, onEffect, onEvent, onDiagnostic }),
    canContinue: (_method, options, generation) => {
      try { admission.assertLease(options.conversationLease, { generation }); return true } catch { return false }
    },
    validateReady: ready => {
      if (ready.protocolVersion !== 1) throw Object.assign(new Error('CONVERSATION_READY_INVALID'), { code: 'CONVERSATION_READY_INVALID' })
      assertConversationStateCompatibility(ready.stateCompatibility)
    },
    initializeParams: async ({ generation, mode }) => {
      const bots = await readBots()
      validateConversationBotSnapshot(bots)
      return { generation, mode, bots: structuredClone(bots) }
    },
  })
  return { ...controller, request(method, params, options) {
    const result = controller.request(method, params, options)
    result.completion ??= result
    if (method === 'user.turn') result.accepted ??= result
    return result
  } }
}
