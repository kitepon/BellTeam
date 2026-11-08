import assert from 'node:assert/strict'
import test from 'node:test'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { executionFailureReport } from '../src/execution-failure-report.mjs'

const inputId = 'dbdaf01a75210019d564977dd57ce16d'
const read = async (receipt, completion = { turn_id: null, operation_id: null }) => {
  const calls = []
  const client = { call: async (name, args) => { calls.push([name, args]); return { content: [{ type: 'text', text: 'answer' }] } } }
  const text = await new AitermTransport({}).readTurnAnswer({ session: 'bot-fixture', receipt }, completion, client)
  return { text, args: calls[0][1] }
}

test('answer read is bound to the Claude dispatch input', async () => {
  const bound = await read({ mode: 'agent_dispatch', input_id: inputId })
  assert.equal(bound.text, 'answer')
  assert.deepEqual(bound.args, { session_id: 'bot-fixture', agent_transcript: true, input_id: inputId })
  // Steer / non-Claude receipts and operation-bound reads keep the previous request.
  assert.deepEqual((await read({ mode: 'agent_steer' })).args, { session_id: 'bot-fixture', agent_transcript: true })
  assert.deepEqual((await read({ input_id: 'not-hex' })).args, { session_id: 'bot-fixture', agent_transcript: true })
  const operation = `sha256:${'a'.repeat(64)}`
  assert.deepEqual((await read({ input_id: inputId }, { operation_id: operation })).args,
    { session_id: 'bot-fixture', agent_transcript: true, operation_id: operation })
})

test('delivery_completion keeps the Aiterm code token, never the text', () => {
  const code = message => JSON.parse(executionFailureReport('bot-fixture', 'delivery_completion', new Error(message), { step: 'answer' }).diagnostic_log).errorCode
  assert.equal(code('aiterm: AITERM_TRANSCRIPT_INPUT_REPLACED: private-canary'), 'AITERM_TRANSCRIPT_INPUT_REPLACED')
  assert.equal(code('aiterm: TRANSCRIPT_TURN_ACTIVE: private-canary'), 'TRANSCRIPT_TURN_ACTIVE')
  assert.equal(code('AITERM_TRANSCRIPT_TURN_MISMATCH'), 'AITERM_TRANSCRIPT_TURN_MISMATCH')
  assert.equal(code('aiterm: operation_idなしのClaude turn はまだ完了していません private-canary'), 'UNKNOWN')
  assert.equal(code('private canary: text'), 'UNKNOWN')
})
