import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { AitermTransport } from '../src/aiterm-transport.mjs'

// t29 (execution remote-seat.md "Resume after the route came back").
const bot = { id: 'b1', terminalId: 'macbook', projectRoot: '/Users/kite/BellTeam/k', harness: 'claude' }
function fake({ seen = null, idle = true, turn = 'idle', harness = 'claude-code', launched = '2026-11-13T02:00:00.000Z', resume = async () => true } = {}) {
  const calls = [], errors = []
  return { calls, errors, routeResumes: new Map(), routeWakes: new Map(), routeReported: new Set(), routeRetryAt: AitermTransport.prototype.routeRetryAt, runtimeLaunches: { s1: { capturedAt: launched } },
    session: () => 's1', seatHarness: () => harness, seatMcpSeen: () => seen, isIdle: () => idle,
    currentTurn: () => ({ state: turn, turnId: null }), reportError: report => errors.push(report),
    resumeRemoteSeat: (target, options) => { calls.push(options?.closed ? `${target.id}:wake` : target.id); return resume() } }
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

test('a working seat waits for its turn end; seat refusals hold until the seat runs a turn; any other failure retries after a delay, reported once', async () => {
  const self = fake({ turn: 'working' })
  run(self, { route_since: later })
  assert.deepEqual(self.calls, [], 'mid-turn: not now')
  const key = `s1@${later}`
  for (const code of ['AGENT_BUSY', 'AGENT_HIBERNATE_UNAVAILABLE']) {
    // Rapi 2026-11-13: an idle seat with MCP helpers got AGENT_BUSY background_work_or_unknown on every ~5 s poll.
    const held = fake({ resume: async () => { throw Object.assign(new Error('no'), { aitermErrorCode: code }) } })
    run(held, { route_since: later }); await setImmediate(); await setImmediate()
    for (let i = 0; i < 3; i++) { run(held, { route_since: later }); await setImmediate() }
    assert.equal(held.calls.length, 1, `${code}: not asked again while the seat stays idle`)
    held.isIdle = () => false
    run(held, { route_since: later }); await setImmediate()
    assert.equal(held.calls.length, 1, `${code}: not while it works`)
    held.isIdle = () => true
    run(held, { route_since: later }); await setImmediate(); await setImmediate()
    assert.equal(held.calls.length, 2, `${code}: asked again after the seat ran a turn`)
    assert.equal(held.routeResumes.get(key), 'turn')
    // 829de1dc: the designed hold is not a failure and files no diagnostic.
    assert.deepEqual(held.errors, [])
    run(held, { route_since: '2026-11-13T02:07:00.000Z' }); await setImmediate()
    assert.equal(held.calls.length, 3, `${code}: a rebuilt forward is a new route`)
  }
  let fail = true
  const refused = fake({ resume: async () => { if (fail) throw Object.assign(new Error('x'), { aitermErrorCode: 'AGENT_RESUME_FAILED' }); return true } })
  run(refused, { route_since: later }); await setImmediate(); await setImmediate()
  run(refused, { route_since: later }); await setImmediate()
  assert.equal(refused.calls.length, 1, 'not again before the retry delay')
  assert.ok(refused.routeResumes.get(key) > Date.now() + 50_000)
  refused.routeResumes.set(key, Date.now() - 1)
  run(refused, { route_since: later }); await setImmediate(); await setImmediate()
  assert.equal(refused.calls.length, 2, 'tried again after the delay')
  refused.routeResumes.set(key, Date.now() - 1); fail = false
  run(refused, { route_since: later }); await setImmediate(); await setImmediate()
  assert.equal(refused.calls.length, 3); assert.equal(refused.routeResumes.has(key), false, 'recovered')
  assert.deepEqual(refused.errors, [{ code: 'REMOTE_SEAT_RESUME_REFUSED', module: 'execution', diagnostic_log: 'bot=b1 stage=close reason=AGENT_RESUME_FAILED message=x' }])
})

test('close succeeded, wake failed: the wake alone is retried without the row; a later launch from elsewhere ends it', async () => {
  let fail = true
  const self = fake({ resume: async () => { if (fail) throw Object.assign(new Error('w'), { code: 'UNREACHABLE', routeClosedAt: Date.parse('2026-11-13T02:10:00.000Z') }); return true } })
  run(self, { route_since: later }); await setImmediate(); await setImmediate()
  assert.deepEqual(self.calls, ['b1'])
  AitermTransport.prototype.resumeLostRoutes.call(self, [bot], []); await setImmediate()
  assert.deepEqual(self.calls, ['b1'], 'not again before the retry delay, even with the row gone')
  self.routeWakes.get('s1').retryAt = Date.now() - 1
  AitermTransport.prototype.resumeLostRoutes.call(self, [bot], []); await setImmediate(); await setImmediate()
  assert.deepEqual(self.calls, ['b1', 'b1:wake'], 'wake only, no second close')
  self.routeWakes.get('s1').retryAt = Date.now() - 1; fail = false
  AitermTransport.prototype.resumeLostRoutes.call(self, [bot], []); await setImmediate(); await setImmediate()
  assert.deepEqual(self.calls, ['b1', 'b1:wake', 'b1:wake']); assert.equal(self.routeWakes.has('s1'), false, 'recovered')
  assert.deepEqual(self.errors.map(error => error.diagnostic_log), ['bot=b1 stage=wake reason=UNREACHABLE message=w'], 'one diagnostic per stage')
  // An ordinary wake or restart that launched after the close ends the record without our call.
  self.routeWakes.set('s1', { closedAt: Date.parse('2026-11-13T02:10:00.000Z'), running: false, retryAt: 0 })
  self.runtimeLaunches.s1.capturedAt = '2026-11-13T02:11:00.000Z'
  AitermTransport.prototype.resumeLostRoutes.call(self, [bot], []); await setImmediate()
  assert.equal(self.calls.length, 3); assert.equal(self.routeWakes.has('s1'), false)
})

test('resumeRemoteSeat: a wake failure after a successful close carries routeClosedAt; closed:true skips the close', async () => {
  const ops = []
  const self = { isIdle: () => true, activity: { configurationChanges: { has: () => false, track: (_, work) => work } },
    memberOperation: (_, work) => work('lease'), session: () => 's1',
    changeSession: async (_, tool) => { ops.push(tool) }, wake: async () => { ops.push('wake'); throw Object.assign(new Error('w'), { code: 'UNREACHABLE' }) } }
  await assert.rejects(AitermTransport.prototype.resumeRemoteSeat.call(self, bot), error => Number.isFinite(error.routeClosedAt) && error.code === 'UNREACHABLE')
  await assert.rejects(AitermTransport.prototype.resumeRemoteSeat.call(self, bot, { closed: true }), error => error.routeClosedAt === undefined)
  assert.deepEqual(ops, ['pty_close', 'wake', 'wake'])
})

test('no SM10 port (older body): the transport has no seen reader, so #seatTurns never runs the route rule', () => {
  assert.equal(new AitermTransport({ client: { call: async () => ({}) } }).seatMcpSeen, null)
})

// a401b (BugHub 829de1dc): the 60 s MCP limit on a hibernate close that Aiterm finished 1 s later is not a refusal.
const timeout = () => Object.assign(new Error('MCP error -32001: Request timed out'), { code: -32001 })
function closing(observation, { wake = async () => true } = {}) {
  const calls = [], errors = []
  const self = { calls, errors, routeReported: new Set(), activity: { configurationChanges: { has: () => false, track: (_id, work) => work } },
    isIdle: () => true, session: () => 's1', memberOperation: (_bot, work) => work({}),
    changeSession: async (_bot, tool) => { calls.push(tool); throw timeout() },
    observe: async () => { if (observation instanceof Error) throw observation; return observation },
    wake: async () => { calls.push('wake'); return wake() }, reportError: report => errors.push(report), routeRetryAt: AitermTransport.prototype.routeRetryAt }
  self.seatClosedAfterTimeout = AitermTransport.prototype.seatClosedAfterTimeout
  return self
}
const seat = extra => ({ schema: 'aiterm.pty-observe-result.v1', session_id: 's1', exists: true, pane_alive: true, state: 'running', ...extra })

test('a close that timed out but Aiterm recorded as hibernated goes on to the wake and files nothing', async () => {
  for (const observation of [seat({ state: 'hibernated', pane_alive: false, reason: 'idle_timeout' }), seat({ state: 'hibernated' })]) {
    const self = closing(observation)
    assert.equal(await AitermTransport.prototype.resumeRemoteSeat.call(self, bot), true)
    assert.deepEqual(self.calls, ['pty_close', 'wake'])
    assert.deepEqual(self.errors, [])
  }
})

test('a close that timed out while the seat stayed open is reported as before, marked seat=open; an unreadable seat proves nothing and files nothing', async () => {
  const open = closing(seat())
  const error = await AitermTransport.prototype.resumeRemoteSeat.call(open, bot).catch(value => value)
  assert.equal(error.code, -32001); assert.equal(error.seatOpen, true)
  assert.equal(open.calls.includes('wake'), false)
  AitermTransport.prototype.routeRetryAt.call(open, bot, 's1@r', error)
  assert.equal(open.errors.length, 1)
  assert.match(open.errors[0].diagnostic_log, /^bot=b1 stage=close reason=-32001 seat=open message=/u)
  // exists:false / pane_alive:false / agent_stopping also show while Aiterm is still stopping: not proof either way.
  for (const observation of [new Error('read failed'), { schema: 'other' }, seat({ session_id: 'other' }), seat({ exists: false }), seat({ pane_alive: false }),
    seat({ state: 'unknown', reason: 'agent_stopping', pane_alive: false })]) {
    const unknown = closing(observation)
    const failure = await AitermTransport.prototype.resumeRemoteSeat.call(unknown, bot).catch(value => value)
    assert.equal(failure.closeUnconfirmed, true)
    const retryAt = AitermTransport.prototype.routeRetryAt.call(unknown, bot, 's1@r', failure)
    assert.deepEqual(unknown.errors, [])
    assert.ok(retryAt > Date.now() + 50_000)
  }
})

test('only a timeout with no Aiterm answer is read; a returned Aiterm refusal or another failure is thrown untouched', async () => {
  for (const error of [Object.assign(new Error('x'), { code: -32001, aitermResponseReturned: true }), Object.assign(new Error('x'), { aitermErrorCode: 'AGENT_BUSY' }), new Error('x')]) {
    const self = closing(seat({ state: 'hibernated' })); self.changeSession = async () => { throw error }
    assert.equal(await AitermTransport.prototype.resumeRemoteSeat.call(self, bot).catch(value => value), error)
  }
})
