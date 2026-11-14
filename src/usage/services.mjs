import { join } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { FeatureSettings } from '../feature-settings.mjs'
import { Onboarding, HARNESS } from '../onboarding.mjs'
import { HarnessAuth, harnessAuthStateKeyValid } from '../harness-auth.mjs'
import { SecretRequests, secretCompletionMessage } from '../secret-requests.mjs'
import { OwnerQuestions, ownerAnswerMessage } from '../owner-questions.mjs'
import { Subscriptions } from '../subscriptions.mjs'
import { authReceipt, authUi } from '../auth-ui.mjs'
import { usageError, validateUsageRequest } from './process-schema.mjs'
import { BackgroundAgentSettings } from './background-agent-settings.mjs'
import { createOnePasswordSource } from './onepassword-source.mjs'

const clone = value => structuredClone(value)
const receiptKeys = ['loggedIn', 'slot', 'account_label', 'schema', 'status', 'session_id', 'url', 'user_code', 'input_required', 'message']
function receipt(value, session) {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ['session_id', 'url', 'user_code', 'message'].some(key => value[key] !== undefined && value[key] !== null && typeof value[key] !== 'string')
    || value.loggedIn !== undefined && typeof value.loggedIn !== 'boolean'
    || value.input_required !== undefined && typeof value.input_required !== 'boolean'
    || value.slot !== undefined && !['1st', '2nd'].includes(value.slot)
    || value.account_label !== undefined && value.account_label !== null && typeof value.account_label !== 'string'
    || session && value.session_id && value.session_id !== session) throw usageError('USAGE_HANDOFF_INVALID')
  authReceipt({ structuredContent: value }, session, () => usageError('USAGE_HANDOFF_INVALID'))
  return { ...Object.fromEntries(receiptKeys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])), auth_ui: authUi(value, session ?? value.session_id) }
}
function volatileState(value) {
  if (!value || value.schema !== 'bellteam.usage-volatile.v1'
    || Object.keys(value).sort().join(',') !== 'epochs,errors,onboardingAuth,receipts,schema,sessions'
    || !['errors', 'sessions', 'receipts', 'epochs'].every(key => Array.isArray(value[key]))) throw usageError('USAGE_HANDOFF_INVALID')
  const map = (rows, validate) => {
    const result = new Map()
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== 2 || result.has(row[0]) || !validate(...row)) throw usageError('USAGE_HANDOFF_INVALID')
      result.set(row[0], clone(row[1]))
    }
    return result
  }
  const epochs = map(value.epochs, (id, epoch) => ['routing', 'callBridge', 'cloudflare', 'diagnostics', 'notifications', 'webPush', 'onePassword'].includes(id) && Number.isSafeInteger(epoch) && epoch >= 0)
  if (epochs.size !== 7) throw usageError('USAGE_HANDOFF_INVALID')
  const sessions = map(value.sessions, (key, session) => harnessAuthStateKeyValid(key) && typeof session === 'string' && session.length > 0)
  const receipts = map(value.receipts, (key, item) => harnessAuthStateKeyValid(key) && item !== null
    && (item.slot === undefined ? key !== 'claude:2nd' : item.slot === (key === 'claude:2nd' ? '2nd' : '1st')) && Boolean(receipt(item, sessions.get(key))))
  const errors = map(value.errors, (id, code) => ['routing', 'callBridge', 'cloudflare', 'diagnostics', 'notifications', 'webPush', 'onePassword'].includes(id) && typeof code === 'string' && /^[A-Z_0-9]+$/u.test(code))
  return { epochs, sessions, receipts: new Map([...receipts].map(([h, item]) => [h, receipt(item, sessions.get(h))])), errors, onboardingAuth: receipt(value.onboardingAuth) }
}

// Runtime owns the process/lock and supplies only fixed parent effects and registry ports.
export function createUsageServices({ root, bots, rooms, effect, onProjection = () => {}, onePassword, secretProviders,
  environment = {}, seatRuntime = false, subscription = {} }) {
  let accepting = false, initialized = false, settingsReady = false, stopped = false, quiesced = false, wave = 0, revision = 0
  let settingsInitializing = false, initializing = false, subscriptionReady = false, subscriptionInitializing = false
  let projectionFailed = false, projectionTail = Promise.resolve()
  const epochs = new Map(['routing', 'callBridge', 'cloudflare', 'diagnostics', 'notifications', 'webPush', 'onePassword'].map(id => [id, 0]))
  const pending = new Set(), effectScope = new AsyncLocalStorage()
  const track = run => {
    const result = Promise.resolve().then(run)
    pending.add(result)
    result.then(() => pending.delete(result), () => pending.delete(result))
    return result
  }
  const scoped = run => {
    const result = track(run), scope = effectScope.getStore()
    if (scope) { scope.effects.add(result); result.then(() => scope.effects.delete(result), () => scope.effects.delete(result)) }
    return result
  }
  const callEffect = (method, params) => {
    const projection = projectionTail
    return scoped(async () => { await projection; if (projectionFailed) throw usageError('USAGE_PROJECTION_UNAVAILABLE'); return effect(method, clone(params)) })
  }
  const settings = new FeatureSettings({ root, environment,
    onChange: async (id, configuration) => {
      // A new or removed token connects 1Password now; the result is the feature's status, never a failed save.
      if (id === 'onePassword') { await secretRequests.credentials.refreshAvailability().catch(() => {}); syncOnePassword(); await onePasswordConnection() }
      const epoch = epochs.get(id) + 1; epochs.set(id, epoch)
      publish(settingsProjection())
      return callEffect('settings.changed', { id, configuration, epoch })
    } })
  const backgroundAgent = new BackgroundAgentSettings({ root,
    models: harness => callEffect('backgroundAgent.models', { harness }),
    onChange: configuration => {
      publish(settingsProjection())
      return callEffect('backgroundAgent.changed', { configuration })
    } })
  const subscriptions = new Subscriptions({ path: join(root, seatRuntime ? 'state/subscription.json' : 'shared/subscription.json'), environment: subscription.environment ?? 'Production', accessMode: subscription.accessMode ?? 'subscription', developerAccessAllowed: subscription.developerAccessAllowed })
  const client = { authOptions: () => ({}), call: (method, params) => {
    if (method !== 'agent_auth') throw usageError('USAGE_EFFECT_INVALID')
    const { cwd, ...auth } = params
    return callEffect('auth.call', auth)
  } }
  const onboarding = new Onboarding({ root, ...(seatRuntime ? { path: join(root, 'state/onboarding.json') } : {}), bots, client, subscriptions,
    projectFiles: { appendInstructions: (bot, text) => callEffect('onboarding.prepareStartup', { botId: bot.id, text }) },
    startConversation: (bot, message) => callEffect('onboarding.startConversation', { botId: bot.id, message }) })
  const background = (method, params) => { void callEffect(method, params).catch(() => {}) }
  const secretRequests = new SecretRequests({ root, bots, rooms, onePassword: onePassword ?? createOnePasswordSource({ autoRetry: false }), secretProviders, credentialRetryMs: 0,
    onSave: item => { if (initialized) publish({ type: 'secret', value: item }) },
    onRequest: item => background('secret.created', { item }),
    notify: item => callEffect('secret.completed', { botId: item.botId, message: secretCompletionMessage(item) }) })
  const onePasswordSource = secretRequests.credentials.onePassword
  onePasswordSource.setToken?.(() => {
    const { enabled, token } = settings.configuration('onePassword')
    return enabled && token.trim() ? token.trim() : null
  })
  const onePasswordItem = () => settings.list().find(item => item.id === 'onePassword')
  const onePasswordConnected = () => settings.configuration('onePassword').enabled && onePasswordSource.available
  const syncOnePassword = () => {
    const code = settings.configuration('onePassword').enabled && !onePasswordSource.available
      ? onePasswordSource.reason === 'missing' ? 'ONEPASSWORD_CLI_MISSING' : 'ONEPASSWORD_TOKEN_REJECTED' : null
    const before = JSON.stringify(onePasswordItem())
    settings.setError('onePassword', code ? { code } : null)
    if (!onePasswordConnected()) settings.setConnection('onePassword', null)
    return JSON.stringify(onePasswordItem()) !== before
  }
  // Runs only inside a live operation (save, initialize, trusted refresh) so its projection is accepted.
  const onePasswordConnection = async () => {
    if (!onePasswordConnected() || !onePasswordSource.inventory) return false
    let connection = null
    try { const { vaults, keys } = await onePasswordSource.inventory(); connection = { vaults, sshKeys: keys.length } } catch {}
    const before = JSON.stringify(onePasswordItem())
    settings.setConnection('onePassword', onePasswordConnected() ? connection : null)
    return JSON.stringify(onePasswordItem()) !== before
  }
  onePasswordSource.watch(() => { if (syncOnePassword() && initialized) publish(settingsProjection()) })
  const ownerQuestions = new OwnerQuestions({ root, bots,
    onSave: item => publish({ type: 'question', value: item }),
    onRequest: item => background('question.created', { item }),
    notify: item => callEffect('question.answered', { botId: item.botId, message: ownerAnswerMessage(item) }) })
  const assertOpen = (method, actor) => {
    if (projectionFailed) throw usageError('USAGE_PROJECTION_UNAVAILABLE')
    if (!initialized && settingsReady && !stopped && actor.kind === 'system' && ['settings.list', 'settings.configuration', 'settings.setError', 'settings.backgroundAgent'].includes(method)) return
    if (stopped || !initialized || !accepting) throw usageError('USAGE_UNAVAILABLE')
  }
  const getOwned = (service, id, actor, code) => {
    const item = service.get(id)
    if (actor.kind === 'bot' && item.botId !== actor.botId) throw Object.assign(new Error(code), { code, status: 404 })
    return item
  }
  const handlers = {
    'settings.list': () => settings.list(),
    'settings.configuration': ({ id }) => settings.configuration(id),
    'settings.update': ({ id, input }, actor) => settings.update(id, input, { secretRequests, botId: actor.botId, allowSecretValues: actor.kind === 'owner' }),
    'settings.backgroundAgent': () => backgroundAgent.configuration(),
    'settings.updateBackgroundAgent': input => backgroundAgent.update(input),
    'settings.setError': ({ id, error, epoch }) => {
      if (epoch !== epochs.get(id)) throw usageError('USAGE_SETTINGS_STALE', 409)
      return settings.setError(id, error)
    },
    'onboarding.snapshot': () => onboarding.snapshot(), 'onboarding.status': () => onboarding.status(),
    'onboarding.select': ({ harness }) => onboarding.select(harness),
    'onboarding.input': ({ input }) => onboarding.input(input), 'onboarding.start': () => onboarding.start(),
    'onboarding.complete': (_, actor) => onboarding.complete(actor.kind === 'bot' ? actor.botId : undefined),
    'onboarding.prepareStartup': async ({ botId }) => {
      await bots.refresh()
      const bot = bots.get(botId)
      if (!bot) throw usageError('BOT_NOT_FOUND', 404)
      return onboarding.prepareStartup(bot)
    },
    'auth.list': () => harnessAuth.list(), 'auth.status': ({ harness, slot }) => harnessAuth.status(harness, { slot }),
    'auth.start': ({ harness, slot }) => harnessAuth.start(harness, { slot }), 'auth.input': ({ harness, input, slot }) => harnessAuth.input(harness, input, { slot }),
    'auth.cancel': ({ harness, slot }) => harnessAuth.cancel(harness, { slot }),
    'secrets.create': (params, actor) => secretRequests.create({ ...params, botId: actor.botId }),
    'secrets.requestTerminalKey': params => secretRequests.requestTerminalKey(params),
    'secrets.current': ({ scope }) => secretRequests.currentCredential(scope),
    'secrets.unbind': ({ handle, scope }) => secretRequests.unbindCredential(handle, scope),
    'secrets.revokeTerminalRequests': ({ scope }) => secretRequests.revokeTerminalRequests(scope),
    'secrets.get': ({ id }, actor) => getOwned(secretRequests, id, actor, 'SECRET_REQUEST_NOT_FOUND'),
    'secrets.onePasswordItems': ({ id }) => secretRequests.onePasswordItems(id),
    'secrets.resolveRequest': ({ id }) => secretRequests.resolveValue(id),
    'secrets.bind': ({ id, scope }) => secretRequests.bindCredential(id, scope),
    'secrets.credential': ({ handle, context }) => secretRequests.credential(handle, context),
    'secrets.resolve': ({ handle, context }) => secretRequests.withResolved(handle, context, value => value),
    'secrets.replace': ({ handle, id, context }) => secretRequests.replaceCredential(handle, id, context),
    'secrets.refresh': async () => {
      const result = await secretRequests.credentials.refreshAvailability()
      if ((syncOnePassword() | (!onePasswordItem().connection && await onePasswordConnection())) && initialized) publish(settingsProjection())
      return result
    },
    'secrets.submit': ({ id, value }) => secretRequests.submit(id, value), 'secrets.cancel': ({ id }) => secretRequests.cancel(id),
    'secrets.withdraw': ({ id }, actor) => secretRequests.withdraw(id, actor.botId),
    'secrets.notifyOwnerGuide': ({ id }) => secretRequests.notifyOwnerGuide(id),
    'secrets.timeline': ({ target }) => secretRequests.timeline(target),
    'questions.create': (params, actor) => ownerQuestions.create({ ...params, botId: actor.botId }),
    'questions.get': ({ id }, actor) => getOwned(ownerQuestions, id, actor, 'OWNER_QUESTION_NOT_FOUND'),
    'questions.answer': ({ id, input }) => ownerQuestions.answer(id, input),
    'questions.timeline': ({ target }) => ownerQuestions.timeline(target),
    'subscriptions.status': () => subscriptions.status(), 'subscriptions.current': () => subscriptions.current(),
    'subscriptions.install': ({ signedTransaction }) => subscriptions.install(signedTransaction),
    'subscriptions.refresh': params => subscriptions.refresh(params),
    'subscriptions.completeSetup': ({ botId }) => subscriptions.completeSetup(botId),
    'subscriptions.runSetupTest': ({ botId }) => subscriptions.runSetupTest(botId, () => callEffect('subscription.setupTest', { botId })),
  }
  const harnessAuth = new HarnessAuth({ bots, client, accounts: { prepare: async (harness, slot) => {
    try { return await callEffect('auth.prepareAccount', { harness, slot, tokenFile: true }) }
    // A body older than one-login-per-slot refuses the flag before running it; the root alone keeps that body's login.
    catch (error) { if (error?.code !== 'USAGE_IPC_INVALID' || error.outcome !== 'not_accepted') throw error }
    return callEffect('auth.prepareAccount', { harness, slot })
  },
    list: () => callEffect('auth.listAccounts', {}) } })
  const publish = record => {
    const row = clone({ ...record, revision: ++revision }), previous = projectionTail
    const result = scoped(async () => { await previous; await onProjection(row) })
    projectionTail = result.catch(() => { projectionFailed = true })
    return result
  }
  const settingsProjection = () => ({ type: 'settings', epochs: Object.fromEntries(epochs), list: settings.list(), configurations: Object.fromEntries(settings.list().map(({ id }) => [id, settings.configuration(id)])), ...backgroundAgent.projection() })
  const baseProjection = () => [{ ...settingsProjection() }, { type: 'onboarding', value: onboarding.snapshot() }, { type: 'auth', value: harnessAuth.list() }, { type: 'subscription', value: subscriptions.status() }]
  secretRequests.watch(event => { if (initialized) publish({ type: 'event', value: event }) })
  secretRequests.watchCredentials(value => { if (initialized) publish({ type: 'credential', value }) })
  secretRequests.watchRecovery(value => { if (initialized) publish({ type: 'credentialRecovery', value }) })
  ownerQuestions.watch(event => publish({ type: 'event', value: event }))
  const dispatch = (method, params, actor) => {
    return track(() => effectScope.run({ effects: new Set() }, async () => {
        try { const result = await handlers[method](params, actor); return result === undefined ? null : clone(result) }
        finally {
          for (const row of initialized ? baseProjection() : [settingsProjection()]) publish(row)
          const { effects } = effectScope.getStore()
          while (effects.size) await Promise.allSettled([...effects])
          if (projectionFailed) throw usageError('USAGE_PROJECTION_UNAVAILABLE')
        }
      }))
  }
  const initializeSubscriptions = async ({ restore = false } = {}) => {
    if (!settingsReady || subscriptionInitializing || stopped) throw usageError('USAGE_INITIALIZATION_ORDER', 409)
    subscriptionInitializing = true
    await subscriptions.initialize({ readOnly: restore }); subscriptionReady = true
    return { type: 'subscription', value: subscriptions.status(), revision }
  }
  return {
    initializeSubscriptions,
    async initializeSettings({ restore = false } = {}) {
      if (settingsReady || settingsInitializing || stopped) throw usageError('USAGE_ALREADY_INITIALIZED', 409)
      settingsInitializing = true
      await settings.initialize({ readOnly: restore }); await backgroundAgent.initialize(); settingsReady = true
      return clone({ ...settingsProjection(), revision })
    },
    async initialize({ restore = false, handoff = null } = {}) {
      if (!settingsReady || initialized || initializing || stopped) throw usageError('USAGE_INITIALIZATION_ORDER', 409)
      initializing = true
      const state = handoff === null ? null : volatileState(handoff)
      if (!subscriptionReady) await initializeSubscriptions({ restore })
      await bots.refresh?.()
      await onboarding.initialize({ readOnly: restore })
      await secretRequests.initialize({ readOnly: restore })
      await ownerQuestions.initialize({ readOnly: restore })
      if (state) {
        for (const [id, epoch] of state.epochs) epochs.set(id, epoch)
        if (Object.hasOwn(settings, 'routingEpoch')) settings.routingEpoch = epochs.get('routing')
        for (const [id, code] of state.errors) settings.setError(id, { code })
        harnessAuth.sessions = state.sessions; harnessAuth.receipts = state.receipts; onboarding.auth = receipt(state.onboardingAuth, onboarding.state.authSession)
      }
      syncOnePassword(); await onePasswordConnection()
      initialized = true; accepting = true
    },
    request(method, params, actor) {
      try { validateUsageRequest(method, params, actor); assertOpen(method, actor); params = clone(params); actor = { ...actor } }
      catch (error) { return Promise.reject(error) }
      return dispatch(method, params, actor)
    },
    callback(method, params, actor) {
      try {
        validateUsageRequest(method, params, actor)
        if (method !== 'settings.setError' || actor.kind !== 'system' || stopped || quiesced || !pending.size) throw usageError('USAGE_CALLBACK_UNAVAILABLE')
      } catch (error) { return Promise.reject(error) }
      return dispatch(method, params, actor)
    },
    async quiesce() {
      if (!initialized || stopped) throw usageError('USAGE_UNAVAILABLE')
      accepting = false; quiesced = false; const captured = ++wave
      while (pending.size) await Promise.allSettled([...pending])
      quiesced = !accepting && !stopped && wave === captured
      return quiesced
    },
    resume() { if (stopped || !initialized) throw usageError('USAGE_UNAVAILABLE'); wave++; quiesced = false; accepting = true },
    exportState() {
      if (!initialized || !quiesced || pending.size) throw usageError('USAGE_NOT_QUIESCED', 409)
      return clone({ schema: 'bellteam.usage-volatile.v1', epochs: [...epochs], errors: [...settings.errors].map(([id, error]) => [id, error.code]),
        sessions: [...harnessAuth.sessions], receipts: [...harnessAuth.receipts].map(([h, value]) => [h, receipt(value, harnessAuth.sessions.get(h))]),
        onboardingAuth: receipt(onboarding.auth, onboarding.state.authSession) })
    },
    *snapshot() {
      if (!initialized || stopped) throw usageError('USAGE_UNAVAILABLE')
      const rows = baseProjection(), secrets = [...secretRequests.items.keys()].map(id => secretRequests.get(id)), questions = [...ownerQuestions.items.values()], captured = revision
      for (const row of rows) yield clone({ ...row, revision: captured })
      for (const item of secrets) yield clone({ type: 'secret', value: item, revision: captured })
      for (const item of questions) yield clone({ type: 'question', value: item, revision: captured })
    },
    close() {
      if (!quiesced || pending.size) throw usageError('USAGE_NOT_QUIESCED', 409)
      secretRequests.close()
      stopped = true; accepting = false; harnessAuth.sessions.clear(); harnessAuth.receipts.clear(); onboarding.auth = null
    },
  }
}


export function usageHandoffValid(value) {
  try { volatileState(value); return true } catch { return false }
}
