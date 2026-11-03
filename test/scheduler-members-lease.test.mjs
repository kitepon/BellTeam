import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BotRegistry } from '../src/bot-registry.mjs'
import { RoomRegistry } from '../src/room-registry.mjs'
import { BotScheduler } from '../src/scheduler.mjs'
const now = new Date('2030-01-01T00:00:01Z')
const due = { kind: 'once', at: '2030-01-01T00:00:00Z', prompt: 'Synthetic' }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
// Test double checks the caller's opaque identity and finish point, not Kiro's gate internals.
function admission() {
  const live = new Set(), entered = [], finished = []
  return { live, entered, finished, closed: false, async withLease(operation, { lease } = {}) {
    if (lease) { assert.ok(live.has(lease)); return operation(lease) }
    if (this.closed) throw Object.assign(new Error('closed'), { code: 'MEMBERS_NOT_ACCEPTED', outcome: 'not_accepted' })
    const current = Object.freeze({ testLease: entered.length }); entered.push(current); live.add(current)
    try { return await operation(current) } finally { live.delete(current); finished.push(current) }
  } }
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'scheduler-members-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: ['a', 'b'].map(id => ({ id: `bot-${id}`, displayName: id, harness: 'grok', session: `bot-${id}`, project: '/unused' })) }))
  const bots = new BotRegistry({ seedPath, botsRoot: join(root, 'bots') }); await bots.initialize()
  const schedule = await bots.setSchedule('bot-a', due), gate = admission()
  return { bots, schedule, gate, root }
}

test('claim, fresh reads and dispatch share one live lease through native acceptance', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(), observed = []
  const refresh = f.bots.refresh.bind(f.bots), claim = f.bots.claimDue.bind(f.bots), list = f.bots.listSchedules.bind(f.bots)
  f.bots.refresh = async options => { if (options?.membersLease) observed.push(options.membersLease); return refresh() }
  f.bots.listSchedules = async (id, options) => { if (options?.membersLease) observed.push(options.membersLease); return list(id) }
  f.bots.claimDue = async (input, options) => { observed.push(options.membersLease); assert.ok(f.gate.live.has(options.membersLease)); return claim(input) }
  const scheduler = new BotScheduler({ registry: f.bots, membersAdmission: f.gate, messenger: { async sendmessage(input, options) {
    observed.push(options.membersLease); assert.ok(f.gate.live.has(options.membersLease)); entered.resolve(); await release.promise
  } } })
  const running = scheduler.runDue(now); await entered.promise
  f.gate.closed = true
  assert.equal(f.gate.finished.length, 0)
  release.resolve(); await running
  assert.equal(f.gate.entered.length, 1); assert.equal(f.gate.finished.length, 1)
  assert.ok(observed.length >= 4); assert.ok(observed.every(lease => lease === f.gate.entered[0]))
})

test('claim response uncertainty never dispatches or retries the unchanged tuple', async t => {
  const f = await fixture(t), claim = f.bots.claimDue.bind(f.bots)
  let claims = 0, sent = 0
  f.bots.claimDue = async input => { if (++claims === 1) throw Object.assign(new Error('unknown claim'), { outcome: 'unknown' }); return claim(input) }
  const scheduler = new BotScheduler({ registry: f.bots, messenger: { async sendmessage() { sent++ } } })
  await scheduler.runDue(now); await scheduler.runDue(now)
  assert.equal(claims, 1); assert.equal(sent, 0)
  await f.bots.setSchedule('bot-a', { ...due, id: f.schedule.id })
  await scheduler.runDue(now)
  assert.equal(claims, 2); assert.equal(sent, 1)
})

test('stop after claim consumes the occurrence without emission or rewind', async t => {
  const f = await fixture(t), claim = f.bots.claimDue.bind(f.bots)
  let epoch = 0, sent = 0
  f.bots.claimDue = async input => { const result = await claim(input); epoch++; return result }
  const scheduler = new BotScheduler({ registry: f.bots, admitWork: () => { const captured = epoch; return () => {
    if (captured !== epoch) throw Object.assign(new Error('paused epoch'), { code: 'AI_GLOBAL_PAUSED' })
  } }, messenger: { async sendmessage() { sent++ } } })
  await scheduler.runDue(now); await scheduler.runDue(now)
  assert.equal(sent, 0); assert.equal((await f.bots.listSchedules('bot-a'))[0].enabled, false)
})

test('Room claim emits the latest targets snapshot after same-revision member cleanup', async t => {
  const f = await fixture(t)
  await f.bots.removeSchedule('bot-a', f.schedule.id)
  const rooms = new RoomRegistry({ roomsRoot: join(f.root, 'rooms'), bots: f.bots, roomId: () => 'room-a' })
  await rooms.initialize(); await rooms.create({ name: 'Synthetic', memberIds: ['bot-a', 'bot-b'] })
  const original = await rooms.setSchedule('room-a', { ...due, targets: ['bot-b'] })
  const claim = rooms.claimDue.bind(rooms)
  rooms.claimDue = async input => { await rooms.removeBot('bot-b'); return claim(input) }
  let emitted
  const scheduler = new BotScheduler({ registry: f.bots, rooms, messenger: {}, roomMessenger: { async sendroommessage(input) { emitted = input } } })
  await scheduler.runDue(now)
  assert.deepEqual(emitted.targets, [])
  assert.equal((await rooms.listSchedules('room-a'))[0].revision, original.revision)
})

test('manual execution leaves due state intact and prepareResume skips under one lease', async t => {
  const f = await fixture(t), observed = []
  const scheduler = new BotScheduler({ registry: f.bots, membersAdmission: f.gate, messenger: { async sendmessage(input, options) { observed.push(options.membersLease) } } })
  await scheduler.runBotSchedule('bot-a', f.schedule.id)
  assert.deepEqual((await f.bots.listSchedules('bot-a'))[0], f.schedule)
  await scheduler.prepareResume(now)
  const [saved] = await f.bots.listSchedules('bot-a')
  assert.equal(saved.enabled, false); assert.equal(saved.lastRunAt, null)
  assert.equal(f.gate.entered.length, 2); assert.equal(f.gate.finished.length, 2)
  assert.equal(observed[0], f.gate.entered[0])
})

test('a long command continues after the scheduler lease has finished', async t => {
  const f = await fixture(t), completion = deferred()
  await f.bots.setSchedule('bot-a', { id: f.schedule.id, kind: 'once', at: due.at, command: 'synthetic' })
  const scheduler = new BotScheduler({ registry: f.bots, membersAdmission: f.gate, messenger: {}, runCommand: () => completion.promise })
  await scheduler.runDue(now)
  assert.equal(f.gate.live.size, 0); assert.equal(scheduler.commandJobs.size, 1)
  const job = [...scheduler.commandJobs][0]
  completion.resolve({ code: 0, stdout: '', stderr: '' }); await job.completion
  assert.equal(scheduler.commandJobs.size, 0)
})
