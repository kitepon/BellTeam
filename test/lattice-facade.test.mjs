import test from 'node:test'
import assert from 'node:assert/strict'
import { createLatticeFacade, createLatticeEffects, lateAnswerText, MAX_WRITES, NUDGE_MS, QUEUE_WAIT_MS, SEAT_ANSWER_MS } from '../src/lattice-facade.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const snap = (projectId, version) => ({ schema: 'bellteam.lattice-chart.v1', projectId, epoch: 'e', version })

function fixture({ respond = () => null, now, nudgeMs, reminders } = {}) {
  const calls = [], timers = [], nudges = []
  let gate = null
  const controller = { request: async (method, params) => {
    calls.push([method, params])
    if (gate) await gate
    const value = respond(method, params)
    if (value instanceof Error) throw value
    return value ?? (method === 'refresh' ? { snapshots: [], nextRefreshMs: 2000 } : { method, params })
  } }
  const facade = createLatticeFacade({ controller, nudgeMs, reminders, ...(now && { now }),
    // The nudge timer (60 s when enabled) and the seat answer timers are kept apart from the refresh loop's timers.
    setTimer: (run, ms) => { const timer = { run, ms }; (ms === NUDGE_MS ? nudges : ms === SEAT_ANSWER_MS ? [] : timers).push(timer); return timer }, clearTimer: timer => { if (timer) timer.cleared = true } })
  const fire = async () => { for (const timer of timers.splice(0)) if (!timer.cleared) timer.run(); await tick(); await tick() }
  return { facade, calls, timers, nudges, fire, hold: () => { let open; gate = new Promise(resolve => { open = resolve }); return () => { gate = null; open() } } }
}

test('writes run one at a time in call order; reads go at once beside a write in flight', async () => {
  const f = fixture()
  const release = f.hold()
  const writes = [f.facade.run({ from: 'bot-a', projectId: 'alpha', args: ['todo', 'start'] }), f.facade.run({ from: 'bot-a', projectId: 'alpha', args: [], name: '工程表' })]
  await tick()
  const reads = [f.facade.charts(), f.facade.chart('alpha'), f.facade.blockers(), f.facade.history({ projectId: 'alpha', before: 'h1.a', limit: 20 }), f.facade.history({ projectId: 'alpha' })]
  await tick()
  // The first write is in flight; the reads were sent beside it, the second write waits.
  assert.deepEqual(f.calls.map(([method]) => method), ['run', 'charts', 'chart', 'blockers', 'history', 'history'])
  release()
  assert.deepEqual((await Promise.all([...writes, ...reads])).map(value => value.method), ['run', 'run', 'charts', 'chart', 'blockers', 'history', 'history'])
  assert.deepEqual(f.calls.map(([method, params]) => [method, params]), [['run', { from: 'bot-a', projectId: 'alpha', args: ['todo', 'start'], input: null }],
    ['charts', {}], ['chart', { projectId: 'alpha' }], ['blockers', {}], ['history', { projectId: 'alpha', before: 'h1.a', limit: 20 }], ['history', { projectId: 'alpha', before: null, limit: 50 }],
    ['run', { from: 'bot-a', projectId: 'alpha', args: [], input: null, name: '工程表' }]])
})

test('a seat run that writes nothing goes at once beside a write in flight; a write-looking run still queues', async () => {
  const f = fixture()
  const release = f.hold()
  const write = f.facade.run({ from: 'bot-a', projectId: 'alpha', args: ['todo', 'add', '--plan', 'p', '--task', 't'] })
  await tick()
  const reads = [f.facade.run({ from: 'bot-b', projectId: 'alpha', args: ['--version'] }), f.facade.run({ from: 'bot-b', projectId: 'alpha', args: ['status'] })]
  const queued = f.facade.run({ from: 'bot-b', projectId: 'alpha', args: ['todo', 'note', '--plan', 'p', '--task', 't', '--message', 'm'] })
  // A named run renames the chart: a write even when its args read (Epinel #1393).
  const named = f.facade.run({ from: 'bot-b', projectId: 'alpha', args: ['status'], name: '工程表' })
  await tick()
  assert.deepEqual(f.calls.map(([, params]) => params.args[0] + (params.args[1] ? ' ' + params.args[1] : '')), ['todo add', '--version', 'status'])
  release()
  await Promise.all([write, ...reads, queued, named])
  assert.deepEqual(f.calls.slice(-2).map(([, params]) => params.args[1] ?? params.name), ['note', '工程表'])
})

test('seat writes go before queued background writes of their lane; the write in flight finishes first', async () => {
  const f = fixture()
  const release = f.hold()
  const nudge = f.facade.nudge()
  await tick()
  const later = [f.facade.deliver(), f.facade.link({ projectId: 'alpha', plan: 'p', taskId: 't' })]
  await tick()
  assert.deepEqual(f.calls.map(([method]) => method), ['nudge'])
  release()
  await Promise.all([nudge, ...later])
  assert.deepEqual(f.calls.map(([method]) => method), ['nudge', 'link', 'deliver'])
})

// f20 (Trony 2026-11-26): one write line for every project made a chart edit wait 15-37 s behind the ~40 s writes of the largest plan.
const writeOn = (f, projectId, step) => f.facade.run({ from: 'bot-a', projectId, args: ['todo', step] })

test('f20: writes of different projects run beside each other; one project keeps its order and a slow project holds no other', async () => {
  const f = slowChild()
  const a1 = writeOn(f, 'alpha', 'a1'), a2 = writeOn(f, 'alpha', 'a2'), b1 = writeOn(f, 'beta', 'b1')
  await tick()
  assert.deepEqual(f.sent, ['a1', 'b1'], 'beta is sent beside alpha; the second alpha write waits for the first')
  f.finish[1]()
  assert.equal((await b1).method, 'run')
  const b2 = writeOn(f, 'beta', 'b2')
  await tick()
  assert.deepEqual(f.sent, ['a1', 'b1', 'b2'], 'beta goes on while alpha is still held')
  f.finish[0]()
  await tick(); await tick()
  assert.deepEqual(f.sent, ['a1', 'b1', 'b2', 'a2'])
  f.finish[2](); f.finish[3]()
  await Promise.all([a1, a2, b2])
})

test('f20: a nudge in flight holds no seat write of a project; a seat write of its lane goes before the queued deliver', async () => {
  const f = slowChild()
  const nudge = f.facade.nudge()
  await tick()
  const deliver = f.facade.deliver(), link = f.facade.link({ projectId: 'alpha', plan: 'p', taskId: 't' }), write = writeOn(f, 'alpha', 'a1')
  await tick()
  assert.deepEqual(f.sent, ['nudge', 'a1'], 'the project write is sent beside the sweep; link and deliver wait for the shared lane')
  f.finish[0]()
  await tick(); await tick()
  assert.deepEqual(f.sent, ['nudge', 'a1', 'link'])
  f.finish[2]()
  await tick(); await tick()
  assert.deepEqual(f.sent, ['nudge', 'a1', 'link', 'deliver'])
  f.finish[1](); f.finish[3]()
  await Promise.all([nudge, deliver, link, write])
})

test('f20: at most MAX_WRITES writes are in flight; a freed place goes to the oldest seat write before a background write', async () => {
  const f = slowChild()
  const writes = ['p1', 'p2', 'p3', 'p4', 'p5'].map(id => writeOn(f, id, id))
  const nudge = f.facade.nudge()
  const late = writeOn(f, 'p6', 'p6')
  await tick()
  assert.equal(MAX_WRITES, 4)
  assert.deepEqual(f.sent, ['p1', 'p2', 'p3', 'p4'])
  f.finish[0]()
  await tick(); await tick()
  assert.deepEqual(f.sent, ['p1', 'p2', 'p3', 'p4', 'p5'])
  f.finish[1]()
  await tick(); await tick()
  assert.deepEqual(f.sent.slice(5), ['p6'], 'the seat write is sent before the nudge that was queued earlier')
  f.finish[2]()
  await tick(); await tick()
  assert.deepEqual(f.sent.slice(6), ['nudge'])
  for (const end of f.finish.slice(3)) end()
  await Promise.all([...writes, nudge, late])
})

test('a write queued past the wait bound is never sent; the next write is sent at once', async () => {
  let clock = 0
  const f = fixture({ now: () => clock })
  const release = f.hold()
  const first = f.facade.run({ from: 'bot-a', projectId: 'alpha', args: ['todo', 'note'] })
  await tick()
  const stale = f.facade.run({ from: 'bot-a', projectId: 'alpha', args: ['todo', 'start'] })
  clock = QUEUE_WAIT_MS + 1
  const fresh = f.facade.unblock({ projectId: 'alpha', stopId: 'b'.repeat(24) })
  release()
  await first
  await assert.rejects(stale, { code: 'LATTICE_UNAVAILABLE', status: 503 })
  assert.equal((await fresh).method, 'unblock')
  assert.deepEqual(f.calls.map(([method, params]) => [method, params.args?.[1] ?? null]), [['run', 'note'], ['unblock', null]], 'the stale run never reached the child')
})

// a162: the seat gets a definite answer before Claude Code aborts the MCP call at 60 s; the write slot follows the child, not the caller.
function slowChild(now = Date.now, onLate = null) {
  const sent = [], finish = [], timers = []
  const controller = { request: (method, params) => {
    sent.push(params.args?.[1] ?? method)
    let end
    const completion = new Promise(resolve => { end = resolve })
    const result = completion.then(value => value ?? ({ method, params }))
    Object.defineProperty(result, 'completion', { value: completion })
    finish.push(end)
    return result
  } }
  const facade = createLatticeFacade({ controller, now, onLate, setTimer: (run, ms) => { const timer = { run, ms }; timers.push(timer); return timer }, clearTimer: timer => { if (timer) timer.cleared = true } })
  const bounds = () => timers.filter(timer => timer.ms === SEAT_ANSWER_MS)
  return { facade, sent, finish, bounds }
}
const writeRun = (f, step) => f.facade.run({ from: 'bot-a', projectId: 'alpha', args: ['todo', step] })

test('a sent seat write unanswered at the answer bound resolves PENDING; the slot stays with the child until it finishes', async () => {
  const f = slowChild()
  const first = writeRun(f, 'note'), second = writeRun(f, 'start')
  await tick()
  f.bounds()[0].run()
  const value = await first
  assert.deepEqual([value.exitCode, value.result.code], [null, 'LATTICE_WRITE_PENDING'])
  await tick()
  assert.deepEqual(f.sent, ['note'], 'the next write is not sent beside the one the child still runs')
  f.finish[0]()
  await tick(); await tick()
  assert.deepEqual(f.sent, ['note', 'start'])
  f.finish[1]()
  assert.equal((await second).method, 'run')
})

// a292: a queued seat write at the answer bound is answered PENDING and stays queued, so it still lands (it used to be dropped as LATTICE_WRITE_NOT_SENT).
test('a queued seat write unanswered at the answer bound resolves PENDING, stays queued past the wait bound and is sent in order', async () => {
  let clock = 0
  const f = slowChild(() => clock)
  const first = writeRun(f, 'note'), queued = writeRun(f, 'start'), last = writeRun(f, 'done')
  await tick()
  f.bounds()[1].run(); f.bounds()[2].run()
  for (const value of await Promise.all([queued, last])) assert.deepEqual([value.exitCode, value.result.code], [null, 'LATTICE_WRITE_PENDING'])
  clock = QUEUE_WAIT_MS + 1
  f.finish[0]()
  assert.equal((await first).method, 'run')
  await tick(); await tick()
  assert.deepEqual(f.sent, ['note', 'start'], 'the pending write is sent, not dropped by the wait bound')
  f.finish[1]()
  await tick(); await tick()
  assert.deepEqual(f.sent, ['note', 'start', 'done'])
  f.finish[2]()
})

test('late answer: a write answered PENDING gives its real outcome to onLate once, refusal included; a write answered in time gives none', async () => {
  const late = []
  const f = slowChild(Date.now, outcome => { late.push(outcome); throw new Error('a failing send is swallowed') })
  const first = writeRun(f, 'note'), second = writeRun(f, 'start'), third = writeRun(f, 'done')
  await tick()
  f.finish[0]({ exitCode: 0, result: {} })
  assert.equal((await first).exitCode, 0)
  assert.deepEqual(late, [], 'answered in time: nothing late')
  await tick(); await tick()
  f.bounds()[1].run(); f.bounds()[2].run()
  await Promise.all([second, third])
  f.finish[1]({ exitCode: 1, result: { code: 'TODO_TRANSITION_REFUSED', message: 'enforced_witness_undeclared', next_action: 'declare it' } })
  await tick(); await tick()
  f.finish[2]({ exitCode: 0, result: {} })
  await tick(); await tick()
  assert.deepEqual(late.map(item => [item.from, item.projectId, item.args[1], item.value.exitCode]), [['bot-a', 'alpha', 'start', 1], ['bot-a', 'alpha', 'done', 0]])
  assert.match(lateAnswerText(late[0]), /refused: TODO_TRANSITION_REFUSED enforced_witness_undeclared declare it/)
  assert.match(lateAnswerText(late[1]), /-> landed\./)
  assert.match(lateAnswerText({ projectId: 'alpha', args: ['todo', 'start'], error: { code: 'LATTICE_UNAVAILABLE' } }), /may not have landed/)
})

test('f30: the chart list carries the saved 催促 switch per chart; an unreadable setting or no store leaves the rows as the child sent them', async () => {
  const list = () => ({ schema: 'bellteam.lattice-charts.v1', at: 'a', charts: [{ projectId: 'alpha', name: 'A' }, { projectId: 'beta', name: 'B' }] })
  const respond = method => method === 'charts' ? list() : null
  const on = fixture({ respond, reminders: { enabledProjects: async () => ['beta', 'gone'] } })
  assert.deepEqual((await on.facade.charts()).charts, [{ projectId: 'alpha', name: 'A', reminders: false }, { projectId: 'beta', name: 'B', reminders: true }])
  const broken = fixture({ respond, reminders: { enabledProjects: async () => { throw new Error('disk') } } })
  assert.deepEqual((await broken.facade.charts()).charts, list().charts, 'the list never fails for the badge')
  assert.deepEqual((await fixture({ respond }).facade.charts()).charts, list().charts)
})

test('subscribers get only their chart; the loop follows nextRefreshMs and stops with the last subscriber', async () => {
  let next = { snapshots: [snap('alpha', 1), snap('beta', 1)], nextRefreshMs: 2000 }
  const f = fixture({ respond: method => method === 'refresh' ? next : null })
  const alpha = [], beta = []
  const offAlpha = f.facade.subscribe('alpha', value => alpha.push(value))
  const offBeta = f.facade.subscribe('beta', value => beta.push(value))
  await tick(); await tick()
  // The first subscriber starts one refresh at once; a later chart joins at the next tick (its first snapshot is the route's own chart read).
  assert.deepEqual(f.calls, [['refresh', { projectIds: ['alpha'] }]])
  assert.deepEqual([alpha.map(s => s.version), beta.map(s => s.version)], [[1], [1]])
  assert.deepEqual(f.timers.map(timer => timer.ms), [2000])
  next = { snapshots: [snap('beta', 2)], nextRefreshMs: 500 }
  await f.fire()
  assert.deepEqual(f.calls.at(-1), ['refresh', { projectIds: ['alpha', 'beta'] }])
  offAlpha()
  next = { snapshots: [snap('beta', 3)], nextRefreshMs: 500 }
  await f.fire()
  assert.deepEqual(f.calls.at(-1), ['refresh', { projectIds: ['beta'] }])
  assert.deepEqual([alpha.length, beta.map(s => s.version)], [1, [1, 2, 3]])
  assert.equal(f.timers.at(-1).ms, 500)
  offBeta()
  assert.equal(f.timers.at(-1).cleared, true)
  const count = f.calls.length
  await f.fire()
  assert.equal(f.calls.length, count)
})

test('a run refreshes a subscribed chart at once; a failed refresh re-arms and passes codes through', async () => {
  let down = false
  const f = fixture({ respond: (method, params) => down ? Object.assign(new Error('LATTICE_IPC_DISCONNECTED'), { code: 'LATTICE_IPC_DISCONNECTED' })
    : method === 'refresh' ? { snapshots: [snap(params.projectIds[0], 3)], nextRefreshMs: 5000 }
      : method === 'chart' ? Object.assign(new Error('LATTICE_CHART_NOT_FOUND'), { code: 'LATTICE_CHART_NOT_FOUND', status: 404 }) : null })
  const sent = []
  f.facade.subscribe('alpha', value => sent.push(value))
  await tick(); await tick()
  await f.facade.run({ from: 'bot-a', projectId: 'alpha', args: ['todo', 'start'], input: { a: 1 } })
  await tick()
  assert.deepEqual(f.calls.map(([method]) => method), ['refresh', 'run', 'refresh'])
  assert.equal(sent.length, 2)
  await f.facade.run({ from: 'bot-a', projectId: 'other', args: ['status'] })
  await tick()
  assert.deepEqual(f.calls.at(-1)[0], 'run')
  await assert.rejects(f.facade.chart('missing'), { code: 'LATTICE_CHART_NOT_FOUND', status: 404 })
  assert.equal(f.timers.at(-1).ms, 5000)
  down = true
  await assert.rejects(f.facade.charts(), { code: 'LATTICE_UNAVAILABLE', status: 503 })
  await f.fire()
  assert.equal(sent.length, 2)
  assert.deepEqual(f.timers.map(timer => timer.ms), [2000], 'a failed refresh re-arms with the retry delay')
})

test('members.list returns exactly the agreed fields; other effects are refused', async () => {
  const effect = createLatticeEffects({ bots: { listForClient: async () => [{ id: 'a', name: 'A', color: 'red', avatarVersion: 7, deleting: false, secret: 'x' }] } })
  assert.deepEqual(await effect('members.list', {}), { members: [{ id: 'a', name: 'A', color: 'red', avatarVersion: '7', deleting: false }] })
  await assert.rejects(effect('queue.read', {}), { code: 'LATTICE_EFFECT_INVALID' })
})

test('nudge: a null interval disables automatic calls and keeps explicit calls available', async () => {
  const f = fixture({ nudgeMs: null })
  assert.deepEqual([...f.timers, ...f.nudges], [])
  assert.deepEqual(f.calls, [])
  await f.facade.nudge()
  assert.deepEqual(f.calls, [['nudge', { projectIds: [] }]])
  assert.deepEqual([...f.timers, ...f.nudges], [])
})

test('nudge: one 60 s timer from creation, re-armed after each call, failures swallowed', async () => {
  let down = false
  const f = fixture({ respond: method => method === 'nudge' && down ? Object.assign(new Error('x'), { code: 'LATTICE_INVALID' }) : { charts: 1, prompted: 1, skipped: 0, failed: 0 } })
  assert.deepEqual(f.nudges.map(timer => timer.ms), [NUDGE_MS])
  assert.deepEqual(f.calls, [])
  f.nudges.shift().run(); await tick(); await tick()
  assert.deepEqual(f.calls, [['nudge', { projectIds: [] }]])
  assert.equal(f.nudges.length, 1, 're-armed after the call')
  down = true
  f.nudges.shift().run(); await tick(); await tick()
  assert.equal(f.calls.length, 2)
  assert.equal(f.nudges.length, 1, 'an old child refusing nudge does not stop the timer')
})

test('a sweep queued behind a write of its lane uses the switches saved before dispatch', async () => {
  let enabled = ['alpha']
  const f = fixture({ reminders: { enabledProjects: async () => enabled } })
  const release = f.hold()
  const write = f.facade.link({ projectId: 'alpha', plan: 'p', taskId: 't' })
  f.nudges.shift().run()
  assert.deepEqual(f.calls.map(([method]) => method), ['link'])
  enabled = ['beta']
  release()
  await write
  await tick()
  assert.deepEqual(f.calls.at(-1), ['nudge', { projectIds: ['beta'] }])
})

test('turns.read: working and idle pass, anything else or a failed read is unknown', async () => {
  const transport = { currentTurn: id => id === 'w' ? { state: 'working' } : id === 'i' ? Promise.resolve({ state: 'idle' }) : id === 'x' ? Promise.reject(new Error('down')) : { state: 'paused' } }
  const effect = createLatticeEffects({ bots: {}, transport })
  assert.deepEqual(await effect('turns.read', { botIds: ['w', 'i', 'x', 'p'] }), { turns: { w: 'working', i: 'idle', x: 'unknown', p: 'unknown' } })
  assert.deepEqual(await createLatticeEffects({ bots: {} })('turns.read', { botIds: ['w'] }), { turns: { w: 'unknown' } })
})

test('turns.read: runningState counts a command wait; a missing method falls back to currentTurn', async () => {
  // The scheduler reports a command wait while the native turn is idle.
  const transport = { runningState: id => id === 'c' ? 'working' : id === 'x' ? (() => { throw new Error('down') })() : id === 'a' ? Promise.reject(new Error('down')) : 'idle',
    currentTurn: () => ({ state: 'idle' }) }
  assert.deepEqual(await createLatticeEffects({ bots: {}, transport })('turns.read', { botIds: ['c', 'i', 'x', 'a'] }),
    { turns: { c: 'working', i: 'idle', x: 'unknown', a: 'unknown' } })
  assert.deepEqual(await createLatticeEffects({ bots: {}, transport: { currentTurn: () => ({ state: 'working' }) } })('turns.read', { botIds: ['w'] }), { turns: { w: 'working' } })
})

test('claude.load: the Claude seats that work now and the cap (LATTICE_CLAUDE_CAP, default 5); deleting and other harnesses are left out', async () => {
  const bots = { listForClient: async () => [{ id: 'c1', harness: 'claude' }, { id: 'c2', harness: 'claude' }, { id: 'c3', harness: 'claude', deleting: true }, { id: 'k1', harness: 'codex' }] }
  const transport = { runningState: id => id === 'c1' || id === 'k1' ? 'working' : 'idle' }
  const saved = process.env.LATTICE_CLAUDE_CAP
  try {
    delete process.env.LATTICE_CLAUDE_CAP
    assert.deepEqual(await createLatticeEffects({ bots, transport })('claude.load', {}), { cap: 5, claude: ['c1', 'c2'], working: ['c1'] })
    process.env.LATTICE_CLAUDE_CAP = '3'
    assert.equal((await createLatticeEffects({ bots, transport })('claude.load', {})).cap, 3)
    process.env.LATTICE_CLAUDE_CAP = 'x'
    assert.equal((await createLatticeEffects({ bots, transport })('claude.load', {})).cap, 5, 'an unreadable cap is the default')
  } finally { if (saved === undefined) delete process.env.LATTICE_CLAUDE_CAP; else process.env.LATTICE_CLAUDE_CAP = saved }
})

test('messages.send runs the messenger in the actor scope named by from, outside any request scope', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks')
  const scope = new AsyncLocalStorage(), seen = []
  // Like conversation-assembly: a send with no actor in scope is refused (CONVERSATION_CONTEXT_REQUIRED).
  const messenger = { sendmessage: async input => {
    const actor = scope.getStore()
    if (!actor) throw new Error('CONVERSATION_CONTEXT_REQUIRED')
    seen.push([input.from, actor]); return { delivery: 'queued', delivery_id: 'd1' }
  } }
  const effect = createLatticeEffects({ bots: {}, messenger, runAs: (actor, send) => scope.run(actor, send) })
  assert.deepEqual(await effect('messages.send', { from: 'scheduler', target: 'p', message: 'm' }), { delivery: 'queued', deliveryId: 'd1' })
  assert.deepEqual(await effect('messages.send', { from: 'bot-a', target: 'p', message: 'm' }), { delivery: 'queued', deliveryId: 'd1' })
  assert.deepEqual(seen, [['scheduler', { kind: 'scheduler' }], ['bot-a', { kind: 'bot', botId: 'bot-a' }]])
  // Without a scope port the old behavior stays: the error is thrown, the child keeps the notice unacked.
  await assert.rejects(createLatticeEffects({ bots: {}, messenger })('messages.send', { from: 'scheduler', target: 'p', message: 'm' }), /CONVERSATION_CONTEXT_REQUIRED/)
})

// a156 (Flora R3, Approval Box extension): ownerTask and link are seat-queue writes; ownerTask refreshes its chart's subscribers like run;
// the child's LATTICE_OWNER_TASK_REFUSED keeps its code (403 path); an old child's LATTICE_INVALID_METHOD-like failure is 503.
test('a156: ownerTask (its project lane) and link (the shared lane) queue as writes; ownerTask refreshes its subscribers; the refusal code passes', async () => {
  const f = fixture({ respond: (method, params) => method === 'ownerTask' && params.args[0] === 'refused'
    ? Object.assign(new Error('refused'), { code: 'LATTICE_OWNER_TASK_REFUSED', status: 403 }) : method === 'link' && params.taskId === 'old'
      ? Object.assign(new Error('x'), { code: 'SOMETHING_ELSE' }) : null })
  const heard = []
  f.facade.subscribe('alpha', snapshot => heard.push(snapshot.version))
  await tick()
  const release = f.hold()
  const writes = [f.facade.ownerTask({ projectId: 'alpha', args: ['todo', 'add'], input: { a: 1 } }), f.facade.link({ projectId: 'alpha', plan: 'p', taskId: 't' })]
  await tick()
  assert.deepEqual(f.calls.filter(call => ['ownerTask', 'link'].includes(call[0])).map(call => call[0]), ['ownerTask', 'link'], 'two lanes, sent beside each other')
  release(); await Promise.all(writes)
  assert.deepEqual(f.calls.filter(call => ['ownerTask', 'link'].includes(call[0])), [['ownerTask', { projectId: 'alpha', args: ['todo', 'add'], input: { a: 1 } }], ['link', { projectId: 'alpha', plan: 'p', taskId: 't' }]])
  assert.ok(f.calls.some(call => call[0] === 'refresh' && call[1].projectIds?.[0] === 'alpha'), 'ownerTask asks the child for a fresh snapshot')
  await assert.rejects(f.facade.ownerTask({ projectId: 'alpha', args: ['refused'] }), { code: 'LATTICE_OWNER_TASK_REFUSED', status: 403 })
  await assert.rejects(f.facade.link({ projectId: 'alpha', plan: 'p', taskId: 'old' }), { code: 'LATTICE_UNAVAILABLE', status: 503 })
})
