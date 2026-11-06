import assert from 'node:assert/strict'
import test from 'node:test'
import { createUsageAssembly } from '../src/usage-assembly.mjs'
import { createConversationAssembly } from '../src/conversation-assembly.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'

test('usage candidate read keeps its captured authority and matching lease until actual completion', async () => {
  let options, finish
  const completion = new Promise(resolve => { finish = resolve })
  createUsageAssembly({ root: '/fixture', getServices: () => ({}), onEffect() {},
    createProcess: value => { options = value; return {} } })
  let captured
  const result = options.probeCandidate({ request(method, params, context) {
    assert.equal(method, 'onboarding.status'); assert.deepEqual(params, {})
    assert.deepEqual(options.authorizeActor(method, context.capturedAuthorization), { kind: 'system', botId: null })
    options.admission.assertLease(context.usageLease)
    captured = context
    const result = Promise.resolve({ complete: true }); result.completion = completion; return result
  } })
  await result
  assert.ok(options.authorizeActor('onboarding.status', captured.capturedAuthorization))
  options.admission.assertLease(captured.usageLease)
  finish(); await completion
  assert.throws(() => options.authorizeActor('onboarding.status', captured.capturedAuthorization))
})

test('conversation candidate read uses owner authority and current generation, releasing only after actual completion', async () => {
  let options, finish
  const completion = new Promise(resolve => { finish = resolve })
  createConversationAssembly({ root: '/fixture', membersAdmission: new MembersAdmission(), getServices: () => ({ bots: new Map() }),
    createProcess: value => { options = value; return {} } })
  let captured
  const result = options.probeCandidate({ request(method, params, context) {
    assert.equal(method, 'rooms.list'); assert.deepEqual(params, {})
    assert.deepEqual(options.authorizeActor(method, context.capturedAuthority), { kind: 'owner' })
    options.admission.assertCurrentLease(context.conversationLease)
    captured = context
    const result = Promise.resolve([]); result.completion = completion; return result
  } })
  await result
  assert.deepEqual(options.authorizeActor('rooms.list', captured.capturedAuthority), { kind: 'owner' })
  options.admission.assertCurrentLease(captured.conversationLease)
  finish(); await completion
  assert.equal(options.authorizeActor('rooms.list', captured.capturedAuthority), false)
})
