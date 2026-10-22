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
  async function events() {
    const abort = new AbortController()
    t.after(() => abort.abort())
    const response = await fetch(server.url + '/api/events', { signal: abort.signal })
    const reader = response.body.getReader(), decoder = new TextDecoder()
    let buffer = ''
    const next = async () => {
      const timeout = setTimeout(() => abort.abort(new Error('PUBLIC_FIXTURE_SSE_TIMEOUT')), 2000)
      try {
        while (!buffer.includes('\n\n')) {
          const value = await reader.read()
          if (value.done) return null
          buffer += decoder.decode(value.value, { stream: true })
        }
        const end = buffer.indexOf('\n\n'), raw = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        return raw
      } finally { clearTimeout(timeout) }
    }
    assert.equal(await next(), 'event: ready\ndata: {}')
    return { abort, next: async () => {
      const raw = await next()
      if (raw === null) return null
      assert.match(raw, /^event: messages\ndata: /u)
      const data = JSON.parse(raw.slice(raw.indexOf('data: ') + 6))
      assert.deepEqual(Object.keys(data), ['at'])
      return data
    } }
  }
  return { ...server, get, events }
}

test('公開6dの実APIは一覧/履歴を返し、追加ai-control APIは製品自身が404を返す', async t => {
  const f = await fixture(t)
  assert.deepEqual((await f.get('/api/bots?avatar=omit')).bots.map(x => x.id), ['bot-one', 'bot-two', 'bot-three'])
  assert.deepEqual((await f.get('/api/rooms?avatar=omit')).rooms.map(x => x.id), ['ideas', 'planning'])
  assert.equal((await f.get('/api/bots/bot-one/messages')).items.length, 2)
  assert.equal((await f.get('/api/setup')).complete, true)
  const response = await fetch(f.url + '/api/ai-control')
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'NOT_FOUND' })
  assert.ok((await f.get('/test/proof')).requests.some(x => x.path === '/api/ai-control' && x.status === 404))
})

test('公開6dはBot/peer/status/roomの変更を旧at通知し、実GETで変更を読める', { timeout: 10000 }, async t => {
  const f = await fixture(t), sse = await f.events()
  const added = await f.get('/test/bot?bot=bot-two'); await sse.next()
  assert.equal((await f.get('/api/bots/bot-two/messages')).items.at(-1).message, added.text)
  const peer = await f.get('/test/peer'); await sse.next()
  for (const id of ['bot-one', 'bot-two']) assert.ok((await f.get(`/api/bots/${id}/messages`)).items.some(x => x.id === peer.id))
  await f.get('/test/status'); await sse.next()
  assert.equal((await f.get('/api/bots/bot-one/messages')).items.find(x => x.id === 'baseline-bot-one-1').delivery, 'failed')
  const room = await f.get('/test/room'); await sse.next()
  assert.equal((await f.get('/api/rooms/planning/messages')).items.at(-1).message, room.text)
  const proof = await f.get('/test/proof')
  assert.ok(proof.events.filter(x => x.event === 'messages').every(x => x.origin === 'product-server' && Object.keys(x.data).join() === 'at'))
  sse.abort.abort()
})

test('公開6dはqueue/カード/予定を旧通知し、再接続で実readyを返す', { timeout: 10000 }, async t => {
  const f = await fixture(t), sse = await f.events()
  await f.get('/test/queue?bot=bot-one&room=planning'); await sse.next()
  assert.equal((await f.get('/api/rooms/planning/queue')).items.length, 1)
  const card = await f.get('/test/question'); await sse.next()
  assert.ok((await f.get('/api/bots/bot-three/messages')).items.some(x => x.id === card.id))
  for (const kind of ['bot', 'room']) {
    const schedule = await f.get(`/test/${kind}-schedule`)
    // 旧room監視はschedule.jsonを通知しないため、Botだけ旧通知を照合する。
    if (kind === 'bot') await sse.next()
    const path = kind === 'bot' ? '/api/bots/bot-one/schedules' : '/api/rooms/planning/schedules'
    assert.equal(schedule.enabled, true)
    assert.equal(schedule.nextRunAt, '2099-01-01T00:00:00.000Z')
    assert.equal(schedule.name, `結合試験予定 ${kind === 'bot' ? 'bot-one' : 'planning'}`)
    assert.ok((await f.get(path)).schedules.some(x => x.id === schedule.id && x.enabled && x.nextRunAt === schedule.nextRunAt))
    assert.equal((await fetch(f.url + `${path}/${schedule.id}/run`, { method: 'POST' })).status, 405)
  }
  assert.ok((await f.get('/test/proof')).cli.every(x => ['pty_list', 'pty_read'].includes(x.name)))
  await f.get('/test/reconnect'); assert.equal(await sse.next(), null)
  const next = await f.events()
  assert.equal((await f.get('/test/proof')).events.filter(x => x.event === 'ready').length, 2)
  next.abort.abort()
})
