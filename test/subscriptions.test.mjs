import assert from 'node:assert/strict'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { Subscriptions } from '../src/subscriptions.mjs'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { BotScheduler } from '../src/scheduler.mjs'
import { BellTeamMessenger } from '../src/messenger.mjs'
import { RoomMessenger } from '../src/room-messenger.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'
import product from '../services/subscriptions/product.json' with { type: 'json' }

async function fixture(accessMode = 'subscription') {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-subscription-'))
  let now = Date.parse('2026-09-28T03:00:00Z')
  let active = true
  let fail = false
  const requests = []
  const subscriptions = new Subscriptions({
    path: join(root, 'subscription.json'), environment: 'Sandbox', accessMode, clock: () => now,
    fetch: async (url, request) => {
      requests.push({ url, body: JSON.parse(request.body) })
      if (fail) throw new Error('試験用の通信障害')
      return Response.json({ productId: product.productId, environment: 'Sandbox', originalTransactionId: 'original',
        checkedAt: new Date(now).toISOString(), entitled: active, state: active ? 'active' : 'expired',
        expiresAt: new Date(now + 30 * 60 * 1000).toISOString(),
        validUntil: active ? new Date(now + 30 * 60 * 1000).toISOString() : null, autoRenewing: false,
      })
    },
  })
  await subscriptions.initialize()
  return { subscriptions, requests, root, advance: ms => { now += ms }, setActive: value => { active = value }, fail: () => { fail = true } }
}

test('一般配布版は開発者免除を拒否し、未購入でもWebのAI利用は無料', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-public-subscription-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'services/subscriptions'), { recursive: true })
  for (const [source, target] of [
    ['src/subscriptions.mjs', 'src/subscriptions.mjs'],
    ['distribution/server/distribution-profile.mjs', 'src/distribution-profile.mjs'],
    ['services/subscriptions/product.json', 'services/subscriptions/product.json'],
    ['services/subscriptions/endpoints.json', 'services/subscriptions/endpoints.json'],
  ]) await copyFile(new URL('../' + source, import.meta.url), join(root, target))
  const { Subscriptions: PublicSubscriptions } = await import(pathToFileURL(join(root, 'src/subscriptions.mjs')))
  assert.throws(() => new PublicSubscriptions({ path: join(root, 'state.json'), accessMode: 'developer' }), {
    message: 'SUBSCRIPTION_DEVELOPER_ACCESS_UNAVAILABLE',
  })
  const subscriptions = new PublicSubscriptions({ path: join(root, 'state.json') })
  await subscriptions.initialize()
  assert.equal(subscriptions.status().accessMode, 'subscription')
  assert.equal(subscriptions.status().canUseAI, true)
  assert.equal(subscriptions.status().entitled, false)
})

test('開発者設定のApple免除は保持し、購入情報を照会しない', async t => {
  const { subscriptions, requests, root } = await fixture('developer')
  t.after(() => rm(root, { recursive: true, force: true }))
  const status = await subscriptions.current()
  assert.equal(status.accessMode, 'developer')
  assert.equal(status.canUseAI, true)
  assert.equal(status.entitled, false)
  assert.equal(status.state, 'not_purchased')
  await subscriptions.refresh({ force: true })
  assert.throws(() => subscriptions.install('購入を送ってはいけない'), { code: 'SUBSCRIPTION_NOT_REQUIRED' })
  assert.equal(requests.length, 0)
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

test('更新停止でも有効期間中は使え、期限に再照会して失効を反映する', async () => {
  const f = await fixture()
  await f.subscriptions.install('signed-purchase')
  assert.equal((await f.subscriptions.current()).entitled, true)
  assert.equal(f.subscriptions.status().autoRenewing, false)
  assert.equal(f.requests.length, 1)
  assert.deepEqual(f.requests[0].body, { signedTransaction: 'signed-purchase' })
  f.advance(30 * 60 * 1000)
  f.setActive(false)
  const expired = await f.subscriptions.current()
  assert.equal(expired.entitled, false)
  assert.equal(expired.canUseAI, true)
  assert.equal(f.requests.length, 2)
  assert.equal(f.subscriptions.status().state, 'expired')
})

test('通信障害は有効扱いに置き換えず、明示的な再確認まで再試行しない', async () => {
  const f = await fixture()
  await f.subscriptions.install('signed-purchase')
  f.advance(30 * 60 * 1000)
  f.fail()
  await assert.rejects(f.subscriptions.refresh(), { code: 'SUBSCRIPTION_CONNECTION_FAILED' })
  const status = await f.subscriptions.current()
  assert.equal(status.error.code, 'SUBSCRIPTION_CONNECTION_FAILED')
  assert.equal(status.canUseAI, true)
  await f.subscriptions.current()
  assert.equal(f.requests.length, 2)
  assert.equal(f.subscriptions.status().entitled, false)
  assert.match(f.subscriptions.status().error.message, /再確認/u)
})

test('同じ購入情報を別サーバーへ復元でき、再起動でも期限と設定を保持する', async () => {
  const first = await fixture()
  const second = await fixture()
  await first.subscriptions.install('same-apple-purchase')
  await second.subscriptions.install('same-apple-purchase')
  assert.equal(first.subscriptions.status().entitled, true)
  assert.equal(second.subscriptions.status().entitled, true)
  const restored = new Subscriptions({path: first.subscriptions.path, environment:'Sandbox', clock:first.subscriptions.clock})
  await restored.initialize()
  assert.equal(restored.status().entitled, true)
  assert.equal(JSON.parse(await readFile(first.subscriptions.path, 'utf8')).signedTransaction, 'same-apple-purchase')
})

for (const purchaseState of ['未購入', '失効', '通信エラー']) {
  test(`${purchaseState}でも送信・Bot間配送・ルーム・予定・起動が使える`, async t => {
    const f = await fixture()
    t.after(() => rm(f.root, { recursive: true, force: true }))
    if (purchaseState !== '未購入') {
      await f.subscriptions.install('signed-purchase')
      f.advance(30 * 60 * 1000)
      if (purchaseState === '失効') f.setActive(false)
      else f.fail()
    }
    const status = await f.subscriptions.current()
    assert.equal(status.entitled, false)
    assert.equal(status.canUseAI, true)
    if (purchaseState === '通信エラー') assert.equal(status.error.code, 'SUBSCRIPTION_CONNECTION_FAILED')
    const checked = f.requests.length
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
    assert.equal(f.requests.length, checked)
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

test('Stripeの購入を保存し、Appleと両方ある時は有効な方を使い、旧い保存形式も読める', async t => {
  const now = Date.parse('2026-11-17T03:00:00Z')
  const root = await mkdtemp(join(tmpdir(), 'bellteam-subscription-stripe-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const verdict = (source, entitled, hours) => ({ productId: product.productId, environment: 'Sandbox', source, ...(source === 'stripe' ? { subscriptionId: 'sub_1' } : {}),
    checkedAt: new Date(now).toISOString(), entitled, state: entitled ? 'active' : 'expired', isTrial: source === 'stripe' && entitled, autoRenewing: true,
    expiresAt: new Date(now + hours * 3600000).toISOString(), validUntil: entitled ? new Date(now + hours * 3600000).toISOString() : null })
  const requests = []
  let apple = verdict('apple', false, -1)
  const subscriptions = new Subscriptions({ path: join(root, 'subscription.json'), environment: 'Sandbox', clock: () => now, fetch: async (url, request) => {
    const body = JSON.parse(request.body)
    requests.push({ url, body })
    if (url.endsWith('/stripe/checkout')) return Response.json({ url: 'https://checkout.stripe.test/c/1', sessionId: 'cs_1' })
    return Response.json(body.signedTransaction ? apple : verdict('stripe', true, 2))
  } })
  await subscriptions.initialize()
  assert.deepEqual(await subscriptions.checkout(), { url: 'https://checkout.stripe.test/c/1', sessionId: 'cs_1' })
  assert.match(requests[0].url, /\/v1\/subscriptions\/stripe\/checkout$/)
  assert.equal(subscriptions.proof(), null)
  await subscriptions.install('signed-purchase')
  assert.equal(subscriptions.status().entitled, false)
  assert.equal(subscriptions.proof(), null)
  const status = await subscriptions.installStripe('cs_1')
  assert.deepEqual(subscriptions.proof(), { stripeSubscriptionId: 'sub_1' })
  assert.notEqual(subscriptions.proof(), subscriptions.proof())
  assert.deepEqual([status.entitled, status.source, status.isTrial, status.canUseAI], [true, 'stripe', true, true])
  assert.equal(JSON.parse(await readFile(subscriptions.path, 'utf8')).stripeSubscriptionId, 'sub_1')
  {
    const later = new Subscriptions({ path: subscriptions.path, environment: 'Sandbox', clock: () => now + 3 * 3600000, fetch: async (url, request) => {
      const body = JSON.parse(request.body)
      requests.push({ url, body })
      return Response.json(body.signedTransaction ? apple : { ...verdict('stripe', false, 2), checkedAt: new Date(now + 3 * 3600000).toISOString() })
    } })
    await later.initialize()
    await later.refresh({ force: true })
    assert.deepEqual(requests.slice(-2).map(request => Object.keys(request.body)[0]), ['signedTransaction', 'stripeSubscriptionId'])
    assert.equal(later.status().entitled, false)
    assert.equal(later.proof(), null)
  }
  const legacy = join(root, 'legacy.json')
  await writeFile(legacy, JSON.stringify({ schema: 'bellteam.subscription.v1', setupComplete: false, signedTransaction: 'old', verification: verdict('apple', true, 1), error: null }))
  const old = new Subscriptions({ path: legacy, environment: 'Sandbox', clock: () => now })
  await old.initialize()
  assert.deepEqual([old.status().entitled, old.status().source], [true, 'apple'])
  assert.deepEqual(old.proof(), { signedTransaction: 'old' })
  assert.throws(() => new Subscriptions({ path: join(root, 'd.json'), accessMode: 'developer', developerAccessAllowed: true }).installStripe('cs_1'), { code: 'SUBSCRIPTION_NOT_REQUIRED' })
  assert.equal(new Subscriptions({ path: join(root, 'd.json'), accessMode: 'developer', developerAccessAllowed: true }).proof(), null)
})

test('課金中の購読がある間はStripeの購入画面を作らず、作った画面は使い回し、管理の入口を返す', async t => {
  const now = Date.parse('2026-11-17T03:00:00Z')
  const root = await mkdtemp(join(tmpdir(), 'bellteam-subscription-double-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let stripeState = 'active', session = { status: 'open', url: 'https://checkout.stripe.test/c/1' }, created = 0, down = false
  const verdict = state => ({ productId: product.productId, environment: 'Sandbox', source: 'stripe', subscriptionId: 'sub_1', checkedAt: new Date(now).toISOString(),
    entitled: state === 'active', state, isTrial: false, autoRenewing: false, expiresAt: new Date(now + 3600000).toISOString(), validUntil: state === 'active' ? new Date(now + 3600000).toISOString() : null })
  const requests = []
  const subscriptions = new Subscriptions({ path: join(root, 'subscription.json'), environment: 'Sandbox', clock: () => now, fetch: async (url, request) => {
    const body = JSON.parse(request.body)
    requests.push({ url, body })
    if (down) throw new Error('offline')
    if (url.endsWith('/stripe/portal')) return Response.json({ url: 'https://billing.stripe.test/p/1' })
    if (url.endsWith('/stripe/checkout')) return body.sessionId ? Response.json({ sessionId: body.sessionId, ...session }) : Response.json({ url: `https://checkout.stripe.test/c/${++created}`, sessionId: `cs_${created}` })
    return Response.json(verdict(stripeState))
  } })
  await subscriptions.initialize()
  assert.deepEqual([subscriptions.status().canPurchase, subscriptions.status().billingSources], [true, []])
  assert.throws(() => subscriptions.manageStripe(), { code: 'NO_STRIPE_SUBSCRIPTION' })
  // 二つの端末が同時に押しても、同じ画面を返し、新しく作らない。
  const [first, second] = await Promise.all([subscriptions.checkout(), subscriptions.checkout()])
  assert.deepEqual([first.sessionId, second.sessionId, created], ['cs_1', 'cs_1', 1])
  // 戻りのSession IDを送らずに支払い済みになっていても、次の購入要求で取り込み、二重に作らない。
  session = { status: 'complete', url: null }
  await assert.rejects(subscriptions.checkout(), { code: 'SUBSCRIPTION_ALREADY_ACTIVE' })
  assert.equal(created, 1)
  const status = subscriptions.status()
  assert.deepEqual([status.entitled, status.canPurchase, status.billingSources], [true, false, ['stripe']])
  assert.deepEqual(await subscriptions.manageStripe(), { url: 'https://billing.stripe.test/p/1' })
  assert.deepEqual(requests.at(-1).body, { stripeSubscriptionId: 'sub_1' })
  // 解約予約中でも、期間が終わるまでは新しい購入を受け付けない。
  await assert.rejects(subscriptions.checkout(), { code: 'SUBSCRIPTION_ALREADY_ACTIVE' })
  // 支払い再試行中は有効ではないが、まだ課金が続くので受け付けない。
  stripeState = 'billing_retry'
  await assert.rejects(subscriptions.checkout(), { code: 'SUBSCRIPTION_ALREADY_ACTIVE' })
  assert.equal(subscriptions.status().entitled, false)
  // 確認できない間は作らず、接続が戻れば期限切れの後に作れる。
  down = true
  await assert.rejects(subscriptions.checkout(), { code: 'SUBSCRIPTION_CONNECTION_FAILED' })
  down = false
  stripeState = 'expired'
  assert.equal((await subscriptions.checkout()).sessionId, 'cs_2')
  assert.equal(subscriptions.status().canPurchase, true)
  assert.throws(() => new Subscriptions({ path: join(root, 'd.json'), accessMode: 'developer', developerAccessAllowed: true }).manageStripe(), { code: 'SUBSCRIPTION_NOT_REQUIRED' })
})

test('Google Playの購入トークンを保存し、課金中は購入元に数え、証拠は一つだけ返し、トークンは状態に出さない', async t => {
  const now = Date.parse('2026-11-19T00:00:00Z')
  const root = await mkdtemp(join(tmpdir(), 'bellteam-subscription-google-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let verdict = { productId: product.productId, environment: 'Sandbox', source: 'google', checkedAt: new Date(now).toISOString(), entitled: true, state: 'active', isTrial: true, autoRenewing: true,
    expiresAt: new Date(now + 3600000).toISOString(), validUntil: new Date(now + 3600000).toISOString() }
  const requests = []
  const open = (clock = () => now) => new Subscriptions({ path: join(root, 'subscription.json'), environment: 'Sandbox', clock, fetch: async (url, request) => {
    requests.push({ url, body: JSON.parse(request.body) })
    return Response.json(verdict)
  } })
  const subscriptions = open()
  await subscriptions.initialize()
  assert.equal(subscriptions.proof(), null)
  const status = await subscriptions.installGoogle('purchase-token-1')
  assert.deepEqual([status.entitled, status.source, status.isTrial, status.billingSources, status.canPurchase], [true, 'google', true, ['google'], false])
  assert.deepEqual(requests[0].body, { googlePurchaseToken: 'purchase-token-1' })
  assert.deepEqual(subscriptions.proof(), { googlePurchaseToken: 'purchase-token-1' })
  assert.equal(JSON.stringify(status).includes('purchase-token-1'), false)
  assert.equal(JSON.parse(await readFile(subscriptions.path, 'utf8')).googlePurchaseToken, 'purchase-token-1')
  // 保存したトークンで再照会し、期限が切れれば証拠も返さない。
  verdict = { ...verdict, entitled: false, state: 'expired', validUntil: null, checkedAt: new Date(now + 7200000).toISOString() }
  const later = open(() => now + 7200000)
  await later.initialize()
  await later.refresh({ force: true })
  assert.deepEqual(requests.at(-1).body, { googlePurchaseToken: 'purchase-token-1' })
  assert.deepEqual([later.status().entitled, later.status().billingSources, later.status().canPurchase, later.proof()], [false, [], true, null])
  // Productionの環境と合わない結果は保存しない。
  verdict = { ...verdict, environment: 'Production', entitled: true, state: 'active', validUntil: new Date(now + 9000000).toISOString() }
  await assert.rejects(open().installGoogle('purchase-token-2'), { code: 'SUBSCRIPTION_RESPONSE_INVALID' })
  assert.throws(() => new Subscriptions({ path: join(root, 'd.json'), accessMode: 'developer', developerAccessAllowed: true }).installGoogle('t'), { code: 'SUBSCRIPTION_NOT_REQUIRED' })
  assert.throws(() => open().installGoogle(''), { code: 'INVALID_GOOGLE_PROOF' })
})
