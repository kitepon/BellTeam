import { normalizeMembersError } from './members/errors.mjs'
import { join } from 'node:path'
import { createMembersProcess } from './members-process.mjs'
import { createMembersFacade } from './members-facade.mjs'
import { createMembersProjection } from './members-projection.mjs'
import { createMembersRuntimeEffects, MEMBERS_RUNTIME_EFFECT_METHODS } from './members-runtime-effects.mjs'
import { validateMembersEffect, validateMembersEffectResult } from './members/protocol.mjs'

export function createMembersAssembly({ root, seatRuntime, aiterm, settings, models, membersAdmission,
  membersAuthorization, diagnostics, dependencies, exchangeMutex, onModuleChildExit, onModuleRestartLimit, onState = () => {}, createProcess = createMembersProcess }) {
  const listeners = new Set()
  const notify = () => { for (const listener of listeners) listener({ all: true, topics: ['bots', 'owner', 'schedules'], botIds: [], roomIds: [] }) }
  const projection = createMembersProjection({ onChange: notify })
  let facade
  const onEffect = async (method, params, context) => {
    if (context.membersReadPin) {
      membersAdmission.assertReadPin(context.membersReadPin, { method: 'schedules.list', generation: context.generation })
      if (method !== 'room.schedules.list') throw Object.assign(new Error('MEMBERS_EFFECT_UNSUPPORTED'), { code: 'MEMBERS_EFFECT_UNSUPPORTED', status: 503 })
      const { generation, leaseId, rootId, ownerWrite, continuation } = context
      validateMembersEffect(method, params, { generation, leaseId, rootId, ownerWrite, continuation })
      const value = await dependencies().rooms.listSchedules(params.roomId, context.operationContext)
      validateMembersEffectResult(method, value)
      return value
    }
    membersAdmission.assertLease(context.membersLease, { generation: context.generation })
    const { generation, leaseId, rootId, ownerWrite, continuation } = context
    validateMembersEffect(method, params, { generation, leaseId, rootId, ownerWrite, continuation })
    let value
    if (MEMBERS_RUNTIME_EFFECT_METHODS.includes(method)) value = await createMembersRuntimeEffects({ seatRuntime, aiterm,
      readCurrentBotIds: captured => facade.readCurrentBotIds(captured), callBridge: () => settings.configuration('callBridge') })(method, params, context)
    else {
      const { rooms, assets } = dependencies()
      switch (method) {
        case 'schedules.currentTurn': value = dependencies().scheduleTurns.currentTurn(params.botId); break
        case 'models.read': value = await models.forHarness(params.harness); break
        // S5 (remote-seat.md): no terminals core, or a core without folder, answers null = not checked.
        case 'terminals.read': { const terminal = await dependencies().terminals?.registry.get(params.terminalId); value = terminal ? { user: terminal.user } : null; break }
        case 'terminals.folder': {
          const core = dependencies().terminals
          if (typeof core?.folder !== 'function') { value = null; break }
          try { value = await core.folder(params) } catch (error) {
            if (error?.code === 'INVALID_PATH') throw Object.assign(new Error('BOT_PROJECT_ROOT_INVALID'), { code: 'BOT_PROJECT_ROOT_INVALID', status: 400 })
            throw error
          }
          break
        }
        case 'assets.prepareBotAssetRemoval': value = await assets.prepareBotAssetRemoval(params.botId, context.operationContext); break
        case 'assets.cancelBotAssetRemoval': value = assets.cancelBotAssetRemoval(params.botId, params.lease, params.state, context.operationContext); break
        case 'room.schedules.list': value = await rooms.listSchedules(params.roomId, context.operationContext); break
        case 'room.schedules.set': value = await rooms.setSchedule(params.roomId, params.input, context.operationContext); break
        case 'room.schedules.remove': value = await rooms.removeSchedule(params.roomId, params.scheduleId, context.operationContext); break
        case 'room.schedules.claimDue': case 'room.schedules.skipDue': {
          const { roomId, ...input } = params
          value = await rooms[method.endsWith('claimDue') ? 'claimDue' : 'skipDue']({ roomId, ...input }, context.operationContext); break
        }
        default: throw Object.assign(new Error('MEMBERS_EFFECT_UNSUPPORTED'), { code: 'MEMBERS_EFFECT_UNSUPPORTED', status: 503 })
      }
    }
    validateMembersEffectResult(method, value)
    return value
  }
  const controller = createProcess({ root, membersAdmission, exchangeMutex, onModuleChildExit, onModuleRestartLimit, onEffect: async (...args) => {
    try {
      const conversation = dependencies().conversationAssembly
      const [method, params, context] = args
      return conversation && (method.startsWith('assets.') || method.startsWith('room.'))
        ? await conversation.memberEffect(context, operationContext => onEffect(method, params, { ...context, operationContext })) : await onEffect(...args)
    } catch (error) { throw normalizeMembersError(error) }
  },
    onGeneration: generation => projection.begin(generation), onProjection: (record, context) => projection.accept(record, context),
    onDiagnostic: report => diagnostics.record(report),
    onState: state => { if (!state.available) { projection.unavailable(); notify() }; onState(state) },
    authorizeOwner: (method, authorization) => membersAuthorization.authorizeOwner(method, authorization),
  })
  facade = createMembersFacade({ request: (method, params, options) => dependencies().conversationAssembly?.memberRequest(method, params, options, (...args) => controller.request(...args)) ?? controller.request(method, params, options), callback: (...args) => controller.callback(...args), admission: membersAdmission, projection })
  Object.defineProperty(facade.bots, 'size', { get: () => [...facade.bots.keys()].length })
  facade.bots.projectPath = id => {
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error('BOT_ID_INVALID')
    return join(root, 'bots', id)
  }
  facade.bots.watch = listener => { listeners.add(listener); return () => listeners.delete(listener) }
  return { ...facade, controller, projection }
}
