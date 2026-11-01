import assert from 'node:assert/strict'
import test from 'node:test'
import { validateAiControlState } from '../src/ai-control-state-transfer.mjs'
test('offline transfer validates persisted pause intent without writing or defaulting unknown state',()=>{
 for(const paused of [true,false]) assert.doesNotThrow(()=>validateAiControlState(Buffer.from(JSON.stringify({schema:'bellteam.ai-control.v1',paused,updatedAt:'2026-11-01T00:00:00Z',resumedAt:null}))))
 for(const data of ['broken','{}',JSON.stringify({schema:'bellteam.ai-control.v1',paused:'false',updatedAt:'2026-11-01T00:00:00Z'}),JSON.stringify({schema:'bellteam.ai-control.v1',paused:false,updatedAt:'invalid'})])
  assert.throws(()=>validateAiControlState(Buffer.from(data)),{code:'AI_CONTROL_TRANSFER_INVALID'})
})
