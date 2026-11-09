import test from 'node:test'
import assert from 'node:assert/strict'
import { withMemberFolderCheck, memberFolderSlug } from '../src/members-folder.mjs'

function setup({ reason = null, current = { id: 'bot-a', name: 'ベロータ', terminalId: '', projectRoot: '' }, core = true } = {}) {
  const calls = { folder: [], create: [], update: [], preview: [] }
  const terminals = core ? {
    registry: { get: async id => id === 'mac' ? { terminalId: 'mac', user: 'kite' } : null },
    folder: async request => { calls.folder.push(request); const r = typeof reason === 'function' ? reason(request) : reason
      return { terminalId: request.terminalId, path: request.path, observedAt: 't', exists: null, directory: null, writable: null, reason: r,
        ...(r ? { action: `do ${r}` } : {}) } },
  } : null
  const bots = withMemberFolderCheck({
    readMember: async () => current,
    create: async input => { calls.create.push(input); return { id: 'bot-n', ...input } },
    update: async (id, changes) => { calls.update.push(changes); return { ...current, ...changes } },
    previewUpdate: async (id, changes) => { calls.preview.push(changes); return { ...current, ...changes } },
  }, () => terminals)
  return { bots, calls }
}

test('create with a terminal only gets the default folder and a usable check', async () => {
  const { bots, calls } = setup()
  const bot = await bots.create({ name: ' ベロ/タ ', harness: 'claude', terminalId: 'mac' })
  assert.equal(bot.projectRoot, '/Users/kite/BellTeam/ベロ-タ')
  assert.deepEqual(calls.folder, [{ terminalId: 'mac', path: '/Users/kite/BellTeam/ベロ-タ', create: false }])
  assert.deepEqual(bot.folderCheck, { checked: true, reason: null, observedAt: 't' })
  assert.equal(memberFolderSlug('..'), 'member')
})

test('a missing folder refuses the save; createFolder repeats it with create and is not saved', async () => {
  const { bots, calls } = setup({ reason: request => request.create ? null : 'FOLDER_MISSING' })
  await assert.rejects(bots.create({ name: 'x', terminalId: 'mac', projectRoot: '/Users/kite/a' }),
    error => error.code === 'FOLDER_MISSING' && error.status === 409 && error.action === 'do FOLDER_MISSING' && error.projectRoot === '/Users/kite/a')
  assert.equal(calls.create.length, 0)
  const bot = await bots.create({ name: 'x', terminalId: 'mac', projectRoot: '/Users/kite/a', createFolder: true })
  assert.equal(calls.folder.at(-1).create, true)
  assert.equal(Object.hasOwn(calls.create[0], 'createFolder'), false)
  assert.equal(bot.folderCheck.checked, true)
})

test('an unreachable terminal saves the folder as unchecked', async () => {
  const { bots, calls } = setup({ reason: 'UNREACHABLE' })
  const bot = await bots.update('bot-a', { terminalId: 'mac', projectRoot: '/Users/kite/a' })
  assert.equal(calls.update.length, 1)
  assert.deepEqual(bot.folderCheck, { checked: false, reason: 'UNREACHABLE', observedAt: 't', action: 'do UNREACHABLE' })
})

test('unchanged or unrelated edits make no terminal call; preview defaults without one', async () => {
  const current = { id: 'bot-a', name: 'a', terminalId: 'mac', projectRoot: '/Users/kite/a' }
  const { bots, calls } = setup({ current })
  await bots.update('bot-a', { role: 'r' })
  await bots.update('bot-a', { terminalId: 'mac', projectRoot: '/Users/kite/a' })
  assert.equal(calls.folder.length, 0)
  const local = setup()
  await local.bots.previewUpdate('bot-a', { terminalId: 'mac', createFolder: true })
  assert.deepEqual(local.calls.preview, [{ terminalId: 'mac', projectRoot: '/Users/kite/BellTeam/ベロータ' }])
  assert.equal(local.calls.folder.length, 0)
})

test('invalid path, unknown terminal, bad flag and no terminals core', async () => {
  const { bots } = setup()
  await assert.rejects(bots.create({ name: 'x', terminalId: 'nope' }), { code: 'TERMINAL_NOT_FOUND', status: 404 })
  await assert.rejects(bots.create({ name: 'x', createFolder: 'yes' }), { code: 'BOT_UPDATE_FIELD_INVALID', status: 400 })
  const invalid = setup()
  invalid.bots.create = withMemberFolderCheck({ create: async input => input }, () => ({ registry: {}, folder: async () => {
    throw Object.assign(new Error('bad'), { code: 'INVALID_PATH', status: 400 }) } })).create
  await assert.rejects(invalid.bots.create({ name: 'x', terminalId: 'mac', projectRoot: '/a' }), { code: 'BOT_PROJECT_ROOT_INVALID', status: 400 })
  const none = setup({ core: false })
  const bot = await none.bots.create({ name: 'x', terminalId: 'mac', projectRoot: '/a', createFolder: true })
  assert.equal(bot.folderCheck, undefined)
  assert.equal(Object.hasOwn(none.calls.create[0], 'createFolder'), false)
})
