import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { BellTeamMessenger } from '../src/messenger.mjs'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'

test('loaded421d backport keeps old unknown owner and permits one new Owner and peer input with normal callbacks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'loaded421d-backport-'))
  const bot = { id: 'bot-quincy', name: 'Quincy', session: 'quincy' }, peer = { id: 'bot-peer', name: 'Peer' }
  const bots = new Map([[bot.id, bot], [peer.id, peer]]); bots.refresh = async () => {}
  const native = Promise.withResolvers(), oldNative = Promise.withResolvers(), calls = []
  const gate = new ConversationLifetimes('current')
  const transport = new AitermTransport({ conversationAdmission: gate, handoffContext: async () => '',
    waitProcess: () => native.promise, client: { async call(name, args) {
      calls.push({ name, args })
      if (name === 'pty_list') return { content: [{ type: 'text', text: 'quincy' }] }
      if (name === 'pty_send') return { structuredContent: { mode: 'agent_dispatch', event_cursor: 1, wait_process: { executable: 'fixture', args: [] } } }
      if (name === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', turn_id: 'fresh', text: 'new reply' } }
      if (name === 'pty_observe') return {}
      assert.fail('unexpected native ' + name)
    }, async close() {} } })
  const occupied = { id: 'old-job', bot, conversationGeneration: 'retired', nativeUnconfirmed: Error('old unknown'),
    info: { message: 'old unknown payload' }, completion: oldNative.promise }
  transport.activity.register(occupied); transport.activity.admit(occupied)
  transport.uncertainChanges.set(bot.id, 'pty_close')
  const version = transport.uncertainChanges.version(bot.id), savedUnknown = occupied.nativeUnconfirmed
  const messenger = new BellTeamMessenger({ bots, transport, logPath: join(root, 'direct.jsonl') })
  t.after(async () => { native.resolve({ outcome: 'done', turn_id: 'fresh' }); oldNative.resolve(); transport.activity.release(occupied); await transport.close(); await rm(root, { recursive: true, force: true }) })
  assert.equal(await transport.ensure(bot), 'quincy')
  await transport.memberOperation(bot, () => transport.awaitUnboundAdmission(bot, transport.captureStopVersion(bot)))
  const owner = messenger.userTurn({ target: bot.id, message: 'new Owner input' })
  assert.equal((await owner.accepted).delivery, 'running')
  const received = await messenger.sendmessage({ from: peer.id, target: bot.id, message: 'new peer input' })
  assert.equal(received.delivery, 'running')
  assert.equal(calls.filter(row => row.name === 'pty_send').length, 2)
  assert.ok(!JSON.stringify(calls).includes('old unknown payload'))
  assert.equal(occupied.completion, oldNative.promise); assert.equal(occupied.nativeUnconfirmed, savedUnknown)
  assert.equal(transport.uncertainChanges.version(bot.id), version)
  transport.requireDeliveryKnown(bot.id); transport.sessionState.requireDeliveryKnown(bot.id)
  assert.throws(() => transport.requireSessionKnown(bot.id), { code: 'BOT_SESSION_UNCONFIRMED' })
  assert.throws(() => transport.assertConversationOccupation(bot.id), { code: 'CONVERSATION_NOT_ACCEPTED' })
  transport.requireAccess = async () => { throw Object.assign(Error('forbidden'), { code: 'BOT_FORBIDDEN' }) }
  const denied = transport.submit(bot, 'denied new input')
  await assert.rejects(denied.accepted, { code: 'BOT_FORBIDDEN' }); await assert.rejects(denied)
  transport.assertWorkAllowed = () => { throw Object.assign(Error('paused'), { code: 'AI_GLOBAL_PAUSED' }) }
  const stopped = transport.submit(bot, 'stopped new input')
  await assert.rejects(stopped.accepted, { code: 'AI_GLOBAL_PAUSED' }); await assert.rejects(stopped)
  assert.equal(calls.filter(row => row.name === 'pty_send').length, 2)
  native.resolve({ outcome: 'done', turn_id: 'fresh' })
  assert.equal((await owner).reply, 'new reply')
  await Promise.all([...transport.activity.jobs].filter(job => job !== occupied).map(job => job.completion))
  assert.equal((await messenger.store.records()).filter(row => row.message === 'new Owner input').length, 1)
  assert.equal((await messenger.store.records()).filter(row => row.message === 'new peer input').length, 1)
})
