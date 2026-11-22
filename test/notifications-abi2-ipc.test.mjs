import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createNotificationsParentChannel } from '../src/notifications-ipc.mjs'

// a487n stage 2: Web push is gone; the provider is apns (and fcm). The readers still accept a ready from a rolled-back module that reports webPush.
const apns = { configured: false, environments: [] }
const legacyWebPush = { enabled: false, configured: false, publicKey: null, error: null }
const statuses = () => ({ apns: structuredClone(apns) })
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

test('ABI2 correlates method/provider form and captures params before caller mutation', async () => {
  const f = fixture()
  const params = { provider: 'apns' }, request = f.channel.request('status', params)
  params.provider = 'fcm'; f.reply(apns)
  assert.deepEqual(await request, apns)
  f.channel.dispose()
})

test('a result of the wrong provider shape is protocol failure/unknown, and the removed webPush provider is refused before it is sent', async () => {
  const f = fixture(), request = f.channel.request('status', { provider: 'apns' })
  f.reply({ registered: true })
  await assert.rejects(request, { code: 'PUSH_IPC_DISCONNECTED', outcome: 'unknown' })
  assert.equal(f.child.connected, false)
  const g = fixture()
  await assert.rejects(g.channel.request('status', { provider: 'webPush' }), { outcome: 'not_accepted' })
  await assert.rejects(g.channel.request('status', {}), { outcome: 'not_accepted' })
  assert.equal(g.sent.length, 0)
  g.channel.dispose()
})

test('ABI2 ready needs the apns status/applyError, reads webPush only as an optional legacy pair, and rejects legacy ABI1', async () => {
  const good = fixture()
  good.child.emit('message', { type: 'ready', versionId: null, protocolVersion: 2, stateSchema: 2,
    status: statuses(), applyError: { apns: 'PUSH_CONFIGURATION_FAILED' } })
  assert.equal((await good.channel.ready).applyError.apns, 'PUSH_CONFIGURATION_FAILED')
  good.channel.dispose()
  const legacy = fixture()
  legacy.child.emit('message', { type: 'ready', versionId: null, protocolVersion: 2, stateSchema: 2,
    status: { ...statuses(), webPush: legacyWebPush }, applyError: { apns: null, webPush: 'WEB_PUSH_KEY_INVALID' } })
  assert.equal((await legacy.channel.ready).applyError.webPush, 'WEB_PUSH_KEY_INVALID')
  legacy.channel.dispose()
  for (const partial of [{ protocolVersion: 1, stateSchema: 1 }, { applyError: null }, { status: apns }]) {
    const f = fixture()
    f.child.emit('message', { type: 'ready', versionId: null, protocolVersion: 2, stateSchema: 2,
      status: statuses(), applyError: { apns: null }, ...partial })
    await assert.rejects(f.channel.ready, { code: 'PUSH_IPC_DISCONNECTED' })
  }
})

test('private initialize shape is exact (apns, with an optional legacy webPush pair) and transport errors keep a finite HTTP status without free text', async () => {
  const f = fixture()
  await assert.rejects(f.channel.control('initialize', { configuration: { enabled: false, relayUrl: '' } }))
  await assert.rejects(f.channel.control('initialize', { configuration: { apns: { enabled: false, relayUrl: '' },
    webPush: { provider: 'webPush', enabled: false, subject: '' } } }))
  assert.equal(f.sent.length, 0)
  const request = f.channel.request('unregister', { provider: 'apns', token: 'a'.repeat(64), environment: 'production', server: 'https://bellteam.example' })
  f.reply(null, { code: 'PUSH_DEVICE_INVALID', outcome: 'unknown', status: 409 })
  await assert.rejects(request, { code: 'PUSH_DEVICE_INVALID', outcome: 'unknown', status: 409 })
  f.channel.dispose()
})
