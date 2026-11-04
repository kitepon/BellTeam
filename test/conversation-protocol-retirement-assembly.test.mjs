import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
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
