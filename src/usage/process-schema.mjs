import { HARNESS } from '../onboarding.mjs'
import { backgroundInputValid } from './background-agent-settings.mjs'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' && value.length > 0 && !value.includes('\0')
const id = value => text(value) && value.length <= 200
const feature = value => ['routing', 'callBridge', 'cloudflare', 'diagnostics', 'notifications', 'webPush'].includes(value)
const harness = value => Object.hasOwn(HARNESS, value)
const none = value => object(value) && Object.keys(value).length === 0
const shape = (required, optional = {}) => value => object(value)
  && Object.keys(value).every(key => Object.hasOwn(required, key) || Object.hasOwn(optional, key))
  && Object.entries(required).every(([key, valid]) => Object.hasOwn(value, key) && valid(value[key]))
  && Object.entries(optional).every(([key, valid]) => !Object.hasOwn(value, key) || valid(value[key]))
const target = value => shape({}, { botId: id, roomId: id })(value) && Number(Object.hasOwn(value, 'botId')) + Number(Object.hasOwn(value, 'roomId')) === 1
const kinds = {
  read: ['owner', 'bot', 'system'], owner: ['owner'], bot: ['bot'], system: ['system'],
}
const spec = (valid, actors = kinds.read) => ({ valid, actors })
const cardRead = spec(shape({ id }))

// Only this closed table is an IPC business surface; service names are never invoked dynamically.
export const usageMethods = {
  'settings.list': spec(none),
  'settings.backgroundAgent': spec(none),
  'settings.updateBackgroundAgent': spec(backgroundInputValid, kinds.owner),
  'settings.configuration': spec(shape({ id: feature }), kinds.system),
  'settings.update': spec(shape({ id: feature, input: object }), ['owner', 'bot']),
  'settings.setError': spec(shape({ id: feature, epoch: value => Number.isSafeInteger(value) && value >= 0, error: shape({ code: text }) }), kinds.system),
  'onboarding.snapshot': spec(none), 'onboarding.status': spec(none),
  'onboarding.select': spec(shape({ harness }), kinds.owner),
  'onboarding.input': spec(shape({ input: object }), kinds.owner),
  'onboarding.start': spec(none),
  'onboarding.complete': spec(none),
  'onboarding.prepareStartup': spec(shape({ botId: id }), kinds.system),
  'auth.list': spec(none), 'auth.status': spec(shape({ harness })),
  'auth.start': spec(shape({ harness }), kinds.owner),
  'auth.input': spec(shape({ harness, input: object }), kinds.owner),
  'auth.cancel': spec(shape({ harness }), kinds.owner),
  'secrets.create': spec(shape({ toolId: text, label: text, message: text }, { roomId: value => value === null || id(value) }), kinds.bot),
  'secrets.get': cardRead,
  'secrets.submit': spec(shape({ id, value: value => typeof value === 'string' }), kinds.owner),
  'secrets.cancel': spec(shape({ id }), kinds.owner),
  'secrets.withdraw': spec(shape({ id }), kinds.bot),
  'secrets.notifyOwnerGuide': spec(shape({ id }), kinds.system),
  'secrets.timeline': spec(shape({ target }), kinds.system),
  'questions.create': spec(shape({ question: text, options: Array.isArray }, { allowOther: value => typeof value === 'boolean' }), kinds.bot),
  'questions.get': cardRead,
  'questions.answer': spec(shape({ id, input: shape({}, { choice: value => value === null || text(value), text: value => value === null || text(value) }) }), kinds.owner),
  'questions.timeline': spec(shape({ target }), kinds.system),
  'subscriptions.status': spec(none), 'subscriptions.current': spec(none),
  'subscriptions.install': spec(shape({ signedTransaction: text }), kinds.owner),
  'subscriptions.refresh': spec(shape({}, { force: value => typeof value === 'boolean' }), ['owner', 'system']),
  'subscriptions.completeSetup': spec(shape({ botId: id }), kinds.system),
  'subscriptions.runSetupTest': spec(shape({ botId: id }), kinds.owner),
}

export function usageError(code, status = 503) { return Object.assign(new Error(code), { code, status }) }
export function validateUsageActor(actor) {
  return shape({ kind: value => ['owner', 'bot', 'system'].includes(value), botId: value => value === null || id(value) })(actor)
    && (actor.kind === 'bot' ? actor.botId !== null : actor.botId === null)
}
export function validateUsageRequest(method, params, actor) {
  if (!Object.hasOwn(usageMethods, method) || !usageMethods[method].valid(params)) throw usageError('USAGE_INPUT_INVALID', 400)
  if (!validateUsageActor(actor) || !usageMethods[method].actors.includes(actor.kind)
    || actor.kind === 'bot' && method === 'settings.update' && params.id === 'webPush') throw usageError('USAGE_ACTOR_FORBIDDEN', 403)
}
