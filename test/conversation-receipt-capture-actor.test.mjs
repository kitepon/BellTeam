import test from 'node:test'
import assert from 'node:assert/strict'
import { createConversationAssembly } from '../src/conversation-assembly.mjs'
import { createModuleExchangeMutex } from '../src/module-exchange-mutex.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'

test('captureReceipt hands the authenticated actor, never the body sender, to the optional callback', () => {
  const conversation = createConversationAssembly({ root: '/synthetic', membersAdmission: new MembersAdmission(),
    exchangeMutex: createModuleExchangeMutex(), createProcess: () => ({}), createFacade: () => ({ assets: {} }),
    getServices: () => ({ bots: { readRemovalStates: async () => ({ removals: [] }) } }) })
  const seen = []
  const owner = { kind: 'owner' }, bot = { kind: 'bot', botId: 'bot-a' }
  const source = { kind: 'registered' }
  assert.equal(conversation.run(owner, () => conversation.captureReceipt('user.post',
    { target: 'bot-b', message: 'hi', from: 'bot-a' }, actor => seen.push(actor)), { executionSource: source }), source)
  conversation.run(bot, () => conversation.captureReceipt('direct.post', { from: 'bot-a', target: 'bot-b', message: 'hi' }, actor => seen.push(actor)))
  assert.deepEqual(seen, [owner, bot])
  assert.notEqual(seen[1], bot)
  assert.throws(() => conversation.run(bot, () => conversation.captureReceipt('direct.post',
    { from: 'bot-c', target: 'bot-b', message: 'hi' }, actor => seen.push(actor))), { code: 'CONVERSATION_SENDER_FORBIDDEN' })
  assert.equal(seen.length, 2)
  assert.equal(conversation.run(owner, () => conversation.captureReceipt('user.post', { target: 'bot-b', message: 'hi' })), undefined)
})
