import test from 'node:test'
import assert from 'node:assert/strict'
import { errorCode, launchRefusal } from '../src/agent-launch-error.mjs'

test('Aiterm 0.70.5: local native_create refusal and error_code meta are read exactly', () => {
  const refusal = { schema: 'aiterm.agent-launch-error.v1', harness: 'claude-code', code: 'AGENT_LAUNCH_NOT_STARTED',
    phase: 'native_create', effect: 'not_started', session_created: false, action: '席は残っていません。' }
  assert.equal(launchRefusal(refusal)?.phase, 'native_create')
  assert.equal(launchRefusal({ ...refusal, phase: 'native_identity' }), null)
  // Aiterm 0.70.7: a refusal decided from the arguments alone, every harness.
  assert.equal(launchRefusal({ ...refusal, harness: 'codex-cli', phase: 'input' })?.phase, 'input')
  assert.equal(errorCode({ schema: 'aiterm.error-code.v1', code: 'SESSION_EXISTS' }), 'SESSION_EXISTS')
  assert.equal(errorCode({ schema: 'aiterm.error-code.v1', code: 'lower' }), null)
  assert.equal(errorCode({ schema: 'other', code: 'SESSION_EXISTS' }), null)
})
