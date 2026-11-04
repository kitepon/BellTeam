import test from 'node:test'
import assert from 'node:assert/strict'
import { ConversationLifetimes, validateConversationAdmissionDiagnostic } from '../src/conversation-lifetimes.mjs'

const inspect = gate => validateConversationAdmissionDiagnostic(gate.inspectAdmission())

test('ticket closure and first owner are observable without changing admission', () => {
  const gate = new ConversationLifetimes('private-writer')
  const root = gate.enter(undefined, 'private-operation')
  const before = gate.snapshot(), open = inspect(gate)
  assert.equal(open.ticket, false); assert.equal(open.failed, false); assert.equal(open.active, 1)
  assert.equal(open.closedBy, null); assert.equal(open.revision, 0)
  open.active = 99; assert.deepEqual(gate.snapshot(), before)
  const ticket = gate.close('module_replace'), closed = inspect(gate)
  assert.equal(closed.ticket, true); assert.equal(closed.failed, false)
  assert.equal(closed.closedBy, 'module_replace'); assert.equal(closed.transition, 'close')
  assert.equal(gate.close('module_close'), ticket); assert.deepEqual(inspect(gate), closed)
  assert.throws(() => gate.enter(), { code: 'CONVERSATION_NOT_ACCEPTED' })
  assert.equal(JSON.stringify(closed).includes('private-'), false)
  gate.finish(root); gate.resume(ticket)
  assert.equal(inspect(gate).ticket, false); assert.equal(inspect(gate).transition, 'resume')
  assert.equal(inspect(gate).closedBy, 'module_replace')
  const next = gate.close({ arbitrary: 'private-message' })
  assert.equal(inspect(gate).closedBy, 'unknown'); gate.resume(next)
})

test('protocol failure is separate from ticket and retains its first fixed source', () => {
  const gate = new ConversationLifetimes('writer', { onProtocolFailure() { throw new Error('private') } })
  assert.throws(() => gate.assertDelivery({}), { code: 'CONVERSATION_PROTOCOL_UNCONFIRMED' })
  const failed = inspect(gate)
  assert.equal(failed.ticket, false); assert.equal(failed.failed, true); assert.equal(failed.unconfirmed, true)
  assert.equal(failed.failureSource, 'assert_delivery'); assert.equal(failed.transition, 'protocol')
  assert.throws(() => gate.claimNative({}, {})); assert.deepEqual(inspect(gate), failed)
  const ticket = gate.close('module_child_exit')
  assert.equal(inspect(gate).ticket, true); assert.equal(inspect(gate).failed, true)
  assert.throws(() => gate.resume(ticket), { code: 'CONVERSATION_PROTOCOL_UNCONFIRMED' })
  gate.recoverFailedGeneration(ticket, 'writer', 'next-writer')
  const recovered = inspect(gate)
  assert.equal(recovered.failed, false); assert.equal(recovered.ticket, true)
  assert.equal(recovered.writerRevision, 1); assert.equal(recovered.closedWriterRevision, 0)
  assert.equal(recovered.failureWriterRevision, 0); assert.equal(recovered.failureSource, 'assert_delivery')
  assert.equal(recovered.transition, 'recover_failed_generation')
  assert.throws(() => gate.recoverFailedGeneration(ticket, 'writer', 'third-writer'))
  assert.deepEqual(inspect(gate), recovered)
})

test('known retired protocol failure does not fabricate a current transition', () => {
  const gate = new ConversationLifetimes('old'), root = gate.enter(undefined, 'root')
  const ticket = gate.close('module_recovery')
  gate.recoverFailedGeneration(ticket, 'old', 'new'); gate.resume(ticket)
  const before = inspect(gate)
  assert.throws(() => gate.assertCurrentLease(root), { code: 'CONVERSATION_PROTOCOL_UNCONFIRMED' })
  const after = inspect(gate)
  assert.equal(after.failed, false); assert.equal(after.unconfirmed, true)
  assert.equal(after.revision, before.revision); assert.equal(after.failureSource, null)
  assert.equal(after.active, 1); gate.finish(root)
  assert.equal(inspect(gate).active, 0)
})

test('diagnostic validator rejects extra data and non-closed values', () => {
  const sample = new ConversationLifetimes().inspectAdmission()
  assert.deepEqual(validateConversationAdmissionDiagnostic(sample), sample)
  for (const change of [{ generation: 'private' }, { active: -1 }, { ticket: null }, { closedBy: 'arbitrary' },
    { failureSource: 'private error' }, { transition: 'force_resume' }, { revision: Number.MAX_SAFE_INTEGER + 1 },
    { failureAt: 'now' }]) {
    assert.throws(() => validateConversationAdmissionDiagnostic({ ...sample, ...change }),
      { code: 'CONVERSATION_ADMISSION_DIAGNOSTIC_INVALID' })
  }
  const { failed, ...missing } = sample
  assert.throws(() => validateConversationAdmissionDiagnostic(missing))
})

test('successful ordinary adopt and recover record the actual writer transition only', () => {
  const gate = new ConversationLifetimes('old')
  const ticket = gate.close()
  gate.adopt(ticket, 'next')
  assert.equal(inspect(gate).writerRevision, 1); assert.equal(inspect(gate).transition, 'adopt')
  gate.resume(ticket)
  const nextTicket = gate.close('module_child_exit')
  gate.recover(nextTicket, 'next', 'recovered')
  const recovered = inspect(gate)
  assert.equal(recovered.writerRevision, 2); assert.equal(recovered.transition, 'recover')
  assert.equal(recovered.closedWriterRevision, 1); assert.equal(recovered.ticket, true)
  assert.throws(() => gate.enter(), { code: 'CONVERSATION_NOT_ACCEPTED' })
})
