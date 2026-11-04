import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotAdministration } from '../src/bot-administration.mjs'
import { automaticConfigurationApplication, automaticConfigurationApplicationSchema } from '../src/automatic-configuration-application.mjs'
import { createExecutionDispatcher, EXECUTION_METHODS } from '../src/execution-dispatcher.mjs'
import { createExecutionFacade } from '../src/execution-facade.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'

const idA = '12345678-1234-1234-1234-123456789abc'
const idB = '12345678-1234-1234-1234-123456789abd'
const snapshot = (changes = {}) => ({ schema: 'bellteam.automatic-configuration-application.v1', requestId: idA,
  state: 'unknown', phase: 'configure', effect: 'possible', laterEffect: 'unknown', stopIntent: 'durable',
  admissionStopped: true, revocation: 'pending', errorCode: 'AUTOMATIC_CONFIGURATION_UNKNOWN', ...changes })
const operation = (currentRequestId = idA) => ({ currentRequestId, records: new Map([[idA, snapshot()],
  [idB, snapshot({ requestId: idB, state: 'pending', phase: 'preparing', effect: 'not_started', errorCode: null })]]) })
function fixture(transport = {}) {
  const bot = { id: 'bot-a', model: 'desired-model' }, bots = new Map([[bot.id, bot], ['bot-b', { id: 'bot-b' }]])
  return { bot, bots, admin: new BotAdministration({ bots, transport, writeLog() {} }) }
}

test('closed ten-key schema rejects extra fields, accessors, symbols and invalid scalar values without invoking getters', () => {
  assert.equal(automaticConfigurationApplicationSchema.required.length, 10)
  const original = snapshot(), result = automaticConfigurationApplication(original, idA)
  assert.deepEqual(result, original); assert.notEqual(result, original); assert.ok(Object.isFrozen(result))
  let getterCalls = 0
  const accessor = { ...original }; Object.defineProperty(accessor, 'phase', { get() { getterCalls++; return 'configure' }, enumerable: true })
  const invalid = [accessor, { ...original, privatePoint: 'private' }, { ...original, [Symbol('secret')]: true },
    { ...original, requestId: 'NOT-A-UUID' }, { ...original, state: 'accepted' }, { ...original, effect: 'safe' },
    { ...original, laterEffect: 'not_recorded' }, { ...original, stopIntent: 'stopped' },
    { ...original, revocation: 'done' }, { ...original, errorCode: 'ARBITRARY_PRIVATE_VALUE' },
    { ...original, admissionStopped: 'true' }, { ...original, schema: 'different' }, { ...original, phase: Promise.resolve() }]
  for (const value of invalid) assert.throws(() => automaticConfigurationApplication(value), { code: 'CONFIGURATION_OPERATION_READ_UNAVAILABLE', status: 503 })
  assert.throws(() => automaticConfigurationApplication(original, idB), { status: 503 })
  assert.equal(getterCalls, 0)
})

test('synchronous view adds only the optional unknown snapshot while preserving the latest ordinary application', () => {
  const { admin, bot } = fixture()
  const ordinary = { state: 'pending', requested: { model: 'newer-B' } }
  admin.applications.set(bot.id, ordinary)
  assert.equal(Object.hasOwn(admin.view(bot), 'automaticConfigurationApplication'), false)
  admin.automaticConfigurationOperations.set(bot.id, operation())
  const view = admin.view(bot)
  assert.deepEqual(view.configurationApplication, ordinary)
  assert.notEqual(view.configurationApplication, ordinary)
  assert.deepEqual(view.automaticConfigurationApplication, snapshot())
  assert.equal(view.automaticConfigurationApplication.requestId, idA)
  assert.equal(view.then, undefined)
  assert.equal(admin.applications.get(bot.id), ordinary)
})

test('same-ID reads preserve old records and unknown, isolate bot IDs and prioritize missing bot over malformed ID', () => {
  const { admin, bot } = fixture()
  const original = operation(idB); admin.automaticConfigurationOperations.set(bot.id, original)
  assert.deepEqual(admin.readConfigurationOperation(bot.id, idA), snapshot())
  assert.equal(admin.view(bot).automaticConfigurationApplication.requestId, idB)
  assert.equal(original.records.get(idA).laterEffect, 'unknown')
  assert.equal(original.records.size, 2)
  assert.throws(() => admin.readConfigurationOperation('missing', 'bad'), { code: 'BOT_NOT_FOUND', status: 404 })
  assert.throws(() => admin.readConfigurationOperation(bot.id, 'bad'), { code: 'CONFIGURATION_OPERATION_ID_INVALID', status: 400 })
  assert.throws(() => admin.readConfigurationOperation('bot-b', idA), { code: 'CONFIGURATION_OPERATION_NOT_RECORDED', status: 404 })
})

test('corrupt records and throwing cache access fail closed without leaking an exception or clearing records', () => {
  const { admin, bot } = fixture(), row = operation()
  admin.automaticConfigurationOperations.set(bot.id, row)
  row.records.set(idA, { ...snapshot(), rawError: 'private' })
  assert.throws(() => admin.readConfigurationOperation(bot.id, idA), { code: 'CONFIGURATION_OPERATION_READ_UNAVAILABLE', status: 503 })
  assert.throws(() => admin.view(bot), { code: 'CONFIGURATION_OPERATION_READ_UNAVAILABLE', status: 503 })
  const secret = new Error('private record failure')
  row.records = { get() { throw secret } }
  assert.throws(() => admin.readConfigurationOperation(bot.id, idA), error => error.message === 'CONFIGURATION_OPERATION_READ_UNAVAILABLE' && error.cause === undefined)
  assert.equal(admin.automaticConfigurationOperations.get(bot.id), row)
})

test('stop failure keeps the original cause and closed optional snapshot; projection failure never replaces stop failure', async () => {
  const cause = new Error('original stop failure')
  const { admin, bot } = fixture({ interrupt: async () => { throw cause } })
  admin.automaticConfigurationOperations.set(bot.id, operation())
  await assert.rejects(admin.stop(bot), error => error.code === 'BOT_STOP_UNCONFIRMED' && error.cause === cause
    && error.automaticConfigurationApplication.requestId === idA && error.automaticConfigurationApplication.state === 'unknown')
  admin.automaticConfigurationOperations.set(bot.id, { records: null })
  await assert.rejects(admin.stop(bot), error => error.code === 'BOT_STOP_UNCONFIRMED' && error.cause === cause
    && !Object.hasOwn(error, 'automaticConfigurationApplication'))
})

test('existing stop success results keep their identity and meaning', async () => {
  for (const result of [{ botId: 'bot-a', status: 'stop_sent' }, { botId: 'bot-a', status: 'interrupted', sessionPreserved: true }]) {
    const { admin, bot } = fixture({ interrupt: async () => result })
    admin.automaticConfigurationOperations.set(bot.id, operation())
    assert.equal(await admin.stop(bot), result)
  }
})

test('the fixed facade reads snapshots after real engine handoff without a new native action', async t => {
  const root = await mkdtemp(join(tmpdir(), 'automatic-configuration-'))
  const { bot, bots } = fixture(), calls = [], engines = []
  const ports = { bots, rooms: {}, membersAdmission: new MembersAdmission(),
    configurationStorage: { root: join(root, 'intents'), ownerUid: process.getuid() }, access: { assertWorkAllowed() {} },
    observer: { report() {} }, native: { async call(name) { calls.push(name); assert.equal(name, 'pty_list'); return {} } } }
  t.after(async () => {
    for (const engine of engines.reverse()) {
      try { await engine.control('quiesce', { timeoutMs: 100 }) } catch {}
      try { await engine.disconnect() } catch {}
    }
    await rm(root, { recursive: true, force: true })
  })
  const first = createExecutionDispatcher({ generation: 'first', ports }); engines.push(first)
  await first.control('initialize'); await first.control('quiesce', { timeoutMs: 100 })
  const handoff = first.exportState(); await first.disconnect()
  handoff.metadata.automaticConfigurationOperations.set(bot.id, operation())
  const second = createExecutionDispatcher({ generation: 'second', ports, handoff }); engines.push(second)
  await second.control('initialize')
  const controller = { dispatch: second.dispatch, project: second.project, close: () => second.disconnect() }
  const facade = createExecutionFacade({ getController: () => controller, client: ports.native, membersAdmission: ports.membersAdmission,
    requestStop() {}, watchQueue() { return () => {} } })
  assert.ok(EXECUTION_METHODS.dispatch.includes('administration.readConfigurationOperation'))
  const before = calls.length
  assert.deepEqual(await facade.administration.readConfigurationOperation(bot.id, idA), snapshot())
  assert.deepEqual(facade.administration.view(bot).automaticConfigurationApplication, snapshot())
  assert.equal(calls.length, before)
  await second.control('quiesce', { timeoutMs: 100 })
  assert.deepEqual(second.exportState().metadata.automaticConfigurationOperations.get(bot.id).records.get(idA), snapshot())
})
