import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { createBellTeamServer } from '../src/http-server.mjs'

async function fixture(t, { authenticated = true } = {}) {
  const calls = []
  const bots = new Map([['bot-a', { id: 'bot-a', session: 'synthetic' }]])
  bots.refresh = async () => { calls.push('bots.refresh') }
  const rooms = new Map([['room-a', { id: 'room-a' }]])
  rooms.refresh = async () => { calls.push('rooms.refresh') }
  const server = createBellTeamServer({ bots, rooms, store: {}, transport: {}, writeLog() {},
    authorize: async () => { calls.push('authorize'); return authenticated },
    ownerProfile: { async get() { calls.push('owner.get'); return { name: 'synthetic' } } },
    onboarding: { async status() { calls.push('setup.status'); return { complete: true } } },
    models: { async list() { calls.push('models.list'); return [] } },
    memory: { async recallMemory(input) { calls.push(['recall', input]); return { items: [] } } },
    scheduler: { async runRoomSchedule(owner, id) { calls.push(['schedule.run', owner, id]); return { id } } },
    messenger: { async sendmessage(input) { calls.push(['deliver', input]); return { delivery: 'unknown' } } },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  return { calls, get: (path, options) => fetch(base + path, options) }
}

test('認証は各機能の受付と本文読取の前に一回だけ行い、health/sessionの既存例外を保つ', async t => {
  const { calls, get } = await fixture(t, { authenticated: false })
  for (const path of ['/api/settings', '/api/owner', '/api/bots/bot-a/memory', '/api/rooms/room-a', '/api/deliveries/direct', '/api/rooms/room-a/schedules/x/run', '/api/bots/bot-a/export', '/api/not-found']) {
    calls.length = 0
    const response = await get(path, { method: 'POST', body: '{malformed', headers: { 'content-type': 'application/json' } })
    assert.equal(response.status, 401, path)
    assert.deepEqual(await response.json(), { error: 'UNAUTHORIZED' })
    assert.deepEqual(calls, ['authorize'])
  }
  calls.length = 0
  assert.equal((await get('/healthz')).status, 200)
  assert.deepEqual(calls, [])
  assert.deepEqual(await (await get('/api/session')).json(), { authenticated: false, authMode: 'cloudflare' })
  assert.deepEqual(calls, ['authorize'])
})

test('制御APIの早期返却と機能APIの台帳refresh・共有サービスへの一回委譲を保つ', async t => {
  const { calls, get } = await fixture(t)
  for (const [path, service] of [['/api/setup', 'setup.status'], ['/api/models', 'models.list']]) {
    calls.length = 0
    assert.equal((await get(path)).status, 200)
    assert.deepEqual(calls, ['authorize', service])
  }
  calls.length = 0
  assert.equal((await get('/api/owner')).status, 200)
  assert.deepEqual(calls, ['authorize', 'bots.refresh', 'owner.get'])
  calls.length = 0
  assert.equal((await get('/api/bots/bot-a/memory?query=needle&scope=shared')).status, 200)
  assert.deepEqual(calls, ['authorize', 'bots.refresh', ['recall', { botId: 'bot-a', query: 'needle', scope: 'shared' }]])
  calls.length = 0
  assert.equal((await get('/api/rooms/room-a')).status, 200)
  assert.deepEqual(calls, ['authorize', 'bots.refresh', 'rooms.refresh'])
  calls.length = 0
  assert.equal((await get('/api/rooms/room-a/schedules/a%20b/run', { method: 'POST' })).status, 202)
  assert.deepEqual(calls, ['authorize', 'bots.refresh', ['schedule.run', 'room-a', 'a b']])
  calls.length = 0
  const response = await get('/api/deliveries/direct', { method: 'POST', body: JSON.stringify({ target: 'bot-a', message: 'synthetic' }) })
  assert.deepEqual(await response.json(), { delivery: 'unknown' })
  assert.deepEqual(calls, ['authorize', 'bots.refresh', ['deliver', { target: 'bot-a', message: 'synthetic' }]])
})

test('未一致routeと既存method拒否・欠損Botを区別し、後続機能へ作用を漏らさない', async t => {
  const { calls, get } = await fixture(t)
  for (const [path, method, status, error, refreshed] of [
    ['/api/unknown', 'GET', 404, 'NOT_FOUND', true],
    ['/api/bots/bot-a', 'PUT', 404, 'NOT_FOUND', true],
    ['/api/bots/missing', 'PUT', 404, 'BOT_NOT_FOUND', true],
    ['/api/bots/bot-a/stop', 'GET', 405, 'METHOD_NOT_ALLOWED', true],
    ['/api/subscription-extra', 'GET', 503, 'SUBSCRIPTION_NOT_CONFIGURED', false],
  ]) {
    calls.length = 0
    const response = await get(path, { method })
    assert.equal(response.status, status, path)
    assert.deepEqual(await response.json(), { error })
    assert.deepEqual(calls, refreshed ? ['authorize', 'bots.refresh'] : ['authorize'])
  }
})
