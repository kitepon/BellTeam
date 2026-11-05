import test from 'node:test'
import assert from 'node:assert/strict'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'

for (const reason of ['native outcome unknown', 'retired conversation']) {
  test(`occupation refusal records failure and preserves ${reason}`, async t => {
    const gate = new ConversationLifetimes('current'), operation = gate.enter()
    const bot = { id: 'bot-preflight', session: 'bot-preflight' }, statuses = []
    const delivery = gate.registerDelivery(operation, {
      deliveryId: 'new-delivery', target: bot.id, kinds: ['delivery.status'],
      dispatch: async (kind, params) => { statuses.push({ kind, ...params }); return { applied: true } },
    })
    let nativeCalls = 0, summaryInvalidations = 0
    const transport = new AitermTransport({ conversationAdmission: gate,
      backgroundSummary: { invalidate(_botId, inputRevision) { if (inputRevision === undefined) summaryInvalidations++ } },
      client: { async call() { nativeCalls++; assert.fail('refused input reached native') }, async close() {} } })
    transport.latestSummaryInputs.set(bot.id, 'original-input')
    const occupied = { id: 'original-job', bot, startedAt: '2026-11-06T00:00:00.000Z',
      conversationGeneration: reason === 'retired conversation' ? 'retired' : 'current',
      ...(reason === 'native outcome unknown' ? { nativeUnconfirmed: Error('original unknown') } : {}),
      info: {}, completion: Promise.resolve(),
    }
    transport.activity.register(occupied); transport.activity.admit(occupied)
    t.after(async () => {
      transport.activity.release(occupied)
      gate.finishUnclaimedDelivery(delivery); gate.finish(operation)
      await transport.close()
    })

    await assert.rejects(transport.notify(bot, 'new input', {
      queue: { groupId: 'new-delivery' }, conversationDelivery: delivery,
    }), { code: 'CONVERSATION_NOT_ACCEPTED' })
    await Promise.allSettled([...transport.activity.jobs].filter(job => job !== occupied).map(job => job.completion))

    assert.deepEqual(statuses.map(value => [value.kind, value.delivery]), [['delivery.status', 'failed']])
    assert.equal(statuses[0].error.code, 'CONVERSATION_NOT_ACCEPTED')
    assert.equal(nativeCalls, 0)
    assert.equal(summaryInvalidations, 0)
    assert.equal(transport.latestSummaryInputs.get(bot.id), 'original-input')
    assert.deepEqual([...transport.activity.jobs], [occupied])
    assert.deepEqual(transport.activity.of(bot.id), [occupied])
  })
}
