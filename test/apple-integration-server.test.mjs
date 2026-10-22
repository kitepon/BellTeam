import assert from 'node:assert/strict'
import test from 'node:test'
import { startAppleIntegrationServer } from './helpers/apple-integration-server.mjs'

async function fixture(t) {
  const server = await startAppleIntegrationServer()
  t.after(() => server.close())
  const get = async path => {
    const response = await fetch(server.url + path)
    assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`)
    return response.json()
  }
  async function connect() {
    const abort = new AbortController()
    t.after(() => abort.abort())
    const response = await fetch(server.url + '/api/events', { signal: abort.signal })
    assert.equal(response.status, 200)
    const reader = response.body.getReader(), decoder = new TextDecoder()
    let buffer = ''
    const next = async () => {
      const timeout = setTimeout(() => abort.abort(new Error('FIXTURE_SSE_TIMEOUT')), 2000)
      try {
        while (!buffer.includes('\n\n')) {
          const result = await reader.read()
          if (result.done) return null
          buffer += decoder.decode(result.value, { stream: true })
        }
        const end = buffer.indexOf('\n\n'), raw = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        return { event: raw.match(/^event: (.*)/mu)?.[1], text: raw.match(/^data: (.*)/mu)?.[1] }
      } finally { clearTimeout(timeout) }
    }
    assert.deepEqual(await next(), { event: 'ready', text: '{}' })
    return { abort, next, message: async () => JSON.parse((await next()).text) }
  }
  return { ...server, get, connect }
}

test('Apple結合入口は実APIと実監視でBot/peer/過去status/roomを返し、要求と配信を記録する', { timeout: 15000 }, async t => {
  const f = await fixture(t), sse = await f.connect()
  assert.deepEqual((await f.get('/api/bots?avatar=omit')).bots.map(x => x.id), ['bot-one', 'bot-two', 'bot-three'])
  assert.deepEqual((await f.get('/api/rooms?avatar=omit')).rooms.map(x => x.id), ['ideas', 'planning'])
  const added = await f.get('/test/bot?bot=bot-two')
  let change = await sse.message()
  assert.equal(change.all, false); assert.deepEqual(change.botIds, ['bot-two']); assert.deepEqual(change.topics, ['timeline'])
  assert.equal((await f.get('/api/bots/bot-two/messages')).items.at(-1).message, added.text)
  assert.ok(!(await f.get('/api/bots/bot-one/messages')).items.some(x => x.id === added.id))
  const peer = await f.get('/test/peer')
  change = await sse.message()
  assert.deepEqual(new Set(change.botIds), new Set(['bot-one', 'bot-two'])); assert.equal(change.all, false)
  for (const id of ['bot-one', 'bot-two']) assert.ok((await f.get(`/api/bots/${id}/messages`)).items.some(x => x.id === peer.id))
  await f.get('/test/status')
  change = await sse.message(); assert.deepEqual(change.botIds, ['bot-one'])
  assert.equal((await f.get('/api/bots/bot-one/messages')).items.find(x => x.id === 'baseline-bot-one-1').delivery, 'failed')
  const room = await f.get('/test/room')
  change = await sse.message(); assert.equal(change.all, false); assert.deepEqual(change.roomIds, ['planning'])
  assert.equal((await f.get('/api/rooms/planning/messages')).items.at(-1).message, room.text)
  const proof = await f.get('/test/proof')
  assert.match(proof.sourceRevision, /^[a-f0-9]{40}$/u)
  assert.ok(proof.requests.some(x => x.path === '/api/bots/bot-one/messages' && x.status === 200))
  assert.ok(proof.events.some(x => x.event === 'messages' && x.origin === 'product-server' && x.data.roomIds.includes('planning')))
  assert.ok(proof.cli.every(x => x.name === 'pty_list' || x.name === 'pty_read'))
  sse.abort.abort()
})

test('Apple結合入口のqueue/カード/予定/ownerは実GETと対応する通知を照合できる', { timeout: 15000 }, async t => {
  const f = await fixture(t), sse = await f.connect()
  for (const active of ['1', '0']) {
    await f.get(`/test/queue?bot=bot-one&room=planning&active=${active}`)
    const change = await sse.message()
    assert.deepEqual(change.topics, ['queue']); assert.deepEqual(change.botIds, ['bot-one']); assert.deepEqual(change.roomIds, ['planning'])
    assert.equal((await f.get('/api/rooms/planning/queue')).items.length, active === '1' ? 1 : 0)
  }
  const request = await f.get('/test/request?bot=bot-one&room=planning')
  let change = await sse.message(); assert.deepEqual(change.topics, ['requests']); assert.deepEqual(change.roomIds, ['planning'])
  assert.ok((await f.get('/api/rooms/planning/messages')).items.some(x => x.id === request.id && x.secret_request.status === 'pending'))
  await f.get('/test/request-cancel'); await sse.message()
  assert.ok((await f.get('/api/rooms/planning/messages')).items.some(x => x.id === request.id && x.secret_request.status === 'cancelled'))
  const question = await f.get('/test/question')
  change = await sse.message(); assert.deepEqual(change.topics, ['questions']); assert.deepEqual(change.botIds, ['bot-three'])
  await f.get('/test/answer'); await sse.message()
  assert.ok((await f.get('/api/bots/bot-three/messages')).items.some(x => x.id === question.id && x.owner_question.status === 'answered'))
  for (const kind of ['bot', 'room']) {
    const item = await f.get(`/test/${kind}-schedule`), notice = await sse.message()
    assert.equal(notice.all, false); assert.deepEqual(notice.topics, ['schedules'])
    const path = kind === 'bot' ? '/api/bots/bot-one/schedules' : '/api/rooms/planning/schedules'
    assert.equal(item.enabled, true)
    assert.equal(item.nextRunAt, '2099-01-01T00:00:00.000Z')
    assert.equal(item.name, `結合試験予定 ${kind === 'bot' ? 'bot-one' : 'planning'}`)
    assert.ok((await f.get(path)).schedules.some(x => x.id === item.id && x.enabled && x.nextRunAt === item.nextRunAt))
    assert.equal((await fetch(f.url + `${path}/${item.id}/run`, { method: 'POST' })).status, 405)
  }
  await f.get('/test/owner?text=人工利用者'); change = await sse.message()
  assert.deepEqual(change.topics, ['owner']); assert.equal(change.all, false)
  assert.equal((await f.get('/api/owner')).owner.name, '人工利用者')
  assert.ok((await f.get('/test/proof')).cli.every(x => ['pty_list', 'pty_read'].includes(x.name)))
  sse.abort.abort()
})

test('旧/不正/未知通知の注入は製品通知と区別し、再接続ready・初期化・誤送信を記録する', { timeout: 15000 }, async t => {
  const f = await fixture(t), first = await f.connect()
  await f.get('/test/legacy'); assert.deepEqual(Object.keys(await first.message()), ['at'])
  await f.get('/test/invalid'); assert.equal((await first.next()).text, '{broken')
  await f.get('/test/unknown-topic'); assert.deepEqual((await first.message()).topics, ['future-topic'])
  await f.get('/test/unknown'); assert.equal((await first.message()).all, true)
  let proof = await f.get('/test/proof')
  assert.equal(proof.events.filter(x => x.origin === 'test-injection').length, 3)
  await f.get('/test/reconnect'); assert.equal(await first.next(), null)
  const second = await f.connect()
  proof = await f.get('/test/proof'); assert.equal(proof.events.filter(x => x.event === 'ready').length, 2)
  const bad = await fetch(f.url + '/api/bots/bot-one/messages', { method: 'POST', body: '{"message":"should not send"}' })
  assert.equal(bad.status, 405)
  assert.ok((await f.get('/test/proof')).requests.some(x => x.method === 'POST' && x.status === 405))
  await f.get('/test/clear-proof'); proof = await f.get('/test/proof'); assert.equal(proof.events.length, 0); assert.equal(proof.subscribers, 1)
  await f.get('/test/reset'); assert.equal(await second.next(), null)
  const third = await f.connect()
  assert.equal((await f.get('/api/bots/bot-one/messages')).items.length, 2)
  assert.equal((await f.get('/test/proof')).events.length, 1)
  third.abort.abort()
})
