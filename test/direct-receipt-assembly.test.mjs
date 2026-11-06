import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDirectReceiptAssembly, directFailureReport } from '../src/direct-receipt-assembly.mjs'
import { createConversationAssembly } from '../src/conversation-assembly.mjs'
import { createModuleExchangeMutex } from '../src/module-exchange-mutex.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { BellTeamMessenger } from '../src/messenger.mjs'
import { Diagnostics } from '../src/diagnostics.mjs'
import { validateConversationResult } from '../src/conversation/results.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
async function settled(predicate) { for (let n = 0; n < 1000; n++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)) }; assert.fail('connection did not settle') }
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'direct-parent-'))
  const membersAdmission = new MembersAdmission(), exchangeMutex = createModuleExchangeMutex(), sends = [], errors = []
  const bots = new Map([['bot-peer', { id: 'bot-peer', name: 'Peer' }], ['bot-quincy', { id: 'bot-quincy', name: 'Quincy', session: 'quincy' }]])
  bots.refresh = async () => {}; bots.readRemovalStates = async () => ({ removals: [] }); bots.readMember = async () => {}
  const listeners = new Set(), aiControl = { paused: true, state: 'stopped',
    watch(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    admit() { this.assertEnabled(); return () => this.assertEnabled() },
    assertEnabled() { if (this.paused) throw Object.assign(Error('paused'), { code: 'AI_GLOBAL_PAUSED' }) },
    enable() { this.paused = false; this.state = 'enabled'; for (const fn of listeners) fn(this) },
  }
  const services = { bots, aiControl }
  const conversation = createConversationAssembly({ root, membersAdmission, exchangeMutex, getServices: () => services,
    createProcess: () => ({ start: async () => {}, close: async () => {}, request() { assert.fail('direct receive entered child') } }) })
  const transport = new AitermTransport({ membersAdmission, conversationAdmission: conversation.admission,
    requireMember: async () => {}, assertWorkAllowed: () => aiControl.assertEnabled(), handoffContext: async () => '',
    waitProcess: async () => ({ outcome: 'done', turn_id: 'fresh-turn' }), client: { async call(name, args) {
      if (name === 'pty_send') { sends.push(args); if (options.nativeError) throw options.nativeError; if (options.nativeUnknown) throw Object.assign(Error('uncertain'), { code: 'BOT_SEND_OUTCOME_UNKNOWN' }); return { structuredContent: { mode: 'agent_dispatch', event_cursor: 1, wait_process: { executable: 'fixture', args: [] } } } }
      if (name === 'pty_list') return { content: [{ type: 'text', text: 'quincy' }] }
      if (name === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', turn_id: 'fresh-turn', text: 'Owner answer' } }
      if (name === 'pty_observe') return {}
      assert.fail('unexpected ' + name)
    }, async close() {} } })
  const legacy = new BellTeamMessenger({ bots, transport, logPath: join(root, 'logs/direct-messages.jsonl') })
  const direct = createDirectReceiptAssembly({ root, bots, transport, conversation, aiControl, exchangeMutex,
    assets: conversation.directAssets, legacy, onMessage: () => {}, onError: (error, context) => { errors.push(error); return options.onError?.(error, context) } })
  services.directReceipts = direct.receipts
  await conversation.initialize()
  t.after(async () => { await direct.close(); await transport.close(); await conversation.close(); await rm(root, { recursive: true, force: true }) })
  return { root, bots, membersAdmission, exchangeMutex, conversation, direct, sends, errors, aiControl, listeners }
}

test('parent saves while AI paused/child closed; mutex release and enabled event dispatch same IDs once with Owner reply and Bridge hint', async t => {
  const f = await fixture(t); f.conversation.admission.close()
  const owner = await f.conversation.run({ kind: 'owner' }, () => f.direct.messenger.enqueueUserTurn({ target: 'bot-quincy', message: 'new Owner input' }))
  const peer = await f.conversation.run({ kind: 'bot', botId: 'bot-peer' }, () => f.direct.messenger.sendmessage({ from: 'bot-peer', target: 'bot-quincy', message: 'new peer input' }))
  const bridge = await f.conversation.run({ kind: 'bridge' }, () => f.direct.messenger.receiveCallBridge({ event: 'session.reply', session_id: 'call-1', target_id: 'bot-quincy', source_system: 'local', source_id: 'person', source_label: 'Caller', message: 'call text', seq: 3 }))
  assert.equal(owner.delivery, 'queued'); assert.equal(peer.delivery, 'queued'); assert.equal(bridge.delivery, 'queued')
  validateConversationResult('user.post', owner); validateConversationResult('direct.post', peer); validateConversationResult('call.receive', bridge)
  const release = f.exchangeMutex.reserve(); f.direct.start(); f.aiControl.enable(); await tick(); assert.equal(f.sends.length, 0)
  release()
  await settled(async () => f.sends.length === 3 && !(await f.direct.receipts.pending()).length)
  await settled(async () => (await f.direct.receipts.store.records()).some(row => row.message === 'Owner answer'))
  const records = await f.direct.receipts.store.records()
  assert.deepEqual(records.filter(row => row.durable_receipt).map(row => row.delivery_id), [owner.delivery_id, peer.delivery_id, bridge.delivery_id])
  assert.ok(JSON.stringify(f.sends[2]).includes('session_id=call-1、from_party=local'))
  f.direct.requestDrain(); await tick(); await tick(); assert.equal(f.sends.length, 3)
  assert.equal(f.errors.length, 0)
  await f.direct.close(); assert.equal(f.listeners.size, 0)
})

test('native unknown is retained without replay; later independent peer input still proceeds', async t => {
  const f = await fixture(t, { nativeUnknown: true }); f.direct.start(); f.aiControl.enable()
  const receive = message => f.conversation.run({ kind: 'bot', botId: 'bot-peer' }, () => f.direct.messenger.sendmessage({ from: 'bot-peer', target: 'bot-quincy', message }))
  const first = await receive('first fresh payload')
  await settled(async () => (await f.direct.receipts.store.durableReceipts())[0]?.delivery === 'unknown')
  const second = await receive('second fresh payload')
  await settled(async () => (await f.direct.receipts.store.durableReceipts()).find(row => row.delivery_id === second.delivery_id)?.delivery === 'unknown')
  f.direct.requestDrain(); await tick(); await tick()
  assert.equal(f.sends.length, 2)
  assert.notEqual(first.delivery_id, second.delivery_id)
})

test('parent authorization rejects spoofed sender/target; save failure cannot acknowledge or invoke native', async t => {
  const f = await fixture(t)
  assert.throws(() => f.conversation.run({ kind: 'bot', botId: 'bot-peer' }, () => f.direct.messenger.sendmessage({ from: 'bot-quincy', target: 'user', message: 'spoof' })), { code: 'CONVERSATION_SENDER_FORBIDDEN' })
  assert.throws(() => f.conversation.run({ kind: 'usage', botId: 'bot-peer', source: 'question' }, () => f.direct.messenger.enqueueUserTurn({ target: 'bot-quincy', message: 'wrong target' })), { code: 'CONVERSATION_TARGET_FORBIDDEN' })
  await mkdir(join(f.root, 'logs/direct-messages.jsonl'), { recursive: true })
  await assert.rejects(f.conversation.run({ kind: 'owner' }, () => f.direct.messenger.enqueueUserTurn({ target: 'bot-quincy', message: 'cannot save' })), { code: 'EISDIR' })
  assert.equal(f.sends.length, 0)
})

test('parent attachment uses shared deletion gate without child admission and survives source removal', async t => {
  const f = await fixture(t), png = Buffer.from([137,80,78,71,13,10,26,10])
  const context = f.conversation.moduleOperations.reserve(); f.conversation.admission.close()
  const receipt = await f.conversation.run({ kind: 'bot', botId: 'bot-peer' }, () => f.direct.messenger.sendmessage({ from: 'bot-peer', target: 'bot-quincy', message: 'image', image: { mime: 'image/png', data: png.toString('base64') } }))
  const record = (await f.direct.receipts.store.records()).find(row => row.delivery_id === receipt.delivery_id)
  assert.deepEqual(await readFile(join(f.conversation.directAssets.directory('bot-peer'), record.image_assets[0].file)), png)
  try { await f.conversation.assets.prepareBotAssetRemoval('bot-peer', context) }
  finally { f.conversation.moduleOperations.finish(context) }
  await assert.rejects(f.conversation.run({ kind: 'bot', botId: 'bot-peer' }, () => f.direct.messenger.sendmessage({ from: 'bot-peer', target: 'bot-quincy', message: 'closed image', image: { mime: 'image/png', data: png.toString('base64') } })), { message: 'IMAGE_BOT_REMOVAL_PENDING' })
})

test('proven pre-input refusal remains queued without a self-loop and resumes on a later normal event', async t => {
  const f = await fixture(t); let reads = 0, available = false
  f.bots.readMember = async () => { reads++; if (!available) throw Object.assign(Error('not ready'), { code: 'MEMBERS_NOT_ACCEPTED' }) }
  const receipt = await f.conversation.run({ kind: 'owner' }, () => f.direct.messenger.enqueueUserTurn({ target: 'bot-quincy', message: 'wait once' }))
  f.direct.start(); f.aiControl.enable()
  await settled(async () => reads === 1 && (await f.direct.receipts.store.durableReceipts())[0]?.delivery === 'queued')
  await tick(); await tick(); assert.equal(reads, 1); assert.equal(f.sends.length, 0)
  available = true; f.direct.requestDrain()
  await settled(async () => f.sends.length === 1 && !(await f.direct.receipts.pending()).length)
  assert.equal((await f.direct.receipts.store.records())[0].delivery_id, receipt.delivery_id)
})

test('application constructs sole receiver before child start and performs initial pending drain after the graph is complete', async t => {
  const { createApplicationRuntime } = await import('../src/application-runtime.mjs')
  const { FeatureSettings } = await import('../src/feature-settings.mjs')
  const { OwnerProfile } = await import('../src/owner-profile.mjs')
  const { UserRules } = await import('../src/user-rules.mjs')
  const { createSyntheticNotificationsProcess } = await import('./helpers/notifications-process.mjs')
  const { writeFile } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'direct-application-'))
  const bot = { id: 'bot-quincy', name: 'Quincy', session: 'quincy', project: join(root, 'bots/bot-quincy'), harness: 'codex' }
  const bots = new Map([[bot.id, bot]])
  bots.refresh = async () => {}; bots.readRemovalStates = async () => ({ removals: [] }); bots.projectPath = id => join(root, 'bots', id)
  const settings = new FeatureSettings({ root, environment: {} }), ownerProfile = new OwnerProfile({ root }), userRules = new UserRules({ root })
  for (const value of [settings, ownerProfile, userRules]) await value.initialize()
  await mkdir(join(root, 'logs'))
  const original = { schema: 'bellteam.direct-message.v1', durable_receipt: true, delivery_id: 'original-saved-id', at: new Date().toISOString(), from: 'user', target: bot.id, message: 'saved before bootstrap', image: false, delivery: 'queued' }
  await writeFile(join(root, 'logs/direct-messages.jsonl'), JSON.stringify(original) + '\n')
  let childStartReceiver, sends = 0
  const runtime = await createApplicationRuntime({ root, appRoot: new URL('../', import.meta.url).pathname, home: join(root, 'home'),
    environment: { BELLTEAM_WEB_PORT: '0', BELLTEAM_INTERNAL_PORT: '0' },
    bootstrap: { bots, settings, ownerProfile, userRules, aiterm: {}, createNotificationsProcess: createSyntheticNotificationsProcess,
      createConversationAssembly: options => createConversationAssembly({ ...options, createProcess: processOptions => ({
        async start() { childStartReceiver = options.getServices().directReceipts; assert.ok(childStartReceiver); processOptions.onState({ phase: 'running', available: true, exchanging: true }) },
        snapshot: () => ({ phase: 'running', available: true }), async close() {}, request() { assert.fail('new direct entered child') },
      }) }),
    },
    client: { async call(name) {
      if (name === 'pty_send') { sends++; return { structuredContent: { mode: 'agent_dispatch', event_cursor: 1, wait_process: { executable: 'fixture', args: [] } } } }
      if (name === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: 'reply' } }
      if (name === 'pty_observe') return {}
      assert.fail('unexpected ' + name)
    }, async close() {} },
  })
  // The SDK waiter is irrelevant to reception; use an explicit terminal fixture for this queued new turn.
  runtime.services.transport.waitProcess = async () => ({ outcome: 'done' })
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }) })
  assert.equal(childStartReceiver, runtime.services.directMessages.receipts)
  await settled(async () => sends === 1 && !(await childStartReceiver.pending()).length)
  assert.equal((await childStartReceiver.store.records())[0].delivery_id, original.delivery_id)
})

test('parent display reads saved history while the conversation child is unavailable', async t => {
  const { createApplicationRuntime } = await import('../src/application-runtime.mjs')
  const { FeatureSettings } = await import('../src/feature-settings.mjs')
  const { OwnerProfile } = await import('../src/owner-profile.mjs')
  const { UserRules } = await import('../src/user-rules.mjs')
  const { createSyntheticNotificationsProcess } = await import('./helpers/notifications-process.mjs')
  const { writeFile } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'direct-application-'))
  const bot = { id: 'bot-quincy', name: 'Quincy', session: 'quincy', project: join(root, 'bots/bot-quincy'), harness: 'codex' }
  const bots = new Map([[bot.id, bot]])
  bots.refresh = async () => {}; bots.readRemovalStates = async () => ({ removals: [] }); bots.projectPath = id => join(root, 'bots', id)
  const settings = new FeatureSettings({ root, environment: {} }), ownerProfile = new OwnerProfile({ root }), userRules = new UserRules({ root })
  for (const value of [settings, ownerProfile, userRules]) await value.initialize()
  await mkdir(join(root, 'logs'))
  const original = { schema: 'bellteam.direct-message.v1', durable_receipt: true, delivery_id: 'original-saved-id', at: new Date().toISOString(), from: 'user', target: bot.id, message: 'saved before bootstrap', image: false, delivery: 'delivered' }
  await writeFile(join(root, 'logs/direct-messages.jsonl'), JSON.stringify(original) + '\n')
  let childStartReceiver, sends = 0
  const runtime = await createApplicationRuntime({ root, appRoot: new URL('../', import.meta.url).pathname, home: join(root, 'home'),
    environment: { BELLTEAM_WEB_PORT: '0', BELLTEAM_INTERNAL_PORT: '0' },
    bootstrap: { bots, settings, ownerProfile, userRules, aiterm: {}, createNotificationsProcess: createSyntheticNotificationsProcess,
      createConversationAssembly: options => createConversationAssembly({ ...options, createProcess: processOptions => ({
        async start() { childStartReceiver = options.getServices().directReceipts; assert.ok(childStartReceiver); processOptions.onState({ phase: 'running', available: true, exchanging: true }) },
        snapshot: () => ({ phase: 'running', available: true }), async close() {}, request() { assert.fail('new direct entered child') },
      }) }),
    },
    client: { async call(name) {
      if (name === 'pty_send') { sends++; return { structuredContent: { mode: 'agent_dispatch', event_cursor: 1, wait_process: { executable: 'fixture', args: [] } } } }
      if (name === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: 'reply' } }
      if (name === 'pty_observe') return {}
      assert.fail('unexpected ' + name)
    }, async close() {} },
  })
  // The SDK waiter is irrelevant to reception; use an explicit terminal fixture for this queued new turn.
  runtime.services.transport.waitProcess = async () => ({ outcome: 'done' })
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }) })
  assert.equal(childStartReceiver, runtime.services.directMessages.receipts)
  runtime.services.conversationAssembly.admission.close('module_child_exit')
  const views = await runtime.services.store.recentViews([bot.id])
  assert.equal(views.get(bot.id).at(-1).message, original.message)
  assert.equal((await runtime.services.store.timeline(bot.id))[0].message, original.message)
  assert.equal(sends, 0)
  assert.equal((await childStartReceiver.store.records())[0].delivery_id, original.delivery_id)
})


test('direct first failure reaches registered diagnostics with bound safe fields and no private error data', async t => {
  const secret = 'PRIVATE_MESSAGE_BODY_STACK_ENV_PATH'
  const error = Object.assign(Error(secret), { code: 'BOT_SEND_OUTCOME_UNKNOWN',
    cause: { code: secret }, aitermResponseReturned: true, effect: 'not_started',
    mcp_request: { phase: 'call', tool: 'pty_send', outcome: 'unknown' },
    executionError: { schema: 'invalid', effect: 'not_started' }, secret })
  let diagnostics, reports = 0
  const f = await fixture(t, { nativeError: error, onError: (failure, context) => {
    reports++; return diagnostics.record(directFailureReport(failure, context))
  } })
  diagnostics = new Diagnostics(join(f.root, 'diagnostics.json')); await diagnostics.initialize()
  f.direct.start(); f.aiControl.enable()
  const receipt = await f.conversation.run({ kind: 'owner' }, () =>
    f.direct.messenger.enqueueUserTurn({ target: 'bot-quincy', message: secret }))
  await settled(async () => (await f.direct.receipts.store.durableReceipts())[0]?.delivery === 'unknown')
  await diagnostics.pending
  const rows = await diagnostics.list()
  assert.equal(rows.length, 1); assert.equal(reports, 1)
  assert.deepEqual(JSON.parse(rows[0].diagnostic_log), {
    delivery_id: receipt.delivery_id, target: 'bot-quincy', stage: 'status',
    code: 'BOT_SEND_OUTCOME_UNKNOWN', cause_code: null, returned: true,
    tool: 'pty_send', request_phase: 'call', effect: null, outcome: 'unknown',
  })
  assert.ok(!JSON.stringify(rows).includes(secret))
  assert.equal(JSON.parse(directFailureReport(error).diagnostic_log).effect, null)
  f.direct.requestDrain(); await tick(); await tick(); assert.equal(f.sends.length, 1)
})
