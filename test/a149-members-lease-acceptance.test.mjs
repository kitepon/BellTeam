import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversationAssembly } from '../src/conversation-assembly.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'

// a149 (production 11/15 13:37): a members exchange drained every members lease and an Owner turn held one until the turn ended,
// so the exchange timed out. The root's members lease now ends at acceptance; the conversation lease still lives to completion.
test('a149: a running user.turn holds its members lease only until acceptance, so a members drain completes', async () => {
  const membersAdmission = new MembersAdmission(), turn = Promise.withResolvers(), accepted = Promise.withResolvers()
  let ports
  const conversation = createConversationAssembly({ root: '/synthetic', membersAdmission,
    getServices: () => ({ bots: { readRemovalStates: async () => ({ removals: [] }) } }),
    createFacade: value => { ports = value; return { assets: {} } },
    createProcess: () => ({ request: () => { const result = turn.promise; result.completion = turn.promise; result.accepted = accepted.promise; return result } }) })
  conversation.run({ kind: 'owner' }, () => {
    const options = ports.context('user.turn', {})
    ports.getController().request('user.turn', { message: 'hi' }, options).catch(() => {})
  })
  const drained = membersAdmission.drain(membersAdmission.close())
  let done = false; drained.then(() => { done = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(done, false, 'before acceptance the root still holds members')
  accepted.resolve({ delivery: 'running' })
  await drained
  assert.equal(done, true, 'after acceptance the drain completes while the turn is still running')
  turn.resolve({})
})
