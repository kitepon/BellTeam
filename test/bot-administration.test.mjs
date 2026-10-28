import assert from 'node:assert/strict'
import test from 'node:test'
import { BotAdministration } from '../src/bot-administration.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))

function registry(initial) {
  const bots = new Map([[initial.id, initial]])
  const saved = []
  bots.previewUpdate = async (id, changes) => ({ ...bots.get(id), ...changes })
  bots.update = async (id, changes) => { saved.push(changes); const next = { ...bots.get(id), ...changes }; bots.set(id, next); return next }
  bots.remove = async id => { bots.delete(id); saved.push({ removed: id }) }
  return { bots, saved }
}

test('設定変更は稼働中の席にだけ適用を並べ、保存の応答は適用を待たない', async () => {
  const { bots, saved } = registry({ id: 'bot-a', harness: 'claude', model: 'opus', reasoningEffort: 'high', fastMode: false })
  const applied = []
  let running = false
  const admin = new BotAdministration({ bots, rooms: {}, transport: {
    async isRunning() { return running },
    async reconfigure(current, next) { applied.push([current.model, next.model]) },
  } })
  const idle = await admin.update('bot-a', { model: 'sonnet' })
  assert.deepEqual([idle.configurationChanged, idle.harnessChanged, idle.applying], [true, false, false])
  running = true
  const result = await admin.update('bot-a', { model: 'haiku', role: '整備' })
  assert.deepEqual([result.configurationChanged, result.harnessChanged, result.applying], [true, false, true])
  assert.equal(result.bot.model, 'haiku')
  const profile = await admin.update('bot-a', { role: '保守' })
  assert.deepEqual([profile.configurationChanged, profile.applying], [false, false])
  await tick()
  assert.deepEqual(applied, [['sonnet', 'haiku']])
  assert.deepEqual(saved, [{ model: 'sonnet' }, { model: 'haiku', role: '整備' }, { role: '保守' }])
})

test('ファストモードが開始前に拒否された時だけ保存を元へ戻し、利用者がその後に変えた値は戻さない', async () => {
  const { bots, saved } = registry({ id: 'bot-a', harness: 'claude', fastMode: false })
  const logs = []
  let failure = null, release
  const transport = { async isRunning() { return true }, reconfigure() { return new Promise((resolve, reject) => { release = () => failure ? reject(failure) : resolve() }) } }
  const admin = new BotAdministration({ bots, rooms: {}, transport, writeLog: line => logs.push(line) })
  failure = Object.assign(new Error('AITERM_FAST_UNAVAILABLE'), { code: 'AITERM_FAST_UNAVAILABLE', effect: 'not_started' })
  await admin.update('bot-a', { fastMode: true })
  release(); await tick(); await tick()
  assert.equal(bots.get('bot-a').fastMode, false)
  assert.deepEqual(saved, [{ fastMode: true }, { fastMode: false }])
  assert.equal(logs.some(line => line.includes('AITERM_FAST_UNAVAILABLE')), true)

  await admin.update('bot-a', { fastMode: true })
  await bots.update('bot-a', { fastMode: false })
  release(); await tick(); await tick()
  assert.deepEqual(saved.slice(2), [{ fastMode: true }, { fastMode: false }])

  failure = null
  await admin.update('bot-a', { fastMode: true })
  release(); await tick(); await tick()
  assert.equal(bots.get('bot-a').fastMode, true)
})

test('停止は対象IDと会話維持の確認がある結果だけを成功にし、他は報告を残して失敗にする', async () => {
  const { bots } = registry({ id: 'bot-a' })
  const logs = []
  const results = [
    { botId: 'bot-a', status: 'stop_sent' },
    { botId: 'bot-a', status: 'interrupted', sessionPreserved: true },
    { botId: 'bot-b', status: 'interrupted', sessionPreserved: true },
    { botId: 'bot-a', status: 'interrupted' },
  ]
  const admin = new BotAdministration({ bots, rooms: {}, transport: { async interrupt() { return results.shift() } }, writeLog: line => logs.push(line) })
  assert.deepEqual(await admin.stop(bots.get('bot-a')), { botId: 'bot-a', status: 'stop_sent' })
  assert.equal((await admin.stop(bots.get('bot-a'))).status, 'interrupted')
  await assert.rejects(admin.stop(bots.get('bot-a')), { code: 'BOT_STOP_UNCONFIRMED' })
  await assert.rejects(admin.stop(bots.get('bot-a')), { code: 'BOT_STOP_UNCONFIRMED' })
  assert.equal(logs.filter(line => line.startsWith('BellTeam stop failure: ')).length, 2)
})

test('削除は席を閉じ、部屋から外し、台帳から消す順で進め、途中の失敗は記録して残りを進めない', async () => {
  const { bots, saved } = registry({ id: 'bot-a' })
  const order = [], logs = []
  const admin = new BotAdministration({ bots, writeLog: line => logs.push(line),
    rooms: { async removeBot(id) { order.push(`rooms:${id}`) } },
    transport: { async stop(bot) { order.push(`stop:${bot.id}`) } },
  })
  admin.remove('bot-a')
  await tick(); await tick()
  assert.deepEqual(order, ['stop:bot-a', 'rooms:bot-a'])
  assert.deepEqual(saved, [{ removed: 'bot-a' }])

  const { bots: again } = registry({ id: 'bot-b' })
  const broken = new BotAdministration({ bots: again, writeLog: line => logs.push(line),
    rooms: { async removeBot() { order.push('rooms:bot-b') } },
    transport: { async stop() { throw new Error('CLOSE_FAILED') } },
  })
  broken.remove('bot-b')
  await tick(); await tick()
  assert.equal(again.has('bot-b'), true)
  assert.equal(order.includes('rooms:bot-b'), false)
  assert.equal(logs.some(line => line.includes('CLOSE_FAILED')), true)
})
