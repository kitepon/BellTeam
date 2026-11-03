import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MembersAdmission } from '../src/members-admission.mjs'
import { createModuleOperationContext } from '../src/module-operation-context.mjs'
import { BotScheduler } from '../src/scheduler.mjs'
import { BotAdministration } from '../src/bot-administration.mjs'
import { RoomRegistry } from '../src/room-registry.mjs'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const now = new Date('2030-01-01T00:00:01Z')
function gates() {
  const members = new MembersAdmission('members')
  // Kiro's conversation lifetime gate and real IPC are later integration boundaries.
  const conversation = new MembersAdmission('conversation')
  return { members, conversation, operations: createModuleOperationContext({ membersAdmission: members, conversationAdmission: conversation }) }
}

test('real common reservation rejects either closed peer before scheduler or removal effects', async () => {
  for (const peer of ['members', 'conversation']) for (const operation of ['schedule', 'remove']) {
    const f = gates(), closed = f[peer].close()
    const unexpected = () => assert.fail('effect before both admissions')
    const bots = { refresh: unexpected, get: unexpected }, transport = { membersAdmission: f.members, stop: unexpected }
    const promise = operation === 'schedule'
      ? new BotScheduler({ registry: bots, transport, moduleOperations: f.operations }).runDue(now)
      : new BotAdministration({ bots, transport, moduleOperations: f.operations }).remove('bot-a')
    await assert.rejects(promise, { status: 503, outcome: 'not_accepted' })
    const other = peer === 'members' ? f.conversation : f.members
    await other.drain(other.close())
    await f[peer].drain(closed)
  }
})

test('real reservation and Room CAS keep consumed latest targets and both leases through publication', async t => {
  const f = gates(), entered = deferred(), release = deferred()
  const root = await mkdtemp(join(tmpdir(), 'members-conversation-room-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bots = new Map(['bot-a', 'bot-b'].map(id => [id, { id, name: id }]))
  bots.refresh = async context => { if (context) f.operations.assert(context) }
  bots.listSchedules = async () => []
  const writer = new RoomRegistry({ roomsRoot: root, bots, roomId: () => 'room-a', now: () => new Date('2029-01-01Z') })
  await writer.initialize(); await writer.create({ name: 'Synthetic', memberIds: [...bots.keys()] })
  const original = await writer.setSchedule('room-a', { kind: 'once', at: '2030-01-01T00:00:00Z', prompt: 'Synthetic', targets: ['bot-b'] })
  let context, tickets, emitted
  const check = value => { assert.equal(value, context); f.operations.assert(value) }
  const rooms = {
    async refresh(value) { context = value; f.operations.assert(value); await writer.refresh() },
    values: () => writer.values(),
    async listSchedules(id, value) { check(value); return writer.listSchedules(id) },
    async claimDue(input, value) {
      check(value); tickets = [f.members.close(), f.conversation.close()]
      await writer.removeBot('bot-b')
      return writer.claimDue(input)
    },
  }
  const run = new BotScheduler({ registry: bots, rooms, moduleOperations: f.operations, messenger: {},
    roomMessenger: { async sendroommessage(input, value) { check(value); emitted = input; entered.resolve(); await release.promise } } }).runDue(now)
  await entered.promise
  assert.deepEqual(emitted.targets, [])
  let drained = false
  const drain = Promise.all([f.members.drain(tickets[0]), f.conversation.drain(tickets[1])]).then(() => { drained = true })
  await Promise.resolve(); assert.equal(drained, false)
  release.resolve(); await run; await drain
  const [saved] = await writer.listSchedules('room-a')
  assert.equal(saved.enabled, false); assert.equal(saved.lastRunAt, now.toISOString()); assert.equal(saved.revision, original.revision)
  assert.throws(() => f.operations.assert(context))
})

test('real combined admission holds both drains beyond deletion 202 until removal completion', async () => {
  const f = gates(), entered = deferred(), release = deferred(), completed = deferred()
  let context, tickets
  const bots = { async refresh(value) { context = value; f.operations.assert(value) }, get: () => ({ id: 'bot-a' }),
    async remove(id, value) { assert.equal(value, context); f.operations.assert(value); entered.resolve(); await release.promise; return { id } } }
  const admin = new BotAdministration({ bots, moduleOperations: f.operations, writeLog: line => assert.fail(line),
    rooms: { async removeBot(id, value) { assert.equal(value, context); f.operations.assert(value); tickets = [f.members.close(), f.conversation.close()] } },
    transport: { membersAdmission: f.members, async stop(bot, version, value) { assert.equal(value, context); f.operations.assert(value) } } })
  const finish = f.operations.finish
  f.operations.finish = value => { finish(value); completed.resolve() }
  assert.deepEqual(await admin.remove('bot-a'), { deleting: 'bot-a' })
  await entered.promise
  let drained = false
  const drain = Promise.all([f.members.drain(tickets[0]), f.conversation.drain(tickets[1])]).then(() => { drained = true })
  await Promise.resolve(); assert.equal(drained, false)
  release.resolve(); await completed.promise; await drain
  assert.throws(() => f.operations.assert(context))
})
