import assert from 'node:assert/strict'
import test from 'node:test'
import { createWebApp } from '../web/application.js'
import { createWebClient } from '../web/client.js'
import { webDOM } from './helpers/web-dom.mjs'

const settle = () => new Promise(resolve => setImmediate(resolve))
function fixture(t) {
  const dom = webDOM(t), calls = [], events = new ReadableStream({ start(controller) { dom.events = controller } })
  const bots = ['a', 'b'].map(id => ({ id, name: id, displayName: id, harness: 'codex', color: 'violet', recent: { id: `recent-${id}` } }))
  let failList = false
  const client = createWebClient({ fetch: async (path, options = {}) => {
    calls.push({ path, options })
    if (path === '/api/events') {
      options.signal.addEventListener('abort', () => dom.events.error(new DOMException('closed', 'AbortError')))
      return new Response(events)
    }
    if (path === '/api/session') return Response.json({ authenticated: true })
    if (path === '/api/setup') return Response.json({ phase: 'ready', complete: true })
    if (path === '/api/settings') return Response.json({ settings: [] })
    if (path.startsWith('/api/bots?')) return failList ? new Response('', { status: 503 }) : Response.json({ bots })
    if (path === '/api/rooms') return Response.json({ rooms: [] })
    if (path === '/api/owner') return Response.json({ owner: { name: 'Owner' } })
    if (path.endsWith('/goal')) return Response.json({ snapshot: { botId: path.split('/')[3], availability: 'unsupported', capabilities: {} } })
    if (path.endsWith('/messages') && options.method === 'POST') { failList = true; return Response.json({ id: 'accepted' }) }
    if (path.includes('/messages') || path.endsWith('/queue')) return Response.json({ items: [], has_more: false })
    throw Error(`Unexpected API ${path}`)
  } })
  const app = createWebApp({ client })
  assert.equal(calls.length, 0, 'construction must not start API requests')
  return { ...dom, calls, app, emit: payload => dom.events.enqueue(new TextEncoder().encode(`data:${JSON.stringify(payload)}\n\n`)) }
}

test('Web boots and keeps conversation drafts through the public client, without server internals', async t => {
  const f = fixture(t)
  await f.app.start()
  assert.equal(f.calls.filter(call => call.path === '/api/events').length, 1)
  await f.choose('bot:a')
  f.get('message-input').value = 'draft-a'
  await f.choose('bot:b')
  f.get('message-input').value = 'draft-b'
  await f.choose('bot:a')
  assert.equal(f.get('message-input').value, 'draft-a')
  assert.equal(JSON.parse(f.reads.get('bellteam-read-receipts.v1'))['bot:a'], 'recent-a')
  const before = f.calls.length
  f.emit({ all: false, topics: ['timeline'], botIds: ['b'], roomIds: [] })
  await settle()
  assert.ok(f.calls.slice(before).some(call => call.path.startsWith('/api/bots?')))
  assert.ok(!f.calls.slice(before).some(call => call.path.includes('/messages')))
  assert.equal(f.get('message-input').value, 'draft-a')
})

test('accepted send and failed display refresh keep acceptance and never issue another POST', async t => {
  const f = fixture(t)
  await f.app.start(); await f.choose('bot:a')
  f.get('message-input').value = 'send once'
  await f.submit()
  const posts = f.calls.filter(call => call.options.method === 'POST')
  assert.equal(posts.length, 1)
  assert.equal(posts[0].path, '/api/bots/a/messages')
  assert.equal(JSON.parse(posts[0].options.body).message, 'send once')
  assert.equal(f.get('message-input').value, '')
  assert.match(f.get('composer-error').textContent, /送信を受け付けました/)
  f.emit({ all: true }); await settle()
  assert.equal(f.calls.filter(call => call.path === '/api/events').length, 1)
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1)
  f.windowEvents.get('pagehide')({ persisted: true })
  assert.equal(f.calls.find(call => call.path === '/api/events').options.signal.aborted, false)
  f.windowEvents.get('pagehide')({ persisted: false })
  assert.equal(f.calls.find(call => call.path === '/api/events').options.signal.aborted, true)
})
