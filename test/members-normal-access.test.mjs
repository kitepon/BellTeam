import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { MembersAdmission } from '../src/members-admission.mjs'
import { createMembersFacade } from '../src/members-facade.mjs'
import { createMembersAssembly } from '../src/members-assembly.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'
import { callBellTeamTool } from '../src/mcp-tools.mjs'
import { BellTeamMessenger } from '../src/messenger.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'members-normal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const admission = new MembersAdmission('current'), calls = []
  const profiles = ['bot-from', 'bot-target'].map(id => ({ id, name: id, session: id, harness: 'codex', avatar: '' }))
  const owner = { schema: 'bellteam.owner-profile.v1', name: 'owner', profile: '', avatar: '', xUrl: '', githubUrl: '', links: [] }
  const projection = {
    get: id => profiles.find(bot => bot.id === id), values: () => profiles.values(),
    snapshot: () => ({ available: true, generation: 'current', revision: 1, profiles }),
  }
  const facade = createMembersFacade({ admission, projection, request: async (method, params, context) => {
    admission.assertReadPin(context.membersReadPin, { method })
    assert.equal(context.membersLease, undefined)
    calls.push(method)
    if (method === 'profiles.read') return { revision: 1 }
    if (method === 'profile.read') {
      const bot = profiles.find(bot => bot.id === params.botId)
      if (!bot) throw Object.assign(new Error('missing'), { code: 'BOT_NOT_FOUND', status: 404 })
      return { bot }
    }
    if (method === 'owner.read') return { owner }
    if (method === 'rules.read') return { text: 'rules' }
    assert.fail(method)
  } })
  let sends = 0
  const transport = {
    runningBots: async () => new Set(profiles.map(bot => bot.id)), queueItems: () => [],
    notify: async () => { sends++; return { delivery: 'running' } },
    turn() {
      sends++
      const completion = Promise.resolve('reply')
      completion.accepted = Promise.resolve({ delivery: 'running' })
      return completion
    },
  }
  const messenger = new BellTeamMessenger({ bots: facade.bots, transport, logPath: join(root, 'messages.jsonl') })
  const rooms = new Map(); rooms.refresh = async () => {}
  const server = createBellTeamServer({ bots: facade.bots, rooms, transport, messenger,
    store: messenger.store, ownerProfile: facade.ownerProfile, userRules: facade.userRules,
    writeLog() {}, authorize: request => request.headers.authorization === 'Bearer fixture' })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const leases = Array.from({ length: 8 }, () => admission.enter())
  t.after(() => leases.forEach(lease => admission.finish(lease)))
  return { admission, leases, calls, facade, messenger, rooms, profiles, get sends() { return sends },
    request: (path, options = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      ...options, headers: { authorization: 'Bearer fixture', ...options.headers },
    }) }
}

test('eight occupied AI leases do not reject normal HTTP reads or accepted user messages', async t => {
  const f = await fixture(t)
  for (const path of ['/api/bots', '/api/owner', '/api/user-rules', '/api/bots/bot-target/messages', '/api/bots/bot-target/queue', '/api/rooms']) {
    const response = await f.request(path)
    assert.equal(response.status, 200, path)
    await response.json()
  }
  const response = await f.request('/api/bots/bot-target/messages', { method: 'POST', body: JSON.stringify({ message: 'new user input' }) })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).delivery, 'running')
  assert.equal(f.sends, 1)
  assert.throws(() => f.admission.enter(), { code: 'MEMBERS_NOT_ACCEPTED' })
  f.leases.forEach(lease => f.admission.assertLease(lease))
})

test('MCP identity and direct contact use fresh reads with eight unrelated AI leases retained', async t => {
  const f = await fixture(t)
  const result = await callBellTeamTool({ name: 'get_self', from: 'bot-from', registry: f.facade.bots, rooms: f.rooms })
  assert.equal(result.bot.id, 'bot-from')
  const sent = await callBellTeamTool({ name: 'sendmessage', arguments: { target: 'bot-target', message: 'new contact' },
    from: 'bot-from', registry: f.facade.bots, rooms: f.rooms, messenger: f.messenger })
  assert.equal(sent.delivery, 'running')
  assert.equal(f.sends, 1)
  assert(f.calls.includes('profiles.read') && f.calls.includes('profile.read'))
  assert.throws(() => f.admission.enter(), { code: 'MEMBERS_NOT_ACCEPTED' })
})

test('direct conversation reads avoid a whole-roster refresh and preserve 401/404/closed rejection', async t => {
  const f = await fixture(t)
  assert.equal((await f.request('/api/bots/bot-target/messages')).status, 200)
  assert.deepEqual(f.calls, ['profile.read'])
  const missing = await f.request('/api/bots/bot-missing/messages')
  assert.equal(missing.status, 404)
  assert.deepEqual(await missing.json(), { error: 'BOT_NOT_FOUND' })
  const count = f.calls.length
  assert.equal((await f.request('/api/bots/bot-target/messages', { headers: { authorization: 'wrong' } })).status, 401)
  assert.equal(f.calls.length, count)
  f.admission.close()
  const closed = await f.request('/api/bots/bot-target/messages')
  assert.equal(closed.status, 503)
  assert.equal((await closed.json()).error, 'MEMBERS_NOT_ACCEPTED')
})

test('readonly room schedule effect has a dedicated assembly branch and cannot run another effect', async () => {
  const admission = new MembersAdmission('current')
  let options, calls = 0
  createMembersAssembly({ root: '/unused', membersAdmission: admission,
    dependencies: () => ({ rooms: { async listSchedules(id) { assert.equal(id, 'room-test'); calls++; return [] } } }),
    createProcess: value => { options = value; return {} },
  })
  const pin = admission.enterReadPin('schedules.list')
  const context = { generation: 'current', leaseId: pin.leaseId, rootId: '1', ownerWrite: false, continuation: false, membersReadPin: pin }
  assert.deepEqual(await options.onEffect('room.schedules.list', { roomId: 'room-test' }, context), [])
  await assert.rejects(options.onEffect('models.read', { harness: 'codex' }, context), { code: 'MEMBERS_EFFECT_UNSUPPORTED' })
  const other = admission.enterReadPin('owner.read')
  await assert.rejects(options.onEffect('room.schedules.list', { roomId: 'room-test' }, { ...context, membersReadPin: other }), { code: 'MEMBERS_NOT_ACCEPTED' })
  assert.equal(calls, 1)
  admission.finishReadPin(pin); admission.finishReadPin(other)
})

test('committed large avatar remains readable after saving while all AI admission slots are busy', async t => {
  const f = await fixture(t)
  const saved = 'data:image/png;base64,iVBORw0KGgo='
  f.profiles[1].avatarLarge = saved
  const profile = await f.request('/api/bots/bot-target')
  assert.equal(profile.status, 200)
  assert.equal((await profile.json()).bot.avatarLarge, saved)
  const image = await f.request('/api/bots/bot-target/avatar-large')
  assert.equal(image.status, 200)
  assert.equal(image.headers.get('content-type'), 'image/png')
  assert.equal(Buffer.from(await image.arrayBuffer()).toString('base64'), 'iVBORw0KGgo=')
  assert.deepEqual(f.calls, ['profile.read', 'profile.read'])
  assert.equal(f.profiles[1].avatarLarge, saved)
  assert.equal(f.sends, 0)
})
