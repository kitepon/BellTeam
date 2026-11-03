import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BotAdministration } from '../src/bot-administration.mjs'
import { BotRegistry } from '../src/bot-registry.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'
import { callBellTeamTool } from '../src/mcp-tools.mjs'
import { internalApi } from '../src/seat-mcp.mjs'
import { startMemberRemoval } from '../src/members/deletion.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
function gate() {
  let release
  const promise = new Promise(resolve => { release = resolve })
  return { promise, release }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'members-deletion-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const seedPath = join(root, 'seed.json'), botsRoot = join(root, 'bots'), stateRoot = join(root, 'state/bots')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [] }))
  const bots = new BotRegistry({ seedPath, botsRoot, stateRoot })
  await bots.initialize()
  for (const id of ['bot-a', 'bot-b']) await bots.create({ name: id }, { id })
  const keep = join(botsRoot, 'bot-a/docs/keep.txt')
  await writeFile(keep, 'unrelated artifact')
  const project = join(botsRoot, 'bot-b'), pending = join(stateRoot, '.deleting/bot-b'), record = `${pending}.json`
  const absent = async () => {
    for (const path of [project, pending, record]) await assert.rejects(stat(path), { code: 'ENOENT' })
    assert.equal((await bots.listForClient()).some(bot => bot.id === 'bot-b'), false)
    assert.equal(await readFile(keep, 'utf8'), 'unrelated artifact')
    assert.equal(bots.has('bot-a'), true)
  }
  return { bots, project, pending, record, absent }
}

test('CLI同期失敗は削除のcleanupを妨げず、削除完了と別の結果を返す', async t => {
  const f = await fixture(t)
  let calls = 0
  f.bots.onChange = async bots => {
    calls++
    assert.equal(bots.has('bot-b'), false)
    await f.absent()
    throw new SyntaxError('Unexpected end of JSON input')
  }
  assert.deepEqual(await f.bots.remove('bot-b'), {
    id: 'bot-b', configurationSync: { state: 'failed', name: 'SyntaxError', message: 'Unexpected end of JSON input' },
  })
  assert.equal(calls, 1)
  await f.absent()
  await assert.rejects(f.bots.remove('bot-b'), /BOT_NOT_FOUND/u)
})

test('project cleanup and CLI effects do not hold the same Bot session mutation lock', { timeout: 2000 }, async t => {
  const f = await fixture(t), remove = f.bots.projectFiles.remove.bind(f.bots.projectFiles)
  f.bots.projectFiles.remove = async project => {
    await assert.rejects(f.bots.updateSession('bot-b', 'late-session'), /BOT_NOT_FOUND/)
    await f.bots.updateSession('bot-a', 'other-session')
    await remove(project)
  }
  f.bots.onChange = async () => {
    await assert.rejects(f.bots.updateSession('bot-b', 'late-cli-session'), /BOT_NOT_FOUND/)
  }
  await f.bots.remove('bot-b')
  assert.equal(f.bots.get('bot-a').session, 'other-session')
  await f.absent()
})

test('retirement waits accepted instruction effects before physical cleanup without state lock', async t => {
  const f = await fixture(t), entered = gate(), release = gate(), retired = gate()
  f.bots.projectFiles.writeInstructions = async () => { entered.release(); await release.promise }
  const updating = f.bots.update('bot-b', { name: 'saved before removal' })
  await entered.promise
  const unwatch = f.bots.watch(() => { if (!f.bots.has('bot-b')) retired.release() })
  t.after(unwatch)
  const removing = f.bots.remove('bot-b')
  await retired.promise
  await assert.rejects(f.bots.updateSession('bot-b', 'late-session'), /BOT_NOT_FOUND/)
  assert.ok(await stat(f.project))
  release.release()
  await assert.rejects(updating, { code: 'BOT_UPDATE_RETIRED', outcome: 'unknown' })
  await removing
  await f.absent()
})

test('early asset cancellation requires fresh active state and skips unknown or retired failures', { timeout: 2000 }, async t => {
  for (const unknown of [false, true]) {
    const f = await fixture(t), refresh = f.bots.refresh.bind(f.bots), cancelled = []
    f.bots.assetRemoval = {
      async prepareBotAssetRemoval() {
        let fail = true
        f.bots.refresh = async () => {
          if (fail) { fail = false; throw Object.assign(new Error('synthetic pre-retirement failure'), unknown ? { outcome: 'unknown' } : {}) }
          return refresh()
        }
        return 'asset-gate'
      },
      async cancelBotAssetRemoval(id, lease, state) {
        cancelled.push({ id, lease, state })
        await f.bots.updateSession(id, 'cancel-callback')
        return true
      },
    }
    await assert.rejects(f.bots.remove('bot-b'), /synthetic pre-retirement/)
    assert.deepEqual(cancelled, unknown ? [] : [{ id: 'bot-b', lease: 'asset-gate', state: { active: true, hasIntent: false, retired: false } }])
  }
  const f = await fixture(t), cancelled = []
  f.bots.assetRemoval = { prepareBotAssetRemoval: async () => 'asset-gate', cancelBotAssetRemoval: async () => { cancelled.push(true) } }
  f.bots.projectFiles.remove = async () => { throw new Error('synthetic cleanup failure') }
  await assert.rejects(f.bots.remove('bot-b'), /BOT_DELETE_PENDING/)
  assert.deepEqual(cancelled, [])
  assert.ok(await stat(f.pending))
})

test('202 deletion retains one parent lease through stop, cleanup and final callback', async t => {
  const f = await fixture(t), stopped = gate(), release = gate(), removed = gate(), lease = Object.freeze({ opaque: true }), contexts = []
  let finished = 0
  const remove = f.bots.remove.bind(f.bots)
  f.bots.remove = (id, options) => { contexts.push(options.membersLease); return remove(id) }
  assert.deepEqual(await startMemberRemoval('bot-b', {
    bots: f.bots, rooms: { removeBot: async () => {} }, writeLog: () => {}, onRemoved: () => removed.release(),
    transport: { membersAdmission: { enter: () => lease, finish: value => { assert.equal(value, lease); finished++ } },
      async stop(bot, version = 7, options = {}) {
        assert.equal(version, 7, 'second argument must remain the native stop version')
        contexts.push(options.membersLease); stopped.release(); await release.promise
      } },
  }), { deleting: 'bot-b' })
  await stopped.promise
  assert.equal(finished, 0)
  release.release(); await removed.promise; await tick()
  assert.deepEqual(contexts, [lease, lease]); assert.equal(finished, 1)
  await f.absent()
})

for (const remaining of ['both', 'record', 'directory']) {
  test(`正規MCP→HTTP DELETEは既pending(${remaining})をnative停止なしで再開し、完全不存在を拒む`, async t => {
    const f = await fixture(t), native = [], logs = []
    const removeProject = f.bots.projectFiles.remove.bind(f.bots.projectFiles)
    f.bots.projectFiles.remove = async () => { throw new Error('CLEANUP_FAILED') }
    await assert.rejects(f.bots.remove('bot-b'), { code: 'BOT_DELETE_PENDING' })
    if (remaining === 'record') await rm(f.pending, { recursive: true })
    if (remaining === 'directory') await rm(f.record)
    assert.equal(await f.bots.hasPendingRemoval('bot-b'), true)
    const synced = gate()
    f.bots.projectFiles.remove = removeProject
    f.bots.onChange = async () => { synced.release() }
    const server = createBellTeamServer({ bots: f.bots, authorize: () => true,
      rooms: { async removeBot(id) { native.push(['rooms', id]) } },
      messenger: {}, store: { async timeline() { return [] } },
      transport: { async stop(bot) { native.push(['stop', bot.id]) }, async runningBots() { return new Set() } },
      writeLog: line => logs.push(line),
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close())
    const port = server.address().port, api = internalApi(port)
    for (const method of ['GET', 'PATCH']) {
      const response = await fetch(`http://127.0.0.1:${port}/api/bots/bot-b`, { method })
      assert.equal(response.status, 404)
    }
    const call = () => callBellTeamTool({ name: 'delete_bot', arguments: { botId: 'bot-b' },
      from: 'bot-a', registry: f.bots, remove: api.remove })
    assert.deepEqual(await call(), { deleting: 'bot-b' })
    await synced.promise; await tick()
    await f.absent()
    assert.deepEqual(native, [])
    assert.equal(logs.some(line => line.includes('delete error')), false)
    await assert.rejects(call(), /BOT_NOT_FOUND/u)
    const missing = await fetch(`http://127.0.0.1:${port}/api/bots/bot-b`, { method: 'DELETE' })
    assert.equal(missing.status, 404)
    assert.equal((await missing.json()).error, 'BOT_NOT_FOUND')
    assert.deepEqual(native, [])
  })
}

for (const cleanupFails of [false, true]) {
  test(`背景削除のcleanup失敗=${cleanupFails}とCLI同期失敗を別に記録する`, async t => {
    const f = await fixture(t), synced = gate(), logs = [], order = []
    if (cleanupFails) f.bots.projectFiles.remove = async () => { throw new Error('CLEANUP_FAILED') }
    f.bots.onChange = async () => { synced.release(); throw Object.assign(new Error('CONFIG_FAILED'), { code: 'CONFIG_FAILED', status: 503 }) }
    const admin = new BotAdministration({ bots: f.bots, writeLog: line => logs.push(line),
      transport: { async stop(bot) { order.push(`stop:${bot.id}`) } },
      rooms: { async removeBot(id) { order.push(`rooms:${id}`) } },
    })
    admin.applications.set('bot-b', { state: 'accepted' })
    assert.deepEqual(await admin.remove('bot-b'), { deleting: 'bot-b' })
    await synced.promise; await tick(); await tick()
    assert.deepEqual(order, ['stop:bot-b', 'rooms:bot-b'])
    assert.equal(logs.filter(line => line.includes('CLI configuration sync error after delete: bot-b:')).length, 1)
    assert.equal(logs.some(line => line.includes('delete error: bot-b:')), cleanupFails)
    assert.equal(admin.applications.has('bot-b'), cleanupFails)
    if (cleanupFails) {
      assert.equal((await f.bots.listForClient()).find(bot => bot.id === 'bot-b').deleting, true)
      assert.equal(await f.bots.hasPendingRemoval('bot-b'), true)
    } else await f.absent()
  })
}

test('同じ対象の同時cleanupを既存のプロフィール変更順序で直列化する', async t => {
  const f = await fixture(t), reached = gate(), proceed = gate()
  t.after(() => proceed.release())
  const removeProject = f.bots.projectFiles.remove.bind(f.bots.projectFiles)
  let calls = 0
  f.bots.projectFiles.remove = async project => { calls++; reached.release(); await proceed.promise; await removeProject(project) }
  const first = f.bots.remove('bot-b')
  await reached.promise
  const second = assert.rejects(f.bots.remove('bot-b'), /BOT_NOT_FOUND/u)
  await tick()
  assert.equal(calls, 1)
  proceed.release()
  await first; await second
  assert.equal(calls, 1)
  await f.absent()
})
