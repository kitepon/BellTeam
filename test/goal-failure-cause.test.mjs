import assert from 'node:assert/strict'
import test from 'node:test'
import { goalFailureCause } from '../src/execution-failure-report.mjs'

test('goal failure cause keeps code tokens and the sanitized Aiterm tool error only (BugHub 56db0203)', () => {
  const error = Object.assign(new Error('synthetic private goal text'), { code: 'not a token', aitermErrorCode: 'AGENT_GOAL_UNSUPPORTED',
    mcp_error: { tool: 'agent_goal', message: 'aiterm: AGENT_GOAL_UNSUPPORTED: no goal in this harness', truncated: false } })
  const cause = goalFailureCause(error)
  assert.deepEqual(cause, { code: null, aiterm_error_code: 'AGENT_GOAL_UNSUPPORTED',
    mcp_error: { tool: 'agent_goal', message: 'aiterm: AGENT_GOAL_UNSUPPORTED: no goal in this harness', truncated: false }, mcp_request: null })
  assert.doesNotMatch(JSON.stringify(cause), /synthetic private goal text/)
  assert.deepEqual(goalFailureCause(new Error('x')), { code: null, aiterm_error_code: null, mcp_error: null, mcp_request: null })
})
