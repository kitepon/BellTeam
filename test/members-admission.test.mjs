import assert from 'node:assert/strict'
import test from 'node:test'
import { MembersAdmission } from '../src/members-admission.mjs'

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
  const gate = new MembersAdmission(), leases = Array.from({ length: 8 }, () => gate.enter())
  assert.throws(() => gate.enter(), { status: 503, outcome: 'not_accepted' })
  await gate.withLease(lease => gate.assertLease(lease), { lease: leases[0] })
  gate.assertLease(leases[0])
  leases.forEach(lease => gate.finish(lease))
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
