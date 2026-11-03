import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createNotificationsParentChannel } from '../src/notifications-ipc.mjs'

const apns = { configured: false, environments: [] }
const webPush = { enabled: false, configured: false, publicKey: null, error: null }
const statuses = () => ({ apns: structuredClone(apns), webPush: structuredClone(webPush) })
const origin = 'https://owner.example', endpoint = 'https://fcm.googleapis.com/opaque'
function fixture() {
  const child = new EventEmitter(), sent = []
  child.connected = true
  child.send = (message, callback) => { sent.push(message); callback?.(); return true }
  child.disconnect = () => { child.connected = false; child.emit('disconnect') }
  const channel = createNotificationsParentChannel(child)
  const reply = (value, error) => {
    const request = sent.at(-1)
    child.emit('message', { type: 'accepted', id: request.id })
    child.emit('message', error ? { type: 'result', id: request.id, ok: false, error }
      : { type: 'result', id: request.id, ok: true, value })
  }
  return { child, channel, sent, reply }
}

test('ABI2 correlates method/provider/endpoint form and captures params before caller mutation', async () => {
  const f = fixture()
  const params = { provider: 'webPush' }, request = f.channel.request('status', params)
  params.provider = 'apns'; f.reply(webPush)
  assert.deepEqual(await request, webPush)
  const lookup = f.channel.request('status', { provider: 'webPush', origin, endpoint })
  f.reply({ registered: false }); assert.deepEqual(await lookup, { registered: false })
  const apple = f.channel.request('status', { provider: 'apns' })
  f.reply(apns); assert.deepEqual(await apple, apns)
  f.channel.dispose()
})

test('wrong provider result or public-versus-registration shape is protocol failure/unknown', async () => {
  for (const [params, result] of [[{ provider: 'webPush' }, apns], [{ provider: 'apns' }, webPush],
    [{ provider: 'webPush', origin, endpoint }, webPush], [{ provider: 'webPush' }, { registered: true }]]) {
    const f = fixture(), request = f.channel.request('status', params)
    f.reply(result)
    await assert.rejects(request, { code: 'PUSH_IPC_DISCONNECTED', outcome: 'unknown' })
    assert.equal(f.child.connected, false)
  }
})

test('origin is required only for private Web registration requests, canonical and never inserted from endpoint', async () => {
  const f = fixture()
  for (const params of [{ provider: 'webPush', endpoint }, { provider: 'webPush', origin: origin + '/', endpoint },
    { provider: 'webPush', origin: 'http://owner.example', endpoint }, { provider: 'webPush', origin }])
    await assert.rejects(f.channel.request('status', params), { code: 'WEB_PUSH_INPUT_INVALID', status: 400, outcome: 'not_accepted' })
  await assert.rejects(f.channel.request('status', {}), { outcome: 'not_accepted' })
  assert.equal(f.sent.length, 0)
  const configure = f.channel.request('configure', { provider: 'webPush', enabled: false, subject: '' })
  f.reply(webPush); await configure
  assert.equal(Object.hasOwn(f.sent.at(-1).params, 'origin'), false)
  f.channel.dispose()
})

test('ABI2 ready requires both provider status/applyError and rejects legacy ABI1', async () => {
  const good = fixture()
  good.child.emit('message', { type: 'ready', versionId: null, protocolVersion: 2, stateSchema: 2,
    status: statuses(), applyError: { apns: null, webPush: 'WEB_PUSH_KEY_INVALID' } })
  assert.equal((await good.channel.ready).applyError.webPush, 'WEB_PUSH_KEY_INVALID')
  good.channel.dispose()
  for (const partial of [{ protocolVersion: 1, stateSchema: 1 }, { applyError: null }, { status: apns }]) {
    const f = fixture()
    f.child.emit('message', { type: 'ready', versionId: null, protocolVersion: 2, stateSchema: 2,
      status: statuses(), applyError: { apns: null, webPush: null }, ...partial })
    await assert.rejects(f.channel.ready, { code: 'PUSH_IPC_DISCONNECTED' })
  }
})

test('private initialize shape is exact and transport errors preserve finite HTTP status without free text', async () => {
  const f = fixture()
  await assert.rejects(f.channel.control('initialize', { configuration: { enabled: false, relayUrl: '' } }))
  await assert.rejects(f.channel.control('initialize', { configuration: { apns: { enabled: false, relayUrl: '' },
    webPush: { provider: 'webPush', enabled: false, subject: '' } } }))
  assert.equal(f.sent.length, 0)
  const request = f.channel.request('unregister', { provider: 'webPush', origin, endpoint })
  f.reply(null, { code: 'WEB_PUSH_REGISTRATION_CONFLICT', outcome: 'unknown', status: 409 })
  await assert.rejects(request, { code: 'WEB_PUSH_REGISTRATION_CONFLICT', outcome: 'unknown', status: 409 })
  f.channel.dispose()
})
