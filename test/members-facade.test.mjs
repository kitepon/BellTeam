import assert from 'node:assert/strict'
import test from 'node:test'
import { MembersAdmission } from '../src/members-admission.mjs'
import { createMembersFacade } from '../src/members-facade.mjs'
const bot = { id: 'bot-test', name: 'test', harness: 'codex', session: 'session' }
function fixture() {
  const admission = new MembersAdmission('generation'), calls = []
  const projection = { get: () => ({ ...bot, name: 'stale' }), has: () => true, keys: () => [bot.id].values(), values: () => [bot].values() }
  const facade = createMembersFacade({ admission, projection,
    request: async (method, params, context) => {
      admission.assertLease(context.membersLease); calls.push({ method, params, context })
      return method === 'profiles.read' ? { profiles: [bot] } : { bot }
    },
    callback: async (method, params, context) => {
      admission.assertLease(context.membersLease); calls.push({ method, params, context }); return { bot }
    },
  })
  return { ...facade, admission, calls }
}
test('fresh refresh and persistence keep the old opaque lease during closure, new roots reject', async () => {
  const f = fixture(), lease = f.admission.enter(), ticket = f.admission.close()
  let enters = 0
  const enter = f.admission.enter.bind(f.admission)
  f.admission.enter = (...args) => { enters++; return enter(...args) }
  assert.equal((await f.bots.refresh({ membersLease: lease }))[0].name, 'test')
  await f.bots.updateSession(bot.id, 'next', { membersLease: lease })
  await f.bots.updateFastMode(bot.id, false, { membersLease: lease })
  assert.equal(enters, 0); assert.ok(f.calls.every(call => call.context.membersLease === lease))
  f.admission.assertLease(lease)
  await assert.rejects(f.bots.refresh(), { status: 503 })
  await assert.rejects(f.bots.updateSession(bot.id, 'next'), { status: 503 })
  await assert.rejects(f.bots.refresh({ membersLease: { ...lease } }), { status: 503 })
  f.admission.finish(lease); await f.admission.drain(ticket)
})
test('fresh identity read never uses the display projection and finished callback cannot revive', async () => {
  const f = fixture()
  assert.equal(f.bots.get(bot.id).name, 'stale')
  assert.equal((await f.bots.readMember(bot.id)).name, 'test')
  const used = f.calls[0].context.membersLease
  assert.throws(() => f.admission.assertLease(used))
  await assert.rejects(f.bots.updateFastMode(bot.id, false, { membersLease: used }), { status: 503 })
})
test('malformed response is unknown and never retried', async () => {
  const admission = new MembersAdmission(), calls = []
  const f = createMembersFacade({ admission, projection: {}, request: async (...args) => { calls.push(args); return { profiles: 'bad' } } })
  await assert.rejects(f.bots.refresh(), { code: 'MEMBERS_RESULT_INVALID', outcome: 'unknown' })
  assert.equal(calls.length, 1)
})

test('caller unknown leaves the tracked real completion and old callbacks live', async () => {
  const admission = new MembersAdmission()
  let settle, used
  const completion = new Promise(resolve => { settle = resolve })
  const f = createMembersFacade({ admission, projection: {}, request: (method, params, { membersLease }) => {
    used = membersLease
    admission.trackCompletion(membersLease, completion)
    return Promise.reject(Object.assign(new Error('ACK_MISSING'), { outcome: 'unknown' }))
  }, callback: async () => ({ bot }) })
  await assert.rejects(f.bots.refresh(), { outcome: 'unknown' })
  const ticket = admission.close()
  let drained = false
  const drain = admission.drain(ticket).then(() => { drained = true })
  await f.bots.updateSession(bot.id, 'saved', { membersLease: used })
  assert.equal(drained, false)
  settle(); await drain
  assert.throws(() => admission.assertLease(used))
})

test('seat identity uses fresh read and separates confirmed absence from unavailability', async () => {
  const { resolveSeatBotId } = await import('../src/seat-mcp.mjs')
  const request = { headers: { 'x-bellteam-seat': bot.id } }
  let cause
  const bots = { has: () => true, async readMember(id) { if (cause) throw cause; return { ...bot, id } } }
  assert.equal(await resolveSeatBotId(request, bots), bot.id)
  cause = Object.assign(new Error(), { code: 'BOT_NOT_FOUND', status: 404 })
  assert.equal(await resolveSeatBotId(request, bots), null)
  cause = Object.assign(new Error(), { code: 'MEMBERS_NOT_ACCEPTED', status: 503 })
  await assert.rejects(resolveSeatBotId(request, bots), { status: 503 })
  assert.equal(await resolveSeatBotId({ headers: { 'x-bellteam-seat': '../forged' } }, bots), null)
})
