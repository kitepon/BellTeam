import { join } from 'node:path'
import { createMembersProcess } from './members-process.mjs'
import { createMembersFacade } from './members-facade.mjs'
import { createMembersProjection } from './members-projection.mjs'
import { createMembersRuntimeEffects, MEMBERS_RUNTIME_EFFECT_METHODS } from './members-runtime-effects.mjs'
import { validateMembersEffect, validateMembersEffectResult } from './members/protocol.mjs'

export function createMembersAssembly({ root, seatRuntime, aiterm, settings, models, membersAdmission,
  membersAuthorization, diagnostics, dependencies, createProcess = createMembersProcess }) {
  const listeners = new Set()
  const notify = () => { for (const listener of listeners) listener({ all: true, topics: ['bots', 'owner', 'schedules'], botIds: [], roomIds: [] }) }
  const projection = createMembersProjection({ onChange: notify })
  let facade
  const onEffect = async (method, params, context) => {
    membersAdmission.assertLease(context.membersLease, { generation: context.generation })
    const { generation, leaseId, rootId, ownerWrite, continuation } = context
    validateMembersEffect(method, params, { generation, leaseId, rootId, ownerWrite, continuation })
    let value
    if (MEMBERS_RUNTIME_EFFECT_METHODS.includes(method)) value = await createMembersRuntimeEffects({ seatRuntime, aiterm,
      readCurrentBotIds: captured => facade.readCurrentBotIds(captured), callBridge: settings.configuration('callBridge') })(method, params, context)
    else {
      const { memory, rooms, assets } = dependencies()
      switch (method) {
        case 'models.read': value = await models.forHarness(params.harness); break
        case 'memory.ensureScope': await memory.ensureScope(params.botId, 'personal'); value = null; break
        case 'assets.prepareBotAssetRemoval': value = await assets.prepareBotAssetRemoval(params.botId); break
        case 'assets.cancelBotAssetRemoval': value = assets.cancelBotAssetRemoval(params.botId, params.lease, params.state); break
        case 'room.schedules.list': value = await rooms.listSchedules(params.roomId); break
        case 'room.schedules.set': value = await rooms.setSchedule(params.roomId, params.input); break
        case 'room.schedules.remove': value = await rooms.removeSchedule(params.roomId, params.scheduleId); break
        case 'room.schedules.claimDue': case 'room.schedules.skipDue': {
          const { roomId, ...input } = params
          value = await rooms[method.endsWith('claimDue') ? 'claimDue' : 'skipDue']({ roomId, ...input }); break
        }
        default: throw Object.assign(new Error('MEMBERS_EFFECT_UNSUPPORTED'), { code: 'MEMBERS_EFFECT_UNSUPPORTED', status: 503 })
      }
    }
    validateMembersEffectResult(method, value)
    return value
  }
  const controller = createProcess({ root, membersAdmission, onEffect,
    onGeneration: generation => projection.begin(generation), onProjection: (record, context) => projection.accept(record, context),
    onDiagnostic: report => diagnostics.record(report),
    onState: state => { if (!state.available) { projection.unavailable(); notify() } },
    authorizeOwner: (method, authorization) => membersAuthorization.authorizeOwner(method, authorization),
  })
  facade = createMembersFacade({ request: (...args) => controller.request(...args), callback: (...args) => controller.callback(...args), admission: membersAdmission, projection })
  Object.defineProperty(facade.bots, 'size', { get: () => [...projection.keys()].length })
  facade.bots.projectPath = id => {
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error('BOT_ID_INVALID')
    return join(root, 'bots', id)
  }
  facade.bots.watch = listener => { listeners.add(listener); return () => listeners.delete(listener) }
  return { ...facade, controller, projection }
}
