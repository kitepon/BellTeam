import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8')
const functions = source.slice(source.indexOf('function eventAffectsTimeline('), source.indexOf('async function connectEvents()'))
function fixture(type = 'bot', id = 'bot-a') {
  const requests = [], refreshed = []
  const state = { selectedType: type, selected: id ? { id } : null }
  const context = vm.createContext({ state, ownerDialog: { open: true },
    aiControl: { refresh: () => refreshed.push('ai-control') }, goals: { refreshOnEvent: () => refreshed.push('goals') },
    loadBots: async () => requests.push('/api/bots', '/api/rooms', '/api/owner'),
    loadMessages: async () => requests.push(type === 'room' ? `/api/rooms/${id}/messages` : `/api/bots/${id}/messages`),
    loadFeatureSettings: async () => refreshed.push('settings'), refreshFeatureSettingsStatus() {},
    document: { querySelector() {} }, api: async path => requests.push(path),
  })
  vm.runInContext(functions, context)
  return { requests, refreshed, run: payload => context.refreshFromEvent(payload) }
}
const event = (botIds = [], roomIds = [], topics = ['timeline']) => ({ all: false, topics, botIds, roomIds })

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
  assert.ok(f.requests.includes('/api/setup'))
})
