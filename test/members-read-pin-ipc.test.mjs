import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { MembersAdmission } from '../src/members-admission.mjs'
import { createMembersParentChannel } from '../src/members-ipc.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(t, options = {}) {
  const endpoint = new EventEmitter(), sent = [], gate = new MembersAdmission('fixture')
  endpoint.connected = true
  endpoint.send = (message, callback) => { sent.push(message); callback() }
  endpoint.disconnect = () => { endpoint.connected = false; endpoint.emit('disconnect') }
  const channel = createMembersParentChannel(endpoint, { generation: 'fixture', admission: gate, ...options })
  t.after(() => channel.reaped())
  const accepted = message => endpoint.emit('message', { type: 'accepted', kind: message.kind, id: message.id })
  const result = (message, value) => endpoint.emit('message', { type: 'result', kind: message.kind, id: message.id, ok: true, value })
  return { endpoint, sent, gate, channel, accepted, result }
}

test('read pin gets a real channel completion while all eight AI leases stay active', async t => {
  const f = fixture(t), leases = Array.from({ length: 8 }, () => f.gate.enter())
  const pin = f.gate.enterReadPin('profiles.read')
  const request = f.channel.request('profiles.read', {}, { membersReadPin: pin })
  const message = f.sent[0]
  assert.equal(f.channel.snapshot().root, 1)
  assert.deepEqual(Object.keys(message.context).sort(), ['continuation', 'generation', 'leaseId', 'ownerWrite', 'rootId'])
  assert.equal(message.context.ownerWrite, false)
  f.gate.finishReadPin(pin); f.gate.assertReadPin(pin)
  f.accepted(message); f.result(message, { revision: 1 }); await request.completion
  await tick()
  assert.throws(() => f.gate.assertReadPin(pin), { code: 'MEMBERS_NOT_ACCEPTED' })
  leases.forEach(lease => { f.gate.assertLease(lease); f.gate.finish(lease) })
})

test('read pins keep the existing shared IPC root limit at eight', async t => {
  const f = fixture(t), pins = Array.from({ length: 9 }, () => f.gate.enterReadPin('profiles.read'))
  const requests = pins.slice(0, 8).map(pin => f.channel.request('profiles.read', {}, { membersReadPin: pin }))
  await assert.rejects(f.channel.request('profiles.read', {}, { membersReadPin: pins[8] }), { code: 'MEMBERS_IPC_CAPACITY' })
  assert.equal(f.sent.length, 8)
  for (const message of f.sent) { f.accepted(message); f.result(message, { revision: 1 }) }
  await Promise.all(requests)
  pins.forEach(pin => f.gate.finishReadPin(pin))
})

test('pin cannot become a mutation, another read, a callback, an AI lease or a reconstructed pin', async t => {
  const f = fixture(t), pin = f.gate.enterReadPin('profiles.read'), lease = f.gate.enter()
  for (const [method, options, callback] of [
    ['profile.update', { membersReadPin: pin }], ['owner.read', { membersReadPin: pin }],
    ['profiles.read', { membersReadPin: { ...pin } }], ['profiles.read', { membersReadPin: lease }],
    ['profiles.read', { membersReadPin: pin, membersLease: lease }],
    ['profiles.read', { membersLease: pin }], ['profiles.cli', { membersReadPin: pin }, true],
  ]) await assert.rejects(f.channel[callback ? 'callback' : 'request'](method, {}, options), { code: 'MEMBERS_NOT_ACCEPTED' })
  assert.equal(f.sent.length, 0)
  f.gate.finishReadPin(pin); f.gate.finish(lease)
})

test('deadline and closure preserve the original pin until actual response, with no new pin admission', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(t), pin = f.gate.enterReadPin('profiles.read')
  const request = f.channel.request('profiles.read', {}, { membersReadPin: pin })
  const rejection = assert.rejects(request, { code: 'MEMBERS_IPC_ACK_TIMEOUT' })
  const message = f.sent[0], ticket = f.gate.close()
  f.gate.finishReadPin(pin)
  assert.throws(() => f.gate.enterReadPin('profiles.read'), { code: 'MEMBERS_NOT_ACCEPTED' })
  let drained = false
  const drain = f.gate.drain(ticket).then(() => { drained = true })
  t.mock.timers.tick(5001); await rejection
  f.gate.assertReadPin(pin); assert.equal(drained, false)
  f.accepted(message); f.result(message, { revision: 1 }); await request.completion; await drain
  assert.throws(() => f.gate.assertReadPin(pin), { code: 'MEMBERS_NOT_ACCEPTED' })
})

test('a live method-bound pin may continue after closure with the original wire epoch', async t => {
  const f = fixture(t), pin = f.gate.enterReadPin('profiles.read'), ticket = f.gate.close()
  const request = f.channel.request('profiles.read', {}, { membersReadPin: pin })
  const message = f.sent[0]
  assert.equal(message.context.continuation, true)
  f.accepted(message); f.result(message, { revision: 1 }); await request
  f.gate.finishReadPin(pin); await f.gate.drain(ticket)
})

test('only the matching room read effect is admitted and its actual completion keeps the pin alive', async t => {
  let release, entered, captured
  const waiting = new Promise(resolve => { entered = resolve }), held = new Promise(resolve => { release = resolve })
  const f = fixture(t, { onEffect: async (method, params, context) => { captured = context; entered(); await held; return [] } })
  const pin = f.gate.enterReadPin('schedules.list')
  const params = { ownerKind: 'room', ownerId: 'room-fixture' }
  const request = f.channel.request('schedules.list', params, { membersReadPin: pin })
  const message = f.sent[0]; f.accepted(message)
  params.ownerId = 'changed-after-send'
  f.endpoint.emit('message', { type: 'call', kind: 'effect', id: 1, method: 'room.schedules.list',
    params: { roomId: 'room-fixture' }, context: message.context })
  await waiting
  assert.equal(captured.membersReadPin, pin)
  assert.equal(Object.hasOwn(captured, 'membersLease'), false)
  f.gate.finishReadPin(pin)
  f.result(message, { schedules: [] }); await request.completion; await tick()
  f.gate.assertReadPin(pin)
  const ticket = f.gate.close(); let drained = false
  const drain = f.gate.drain(ticket).then(() => { drained = true })
  await tick(); assert.equal(drained, false)
  release(); await drain
})

test('readonly effects reject mutation and a different room before calling the parent adapter', async t => {
  let calls = 0
  const f = fixture(t, { onEffect: () => { calls++; return [] } })
  const pin = f.gate.enterReadPin('schedules.list')
  const request = f.channel.request('schedules.list', { ownerKind: 'room', ownerId: 'room-fixture' }, { membersReadPin: pin })
  const message = f.sent[0]; f.accepted(message)
  for (const [id, method, params] of [[1, 'room.schedules.list', { roomId: 'other-room' }], [2, 'room.schedules.set', {}]])
    f.endpoint.emit('message', { type: 'call', kind: 'effect', id, method, params, context: message.context })
  await tick()
  assert.equal(calls, 0)
  assert.equal(f.sent.filter(m => m.type === 'result' && !m.ok && m.error.code === 'MEMBERS_NOT_ACCEPTED').length, 2)
  f.result(message, { schedules: [] }); await request; f.gate.finishReadPin(pin)
})

test('only profiles.read pins may send a projection on their pending operation', async t => {
  let calls = 0
  const f = fixture(t, { onProjection: () => { calls++ } })
  const profiles = f.gate.enterReadPin('profiles.read'), rules = f.gate.enterReadPin('rules.read')
  const readProfiles = f.channel.request('profiles.read', {}, { membersReadPin: profiles }), profilesMessage = f.sent.at(-1)
  const readRules = f.channel.request('rules.read', {}, { membersReadPin: rules }), rulesMessage = f.sent.at(-1)
  f.accepted(profilesMessage); f.accepted(rulesMessage)
  f.endpoint.emit('message', { type: 'call', kind: 'projection', id: 1, method: 'projection', params: { type: 'snapshot-start', revision: 1 }, context: rulesMessage.context })
  f.endpoint.emit('message', { type: 'call', kind: 'projection', id: 2, method: 'projection', params: { type: 'snapshot-start', revision: 1 }, context: profilesMessage.context })
  await tick(); assert.equal(calls, 1)
  f.result(profilesMessage, { revision: 1 }); f.result(rulesMessage, { text: '' })
  await Promise.all([readProfiles, readRules]); f.gate.finishReadPin(profiles); f.gate.finishReadPin(rules)
})
