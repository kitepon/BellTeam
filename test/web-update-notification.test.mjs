import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { parseNotificationPayload, notificationPresentation, notificationRoute, notificationURL } from '../web/notification-payload.js'
import { installNotificationWorker } from '../web/notification-worker.js'
import { createNotificationNavigation } from '../web/notification-navigation.js'
import { createUpdateCenter } from '../web/update-center.js'
import { updateExamples } from '../src/update-center-contract.mjs'
import { webDOM } from './helpers/web-dom.mjs'

const payload = { schema: 'bellteam.web-push.v1', kind: 'update', messageId: 'a'.repeat(64), title: 'BellTeam', body: '更新があります。Updateで確認してください。' }
const route = { kind: 'update' }
const settle = () => new Promise(resolve => setImmediate(resolve))

test('update payload and route are closed, fixed public text with a separate candidate tag', () => {
  const parsed = parseNotificationPayload(JSON.stringify(payload))
  assert.deepEqual(parsed, { value: payload, route })
  assert.deepEqual(notificationPresentation(parsed), { title: payload.title, body: payload.body, route })
  for (const value of [{ ...payload, messageId: 'A'.repeat(64) }, { ...payload, messageId: 'a'.repeat(63) },
    { ...payload, title: 'private' }, { ...payload, body: 'private' }, { ...payload, url: 'https://other/' },
    { ...payload, botId: 'bot-a' }, { ...payload, kind: 'future' }, { ...payload, schema: 'future' }]) {
    assert.equal(parseNotificationPayload(JSON.stringify(value)), null)
  }
  for (const value of [{ ...route, messageId: payload.messageId }, { ...route, url: 'https://other/' }, { kind: 'future' }]) assert.equal(notificationRoute(value), null)
  const url = new URL(notificationURL(route, 'https://example.com'))
  assert.equal(url.origin, 'https://example.com')
  assert.deepEqual(JSON.parse(url.searchParams.get('notification')), route)
  assert.ok(!url.href.includes(payload.messageId))
})

test('SW update display uses the candidate tag and both existing-window and cold clicks carry only the route', async () => {
  const handlers = {}, shown = [], posted = [], opened = []
  let windows = [], focused = 0
  installNotificationWorker({ location: { origin: 'https://example.com' }, addEventListener(name, fn) { handlers[name] = fn },
    registration: { async showNotification(title, options) { shown.push({ title, options }) } },
    clients: { async matchAll() { return windows }, async openWindow(url) { opened.push(url) } } })
  const dispatch = async (name, input) => { let pending; handlers[name]({ ...input, waitUntil(value) { pending = value } }); await pending }
  await dispatch('push', { data: { text: () => JSON.stringify(payload) } })
  assert.equal(shown[0].options.tag, payload.messageId)
  assert.deepEqual(shown[0].options.data, route)
  windows = [{ url: 'https://other/', focus() { assert.fail('foreign focus') } },
    { url: 'https://example.com/', async focus() { focused++ }, postMessage(value) { posted.push(value) } }]
  await dispatch('notificationclick', { notification: { data: route, close() {} } })
  assert.equal(focused, 1)
  assert.deepEqual(posted, [{ type: 'bellteam-notification', route }])
  windows = []
  await dispatch('notificationclick', { notification: { data: route, close() {} } })
  assert.deepEqual(opened, [notificationURL(route, 'https://example.com')])
})

test('cold update route waits for normal readiness and survives an editor refusal for explicit retry', async () => {
  const data = new Map(), routed = [], notices = []
  let blocked = true
  const browser = { location: { href: notificationURL(route, 'https://example.com'), origin: 'https://example.com' },
    history: { replaceState(a, b, url) { browser.location.href = url } },
    sessionStorage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) } }
  const nav = createNotificationNavigation({ browser, onNotice: value => notices.push(value), onRoute: async value => { routed.push(value); if (blocked) throw Error('EDITOR_OPEN') } })
  assert.equal(routed.length, 0)
  await nav.ready()
  assert.equal(routed.length, 1)
  assert.match(notices.at(-1), /入力中/)
  assert.deepEqual(JSON.parse([...data.values()][0]), route)
  blocked = false
  await nav.retry()
  assert.deepEqual(routed, [route, route])
  assert.equal(data.size, 0)
})

test('application update routing opens only Update and respects an already open editor', async () => {
  const source = await readFile(new URL('../web/application.js', import.meta.url), 'utf8')
  const callback = source.slice(source.indexOf('onRoute: async route => {') + 'onRoute: '.length, source.indexOf('\n  })\n  document.querySelector(\'#notification-route-retry\')')).replace(/,\s*$/, '')
  let editor = false, opens = 0
  const run = vm.runInNewContext('(' + callback + ')', { document: { querySelector: () => editor }, updateCenter: { async open() { opens++ } } })
  await run(route)
  assert.equal(opens, 1)
  editor = true
  await assert.rejects(run(route), /EDITOR_OPEN/)
  assert.equal(opens, 1)
})

test('public Update open reads inventory and preserved unknown IDs, sends no plan/start, and restores visible opener focus', async t => {
  const dom = webDOM(t), root = dom.get('update-center'), calls = []
  const buttons = [dom.get('update-open'), dom.get('update-open-mobile')]
  buttons[0].getClientRects = () => [{}]
  buttons[1].getClientRects = () => [{}]
  window.getComputedStyle = item => ({ visibility: item === buttons[0] ? 'hidden' : 'visible' })
  let focused = false
  buttons[1].focus = () => { focused = true }
  const value = structuredClone(updateExamples.disconnected_unknown), previous = value.operation
  const held = JSON.stringify({ requestId: previous.requestId, planId: previous.plan.planId })
  const data = new Map([['bellteam-update-request.v1', held]])
  const center = createUpdateCenter({ root, buttons, storage: { getItem: key => data.get(key) ?? null, setItem: (key, val) => data.set(key, val), removeItem: key => data.delete(key) },
    api: async (path, options) => { calls.push([path, options]); return path === '/api/updates?runtime=1' ? value : { operation: previous } } })
  await center.open()
  assert.equal(root.open, true)
  assert.deepEqual(calls.map(([path]) => path), ['/api/updates?runtime=1', `/api/updates/operations/${previous.requestId}`])
  assert.ok(calls.every(([, options]) => !options?.method))
  assert.match(data.get('bellteam-update-request.v1'), new RegExp(previous.requestId))
  root.close(); await settle()
  assert.equal(focused, true)
  center.close()
  await center.open(buttons[0])
  assert.equal(calls.length, 2)
})
