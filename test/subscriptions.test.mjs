import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Subscriptions } from '../src/subscriptions.mjs'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { BotScheduler } from '../src/scheduler.mjs'
import { BellTeamMessenger } from '../src/messenger.mjs'
import { RoomMessenger } from '../src/room-messenger.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'
import product from '../services/subscriptions/product.json' with { type: 'json' }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-subscription-'))
  const subscriptions = new Subscriptions({ path: join(root, 'subscription.json'), environment: 'Sandbox' })
  await subscriptions.initialize()
  return { subscriptions, root }
}

// a540: the server checks, keeps and refuses nothing about money; installed apps read one fixed "not gated" answer.
test('契約を確かめない一定の応答を返し、refreshも同じ応答（取り付け済みアプリ向け）', async t => {
  const { subscriptions, root } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixed = { productId: product.productId, environment: 'Sandbox', accessMode: 'developer', setupComplete: false, entitled: false, entitlementState: 'active', canUseAI: true,
    state: 'not_purchased', source: null, isTrial: false, checkedAt: null, expiresAt: null, validUntil: null, autoRenewing: false, billingSources: [], canPurchase: false, error: null }
  assert.deepEqual(subscriptions.status(), fixed)
  assert.deepEqual(await subscriptions.current(), fixed)
  assert.deepEqual(await subscriptions.refresh(), fixed)
  for (const name of ['install', 'installStripe', 'installGoogle', 'checkout', 'manageStripe', 'proof', 'verify']) assert.equal(subscriptions[name], undefined)
})

test('保存ファイルは案内の完了だけを持ち、旧い課金の項目は読み捨て、読み戻し用の空の項目を残す', async t => {
  const { subscriptions, root } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(subscriptions.path, JSON.stringify({ schema: 'bellteam.subscription.v1', setupComplete: true, setup: { botId: 'guide', completedAt: '2026-11-01T00:00:00.000Z' },
    signedTransaction: 'OLD_RECEIPT', stripeSubscriptionId: 'sub_old', googlePurchaseToken: 'old-token', verifications: { apple: { entitled: true } }, verification: { entitled: true }, error: null }))
  const restored = new Subscriptions({ path: subscriptions.path, environment: 'Sandbox' })
  await restored.initialize()
  assert.equal(restored.status().setupComplete, true)
  await restored.completeSetup('guide')
  const saved = JSON.parse(await readFile(subscriptions.path, 'utf8'))
  assert.deepEqual([saved.signedTransaction, saved.stripeSubscriptionId, saved.googlePurchaseToken, saved.verification, saved.verifications], [null, null, null, null, {}])
  assert.equal(saved.setupComplete, true)
  assert.ok(!JSON.stringify(saved).includes('OLD_RECEIPT'))
})

test('購入前のAI動作確認は返答を受け取った時だけ完了し、一度だけ使える', async () => {
  const { subscriptions } = await fixture()
  await assert.rejects(subscriptions.runSetupTest('bot', async () => ''), { code: 'SETUP_REPLY_MISSING' })
  assert.equal(subscriptions.status().setupComplete, false)
  const result = await subscriptions.runSetupTest('bot', async () => '接続できました')
  assert.equal(result.subscription.setupComplete, true)
  assert.equal(result.subscription.entitled, false)
  await assert.rejects(subscriptions.runSetupTest('bot', () => { throw Error('呼び出してはいけない') }), { code: 'SETUP_ALREADY_COMPLETE' })
})

for (const purchaseState of ['契約を確かめない']) {
  test(`${purchaseState}でも送信・Bot間配送・ルーム・予定・起動が使える`, async t => {
    const f = await fixture()
    t.after(() => rm(f.root, { recursive: true, force: true }))
    const status = await f.subscriptions.current()
    assert.equal(status.entitled, false)
    assert.equal(status.canUseAI, true)
    const calls = [], records = [], executed = [], marked = []
    const bot = { id: 'bot', name: '担当', harness: 'codex', project: f.root }
    const other = { id: 'bot-other', name: '相手' }
    const bots = new Map([[bot.id, bot], [other.id, other]])
    bots.refresh = async () => {}
    bots.previewUpdate = async (id, input) => ({ ...bots.get(id), ...input })
    bots.update = async (id, input) => { const updated = { ...bots.get(id), ...input }; bots.set(id, updated); return updated }
    const transport = {
      turn(bot, text) { calls.push(['turn', bot.id, text]); const result = Promise.resolve('返答'); result.accepted = Promise.resolve({ delivery: 'running' }); return result },
      async notify(bot, text) { calls.push(['notify', bot.id, text]); return { delivery: 'running' } },
      async restart(bot) { calls.push(['restart', bot.id]) },
      async reconfigure(bot) { calls.push(['reconfigure', bot.id]) },
      async isRunning() { return true },
    }
    const messenger = new BellTeamMessenger({ bots, transport, logPath: join(f.root, 'messages.jsonl') })
    const room = { id: 'room', name: '相談', memberIds: [bot.id, other.id] }
    const rooms = new Map([[room.id, room]])
    rooms.refresh = async () => {}
    rooms.appendMessage = async (_id, record) => records.push(record)
    const roomMessenger = new RoomMessenger({ rooms, bots, transport, roomTurns: async () => [], chooseResponder: async () => [bot.id] })
    const server = createBellTeamServer({ subscriptions: f.subscriptions, bots, rooms, roomMessenger, messenger, transport, authorize: async () => true })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    t.after(() => server.close())
    const base = `http://127.0.0.1:${server.address().port}`
    const send = (path, body = {}, method = 'POST') => fetch(base + path, {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    assert.equal((await send('/api/bots/bot/messages', { message: 'Webから送信' })).status, 200)
    assert.equal((await send('/api/bots/bot/restart')).status, 200)
    assert.equal((await send('/api/bots/bot', { model: 'new-model' }, 'PATCH')).status, 200)
    await messenger.sendmessage({ from: other.id, target: bot.id, message: 'Bot間の配送' })
    assert.equal((await roomMessenger.sendroommessage({ from: 'user', room: room.id, message: 'ルームの相談' })).delivery, 'running')
    const schedules = [{ id: 'command', enabled: true, command: '試験コマンド', nextRunAt: '2026-09-28T00:00:00Z' },
      { id: 'ai', enabled: true, prompt: '予定のAI送信', nextRunAt: '2026-09-28T00:00:00Z' }]
    const scheduler = new BotScheduler({ registry: {
      refresh: async () => {}, values: () => [bot], listSchedules: async () => schedules,
      claimDue: async input => { marked.push(input); return schedules.find(schedule => schedule.id === input.scheduleId) },
    }, messenger, rooms: {
      refresh: async () => {}, values: () => [room], listSchedules: async () => [{ ...schedules[1], targets: [bot.id] }],
      claimDue: async input => { marked.push(input); return { ...schedules[1], targets: [bot.id] } },
    }, roomMessenger, runCommand: async input => { executed.push(input); return { code: 0 } } })
    await scheduler.runDue()
    assert.equal(executed.length, 1)
    assert.equal(marked.length, 3)
    assert.equal(records.filter(record => record.kind === 'schedule').length, 1)
    assert.ok(calls.some(call => call[0] === 'turn'))
    assert.ok(calls.some(call => call[0] === 'notify' && call[2].includes('Bot間の配送')))
    assert.ok(calls.some(call => call[0] === 'notify' && call[2].includes('予定のAI送信')))
    assert.ok(calls.some(call => call[0] === 'restart'))
    assert.ok(calls.some(call => call[0] === 'reconfigure'))
    const launches = []
    const startup = new AitermTransport({ handoffContext: async () => '', client: { async call(name, args) {
      if (name === 'pty_list') return { content: [{ type: 'text', text: '(セッション無し)' }] }
      if (name === 'agent_launch') { launches.push(args); return { structuredContent: { session_id: 'new-session' } } }
      throw new Error(`想定外の呼出し: ${name}`)
    } } })
    await startup.ensure(bot)
    assert.equal(launches.length, 1)
  })
}

test('失効中も認証済みの会話閲覧は使え、購読状態APIは購入情報を返さない', async t => {
  const { subscriptions } = await fixture()
  const server = createBellTeamServer({subscriptions,bots:new Map([['bot',{id:'bot'}]]),authorize:async()=>true,
    store:{timeline:async()=>[{id:'m',kind:'message',message:'保存済みの会話',direction:'incoming'}]},transport:{},messenger:{}})
  server.listen(0,'127.0.0.1')
  await once(server,'listening')
  t.after(()=>server.close())
  const base=`http://127.0.0.1:${server.address().port}`
  const response=await fetch(base+'/api/bots/bot/messages')
  assert.equal(response.status,200)
  assert.equal((await response.json()).items[0].message,'保存済みの会話')
  const status=await (await fetch(base+'/api/subscription')).json()
  assert.equal(status.subscription.entitled,false)
  assert.equal(status.subscription.signedTransaction,undefined)
})

