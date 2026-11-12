import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'
import { createWebClient } from '../web/client.js'
const settle = () => new Promise(resolve => setImmediate(resolve))

const source = await readFile(new URL('../web/application.js', import.meta.url), 'utf8')
const functions = source.slice(source.indexOf('function eventAffectsTimeline('), source.indexOf('async function connectEvents()'))
function fixture(type = 'bot', id = 'bot-a') {
  const requests = [], refreshed = [], updateEvents = []
  const state = { selectedType: type, selected: id ? { id } : null }
  const context = vm.createContext({ state, ownerDialog: { open: true },
    allSchedules: { refresh() {} }, scheduleEditor: { refresh() {} },
    updateCenter: { refresh: event => { refreshed.push('updates'); updateEvents.push(event) } },
    ownerEditor: { refreshAI: () => refreshed.push('ai-control'), refreshFeatureStatus() {} }, goals: { refreshOnEvent: () => refreshed.push('goals') },
    loadBots: async () => requests.push('/api/bots', '/api/rooms', '/api/owner'),
    loadMessages: async () => requests.push(type === 'room' ? `/api/rooms/${id}/messages` : `/api/bots/${id}/messages`),
    loadFeatureSettings: async () => refreshed.push('settings'), refreshFeatureSettingsStatus() {},
    document: { querySelector() {} }, api: async path => requests.push(path),
  })
  vm.runInContext(functions, context)
  return { requests, refreshed, updateEvents, run: payload => context.refreshFromEvent(payload) }
}
const event = (botIds = [], roomIds = [], topics = ['timeline']) => ({ all: false, topics, botIds, roomIds })

test('stored update jobs SSE reader errors reach the update view unchanged', async () => {
  const f = fixture()
  const payload = { type: 'updates', all: true, error: { code: 'UNREADABLE', message: 'EACCES', path: '/state/jobs/record.json', reason: 'EACCES' } }
  await f.run(payload)
  assert.equal(f.updateEvents[0], payload)
})

test('別会話の通知は一覧だけ取得し、開いている履歴を読み直さない', async () => {
  const f = fixture()
  await f.run(event(['bot-other']))
  assert.deepEqual(f.requests.sort(), ['/api/bots', '/api/owner', '/api/rooms'])
})

test('対象の履歴・queue・カードと部屋の通知はそれぞれの会話を更新する', async () => {
  for (const topic of ['timeline', 'queue', 'requests', 'questions', 'schedules']) {
    const f = fixture(); await f.run(event(['bot-a'], [], [topic]))
    assert.ok(f.requests.includes('/api/bots/bot-a/messages'))
  }
  const room = fixture('room', 'room-a')
  await room.run(event(['bot-a'], ['room-other'], ['queue']))
  assert.ok(!room.requests.some(path => path.endsWith('/messages')))
  await room.run(event(['bot-a'], ['room-a'], ['requests']))
  assert.ok(room.requests.includes('/api/rooms/room-a/messages'))
})

test('ready・全体・未知・対象不足では履歴を再照合し、設定等の専用更新も維持する', async () => {
  for (const payload of [{}, { all: true }, event(), event(['other'], [], ['future-topic']),
    event([null]), { all: false, topics: ['timeline'], botIds: ['other'] }]) {
    const f = fixture(); await f.run(payload)
    assert.ok(f.requests.includes('/api/bots/bot-a/messages'), JSON.stringify(payload))
  }
  const f = fixture()
  await f.run({ type: 'settings', all: true })
  await f.run({ type: 'ai-control', all: true })
  await f.run({ type: 'setup', all: true })
  assert.ok(f.refreshed.includes('settings'))
  assert.ok(f.refreshed.includes('ai-control'))
  assert.ok(f.refreshed.includes('updates'))
  assert.ok(f.requests.includes('/api/setup'))
})

test('表示取得の失敗をSSE接続の失敗として伝播しない', async () => {
  const notices = []
  const context = vm.createContext({ state: { selectedType: 'bot', selected: { id: 'a' } }, ownerDialog: { open: false },
    updateCenter: { refresh() {} },
    goals: { refreshOnEvent() {} }, loadBots: async () => { throw new TypeError('GET failed') }, loadMessages: async () => {},
    conversationComposer: { showError: () => assert.fail('an app-level failure went to a conversation') },
    showBanner: (message, action) => notices.push({ message, action }),
  })
  vm.runInContext(functions, context)
  await context.refreshFromEvent({ all: true })
  assert.equal(notices.length, 1)
  assert.match(notices[0].message, /表示を更新できませんでした/)
  assert.equal(notices[0].action.label, 'もう一度')
  // With nothing selected the failure still reaches the top banner (W4).
  context.state.selectedType = null; context.state.selected = null
  await context.refreshFromEvent({ type: 'settings' })
  assert.equal(notices.length, 2)
})

test('a clean SSE end shows 再接続中…, reconnects and re-reads the list once; 401 still stops with the banner (W3)', async () => {
  const shell = source.slice(source.indexOf('function eventAffectsTimeline('), source.indexOf('function conversationKey('))
  const tasks = [], banners = [], reads = []; let calls = 0, refuse = false
  const client = createWebClient({ fetch: async () => {
    calls++
    if (refuse) return new Response('', { status: 401 })
    return new Response(new ReadableStream({ start(controller) { if (calls === 1) controller.close() } }))
  }, setTimeout: run => { tasks.push(run); return tasks.length }, clearTimeout() {} })
  const pill = { hidden: true }
  const context = vm.createContext({ state: {}, watchEvents: client.watchEvents, updateCenter: { refresh() {} },
    reconnectPill: pill, showBanner: (message, action) => { if (message) banners.push({ message, action }) },
    loadBots: async () => reads.push('list'),
  })
  vm.runInContext(shell, context)
  await context.connectEvents(); await settle(); await settle()
  assert.equal(pill.hidden, false, 'EOF shows the reconnecting pill'); assert.equal(tasks.length, 1); assert.deepEqual(banners, [])
  void tasks[0](); await settle(); await settle()
  assert.equal(calls, 2); assert.equal(pill.hidden, true); assert.deepEqual(reads, ['list'], 'one resumed list read')
  context.state.stopEvents()
  refuse = true; await context.connectEvents(); await settle(); await settle()
  assert.equal(banners.length, 1); assert.match(banners[0].message, /最新の状態が届かなくなりました/); assert.equal(tasks.length, 1, '401 does not retry')
  context.state.stopEvents()
})

test('updates changes refresh the update view; unrelated conversation changes do not', async () => {
  const f = fixture()
  await f.run(event(['other']))
  assert.ok(!f.refreshed.includes('updates'))
  await f.run({ type: 'updates' })
  assert.ok(f.refreshed.includes('updates'))
})
