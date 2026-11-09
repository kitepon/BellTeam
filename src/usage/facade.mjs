import { EventEmitter } from 'node:events'

// Request context is a parent-captured capability; caller fields never grant authority.
export function createUsageFacade({ request, projection, toolsDirectory }) {
  const events = new EventEmitter()
  const call = (method, params, context) => request(method, params, context)
  const authTarget = (harness, options) => ({ harness, ...(options.slot === undefined ? {} : { slot: options.slot }) })
  const cards = kind => ({
    get: id => projection.get(kind, id),
    read: (id, context) => call(kind === 'secret' ? 'secrets.get' : 'questions.get', { id }, context),
    timeline: target => projection.timeline(kind, target),
    timelineView: target => projection.timelineView(kind, target),
    watch(listener) { events.on(kind, listener); return () => events.off(kind, listener) },
  })
  const facade = {
    settings: {
      list: () => projection.list(), configuration: id => projection.configuration(id),
      hasBackgroundAgent: () => projection.hasBackgroundAgent(),
      backgroundAgentConfiguration: async () => projection.backgroundAgent(),
      updateBackgroundAgent: (input, options = {}) => call('settings.updateBackgroundAgent', input, options.usageContext),
      routingState: () => ({ enabled: projection.configuration('routing').enabled, epoch: projection.epoch('routing') }),
      configurationState: id => ({ configuration: projection.configuration(id), epoch: projection.epoch(id) }),
      update: (id, input, options = {}) => call('settings.update', { id, input }, options.usageContext),
      setError: (id, error, options = {}) => call('settings.setError', { id, epoch: options.epoch, error: error ? { code: /^[A-Z_0-9]+$/u.test(error.code ?? '') ? error.code : 'FEATURE_APPLY_FAILED' } : null }, options.usageContext),
    },
    onboarding: {
      snapshot: () => projection.onboarding(), status: context => call('onboarding.status', {}, context),
      select: (harness, context) => call('onboarding.select', { harness }, context),
      input: (input, context) => call('onboarding.input', { input }, context),
      start: context => call('onboarding.start', {}, context),
      complete: (_, context) => call('onboarding.complete', {}, context),
      prepareStartup: (bot, context) => call('onboarding.prepareStartup', { botId: bot.id }, context),
    },
    harnessAuth: {
      list: () => projection.auth(), status: (harness, context, options = {}) => call('auth.status', authTarget(harness, options), context),
      start: (harness, context, options = {}) => call('auth.start', authTarget(harness, options), context),
      input: (harness, input, context, options = {}) => call('auth.input', { ...authTarget(harness, options), input }, context),
      cancel: (harness, context, options = {}) => call('auth.cancel', authTarget(harness, options), context),
    },
    secretRequests: {
      ...cards('secret'), toolsDirectory,
      create: ({ botId, ...input }, context) => call('secrets.create', input, context),
      requestTerminalKey: (input, context) => call('secrets.requestTerminalKey', input, context),
      currentCredential: (scope, context) => call('secrets.current', { scope }, context),
      unbindCredential: (handle, scope, context) => call('secrets.unbind', { handle, scope }, context),
      revokeTerminalRequests: (scope, context) => call('secrets.revokeTerminalRequests', { scope }, context),
      submit: (id, value, context) => call('secrets.submit', { id, value }, context),
      resolveValue: (id, context) => call('secrets.resolveRequest', { id }, context),
      bindCredential: (id, scope, context) => call('secrets.bind', { id, scope }, context),
      credential: (handle, target, context) => call('secrets.credential', { handle, context: target }, context),
      replaceCredential: (handle, id, target, context) => call('secrets.replace', { handle, id, context: target }, context),
      async withResolved(handle, target, consume, context) {
        let value = await call('secrets.resolve', { handle, context: target }, context)
        try { return await consume(value) } finally { value = null }
      },
      watchCredentials(listener) { events.on('credential', listener); return () => events.off('credential', listener) },
      watchRecovery(listener) { events.on('credentialRecovery', listener); return () => events.off('credentialRecovery', listener) },
      refreshCredentials: context => call('secrets.refresh', {}, context),
      cancel: (id, context) => call('secrets.cancel', { id }, context),
      withdraw: (id, botId, context) => call('secrets.withdraw', { id }, context),
      notifyOwnerGuide: (id, context) => call('secrets.notifyOwnerGuide', { id }, context),
    },
    ownerQuestions: {
      ...cards('question'),
      create: ({ botId, ...input }, context) => call('questions.create', input, context),
      answer: (id, input, context) => call('questions.answer', { id, input }, context),
    },
    subscriptions: {
      status: () => projection.subscription(), current: context => call('subscriptions.current', {}, context),
      install: (signedTransaction, context) => call('subscriptions.install', { signedTransaction }, context),
      refresh: (input = {}, context) => call('subscriptions.refresh', input, context),
      completeSetup: (botId, context) => call('subscriptions.completeSetup', { botId }, context),
      runSetupTest: (botId, run, context) => call('subscriptions.runSetupTest', { botId }, context),
    },
    accept(row, generation, beforeNotify) {
      projection.accept(row, generation)
      const notify = () => {
        if (row.type === 'credential') events.emit('credential', structuredClone(row.value))
        if (row.type === 'credentialRecovery') events.emit('credentialRecovery', structuredClone(row.value))
        if (row.type === 'event') {
          if (row.value.topics.includes('requests')) events.emit('secret', structuredClone(row.value))
          if (row.value.topics.includes('questions')) events.emit('question', structuredClone(row.value))
        }
      }
      if (beforeNotify) return Promise.resolve().then(beforeNotify).then(notify)
      notify()
    },
  }
  return facade
}
