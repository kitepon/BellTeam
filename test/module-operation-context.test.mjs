import { MODULE_CONCURRENCY } from '../src/module-ipc.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'
import { createModuleOperationContext } from '../src/module-operation-context.mjs'
import { createModuleExchangeMutex } from '../src/module-exchange-mutex.mjs'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const setup = () => {
  const membersAdmission = new MembersAdmission('members')
  const conversationAdmission = new ConversationLifetimes('conversation')
  return { membersAdmission, conversationAdmission, ...createModuleOperationContext({ membersAdmission, conversationAdmission }) }
}

test('a closed or full peer rejects before work and releases the first reservation without waiting', async () => {
  const gate = setup()
  const closed = gate.conversationAdmission.close()
  let effects = 0
  assert.throws(() => gate.withContext(() => { effects++ }), { code: 'CONVERSATION_NOT_ACCEPTED' })
  const ticket = gate.membersAdmission.close()
  await gate.membersAdmission.drain(ticket)
  assert.equal(effects, 0)
  gate.membersAdmission.resume(ticket)
  gate.conversationAdmission.resume(closed)
  const leases = Array.from({ length: MODULE_CONCURRENCY }, () => gate.membersAdmission.enter())
  assert.throws(() => gate.reserve(), { code: 'MEMBERS_NOT_ACCEPTED' })
  assert.equal(gate.conversationAdmission.snapshot().active, 0)
  for (const lease of leases) gate.membersAdmission.finish(lease)
  const second = gate.membersAdmission.close()
  await gate.membersAdmission.drain(second)
})

test('only the original opaque context continues through closure and nested calls never enter or finish again', async () => {
  const gate = setup(), context = gate.reserve()
  gate.membersAdmission.close(); gate.conversationAdmission.close()
  assert.throws(() => gate.assert({ ...context }), { code: 'MODULE_OPERATION_NOT_ACCEPTED' })
  assert.throws(() => gate.assert(JSON.parse(JSON.stringify(context))), { code: 'MODULE_OPERATION_NOT_ACCEPTED' })
  await gate.withContext(async same => {
    assert.equal(same, context)
    assert.equal(await gate.withContext(value => value, same), context)
  }, context)
  gate.assert(context)
  gate.finish(context)
  assert.throws(() => gate.assert(context))
})

test('finish requests preserve the actual pending completion after caller unknown and require both drains', async () => {
  const gate = setup(), context = gate.reserve(), completion = deferred()
  gate.membersAdmission.trackCompletion(context.membersLease, completion.promise)
  gate.conversationAdmission.trackCompletion(context.conversationLease, completion.promise)
  const m = gate.membersAdmission.close(), c = gate.conversationAdmission.close()
  gate.finish(context)
  gate.assert(context)
  let drained = false
  const drain = Promise.all([gate.membersAdmission.drain(m), gate.conversationAdmission.drain(c)]).then(() => { drained = true })
  await Promise.resolve(); assert.equal(drained, false)
  completion.resolve(); await drain
  assert.throws(() => gate.assert(context))
})

test('an operation failure releases its owned reservation and is not retried', async () => {
  const gate = setup(), failure = new Error('fixed failure')
  let calls = 0
  await assert.rejects(gate.withContext(async () => { calls++; throw failure }), error => error === failure)
  await gate.membersAdmission.drain(gate.membersAdmission.close())
  await gate.conversationAdmission.drain(gate.conversationAdmission.close())
  assert.equal(calls, 1)
})

test('one exchange mutex rejects concurrent replacements without queueing and releases on either outcome', async () => {
  const mutex = createModuleExchangeMutex(), done = deferred()
  const first = mutex.runExclusive(() => done.promise)
  let second = 0
  await assert.rejects(mutex.runExclusive(() => { second++ }), { code: 'MODULE_EXCHANGE_BUSY', status: 409, outcome: 'not_accepted' })
  assert.equal(second, 0)
  done.resolve('members'); assert.equal(await first, 'members')
  await assert.rejects(mutex.runExclusive(() => { throw new Error('failed') }), /failed/)
  assert.equal(await mutex.runExclusive(() => 'conversation'), 'conversation')
})


test('accepted paired preparation releases members while a real conversation delivery still owns its late callback', async () => {
  const gate = setup(), context = gate.reserve()
  const delivery = gate.conversationAdmission.registerDelivery(context.conversationLease, {
    deliveryId: 'delivery-one', target: 'bot-one', kinds: ['delivery.answer'], dispatch: async () => ({ applied: true }),
  })
  gate.finish(context)
  const members = gate.membersAdmission.close(), conversation = gate.conversationAdmission.close()
  await gate.membersAdmission.drain(members)
  assert.deepEqual(await gate.conversationAdmission.drain(conversation, { timeoutMs: 0 }), { status: 'busy' })
  assert.deepEqual(await gate.conversationAdmission.invoke(delivery, 'delivery.answer', { text: 'finite fixture' }), { applied: true })
  gate.conversationAdmission.finish(delivery)
  assert.deepEqual(await gate.conversationAdmission.drain(conversation), { status: 'drained' })
})
