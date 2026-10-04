import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { createBellTeamServer } from '../src/http-server.mjs'

test('購読がなくてもBotとルームの会話を全件書き出せる', async t => {
  const messages = Array.from({ length: 130 }, (_, i) => ({ id: `m${i}`, message: `会話${i}`, at: new Date(i * 1000).toISOString() }))
  messages[0].imageAsset = { owner: 'bot', file: 'image.png' }
  const server = createBellTeamServer({
    authorize: request => request.headers.authorization === 'Bearer test',
    bots: new Map([['bot', { id: 'bot', displayName: 'ベル' }]]),
    rooms: { refresh() {}, get: id => id === 'room' ? { id, name: 'ルーム' } : null, messages: async () => messages },
    store: { timeline: async () => messages }, transport: {}, messenger: {},
    subscriptions: { requireActive() { throw Error('書き出しに購読は不要') } },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  assert.equal((await fetch(base + '/api/bots/bot/export')).status, 401)
  for (const path of ['/api/bots/bot/export', '/api/rooms/room/export']) {
    const response = await fetch(base + path, { headers: { authorization: 'Bearer test' } })
    assert.equal(response.status, 200)
    const exported = await response.json()
    assert.equal(exported.format, 'bellteam.conversation.v1')
    assert.equal(exported.messages.length, 130)
    assert.equal(exported.messages[0].image_url, '/api/message-images/bot/image.png')
    assert.equal(exported.messages[0].imageAsset, undefined)
  }
})
