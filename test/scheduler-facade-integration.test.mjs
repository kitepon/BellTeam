import assert from 'node:assert/strict'
import test from 'node:test'
import { MembersAdmission } from '../src/members-admission.mjs'
import { createMembersFacade } from '../src/members-facade.mjs'
import { BotScheduler } from '../src/scheduler.mjs'
import { normalizeSchedule } from '../src/schedule-definition.mjs'
const now = new Date('2030-01-01T00:00:01Z')
const profile = { id: 'bot-test', name: 'test', harness: 'codex', session: '' }
function fixture({ stopAfterClaim = false } = {}) {
  const admission = new MembersAdmission('test'), seen = []
  let ticket, consumed = false, emits = 0, epoch = 0, entered = 0
  const originalEnter = admission.enter.bind(admission)
  admission.enter = (...args) => { entered++; return originalEnter(...args) }
  const schedule = { ...normalizeSchedule({ id: 'test-schedule', kind: 'once', at: '2030-01-01T00:00:00Z', prompt: 'synthetic' }, new Date('2029-12-31T00:00:00Z')), revision: 0 }
  const { bots } = createMembersFacade({ admission, projection: { values: () => [profile].values() }, request: async (method, params, { membersLease }) => {
    admission.assertLease(membersLease); seen.push(membersLease)
    if (method === 'profiles.read') return { profiles: [profile] }
    if (method === 'schedules.list') return { schedules: consumed ? [] : [schedule] }
    assert.equal(method, 'schedules.claimDue')
    assert.deepEqual(params, { ownerKind: 'bot', ownerId: profile.id, scheduleId: schedule.id, expectedRevision: 0, expectedNextRunAt: schedule.nextRunAt, ranAt: now.toISOString() })
    assert.equal(consumed, false); consumed = true
    ticket = admission.close()
    if (stopAfterClaim) epoch++
    return schedule
  } })
  const scheduler = new BotScheduler({ registry: bots, membersAdmission: admission,
    admitWork: () => { const captured = epoch; return () => { if (epoch !== captured) throw Object.assign(new Error('stopped'), { code: 'AI_GLOBAL_PAUSED' }) } },
    messenger: { async sendmessage(input, options) {
      assert.equal(consumed, true); assert.equal(input.target, profile.id)
      admission.assertLease(options.membersLease)
      await bots.refresh(options)
      emits++
    } },
  })
  return { scheduler, admission, seen, result: () => ({ ticket, consumed, emits, entered }) }
}
test('real scheduler and facade use one old lease from claim through fresh delivery read', async () => {
  const f = fixture()
  await f.scheduler.runDue(now)
  const result = f.result()
  assert.equal(result.consumed, true); assert.equal(result.emits, 1); assert.equal(result.entered, 1)
  assert.equal(f.seen.length, 4); assert.ok(f.seen.every(value => value === f.seen[0]))
  await f.admission.drain(result.ticket)
  assert.throws(() => f.admission.assertLease(f.seen[0]))
})
test('global stop after claim prevents emission and preserves consumption', async () => {
  const f = fixture({ stopAfterClaim: true })
  await f.scheduler.runDue(now)
  const result = f.result()
  assert.equal(result.consumed, true); assert.equal(result.emits, 0); assert.equal(result.entered, 1)
  await f.admission.drain(result.ticket)
})
