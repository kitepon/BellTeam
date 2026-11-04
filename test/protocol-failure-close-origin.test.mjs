import test from 'node:test'
import assert from 'node:assert/strict'
import {ConversationLifetimes,validateConversationAdmissionDiagnostic} from '../src/conversation-lifetimes.mjs'
test('live protocol retirement has a distinct validated first close origin',()=>{
 const gate=new ConversationLifetimes('writer')
 const ticket=gate.close('module_protocol_failure')
 const before=gate.inspectAdmission()
 assert.equal(before.closedBy,'module_protocol_failure')
 assert.equal(before.ticket,true)
 assert.equal(before.failed,false)
 assert.deepEqual(validateConversationAdmissionDiagnostic(before),before)
 assert.equal(gate.close('module_child_exit'),ticket)
 assert.deepEqual(gate.inspectAdmission(),before)
 assert.throws(()=>validateConversationAdmissionDiagnostic({...before,closedBy:'arbitrary_actor'}),{code:'CONVERSATION_ADMISSION_DIAGNOSTIC_INVALID'})
})
