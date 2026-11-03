import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BotRegistry } from '../src/bot-registry.mjs'
import { OwnerProfile } from '../src/owner-profile.mjs'
import { UserRules } from '../src/user-rules.mjs'
import { MEMBERS_STATE_COMPATIBILITY, assertMembersStateCompatibility } from '../src/members/state-compatibility.mjs'

async function snapshot(root) {
  const files = {}
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files[entry.name] = await snapshot(path)
    else {
      const info = await stat(path, { bigint: true })
      files[entry.name] = { bytes: (await readFile(path)).toString('base64'), mode: info.mode, mtime: info.mtimeNs }
    }
  }
  return files
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'members-restore-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [{ id: 'bot-a', displayName: 'Synthetic', harness: 'grok', session: 'bot-a', project: '/unused' }] }))
  const options = { seedPath, botsRoot: join(root, 'projects'), stateRoot: join(root, 'state') }
  const original = new BotRegistry(options)
  await original.initialize()
  await original.updateSession('bot-a', 'saved-session')
  const owner = new OwnerProfile({ root }), rules = new UserRules({ root })
  await owner.initialize(); await rules.initialize()
  return { root, options, original, owner, rules }
}

test('restore reads current state and pending receipts without bootstrap writes or effects', async t => {
  const f = await fixture(t)
  f.original.projectFiles.remove = async () => { throw new Error('synthetic cleanup failure') }
  await assert.rejects(f.original.remove('bot-a'), /BOT_DELETE_PENDING/)
  const before = await snapshot(f.root)
  const forbidden = () => { throw new Error('restore effect') }
  const restored = new BotRegistry({ ...f.options, projectFiles: new Proxy({}, { get: () => forbidden }), models: { forHarness: forbidden }, onChange: forbidden })
  assert.equal(await restored.restore(), restored)
  assert.equal(restored.has('bot-a'), false)
  assert.equal((await restored.listForClient())[0].deleting, true)
  assert.equal((await restored.listForClient())[0].session, 'saved-session')
  assert.deepEqual(await restored.readRemovalStates(), { removals: [{ botId: 'bot-a', active: false, hasIntent: true, retired: true }] })
  await f.owner.restore(); await f.rules.restore()
  assert.deepEqual(await snapshot(f.root), before)
})

test('restore reads active sessions and schedules without recreating missing documents', async t => {
  const f = await fixture(t), restored = new BotRegistry(f.options)
  await f.original.setSchedule('bot-a', { kind: 'once', at: '2030-01-01T00:00:00Z', prompt: 'Synthetic' })
  const before = await snapshot(f.root)
  await restored.restore()
  assert.equal(restored.get('bot-a').session, 'saved-session')
  assert.equal((await restored.listSchedules('bot-a')).length, 1)
  assert.deepEqual(await snapshot(f.root), before)
  const path = join(f.options.stateRoot, 'bot-a/schedule.json')
  await rm(path)
  await assert.rejects(new BotRegistry(f.options).restore(), { code: 'ENOENT' })
  await assert.rejects(stat(path), { code: 'ENOENT' })
})

test('restore rejects uninitialized, corrupt and old-schema state without repair', async t => {
  const f = await fixture(t), path = join(f.options.stateRoot, 'bot-a/bot.json')
  const raw = await readFile(path, 'utf8')
  for (const content of ['{', raw.replace('bellteam.bot.v8', 'bellteam.bot.v7')]) {
    await writeFile(path, content)
    await assert.rejects(new BotRegistry(f.options).restore())
    assert.equal(await readFile(path, 'utf8'), content)
  }
  await rm(join(f.options.stateRoot, '.initialized'))
  await assert.rejects(new BotRegistry(f.options).restore(), { code: 'BOT_STATE_UNINITIALIZED' })
  for (const storage of [f.owner, f.rules]) {
    await rm(storage.path)
    await assert.rejects(storage.restore(), { code: 'ENOENT' })
    await assert.rejects(stat(storage.path), { code: 'ENOENT' })
  }
})

test('state compatibility accepts only the exact existing format declaration', () => {
  assertMembersStateCompatibility(structuredClone(MEMBERS_STATE_COMPATIBILITY))
  for (const value of [{ ...MEMBERS_STATE_COMPATIBILITY, botProfileSchema: 'bellteam.bot.v9' }, { ...MEMBERS_STATE_COMPATIBILITY, extra: true }, null])
    assert.throws(() => assertMembersStateCompatibility(value), { code: 'MEMBERS_STATE_INCOMPATIBLE' })
})
