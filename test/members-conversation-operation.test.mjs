import assert from 'node:assert/strict'
import test from 'node:test'
import { BotAdministration } from '../src/bot-administration.mjs'
import { BotScheduler } from '../src/scheduler.mjs'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const rejected = () => Object.assign(new Error('MODULE_OPERATION_NOT_ACCEPTED'), { status: 503, outcome: 'not_accepted' })
const now = new Date('2030-01-01T00:00:01Z')
const schedule = { id: 'schedule-a', enabled: true, revision: 1, nextRunAt: '2030-01-01T00:00:00Z', prompt: 'Synthetic', targets: ['old'] }

// Caller-only double; the common owner's direct tests establish atomic reservation/IPC authority.
function moduleOperations() {
  const live = new Set(), contexts = [], finished = []
  return { contexts, finished, closed: false,
    reserve() {
      if (this.closed) throw rejected()
      const context = Object.freeze({ membersLease: Object.freeze({}), conversationLease: Object.freeze({}) })
      live.add(context); contexts.push(context); return context
    },
    assert(context) { assert.ok(live.has(context)); return context },
    finish(context) { this.assert(context); live.delete(context); finished.push(context) },
    withContext(operation, context) {
      const owned = context === undefined, accepted = owned ? this.reserve() : this.assert(context)
      return Promise.resolve(operation(accepted)).finally(() => { if (owned) this.finish(accepted) })
    },
  }
}

for (const name of ['runDue', 'prepareResume', 'runBotSchedule', 'runRoomSchedule', 'remove']) {
  test(`${name} rejects the combined reservation before reads, native effects or consumption`, async () => {
    const ops = moduleOperations(); ops.closed = true
    const unexpected = () => assert.fail('operation before combined admission')
    const bots = { refresh: unexpected, get: unexpected }, rooms = { refresh: unexpected, removeBot: unexpected }
    const transport = { membersAdmission: { enter: unexpected }, stop: unexpected }
    const operation = name === 'remove'
      ? new BotAdministration({ bots, rooms, transport, moduleOperations: ops }).remove('bot-a')
      : new BotScheduler({ registry: bots, rooms, transport, moduleOperations: ops })[name](
        ...(name === 'runDue' || name === 'prepareResume' ? [now] : ['owner-a', schedule.id]))
    await assert.rejects(operation, { status: 503, outcome: 'not_accepted' })
    assert.equal(ops.contexts.length, 0); assert.equal(ops.finished.length, 0)
  })
}

test('due Room work keeps one combined context through claim and publication after closure', async () => {
  const ops = moduleOperations(), calls = []
  const check = (name, context) => { assert.equal(context, ops.contexts[0]); ops.assert(context); calls.push(name) }
  const bots = { async refresh(context) { check('bots.read', context) }, values: () => [] }
  const rooms = {
    async refresh(context) { check('rooms.read', context) }, values: () => [{ id: 'room-a' }],
    async listSchedules(id, context) { check('rooms.list', context); return [schedule] },
    async claimDue(input, context) { check('rooms.claim', context); ops.closed = true; return { ...schedule, targets: ['latest'] } },
  }
  const scheduler = new BotScheduler({ registry: bots, rooms, moduleOperations: ops, messenger: {},
    membersAdmission: { withLease: () => assert.fail('new members-only root') },
    roomMessenger: { async sendroommessage(input, context) { check('rooms.send', context); assert.deepEqual(input.targets, ['latest']) } } })
  await scheduler.runDue(now)
  assert.deepEqual(calls, ['bots.read', 'rooms.read', 'rooms.list', 'rooms.claim', 'rooms.send'])
  assert.deepEqual(ops.finished, ops.contexts); assert.equal(ops.contexts.length, 1)
})

test('manual Bot and Room execution reuse the supplied object without reserving or finishing it', async () => {
  const ops = moduleOperations(), context = ops.reserve(), calls = []
  ops.closed = true
  const check = options => { assert.equal(options, context); ops.assert(options) }
  const registry = { async refresh(options) { check(options) }, get: id => ({ id }), async listSchedules(id, options) { check(options); return [schedule] } }
  const scheduler = new BotScheduler({ registry, rooms: registry, moduleOperations: ops,
    messenger: { async sendmessage(input, options) { check(options); calls.push('bot') } },
    roomMessenger: { async sendroommessage(input, options) { check(options); calls.push('room') } } })
  await scheduler.runBotSchedule('bot-a', schedule.id, context)
  await scheduler.runRoomSchedule('room-a', schedule.id, context)
  assert.deepEqual(calls, ['bot', 'room']); assert.equal(ops.contexts.length, 1); assert.equal(ops.finished.length, 0)
  ops.finish(context)
})

test('prepareResume skips both registries under the one combined context', async () => {
  const ops = moduleOperations(), skips = []
  const check = context => { assert.equal(context, ops.contexts[0]); ops.assert(context) }
  const registry = { async refresh(context) { check(context) }, values: () => [{ id: 'owner-a' }],
    async listSchedules(id, context) { check(context); return [schedule] },
    async skipDue(input, context) { check(context); skips.push(input); ops.closed = true } }
  await new BotScheduler({ registry, rooms: registry, moduleOperations: ops }).prepareResume(now)
  assert.equal(skips.length, 2); assert.equal(skips[0].botId, 'owner-a'); assert.equal(skips[1].roomId, 'owner-a')
  assert.equal(ops.contexts.length, 1); assert.deepEqual(ops.finished, ops.contexts)
})

for (const pending of [false, true]) {
  test(`202 deletion holds both reservations until its background ends (pending=${pending})`, async () => {
    const ops = moduleOperations(), entered = deferred(), release = deferred(), ended = deferred(), calls = []
    const finish = ops.finish.bind(ops)
    ops.finish = context => { finish(context); ended.resolve() }
    const check = context => { assert.equal(context, ops.contexts[0]); ops.assert(context) }
    const bots = { async refresh(context) { check(context) }, get: () => pending ? null : { id: 'bot-a' },
      async hasPendingRemoval(id, context) { check(context); return pending },
      async remove(id, context) { check(context); calls.push('remove'); entered.resolve(); await release.promise; return { id } } }
    const admin = new BotAdministration({ bots, moduleOperations: ops,
      transport: { membersAdmission: { enter: () => assert.fail('members-only admission') },
        async stop(bot, version, context) { check(context); assert.equal(version, undefined); calls.push('stop') } },
      rooms: { async removeBot(id, context) { check(context); calls.push('rooms.remove'); ops.closed = true } },
      writeLog: line => assert.fail(line) })
    assert.deepEqual(await admin.remove('bot-a'), { deleting: 'bot-a' })
    await entered.promise
    assert.equal(ops.finished.length, 0)
    release.resolve(); await ended.promise
    assert.deepEqual(calls, pending ? ['remove'] : ['stop', 'rooms.remove', 'remove'])
    assert.equal(ops.contexts.length, 1); assert.deepEqual(ops.finished, ops.contexts)
  })
}

test('a failed fresh target check releases the combined reservation before 202', async () => {
  const ops = moduleOperations()
  const admin = new BotAdministration({ moduleOperations: ops, transport: {},
    bots: { async refresh() { throw Object.assign(new Error('unavailable'), { outcome: 'unknown' }) } } })
  await assert.rejects(admin.remove('bot-a'), { outcome: 'unknown' })
  assert.equal(ops.contexts.length, 1); assert.deepEqual(ops.finished, ops.contexts)
})
