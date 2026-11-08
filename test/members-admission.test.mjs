import { MODULE_CONCURRENCY } from '../src/module-ipc.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { MembersAdmission, MEMBERS_READ_PIN_METHODS } from '../src/members-admission.mjs'

test('caller unknown cannot release a lease with a registered real completion', async () => {
  const gate = new MembersAdmission('a')
  let complete, callbackComplete, lease
  const real = new Promise(resolve => { complete = resolve })
  await gate.withLease(value => { lease = value; gate.trackCompletion(value, real); return 'unknown' })
  const ticket = gate.close()
  let drained = false
  const wait = gate.drain(ticket).then(() => { drained = true })
  gate.assertLease(lease)
  const callback = new Promise(resolve => { callbackComplete = resolve })
  gate.trackCompletion(lease, callback)
  complete(); await Promise.resolve(); assert.equal(drained, false)
  gate.assertLease(lease)
  callbackComplete(); await wait
  assert.throws(() => gate.assertLease(lease), { code: 'MEMBERS_NOT_ACCEPTED' })
})

test('a rejected real completion is terminal, not a retry or an unhandled rejection', async () => {
  const gate = new MembersAdmission(), lease = gate.enter()
  let reject
  gate.trackCompletion(lease, new Promise((resolve, fail) => { reject = fail }))
  gate.finish(lease); gate.assertLease(lease)
  reject(Error('synthetic real terminal'))
  const ticket = gate.close(); await gate.drain(ticket)
  gate.adopt(ticket, 'b'); gate.resume(ticket)
})

test('a fresh root waits through an exchange and runs on the new generation', async () => {
  const gate = new MembersAdmission('a'), ticket = gate.close()
  const seen = []
  const read = gate.withReadPin('profiles.read', pin => seen.push(['read', pin.generation]))
  const write = gate.withLease(lease => seen.push(['write', lease.generation]))
  assert.throws(() => gate.enter(), { code: 'MEMBERS_NOT_ACCEPTED' })
  await gate.drain(ticket); gate.adopt(ticket, 'b')
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(seen, [])
  gate.resume(ticket); await Promise.all([read, write])
  assert.deepEqual(seen, [['read', 'b'], ['write', 'b']])
})

test('closed root rejects new work while old live lease callbacks drain', async () => {
  const gate = new MembersAdmission('a'), old = gate.capture(), lease = gate.enter(old, 'root-a')
  const ticket = gate.close()
  assert.throws(() => gate.enter(), { code: 'MEMBERS_NOT_ACCEPTED' })
  gate.assertLease(lease, { generation: 'a', correlation: 'root-a' })
  assert.throws(() => gate.assertLease({ ...lease }), { code: 'MEMBERS_NOT_ACCEPTED' })
  assert.throws(() => gate.assertLease(lease, { correlation: 'other' }), { code: 'MEMBERS_NOT_ACCEPTED' })
  let done = false
  const drained = gate.drain(ticket).then(() => { done = true })
  await Promise.resolve(); assert.equal(done, false)
  gate.finish(lease); await drained
  assert.throws(() => gate.assertLease(lease), { code: 'MEMBERS_NOT_ACCEPTED' })
  gate.adopt(ticket, 'b'); gate.resume(ticket)
  assert.throws(() => gate.enter(old), { code: 'MEMBERS_NOT_ACCEPTED' })
  const next = gate.enter(); assert.equal(next.generation, 'b'); gate.finish(next)
})

test('root capacity does not consume new credit for an existing lease', async () => {
  const gate = new MembersAdmission(), leases = Array.from({ length: MODULE_CONCURRENCY }, () => gate.enter())
  assert.throws(() => gate.enter(), { status: 503, outcome: 'not_accepted' })
  await gate.withLease(lease => gate.assertLease(lease), { lease: leases[0] })
  gate.assertLease(leases[0])
  const actual = Promise.withResolvers()
  gate.trackCompletion(leases[0], actual.promise); gate.finish(leases[0])
  assert.throws(() => gate.enter(), { code: 'MEMBERS_NOT_ACCEPTED' })
  actual.resolve(); await actual.promise; await Promise.resolve()
  const next = gate.enter(); gate.finish(next)
  leases.slice(1).forEach(lease => gate.finish(lease))
})

test('failed drain can resume old generation without invalidating live leases', async () => {
  const gate = new MembersAdmission('a'), lease = gate.enter(), ticket = gate.close()
  assert.throws(() => gate.adopt(ticket, 'b'), { code: 'MEMBERS_NOT_ACCEPTED' })
  gate.resume(ticket); gate.assertLease(lease)
  const second = gate.close()
  assert.throws(() => gate.resume(ticket), { code: 'MEMBERS_NOT_ACCEPTED' })
  gate.finish(lease); await gate.drain(second); gate.resume(second)
})

test('operation errors retain identity and release only owned leases', async () => {
  const gate = new MembersAdmission(), original = Error('synthetic')
  await assert.rejects(gate.withLease(async () => { throw original }), error => error === original)
  const ticket = gate.close(); await gate.drain(ticket); gate.resume(ticket)
  const lease = gate.enter()
  assert.throws(() => gate.withLease(() => { throw original }, { lease }), error => error === original)
  gate.assertLease(lease); gate.finish(lease)
})

test('read pins pass configured occupied AI leases without increasing the configured AI roots', async () => {
  const gate = new MembersAdmission(), leases = Array.from({ length: MODULE_CONCURRENCY }, () => gate.enter())
  for (const method of MEMBERS_READ_PIN_METHODS) await gate.withReadPin(method, pin => gate.assertReadPin(pin, { method }))
  assert.throws(() => gate.enter(), { code: 'MEMBERS_NOT_ACCEPTED' })
  leases.forEach(lease => gate.finish(lease))
})

test('read pin cannot become an AI root or another method, generation, correlation or copied pin', async () => {
  const gate = new MembersAdmission('a'), pin = gate.enterReadPin('profiles.read'), lease = gate.enter()
  for (const method of ['profile.update', 'profile.session', 'profiles.cli', 'unknown', 'profile.read'])
    assert.throws(() => gate.assertReadPin(pin, { method }), { code: 'MEMBERS_NOT_ACCEPTED' })
  assert.throws(() => gate.assertReadPin(pin, { generation: 'b' }), { code: 'MEMBERS_NOT_ACCEPTED' })
  assert.throws(() => gate.assertReadPin(pin, { correlation: 'different' }), { code: 'MEMBERS_NOT_ACCEPTED' })
  assert.throws(() => gate.assertReadPin({ ...pin }), { code: 'MEMBERS_NOT_ACCEPTED' })
  assert.throws(() => gate.assertReadPin(lease), { code: 'MEMBERS_NOT_ACCEPTED' })
  assert.throws(() => gate.assertLease(pin), { code: 'MEMBERS_NOT_ACCEPTED' })
  assert.throws(() => gate.withLease(() => {}, { lease: pin }), { code: 'MEMBERS_NOT_ACCEPTED' })
  assert.throws(() => gate.withReadPin('profiles.read', () => {}, { pin: lease }), { code: 'MEMBERS_NOT_ACCEPTED' })
  assert.throws(() => gate.enterReadPin('profile.update'), { code: 'MEMBERS_NOT_ACCEPTED' })
  gate.finish(lease); gate.finishReadPin(pin)
  assert.throws(() => gate.assertReadPin(pin), { code: 'MEMBERS_NOT_ACCEPTED' })
})

test('read timeout does not release actual completions and shared drain waits both domains', async () => {
  const gate = new MembersAdmission('a'), lease = gate.enter()
  let pin, finishRead, finishEffect
  const real = new Promise(resolve => { finishRead = resolve })
  await gate.withReadPin('profiles.read', value => { pin = value; gate.trackReadCompletion(pin, real); return 'caller unknown' })
  const ticket = gate.close()
  assert.throws(() => gate.enterReadPin('profiles.read'), { code: 'MEMBERS_NOT_ACCEPTED' })
  gate.assertReadPin(pin)
  assert.throws(() => gate.adopt(ticket, 'b'), { code: 'MEMBERS_NOT_ACCEPTED' })
  const callback = new Promise(resolve => { finishEffect = resolve })
  gate.trackReadCompletion(pin, callback)
  let drained = false
  const wait = gate.drain(ticket).then(() => { drained = true })
  finishRead(); await Promise.resolve(); assert.equal(drained, false)
  finishEffect(); await Promise.resolve(); assert.equal(drained, false)
  gate.finish(lease); await wait
  gate.adopt(ticket, 'b'); gate.resume(ticket)
  assert.throws(() => gate.assertReadPin(pin), { code: 'MEMBERS_NOT_ACCEPTED' })
})

test('read pin reuse releases only owned pins and rejects stale epoch after reopen', async () => {
  const gate = new MembersAdmission('a'), old = gate.capture(), pin = gate.enterReadPin('profile.read', old)
  await gate.withReadPin('profile.read', value => gate.assertReadPin(value), { pin })
  gate.assertReadPin(pin)
  const ticket = gate.close(); gate.resume(ticket)
  assert.throws(() => gate.enterReadPin('profile.read', old), { code: 'MEMBERS_NOT_ACCEPTED' })
  gate.assertReadPin(pin); gate.finishReadPin(pin)
  const next = gate.enterReadPin('profile.read'); gate.finishReadPin(next)
})

test('rejected read completion is terminal and original operation errors retain identity', async () => {
  const gate = new MembersAdmission(), original = Error('synthetic'), pin = gate.enterReadPin('profiles.read')
  gate.trackReadCompletion(pin, Promise.reject(original))
  gate.finishReadPin(pin)
  await assert.rejects(gate.withReadPin('profiles.read', async () => { throw original }), error => error === original)
  assert.throws(() => gate.withReadPin('profiles.read', () => { throw original }), error => error === original)
  const ticket = gate.close(); await gate.drain(ticket); gate.adopt(ticket, 'next'); gate.resume(ticket)
})

test('a members hold that timed out never runs its operation on a later resume', async t => {
  const { mock } = await import('node:test')
  const { MEMBERS_EXCHANGE_HOLD_MS } = await import('../src/members-admission.mjs')
  mock.timers.enable({ apis: ['setTimeout'] }); t.after(() => mock.timers.reset())
  const gate = new MembersAdmission('a'), ticket = gate.close()
  let runs = 0
  const held = gate.withLease(() => ++runs)
  mock.timers.tick(MEMBERS_EXCHANGE_HOLD_MS)
  await assert.rejects(held, { code: 'MEMBERS_NOT_ACCEPTED' })
  await gate.drain(ticket); gate.resume(ticket); await new Promise(resolve => setImmediate(resolve))
  assert.equal(runs, 0)
})
