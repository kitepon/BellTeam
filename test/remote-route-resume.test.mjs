import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { AitermTransport } from '../src/aiterm-transport.mjs'

// t29 (execution remote-seat.md "Resume after the route came back").
const bot = { id: 'b1', terminalId: 'macbook', projectRoot: '/Users/kite/BellTeam/k', harness: 'claude' }
function fake({ seen = null, idle = true, turn = 'idle', harness = 'claude-code', launched = '2026-11-13T02:00:00.000Z', resume = async () => true } = {}) {
  const calls = [], errors = []
  return { calls, errors, routeResumes: new Map(), runtimeLaunches: { s1: { capturedAt: launched } },
    session: () => 's1', seatHarness: () => harness, seatMcpSeen: () => seen, isIdle: () => idle,
    currentTurn: () => ({ state: turn, turnId: null }), reportError: report => errors.push(report),
    resumeRemoteSeat: target => { calls.push(target.id); return resume() } }
}
const run = (self, row) => AitermTransport.prototype.resumeLostRoutes.call(self, [bot], [{ session_id: 's1', ...row }])
const later = '2026-11-13T02:05:00.000Z'

test('resumes an idle remote seat whose route was rebuilt after launch and whose CLI did not come back; once per route', async () => {
  const self = fake()
  run(self, { route_since: later }); await setImmediate()
  assert.deepEqual(self.calls, ['b1'])
  self.runtimeLaunches.s1.capturedAt = '2026-11-13T02:06:00.000Z'
  run(self, { route_since: later }); await setImmediate()
  assert.deepEqual(self.calls, ['b1'], 'the resumed launch moved past route_since')
})

test('leaves the seat: no route_since (older Aiterm), route older than launch, seen after the route, other harness, local seat', () => {
  for (const [self, row, target] of [
    [fake(), {}, bot], [fake(), { route_since: '2026-11-13T01:00:00.000Z' }, bot],
    [fake({ seen: Date.parse(later) + 1 }), { route_since: later }, bot], [fake({ harness: 'grok-cli' }), { route_since: later }, bot],
    [fake(), { route_since: later }, { ...bot, terminalId: '' }]]) {
    AitermTransport.prototype.resumeLostRoutes.call(self, [target], [{ session_id: 's1', ...row }])
    assert.deepEqual(self.calls, [])
  }
})

test('a working seat waits for its turn end; AGENT_BUSY retries; another refusal is reported once per route', async () => {
  const self = fake({ turn: 'working' })
  run(self, { route_since: later })
  assert.deepEqual(self.calls, [], 'mid-turn: not now')
  const busy = fake({ resume: async () => { throw Object.assign(new Error('busy'), { aitermErrorCode: 'AGENT_BUSY' }) } })
  run(busy, { route_since: later }); await setImmediate(); await setImmediate()
  run(busy, { route_since: later }); await setImmediate()
  assert.equal(busy.calls.length, 2, 'AGENT_BUSY tries again on a later poll')
  const refused = fake({ resume: async () => { throw Object.assign(new Error('x'), { aitermErrorCode: 'AGENT_HIBERNATE_UNAVAILABLE' }) } })
  run(refused, { route_since: later }); await setImmediate(); await setImmediate()
  run(refused, { route_since: later }); await setImmediate()
  assert.equal(refused.calls.length, 1)
  assert.deepEqual(refused.errors, [{ code: 'REMOTE_SEAT_RESUME_REFUSED', module: 'execution', botId: 'b1', reason: 'AGENT_HIBERNATE_UNAVAILABLE' }])
})

test('no SM10 port (older body): the transport has no seen reader, so #seatTurns never runs the route rule', () => {
  assert.equal(new AitermTransport({ client: { call: async () => ({}) } }).seatMcpSeen, null)
})
