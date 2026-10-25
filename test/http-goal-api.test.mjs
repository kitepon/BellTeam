import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { createBellTeamServer } from '../src/http-server.mjs'
import { AiControl } from '../src/ai-control.mjs'

async function fixture(t, { authenticated = true, internal = false, configured = true, paused = false, outcome = 'confirmed' } = {}) {
  const calls = [], bots = new Map([['bot-a', { id: 'bot-a', session: 'existing-seat' }]])
  const binding = { sessionId: 'existing-seat', launchId: 'a'.repeat(32), threadId: 'existing-thread' }
  const snapshot = { botId: 'bot-a', availability: 'available', binding, goal: null }
  const unavailable = { botId: 'bot-b', availability: 'unavailable', goal: null }
  const goals = {
    async list(list) { calls.push(['list', list]); return [snapshot, unavailable] },
    async inspect(bot) { calls.push(['inspect', bot]); return snapshot },
    async mutate(bot, input, context) { calls.push(['mutate', bot, input, context]); return { outcome, snapshot } },
  }
  const server = createBellTeamServer({ bots, rooms: new Map(), store: {}, transport: {}, authorize: async () => authenticated,
    internal, goals: configured ? goals : null, writeLog() {},
    aiControl: { assertEnabled() { AiControl.prototype.assertEnabled.call({ paused }) } },
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const get = (path, options) => fetch(`http://127.0.0.1:${server.address().port}${path}`, options)
  const post = input => get('/api/bots/bot-a/goal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  return { get, post, calls, binding, snapshot, unavailable }
}

test('Owner認証とloopback席の由来を区別し、モデル引数をuser操作へ昇格させない', async t => {
  const unauth = await fixture(t, { authenticated: false })
  assert.equal((await unauth.post({ action: 'clear', binding: unauth.binding })).status, 401)
  assert.deepEqual(unauth.calls, [])
  const seat = await fixture(t, { internal: true })
  assert.equal((await seat.post({ action: 'clear', binding: seat.binding })).status, 403)
  assert.deepEqual(seat.calls, [])
  const owner = await fixture(t)
  assert.equal((await owner.post({ action: 'clear', binding: owner.binding, origin: 'user' })).status, 400)
  assert.deepEqual(owner.calls, [])
})

test('全体一覧と個別取得は登録Botと実snapshotを保ち、取得不能をゴールなしへ変えない', async t => {
  const { get, calls, snapshot, unavailable } = await fixture(t)
  assert.deepEqual(await (await get('/api/goals')).json(), { goals: [snapshot, unavailable] })
  assert.deepEqual(await (await get('/api/bots/bot-a/goal')).json(), { snapshot })
  assert.equal((await get('/api/bots/missing/goal')).status, 404)
  assert.equal(calls.length, 2)
  assert.equal(calls[1][1].session, 'existing-seat')
})

test('設定・編集・一時停止・再開・取消を各一回だけ所有サービスへ渡す', async t => {
  const { post, calls, binding } = await fixture(t)
  for (const input of [
    { action: 'create', objective: '人工の目的' }, { action: 'edit', objective: '変更した目的', tokenBudget: 1000 },
    { action: 'pause' }, { action: 'resume' }, { action: 'clear' },
  ]) {
    const response = await post({ ...input, binding })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).outcome, 'confirmed')
    const call = calls.at(-1)
    assert.deepEqual(call, ['mutate', { id: 'bot-a', session: 'existing-seat' }, { ...input, binding }, { origin: 'user' }])
  }
  assert.equal(calls.length, 5)
})

test('空の目的・不正予算・操作の混在を受付けず、予算を暗黙に追加しない', async t => {
  const { post, calls, binding } = await fixture(t)
  for (const input of [
    { action: 'unknown' }, { action: 'create' }, { action: 'create', objective: ' ' },
    { action: 'create', objective: 'a'.repeat(4001) }, { action: 'edit' },
    { action: 'edit', tokenBudget: null }, { action: 'edit', tokenBudget: 1.5 },
    { action: 'pause', objective: '変える' }, { action: 'resume', tokenBudget: 2 },
  ]) assert.equal((await post({ ...input, binding })).status, 400)
  assert.deepEqual(calls, [])
  await post({ action: 'create', objective: '予算を指定しない', binding })
  assert.equal(Object.hasOwn(calls[0][2], 'tokenBudget'), false)
})

test('AIが停止中はゴールを動かす操作を開始せず、一時停止と取消は受け付ける', async t => {
  const { post, calls, binding } = await fixture(t, { paused: true })
  for (const input of [{ action: 'create', objective: '人工' }, { action: 'edit', objective: '人工' }, { action: 'resume' }])
    assert.equal((await post({ ...input, binding })).status, 423)
  assert.deepEqual(calls, [])
  assert.equal((await post({ action: 'pause', binding })).status, 200)
  assert.equal((await post({ action: 'clear', binding })).status, 200)
  assert.equal(calls.length, 2)
})

test('結果不明は202のまま一回返し、未構成を成功や空一覧にしない', async t => {
  const unknown = await fixture(t, { outcome: 'unconfirmed' })
  const response = await unknown.post({ action: 'clear', binding: unknown.binding })
  assert.equal(response.status, 202)
  assert.equal((await response.json()).outcome, 'unconfirmed')
  assert.equal(unknown.calls.length, 1)
  const absent = await fixture(t, { configured: false })
  assert.equal((await absent.get('/api/goals')).status, 503)
  assert.deepEqual(absent.calls, [])
})
