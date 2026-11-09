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

const context = Object.freeze({ generation: 'test', leaseId: 'lease', rootId: 'root', ownerWrite: false, continuation: false })

async function fixture(t, reason = () => null) {
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
    if (method === 'terminals.read') return params.terminalId === 'mac' ? { user: 'kite' } : null
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
