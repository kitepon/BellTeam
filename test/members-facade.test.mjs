import assert from 'node:assert/strict'
import test from 'node:test'
import { MembersAdmission } from '../src/members-admission.mjs'
import { createMembersFacade } from '../src/members-facade.mjs'
const bot = { id: 'bot-test', name: 'test', harness: 'codex', session: 'session' }
function fixture() {
  const admission = new MembersAdmission('generation'), calls = []
  const projection = { get: () => ({ ...bot, name: 'stale' }), has: () => true, keys: () => [bot.id].values(), values: () => [bot].values(), snapshot: () => ({ available: true, generation: 'generation', revision: 1, profiles: [bot] }) }
  const facade = createMembersFacade({ admission, projection,
    request: async (method, params, context) => {
      if (context.membersReadPin) admission.assertReadPin(context.membersReadPin, { method })
      else admission.assertLease(context.membersLease)
      calls.push({ method, params, context })
      return method === 'profiles.read' ? { revision: 1 } : { bot }
    },
    callback: async (method, params, context) => {
      admission.assertLease(context.membersLease); calls.push({ method, params, context }); return { bot }
    },
  })
  return { ...facade, admission, calls }
}
test('fresh refresh and persistence keep the old opaque lease during closure, new roots reject', async () => {
  const f = fixture(), lease = f.admission.enter(), ticket = f.admission.close(), membersEffect = Object.freeze({})
  let enters = 0
  const enter = f.admission.enter.bind(f.admission)
  f.admission.enter = (...args) => { enters++; return enter(...args) }
  assert.equal((await f.bots.refresh({ membersLease: lease }))[0].name, 'test')
  await f.bots.updateSession(bot.id, 'next', { membersLease: lease, membersEffect })
  await f.bots.updateFastMode(bot.id, false, { membersLease: lease })
  assert.equal(enters, 0); assert.ok(f.calls.every(call => call.context.membersLease === lease))
  assert.equal(f.calls[1].context.membersEffect, membersEffect)
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
  const used = f.calls[0].context.membersReadPin
  assert.throws(() => f.admission.assertReadPin(used))
  await assert.rejects(f.bots.updateFastMode(bot.id, false, { membersLease: used }), { status: 503 })
})
test('malformed response is unknown and never retried', async () => {
  const admission = new MembersAdmission(), calls = []
  const f = createMembersFacade({ admission, projection: {}, request: async (...args) => { calls.push(args); return { profiles: 'bad' } } })
  await assert.rejects(f.bots.refresh(), { code: 'MEMBERS_RESULT_INVALID', outcome: 'unknown' })
  assert.equal(calls.length, 1)
})

test('caller unknown holds the read generation until actual completion without granting callbacks', async () => {
  const admission = new MembersAdmission()
  let settle, used
  const completion = new Promise(resolve => { settle = resolve })
  const f = createMembersFacade({ admission, projection: {}, request: (method, params, { membersReadPin }) => {
    used = membersReadPin
    admission.trackReadCompletion(membersReadPin, completion)
    return Promise.reject(Object.assign(new Error('ACK_MISSING'), { outcome: 'unknown' }))
  }, callback: async () => ({ bot }) })
  await assert.rejects(f.bots.refresh(), { outcome: 'unknown' })
  const ticket = admission.close()
  let drained = false
  const drain = admission.drain(ticket).then(() => { drained = true })
  await assert.rejects(f.bots.updateSession(bot.id, 'saved', { membersLease: used }), { status: 503 })
  assert.equal(drained, false)
  settle(); await drain
  assert.throws(() => admission.assertReadPin(used))
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

test('an account seat name resolves to its Bot after the exact name is confirmed absent', async () => {
  const { resolveSeatBotId } = await import('../src/seat-mcp.mjs')
  const seat = id => ({ headers: { 'x-bellteam-seat': id } }), read = []
  const missing = () => Object.assign(new Error(), { code: 'BOT_NOT_FOUND', status: 404 })
  const bots = { has: () => true, async readMember(id) { read.push(id); if (id !== 'bot-7b140b27') throw missing(); return { id } } }
  assert.equal(await resolveSeatBotId(seat('bot-7b140b27-2nd-mw8hc4gr'), bots), 'bot-7b140b27')
  assert.deepEqual(read, ['bot-7b140b27-2nd-mw8hc4gr', 'bot-7b140b27'])
  assert.equal(await resolveSeatBotId(seat('bot-gone-2nd-mw8hc4gr'), bots), null)
  assert.equal(await resolveSeatBotId(seat('bot-7b140b27-2nd'), bots), null)
  read.length = 0
  assert.equal(await resolveSeatBotId(seat('bot-7b140b27-worker-mw8hc4gr'), bots), null)
  assert.deepEqual(read, ['bot-7b140b27-worker-mw8hc4gr'])
  const exact = { async readMember(id) { if (id === 'bot-x-1st-y') return { id }; throw missing() } }
  assert.equal(await resolveSeatBotId(seat('bot-x-1st-y'), exact), 'bot-x-1st-y')
  const down = { async readMember(id) { if (id.endsWith('-mw8hc4gr')) throw missing(); throw Object.assign(new Error(), { status: 503 }) } }
  await assert.rejects(resolveSeatBotId(seat('bot-7b140b27-2nd-mw8hc4gr'), down), { status: 503 })
})

test('removal and CLI queue read use closed methods with the same live effect context', async () => {
  const admission = new MembersAdmission(), lease = admission.enter(), effect = Object.freeze({}), calls = []
  const f = createMembersFacade({ admission, projection: {}, request: async (method, params, options) => {
    calls.push(method); assert.equal(options.membersLease, lease)
    return method === 'removals.read' ? { removals: [{ botId: bot.id, active: false, hasIntent: true, retired: true }] } : { id: params.botId }
  }, callback: async (method, params, options) => {
    calls.push(method); assert.equal(options.membersLease, lease); assert.equal(options.membersEffect, effect)
    return { botIds: [bot.id] }
  } })
  assert.equal(await f.bots.hasPendingRemoval(bot.id, { membersLease: lease }), true)
  assert.deepEqual(await f.bots.remove(bot.id, { membersLease: lease }), { id: bot.id })
  const ticket = admission.close()
  assert.deepEqual(await f.readCurrentBotIds({ membersLease: lease, membersEffect: effect }), [bot.id])
  assert.deepEqual(calls, ['removals.read', 'profile.remove', 'profiles.cli'])
  await assert.rejects(f.readCurrentBotIds(), { status: 503 })
  admission.finish(lease); await admission.drain(ticket)
})

test('fixed onboarding creation option is retained outside the profile input', async () => {
  const f = fixture()
  await f.bots.create({ name: 'guide' }, { id: 'bot-guide' })
  assert.deepEqual(f.calls[0].params, { input: { name: 'guide' }, id: 'bot-guide' })
  assert.equal(Object.hasOwn(f.calls[0].context, 'id'), false)
})

test('display list restores full profiles with distinct method pins and no AI credit', async () => {
  const admission = new MembersAdmission(), calls = []
  let entered = 0
  const enter = admission.enter.bind(admission); admission.enter = (...args) => { entered++; return enter(...args) }
  const pending = { ...bot, id: 'bot-pending', deleting: true, avatar: '', avatarLarge: '' }
  const f = createMembersFacade({ admission, projection: { snapshot: () => ({ available: true, generation: 'builtin', revision: 1, profiles: [bot, pending] }) }, request: async (method, params, options) => {
    calls.push({ method, params, pin: options.membersReadPin }); admission.assertReadPin(options.membersReadPin, { method })
    if (method === 'profiles.read') return { revision: 1 }
    if (params.botId === pending.id && !params.includeDeleting) throw Object.assign(new Error('missing'), { code: 'BOT_NOT_FOUND', status: 404 })
    return { bot: params.botId === pending.id ? pending : { ...bot, avatar: '' } }
  } })
  const listed = await f.bots.listForClient({ omitAvatars: false })
  assert.equal(entered, 0)
  assert.equal(calls[0].pin.method, 'profiles.read')
  assert.ok(calls.slice(1).every(call => call.pin === calls[1].pin && call.pin.method === 'profile.read'))
  assert.ok(calls.slice(1).every(call => call.params.includeDeleting === true))
  assert.equal(listed[1].deleting, true); assert.equal(Object.hasOwn(listed[0], 'avatar'), true)
  await assert.rejects(f.bots.readMember(pending.id), { status: 404 })
  assert.equal(Object.hasOwn(calls.at(-1).params, 'includeDeleting'), false)
})
test('list projection disappearance skips confirmed 404 only, unknown never returns an empty roster', async () => {
  const admission = new MembersAdmission()
  let failure = Object.assign(new Error(), { code: 'BOT_NOT_FOUND', status: 404 })
  const f = createMembersFacade({ admission, projection: { snapshot: () => ({ available: true, generation: 'builtin', revision: 1, profiles: [bot] }) }, request: async method => {
    if (method === 'profiles.read') return { revision: 1 }
    throw failure
  } })
  assert.deepEqual(await f.bots.listForClient(), [])
  failure = Object.assign(new Error(), { code: 'MEMBERS_UNAVAILABLE', status: 503, outcome: 'unknown' })
  await assert.rejects(f.bots.listForClient(), { status: 503, outcome: 'unknown' })
})

// a153: a lease carried across a members exchange (#1554 adopt) keeps its old generation; the roster it reads is the new child's,
// so the projection check compares with the current admission generation, not the lease's frozen one.
test('a153: a lease carried across an exchange reads the current generation roster instead of UNCONFIRMED', async () => {
  const admission = new MembersAdmission('old')
  const projection = { snapshot: () => ({ available: true, generation: 'new', revision: 2, profiles: [bot] }), get: () => bot, has: () => true, keys: () => [bot.id].values(), values: () => [bot].values() }
  const facade = createMembersFacade({ admission, projection, request: async () => ({ revision: 1 }), callback: async () => ({}) })
  const lease = admission.enter(), ticket = admission.close()
  admission.adopt(ticket, 'new'); admission.resume(ticket) // the lease is carried; its own generation stays 'old'
  assert.equal(lease.generation, 'old')
  assert.deepEqual(await facade.bots.refresh({ membersLease: lease }), [bot])
  admission.finish(lease)
})

// 2026-11-26 (members-roster-per-dispatch): a cached roster read and an image-free existence read.
function cachedFixture({ summaryRejects = null } = {}) {
  const admission = new MembersAdmission('generation'), requests = []
  const view = { available: true, generation: 'generation', revision: 1, profiles: [bot] }
  const projection = { snapshot: () => ({ ...view }), get: () => bot, has: () => true, keys: () => [bot.id].values(), values: () => [bot].values() }
  const full = { ...bot, avatar: 'data:image/png;base64,AAAA' }
  const facade = createMembersFacade({ admission, projection, callback: async () => ({ bot }),
    request: async (method, params, context) => {
      requests.push({ method, params })
      if (method === 'profiles.read') { view.available = true; view.generation = 'generation'; view.revision++; return { revision: view.revision } }
      if (params.summary && summaryRejects) throw summaryRejects
      return { bot: params.summary ? bot : full }
    } })
  return { ...facade, view, requests, full }
}
test('readCached returns the confirmed projection with no request, and re-snapshots when unavailable or from another generation', async () => {
  const f = cachedFixture()
  assert.deepEqual(await f.bots.readCached(), [bot]); assert.equal(f.requests.length, 0)
  f.view.available = false
  assert.deepEqual(await f.bots.readCached(), [bot]); assert.deepEqual(f.requests.map(r => r.method), ['profiles.read'])
  assert.deepEqual(await f.bots.readCached(), [bot]); assert.equal(f.requests.length, 1)
  f.view.generation = 'other'
  await f.bots.readCached(); assert.equal(f.requests.length, 2)
})
test('readCached never returns a stale view when the re-snapshot is unconfirmed; refresh and listForClient always read', async () => {
  const f = cachedFixture(); f.view.available = false
  const admission = new MembersAdmission('generation')
  const stuck = createMembersFacade({ admission, projection: { snapshot: () => ({ ...f.view }) }, request: async () => ({ revision: 9 }), callback: async () => ({}) })
  await assert.rejects(stuck.bots.readCached(), { code: 'MEMBERS_PROJECTION_UNCONFIRMED', status: 503, outcome: 'unknown' })
  const g = cachedFixture()
  const reads = () => g.requests.filter(r => r.method === 'profiles.read').length
  await g.bots.refresh(); assert.equal(reads(), 1); await g.bots.listForClient(); assert.ok(reads() >= 2)
})
test('readMemberSummary asks for a summary, retries once without it on MEMBERS_INPUT_INVALID, and propagates any other error', async () => {
  const f = cachedFixture()
  assert.equal((await f.bots.readMemberSummary(bot.id)).avatar, undefined); assert.deepEqual(f.requests[0].params, { botId: bot.id, summary: true })
  assert.equal((await f.bots.readMember(bot.id)).avatar, f.full.avatar); assert.deepEqual(f.requests[1].params, { botId: bot.id })
  const old = cachedFixture({ summaryRejects: Object.assign(new Error('x'), { code: 'MEMBERS_INPUT_INVALID', status: 400 }) })
  assert.equal((await old.bots.readMemberSummary(bot.id)).avatar, old.full.avatar)
  assert.deepEqual(old.requests.map(r => r.params), [{ botId: bot.id, summary: true }, { botId: bot.id }])
  const missing = cachedFixture({ summaryRejects: Object.assign(new Error('x'), { code: 'BOT_NOT_FOUND', status: 404 }) })
  await assert.rejects(missing.bots.readMemberSummary(bot.id), { code: 'BOT_NOT_FOUND' }); assert.equal(missing.requests.length, 1)
  const listed = cachedFixture(); await listed.bots.readMemberSummary(bot.id, undefined, { includeDeleting: true })
  assert.deepEqual(listed.requests[0].params, { botId: bot.id, includeDeleting: true, summary: true })
})
