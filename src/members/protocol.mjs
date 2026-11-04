import { validateAvatar } from '../avatar-value.mjs'
import { normalizeSchedule } from '../schedule-definition.mjs'
import { normalizeMembersError } from './errors.mjs'

const fail = () => { throw Object.assign(new Error('MEMBERS_INPUT_INVALID'), { code: 'MEMBERS_INPUT_INVALID', outcome: 'not_accepted', status: 400 }) }
const string = (value, max = 16 * 1024 * 1024) => { if (typeof value !== 'string' || value.length > max || value.includes('\0')) fail() }
const id = value => { string(value, 64); if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value)) fail() }
const bool = value => { if (typeof value !== 'boolean') fail() }
const time = value => { string(value); if (!Number.isFinite(Date.parse(value))) fail() }
const revision = value => { if (!Number.isSafeInteger(value) || value < 0) fail() }
const object = (value, fields, required = Object.keys(fields)) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key))) fail()
  for (const [key, item] of Object.entries(value)) { if (!Object.hasOwn(fields, key)) fail(); fields[key](item) }
}
const empty = value => object(value, {})
const text = value => string(value)
const body = value => { string(value); if (Buffer.byteLength(value) > 16 * 1024 * 1024) fail() }
const ids = value => { if (!Array.isArray(value)) fail(); value.forEach(id) }
const harness = value => { if (!['claude', 'codex', 'grok', 'cursor', 'antigravity'].includes(value)) fail() }
const crop = value => {
  if (value === null) return
  object(value, Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, number => { if (!Number.isFinite(number)) fail() }])))
}
const profileFields = {
  name: value => { string(value, 100); if (!value.trim()) fail() }, harness,
  model: value => string(value, 200), reasoningEffort: text, fastMode: bool,
  profileText: value => string(value, 8000), personality: value => string(value, 8000), speechStyle: value => string(value, 8000),
  position: value => string(value, 100), role: value => string(value, 8000),
  color: value => { if (!['rose', 'indigo', 'violet'].includes(value)) fail() },
  avatar: validateAvatar, avatarLarge: validateAvatar, avatarSource: validateAvatar, avatarLargeSource: validateAvatar,
  avatarCrop: crop, avatarLargeCrop: crop,
}
const changes = value => object(value, profileFields, [])
const create = value => object(value, profileFields, ['name'])
const ownerChanges = value => object(value, {
  name: value => string(value, 100), profile: value => string(value, 8000), avatar: validateAvatar,
  xUrl: value => string(value, 2048), githubUrl: value => string(value, 2048),
  links: value => { if (!Array.isArray(value) || value.length > 20) fail(); value.forEach(item => object(item, { label: value => string(value, 100), url: value => string(value, 2048) })) },
}, [])
const schedule = value => {
  object(value, Object.fromEntries(['id', 'name', 'kind', 'at', 'expression', 'timezone', 'prompt', 'command', 'enabled', 'intervalDays', 'startDate', 'time', 'intervalHours', 'startHour', 'endHour', 'minute', 'targets'].map(key => [key, () => {}])), ['kind'])
  if (value.targets !== undefined) ids(value.targets)
  normalizeSchedule({ ...value, id: value.id ?? 'validation' }, new Date())
}
const owner = { ownerKind: value => { if (!['bot', 'room'].includes(value)) fail() }, ownerId: id }
const claim = { ...owner, scheduleId: text, expectedRevision: revision, expectedNextRunAt: time, ranAt: time }

export function validateMembersContext(context, { initialize = false } = {}) {
  object(context, { generation: value => { string(value, 200); if (!value) fail() }, leaseId: value => { if (initialize && value === null) return; string(value, 200); if (!value) fail() }, rootId: value => { string(value, 200); if (!value) fail() }, ownerWrite: bool, continuation: bool })
}

const requests = {
  'profiles.read': value => empty(value), 'profile.read': value => object(value, { botId: id, includeDeleting: value => { if (value !== true) fail() } }, ['botId']),
  'profile.create': value => object(value, { input: create, id: value => { if (value !== 'bot-guide') fail() } }, ['input']),
  'profile.preview': value => object(value, { botId: id, changes }),
  'profile.update': value => object(value, { botId: id, changes }),
  'profile.startup': value => object(value, { botId: id, shortTermMemory: body }),
  'profile.remove': value => object(value, { botId: id }),
  'removals.read': empty,
  'owner.read': empty, 'owner.update': value => object(value, { changes: ownerChanges }),
  'rules.read': empty, 'rules.update': value => object(value, { text: value => string(value, 20000) }),
  'schedules.list': value => object(value, owner),
  'schedules.set': value => object(value, { ...owner, input: schedule }),
  'schedules.remove': value => object(value, { ...owner, scheduleId: text }),
  'schedules.claimDue': value => object(value, claim), 'schedules.skipDue': value => object(value, claim),
}
const callbacks = {
  'profiles.cli': empty,
  'profile.session': value => object(value, { botId: id, session: value => { string(value, 8000); if (!value.trim()) fail() } }),
  'profile.fastMode': value => object(value, { botId: id, fastMode: bool }),
}
export const MEMBERS_REQUEST_METHODS = Object.freeze(Object.keys(requests))
export const MEMBERS_CALLBACK_METHODS = Object.freeze(Object.keys(callbacks))
function validate(table, method, params, context) {
  validateMembersContext(context)
  if (!Object.hasOwn(table, method) || Buffer.byteLength(JSON.stringify(params) ?? '') > 16 * 1024 * 1024) fail()
  table[method](params)
  if (['owner.update', 'rules.update'].includes(method) && context.ownerWrite !== true) fail()
}
export const validateMembersRequest = (method, params, context) => {
  try { validate(requests, method, params, context) } catch (error) { throw normalizeMembersError(error) }
}
export const validateMembersCallback = (method, params, context) => {
  try { validate(callbacks, method, params, context) } catch (error) { throw normalizeMembersError(error) }
}

const projectId = { botId: id }
const roomId = { roomId: id }
const roomClaim = { ...roomId, scheduleId: text, expectedRevision: revision, expectedNextRunAt: time, ranAt: time }
const effects = {
  'project.ensureRoot': empty,
  'project.claim': value => object(value, projectId), 'project.initialize': value => object(value, projectId), 'project.remove': value => object(value, projectId),
  'project.readPreviousSession': value => object(value, projectId),
  'project.writeInstructions': value => object(value, { ...projectId, body }),
  'project.prepareStartupContext': value => object(value, { ...projectId, previousSession: body, body }),
  'project.appendInstructions': value => object(value, { ...projectId, text: body }),
  'global.writeInstructions': value => object(value, { body }),
  'cli.configure': value => object(value, { botIds: ids }),
  'models.read': value => object(value, { harness }),
  'assets.prepareBotAssetRemoval': value => object(value, projectId),
  'assets.cancelBotAssetRemoval': value => object(value, { ...projectId, lease: text, state: value => object(value, {
    active: value => { if (value !== true) fail() }, hasIntent: value => { if (value !== false) fail() }, retired: value => { if (value !== false) fail() },
  }) }),
  'room.schedules.list': value => object(value, roomId),
  'room.schedules.set': value => object(value, { ...roomId, input: schedule }),
  'room.schedules.remove': value => object(value, { ...roomId, scheduleId: text }),
  'room.schedules.claimDue': value => object(value, roomClaim), 'room.schedules.skipDue': value => object(value, roomClaim),
}
export const MEMBERS_EFFECT_METHODS = Object.freeze(Object.keys(effects))
export function validateMembersEffect(method, params, context) {
  try { validate(effects, method, params, context) } catch (error) { throw normalizeMembersError(error) }
}
export function validateMembersControl(method, params) {
  if (method === 'initialize') object(params, { generation: value => { string(value, 200); if (!value) fail() } })
  else if (['resume', 'quiesce', 'exit'].includes(method)) empty(params)
  else fail()
}

const version = value => { if (value !== '' && (typeof value !== 'string' || !/^[a-f0-9]{16}$/u.test(value))) fail() }
const avatarVersions = { avatarVersion: version, avatarLargeVersion: version, avatarSourceVersion: version, avatarLargeSourceVersion: version }
const bot = (value, metadata = false) => {
  object(value, { ...profileFields, ...(metadata ? avatarVersions : {}), id, session: text, project: text, displayName: text, deleting: bool, hasAvatar: bool, hasAvatarLarge: bool }, ['id', 'name', 'harness', 'session'])
}
const persistedSchedule = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  const { lastRunAt, nextRunAt, revision: generation, ...input } = value
  schedule(input)
  if (lastRunAt !== null) time(lastRunAt)
  if (nextRunAt !== null) time(nextRunAt)
  if (generation !== undefined) revision(generation)
}
const nullableSchedule = value => { if (value !== null) persistedSchedule(value) }
const removalStates = value => object(value, { removals: values => {
  if (!Array.isArray(values)) fail()
  values.forEach(item => object(item, { botId: id, active: bool, hasIntent: value => { if (value !== true) fail() }, retired: bool }))
} })
function checkMembersResult(method, value) {
  if (method === 'profiles.cli') { object(value, { botIds: ids }); return }
  if (method === 'profile.remove') {
    object(value, { id, configurationSync: value => object(value, { state: value => { if (value !== 'failed') fail() }, name: text, message: text, code: text, status: value => { if (!Number.isInteger(value)) fail() } }, ['state', 'name', 'message']) }, ['id'])
    return
  }
  if (method === 'profiles.read') { object(value, { revision }); return }
  if (['profile.read', 'profile.create', 'profile.preview', 'profile.update', 'profile.session', 'profile.fastMode'].includes(method)) { object(value, { bot }); return }
  if (method === 'profile.startup') { object(value, { prepared: value => { if (value !== true) fail() } }); return }
  if (method === 'removals.read') { removalStates(value); return }
  if (['rules.read', 'rules.update'].includes(method)) { object(value, { text: body }); return }
  if (['owner.read', 'owner.update'].includes(method)) { object(value, { owner: value => { const { schema, ...fields } = value ?? {}; if (schema !== 'bellteam.owner-profile.v1') fail(); ownerChanges(fields) } }); return }
  if (method === 'schedules.list') { object(value, { schedules: values => { if (!Array.isArray(values)) fail(); values.forEach(persistedSchedule) } }); return }
  if (method === 'schedules.set') { object(value, { schedule: persistedSchedule }); return }
  if (method === 'schedules.remove') { object(value, { removed: text }); return }
  if (['schedules.claimDue', 'schedules.skipDue'].includes(method)) { nullableSchedule(value); return }
  fail()
}
function checkMembersEffectResult(method, value) {
  if (method === 'assets.prepareBotAssetRemoval') { string(value, 200); if (!value) fail(); return }
  if (method === 'assets.cancelBotAssetRemoval') { bool(value); return }
  if (method === 'project.readPreviousSession') { body(value); return }
  if (method === 'models.read') {
    if (!value || typeof value !== 'object' || !Array.isArray(value.efforts) || value.efforts.some(item => typeof item !== 'string')
      || value.models !== undefined && !Array.isArray(value.models)) fail()
    return
  }
  if (method === 'room.schedules.list') { if (!Array.isArray(value)) fail(); value.forEach(persistedSchedule); return }
  if (method === 'room.schedules.set') { persistedSchedule(value); return }
  if (['room.schedules.claimDue', 'room.schedules.skipDue'].includes(method)) { nullableSchedule(value); return }
  if (method === 'room.schedules.remove') { if (value !== true) fail(); return }
  if (!Object.hasOwn(effects, method) || value !== undefined && value !== null) fail()
}
export function validateMembersProjection(record, context) {
  validateMembersContext(context, { initialize: true })
  if (record?.type === 'snapshot-start' || record?.type === 'snapshot-end') object(record, { type: text, revision })
  else if (record?.type === 'profile') object(record, { type: text, revision, bot: value => bot(value, true) })
  else fail()
}

function resultCheck(check, method, value) {
  try { check(method, value) } catch (cause) {
    throw Object.assign(new Error('MEMBERS_RESULT_INVALID', { cause }), { code: 'MEMBERS_RESULT_INVALID', outcome: 'unknown', status: 503 })
  }
}
export const validateMembersResult = (method, value) => resultCheck(checkMembersResult, method, value)
export const validateMembersEffectResult = (method, value) => resultCheck(checkMembersEffectResult, method, value)
