import test from 'node:test'
import assert from 'node:assert/strict'
import { createMembersAssembly } from '../src/members-assembly.mjs'
import { createConversationAssembly } from '../src/conversation-assembly.mjs'
import { createModuleExchangeMutex } from '../src/module-exchange-mutex.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'

test('members and conversation assemblies retain the same parent exchange capability', async () => {
  const exchangeMutex = createModuleExchangeMutex(), membersAdmission = new MembersAdmission()
  const seen = []
  let held, calls = 0
  const waiting = new Promise(resolve => { held = resolve })
  const createProcess = options => {
    seen.push(options.exchangeMutex)
    return { replace: () => options.exchangeMutex.runExclusive(async () => { calls++; await waiting }) }
  }
  const members = createMembersAssembly({ root: '/synthetic', membersAdmission, exchangeMutex, createProcess,
    membersAuthorization: {}, diagnostics: {}, dependencies: () => ({}) })
  const conversation = createConversationAssembly({ root: '/synthetic', membersAdmission, exchangeMutex, createProcess,
    getServices: () => ({ bots: { readRemovalStates: async () => ({ removals: [] }) } }), createFacade: () => ({ assets: {} }) })
  await conversation.assets.initialize()
  assert.deepEqual(seen, [exchangeMutex, exchangeMutex])
  const first = members.controller.replace()
  await assert.rejects(conversation.controller.replace(), { code: 'MODULE_EXCHANGE_BUSY' })
  assert.equal(calls, 1)
  held(); await first
  await conversation.controller.replace()
  assert.equal(calls, 2)
})
