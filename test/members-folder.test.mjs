// S5 folder check on save (docs/architecture/modules/members/remote-seat.md "Folder check on save").
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRegistry, memberFolderSlug } from '../src/bot-registry.mjs'
import { OwnerProfile } from '../src/owner-profile.mjs'
import { UserRules } from '../src/user-rules.mjs'
import { createMembersDispatcher } from '../src/members/dispatcher.mjs'
import { validateMembersEffectResult } from '../src/members/protocol.mjs'

const context = Object.freeze({ generation: 'test', leaseId: 'lease', rootId: 'root', ownerWrite: false, continuation: false })

async function fixture(t, reason = () => null, { terminalsError } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'members-folder-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [{ id: 'bot-a', displayName: 'Synthetic', harness: 'claude', session: 'bot-a', project: '/unused' }] }))
  await mkdir(join(root, 'state'))
  await new BotRegistry({ seedPath, botsRoot: join(root, 'bots'), stateRoot: join(root, 'state/bots') }).initialize()
  await new OwnerProfile({ root }).initialize(); await new UserRules({ root }).initialize()
  const folders = []
  const effect = async (method, params) => {
    if (method === 'project.readPreviousSession') return ''
    if (method.startsWith('terminals.') && terminalsError) throw Object.assign(new Error(terminalsError), { code: terminalsError })
    if (method === 'terminals.read') return { mac: { user: 'kite' }, fox: { user: 'kite_', os: 'windows' }, rabbit: { user: 'kite', os: 'linux' } }[params.terminalId] ?? null
    if (method === 'terminals.folder') {
      folders.push(params)
      const r = reason(params)
      return { terminalId: params.terminalId, path: params.path, observedAt: '2026-11-10T00:00:00.000Z', exists: null, directory: null, writable: null, reason: r, ...(r ? { action: `do ${r}` } : {}) }
    }
  }
  const dispatcher = createMembersDispatcher({ root, effect, projection: async () => {} })
  await dispatcher.control('initialize', { generation: 'test' }, { ...context, leaseId: null })
  await dispatcher.control('resume', {})
  const request = (method, params) => { dispatcher.validateRequest(method, params, context); return dispatcher.dispatch(method, params, context) }
  return { request, folders }
}

test('create with a terminal only gets the default folder and a usable check', async t => {
  const f = await fixture(t)
  const { bot, folderCheck } = await f.request('profile.create', { input: { name: ' ベロ/タ ', harness: 'claude', terminalId: 'mac' } })
  assert.equal(bot.projectRoot, '/Users/kite/BellTeam/ベロ-タ')
  assert.deepEqual(f.folders, [{ terminalId: 'mac', path: '/Users/kite/BellTeam/ベロ-タ', create: false }])
  assert.deepEqual(folderCheck, { checked: true, reason: null, observedAt: '2026-11-10T00:00:00.000Z' })
  assert.equal(memberFolderSlug('..'), 'member')
  await assert.rejects(f.request('profile.create', { input: { name: 'x', terminalId: 'nope' } }), { code: 'TERMINAL_NOT_FOUND', status: 404 })
})

test('a body older than S5 (unknown terminals effects) saves the given folder unchecked and keeps the pair rule', async t => {
  for (const terminalsError of ['MEMBERS_INPUT_INVALID', 'MEMBERS_EFFECT_UNSUPPORTED']) {
    const f = await fixture(t, undefined, { terminalsError })
    const result = await f.request('profile.create', { input: { name: 'x', harness: 'claude', terminalId: 'mac', projectRoot: '/Users/kite/BellTeam/test' } })
    assert.deepEqual([result.bot.terminalId, result.bot.projectRoot, Object.hasOwn(result, 'folderCheck')], ['mac', '/Users/kite/BellTeam/test', false])
    await assert.rejects(f.request('profile.create', { input: { name: 'y', harness: 'claude', terminalId: 'mac' } }), { code: 'BOT_REMOTE_BINDING_INVALID' })
  }
  const other = await fixture(t, undefined, { terminalsError: 'MEMBERS_UNAVAILABLE' })
  await assert.rejects(other.request('profile.create', { input: { name: 'z', harness: 'claude', terminalId: 'mac', projectRoot: '/Users/kite/z' } }), { code: 'MEMBERS_UNAVAILABLE' })
})

test('a missing folder refuses the save; createFolder repeats it with create and is not saved', async t => {
  const f = await fixture(t, params => params.create ? null : 'FOLDER_MISSING')
  const input = { name: 'x', harness: 'claude', terminalId: 'mac', projectRoot: '/Users/kite/a' }
  await assert.rejects(f.request('profile.create', { input }), { code: 'FOLDER_MISSING', status: 409 })
  assert.equal((await f.request('profile.preview', { botId: 'bot-a', changes: {} })).bot.id, 'bot-a')
  const { bot } = await f.request('profile.create', { input: { ...input, createFolder: true } })
  assert.equal(f.folders.at(-1).create, true)
  assert.equal(Object.hasOwn(bot, 'createFolder'), false)
})

test('rejected input with createFolder never reaches the terminal', async t => {
  const f = await fixture(t)
  await assert.rejects(f.request('profile.create', { input: { name: 'x', terminalId: 'mac', projectRoot: '/Users/kite/../a', createFolder: true } }),
    { code: 'BOT_PROJECT_ROOT_INVALID' })
  await assert.rejects(f.request('profile.update', { botId: 'bot-a', changes: { avatarSource: '', terminalId: 'mac', projectRoot: '/Users/kite/a', createFolder: true } }),
    { code: 'BOT_AVATAR_CROP_INVALID' })
  assert.deepEqual(f.folders, [])
})

test('an unreachable terminal saves the folder as unchecked; unrelated edits make no terminal call', async t => {
  const f = await fixture(t, () => 'UNREACHABLE')
  const { bot, folderCheck } = await f.request('profile.update', { botId: 'bot-a', changes: { terminalId: 'mac', projectRoot: '/Users/kite/a' } })
  assert.equal(bot.projectRoot, '/Users/kite/a')
  assert.deepEqual(folderCheck, { checked: false, reason: 'UNREACHABLE', observedAt: '2026-11-10T00:00:00.000Z', action: 'do UNREACHABLE' })
  const unrelated = await f.request('profile.update', { botId: 'bot-a', changes: { role: 'r' } })
  assert.equal(unrelated.folderCheck, undefined)
  assert.equal(f.folders.length, 1)
})

test('Windows and Linux terminals: default folder and folder form follow the terminal os', async t => {
  const f = await fixture(t)
  const create = input => f.request('profile.create', { input: { harness: 'claude', ...input } })
  assert.equal((await create({ name: 'a\\b', terminalId: 'fox' })).bot.projectRoot, 'C:\\Users\\kite_\\BellTeam\\a-b')
  assert.equal((await create({ name: 'x', terminalId: 'rabbit' })).bot.projectRoot, '/home/kite/BellTeam/x')
  assert.equal((await create({ name: 'y', terminalId: 'fox', projectRoot: 'D:\\work\\app' })).bot.projectRoot, 'D:\\work\\app')
  const calls = f.folders.length
  for (const [terminalId, projectRoot] of [['fox', '/home/kite/a'], ['mac', 'C:\\a'], ['rabbit', 'C:\\a'], ['fox', 'C:\\a/b'], ['fox', 'C:\\a\\..\\b'], ['fox', 'C:\\a\\'], ['fox', 'C:\\a:b'], ['fox', 'C:a']])
    await assert.rejects(create({ name: 'z', terminalId, projectRoot }), { code: 'BOT_PROJECT_ROOT_INVALID' }, `${terminalId} ${projectRoot}`)
  assert.equal(f.folders.length, calls)
  const old = await fixture(t, undefined, { terminalsError: 'MEMBERS_EFFECT_UNSUPPORTED' })
  await assert.rejects(old.request('profile.create', { input: { name: 'w', harness: 'claude', terminalId: 'fox', projectRoot: 'C:\\a' } }), { code: 'BOT_PROJECT_ROOT_INVALID' })
  validateMembersEffectResult('terminals.read', { user: 'kite_', os: 'windows' })
  assert.throws(() => validateMembersEffectResult('terminals.read', { user: 'kite_', os: 1 }))
})
