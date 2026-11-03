import { AsyncLocalStorage } from 'node:async_hooks'
import { join } from 'node:path'
import { createUsageServices } from './services.mjs'
import { createUsageRegistryPorts } from './registry-ports.mjs'
import { usageError, validateUsageRequest } from './process-schema.mjs'
import { USAGE_STATE_COMPATIBILITY } from './state-compatibility.mjs'

const object = value => value && typeof value === 'object' && !Array.isArray(value)
const keys = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key))
const environmentKeys = ['TYPESAFE_API_KEY', 'BELLTEAM_CALL_BRIDGE_MCP_URL', 'BELLTEAM_CF_TEAM_DOMAIN', 'BELLTEAM_CF_AUD', 'BELLTEAM_BUGHUB_KEY']
const bootstrapValid = value => keys(value, ['environment', 'seatRuntime', 'subscription']) && keys(value.environment, [], environmentKeys)
  && Object.values(value.environment).every(value => typeof value === 'string') && typeof value.seatRuntime === 'boolean'
  && keys(value.subscription, [], ['environment', 'accessMode']) && Object.values(value.subscription).every(value => typeof value === 'string')

const businessStatuses = { SECRET_REQUEST_NOT_FOUND: 404, SECRET_REQUEST_CLOSED: 409, SECRET_REQUEST_INVALID: 400,
  SECRET_VALUE_INVALID: 400, SECRET_ROOM_INVALID: 400, BOT_NOT_FOUND: 404, OWNER_QUESTION_NOT_FOUND: 404,
  OWNER_QUESTION_CLOSED: 409, OWNER_QUESTION_INVALID: 400, OWNER_QUESTION_ANSWER_INVALID: 400 }
const protect = async (operation, method) => {
  try { return await operation() } catch (error) {
    if (/^[A-Z_0-9]{1,100}$/.test(error.code ?? '') && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) throw error
    if (Object.hasOwn(businessStatuses, error.message)) throw usageError(error.message, businessStatuses[error.message])
    throw usageError(method.startsWith('secrets.') ? 'SECRET_OPERATION_FAILED' : 'USAGE_OPERATION_FAILED', 500)
  }
}

// The channel supplies the validated generation/root context, never an external request body.
export function createUsageChannelDispatcher({ root = '/srv/bellteam', effect, projection }) {
  const scope = new AsyncLocalStorage()
  let services = null, stage = 'new', restore = false
  const context = () => {
    const value = scope.getStore()
    if (!value) throw usageError('USAGE_CONTEXT_UNAVAILABLE')
    return value
  }
  const sendEffect = (method, params) => effect(method, params, context())
  const emit = (row, phase = 'update') => projection({ phase, row }, context())
  return {
    stateCompatibility: USAGE_STATE_COMPATIBILITY,
    validateRequest(method, params, captured) { validateUsageRequest(method, params, captured.actor); return true },
    dispatch: (method, params, captured) => scope.run(captured, () => protect(() => services ? services.request(method, params, captured.actor) : Promise.reject(usageError('USAGE_UNAVAILABLE')), method)),
    validateCallback(method, params, captured) {
      validateUsageRequest(method, params, captured.actor)
      if (method !== 'settings.setError' || captured.actor.kind !== 'system') throw usageError('USAGE_CALLBACK_UNAVAILABLE')
      return true
    },
    dispatchCallback: (method, params, captured) => scope.run(captured, () => protect(() => services ? services.callback(method, params, captured.actor) : Promise.reject(usageError('USAGE_UNAVAILABLE')), method)),
    control: (method, params, captured) => scope.run(captured, async () => {
      if (method === 'initialize' && params.mode === 'restore') {
        if (stage !== 'new' || !keys(params, ['generation', 'mode', 'bootstrap', 'handoff']) || !bootstrapValid(params.bootstrap) || !params.handoff) throw usageError('USAGE_INITIALIZATION_ORDER', 409)
        const bootstrap = params.bootstrap
        const ports = createUsageRegistryPorts({ effect: sendEffect, initialMembers: [] })
        services = createUsageServices({ root, ...ports, effect: sendEffect, onProjection: emit, bridgeHeadersPath: join(root, 'state/call-bridge/headers'), ...bootstrap })
        restore = true
        await emit(await services.initializeSettings({ restore }), 'seed')
        await emit(await services.initializeSubscriptions({ restore }), 'seed')
        await services.initialize({ restore, handoff: params.handoff })
        for (const row of services.snapshot()) await emit(row, 'snapshot')
        stage = 'services'
        return { stateCompatibility: USAGE_STATE_COMPATIBILITY }
      }
      if (method === 'initialize') {
        if (!keys(params, ['generation', 'mode'], ['bootstrap', 'restore', 'handoff'])
          || !['settings', 'subscriptions', 'services'].includes(params.mode)) throw usageError('USAGE_INITIALIZATION_INVALID', 400)
        if (params.mode === 'settings') {
          if (stage !== 'new' || !bootstrapValid(params.bootstrap) || typeof params.restore !== 'boolean' || Object.hasOwn(params, 'handoff')) throw usageError('USAGE_INITIALIZATION_ORDER', 409)
          restore = params.restore
          const ports = createUsageRegistryPorts({ effect: sendEffect, initialMembers: [] })
          services = createUsageServices({ root, ...ports, effect: sendEffect, onProjection: emit,
            bridgeHeadersPath: join(root, 'state/call-bridge/headers'), ...params.bootstrap })
          await emit(await services.initializeSettings({ restore }), 'seed'); stage = 'settings'
        } else if (params.mode === 'subscriptions') {
          if (stage !== 'settings' || Object.keys(params).sort().join(',') !== 'generation,mode') throw usageError('USAGE_INITIALIZATION_ORDER', 409)
          await emit(await services.initializeSubscriptions({ restore }), 'seed'); stage = 'subscriptions'
        } else {
          if (stage !== 'subscriptions' || !keys(params, ['generation', 'mode'], ['handoff']) || restore && !params.handoff) throw usageError('USAGE_INITIALIZATION_ORDER', 409)
          await services.initialize({ restore, handoff: params.handoff ?? null })
          for (const row of services.snapshot()) await emit(row, 'snapshot')
          stage = 'services'
        }
        return { stateCompatibility: USAGE_STATE_COMPATIBILITY }
      }
      if (!keys(params, [])) throw usageError('USAGE_CONTROL_INVALID', 400)
      if (stage !== 'services') throw usageError('USAGE_UNAVAILABLE')
      if (method === 'quiesce') return { quiesced: await services.quiesce() }
      if (method === 'resume') { services.resume(); return { resumed: true } }
      if (method === 'export') return { handoff: services.exportState() }
      if (method === 'exit') { services.close(); stage = 'closed'; return { closed: true } }
      throw usageError('USAGE_CONTROL_INVALID', 400)
    }),
    async disconnect() { if (services && stage === 'services') { await services.quiesce(); services.close(); stage = 'closed' } },
  }
}
