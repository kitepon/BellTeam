import assert from 'node:assert/strict'
import test from 'node:test'
import { MembersAdmission } from '../src/members-admission.mjs'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'
import { createConversationExecutionEffects } from '../src/conversation-execution-effects.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(t) {
  const members = new MembersAdmission(), admission = new ConversationLifetimes('synthetic-report')
  const root = admission.enter(), oldMembers = members.enter(), background = Promise.withResolvers()
  const source = admission.registerDelivery(root, { deliveryId: 'source', target: 'bot-fixture', kinds: [], dispatch() {} })
  const work = admission.runBackground(source, () => background.promise)
  const delivery = admission.deriveReport(source, { deliveryId: 'report', reason: 'missing', kinds: [], dispatch() {} })
  const original = Object.freeze({ membersLease: oldMembers, conversationLease: root })
  members.finish(oldMembers)
  const context = { generation: 'synthetic-report', operationId: root.correlation, rootMethod: 'user.turn',
    operationContext: original, conversationLease: root, conversationDelivery: delivery,
    actualCompletion: Promise.resolve(), admissionCheck() {} }
  const bot = { id: 'bot-fixture' }, accepted = Promise.withResolvers()
  const state = { native: 0, fresh: 0, lease: null }
  const services = { aiControl: { assertEnabled() {} }, bots: {
    async readMember(id, context) { assert.equal(id, bot.id); state.fresh++; state.lease = context.membersLease; members.assertLease(state.lease) },
    get: () => bot,
  }, transport: { membersAdmission: members, notifyReport(target, message, options) {
    assert.equal(target, bot); assert.equal(message, 'fixed report')
    assert.equal(options.membersLease, state.lease); assert.notEqual(state.lease, oldMembers)
    for (const key of ['operationContext', 'conversationLease', 'conversationDelivery', 'actualCompletion', 'admissionCheck']) assert.equal(options[key], context[key])
    state.native++; return accepted.promise
  } } }
  const effect = createConversationExecutionEffects({ admission, getServices: () => services, getController: () => ({ callback() {} }) })
  const params = { deliveryId: 'report', target: bot.id, message: 'fixed report', images: [], queue: { groupId: 'report', context: 'report' } }
  t.after(async () => { accepted.resolve({ delivery: 'running' }); background.resolve(); await work; admission.finish(delivery); admission.finish(source); admission.finish(root) })
  return { members, admission, root, delivery, oldMembers, context, effect, params, services, accepted, state }
}

test('derived report rechecks fresh members under one short lease while original conversation identities survive acceptance', async t => {
  const f = fixture(t), result = f.effect('execution.report', f.params, f.context)
  await tick(); assert.equal(f.state.native, 1); f.members.assertLease(f.state.lease)
  f.accepted.resolve({ delivery: 'running' }); assert.deepEqual(await result, { delivery: 'running' })
  assert.throws(() => f.members.assertLease(f.state.lease), { code: 'MEMBERS_NOT_ACCEPTED' })
  f.admission.assertDelivery(f.delivery); f.admission.assertLease(f.context.conversationLease)
})

test('not-issued report adapter retains captured identity and releases only its fresh preparation lease', async t => {
  const f = fixture(t), unavailable = { report: 'unavailable', reason: 'not_issued' }
  const result = f.effect('execution.report', f.params, f.context)
  await tick(); assert.equal(f.state.native, 1)
  f.accepted.resolve(unavailable)
  assert.equal(await result, unavailable)
  f.admission.assertDelivery(f.delivery)
  assert.throws(() => f.members.assertLease(f.state.lease), { code: 'MEMBERS_NOT_ACCEPTED' })
})

test('closed members admission rejects the one derived preparation before fresh/native and never retries on resume', async t => {
  const f = fixture(t), ticket = f.members.close()
  await assert.rejects(f.effect('execution.report', f.params, f.context), { code: 'MEMBERS_NOT_ACCEPTED' })
  f.members.resume(ticket); await tick()
  assert.equal(f.state.fresh, 0); assert.equal(f.state.native, 0)
})

test('fresh await retains the captured stop check and releases its new preparation lease on refusal', async t => {
  const f = fixture(t); let allowed = true
  f.context.admissionCheck = () => { if (!allowed) throw Object.assign(Error('paused'), { code: 'AI_GLOBAL_PAUSED' }) }
  const read = f.services.bots.readMember
  f.services.bots.readMember = async (...args) => { await read(...args); allowed = false }
  await assert.rejects(f.effect('execution.report', f.params, f.context), { code: 'AI_GLOBAL_PAUSED' })
  assert.equal(f.state.native, 0)
  assert.throws(() => f.members.assertLease(f.state.lease), { code: 'MEMBERS_NOT_ACCEPTED' })
})
