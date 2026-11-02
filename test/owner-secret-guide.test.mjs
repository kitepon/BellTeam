import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SecretRequests } from '../src/secret-requests.mjs'
import { createMessageViews } from '../src/http-messages.mjs'
import { createConversationApi } from '../src/http-conversation-api.mjs'
import { recentTimeline } from '../src/timeline-index.mjs'

const guideUrl = 'https://claude.ai/fixture-only'
const pageUrl = query => new URL(`http://fixture/?${query}`)
const withoutGuide = page => ({ ...page, items: page.items.map(item => {
  if (!item.secret_request?.ownerGuide) return item
  const { ownerGuide, ...request } = item.secret_request
  return { ...item, secret_request: request }
}) })

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'owner-secret-guide-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bots = new Map([['bot-a', { id: 'bot-a', name: 'fixture' }]])
  const rooms = new Map([['room-a', { id: 'room-a', name: 'fixture', memberIds: ['bot-a'] }]])
  rooms.refresh = async () => {}
  const changes = [], notifications = []
  const secretRequests = new SecretRequests({ root, bots, rooms,
    onRequest: item => notifications.push(item), notify: item => notifications.push(item) })
  await secretRequests.initialize()
  secretRequests.watch(event => changes.push(event))
  const requests = []
  for (const roomId of [null, 'room-a']) requests.push(await secretRequests.create({ botId: 'bot-a', roomId,
    toolId: 'fixture', label: 'fixture', message: 'fixture card' }))
  const rows = Object.freeze([
    Object.freeze({ id: 'old', kind: 'message', at: '2000-01-01T00:00:00Z', message: 'old' }),
    Object.freeze({ id: 'new', kind: 'message', at: '9999-01-01T00:00:00Z', message: 'new' }),
  ])
  const store = { async timeline() { return rows } }
  rooms.messages = async () => rows
  for (const target of [{ botId: 'bot-a' }, { roomId: 'room-a' }]) {
    const row = secretRequests.timelineView(target).at(0)
    Object.freeze(row.secret_request); Object.freeze(row)
  }
  return { root, bots, rooms, secretRequests, requests, changes, notifications, store }
}

test('Owner pages add only URL to copied Bot/room cards using the same request identity', async t => {
  const f = await fixture(t), calls = []
  const plain = createMessageViews(f)
  const views = createMessageViews({ ...f, ownerSecretGuide: async identity => {
    calls.push(identity)
    const request = f.secretRequests.get(identity.requestId)
    assert.deepEqual(identity, { requestId: request.id, botId: request.botId, roomId: request.roomId })
    return { url: guideUrl, label: 'DO_NOT_COPY', raw: 'DO_NOT_COPY' }
  } })
  for (const [kind, id, request] of [['bots', 'bot-a', f.requests[0]], ['rooms', 'room-a', f.requests[1]]]) {
    const baseline = await plain.messagePage(kind, id, pageUrl('limit=200'))
    const result = await views.messagePage(kind, id, pageUrl('limit=200'))
    assert.deepEqual(withoutGuide(result), baseline)
    const card = result.items.find(item => item.id === request.id)
    const original = baseline.items.find(item => item.id === request.id)
    assert.deepEqual(card.secret_request.ownerGuide, { url: guideUrl })
    assert.notEqual(card, original); assert.notEqual(card.secret_request, original.secret_request)
    assert.equal(f.secretRequests.get(request.id).ownerGuide, undefined)
    assert.deepEqual(await plain.messagePage(kind, id, pageUrl('limit=200')), baseline)
  }
  assert.equal(calls.length, 2)
})

test('before/after/limit select rows before lookup and retain all page metadata', async t => {
  const f = await fixture(t), calls = []
  const views = createMessageViews({ ...f, ownerSecretGuide: async identity => { calls.push(identity.requestId); return { url: guideUrl } } })
  const plain = createMessageViews(f)
  for (const [kind, id, request] of [['bots', 'bot-a', f.requests[0]], ['rooms', 'room-a', f.requests[1]]]) {
    for (const query of ['limit=1', 'limit=1&before=new', 'limit=1&after=old',
      `limit=1&before=${request.id}`, `limit=1&after=${request.id}`, 'limit=2&after=unknown']) {
      calls.length = 0
      const baseline = await plain.messagePage(kind, id, pageUrl(query))
      const result = await views.messagePage(kind, id, pageUrl(query))
      assert.deepEqual(withoutGuide(result), baseline, query)
      assert.deepEqual(calls, baseline.items.filter(item => item.kind === 'secret_request').map(item => item.id), query)
    }
  }
})

test('null, rejected, throwing or invalid guide keeps cards and unrelated messages intact', async t => {
  const f = await fixture(t)
  const baseline = await createMessageViews(f).messagePage('bots', 'bot-a', pageUrl('limit=200'))
  for (const ownerSecretGuide of [null, async () => null, () => { throw new Error('PRIVATE_ERROR') },
    async () => { throw new Error('PRIVATE_ERROR') }, async () => ({ url: 42 })]) {
    const views = createMessageViews({ ...f, ownerSecretGuide })
    assert.deepEqual(await views.messagePage('bots', 'bot-a', pageUrl('limit=200')), baseline)
  }
})

test('internal null injection, sources, export, recent, request receipts, disk and events contain no guide', async t => {
  const f = await fixture(t)
  const views = createMessageViews({ ...f, ownerSecretGuide: async () => ({ url: guideUrl }) })
  const internal = createMessageViews({ ...f, ownerSecretGuide: null })
  const api = createConversationApi({ ...f, timeline: views.timeline })
  for (const [kind, id] of [['bots', 'bot-a'], ['rooms', 'room-a']]) {
    await views.messagePage(kind, id, pageUrl('limit=200'))
    const sources = await views.sources(kind, id)
    const outside = [await internal.messagePage(kind, id, pageUrl('limit=200')),
      await views.timeline(kind, id), sources.map(source => source.snapshot()), recentTimeline(sources)]
    let status, body
    const response = { writeHead(value) { status = value }, end(value) { body = JSON.parse(value) } }
    await api({ method: 'GET' }, response, new URL(`http://fixture/api/${kind}/${id}/export`))
    assert.equal(status, 200); outside.push(body)
    assert.doesNotMatch(JSON.stringify(outside), /ownerGuide|fixture-only/)
  }
  for (const request of f.requests) {
    assert.doesNotMatch(await readFile(join(f.root, 'state/secret-requests', `${request.id}.json`), 'utf8'), /ownerGuide|fixture-only/)
    assert.equal(f.secretRequests.get(request.id).ownerGuide, undefined)
  }
  assert.doesNotMatch(JSON.stringify([f.requests, f.notifications, f.changes]), /ownerGuide|fixture-only/)
})
