import test from 'node:test'
import assert from 'node:assert/strict'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'

for (const reason of ['native outcome unknown', 'retired conversation']) {
  for (const caller of ['Owner', 'peer', 'conversation']) test(`${caller} new input preserves ${reason} without refusal or replay`, async t => {
    const gate = new ConversationLifetimes('current'), operation = gate.enter()
    const bot = { id: 'bot-quincy-fixture', session: 'quincy-fixture' }, statuses = [], sends = []
    const delivery = caller === 'conversation' ? gate.registerDelivery(operation, {
      deliveryId: 'new-delivery', target: bot.id, kinds: ['delivery.status'],
      dispatch: async (kind, params) => { statuses.push({ kind, ...params }); return { applied: true } },
    }) : null
    const transport = new AitermTransport({ conversationAdmission: gate, handoffContext: async () => '',
      waitProcess: async () => ({ outcome: 'done', turn_id: 'fresh-turn' }),
      client: { async call(name, args) {
        if (name === 'pty_send') { sends.push(args); return { structuredContent: { mode: 'agent_dispatch', event_cursor: 1, wait_process: { executable: 'fixture', args: [] } } } }
        if (name === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', turn_id: 'fresh-turn', text: 'fresh answer' } }
        if (name === 'pty_observe') return {}
        assert.fail('unexpected native ' + name)
      }, async close() {} } })
    const occupied = { id: 'original-job', bot, startedAt: '2026-11-06T00:00:00.000Z',
      conversationGeneration: reason === 'retired conversation' ? 'retired' : 'current',
      ...(reason === 'native outcome unknown' ? { nativeUnconfirmed: Error('original unknown') } : {}),
      info: { message: 'old unknown body' }, completion: Promise.resolve(),
    }
    transport.activity.register(occupied); transport.activity.admit(occupied)
    const original = { ...occupied }
    t.after(async () => {
      transport.activity.release(occupied)
      if (delivery) gate.finishUnclaimedDelivery(delivery)
      gate.finish(operation); await transport.close()
    })
    const options = { queue: { groupId: 'new-delivery' }, ...(delivery ? { conversationDelivery: delivery } : { onStatus: value => statuses.push(value) }) }
    if (caller === 'Owner') {
      const completion = transport.turn(bot, 'new Owner input', options)
      assert.deepEqual(await completion.accepted, { delivery: 'running' })
      assert.equal(await completion, 'fresh answer')
    } else {
      assert.deepEqual(await transport.notify(bot, 'new peer input', options), { delivery: 'running' })
      await Promise.all([...transport.activity.jobs].filter(job => job !== occupied).map(job => job.completion))
    }
    assert.equal(sends.length, 1)
    assert.equal(sends[0].session_id, 'quincy-fixture')
    assert.ok(!JSON.stringify(sends).includes('old unknown body'))
    assert.ok(statuses.length > 0)
    assert.deepEqual(occupied, original)
    assert.deepEqual(transport.activity.of(bot.id), [occupied])
  })
}
