import assert from 'node:assert/strict'
import test from 'node:test'
import { createWebApp } from '../web/application.js'
import { webDOM } from './helpers/web-dom.mjs'
import { deferred } from './helpers/editor-dom.mjs'

const settle = () => new Promise(resolve => setImmediate(resolve))

test('active Bot keeps ordinary send alongside stop and the existing single-flight', async t => {
  const dom = webDOM(t), message = deferred(), stop = deferred(), posts = []
  const bot = { id: 'a', name: 'a', displayName: 'a', color: 'violet' }
  let queue = []
  const client = {
    async api(path, options = {}) {
      if (path === '/api/session') return { authenticated: true }
      if (path === '/api/setup') return { phase: 'ready', complete: true }
      if (path === '/api/settings') return { settings: [] }
      if (path.startsWith('/api/bots?')) return { bots: [bot] }
      if (path === '/api/rooms') return { rooms: [{ id: 'r', name: 'room', memberIds: ['a'] }] }
      if (path === '/api/owner') return { owner: { name: 'Owner' } }
      if (path.endsWith('/goal')) return { snapshot: { botId: 'a', availability: 'unsupported', capabilities: {} } }
      if (path === '/api/bots/a/messages' && options.method === 'POST') { posts.push(JSON.parse(options.body)); return message.promise }
      if (path === '/api/bots/a/stop') return stop.promise
      if (path.endsWith('/queue')) return { items: queue }
      if (path.includes('/messages')) return { items: [], has_more: false }
      throw Error(`Unexpected API ${path}`)
    },
    fetchImage() {}, watchEvents() { return () => {} },
  }
  const app = createWebApp({ client })
  const send = dom.get('send-button'), stopButton = dom.get('stop-button'), input = dom.get('message-input')
  await app.start(); await dom.choose('bot:a'); await settle()
  input.value = 'first'; input.handlers.input()
  assert.equal(send.hidden, false); assert.equal(send.disabled, false); assert.equal(stopButton.hidden, true)

  queue = [{ botId: 'a', status: 'running' }]
  await dom.choose('bot:a'); await settle()
  assert.equal(send.hidden, false); assert.equal(send.disabled, false); assert.equal(stopButton.hidden, false)
  const first = dom.submit()
  await settle()
  input.value = 'second'; input.handlers.input()
  assert.equal(send.disabled, true)
  await dom.submit()
  assert.deepEqual(posts.map(post => post.message), ['first'])
  message.resolve({ id: 'accepted' }); await first
  assert.equal(send.disabled, false)

  stopButton.handlers.click()
  assert.equal(send.hidden, true); assert.equal(stopButton.hidden, false); assert.equal(stopButton.disabled, true)
  stop.resolve({ botId: 'a', status: 'stop_sent' }); await settle()
  assert.equal(send.hidden, false); assert.equal(stopButton.disabled, false)

  bot.deleting = true
  await dom.get('roster-retry').handlers.click()
  assert.equal(send.hidden, false); assert.equal(send.disabled, true); assert.equal(stopButton.hidden, true)
  await dom.choose('room:r'); await settle()
  assert.equal(send.hidden, false); assert.equal(stopButton.hidden, true)
})
