import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRegistry } from '../src/bot-registry.mjs'
import { OwnerProfile } from '../src/owner-profile.mjs'
import { UserRules } from '../src/user-rules.mjs'
import { createMembersDispatcher } from '../src/members/dispatcher.mjs'
import { validateMembersRequest, validateMembersEffect, validateMembersEffectResult } from '../src/members/protocol.mjs'
const context = Object.freeze({ generation: 'test', leaseId: 'lease', rootId: 'root', ownerWrite: false })
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
