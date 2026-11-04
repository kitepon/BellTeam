import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createConversationProcess } from '../src/conversation-process.mjs'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'
import { createModuleExchangeMutex } from '../src/module-exchange-mutex.mjs'

// Only the runtime/channel handoff is new here; writer/native internal suites are inherited.
test('runtime and actual conversation channel retire a failed writer, then Q restores after mutex release', { timeout: 6000 }, async t => {
  const fixture = JSON.parse(await readFile(new URL('../src/conversation/probe-fixture.json', import.meta.url), 'utf8'))
  const root = await mkdtemp(join(tmpdir(), 'retirement-contact-'))
  for (const [relative, value] of Object.entries(fixture.files)) {
    const path = join(root, relative); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, JSON.stringify(value) + '\n', { mode: 0o600 })
  }
  await mkdir(join(root, 'state'), { recursive: true })
  await writeFile(join(root, 'state/conversation-release.json'), JSON.stringify({ schema: 'bellteam.conversation.adoption.v1', currentVersionId: null, previousVersionId: null }) + '\n', { mode: 0o600 })
  const admission = new ConversationLifetimes(), exchangeMutex = createModuleExchangeMutex(), children = []
  const physical = Promise.withResolvers(), restored = Promise.withResolvers()
  let oldGeneration, delivery, controller, lease, fresh, stderr = ''
  t.mock.method(console, 'error', () => {})
  controller = createConversationProcess({ root, admission, exchangeMutex, readBots: async () => fixture.bots,
    authorizeActor: () => ({ kind: 'owner' }), onEvent: async () => {}, onDiagnostic: async () => {},
    onState: snapshot => { if (oldGeneration && snapshot.available && snapshot.generation !== oldGeneration) restored.resolve(snapshot) },
    onEffect: async (method, params, context) => {
      if (method === 'members.profiles.read') return { bots: fixture.bots }
      if (method === 'execution.assertAccess') return { allowed: true }
      if (method === 'execution.turn') {
        delivery = context.conversationDelivery
        admission.claimNative(delivery, { deliveryId: params.deliveryId, target: params.target, kind: 'turn' })
        admission.trackNativeContinuation(delivery, { mode: 'agent_dispatch', event_cursor: 1, wait_process: 'original-native' }, physical.promise)
        admission.finish(delivery)
        return { delivery: 'running' }
      }
      if (method === 'usage.routing.read') return { enabled: false, epoch: 1, apiKey: null }
      if (method.startsWith('usage.notify.')) return { accepted: true }
      assert.fail('unexpected effect ' + method)
    },
    spawnProcess: (path, args, options) => {
      assert.equal(path, '/usr/local/libexec/bellteam-conversation-start'); assert.equal(options.serialization, 'advanced')
      const child = spawn(process.execPath, [new URL('./fixtures/conversation-channel-child.mjs', import.meta.url).pathname, root, args[0]], options)
      child.stderr.on('data', chunk => { stderr += chunk }); children.push(child); return child
    },
  })
  t.after(async () => {
    physical.resolve()
    for (const held of [lease, fresh]) if (held) { try { admission.finish(held) } catch {} }
    await controller.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
    assert.equal(stderr, '')
  })
  await controller.start(); oldGeneration = controller.snapshot().generation; lease = admission.enter()
  const options = { conversationLease: lease, capturedAuthority: {}, operationContext: {}, admissionCheck() {} }
  const original = controller.request('user.turn', { target: fixture.bots[0].id, message: 'held original native', images: [] }, options)
  const failed = assert.rejects(original), completed = assert.rejects(original.completion)
  await original.accepted
  const nativeDone = admission.deliveryCompletion(delivery)
  let nativeEnded = false; nativeDone.then(() => { nativeEnded = true })
  assert.throws(() => admission.assertDelivery({}), { code: 'CONVERSATION_PROTOCOL_UNCONFIRMED' })
  const retired = await exchangeMutex.runExclusive(() => controller.retireProtocolFailedWriter({ generation: oldGeneration }))
  assert.equal(retired.available, false); assert.equal(children.length, 1)
  assert.equal(children[0].exitCode, 0); assert.equal(children[0].connected, false)
  assert.equal(children[0].stdout.closed, true); assert.equal(children[0].stderr.closed, true)
  assert.equal(nativeEnded, false); assert.equal(admission.assertLease(delivery), delivery)
  await failed; await completed; admission.finish(lease)
  const next = await restored.promise
  assert.equal(next.available, true); assert.notEqual(next.generation, oldGeneration); assert.equal(children.length, 2)
  assert.equal(admission.inspectAdmission().failed, false); assert.equal(nativeEnded, false)
  fresh = admission.enter()
  const chunks = []
  const history = controller.request('history.listMessages', { botId: fixture.bots[0].id }, { ...options, conversationLease: fresh, onChunk: chunk => chunks.push(chunk) })
  assert.deepEqual(await history, { streamed: true })
  await history.completion; admission.finish(fresh)
  const rows = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.ok(rows.some(row => row.message === 'held original native'))
  physical.resolve(); await nativeDone
})
