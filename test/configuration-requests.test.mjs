import assert from 'node:assert/strict'
import test from 'node:test'
import { configurationReceipt } from '../src/configuration-request.mjs'

const receipt = (binding, change = {}) => ({ schema: 'aiterm.agent-configure-request-result.v1', binding,
  request_state: 'terminal', outcome: 'not_applied', later_effect: 'excluded', terminal_at: '2026-11-03T07:00:00.000Z',
  result: null, current: { availability: 'unsupported' }, observed_at: '2026-11-03T07:00:01.000Z', ...change })
const applied = binding => receipt(binding, { outcome: 'applied', later_effect: 'unconfirmed', result: {
  schema: 'aiterm.agent-configure-result.v1', session_id: binding.session_id, provider: 'codex', harness: 'codex-cli', model: 'next', reasoning_effort: 'high', fast: null,
} })

test('strict receipt rejects wrong binding and contradictory states', () => {
  const binding = { id: 'a1234567-1234-4123-8123-123456789abc', session_id: 'original', launch_id: '1'.repeat(32), digest: '2'.repeat(64) }
  for (const changed of [{ binding: { ...binding, launch_id: '3'.repeat(32) } }, { extra: true },
    { request_state: 'not_recorded' }, { outcome: 'applied' }, { terminal_at: '2026-02-31T00:00:00Z' },
    { current: { availability: 'available' } }, { request_state: 'pending_or_unknown', terminal_at: null, later_effect: 'excluded' }])
    assert.throws(() => configurationReceipt(receipt(binding, changed), binding), { code: 'CONFIGURATION_RESULT_UNCONFIRMED' })
})
