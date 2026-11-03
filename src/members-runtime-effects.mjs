import { validateMembersEffect } from './members/protocol.mjs'

export const MEMBERS_RUNTIME_EFFECT_METHODS = Object.freeze([
  'project.ensureRoot', 'project.claim', 'project.initialize', 'project.remove', 'project.readPreviousSession',
  'project.writeInstructions', 'project.prepareStartupContext', 'project.appendInstructions', 'global.writeInstructions', 'cli.configure',
])

export function createMembersRuntimeEffects({ seatRuntime, readCurrentBotIds, aiterm, callBridge }) {
  return async (method, params, context) => {
    const { generation, leaseId, rootId, ownerWrite, continuation } = context ?? {}
    validateMembersEffect(method, params, { generation, leaseId, rootId, ownerWrite, continuation })
    if (!MEMBERS_RUNTIME_EFFECT_METHODS.includes(method))
      throw Object.assign(new Error('MEMBERS_EFFECT_UNSUPPORTED'), { code: 'MEMBERS_EFFECT_UNSUPPORTED', outcome: 'not_accepted' })
    if (method === 'cli.configure') {
      if (typeof readCurrentBotIds !== 'function')
        throw Object.assign(new Error('MEMBERS_EFFECT_UNAVAILABLE'), { code: 'MEMBERS_EFFECT_UNAVAILABLE' })
      await seatRuntime.configureMembersHarnesses(() => readCurrentBotIds(context), aiterm, callBridge)
      return null
    }
    return seatRuntime.membersProject(method, params)
  }
}
