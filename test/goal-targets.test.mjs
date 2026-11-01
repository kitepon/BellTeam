import assert from 'node:assert/strict'
import test from 'node:test'
import { AitermTransport } from '../src/aiterm-transport.mjs'

test('Goal対象は通常一覧1回だけで取得し、旧field欠測と明示nullを区別する', async () => {
  const seen = [], bots = ['current', 'legacy', 'unknown', 'closed'].map(id => ({ id, session: id }))
  const transport = new AitermTransport({ client: { async call(name, args) {
    seen.push([name, args])
    return { structuredContent: { schema: 'aiterm.pty-list-result.v1', observed_at: new Date().toISOString(), sessions: [
      { session_id: 'current', launch_id: 'a'.repeat(32) }, { session_id: 'legacy' }, { session_id: 'unknown', launch_id: null },
    ] } }
  } } })
  const targets = await transport.goalTargets(bots)
  assert.deepEqual(seen, [['pty_list', undefined]])
  assert.equal(targets.get('current').launch_id, 'a'.repeat(32))
  assert.equal(Object.hasOwn(targets.get('legacy'), 'launch_id'), false)
  assert.equal(targets.get('unknown').launch_id, null)
  assert.equal(targets.has('closed'), false)
})

test('壊れた一覧や同名session重複はGoal対象へ採用しない', async () => {
  for (const sessions of [null, [{ session_id: 'same' }, { session_id: 'same' }], [{ session_id: null }]]) {
    const transport = new AitermTransport({ client: { async call() { return { structuredContent: { schema: 'aiterm.pty-list-result.v1', observed_at: new Date().toISOString(), sessions } } } } })
    await assert.rejects(transport.goalTargets([{ id: 'same', session: 'same' }]), /GOAL_TARGETS_INVALID/)
  }
})
