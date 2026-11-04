import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConversationAssembly } from '../src/conversation-assembly.mjs'
import { createModuleExchangeMutex } from '../src/module-exchange-mutex.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'

const fail = admission => assert.throws(() => admission.deliveryFor({}, { deliveryId: 'missing', target: 'bot-fixture' }),
  { code: 'CONVERSATION_PROTOCOL_UNCONFIRMED', outcome: 'outcome_unknown' })
function fixture(exchangeMutex, retire) {
  const diagnostics = [], calls = []
  const assembly = createConversationAssembly({ root: '/synthetic', membersAdmission: new MembersAdmission(), exchangeMutex,
    getServices: () => ({}), createFacade: () => ({ assets: {} }), onDiagnostic: row => { diagnostics.push(row); return Promise.reject(Error('diagnostic unavailable')) },
    createProcess: ({ admission }) => ({ snapshot: () => ({ generation: admission.capture().generation }), close: async () => {},
      retireProtocolFailedWriter: input => { calls.push(input); return retire?.(input) ?? Promise.resolve({ available: false }) } }) })
  return { assembly, calls, diagnostics }
}

test('first protocol failure survives busy and acquisition contention without waiting on the original error', async () => {
  const mutex = createModuleExchangeMutex(), release = mutex.reserve()
  let contention = true, attempts = 0
  const exchangeMutex = { waitForIdle: mutex.waitForIdle, runExclusive: action => {
    attempts++
    if (contention) {
      contention = false
      const releaseRace = mutex.reserve()
      queueMicrotask(releaseRace)
      return mutex.runExclusive(action)
    }
    return mutex.runExclusive(action)
  } }
  const { assembly, calls, diagnostics } = fixture(exchangeMutex, async () => {
    await assert.rejects(mutex.runExclusive(() => assert.fail('concurrent exchange entered')), { code: 'MODULE_EXCHANGE_BUSY' })
    return { available: false }
  })
  fail(assembly.admission); fail(assembly.admission)
  assert.deepEqual(calls, [])
  assert.equal(assembly.admission.inspectAdmission().failed, true)
  release(); await setImmediate()
  assert.equal(attempts, 2)
  assert.deepEqual(calls, [{ generation: 'builtin' }])
  assert.deepEqual(diagnostics, [])
  await mutex.runExclusive(() => {})
  await assembly.close()
})

test('stale generation or parent close discards a pending notification without retiring another writer', async () => {
  for (const stale of ['generation', 'close']) {
    const mutex = createModuleExchangeMutex(), release = mutex.reserve()
    const { assembly, calls } = fixture(mutex)
    fail(assembly.admission)
    if (stale === 'close') await assembly.close()
    else {
      const ticket = assembly.admission.close()
      assembly.admission.recoverFailedGeneration(ticket, 'builtin', 'new-writer')
      assembly.admission.resume(ticket)
    }
    release(); await setImmediate()
    assert.deepEqual(calls, [])
    await assembly.close()
  }
})

test('issued retirement rejection stays unknown, is owned by the diagnostic path and is not replayed', async () => {
  const mutex = createModuleExchangeMutex()
  const { assembly, calls, diagnostics } = fixture(mutex, () => Promise.reject(Error('private provider detail')))
  fail(assembly.admission)
  await setImmediate()
  fail(assembly.admission)
  await mutex.runExclusive(() => {})
  await setImmediate()
  assert.deepEqual(calls, [{ generation: 'builtin' }])
  assert.deepEqual(diagnostics, [{ code: 'CONVERSATION_PROTOCOL_UNCONFIRMED' }])
  assert.equal(assembly.admission.inspectAdmission().failed, true)
  await assembly.close()
})

test('actual assembly notification retires its real child and releases exchange before Q resumes with old native held', { timeout: 6000 }, async t => {
  t.mock.method(console, 'error', () => {})
  const root = await mkdtemp(join(tmpdir(), 'protocol-parent-'))
  await mkdir(join(root, 'state'))
  const mutex = createModuleExchangeMutex(), children = [], resumed = Promise.withResolvers(), native = Promise.withResolvers()
  let initialGeneration, lease, delivery
  const assembly = createConversationAssembly({ root, membersAdmission: new MembersAdmission(), exchangeMutex: mutex,
    getServices: () => ({ bots: { refresh: async () => {}, values: () => [], readRemovalStates: async () => ({ removals: [] }) } }),
    createFacade: () => ({ assets: {} }),
    onState: state => { if (initialGeneration && state.available && state.generation !== initialGeneration) resumed.resolve(state) },
    spawnProcess: (_entry, args, options) => {
      const child = spawn(process.execPath, [new URL('./fixtures/conversation-channel-child.mjs', import.meta.url).pathname, root, args[0]], options)
      children.push(child); return child
    } })
  t.after(async () => {
    native.resolve()
    for (const retained of [delivery, lease]) if (retained) { try { assembly.admission.finish(retained) } catch {} }
    await setImmediate(); await assembly.close().catch(() => {}); await rm(root, { recursive: true, force: true })
  })
  await assembly.initialize()
  lease = assembly.admission.enter()
  initialGeneration = lease.generation
  delivery = assembly.admission.registerDelivery(lease, { deliveryId: 'old-native', target: 'bot-fixture', dispatch: async () => {}, kinds: [] })
  assembly.admission.claimNative(delivery, { deliveryId: 'old-native', target: 'bot-fixture', kind: 'turn' })
  assembly.admission.trackNativeContinuation(delivery, { mode: 'agent_dispatch', event_cursor: 1, wait_process: 'old' }, native.promise)
  assembly.admission.finish(delivery); assembly.admission.finish(lease)
  const release = mutex.reserve()
  fail(assembly.admission)
  assert.equal(children.length, 1)
  assert.equal(children[0].exitCode, null)
  release()
  const state = await resumed.promise
  assert.equal(state.currentVersionId, null)
  assert.equal(children.length, 2)
  assert.notEqual(children[0].exitCode, null)
  assert.equal(children[0].connected, false)
  assert.equal(children[0].stdout.closed, true); assert.equal(children[0].stderr.closed, true)
  assert.equal(assembly.admission.inspectAdmission().failed, false)
  assert.equal(assembly.admission.assertLease(delivery), delivery)
  assert.equal(assembly.admission.snapshot().active, 2)
  assert.equal(assembly.admission.snapshot().unconfirmed, true)
  const current = assembly.admission.enter()
  assert.notEqual(current.generation, initialGeneration)
  assembly.admission.finish(current)
  await mutex.waitForIdle()
  await mutex.runExclusive(() => {})
})
