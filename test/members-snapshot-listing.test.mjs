import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemberProfileApi } from '../src/members/profiles-http.mjs'
import { createMembersFacade } from '../src/members-facade.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'
import { avatarVersion } from '../src/avatar-value.mjs'

const fields = ['avatar', 'avatarLarge', 'avatarSource', 'avatarLargeSource']
function fixture({ legacy = false } = {}) {
  const admission = new MembersAdmission('fixture'), calls = []
  const full = [{ id: 'bot-a', name: 'A', harness: 'codex', session: 'a', avatar: 'data:image/png;base64,AAAA',
    avatarLarge: '', avatarSource: 'data:image/png;base64,BBBB', avatarLargeSource: 'data:image/png;base64,CCCC' },
  { id: 'bot-pending', name: 'Pending', harness: 'codex', session: 'p', deleting: true, avatar: '' }]
  const metadata = full.map(bot => {
    const result = { ...bot }
    for (const field of fields) {
      delete result[field]
      if (!legacy) result[`${field}Version`] = avatarVersion(field === 'avatarLarge' ? bot[field] || bot.avatar : bot[field])
    }
    return result
  })
  const current = new Map(metadata.map(bot => [bot.id, bot]))
  const view = { available: true, generation: 'fixture', revision: 1, profiles: metadata }
  const f = createMembersFacade({ admission, projection: { snapshot: () => view, get: id => current.get(id) },
    request: async (method, params, options) => {
      admission.assertReadPin(options.membersReadPin, { method }); calls.push({ method, params, options })
      if (method === 'profiles.read') return { revision: 1 }
      return { bot: full.find(bot => bot.id === params.botId) }
    } })
  return { ...f, calls, full, metadata, current, view, admission }
}
async function listing(f, query = '', sources = async () => []) {
  const api = createMemberProfileApi({ bots: f.bots, administration: {}, sources,
    transport: { runningBots: async () => new Set(['bot-a', 'bot-pending']) },
    store: { recentViews: async () => new Map() } })
  const response = { writeHead(status) { this.status = status }, end(body) { this.body = JSON.parse(body) } }
  await api({ method: 'GET' }, response, new URL(`http://fixture/api/bots${query}`))
  assert.equal(response.status, 200)
  return response.body.bots
}

test('HTTP roster always omits avatar bodies and uses one snapshot with all versions and pending', async () => {
  for (const query of ['', '?avatar=omit', '?avatar=inline']) {
    const f = fixture(), bots = await listing(f, query)
    assert.deepEqual(f.calls.map(call => call.method), ['profiles.read'])
    assert.doesNotMatch(JSON.stringify(bots), /data:/u)
    for (let i = 0; i < bots.length; i++) for (const field of fields) {
      assert.equal(Object.hasOwn(bots[i], field), false)
      assert.equal(bots[i][`${field}Version`], f.metadata[i][`${field}Version`])
    }
    assert.equal(bots[0].avatarLargeVersion, bots[0].avatarVersion)
    assert.equal(bots[1].deleting, true); assert.equal(bots[1].online, false)
    assert.equal(f.bots.get('bot-pending'), undefined)
  }
})

test('legacy snapshots restore versions without exposing images in either HTTP query', async () => {
  for (const query of ['', '?avatar=omit']) {
    const f = fixture({ legacy: true }), bots = await listing(f, query)
    assert.deepEqual(f.calls.map(call => call.method), ['profiles.read', 'profiles.read', 'profile.read', 'profile.read'])
    assert.doesNotMatch(JSON.stringify(bots), /data:/u)
    for (const field of fields) {
      assert.equal(Object.hasOwn(bots[0], field), false)
      assert.equal(bots[0][`${field}Version`], avatarVersion(field === 'avatarLarge' ? f.full[0][field] || f.full[0].avatar : f.full[0][field]))
    }
  }
})

test('listing rechecks active/pending/absent after asynchronous timeline work', async () => {
  const f = fixture()
  const bots = await listing(f, '?avatar=omit', async () => {
    f.current.get('bot-a').deleting = true
    f.current.delete('bot-pending')
    return []
  })
  assert.deepEqual(bots.map(bot => [bot.id, bot.deleting, bot.online]), [['bot-a', true, false]])
})

test('unconfirmed or unavailable snapshots fail without an empty roster or extra requests', async () => {
  for (const change of [{ available: false }, { generation: 'old' }, { revision: 0 }]) {
    const f = fixture(); Object.assign(f.view, change)
    await assert.rejects(listing(f), { code: 'MEMBERS_PROJECTION_UNCONFIRMED', status: 503, outcome: 'unknown' })
    assert.equal(f.calls.length, 1)
  }
  const f = fixture(); f.admission.close()
  await assert.rejects(listing(f), { status: 503 }); assert.equal(f.calls.length, 0)
})

test('omitted snapshot keeps its read pin until actual completion after caller unknown', async () => {
  const admission = new MembersAdmission('fixture')
  let settle, calls = 0
  const completion = new Promise(resolve => { settle = resolve })
  const { bots } = createMembersFacade({ admission, projection: {}, request: (method, params, { membersReadPin }) => {
    calls++; admission.trackReadCompletion(membersReadPin, completion)
    return Promise.reject(Object.assign(new Error('fixture'), { outcome: 'unknown' }))
  } })
  await assert.rejects(bots.listForClient({ omitAvatars: true }), { outcome: 'unknown' })
  const ticket = admission.close(); let drained = false
  const done = admission.drain(ticket).then(() => { drained = true })
  await Promise.resolve(); assert.equal(drained, false); assert.equal(calls, 1)
  settle(); await done; assert.equal(drained, true)
})
