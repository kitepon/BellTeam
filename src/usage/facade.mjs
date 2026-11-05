import { EventEmitter } from 'node:events'

// Request context is a parent-captured capability; caller fields never grant authority.
export function createUsageFacade({ request, projection, toolsDirectory }) {
  const events = new EventEmitter()
  const call = (method, params, context) => request(method, params, context)
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
      list: () => projection.auth(), status: (harness, context) => call('auth.status', { harness }, context),
      start: (harness, context) => call('auth.start', { harness }, context),
      input: (harness, input, context) => call('auth.input', { harness, input }, context),
      cancel: (harness, context) => call('auth.cancel', { harness }, context),
    },
    secretRequests: {
      ...cards('secret'), toolsDirectory,
      create: ({ botId, ...input }, context) => call('secrets.create', input, context),
      submit: (id, value, context) => call('secrets.submit', { id, value }, context),
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
    accept(row, generation) {
      projection.accept(row, generation)
      if (row.type === 'event') {
        if (row.value.topics.includes('requests')) events.emit('secret', structuredClone(row.value))
        if (row.value.topics.includes('questions')) events.emit('question', structuredClone(row.value))
      }
    },
  }
  return facade
}
