import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyBridge, classifyRelease } from '../scripts/body-preflight.mjs'

test('only a definite target-code failure blocks; #822 fallbacks and unknowns are warnings', () => {
  assert.equal(classifyRelease('usage', 'currentVersionId', 'USAGE_STATE_INCOMPATIBLE'), 'warning')
  assert.equal(classifyRelease('work-graph', 'previousVersionId', 'WORK_GRAPH_STATE_INCOMPATIBLE'), 'warning')
  assert.equal(classifyRelease('usage', 'currentVersionId', 'GATEWAY_RELEASE_INCOMPATIBLE'), 'fail')
  assert.equal(classifyRelease('members', 'currentVersionId', 'MEMBERS_STATE_INCOMPATIBLE'), 'fail')
  assert.equal(classifyRelease('members', 'previousVersionId', 'MEMBERS_STATE_INCOMPATIBLE'), 'warning')
  assert.equal(classifyBridge(0, ''), 'pass')
  assert.equal(classifyBridge(1, 'HOST_MODULE_SWITCH_STORAGE\n'), 'fail')
  assert.equal(classifyBridge(1, 'HOST_MODULE_TERMINATION_UNCONFIRMED\n'), 'warning')
  assert.equal(classifyBridge(null, ''), 'warning')
})
