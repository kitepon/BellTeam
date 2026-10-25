import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'
import { BotRegistry } from '../src/bot-registry.mjs'
import { RoomRegistry } from '../src/room-registry.mjs'
import { BotScheduler } from '../src/scheduler.mjs'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const now = new Date('2026-10-25T11:25:01Z')
const due = { kind: 'once', at: '2026-10-25T11:25:00Z', prompt: 'old prompt' }
async function fixture(t, room = false) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-schedule-generation-')); t.after(() => rm(root, { recursive: true, force: true }))
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [{ id: 'bot-a', displayName: 'A', harness: 'grok', session: 'bot-a', project: '/unused' }] }))
  const bots = new BotRegistry({ seedPath, botsRoot: join(root, 'bots'), id: () => 'once-id' }); await bots.initialize()
  const registry = room ? new RoomRegistry({ roomsRoot: join(root, 'rooms'), bots, roomId: () => 'room-a', id: () => 'once-id' }) : bots
  if (room) { await registry.initialize(); await registry.create({ name: 'Synthetic', memberIds: ['bot-a'] }) }
  const owner = room ? 'room-a' : 'bot-a'
  const entered = deferred(), delivery = deferred(), sent = []
  const send = async value => { sent.push(value); entered.resolve(); await delivery.promise }
  const scheduler = new BotScheduler({ registry: room ? { async refresh() {}, values() { return [] } } : bots,
    messenger: { sendmessage: send }, ...(room ? { rooms: registry, roomMessenger: { sendroommessage: send } } : {}) })
  await registry.setSchedule(owner, due)
  return { root, registry, scheduler, owner, entered, delivery, sent }
}

for (const room of [false, true]) test(`${room ? 'room' : 'bot'} old delivery completion preserves a future same-ID update`, async t => {
  const f = await fixture(t, room), running = f.scheduler.runDue(now)
  await f.entered.promise
  const future = await f.registry.setSchedule(f.owner, { ...due, id: 'once-id', at: '2026-10-25T11:45:00Z', prompt: 'future prompt' })
  f.delivery.resolve(); await running
  assert.deepEqual((await f.registry.listSchedules(f.owner))[0], future)
  assert.equal(future.enabled, true); assert.equal(future.nextRunAt, '2026-10-25T11:45:00.000Z')
  assert.equal(f.sent.length, 1)
})

test('an explicit rearm with identical contents still survives the old completion', async t => {
  const f = await fixture(t), running = f.scheduler.runDue(now)
  await f.entered.promise
  const rearmed = await f.registry.setSchedule(f.owner, { ...due, id: 'once-id' })
  f.delivery.resolve(); await running
  assert.deepEqual((await f.registry.listSchedules(f.owner))[0], rearmed)
  assert.equal(rearmed.enabled, true)
})

test('an update while completion write is pending cannot be lost by read-modify-write interleaving', async t => {
  const f = await fixture(t), enteredWrite = deferred(), releaseWrite = deferred()
  const write = f.registry.writeScheduleDocument.bind(f.registry)
  // Keep real file reads/writes but remove unrelated profile-refresh timing
  // from this precise write interleaving.
  f.registry.refresh = async () => f.registry
  f.registry.readScheduleDocument = async () => JSON.parse(readFileSync(join(f.root, 'bots/bot-a/schedule.json'), 'utf8'))
  let hold = true, secondWriteEntered = false
  f.registry.writeScheduleDocument = async (...args) => {
    if (hold) { hold = false; enteredWrite.resolve(); await releaseWrite.promise }
    else secondWriteEntered = true
    return write(...args)
  }
  const running = f.scheduler.runDue(now); await f.entered.promise; f.delivery.resolve(); await enteredWrite.promise
  const updating = f.registry.setSchedule(f.owner, { ...due, id: 'once-id', at: '2026-10-25T11:45:00Z' })
  await new Promise(resolve => setImmediate(resolve))
  if (secondWriteEntered) await updating
  releaseWrite.resolve()
  const future = await updating; await running
  assert.deepEqual((await f.registry.listSchedules(f.owner))[0], future)
})

test('deleting an in-flight schedule does not resurrect it after delivery', async t => {
  const f = await fixture(t), running = f.scheduler.runDue(now)
  await f.entered.promise; await f.registry.removeSchedule(f.owner, 'once-id')
  f.delivery.resolve(); await running
  assert.deepEqual(await f.registry.listSchedules(f.owner), [])
})

test('concurrent additions keep both schedules and a failed write releases the owner', async t => {
  const f = await fixture(t)
  let next = 0; f.registry.id = () => `added-${++next}`
  await Promise.all([f.registry.setSchedule(f.owner, due), f.registry.setSchedule(f.owner, { ...due, prompt: 'second' })])
  assert.deepEqual((await f.registry.listSchedules(f.owner)).map(s => s.id).sort(), ['added-1', 'added-2', 'once-id'])
  const write = f.registry.writeScheduleDocument.bind(f.registry), fault = new Error('synthetic write failure')
  let fail = true
  f.registry.writeScheduleDocument = (...args) => { if (fail) { fail = false; throw fault } return write(...args) }
  await assert.rejects(f.registry.setSchedule(f.owner, { ...due, id: 'once-id' }), error => error === fault)
  const future = await f.registry.setSchedule(f.owner, { ...due, id: 'once-id', at: '2026-10-25T11:45:00Z' })
  assert.equal(future.enabled, true)
})

test('a skipped old generation cannot consume a newly updated overdue request', async t => {
  const f = await fixture(t), [old] = await f.registry.listSchedules(f.owner)
  const latest = await f.registry.setSchedule(f.owner, { ...due, id: 'once-id', prompt: 'new explicit request' })
  await f.registry.markScheduleRun(f.owner, old.id, now, { skipped: true, expectedRevision: old.revision ?? 0 })
  assert.deepEqual((await f.registry.listSchedules(f.owner))[0], latest)
})
