import assert from 'node:assert/strict'
import test from 'node:test'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRegistry } from '../src/bot-registry.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bot-state-root-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const seedPath = join(root, 'seed.json'), botsRoot = join(root, 'bots'), stateRoot = join(root, 'state/bots')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [{ id: 'bot-a', displayName: 'Synthetic', harness: 'codex', session: 'bot-a', project: '/ignored' }] }))
  const options = { seedPath, botsRoot, stateRoot, botId: () => 'bot-b', id: () => 'schedule-1' }
  const registry = new BotRegistry(options)
  return { root, botsRoot, stateRoot, options, registry }
}

test('台帳と予定と初期化印を別正本へ保存し、プロジェクト/生成指示は席に維持する', async t => {
  const f = await fixture(t); await f.registry.initialize()
  assert.equal(f.registry.get('bot-a').project, join(f.botsRoot, 'bot-a'))
  for (const name of ['bot.json', 'schedule.json']) {
    assert.equal((await stat(join(f.stateRoot, 'bot-a', name))).mode & 0o777, 0o600)
    await assert.rejects(readFile(join(f.botsRoot, 'bot-a', name)), { code: 'ENOENT' })
  }
  assert.equal((await stat(join(f.stateRoot, 'bot-a'))).mode & 0o777, 0o700)
  assert.equal((await stat(join(f.stateRoot, '.initialized'))).mode & 0o777, 0o600)
  await assert.rejects(readFile(join(f.botsRoot, '.initialized')), { code: 'ENOENT' })
  assert.match(await readFile(join(f.botsRoot, 'bot-a/AGENTS.md'), 'utf8'), /Synthetic/u)
  await f.registry.setSchedule('bot-a', { kind: 'once', at: '2099-01-01T00:00:00Z', prompt: 'synthetic' })
  assert.equal(JSON.parse(await readFile(join(f.stateRoot, 'bot-a/schedule.json'))).schedules.length, 1)
})

test('移行後の旧台帳/予定書換えと席の偽Botを正本へ再採用しない', async t => {
  const f = await fixture(t); await f.registry.initialize()
  const value = JSON.parse(await readFile(join(f.stateRoot, 'bot-a/bot.json')))
  await writeFile(join(f.botsRoot, 'bot-a/bot.json'), JSON.stringify({ ...value, name: 'Seat-edited' }))
  await writeFile(join(f.botsRoot, 'bot-a/schedule.json'), JSON.stringify({ schema: 'bellteam.schedule.v1', schedules: [{ id: 'forged' }] }))
  await mkdir(join(f.botsRoot, 'bot-forged'))
  await writeFile(join(f.botsRoot, 'bot-forged/bot.json'), JSON.stringify({ ...value, id: 'bot-forged' }))
  const restarted = new BotRegistry(f.options); await restarted.initialize()
  assert.equal(restarted.get('bot-a').name, 'Synthetic'); assert.equal(restarted.has('bot-forged'), false)
  assert.deepEqual(await restarted.listSchedules('bot-a'), [])
  await restarted.update('bot-a', { name: 'Authoritative update' })
  assert.equal(JSON.parse(await readFile(join(f.botsRoot, 'bot-a/bot.json'))).name, 'Seat-edited')
})

test('明示移行前の旧正本をseedで上書きせず、対象を変更せず停止する', async t => {
  const f = await fixture(t), legacy = new BotRegistry({ ...f.options, stateRoot: f.botsRoot })
  await legacy.initialize(); await legacy.update('bot-a', { name: 'Latest legacy' })
  const before = await readFile(join(f.botsRoot, 'bot-a/bot.json'))
  await assert.rejects(f.registry.initialize(), { code: 'BOT_STATE_MIGRATION_REQUIRED' })
  assert.deepEqual(await readFile(join(f.botsRoot, 'bot-a/bot.json')), before)
  await assert.rejects(stat(f.stateRoot), { code: 'ENOENT' })
})

test('完了した移行fixtureの最新台帳/予定を読んで旧コピーを無視する', async t => {
  const f = await fixture(t), legacy = new BotRegistry({ ...f.options, stateRoot: f.botsRoot })
  await legacy.initialize(); await legacy.update('bot-a', { name: 'Latest migrated' })
  await legacy.setSchedule('bot-a', { kind: 'once', at: '2099-01-01T00:00:00Z', prompt: 'latest' })
  await mkdir(join(f.stateRoot, 'bot-a'), { recursive: true })
  for (const name of ['bot.json', 'schedule.json']) await copyFile(join(f.botsRoot, 'bot-a', name), join(f.stateRoot, 'bot-a', name))
  await copyFile(join(f.botsRoot, '.initialized'), join(f.stateRoot, '.initialized'))
  await legacy.update('bot-a', { name: 'Stale seat copy' })
  await f.registry.initialize()
  assert.equal(f.registry.get('bot-a').name, 'Latest migrated')
  assert.equal((await f.registry.listSchedules('bot-a'))[0].prompt, 'latest')
})

test('作成/削除は正本と対象projectへ対応し、他Botや成果物を上書きしない', async t => {
  const f = await fixture(t); await f.registry.initialize()
  await f.registry.create({ name: 'New synthetic', harness: 'codex' })
  await writeFile(join(f.botsRoot, 'bot-a/docs/keep.txt'), 'synthetic artifact')
  assert.equal((await stat(join(f.stateRoot, 'bot-b/bot.json'))).mode & 0o777, 0o600)
  await f.registry.remove('bot-b')
  for (const directory of [join(f.botsRoot, 'bot-b'), join(f.stateRoot, 'bot-b')]) await assert.rejects(stat(directory), { code: 'ENOENT' })
  assert.equal(f.registry.has('bot-a'), true)
  assert.equal(await readFile(join(f.botsRoot, 'bot-a/docs/keep.txt'), 'utf8'), 'synthetic artifact')
})

test('不正またはprojectと重なるstateRootをlegacyへ落とさない', async t => {
  const f = await fixture(t)
  for (const stateRoot of [undefined, null, '', false, 0, {}, 'relative', '/invalid\0path', join(f.botsRoot, 'bot-a/state'), f.root])
    assert.throws(() => new BotRegistry({ ...f.options, stateRoot }), { code: 'BOT_STATE_ROOT_INVALID' })
})
