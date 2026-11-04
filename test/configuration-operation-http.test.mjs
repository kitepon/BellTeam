import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createBellTeamServer } from '../src/http-server.mjs'
import { BotAdministration } from '../src/bot-administration.mjs'
const id = '12345678-1234-1234-1234-123456789abc'
const dto = { schema: 'bellteam.automatic-configuration-application.v1', requestId: id, state: 'unknown', phase: 'configure', effect: 'possible', laterEffect: 'unknown', stopIntent: 'durable', admissionStopped: true, revocation: 'pending', errorCode: 'AUTOMATIC_CONFIGURATION_UNKNOWN' }
async function fixture(t, authorized = true) {
  let refreshes = 0, effects = 0
  const bots = new Map([['bot-a', { id: 'bot-a' }], ['bot-b', { id: 'bot-b' }]])
  bots.readMember = async key => bots.get(key); bots.refresh = async () => { refreshes++ }
  const administration = new BotAdministration({ bots, writeLog() {}, transport: { async interrupt() { effects++; throw Error('private-native-error') } } })
  administration.automaticConfigurationOperations.set('bot-a', { currentRequestId: id, records: new Map([[id, dto]]) })
  const server = createBellTeamServer({ bots, administration, store: {}, transport: {}, authorize: async () => authorized, writeLog() {} })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)))
  return { administration, effects: () => effects, refreshes: () => refreshes, request: (path, options) => fetch(`http://127.0.0.1:${server.address().port}${path}`, options) }
}
test('authenticated same-ID HTTP reads preserve unknown, target precedence and closed errors without native effects', async t => {
  const f = await fixture(t), path = `/api/bots/bot-a/configuration-operations/${id}`
  const read = await f.request(path); assert.equal(read.status, 200); assert.deepEqual(await read.json(), dto)
  for (const [requestPath, status, code] of [[`/api/bots/missing/configuration-operations/invalid`, 404, 'BOT_NOT_FOUND'], ['/api/bots/bot-a/configuration-operations/invalid', 400, 'CONFIGURATION_OPERATION_ID_INVALID'], [path + '?extra=1', 400, 'CONFIGURATION_OPERATION_ID_INVALID'], [`/api/bots/bot-b/configuration-operations/${id}`, 404, 'CONFIGURATION_OPERATION_NOT_RECORDED']]) {
    const result = await f.request(requestPath); assert.equal(result.status, status); assert.equal((await result.json()).error, code)
  }
  assert.equal(f.refreshes(), 0)
  assert.equal((await f.request(path, { method: 'POST' })).status, 405)
  f.administration.readConfigurationOperation = () => { throw Error('private native detail') }
  const unavailable = await f.request(path); assert.equal(unavailable.status, 503); assert.deepEqual(await unavailable.json(), { error: 'CONFIGURATION_OPERATION_READ_UNAVAILABLE' })
  assert.equal(f.effects(), 0)
  const denied = await fixture(t, false); assert.equal((await denied.request(path)).status, 401); assert.equal(denied.effects(), 0)
})
test('stop keeps the original 502 and only adds the execution-validated safe optional projection', async t => {
  const f = await fixture(t)
  const stopped = await f.request('/api/bots/bot-a/stop', { method: 'POST' }), value = await stopped.json()
  assert.equal(stopped.status, 502); assert.equal(value.error, 'BOT_STOP_UNCONFIRMED'); assert.deepEqual(value.automaticConfigurationApplication, dto); assert.equal(f.effects(), 1)
  f.administration.stop = async () => { throw Object.assign(Error('private'), { automaticConfigurationApplication: { ...dto, private: true } }) }
  const malformed = await f.request('/api/bots/bot-a/stop', { method: 'POST' })
  assert.equal(malformed.status, 502); assert.deepEqual(await malformed.json(), { error: 'BOT_STOP_UNCONFIRMED', message: value.message })
})
