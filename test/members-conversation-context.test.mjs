import assert from 'node:assert/strict'
import test from 'node:test'
import { BotScheduler } from '../src/scheduler.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'
import { startMemberRemoval } from '../src/members/deletion.mjs'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('Room read, due claim and latest snapshot delivery retain the accepted lease after closure', async () => {
  const admission = new MembersAdmission(), calls = []
  let context, ticket
  const check = (name, options) => {
    assert.equal(options, context)
    admission.assertLease(options.membersLease)
    calls.push(name)
  }
  const now = new Date('2030-01-01T00:00:01Z')
  const schedule = { id: 'schedule-a', enabled: true, revision: 1, nextRunAt: '2030-01-01T00:00:00Z', prompt: 'Synthetic', targets: ['old'] }
  const registry = { async refresh(options) { context = options }, values: () => [] }
  const rooms = {
    async refresh(options) { check('room.refresh', options); ticket = admission.close() },
    values: () => [{ id: 'room-a' }],
    async listSchedules(id, options) { check('room.list', options); return [schedule] },
    async claimDue(input, options) { check('room.claim', options); assert.equal(input.roomId, 'room-a'); return { ...schedule, targets: ['latest'] } },
  }
  const scheduler = new BotScheduler({ registry, rooms, membersAdmission: admission, messenger: {},
    roomMessenger: { async sendroommessage(input, options) { check('room.send', options); assert.deepEqual(input.targets, ['latest']) } } })
  await scheduler.runDue(now)
  assert.deepEqual(calls, ['room.refresh', 'room.list', 'room.claim', 'room.send'])
  await admission.drain(ticket)
  assert.throws(() => admission.assertLease(context.membersLease), { code: 'MEMBERS_NOT_ACCEPTED' })
})

test('accepted deletion retains the same Room context and delays drain until background removal ends', async () => {
  const admission = new MembersAdmission(), roomEntered = deferred(), release = deferred(), finished = deferred(), calls = []
  const finish = admission.finish.bind(admission)
  admission.finish = lease => { finish(lease); finished.resolve() }
  const bot = { id: 'bot-fixture' }
  let context
  const check = (name, options) => { assert.equal(options, context); admission.assertLease(options.membersLease); calls.push(name) }
  const bots = {
    async refresh(options) { context = options }, get: () => bot,
    async remove(id, options) { check('remove', options); assert.equal(id, bot.id); return { id } },
  }
  const result = await startMemberRemoval(bot.id, { bots,
    transport: { membersAdmission: admission, async stop(value, version, options) { assert.equal(value, bot); assert.equal(version, undefined); check('stop', options) } },
    rooms: { async removeBot(id, options) { check('rooms.remove', options); roomEntered.resolve(); await release.promise } },
    onRemoved: id => { assert.equal(id, bot.id); calls.push('removed') }, writeLog: line => assert.fail(line),
  })
  assert.deepEqual(result, { deleting: bot.id })
  await roomEntered.promise
  const ticket = admission.close()
  let drained = false
  const drain = admission.drain(ticket).then(() => { drained = true })
  await Promise.resolve()
  assert.equal(drained, false)
  release.resolve(); await finished.promise; await drain
  assert.deepEqual(calls, ['stop', 'rooms.remove', 'remove', 'removed'])
})
