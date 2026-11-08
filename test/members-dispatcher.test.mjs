import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile, rm, mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRegistry } from '../src/bot-registry.mjs'
import { OwnerProfile } from '../src/owner-profile.mjs'
import { UserRules } from '../src/user-rules.mjs'
import { createMembersDispatcher } from '../src/members/dispatcher.mjs'
import { GUIDE_BOT_ID } from '../src/onboarding.mjs'
import { normalizeMembersError } from '../src/members/errors.mjs'
import { avatarVersion } from '../src/avatar-value.mjs'
import { validateMembersRequest, validateMembersEffect, validateMembersEffectResult, validateMembersProjection, validateMembersResult } from '../src/members/protocol.mjs'
const context = Object.freeze({ generation: 'test', leaseId: 'lease', rootId: 'root', ownerWrite: false, continuation: false })
const initial = Object.freeze({ ...context, leaseId: null })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function fixture(t, effect = async method => method === 'project.readPreviousSession' ? '' : undefined) {
  const root = await mkdtemp(join(tmpdir(), 'members-dispatcher-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [{ id: 'bot-a', displayName: 'Synthetic', harness: 'grok', session: 'bot-a', project: '/unused' }] }))
  await mkdir(join(root, 'state'))
  await new BotRegistry({ seedPath, botsRoot: join(root, 'bots'), stateRoot: join(root, 'state/bots') }).initialize()
  await new OwnerProfile({ root }).initialize(); await new UserRules({ root }).initialize()
  const records = []
  const dispatcher = createMembersDispatcher({ root, effect, projection: async (record, context) => { records.push({ record, context }) } })
  await dispatcher.control('initialize', { generation: 'test' }, initial)
  await dispatcher.control('resume', {})
  const request = (method, params, ctx = context) => { dispatcher.validateRequest(method, params, ctx); return dispatcher.dispatch(method, params, ctx) }
  return { dispatcher, request, records, root }
}

test('restore snapshots complete before ready and root mutations update projection before result', async t => {
  const f = await fixture(t)
  assert.deepEqual(f.records.map(item => item.record.type), ['snapshot-start', 'profile', 'snapshot-end'])
  const { bot } = await f.request('profile.update', { botId: 'bot-a', changes: { name: 'Updated' } })
  assert.equal(bot.name, 'Updated')
  assert.equal(f.records.at(-1).record.type, 'snapshot-end')
  assert.equal(f.records.at(-2).record.bot.name, 'Updated')
  assert.equal(Object.hasOwn(f.records.at(-2).record.bot, 'avatar'), false)
})

test('Owner write needs trusted context, and ordinary params cannot inject it', async t => {
  const f = await fixture(t)
  assert.throws(() => f.dispatcher.validateRequest('rules.update', { text: 'rule' }, context), /MEMBERS_INPUT_INVALID/)
  assert.throws(() => f.dispatcher.validateRequest('rules.update', { text: 'rule', ownerWrite: true }, { ...context, ownerWrite: true }), /MEMBERS_INPUT_INVALID/)
  assert.deepEqual(await f.request('rules.update', { text: 'rule' }, { ...context, ownerWrite: true }), { text: 'rule\n' })
})

test('same-lease session callback completes while root update waits for parent effect', async t => {
  let dispatcher
  const f = await fixture(t, async (method, params, ctx) => {
    if (method === 'project.readPreviousSession') return ''
    if (method === 'project.writeInstructions') {
      dispatcher.validateCallback('profile.session', { botId: 'bot-a', session: 'native-new' }, ctx)
      await dispatcher.dispatchCallback('profile.session', { botId: 'bot-a', session: 'native-new' }, ctx)
    }
  })
  dispatcher = f.dispatcher
  const result = await f.request('profile.update', { botId: 'bot-a', changes: { name: 'Updated' } })
  assert.equal(result.bot.session, 'native-new')
})

test('quiesce rejects new roots but preserves callback, and late drain cannot undo resume', async t => {
  const entered = deferred(), release = deferred()
  const f = await fixture(t, async method => {
    if (method === 'project.readPreviousSession') { entered.resolve(); await release.promise; return '' }
  })
  const updating = f.request('profile.update', { botId: 'bot-a', changes: { name: 'Updated' } })
  await entered.promise
  const quiescing = f.dispatcher.control('quiesce', {})
  assert.throws(() => f.dispatcher.validateRequest('profile.read', { botId: 'bot-a' }, context), /MEMBERS_UNAVAILABLE/)
  f.dispatcher.validateCallback('profile.fastMode', { botId: 'bot-a', fastMode: true }, context)
  await f.dispatcher.dispatchCallback('profile.fastMode', { botId: 'bot-a', fastMode: true }, context)
  await f.dispatcher.control('resume', {})
  release.resolve(); await updating
  assert.deepEqual(await quiescing, { quiesced: false })
  assert.equal((await f.request('profile.read', { botId: 'bot-a' })).bot.fastMode, true)
  await assert.rejects(f.dispatcher.control('exit', {}), /MEMBERS_NOT_QUIESCED/)
})

test('finite DTOs reject unknown operations, callback/root confusion, path and fake authority', () => {
  for (const [method, params] of [['toString', {}], ['profile.session', { botId: 'bot-a', session: 'fake' }], ['profile.read', { botId: '../escape' }], ['profile.update', { botId: 'bot-a', changes: { project: '/tmp' } }]])
    assert.throws(() => validateMembersRequest(method, params, context))
  assert.throws(() => validateMembersEffect('project.writeInstructions', { botId: 'bot-a', body: '', home: '/tmp' }, context))
  assert.throws(() => validateMembersRequest('profile.read', { botId: 'bot-a' }, { ...context, actor: 'owner' }))
})

test('parent effect failure after persistence preserves saved data and is never retried', async t => {
  let writes = 0
  const f = await fixture(t, async method => {
    if (method === 'project.readPreviousSession') return ''
    if (method === 'project.writeInstructions') { writes++; throw Object.assign(new Error('synthetic disconnect'), { outcome: 'unknown' }) }
  })
  await assert.rejects(f.request('profile.update', { botId: 'bot-a', changes: { name: 'Saved' } }), { outcome: 'unknown' })
  assert.equal(writes, 1)
  assert.equal((await f.request('profile.read', { botId: 'bot-a' })).bot.name, 'Saved')
})

test('internal DTO admits four maximum image fields and enforces UTF-8 byte budget', () => {
  const prefix = 'data:image/png;base64,'
  const image = prefix + 'A'.repeat(3_000_000 - prefix.length)
  validateMembersRequest('profile.update', { botId: 'bot-a', changes: { avatar: image, avatarLarge: image, avatarSource: image, avatarLargeSource: image } }, context)
  assert.throws(() => validateMembersRequest('profile.update', { botId: 'bot-a', changes: { reasoningEffort: 'あ'.repeat(6_000_000) } }, context))
  assert.throws(() => validateMembersEffectResult('project.readPreviousSession', { unexpected: true }), { outcome: 'unknown', code: 'MEMBERS_RESULT_INVALID' })
})


test('quiesce detects incompatible current state before allowing old writer exit', async t => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'owner/profile.json'), JSON.stringify({ schema: 'unknown' }))
  await assert.rejects(f.dispatcher.control('quiesce', {}), /OWNER_PROFILE_FILE_INVALID/)
  await assert.rejects(f.dispatcher.control('exit', {}), /MEMBERS_NOT_QUIESCED/)
  assert.deepEqual(await f.dispatcher.control('resume', {}), { resumed: true })
})

test('profile.remove waits the asset gate before retirement and drains its background effects', async t => {
  const entered = deferred(), release = deferred(), calls = []
  let f
  f = await fixture(t, async (method, params, ctx) => {
    calls.push(method)
    if (method === 'assets.prepareBotAssetRemoval') {
      entered.resolve(); await release.promise
      return 'opaque-asset-gate'
    }
    if (method === 'project.remove') {
      await assert.rejects(stat(join(f.root, 'state/bots/bot-a')), { code: 'ENOENT' })
      assert.ok(await stat(join(f.root, 'state/bots/.deleting/bot-a')))
    }
  })
  const removing = f.request('profile.remove', { botId: 'bot-a' })
  await entered.promise
  const quiescing = f.dispatcher.control('quiesce', {})
  assert.ok(await stat(join(f.root, 'state/bots/bot-a/bot.json')))
  await f.dispatcher.dispatchCallback('profile.session', { botId: 'bot-a', session: 'last-save' }, context)
  release.resolve()
  assert.deepEqual(await removing, { id: 'bot-a' })
  assert.deepEqual(await quiescing, { quiesced: true })
  assert.deepEqual(calls, ['assets.prepareBotAssetRemoval', 'project.remove', 'cli.configure'])
})

test('CLI queue callback reads current IDs during drain without effects or another root', async t => {
  let dispatcher, ids
  const entered = deferred(), release = deferred()
  const f = await fixture(t, async (method, params, ctx) => {
    if (method === 'assets.prepareBotAssetRemoval') return 'asset-gate'
    if (method === 'cli.configure') {
      entered.resolve(); await release.promise
      dispatcher.validateCallback('profiles.cli', {}, ctx)
      ids = await dispatcher.dispatchCallback('profiles.cli', {}, ctx)
    }
  })
  dispatcher = f.dispatcher
  assert.throws(() => dispatcher.validateRequest('profiles.cli', {}, context))
  const removing = f.request('profile.remove', { botId: 'bot-a' })
  await entered.promise
  const quiescing = dispatcher.control('quiesce', {})
  release.resolve(); await removing
  assert.deepEqual(await quiescing, { quiesced: true })
  assert.deepEqual(ids, { botIds: [] })
})

test('trusted old-lease root continuation can fresh-read and prepare startup during quiesce', async t => {
  const entered = deferred(), release = deferred(), effects = []
  const f = await fixture(t, async (method, params, ctx) => {
    effects.push({ method, context: ctx })
    if (method === 'project.readPreviousSession') { entered.resolve(); await release.promise; return '' }
  })
  const updating = f.request('profile.update', { botId: 'bot-a', changes: { name: 'Updated' } })
  await entered.promise
  const quiescing = f.dispatcher.control('quiesce', {})
  const continued = Object.freeze({ ...context, rootId: 'continued', continuation: true })
  assert.equal((await f.request('profile.read', { botId: 'bot-a' }, continued)).bot.name, 'Updated')
  assert.deepEqual(await f.request('profile.startup', { botId: 'bot-a', shortTermMemory: 'previous' }, continued), { prepared: true })
  assert.equal(effects.find(item => item.method === 'project.prepareStartupContext').context, continued)
  assert.throws(() => f.dispatcher.validateRequest('profile.startup', { botId: 'bot-a', shortTermMemory: '' }, context), /MEMBERS_UNAVAILABLE/)
  assert.throws(() => f.dispatcher.validateRequest('profile.read', { botId: 'bot-a', continuation: true }, context))
  assert.throws(() => f.dispatcher.validateCallback('profile.startup', { botId: 'bot-a', shortTermMemory: '' }, continued))
  release.resolve(); await updating
  assert.deepEqual(await quiescing, { quiesced: true })
})

test('internal onboarding create preserves only the existing literal guide ID', async t => {
  const effects = []
  const f = await fixture(t, async method => { effects.push(method); if (method === 'project.readPreviousSession') return '' })
  const input = { name: 'Synthetic guide', harness: 'grok' }
  assert.throws(() => f.dispatcher.validateRequest('profile.create', { input, id: 'bot-other' }, context))
  assert.equal(GUIDE_BOT_ID, 'bot-guide')
  const guide = await f.request('profile.create', { input, id: GUIDE_BOT_ID })
  assert.equal(guide.bot.id, GUIDE_BOT_ID)
  const ordinary = await f.request('profile.create', { input })
  assert.notEqual(ordinary.bot.id, GUIDE_BOT_ID)
  assert.match(ordinary.bot.id, /^bot-/u)
  assert.equal(effects.includes('memory.ensureScope'), false, 'existing HTTP/MCP callers initialize memory after the published create result')
})

test('display read can retain pending avatar bytes while active authorization stays 404', async t => {
  const avatar = 'data:image/png;base64,AAAA'
  const f = await fixture(t, async method => {
    if (method === 'project.readPreviousSession') return ''
    if (method === 'assets.prepareBotAssetRemoval') return 'gate'
    if (method === 'project.remove') throw new Error('synthetic cleanup failure')
  })
  await f.request('profile.update', { botId: 'bot-a', changes: { avatar } })
  await assert.rejects(f.request('profile.remove', { botId: 'bot-a' }), { code: 'BOT_DELETE_PENDING' })
  await assert.rejects(f.request('profile.read', { botId: 'bot-a' }), { code: 'BOT_NOT_FOUND', status: 404 })
  const display = await f.request('profile.read', { botId: 'bot-a', includeDeleting: true })
  assert.equal(display.bot.deleting, true); assert.equal(display.bot.avatar, avatar)
  const metadata = await f.request('profiles.read', {})
  const projected = f.records.find(item => item.record.type === 'profile' && item.record.revision === metadata.revision).record.bot
  assert.equal(Object.hasOwn(projected, 'avatar'), false)
  assert.equal(projected.hasAvatar, true)
  assert.equal(projected.avatarVersion, avatarVersion(avatar))
  assert.equal(projected.avatarLargeVersion, avatarVersion(avatar))
  assert.equal(projected.avatarSourceVersion, '')
  assert.equal(projected.avatarLargeSourceVersion, '')
  assert.equal(projected.deleting, true)
  assert.equal(Object.hasOwn(display.bot, 'avatarVersion'), false)
})

test('fixed semantic errors preserve HTTP status while the wire can omit private messages', async t => {
  const f = await fixture(t)
  await assert.rejects(f.request('profile.preview', { botId: 'bot-absent', changes: {} }), { code: 'BOT_NOT_FOUND', status: 404 })
  await assert.rejects(f.request('profile.preview', { botId: 'bot-a', changes: { avatar: 'data:image/png;base64,AAAA', avatarSource: '', avatarCrop: { x: 0, y: 0, width: 1, height: 1 } } }), { code: 'BOT_AVATAR_CROP_INVALID', status: 400 })
  const error = Object.assign(new Error('BOT_NOT_FOUND: private-id'), { outcome: 'unknown' })
  const normalized = normalizeMembersError(error)
  assert.deepEqual({ code: normalized.code, status: normalized.status, outcome: normalized.outcome }, { code: 'BOT_NOT_FOUND', status: 404, outcome: 'unknown' })
  const unknown = new Error('private free text')
  assert.equal(normalizeMembersError(unknown), unknown)
  assert.equal(Object.hasOwn(unknown, 'code'), false)
})

test('fresh metadata larger than one payload is streamed without a member-count limit', async t => {
  const f = await fixture(t), template = JSON.parse(await readFile(join(f.root, 'state/bots/bot-a/bot.json'), 'utf8'))
  const text = 'x'.repeat(8000)
  await Promise.all(Array.from({ length: 600 }, async (_, index) => {
    const id = `bot-many-${index}`, directory = join(f.root, 'state/bots', id)
    await mkdir(directory)
    await writeFile(join(directory, 'bot.json'), JSON.stringify({ ...template, id, session: id, profileText: text, personality: text, speechStyle: text, role: text }))
    await writeFile(join(directory, 'schedule.json'), JSON.stringify({ schema: 'bellteam.schedule.v1', schedules: [] }))
  }))
  const result = await f.request('profiles.read', {})
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 100)
  const records = f.records.filter(item => item.record.revision === result.revision)
  assert.equal(records.filter(item => item.record.type === 'profile').length, 601)
  assert.equal(records.at(-1).record.type, 'snapshot-end')
  const sizes = records.map(item => Buffer.byteLength(JSON.stringify(item.record)))
  assert.ok(sizes.reduce((total, size) => total + size, 0) > 16 * 1024 * 1024)
  assert.ok(sizes.every(size => size < 64 * 1024))
})


test('streamed snapshot versions match HTTP hashing without reading each member', async t => {
  const f = await fixture(t)
  const changes = { avatar: 'data:image/png;base64,AAAA', avatarLarge: 'data:image/png;base64,BBBB',
    avatarSource: 'data:image/png;base64,CCCC', avatarLargeSource: 'data:image/png;base64,DDDD' }
  await f.request('profile.update', { botId: 'bot-a', changes: { ...changes,
    avatarCrop: { x: 0, y: 0, width: 1, height: 1 }, avatarLargeCrop: { x: 0, y: 0, width: 1, height: 1 } } })
  let refreshes = 0, listings = 0
  const refresh = BotRegistry.prototype.refresh, list = BotRegistry.prototype.listForClient
  t.after(() => { BotRegistry.prototype.refresh = refresh; BotRegistry.prototype.listForClient = list })
  BotRegistry.prototype.refresh = function (...args) { refreshes++; return refresh.apply(this, args) }
  BotRegistry.prototype.listForClient = function (...args) { listings++; return list.apply(this, args) }
  const { revision } = await f.request('profiles.read', {})
  assert.deepEqual([refreshes, listings], [1, 1])
  const projected = f.records.find(item => item.record.type === 'profile' && item.record.revision === revision).record.bot
  for (const [field, image] of Object.entries(changes)) {
    assert.equal(Object.hasOwn(projected, field), false)
    assert.equal(projected[`${field}Version`], avatarVersion(image))
  }
  const exact = (await f.request('profile.read', { botId: 'bot-a' })).bot
  assert.equal(exact.avatar, changes.avatar)
  assert.equal(Object.hasOwn(exact, 'avatarVersion'), false)
})

test('avatar versions are projection-only closed metadata with exact digest format', () => {
  const bot = { id: 'bot-a', name: 'A', harness: 'grok', session: 'bot-a' }
  for (const field of ['avatarVersion', 'avatarLargeVersion', 'avatarSourceVersion', 'avatarLargeSourceVersion']) {
    for (const value of ['', '0123456789abcdef'])
      validateMembersProjection({ type: 'profile', revision: 1, bot: { ...bot, [field]: value } }, context)
    for (const value of ['xyz', 'A'.repeat(16), 3, null, 'a'.repeat(17)])
      assert.throws(() => validateMembersProjection({ type: 'profile', revision: 1, bot: { ...bot, [field]: value } }, context))
    assert.throws(() => validateMembersResult('profile.read', { bot: { ...bot, [field]: '' } }), { code: 'MEMBERS_RESULT_INVALID', outcome: 'unknown' })
  }
  assert.throws(() => validateMembersRequest('profile.update', { botId: 'bot-a', changes: { avatarVersion: '' } }, context))
})

test('each generation renders the global instructions from its own template once, on the first owner.read', async t => {
  const template = await readFile(new URL('../config/common-agents.md', import.meta.url), 'utf8')
  const writes = []
  const f = await fixture(t, async (method, params) => {
    if (method === 'global.writeInstructions') writes.push(params.body)
    return method === 'project.readPreviousSession' ? '' : undefined
  })
  assert.equal(writes.length, 0)
  await f.request('owner.read', {}); await f.request('owner.read', {})
  assert.equal(writes.length, 1)
  assert.ok(writes[0].includes(template.trim()))

  const reports = []
  let attempts = 0
  const root = f.root
  const failing = createMembersDispatcher({ root, projection: async () => {}, diagnostic: async report => { reports.push(report) },
    effect: async method => { if (method === 'global.writeInstructions') { attempts++; throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) } } })
  await failing.control('initialize', { generation: 'test' }, initial); await failing.control('resume', {})
  failing.validateRequest('owner.read', {}, context)
  assert.equal((await failing.dispatch('owner.read', {}, context)).owner.schema, 'bellteam.owner-profile.v1')
  assert.equal((await failing.dispatch('owner.read', {}, context)).owner.schema, 'bellteam.owner-profile.v1')
  assert.deepEqual(reports.map(report => report.code), ['MEMBERS_GLOBAL_INSTRUCTIONS_FAILED'])
  assert.equal(attempts, 2)
})
