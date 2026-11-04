import assert from 'node:assert/strict'
import test from 'node:test'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'
import { createModuleOperationContext } from '../src/module-operation-context.mjs'

test('retired paired context cannot start work or become a fresh root, but cleanup waits for real completion', async () => {
  const members = new MembersAdmission('members')
  const conversation = new ConversationLifetimes('old')
  const operations = createModuleOperationContext({ membersAdmission: members, conversationAdmission: conversation })
  const previous = operations.reserve()
  const native = Promise.withResolvers()
  conversation.trackCompletion(previous.conversationLease, native.promise)
  const terminal = conversation.operationCompletion(previous.conversationLease)
  const ticket = conversation.close()
  conversation.recoverFailedGeneration(ticket, 'old', 'new')
  conversation.resume(ticket)

  let effects = 0, ended = false
  terminal.then(() => { ended = true })
  assert.throws(() => operations.assert(previous), { code: 'CONVERSATION_PROTOCOL_UNCONFIRMED' })
  assert.throws(() => operations.withContext(() => { effects++ }, previous), { code: 'CONVERSATION_PROTOCOL_UNCONFIRMED' })
  // A known retired context must not become null and trigger memberRequest's reserve fallback.
  assert.throws(() => operations.forMembers(previous.membersLease), { code: 'CONVERSATION_PROTOCOL_UNCONFIRMED' })
  assert.equal(operations.forMembers(Object.freeze({})), null)
  assert.equal(effects, 0)
  assert.equal(conversation.assertLease(previous.conversationLease), previous.conversationLease)
  operations.finish(previous)
  await Promise.resolve()
  assert.equal(ended, false)
  await operations.withContext(() => { effects++ })
  assert.equal(effects, 1)
  assert.equal(ended, false)
  native.resolve()
  await terminal
  assert.equal(ended, true)
  assert.equal(conversation.snapshot().active, 0)
})
