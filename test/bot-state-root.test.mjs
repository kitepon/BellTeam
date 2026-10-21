import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { createBellTeamServer } from '../src/http-server.mjs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
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


test('split作成は既存project・file・dangling symlinkを再利用しない', async t => {
  const f = await fixture(t); await f.registry.initialize()
  const orphan = join(f.botsRoot, 'bot-b')
  await mkdir(join(orphan, 'environment'), { recursive: true })
  await mkdir(join(orphan, 'memory'))
  await writeFile(join(orphan, 'environment/env.sh'), 'synthetic untrusted env')
  await writeFile(join(orphan, 'memory/previous-session.md'), 'synthetic orphan memory')
  await assert.rejects(f.registry.create({ name: 'New' }), { code: 'BOT_PROJECT_EXISTS' })
  assert.equal(await readFile(join(orphan, 'environment/env.sh'), 'utf8'), 'synthetic untrusted env')
  assert.equal(await readFile(join(orphan, 'memory/previous-session.md'), 'utf8'), 'synthetic orphan memory')
  await assert.rejects(stat(join(f.stateRoot, 'bot-b')), { code: 'ENOENT' })
  await rm(orphan, { recursive: true })
  await writeFile(orphan, 'synthetic orphan file')
  await assert.rejects(f.registry.create({ name: 'New' }, { id: 'bot-b' }), { code: 'BOT_PROJECT_EXISTS' })
  await rm(orphan)
  await symlink(join(f.root, 'absent'), orphan)
  await assert.rejects(f.registry.create({ name: 'New' }, { id: 'bot-b' }), { code: 'BOT_PROJECT_EXISTS' })
})

test('project削除失敗は正本を退役しIDを予約、再起動は未完削除を再開する', async t => {
  const f = await fixture(t); await f.registry.initialize()
  await f.registry.create({ name: 'Remove synthetic' })
  const project = join(f.botsRoot, 'bot-b'), pending = join(f.stateRoot, '.deleting/bot-b')
  await writeFile(join(project, 'keep.txt'), 'synthetic')
  t.after(() => chmod(project, 0o700).catch(() => {}))
  await chmod(project, 0o500)
  await assert.rejects(f.registry.remove('bot-b'), { code: 'BOT_DELETE_PENDING' })
  assert.equal(f.registry.has('bot-b'), false)
  assert.equal((await f.registry.listForClient()).find(bot => bot.id === 'bot-b').deleting, true)
  await f.registry.refresh(); assert.equal(f.registry.has('bot-b'), false)
  assert.equal(await readFile(join(project, 'keep.txt'), 'utf8'), 'synthetic')
  assert.equal((await stat(pending)).isDirectory(), true)
  await assert.rejects(f.registry.create({ name: 'Replacement' }), { code: 'BOT_DELETE_PENDING' })
  await assert.rejects(new BotRegistry(f.options).initialize(), { code: 'BOT_DELETE_PENDING' })
  await chmod(project, 0o700)
  const restarted = new BotRegistry(f.options); await restarted.initialize()
  assert.equal(restarted.has('bot-b'), false); assert.equal(restarted.has('bot-a'), true)
  await assert.rejects(stat(project), { code: 'ENOENT' })
  await assert.rejects(stat(pending), { code: 'ENOENT' })
})

test('正本退役後のstate掃除失敗も記録を保持し、同じremoveで再開できる', async t => {
  const f = await fixture(t); await f.registry.initialize()
  await f.registry.create({ name: 'Remove synthetic' })
  const pendingRoot = join(f.stateRoot, '.deleting'), pending = join(pendingRoot, 'bot-b')
  await mkdir(pendingRoot)
  let changes = 0
  f.registry.onChange = async () => { changes++; await chmod(pendingRoot, 0o500) }
  t.after(() => chmod(pendingRoot, 0o700).catch(error => { if (error.code !== 'ENOENT') throw error }))
  await assert.rejects(f.registry.remove('bot-b'), { code: 'BOT_DELETE_PENDING' })
  assert.equal(changes, 1); assert.equal(f.registry.has('bot-b'), false)
  await assert.rejects(stat(join(f.botsRoot, 'bot-b')), { code: 'ENOENT' })
  assert.equal((await stat(pending)).isDirectory(), true)
  assert.equal((await f.registry.listForClient()).find(bot => bot.id === 'bot-b').deleting, true)
  await assert.rejects(f.registry.create({ name: 'Replacement' }), { code: 'BOT_DELETE_PENDING' })
  await chmod(pendingRoot, 0o700); f.registry.onChange = async () => {}
  assert.deepEqual(await f.registry.remove('bot-b'), { id: 'bot-b' })
  await assert.rejects(stat(pending), { code: 'ENOENT' })
  await f.registry.create({ name: 'Fresh replacement' })
  assert.equal(f.registry.get('bot-b').name, 'Fresh replacement')
})


test('退役renameの失敗ではprojectとactive正本を消さない', async t => {
  const f = await fixture(t); await f.registry.initialize()
  await f.registry.create({ name: 'Still active' })
  await mkdir(join(f.stateRoot, '.deleting'))
  await chmod(f.stateRoot, 0o500)
  try {
    await assert.rejects(f.registry.remove('bot-b'), { code: 'EACCES' })
    assert.equal(f.registry.has('bot-b'), true)
    assert.equal((await stat(join(f.botsRoot, 'bot-b/environment'))).isDirectory(), true)
    assert.equal(JSON.parse(await readFile(join(f.stateRoot, 'bot-b/bot.json'))).name, 'Still active')
  } finally { await chmod(f.stateRoot, 0o700) }
  const restarted = new BotRegistry(f.options); await restarted.initialize()
  assert.equal(restarted.get('bot-b').name, 'Still active')
  assert.equal((await stat(join(f.botsRoot, 'bot-b/environment'))).isDirectory(), true)
  await assert.rejects(stat(join(f.stateRoot, '.deleting/bot-b.json')), { code: 'ENOENT' })
})


test('HTTP一覧の消失は全掃除完了後だけ、pendingは一覧だけに残して起動対象にしない', async t => {
  const f = await fixture(t); await f.registry.initialize()
  await f.registry.create({ name: 'Pending synthetic' })
  const runningInputs = []
  const server = createBellTeamServer({ bots: f.registry, authorize: () => true,
    messenger: {}, store: { async timeline() { return [] } },
    transport: { async runningBots(bots) { runningInputs.push(bots.map(bot => bot.id)); return new Set() } },
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/api/bots`
  const list = async () => { const response = await fetch(url); assert.equal(response.status, 200); return (await response.json()).bots }
  assert.equal((await list()).some(bot => bot.id === 'bot-b'), true)
  const project = join(f.botsRoot, 'bot-b')
  await writeFile(join(project, 'keep.txt'), 'synthetic')
  await chmod(project, 0o500)
  try {
    await assert.rejects(f.registry.remove('bot-b'), { code: 'BOT_DELETE_PENDING' })
    const pending = (await list()).find(bot => bot.id === 'bot-b')
    assert.equal(pending.deleting, true); assert.equal(pending.online, false)
    assert.equal(f.registry.has('bot-b'), false)
    assert.equal(runningInputs.at(-1).includes('bot-b'), false)
    assert.equal(await readFile(join(project, 'keep.txt'), 'utf8'), 'synthetic')
  } finally { await chmod(project, 0o700) }
  await f.registry.remove('bot-b')
  assert.equal((await list()).some(bot => bot.id === 'bot-b'), false)
  await assert.rejects(stat(project), { code: 'ENOENT' })
  await assert.rejects(stat(join(f.stateRoot, '.deleting/bot-b')), { code: 'ENOENT' })
  await assert.rejects(stat(join(f.stateRoot, '.deleting/bot-b.json')), { code: 'ENOENT' })
})


function gate() {
  let release
  const promise = new Promise(resolve => { release = resolve })
  return { promise, release }
}

for (const phase of ['during', 'completed']) for (const crossing of ['list_snapshot', 'running_response', 'other_timeline']) {
  test(`退役renameをまたぐGETの${crossing}/${phase}を現在状態へ再確認する`, { timeout: 5000 }, async t => {
    const f = await fixture(t); await f.registry.initialize()
    await f.registry.create({ name: 'Concurrent synthetic' })
    const reached = gate(), continueGet = gate(), retired = gate(), continueRemove = gate()
    t.after(() => { continueGet.release(); continueRemove.release() })
    const originalRefresh = f.registry.refresh.bind(f.registry)
    f.registry.refresh = async () => {
      try { await stat(join(f.stateRoot, 'bot-b')) } catch (error) {
        if (error.code !== 'ENOENT') throw error
        retired.release()
        await continueRemove.promise
      }
      return originalRefresh()
    }
    const originalList = f.registry.listForClient.bind(f.registry)
    let firstList = true, firstRunning = true
    f.registry.listForClient = async () => {
      const snapshot = await originalList()
      if (crossing === 'list_snapshot' && firstList) {
        firstList = false; reached.release(); await continueGet.promise
      }
      return snapshot
    }
    const runningInputs = []
    const server = createBellTeamServer({ bots: f.registry, authorize: () => true,
      messenger: {}, store: { async timeline(id) {
        if (crossing === 'other_timeline' && id === 'bot-a') {
          reached.release(); await continueGet.promise
        }
        return []
      } },
      transport: { async runningBots(bots) {
        runningInputs.push(bots.map(bot => bot.id))
        if (crossing === 'running_response' && firstRunning) {
          firstRunning = false; reached.release(); await continueGet.promise
        }
        return new Set(bots.map(bot => bot.id))
      } },
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close())
    const url = `http://127.0.0.1:${server.address().port}/api/bots`
    const response = fetch(url)
    await reached.promise
    const removing = f.registry.remove('bot-b')
    await retired.promise
    assert.equal(f.registry.has('bot-b'), false)
    assert.equal(f.registry.isDeleting('bot-b'), true)
    if (phase === 'completed') {
      continueRemove.release(); await removing
      assert.equal(f.registry.isDeleting('bot-b'), false)
      assert.equal(f.registry.clientListingState('bot-b'), 'absent')
      for (const path of [join(f.botsRoot, 'bot-b'), join(f.stateRoot, '.deleting/bot-b'), join(f.stateRoot, '.deleting/bot-b.json')])
        await assert.rejects(stat(path), { code: 'ENOENT' })
    }
    continueGet.release()
    const item = (await (await response).json()).bots.find(bot => bot.id === 'bot-b')
    if (phase === 'completed') assert.equal(item, undefined)
    else { assert.equal(item.deleting, true); assert.equal(item.online, false) }
    if (crossing === 'list_snapshot') assert.equal(runningInputs[0].includes('bot-b'), false)
    continueRemove.release(); await removing
    assert.equal(f.registry.isDeleting('bot-b'), false)
    assert.equal((await (await fetch(url)).json()).bots.some(bot => bot.id === 'bot-b'), false)
  })
}
