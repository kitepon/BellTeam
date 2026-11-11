import assert from 'node:assert/strict'
import test from 'node:test'
import { createWebApp } from '../web/application.js'
import { createWebClient } from '../web/client.js'
import { webDOM } from './helpers/web-dom.mjs'

const settle = () => new Promise(resolve => setImmediate(resolve))
function fixture(t, settings = {}) {
  const dom = webDOM(t), calls = [], events = new ReadableStream({ start(controller) { dom.events = controller } })
  if (settings.readReceipts) dom.reads.set('bellteam-read-receipts.v1', JSON.stringify(settings.readReceipts))
  const bots = ['a', 'b'].map(id => ({ id, name: id, displayName: id, harness: 'codex', color: 'violet', recent: { id: `recent-${id}` } }))
  let failList = settings.failList ?? false
  const client = createWebClient({ fetch: async (path, options = {}) => {
    calls.push({ path, options })
    if (path === '/api/events') {
      options.signal.addEventListener('abort', () => dom.events.error(new DOMException('closed', 'AbortError')))
      return new Response(events)
    }
    if (path === '/api/session') return Response.json({ authenticated: true })
    if (path === '/api/setup') return Response.json({ phase: 'ready', complete: true })
    if (path === '/api/settings') return Response.json({ settings: [] })
    if (path.startsWith('/api/bots?')) return failList ? Response.json({ error: 'MEMBERS_NOT_ACCEPTED' }, { status: settings.errorStatus ?? 503 }) : Response.json({ bots })
    if (path === '/api/rooms') return Response.json({ rooms: settings.rooms ?? [] })
    if (path === '/api/owner') return settings.ownerRead ? settings.ownerRead() : Response.json({ owner: { name: 'Owner' } })
    if (path.endsWith('/goal')) return Response.json({ snapshot: { botId: path.split('/')[3], availability: 'unsupported', capabilities: {} } })
    if (path.endsWith('/messages') && options.method === 'POST') { failList = true; return Response.json({ id: 'accepted' }) }
    if (path.includes('/messages') || path.endsWith('/queue')) return Response.json({ items: [], has_more: false })
    throw Error(`Unexpected API ${path}`)
  } })
  const app = createWebApp({ client })
  assert.equal(calls.length, 0, 'construction must not start API requests')
  return { ...dom, calls, app, setListFailure: value => { failList = value }, emit: payload => dom.events.enqueue(new TextEncoder().encode(`data:${JSON.stringify(payload)}\n\n`)) }
}

test('only a current successful full roster collects deleted conversation receipts', async t => {
  let releaseOldOwner
  const oldOwner = new Promise(resolve => { releaseOldOwner = resolve })
  let ownerReads = 0
  const saved = { 'bot:a': 'recent-a', 'bot:deleted': 'old-bot', 'room:r': 'recent-r', 'room:deleted': 'old-room' }
  const f = fixture(t, { failList: true, readReceipts: saved,
    rooms: [{ id: 'r', name: 'room', memberIds: [] }],
    ownerRead: () => ++ownerReads === 2 ? oldOwner : Response.json({ owner: { name: 'Owner' } }),
  })
  f.reads.set('unrelated-key', 'keep')
  await f.app.start()
  assert.deepEqual(JSON.parse(f.reads.get('bellteam-read-receipts.v1')), saved, 'failed roster keeps receipts')
  f.setListFailure(false)
  const stale = f.get('roster-retry').handlers.click()
  await settle()
  f.setListFailure(true)
  await f.get('roster-retry').handlers.click()
  releaseOldOwner(Response.json({ owner: { name: 'Old owner' } }))
  await stale
  assert.deepEqual(JSON.parse(f.reads.get('bellteam-read-receipts.v1')), saved, 'stale success must not collect')
  f.setListFailure(false)
  await f.get('roster-retry').handlers.click()
  assert.deepEqual(JSON.parse(f.reads.get('bellteam-read-receipts.v1')), { 'bot:a': 'recent-a', 'room:r': 'recent-r' })
  assert.equal(f.reads.get('unrelated-key'), 'keep')
  await f.choose('bot:a')
  f.get('message-input').value = '保持する下書き'
  f.emit({ type: 'ready', all: true }); await settle()
  assert.equal(f.get('message-input').value, '保持する下書き')
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 0)
})

test('initial members 503 keeps the existing SSE available for readonly recovery', async t => {
  const f = fixture(t, { failList: true })
  await f.app.start()
  assert.equal(f.calls.filter(call => call.path === '/api/events').length, 1)
  // Nothing read yet: the list itself is the error card with its own retry (user-paths.md 2.2 RError).
  assert.equal(f.get('roster-notice').hidden, true)
  assert.equal(f.get('bot-list').children.length, 1)
  assert.match(f.get('bot-list').children[0].querySelector('p').textContent, /いま応答できません/)
  f.setListFailure(false)
  f.emit({ type: 'ready', all: true }); await settle()
  assert.equal(f.get('roster-notice').hidden, true)
  await f.choose('bot:a')
  assert.equal(f.calls.filter(call => call.path === '/api/events').length, 1)
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 0)
})

test('failed readonly refresh preserves the roster and draft; explicit GET recovers without sending', async t => {
  const f = fixture(t)
  await f.app.start(); await f.choose('bot:a')
  f.get('message-input').value = '保持する入力'
  const rows = [...f.get('bot-list').children]
  f.setListFailure(true)
  f.emit({ type: 'ready', all: true }); await settle()
  assert.equal(f.get('roster-notice').hidden, false)
  assert.deepEqual(f.get('bot-list').children, rows)
  assert.equal(f.get('message-input').value, '保持する入力')
  f.setListFailure(false)
  const before = f.calls.length
  await f.get('roster-retry').handlers.click()
  assert.equal(f.get('roster-notice').hidden, true)
  assert.equal(f.get('message-input').value, '保持する入力')
  assert.deepEqual(f.calls.slice(before).map(call => call.path).sort(), ['/api/bots?avatar=omit', '/api/owner', '/api/rooms'])
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 0)
})

test('initial authentication refusal still stops startup instead of opening recovery SSE', async t => {
  const f = fixture(t, { failList: true, errorStatus: 403 })
  await assert.rejects(f.app.start(), error => error.status === 403)
  assert.equal(f.calls.filter(call => call.path === '/api/events').length, 0)
})

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
