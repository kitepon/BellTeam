import assert from 'node:assert/strict'
import test from 'node:test'

import { callConversationTool, conversationTools } from '../src/mcp-conversation-tools.mjs'
import { directEnvelope } from '../src/messenger.mjs'
import { createSendGate, OWNER_CHECK_CODE, OWNER_SKILL, RECEIVER_LINE } from '../src/conversation/send-gate.mjs'

const registry = new Map([
  ['bot-a', { id: 'bot-a', name: 'A' }],
  ['bot-b', { id: 'bot-b', name: 'B', position: '開発', role: '開発担当' }],
  ['bot-c', { id: 'bot-c', name: 'C' }],
])
const setup = ({ failOnce = false } = {}) => {
  const sent = []
  let fail = failOnce
  const context = { registry, from: 'bot-a', sendGate: createSendGate(),
    deliverMessage: async value => { if (fail) { fail = false; throw new Error('BOT_STOPPED') } sent.push(value); return { delivery: 'running' } } }
  const send = target => callConversationTool({ ...context, name: 'sendmessage', args: { target, message: 'm' } })
  return { sent, send }
}

test('first sendmessage to a Bot is refused and stores nothing, the next one for the same pair is delivered once', async () => {
  const { sent, send } = setup()
  await assert.rejects(send('B'), error => error.code === OWNER_CHECK_CODE && error.message.includes(OWNER_SKILL) && error.message.includes('「B」（開発 / 開発担当、bot-b）'))
  assert.equal(sent.length, 0)
  assert.deepEqual(await send('bot-b'), { delivery: 'running' })
  assert.equal(sent.length, 1)
  await assert.rejects(send('bot-b'), { code: OWNER_CHECK_CODE }, 'a pass is for one message')
})

test('each target is judged on its own, and user and unknown targets are not gated', async () => {
  const { sent, send } = setup()
  await assert.rejects(send('bot-b'), { code: OWNER_CHECK_CODE })
  await assert.rejects(send('bot-c'), { code: OWNER_CHECK_CODE })
  await send('bot-c')
  assert.deepEqual(sent.map(value => value.target), ['bot-c'])
  await send('user')
  assert.equal(sent.at(-1).target, 'user')
  await assert.rejects(send('missing'), /BOT_NOT_FOUND/u)
})

test('a delivery that fails after the pass keeps the pass for the retry', async () => {
  const { sent, send } = setup({ failOnce: true })
  await assert.rejects(send('bot-b'), { code: OWNER_CHECK_CODE })
  await assert.rejects(send('bot-b'), /BOT_STOPPED/u)
  await send('bot-b')
  assert.equal(sent.length, 1)
})

test('the receiver line goes into a Bot request, not into the Owner, scheduler or fork answer envelope', () => {
  const bot = { id: 'bot-a', name: 'A', position: '', role: '' }
  assert.equal(directEnvelope(bot, '本文'), `「A」からあなたへ次のメッセージが届いています。\n\n${RECEIVER_LINE}\n\n本文`)
  assert.equal(directEnvelope(bot, '本文', { fork: true }).includes(RECEIVER_LINE), true)
  for (const id of ['user', 'scheduler']) assert.doesNotMatch(directEnvelope({ id, name: id }, '本文'), /assign-owner/u)
  assert.doesNotMatch(directEnvelope(bot, '本文', { answer: true }), /assign-owner/u)
  assert.ok(RECEIVER_LINE.includes(OWNER_SKILL))
  assert.match(conversationTools.find(tool => tool.name === 'sendmessage').description, /assign-owner/u)
})
