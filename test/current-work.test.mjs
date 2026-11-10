import test from 'node:test'
import assert from 'node:assert/strict'
import { CurrentWork, workSummaryInput } from '../src/current-work.mjs'

const botId = 'bot-test', sessionId = botId, launchId = 'a'.repeat(32)
const source = () => ({ sourceSession: sessionId, source: { launch: { session_id: sessionId, launch_id: launchId }, boundary: null } })
const row = (turnId = 'turn-a', overrides = {}) => ({ session_id: sessionId, launch_id: launchId, harness: 'codex-cli', turn: { state: 'running', turn_id: turnId }, ...overrides })
const data = (...seats) => ({ schema: 'aiterm.seat-turns.v1', seats })
function fixture(t) {
  let clock = 0, current = true
  const events = [], work = new CurrentWork({ monotonic: () => clock, now: () => new Date(1_800_000_000_000 + clock).toISOString(), notify: id => events.push(id) })
  t.after(() => work.close())
  const targets = [{ botId, sessionId, current: () => current }]
  const read = () => work.beginRead(targets)
  const observe = (value = data(row())) => work.endRead(read(), value)
  const snapshot = () => work.snapshot(botId, sessionId)
  const binding = () => work.selfBinding(botId, sessionId, source())
  const update = summary => work.update(botId, sessionId, { expected: binding(), summary }, source(), () => current)
  return { work, read, observe, snapshot, binding, update, events, set clock(value) { clock = value }, set current(value) { current = value } }
}
async function report(f, summary = '原要求の保存境界を確認中') { const p = f.update(summary); f.observe(); return p }

test('all DTO keys start unknown; positive running/idle and unsupported/null are separate', t => {
  const f = fixture(t)
  assert.deepEqual(f.snapshot(), { state: 'unknown', summary: null, summaryStatus: 'missing', summaryUpdatedAt: null, observedAt: null, source: null })
  f.observe(); assert.equal(f.snapshot().state, 'working'); assert.equal(f.snapshot().summary, null)
  f.observe(data(row(null, { turn: { state: 'idle' } }))); assert.equal(f.snapshot().state, 'idle'); assert.equal(f.binding(), null)
  f.observe(data(row('a', { harness: 'claude-code', turn: null }))); assert.equal(f.snapshot().state, 'unknown')
})
test('self report waits for a read that starts after ingress; stable observations retain UUID revision', async t => {
  const f = fixture(t); f.observe(); const before = f.binding(), oldRead = f.read()
  const p = f.update('  通常mainへの採用を照合中  '); let settled = false; p.then(() => { settled = true })
  f.work.endRead(oldRead, data(row())); await Promise.resolve(); assert.equal(settled, false)
  assert.deepEqual(f.binding(), before)
  f.observe(); const result = await p
  assert.equal(result.currentWork.summary, '通常mainへの採用を照合中')
  assert.equal(result.currentWork.source, 'self_reported'); assert.notEqual(result.currentWorkBinding.revision, before.revision)
  const next = f.binding(); f.observe(); assert.deepEqual(f.binding(), next)
})
test('only captured self launch can read binding or update; expected does not grant identity', t => {
  const f = fixture(t); f.observe(); const expected = f.binding()
  assert.equal(f.work.selfBinding(botId, sessionId, { sourceSession: 'other' }), null)
  assert.throws(() => f.work.update(botId, sessionId, { expected, summary: 'x' }, { sourceSession: 'other' }), { code: 'CURRENT_WORK_FORBIDDEN' })
  const old = source(); old.source.launch.launch_id = 'b'.repeat(32)
  assert.throws(() => f.work.update(botId, sessionId, { expected, summary: 'x' }, old), { status: 403 })
})
test('old launch/turn/revision and concurrent updates conflict without a queue', async t => {
  const f = fixture(t); f.observe(); const expected = f.binding()
  for (const change of [{ revision: '11111111-1111-4111-8111-111111111111' }, { turnId: 'old' }, { launchId: 'b'.repeat(32) }])
    assert.throws(() => f.work.update(botId, sessionId, { expected: { ...expected, ...change }, summary: 'x' }, source()), { status: 409 })
  const p = f.update('x'); assert.throws(() => f.update('y'), { code: 'CURRENT_WORK_CONFLICT' })
  f.observe(); await p; assert.equal(f.snapshot().summary, 'x')
})
test('a delayed older read cannot replace a newer generation; waiting writer rejects a turn change', async t => {
  const f = fixture(t); f.observe(); const older = f.read(), newer = f.read()
  const p = f.update('a'); const rejection = assert.rejects(p, { code: 'CURRENT_WORK_CONFLICT' })
  f.work.endRead(newer, data(row('turn-b'))); await rejection
  f.work.endRead(older, data(row())); assert.equal(f.binding().turnId, 'turn-b'); assert.equal(f.snapshot().summary, null)
})
test('invalid schema, duplicate rows, absent launch and failed observation are unknown', t => {
  const f = fixture(t)
  for (const invalid of [null, { schema: 'wrong', seats: [] }, data(row(), row()), data(row('a', { launch_id: null })), data(row('a', { turn: null })), data(), { ...data(row()), error: '' }, data(row('a', { turn: { state: 'idle', turn_id: 'contradiction' } }))]) {
    f.observe(); const last = f.snapshot().observedAt; f.clock = 100
    f.observe(invalid); assert.equal(f.snapshot().state, 'unknown'); assert.equal(f.snapshot().observedAt, last)
  }
})
test('terminal same-turn reads idle at once and fences reads; another turn done does not clear current work', async t => {
  const f = fixture(t); f.observe(); await report(f); const old = f.read()
  const done = { schema: 'aiterm.agent-wait-result.v1', outcome: 'done', session_id: sessionId, launch_id: launchId, turn_id: 'other' }
  f.work.completedTurn(done); assert.equal(f.snapshot().summaryStatus, 'current')
  f.work.completedTurn({ ...done, turn_id: 'turn-a' }); assert.equal(f.snapshot().state, 'idle'); assert.equal(f.snapshot().summary, null)
  f.work.endRead(old, data(row())); assert.equal(f.snapshot().state, 'idle')
  f.observe(); assert.equal(f.snapshot().state, 'unknown')
  f.observe(data(row('turn-b'))); assert.equal(f.snapshot().state, 'working'); assert.equal(f.snapshot().summary, null)
})
test('stop acceptance clears summary to unknown and ignores an in-flight pre-stop observation', async t => {
  const f = fixture(t); f.observe(); await report(f); const old = f.read()
  f.work.invalidate(botId); assert.equal(f.snapshot().state, 'unknown'); assert.equal(f.snapshot().summary, null)
  f.work.endRead(old, data(row())); assert.equal(f.snapshot().state, 'unknown')
  f.observe(); assert.equal(f.snapshot().state, 'working'); assert.equal(f.snapshot().summary, null)
})
test('native 15-second expiry hides summary, retains last observedAt, and changes revision before reuse', async t => {
  const f = fixture(t); f.observe(); await report(f); const before = f.binding(), observed = f.snapshot().observedAt
  f.clock = 15_000; assert.equal(f.snapshot().state, 'unknown'); assert.equal(f.snapshot().summaryStatus, 'missing'); assert.equal(f.snapshot().observedAt, observed)
  f.observe(); assert.notEqual(f.binding().revision, before.revision); assert.equal(f.snapshot().summary, null)
})
test('ten-minute summary expiry is stale while native observations stay fresh; clear returns missing', async t => {
  const f = fixture(t); f.observe(); await report(f); const updated = f.snapshot().summaryUpdatedAt
  for (let time = 10_000; time <= 600_000; time += 10_000) { f.clock = time; f.observe() }
  assert.deepEqual({ ...f.snapshot(), observedAt: null }, { state: 'working', summary: null, summaryStatus: 'stale', summaryUpdatedAt: updated, observedAt: null, source: 'self_reported' })
  await report(f, null); assert.equal(f.snapshot().summaryStatus, 'missing'); assert.equal(f.snapshot().summaryUpdatedAt, null)
})
test('parent restart issues a different UUID even for the same native turn', t => {
  const a = fixture(t), b = fixture(t); a.observe(); b.observe()
  assert.notEqual(a.binding().revision, b.binding().revision)
  assert.throws(() => b.work.update(botId, sessionId, { expected: a.binding(), summary: 'old parent' }, source()), { status: 409 })
})
test('bounded update times out without starting any observation; close settles pending updates', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(t); f.observe()
  const p = f.update('x'); const failed = assert.rejects(p, { code: 'CURRENT_WORK_UNAVAILABLE' })
  t.mock.timers.tick(15_000); await failed; assert.equal(f.snapshot().summary, null)
  const another = f.update('y'); const closed = assert.rejects(another, { status: 503 }); f.work.close(); await closed
})
test('Unicode codepoint, control-character and exact shape boundaries; plain markup remains text', t => {
  const f = fixture(t); f.observe(); const expected = f.binding()
  assert.equal(workSummaryInput({ expected, summary: '😀'.repeat(160) }).summary.length, 320)
  assert.equal(workSummaryInput({ expected, summary: '<b>検証中</b>' }).summary, '<b>検証中</b>')
  for (const summary of ['', ' ', '😀'.repeat(161), 'a\nb', 'a\tb', '\u0085', '\u2028', '\u2029', 3, {}])
    assert.throws(() => workSummaryInput({ expected, summary }), { code: 'CURRENT_WORK_INPUT_INVALID' })
  assert.throws(() => workSummaryInput({ expected, summary: null, botId }), { status: 400 })
})
test('uncertainty and session replacement invalidate pending and prevent summary inheritance', async t => {
  const f = fixture(t); f.observe(); await report(f); const p = f.update('later'), failed = assert.rejects(p, { status: 503 })
  f.current = false; f.observe(); await failed; assert.equal(f.snapshot().state, 'unknown')
  assert.equal(f.work.snapshot(botId, 'other-session').summary, null)
})

test('captured actor cannot be changed while waiting and malformed observations cannot make a report succeed', async t => {
  const f = fixture(t); f.observe(); const actor = source()
  const p = f.work.update(botId, sessionId, { expected: f.binding(), summary: 'original' }, actor)
  actor.source.launch.launch_id = 'b'.repeat(32)
  f.observe(); assert.equal((await p).currentWork.summary, 'original')
  const waiting = f.update('next'), rejected = assert.rejects(waiting, { status: 503 })
  f.observe(data(row(), row())); await rejected; assert.equal(f.snapshot().summary, null)
})
test('expiry timer emits state invalidation without AI or a client read; same-row refresh does not emit', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(t); f.observe()
  const eventCount = f.events.length; f.observe(); assert.equal(f.events.length, eventCount)
  f.clock = 15_000; t.mock.timers.tick(15_000)
  assert.equal(f.events.length, eventCount + 1); assert.equal(f.snapshot().state, 'unknown')
})
test('Aiterm 0.70.7 unread: a seat whose terminal was not read keeps its observation, is never absent, then expires', t => {
  const f = fixture(t); f.observe(); assert.equal(f.snapshot().state, 'working')
  f.observe({ ...data(), unread: [sessionId] })
  assert.equal(f.snapshot().state, 'working')
  assert.deepEqual(f.work.turn(botId).state, 'working', 'after_turn does not see an unread working seat as idle')
  f.clock = 16_000; f.observe({ ...data(), unread: [sessionId] })
  assert.equal(f.snapshot().state, 'unknown')
  assert.equal(f.work.turn(botId).state, 'unknown')
  f.observe(data()); assert.equal(f.work.turn(botId).state, 'idle', 'an answered read without the row is still absent')
})
